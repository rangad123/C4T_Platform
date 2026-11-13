/**
 * Which AI a person's work uses, and who pays (round 57). Every person has one chosen key (ai-config-store.ts): one of their own personal keys,
 * or an organisational key an admin assigned to them. All the AI work they start uses it, in any project; a schedule's or a deploy trigger's
 * work uses its maker's. Read when a job starts, or when a route is about to call the model: the answer is fixed for that piece of work.
 *
 * - A personal key: that person pays. An organisational key: Crowd4Test pays.
 * - Only that key is used, with its own models: no fallback models, no fast model from Settings, and never the server's key. Anything wrong
 *   with it stops the AI work with a plain sentence.
 * - The open server (no accounts) uses its chosen key if it has one, else the server's own key, as before; the shared access key (API_KEY)
 *   uses the server's own key. A signed-in person never does.
 *
 * The messages of a job are read by everyone on the project, testers too, so they name no key, label or provider. The detail stays on the
 * key (`status_note`), which only the people who manage it see.
 */
import type { Config } from "../config.js";
import { CLASS_RULES, isLlmCallError, LlmCallError, toLlmCallError, type LlmErrorClass } from "../engine/llm/errors.js";
import { assertLlmConfigured, createLlmClient, createLlmClientOrUnavailable, LlmNotConfiguredError, unavailableLlmClient, type CreateClientOptions, type LlmClient } from "../engine/llm/provider.js";
import { routedClient } from "../engine/llm/routing.js";
import { ESCALATION_PURPOSE, type UsageBilling } from "../engine/llm/usage.js";
import type { EngineEvent } from "../engine/context.js";
import { ACCESS_KEY_OWNER, jobOwnerId, OPEN_OWNER_ID, ownerIdOfActor } from "./agent-store.js";
import { AiConfigStore, assignableSql, type AiConfiguration } from "./ai-config-store.js";
import type { Db } from "./db.js";
import { guardedFetch } from "./guarded-fetch.js";
import { assertAllowedTarget } from "./net-guard.js";
import { SecretBox } from "./secrets.js";
import type { Sql } from "./sql.js";
import { usageStoreFor } from "./usage-store.js";

/**
 * Whose AI the work uses: a person's id, OPEN_OWNER_ID (the open server), ACCESS_KEY_OWNER (the shared access key, API_KEY: an operator's
 * credential, not a person; it uses the server's own key, as the open server does), or null (nobody: refused).
 */
export { ACCESS_KEY_OWNER };
export const aiOwnerOfActor = (actor: { kind: string; id?: string | undefined }): string | null => (actor.kind === "key" ? ACCESS_KEY_OWNER : ownerIdOfActor(actor));
/** A job's: its starter's; a schedule's or trigger's made with the shared access key uses the server's key like the access key itself. */
export function aiOwnerOfJob(options: { startedBy?: unknown }): string | null {
    const s = options.startedBy as { kind?: string; ownerId?: string | null } | undefined;
    if (s?.kind === "key") return ACCESS_KEY_OWNER;
    if ((s?.kind === "schedule" || s?.kind === "trigger") && s.ownerId === ACCESS_KEY_OWNER) return ACCESS_KEY_OWNER;
    return jobOwnerId(options);
}

/** The person acting has no usable key at all. */
export const NO_AI_KEY = "You have no AI key. Add your own key in Settings, AI keys, or ask an admin to assign an organisational key.";
/** Their chosen key was removed, or its assignment was taken away. */
export const KEY_NOT_AVAILABLE = "Your chosen AI key is no longer available to you. Choose another one in Settings, AI keys, or ask an admin to assign an organisational key.";
/** The person behind the work is turned off here, or no longer here. */
export const PERSON_INACTIVE = "AI is not available: the person whose AI key this work uses can no longer use AI Studio.";
/** No person behind the work (the shared access key, the system). */
export const NO_PERSON = "AI work needs a person's AI key: sign in with your own account to use AI.";
/** Said in a job (read by everyone on the project) when its starter's key cannot be used: names no key and no person. */
export const AI_NOT_AVAILABLE = "AI is not available for this work: the AI key of the person who started it cannot be used. They can fix it in Settings, AI keys. No other key was used instead.";
export const AI_REFUSED = "The AI work stopped: the provider did not accept the AI key of the person who started it. They can fix it in Settings, AI keys. No other key was used instead.";
export const AI_NO_ANSWER = "The AI work stopped: the provider did not answer with the AI key of the person who started it. Try again later. No other key was used instead.";

const CROWD4TEST: UsageBilling = { owner: "crowd4test" };

export interface AiDeps {
    sql: Sql;
    config: Config;
}

/** The AI one piece of work uses. */
export interface WorkAi {
    /** Whose key: Crowd4Test's (organisational, or the open server's own key) or the person's own. */
    billing: UsageBilling;
    /** What this work uses: the server's key (open server only), a key, or nothing. */
    source: "server" | "configuration" | "blocked";
    configuration?: AiConfiguration;
    /** Only for building this work's client; never logged or returned. */
    key?: string;
    /** The sentence when `source` is "blocked", for the person themselves (NO_AI_KEY, KEY_NOT_AVAILABLE, NO_PERSON, or the key's problem). */
    blocked?: string;
    /** What is wrong with the key, for its owner (and the admins, for an organisational key). */
    problem?: string;
}

export const secretBoxOf = (config: Pick<Config, "dataDir" | "SECRET_KEY">): SecretBox => new SecretBox(config.dataDir, config.SECRET_KEY);
export const aiConfigStore = (d: AiDeps): AiConfigStore => new AiConfigStore(d.sql, secretBoxOf(d.config));

/** Who pays for a key's calls. */
export function billingOfKey(c: AiConfiguration): UsageBilling {
    return c.kind === "personal" ? { owner: "personal", personId: c.ownerPersonId } : CROWD4TEST;
}

/** Whether this server signs people in with Crowd4Test (then only Crowd4Test admins and sub-admins hold organisational keys). */
export const crowd4testOn = (config: Pick<Config, "C4T_API_ORIGIN">): boolean => Boolean(config.C4T_API_ORIGIN?.trim());

/** May this person be assigned an organisational key (and keep using one)? Crowd4Test admins and sub-admins; without Crowd4Test sign-in, owners. */
export async function mayHoldOrganisational(d: AiDeps, personId: string): Promise<boolean> {
    if (personId === OPEN_OWNER_ID) return true;
    return Boolean(await d.sql.get(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${assignableSql("u", crowd4testOn(d.config))}`, personId));
}

/** Is this person still someone here (active)? The open server always is. */
export async function personActive(sql: Sql, personId: string): Promise<boolean> {
    if (personId === OPEN_OWNER_ID) return true;
    return Boolean(await sql.get("SELECT 1 AS x FROM users WHERE id = ? AND role IS NOT NULL AND status = 'active'", personId));
}

/** May this person use this key? Their own personal key, or an organisational key assigned to them that they may still hold. */
export async function mayUseKey(store: AiConfigStore, d: AiDeps, c: AiConfiguration, personId: string): Promise<boolean> {
    if (c.kind === "personal") return c.ownerPersonId === personId;
    return (await store.isAssigned(c.id, personId)) && (await mayHoldOrganisational(d, personId));
}

/** The key, and its address check, or what is wrong. */
async function usable(store: AiConfigStore, c: AiConfiguration): Promise<{ key: string } | { problem: string }> {
    let key: string;
    try {
        key = await store.keyOf(c.id);
    } catch {
        return { problem: "The stored key could not be read. Enter it again." };
    }
    if (c.baseUrl) {
        try {
            await assertAllowedTarget(c.baseUrl);
        } catch {
            // Never why: whether a name resolves to a private address is itself something to keep from the person who typed it.
            return { problem: ADDRESS_NOT_REACHABLE };
        }
    }
    return { key };
}

/** Whether the server's own settings name a usable key (LLM_PROVIDER and its key in .env): used only for the open server. */
export function serverHasKey(config: Config): boolean {
    try {
        assertLlmConfigured(config);
        return true;
    } catch {
        return false;
    }
}

/**
 * The AI this person's work uses right now. `ownerId` is from aiOwnerOfActor / aiOwnerOfJob. Never throws.
 */
export async function resolveAiFor(d: AiDeps, ownerId: string | null): Promise<WorkAi> {
    if (!ownerId) return { billing: CROWD4TEST, source: "blocked", blocked: NO_PERSON };
    if (ownerId === ACCESS_KEY_OWNER) return { billing: CROWD4TEST, source: "server" };
    const blocked = (sentence: string, problem?: string): WorkAi => ({ billing: CROWD4TEST, source: "blocked", blocked: sentence, ...(problem ? { problem } : {}) });
    try {
        if (!(await personActive(d.sql, ownerId))) return blocked(PERSON_INACTIVE);
        const store = aiConfigStore(d);
        const chosen = await store.chosenOf(ownerId);
        if (!chosen) return ownerId === OPEN_OWNER_ID ? { billing: CROWD4TEST, source: "server" } : blocked(NO_AI_KEY);
        const row = await store.get(chosen);
        if (!row || !(await mayUseKey(store, d, row, ownerId))) return blocked(KEY_NOT_AVAILABLE);
        const u = await usable(store, row);
        if (!("key" in u)) return blocked(keyCannotBeUsed(u.problem), u.problem);
        return { billing: billingOfKey(row), source: "configuration", configuration: row, key: u.key };
    } catch {
        return blocked("Your AI key could not be read. Try again, or choose it again in Settings, AI keys.");
    }
}

/** The same refusal as a job says it (read by everyone on the project): no "you", no key, no person named. */
export function jobSentenceOf(blocked: string): string {
    if (blocked === NO_AI_KEY) return "AI is not available for this work: the person who started it has no AI key. They can add their own key in Settings, AI keys, or ask an admin to assign an organisational key.";
    if (blocked === NO_PERSON) return "AI is not available for this work: no person's AI key is behind it. Start it while signed in with your own account.";
    if (blocked === PERSON_INACTIVE) return PERSON_INACTIVE;
    return AI_NOT_AVAILABLE;
}

/** The sentence a person gets when their chosen key itself is the problem. */
export const keyCannotBeUsed = (problem: string): string => `Your chosen AI key cannot be used: ${problem} Fix it in Settings, AI keys.`;

/**
 * The person's AI as the "AI connected" signs show it: their chosen key's provider, model and label, or the open server's own key. Names
 * no key. A key whose last test failed does not count as connected.
 */
export async function personAiView(d: AiDeps, ownerId: string | null, serverModel?: string): Promise<{ configured: boolean; provider: string; model: string; via: "personal" | "organisational" | "server" | "none"; label?: string; problem?: string }> {
    const ai = await resolveAiFor(d, ownerId);
    if (ai.source === "configuration") {
        const c = ai.configuration!;
        const failed = c.status === "failed";
        return { configured: !failed, provider: c.provider, model: c.model, via: c.kind, label: c.label, ...(failed ? { problem: keyCannotBeUsed(c.statusNote ?? "its last test failed.") } : {}) };
    }
    if (ai.source === "server") {
        // The server's own model as the platform built it (a model given to the platform in code counts too), else its .env settings.
        const ok = serverModel !== undefined ? serverModel !== "unavailable" : serverHasKey(d.config);
        return { configured: ok, provider: d.config.LLM_PROVIDER, model: ok ? (serverModel ?? d.config.LLM_MODEL ?? "") : "unavailable", via: ok ? "server" : "none" };
    }
    return { configured: false, provider: "", model: "unavailable", via: "none", ...(ai.blocked ? { problem: ai.blocked } : {}) };
}

/**
 * The only things "Test this key" and a configuration's note say about a failure: its class, in words of our own. Nothing of the answer
 * (a custom endpoint's text could be anything, from anywhere) is ever shown.
 */
export type KeyFailure = "Key refused" | "Address not reachable" | "Provider busy" | "Unexpected answer";
export const ADDRESS_NOT_REACHABLE = "Address not reachable. Check the address, and that it is reachable from the internet.";
export function keyFailureOf(cls: LlmErrorClass): KeyFailure {
    if (cls === "auth" || cls === "credit") return "Key refused";
    if (cls === "network" || cls === "timeout") return "Address not reachable";
    if (cls === "rate_limited" || cls === "overloaded" || cls === "server" || cls === "paused") return "Provider busy";
    return "Unexpected answer";
}
const KEY_FAILURE_HINT: Record<KeyFailure, string> = {
    "Key refused": "The provider refused this key, or says it is out of credit. Check it and enter it again.",
    "Address not reachable": "Check the address, and that it is reachable from the internet.",
    "Provider busy": "Try again in a few minutes.",
    "Unexpected answer": "Check the provider, the model name and the address.",
};
/** "Key refused. The provider refused this key..." */
export const keyFailureWords = (cls: LlmErrorClass): string => `${keyFailureOf(cls)}. ${KEY_FAILURE_HINT[keyFailureOf(cls)]}`;

/** A provider's failure in words a person who manages keys can act on. */
export function keyProblemWords(cls: LlmErrorClass): string {
    switch (cls) {
        case "auth":
            return "The provider refused this key. Check it and enter it again.";
        case "credit":
            return "The provider says this key is out of credit.";
        case "model":
            return "The provider does not offer this model with this key, or the address is wrong.";
        default:
            return CLASS_RULES[cls].sentence;
    }
}

const hide = (text: string, key: string): string => (key ? text.split(key).join("[hidden]") : text);

/** The server's settings with this configuration in their place. Nothing of the server's AI setup is left in it. */
export function configWith(config: Config, c: Pick<AiConfiguration, "provider" | "model" | "baseUrl">, key: string): Config {
    return { ...config, LLM_PROVIDER: c.provider, LLM_MODEL: c.model, LLM_API_KEY: key, LLM_BASE_URL: c.baseUrl ?? undefined, LLM_FALLBACK_MODELS: undefined, LLM_MODEL_FAST: undefined, LLM_MODEL_FAST_IMAGES: undefined };
}

/** How a client on a project's key behaves: its own pause counter, no fallback, and failures that name no key (read by testers too). */
function ownKeyOptions(c: AiConfiguration, key: string, words: boolean, onKeyFailed?: (e: LlmCallError) => void): CreateClientOptions {
    return {
        fallbacks: [],
        fetch: guardedFetch,
        ownKey: {
            id: c.id,
            onKeyFailed,
            explain: (err) => {
                const detail = err.info.detail === undefined ? {} : { detail: hide(err.info.detail, key) };
                if (!words) return new LlmCallError({ ...err.info, ...detail }, { modelName: err.modelName, cause: undefined });
                const rule = CLASS_RULES[err.cls];
                if (!rule.fallback) return new LlmCallError({ ...err.info, ...detail }, { modelName: err.modelName, cause: undefined });
                const refused = err.cls === "auth" || err.cls === "credit" || err.cls === "model";
                return new LlmCallError({ cls: err.cls }, { modelName: err.modelName, sentence: refused ? AI_REFUSED : AI_NO_ANSWER });
            },
        },
    };
}

/** What a job or route does when a key fails for good: the key shows it, for the people who manage it. */
const markFailed = (d: AiDeps, c: AiConfiguration) => (e: LlmCallError) => {
    void aiConfigStore(d)
        .setStatus(c.id, "failed", keyFailureWords(e.cls), false)
        .catch(() => undefined);
};

/** Builds a model client from settings; tests hand in a scripted double. */
export type MakeLlm = (config: Config) => LlmClient;

/** One piece of work's client on a key, or the sentence when it is blocked (the open server's own key goes through llm-routing.ts). */
export function clientOfConfiguration(d: AiDeps, ai: WorkAi, o: { makeLlm?: MakeLlm; onEscalation?: (e: { to: string }) => void; blockedSentence?: string } = {}): LlmClient {
    if (ai.source !== "configuration") return unavailableLlmClient(o.blockedSentence ?? ai.blocked ?? AI_NOT_AVAILABLE);
    const c = ai.configuration!;
    const key = ai.key!;
    const cfg = configWith(d.config, c, key);
    const options = ownKeyOptions(c, key, true, markFailed(d, c));
    const build = (settings: Config) => (o.makeLlm ? o.makeLlm(settings) : createLlmClient(settings, options));
    try {
        const main = build(cfg);
        if (!c.fastModel || c.fastModel === c.model) return main;
        return routedClient(main, { fast: build({ ...cfg, LLM_MODEL: c.fastModel }), fastImages: false, onEscalation: o.onEscalation });
    } catch (e) {
        if (e instanceof LlmNotConfiguredError) return unavailableLlmClient(AI_NOT_AVAILABLE);
        throw e;
    }
}

/** A job's client on a key: as `clientOfConfiguration`, with escalations counted on the usage rows of whoever pays. */
export function configuredLlmForJob(deps: AiDeps & { db: Db; emit?: (e: EngineEvent) => void }, job: { id: string; projectId: string }, ai: WorkAi, makeLlm?: MakeLlm): LlmClient {
    return clientOfConfiguration(deps, ai, {
        makeLlm,
        // A job is read by everyone on the project: the neutral sentence, never the starter's own.
        blockedSentence: AI_NOT_AVAILABLE,
        onEscalation: (e) => {
            try {
                usageStoreFor(deps.db, deps.config).addUsage({ jobId: job.id, projectId: job.projectId, purpose: ESCALATION_PURPOSE, model: e.to, at: new Date(), calls: 1, failedCalls: 0, inputTokens: 0, outputTokens: 0, images: 0, estimatedCalls: 0, billing: ai.billing });
            } catch {
                // Counting must never break a job.
            }
        },
    });
}

/** The client for a model call outside a job (a route), for the person acting: with who pays, and the sentence when it cannot run. */
export async function personLlm(p: AiDeps, ownerId: string | null): Promise<{ llm: LlmClient; billing: UsageBilling; blocked?: string }> {
    const ai = await resolveAiFor(p, ownerId);
    if (ai.source === "server") return { llm: createLlmClientOrUnavailable(p.config), billing: ai.billing };
    return { llm: clientOfConfiguration(p, ai), billing: ai.billing, ...(ai.blocked ? { blocked: ai.blocked } : {}) };
}

/**
 * Whether this person can use AI at all (a key that is there, not whether a worker runs): `ok` false with the plain reason. What checks in
 * front of AI work ask.
 */
export async function aiGate(p: AiDeps & { llm: { modelName: string } }, ownerId: string | null): Promise<{ ok: true } | { ok: false; reason?: string }> {
    const ai = await resolveAiFor(p, ownerId);
    // A key whose last call failed may work again (credit added): the work starts, and fails with the provider's answer if it still does not.
    if (ai.source === "configuration") return { ok: true };
    if (ai.source === "blocked") return { ok: false, reason: ai.blocked ?? NO_AI_KEY };
    // The open server or the shared access key on the server's own key: with none, the caller says "no AI model" in its own words.
    return p.llm.modelName === "unavailable" ? { ok: false } : { ok: true };
}

export interface KeyTestResult {
    ok: boolean;
    message: string;
    model: string;
    latencyMs: number;
    /** What went wrong, in the provider-family words of errors.ts. */
    problem?: string;
    inputTokens: number;
    outputTokens: number;
}

/** One minimal call through the same provider code a job uses: one attempt, no fallback, sent even while the configuration is paused. */
export async function testConfiguration(d: AiDeps, c: AiConfiguration, o: { now?: () => number } = {}): Promise<KeyTestResult> {
    const now = o.now ?? Date.now;
    const store = aiConfigStore(d);
    const u = await usable(store, c);
    if (!("key" in u)) return { ok: false, message: `It did not work. ${u.problem}`, model: c.model, latencyMs: 0, problem: u.problem, inputTokens: 0, outputTokens: 0 };
    const { key } = u;
    const client = createLlmClient(configWith(d.config, c, key), { ...ownKeyOptions(c, key, false), resilience: { probe: true, policy: { attempts: 1, attemptTimeoutMs: 20_000, deadlineMs: 25_000 } } });
    const t0 = now();
    try {
        await client.text({ system: "You answer connection checks.", prompt: "Reply with the single word OK.", maxOutputTokens: 16, purpose: "other" });
        return { ok: true, message: `It worked: ${client.modelName} answered.`, model: client.modelName, latencyMs: now() - t0, inputTokens: client.usage.inputTokens, outputTokens: client.usage.outputTokens };
    } catch (e) {
        const err = isLlmCallError(e) ? e : toLlmCallError(e, { modelName: client.modelName });
        // Only the class of failure: the answer's own text could be anything a custom address sends back.
        const problem = keyFailureWords(err.cls);
        return { ok: false, message: `It did not work. ${problem}`, model: client.modelName, latencyMs: now() - t0, problem, inputTokens: client.usage.inputTokens, outputTokens: client.usage.outputTokens };
    }
}
