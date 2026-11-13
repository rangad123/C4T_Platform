/**
 * AI keys (round 57; docs/features/ai-keys.md). Two kinds: a person's own personal keys, and Crowd4Test's organisational keys that admins
 * assign to particular admins and sub-admins. Each person chooses one key; all the AI work they start uses it. Projects choose nothing.
 *
 *   GET    /api/me/ai                          → { chosen, problem, personal, organisational (assigned to me), canManageOrganisational, providers, openServer }
 *   PUT    /api/me/ai/chosen                   { keyId } → the same answer (one of mine, or assigned to me)
 *   POST   /api/me/ai/keys                     a personal key → { key }
 *   PATCH  /api/me/ai/keys/:keyId              change one of my keys; a new provider or address needs the key entered again
 *   DELETE /api/me/ai/keys/:keyId              remove one of my keys (my choice of it clears)
 *   POST   /api/me/ai/keys/:keyId/test         "Test this key": one of mine, or an organisational key assigned to me
 *   GET    /api/admin/ai-keys                  → { keys (with assignees), people (who may be assigned), providers }   Crowd4Test admins only
 *   POST   /api/admin/ai-keys                  an organisational key
 *   PATCH  /api/admin/ai-keys/:keyId           change it
 *   DELETE /api/admin/ai-keys/:keyId           remove it (people who chose it lose that choice)
 *   POST   /api/admin/ai-keys/:keyId/test      "Test this key"
 *   PUT    /api/admin/ai-keys/:keyId/assignees { personIds } → the key with its assignees (admins and sub-admins only)
 *
 * A key goes in and never comes out: no answer carries it, only its last four characters. Activity (which admins read) never names a personal
 * key, its provider, model or address: only "their own AI key". A personal key exists only for its person (anyone
 * else, admins included, gets the same 404 as an unknown key); an organisational key exists only for the people it is assigned to, and the admins.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { defaultModelOf, LLM_PROVIDERS, type LlmProviderId } from "../../engine/llm/provider.js";
import { OPEN_OWNER_ID, ownerIdOfActor } from "../agent-store.js";
import { aiConfigStore, billingOfKey, crowd4testOn, keyCannotBeUsed, keyProblemWords, mayHoldOrganisational, mayUseKey, NO_AI_KEY, resolveAiFor, serverHasKey, testConfiguration } from "../ai-config.js";
import { assignableSql, type AiConfiguration } from "../ai-config-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, permissionsOf, sideOf, type Actor } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { CONNECTION_CHECK_PROJECT } from "../llm-health.js";
import { assertAllowedTarget } from "../net-guard.js";
import { usageStoreFor } from "../usage-store.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

export const KEY_NOT_FOUND = "AI key not found";
export const MAX_PERSONAL_KEYS = 20;
export const MAX_ORGANISATIONAL_KEYS = 50;
const ONLY_ADMINS = "Only Crowd4Test admins manage organisational AI keys.";
const NO_KEYS_FOR_THIS = "Sign in with your own account to add and use AI keys.";
const NOT_STAFF = "Organisational keys can be assigned only to Crowd4Test admins and sub-admins.";
const NEW_KEY_NEEDED = "Enter the key again when you change the provider or the address: a stored key is only sent where it was entered for.";

const PROVIDER_WORDS: Record<LlmProviderId, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "openai-compatible": "Custom endpoint" };

const Label = z.string().trim().min(1, "Give the configuration a name.").max(80, "A name is at most 80 characters.");
const Provider = z.enum(LLM_PROVIDERS as unknown as [LlmProviderId, ...LlmProviderId[]], { message: "Choose a provider." });
const Model = z
    .string()
    .trim()
    .min(1, "Name the model.")
    .max(200, "A model name is at most 200 characters.")
    .regex(/^[^\s,\u0000-\u001f<>]*$/, "One model name, without spaces or commas.");
const FastModel = z
    .string()
    .trim()
    .max(200, "A model name is at most 200 characters.")
    .regex(/^[^\s,\u0000-\u001f<>]*$/, "One model name, without spaces or commas.")
    .nullable();
const ApiKey = z
    .string()
    .trim()
    .min(8, "An AI key is at least 8 characters.")
    .max(1000, "An AI key is at most 1000 characters.")
    .regex(/^[^\s\u0000-\u001f]*$/, "An AI key has no spaces or line breaks.");
const BaseUrl = z.string().trim().max(500, "An address is at most 500 characters.").nullable();

const Fields = { label: Label, provider: Provider, model: Model, fastModel: FastModel.optional(), baseUrl: BaseUrl.optional(), apiKey: ApiKey };
const NewKeyBody = z.object(Fields).strict();
const ChangeBody = z.object({ label: Label.optional(), model: Model.optional(), fastModel: FastModel.optional(), provider: Provider.optional(), baseUrl: BaseUrl.optional(), apiKey: ApiKey.optional() }).strict();
const ChosenBody = z.object({ keyId: z.string().min(1).max(100) }).strict();
const AssigneesBody = z.object({ personIds: z.array(z.string().min(1).max(100)).max(200) }).strict();

/** An address for a custom endpoint: only that provider has one, it must be a plain http(s) URL, and the platform's address guard applies. */
async function checkedAddress(provider: LlmProviderId, baseUrl: string | null | undefined): Promise<string | null> {
    const raw = baseUrl?.trim() || null;
    if (provider !== "openai-compatible") {
        if (raw) throw new HttpError(400, "Only a custom endpoint has an address.");
        return null;
    }
    if (!raw) throw new HttpError(400, "A custom endpoint needs its address, like https://llm.example.com/v1.");
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new HttpError(400, "That address is not a valid URL.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "The address must start with http:// or https://.");
    if (u.username || u.password) throw new HttpError(400, "Put the key in the key field, not in the address.");
    await assertAllowedTarget(raw);
    return raw.replace(/\/+$/, "");
}

/** The last check of "Test this key" per configuration, so one person cannot hammer a provider with someone's key. */
const lastTest = new Map<string, number>();
const running = new Set<string>();
const TEST_MIN_INTERVAL_MS = 2_000;

/** Tests only: forget the last checks. */
export function resetKeyTests(): void {
    lastTest.clear();
    running.clear();
}

export function registerAiConfigRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const control = accessControlOf(app);
    const store = aiConfigStore(p);
    const who = (req: FastifyRequest): Actor => actorOf(req) ?? currentActor();
    const note = (actor: Actor, action: string, detail: string) => control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail, projectId: null });

    /** The person behind the request who may have AI keys: a signed-in person who may use AI, or the open server. Else refused. */
    const personOf = (req: FastifyRequest): string => {
        const actor = who(req);
        const id = ownerIdOfActor(actor);
        if (!id) throw new HttpError(403, NO_KEYS_FOR_THIS);
        if (actor.kind === "user") {
            const held = permissionsOf(actor);
            if (!held.has("ai_studio.tests.generate") && !held.has("ai_studio.agent.run")) throw new HttpError(403, "You don't have permission to use AI here. Ask your Crowd4Test administrator.");
        }
        return id;
    };

    /** Crowd4Test admins (C4T role ADMIN); without Crowd4Test sign-in, people holding the platform settings; the open server. */
    const isKeyAdmin = (actor: Actor): boolean => {
        if (actor.kind === "open") return true;
        if (actor.kind !== "user" || !actor.id) return false;
        const held = permissionsOf(actor);
        const side = sideOf(actor);
        if (side === "admin") return held.has("ai_studio.ai_keys.manage") && control.projects.store.crowd4TestAccountOf(actor.id)?.c4tRole === "ADMIN";
        // A local account manages them only on a server without Crowd4Test sign-in.
        return side === "local" && !crowd4testOn(p.config) && held.has("ai_studio.platform.settings");
    };
    const refuseUnlessAdmin = (req: FastifyRequest): Actor => {
        const actor = who(req);
        if (!isKeyAdmin(actor)) throw new HttpError(403, ONLY_ADMINS);
        return actor;
    };

    const providers = () => LLM_PROVIDERS.map((id) => ({ id, name: PROVIDER_WORDS[id], defaultModel: defaultModelOf(id), needsAddress: id === "openai-compatible" }));

    const viewOf = (c: AiConfiguration, chosenId: string | null) => ({
        id: c.id,
        kind: c.kind,
        label: c.label,
        provider: c.provider,
        providerWords: PROVIDER_WORDS[c.provider] ?? c.provider,
        model: c.model,
        fastModel: c.fastModel,
        baseUrl: c.baseUrl,
        keyHint: c.keyHint,
        status: c.status,
        statusNote: c.statusNote,
        lastValidatedAt: c.lastValidatedAt,
        chosen: c.id === chosenId,
    });

    const people = () =>
        p.db.all<{ id: string; name: string | null; email: string; c4t_role: string | null; role: string }>(
            `SELECT u.id, u.name, u.email, u.c4t_role, u.role FROM users u WHERE ${assignableSql("u", crowd4testOn(p.config))} ORDER BY COALESCE(u.name, u.email), u.id`,
        );
    const personWords = (r: { id: string; name: string | null; email: string; c4t_role: string | null; role: string }) => ({
        id: r.id,
        name: r.name || r.email,
        email: r.email,
        role: r.c4t_role === "ADMIN" ? "Admin" : r.c4t_role === "SUB_ADMIN" ? "Sub-admin" : "Owner",
    });

    const meAnswer = async (req: FastifyRequest) => {
        const person = personOf(req);
        const actor = who(req);
        const chosenId = await store.chosenOf(person);
        const personal = await store.personalOf(person);
        const organisational: AiConfiguration[] = [];
        if (await mayHoldOrganisational(p, person)) organisational.push(...(await store.assignedTo(person)));
        const ai = await resolveAiFor(p, person);
        const chosen = ai.source === "configuration" ? ai.configuration! : null;
        const problem = ai.source === "blocked" ? (ai.blocked ?? NO_AI_KEY) : chosen?.status === "failed" ? keyCannotBeUsed(chosen.statusNote ?? "its last test failed.") : ai.source === "server" && !serverHasKey(p.config) ? NO_AI_KEY : null;
        const open = person === OPEN_OWNER_ID;
        return {
            chosen: chosen ? viewOf(chosen, chosenId) : null,
            problem,
            personal: personal.map((c) => viewOf(c, chosenId)),
            organisational: organisational.map((c) => viewOf(c, chosenId)),
            canManageOrganisational: isKeyAdmin(actor),
            providers: providers(),
            openServer: open && ai.source === "server" ? { configured: serverHasKey(p.config), provider: p.config.LLM_PROVIDER, model: p.llm.modelName } : null,
        };
    };

    /** One of this person's own keys, or 404. */
    const mine = async (req: FastifyRequest, keyId: string): Promise<{ person: string; key: AiConfiguration }> => {
        const person = personOf(req);
        const key = await store.get(keyId);
        if (!key || key.kind !== "personal" || key.ownerPersonId !== person) throw new HttpError(404, KEY_NOT_FOUND);
        return { person, key };
    };
    const organisationalKey = async (keyId: string): Promise<AiConfiguration> => {
        const key = await store.get(keyId);
        if (!key || key.kind !== "organisational") throw new HttpError(404, KEY_NOT_FOUND);
        return key;
    };

    /** "Test this key", for whoever may: one call, its status, its usage on whoever pays. */
    const runTest = async (req: FastifyRequest, c: AiConfiguration) => {
        const now = Date.now();
        if (running.has(c.id)) throw new HttpError(409, "This key is being tested already.");
        if (now - (lastTest.get(c.id) ?? 0) < TEST_MIN_INTERVAL_MS) throw new HttpError(429, "Wait a few seconds before testing again.");
        running.add(c.id);
        lastTest.set(c.id, now);
        try {
            const r = await testConfiguration(p, c);
            await store.setStatus(c.id, r.ok ? "working" : "failed", r.ok ? null : (r.problem ?? keyProblemWords("unknown")), true);
            try {
                // One small call is still a call: it counts, for whoever pays for this key.
                usageStoreFor(p.db, p.config).addUsage({ jobId: `key-test-${c.id}`, projectId: CONNECTION_CHECK_PROJECT, purpose: "other", model: r.model, at: new Date(), calls: 1, failedCalls: r.ok ? 0 : 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, images: 0, estimatedCalls: 0, billing: billingOfKey(c) });
            } catch {
                // Counting must not hide the answer.
            }
            note(who(req), "ai-key-tested", `${c.kind === "organisational" ? `Organisational AI key “${c.label}”` : "Their own AI key"} was tested: ${r.ok ? "it worked" : "it did not work"}.`);
            return { ok: r.ok, message: r.message, latencyMs: r.latencyMs, key: (await store.get(c.id))! };
        } finally {
            running.delete(c.id);
        }
    };

    const change = async (req: FastifyRequest, cur: AiConfiguration) => {
        const body = parsePlain(ChangeBody, req.body);
        const provider = body.provider ?? cur.provider;
        const baseUrl = await checkedAddress(provider, body.baseUrl === undefined ? cur.baseUrl : body.baseUrl);
        if ((provider !== cur.provider || baseUrl !== cur.baseUrl) && !body.apiKey) throw new HttpError(400, NEW_KEY_NEEDED);
        const { fastModel, ...rest } = body;
        const next = await store.update(cur.id, { ...rest, baseUrl, ...(fastModel === undefined ? {} : { fastModel: fastModel || null }) });
        if (!next) throw new HttpError(404, KEY_NOT_FOUND);
        note(who(req), "ai-key-changed", `${next.kind === "organisational" ? `Organisational AI key “${next.label}”` : "Their own AI key"} was changed${body.apiKey ? ", with a new key" : ""}.`);
        return next;
    };

    // ── the person's own ────────────────────────────────────────────────────────
    app.get("/api/me/ai", async (req) => meAnswer(req));

    app.put("/api/me/ai/chosen", async (req) => {
        const person = personOf(req);
        const { keyId } = parsePlain(ChosenBody, req.body);
        const key = await store.get(keyId);
        if (!key || !(await mayUseKey(store, p, key, person))) throw new HttpError(404, KEY_NOT_FOUND);
        await store.setChosen(person, keyId);
        note(who(req), "ai-key-chosen", key.kind === "organisational" ? `Their AI work now uses the organisational key “${key.label}”.` : "Their AI work now uses their own key.");
        return meAnswer(req);
    });

    app.post("/api/me/ai/keys", async (req, reply) => {
        const person = personOf(req);
        const body = parsePlain(NewKeyBody, req.body);
        const baseUrl = await checkedAddress(body.provider, body.baseUrl);
        if ((await store.countPersonal(person)) >= MAX_PERSONAL_KEYS) throw new HttpError(409, `You can have at most ${MAX_PERSONAL_KEYS} AI keys. Remove one first.`);
        const created = await store.create({ ...body, kind: "personal", ownerPersonId: person, baseUrl, fastModel: body.fastModel || null, createdBy: actorLabel(who(req)) });
        // The first key a person adds is the one their work uses, so adding a key is enough to start.
        if (!(await store.chosenOf(person))) await store.setChosen(person, created.id);
        note(who(req), "ai-key-added", "Their own AI key was added.");
        return reply.code(201).send({ key: viewOf(created, await store.chosenOf(person)) });
    });

    app.patch("/api/me/ai/keys/:keyId", async (req) => {
        const { keyId } = req.params as { keyId: string };
        const { person, key } = await mine(req, keyId);
        return { key: viewOf(await change(req, key), await store.chosenOf(person)) };
    });

    app.delete("/api/me/ai/keys/:keyId", async (req, reply) => {
        const { keyId } = req.params as { keyId: string };
        await mine(req, keyId);
        await store.remove(keyId);
        note(who(req), "ai-key-removed", "Their own AI key was removed.");
        return reply.code(204).send();
    });

    app.post("/api/me/ai/keys/:keyId/test", async (req) => {
        const { keyId } = req.params as { keyId: string };
        const person = personOf(req);
        const key = await store.get(keyId);
        if (!key || !(await mayUseKey(store, p, key, person))) throw new HttpError(404, KEY_NOT_FOUND);
        const r = await runTest(req, key);
        return { ...r, key: viewOf(r.key, await store.chosenOf(person)) };
    });

    // ── admins: organisational keys ─────────────────────────────────────────────
    const adminView = async (c: AiConfiguration, everyone?: ReturnType<typeof people>) => {
        const all = new Map((everyone ?? people()).map((r) => [r.id, r]));
        const ids = await store.assigneesOf(c.id);
        const assignees = ids.map((id) => all.get(id) ?? p.db.get<{ id: string; name: string | null; email: string; c4t_role: string | null; role: string }>("SELECT id, name, email, c4t_role, role FROM users WHERE id = ?", id)).filter((r): r is NonNullable<typeof r> => Boolean(r)).map(personWords);
        return { ...viewOf(c, null), assignees };
    };

    app.get("/api/admin/ai-keys", async (req) => {
        refuseUnlessAdmin(req);
        const everyone = people();
        const keys = await store.organisational();
        return { keys: await Promise.all(keys.map((c) => adminView(c, everyone))), people: everyone.map(personWords), providers: providers() };
    });

    app.post("/api/admin/ai-keys", async (req, reply) => {
        const actor = refuseUnlessAdmin(req);
        const body = parsePlain(NewKeyBody, req.body);
        const baseUrl = await checkedAddress(body.provider, body.baseUrl);
        if ((await store.countOrganisational()) >= MAX_ORGANISATIONAL_KEYS) throw new HttpError(409, `There can be at most ${MAX_ORGANISATIONAL_KEYS} organisational AI keys. Remove one first.`);
        const created = await store.create({ ...body, kind: "organisational", baseUrl, fastModel: body.fastModel || null, createdBy: actorLabel(actor) });
        note(actor, "ai-key-added", `Organisational AI key “${created.label}” was added.`);
        return reply.code(201).send({ key: await adminView(created) });
    });

    app.patch("/api/admin/ai-keys/:keyId", async (req) => {
        refuseUnlessAdmin(req);
        const { keyId } = req.params as { keyId: string };
        return { key: await adminView(await change(req, await organisationalKey(keyId))) };
    });

    app.delete("/api/admin/ai-keys/:keyId", async (req, reply) => {
        const actor = refuseUnlessAdmin(req);
        const { keyId } = req.params as { keyId: string };
        const key = await organisationalKey(keyId);
        const chosenBy = (await store.choiceCounts()).get(keyId) ?? 0;
        await store.remove(keyId);
        note(actor, "ai-key-removed", `Organisational AI key “${key.label}” was removed${chosenBy ? `; ${chosenBy === 1 ? "one person" : `${chosenBy} people`} who used it must choose another key` : ""}.`);
        return reply.code(204).send();
    });

    app.post("/api/admin/ai-keys/:keyId/test", async (req) => {
        refuseUnlessAdmin(req);
        const { keyId } = req.params as { keyId: string };
        const r = await runTest(req, await organisationalKey(keyId));
        return { ...r, key: await adminView(r.key) };
    });

    app.put("/api/admin/ai-keys/:keyId/assignees", async (req) => {
        const actor = refuseUnlessAdmin(req);
        const { keyId } = req.params as { keyId: string };
        const key = await organisationalKey(keyId);
        const { personIds } = parsePlain(AssigneesBody, req.body);
        const everyone = people();
        const allowed = new Set(everyone.map((r) => r.id));
        if (personIds.some((id) => !allowed.has(id))) throw new HttpError(400, NOT_STAFF);
        const { added, removed } = await store.setAssignees(keyId, [...new Set(personIds)], actorLabel(actor));
        const name = (id: string) => personWords(everyone.find((r) => r.id === id) ?? { id, name: null, email: "someone", c4t_role: null, role: "" }).name;
        if (added.length) note(actor, "ai-key-assigned", `Organisational AI key “${key.label}” was assigned to ${added.map(name).join(", ")}.`);
        if (removed.length) note(actor, "ai-key-unassigned", `Organisational AI key “${key.label}” was taken away from ${removed.map(name).join(", ")}.`);
        return { key: await adminView(key, everyone) };
    });
}
