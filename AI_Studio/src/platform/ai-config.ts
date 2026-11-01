/**
 * Which AI a project's work uses, and who pays (AD-11, AI-02, AI-03). Read when a job starts, or when a route is about to call the model: the
 * answer is fixed for that piece of work, so the engine keeps reading only its own client and the settings caches, and never waits on this.
 *
 * - Managed AI: Crowd4Test pays. The platform's configuration the project picked, or the server's key when none is picked or it cannot be used.
 * - Own key: the organisation pays. Only that configuration is used, with its own models: no fallback models, no fast model from Settings, no
 *   server key. Anything wrong with it stops the AI work with a clear message; it never turns into spending Crowd4Test's key.
 *
 * The messages of a job are read by everyone on the project, testers too, so they name no key, label or provider. The detail stays on the
 * configuration (`status_note`), which only people who manage keys see.
 */
import type { Config } from "../config.js";
import { CLASS_RULES, isLlmCallError, LlmCallError, toLlmCallError, type LlmErrorClass } from "../engine/llm/errors.js";
import { assertLlmConfigured, createLlmClient, createLlmClientOrUnavailable, LlmNotConfiguredError, unavailableLlmClient, type CreateClientOptions, type LlmClient } from "../engine/llm/provider.js";
import { routedClient } from "../engine/llm/routing.js";
import { ESCALATION_PURPOSE, type UsageBilling } from "../engine/llm/usage.js";
import type { EngineEvent } from "../engine/context.js";
import { AiConfigStore, type AiConfiguration, type AiMode } from "./ai-config-store.js";
import type { Db } from "./db.js";
import { guardedFetch } from "./guarded-fetch.js";
import { assertAllowedTarget } from "./net-guard.js";
import { SecretBox } from "./secrets.js";
import type { Sql } from "./sql.js";
import { usageStoreFor } from "./usage-store.js";

export const AI_NOT_AVAILABLE = "AI is not available for this project: its AI configuration cannot be used. A project admin can fix it in Settings, AI configuration. Crowd4Test’s AI was not used instead.";
export const AI_REFUSED = "The AI work stopped: the provider did not accept this project’s AI configuration. A project admin can fix it in Settings, AI configuration. Crowd4Test’s AI was not used instead.";
export const AI_NO_ANSWER = "The AI work stopped: the provider did not answer with this project’s AI configuration. Try again later. Crowd4Test’s AI was not used instead.";

const CROWD4TEST: UsageBilling = { owner: "crowd4test", organizationId: null };

export interface AiDeps {
    sql: Sql;
    config: Config;
}

export interface ProjectAi {
    mode: AiMode;
    billing: UsageBilling;
    /** What this work uses: the server's key, a configuration, or nothing (own key that cannot be used). */
    source: "server" | "configuration" | "blocked";
    configuration?: AiConfiguration;
    /** Only for building this work's client; never logged or returned. */
    key?: string;
    /** The message for everyone when `source` is "blocked". */
    blocked?: string;
    /** What is wrong, for the people who manage keys. */
    problem?: string;
}

export const secretBoxOf = (config: Pick<Config, "dataDir" | "SECRET_KEY">): SecretBox => new SecretBox(config.dataDir, config.SECRET_KEY);
export const aiConfigStore = (d: AiDeps): AiConfigStore => new AiConfigStore(d.sql, secretBoxOf(d.config));

/** Who pays for a configuration's calls outside a project (its "Test this key"). */
export async function billingOfConfiguration(sql: Sql, c: AiConfiguration): Promise<UsageBilling> {
    if (c.ownerKind === "platform") return CROWD4TEST;
    return { owner: "organization", organizationId: c.ownerKind === "organization" ? c.organizationId : await organizationOf(sql, c.projectId ?? "") };
}

const organizationOf = async (sql: Sql, projectId: string): Promise<string | null> => (await sql.get<{ organization_id: string | null }>("SELECT organization_id FROM projects WHERE id = ?", projectId))?.organization_id ?? null;

/** May this project use this configuration? Checked at every use, so a project moved to another organisation stops using the old one's key at once. */
export function belongsTo(c: AiConfiguration, projectId: string, organizationId: string | null): boolean {
    if (c.ownerKind === "project") return c.projectId === projectId;
    return c.ownerKind === "organization" && Boolean(organizationId) && c.organizationId === organizationId;
}

/** The configuration, its key and its address check, or what is wrong. */
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

/**
 * The AI this project's work uses right now. Never throws: when the choice itself cannot be read the work is stopped, because a project on
 * its own key must not reach the server's key by accident.
 */
export async function resolveProjectAi(d: AiDeps, projectId: string): Promise<ProjectAi> {
    let organizationId: string | null = null;
    const stop = (problem: string): ProjectAi => ({ mode: "own", billing: { owner: "organization", organizationId }, source: "blocked", blocked: AI_NOT_AVAILABLE, problem });
    try {
        const store = aiConfigStore(d);
        const choice = await store.choice(projectId);
        organizationId = await organizationOf(d.sql, projectId);
        const row = choice.configurationId ? await store.get(choice.configurationId) : undefined;
        if (choice.mode === "managed") {
            if (row?.ownerKind !== "platform" || row.status === "failed") return { mode: "managed", billing: CROWD4TEST, source: "server" };
            const u = await usable(store, row);
            return "key" in u ? { mode: "managed", billing: CROWD4TEST, source: "configuration", configuration: row, key: u.key } : { mode: "managed", billing: CROWD4TEST, source: "server" };
        }
        if (!row) return stop("No configuration is chosen for this project.");
        if (!belongsTo(row, projectId, organizationId)) return stop("This configuration belongs to another organisation. Choose another one.");
        const u = await usable(store, row);
        if (!("key" in u)) return stop(u.problem);
        return { mode: "own", billing: { owner: "organization", organizationId }, source: "configuration", configuration: row, key: u.key };
    } catch {
        return stop("The project’s AI configuration could not be read.");
    }
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

/** A managed project's configuration is Crowd4Test's money either way: when it fails, the server's key answers, as for any other project. */
function managedOptions(config: Config): CreateClientOptions {
    try {
        assertLlmConfigured(config);
        return { fallbacks: [], thenServer: config, fetch: guardedFetch };
    } catch {
        return { fallbacks: [], fetch: guardedFetch };
    }
}

/** What a job or route does when a project's own key fails for good: the configuration shows it, for the people who manage keys. */
const markFailed = (d: AiDeps, c: AiConfiguration) => (e: LlmCallError) => {
    void aiConfigStore(d)
        .setStatus(c.id, "failed", keyFailureWords(e.cls), false)
        .catch(() => undefined);
};

/** Builds a model client from settings; tests hand in a scripted double. */
export type MakeLlm = (config: Config) => LlmClient;

/** One piece of work's client for a project whose AI is a configuration or blocked (a project on the server's key goes through llm-routing.ts). */
export function clientOfConfiguration(d: AiDeps, ai: ProjectAi, o: { makeLlm?: MakeLlm; onEscalation?: (e: { to: string }) => void } = {}): LlmClient {
    if (ai.source !== "configuration") return unavailableLlmClient(ai.blocked ?? AI_NOT_AVAILABLE);
    const c = ai.configuration!;
    const key = ai.key!;
    const cfg = configWith(d.config, c, key);
    const options = ai.mode === "own" ? ownKeyOptions(c, key, true, markFailed(d, c)) : managedOptions(d.config);
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

/** A job's client on a configuration: as `clientOfConfiguration`, with escalations counted on the usage rows of whoever pays. */
export function configuredLlmForJob(deps: AiDeps & { db: Db; emit?: (e: EngineEvent) => void }, job: { id: string; projectId: string }, ai: ProjectAi, makeLlm?: MakeLlm): LlmClient {
    return clientOfConfiguration(deps, ai, {
        makeLlm,
        onEscalation: (e) => {
            try {
                usageStoreFor(deps.db, deps.config).addUsage({ jobId: job.id, projectId: job.projectId, purpose: ESCALATION_PURPOSE, model: e.to, at: new Date(), calls: 1, failedCalls: 0, inputTokens: 0, outputTokens: 0, images: 0, estimatedCalls: 0, billing: ai.billing });
            } catch {
                // Counting must never break a job.
            }
        },
    });
}

/** The client for a model call outside a job (a route): with who pays, and the message when it cannot run. */
export async function projectLlm(p: AiDeps, projectId: string): Promise<{ llm: LlmClient; billing: UsageBilling; blocked?: string }> {
    const ai = await resolveProjectAi(p, projectId);
    if (ai.source === "server") return { llm: createLlmClientOrUnavailable(p.config), billing: ai.billing };
    return { llm: clientOfConfiguration(p, ai), billing: ai.billing, blocked: ai.blocked };
}

/**
 * Whether this project can use AI at all (a key that is there, not whether a worker runs): `ok` false with the plain reason. It is what
 * checks in front of AI work ask, instead of whether the server has a key of its own.
 */
export async function projectAiGate(p: AiDeps & { llm: { modelName: string } }, projectId: string): Promise<{ ok: true } | { ok: false; own: boolean; reason?: string }> {
    const ai = await resolveProjectAi(p, projectId);
    if (ai.source === "configuration") return { ok: true };
    if (ai.source === "blocked") return { ok: false, own: true, reason: ai.blocked };
    return p.llm.modelName === "unavailable" ? { ok: false, own: false } : { ok: true };
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
