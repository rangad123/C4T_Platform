/**
 * AI configuration (AD-10, AD-11, AI-02, AI-03, FL-E): who pays for a project's AI, which configuration it uses, and the keys.
 *
 *   GET    /api/projects/:id/ai                     → what the person may see of it: whether AI is available, always; who pays and the budget with
 *                                                     "see usage"; the configuration and its options with "manage keys"
 *   PUT    /api/projects/:id/ai                     { mode, configurationId? } → the same answer
 *   POST   /api/projects/:id/ai/configurations      a configuration of this project
 *   GET    /api/ai-configurations                   → { configurations, organizations, ... }  the ones the person manages
 *   POST   /api/ai-configurations                   a configuration of an organisation or of the platform
 *   PATCH  /api/ai-configurations/:configId         change it; a new provider or address needs the key entered again
 *   DELETE /api/ai-configurations/:configId         refused while a project uses it
 *   POST   /api/ai-configurations/:configId/test    "Test this key": one minimal call, the answer says whether it worked
 *
 * A key goes in and never comes out: no answer carries it, only its last four characters. A customer manages only their own organisation's
 * configurations; another's answers the same 404 as an unknown one. Testers hold neither permission, so they see only whether AI is available.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { defaultModelOf, LLM_PROVIDERS, type LlmProviderId } from "../../engine/llm/provider.js";
import { groupRows, monthBounds, monthOf, dayOf } from "../../engine/llm/usage.js";
import { aiConfigStore, belongsTo, billingOfConfiguration, keyProblemWords, platformAi, projectAiGate, resolveProjectAi, testConfiguration } from "../ai-config.js";
import type { AiConfiguration, AiMode, ConfigOwnerKind } from "../ai-config-store.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, permissionsOf, sideOf, type Actor } from "../auth/actor.js";
import type { Permission } from "../auth/permissions.js";
import { HttpError } from "../http-error.js";
import { CONNECTION_CHECK_PROJECT } from "../llm-health.js";
import { assertAllowedTarget } from "../net-guard.js";
import { runsCanStartHere } from "../suite-run.js";
import { usageStoreFor } from "../usage-store.js";
import { parsePlain } from "./project-settings.js";
import type { RouteCtx } from "./types.js";

export const CONFIGURATION_NOT_FOUND = "AI configuration not found";
const MANAGE: Permission = "ai_studio.ai_keys.manage";
const CANNOT_MANAGE = "You can manage AI keys only for your own organisation.";
/** AI configurations per organisation (its own and its projects'), and of the platform. */
export const MAX_CONFIGURATIONS_PER_ORGANIZATION = 20;
const CONFIGURATION_CAP = `An organisation can have at most ${MAX_CONFIGURATIONS_PER_ORGANIZATION} AI configurations. Remove one first.`;
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
const OrgId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organization id is letters, digits, - and _ (at most 64).");

const Fields = { label: Label, provider: Provider, model: Model, fastModel: FastModel.optional(), baseUrl: BaseUrl.optional(), apiKey: ApiKey };
const ProjectConfigBody = z.object(Fields).strict();
const GlobalConfigBody = z.object({ ...Fields, owner: z.enum(["organization", "platform"]), organizationId: OrgId.nullable().optional() }).strict();
const ChangeBody = z.object({ label: Label.optional(), model: Model.optional(), fastModel: FastModel.optional(), provider: Provider.optional(), baseUrl: BaseUrl.optional(), apiKey: ApiKey.optional() }).strict();
const ChoiceBody = z.object({ mode: z.enum(["managed", "own"]), configurationId: z.string().min(1).max(100).nullable().optional() }).strict();

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
    const note = (actor: Actor, action: string, detail: string, projectId?: string | null) => control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail, projectId: projectId ?? null });

    const orgName = (id: string | null): string | null => (id ? (control.projects.store.organizations().find((o) => o.id === id)?.name ?? null) : null);
    const projectOrg = (projectId: string): string | null => (ctx.project(projectId).organization_id as string | null) ?? null;
    const projectName = (id: string): string | null => p.repo.getProject(id)?.name ?? null;

    /** May this person change this configuration? The same words as seeing it: a configuration someone does not manage does not exist for them. */
    const manages = (actor: Actor, c: Pick<AiConfiguration, "ownerKind" | "organizationId" | "projectId">): boolean => {
        if (c.ownerKind === "project") return Boolean(c.projectId && control.projects.permissionsIn(actor, c.projectId)?.has(MANAGE));
        return mayOwn(actor, c.ownerKind, c.organizationId);
    };
    const mayOwn = (actor: Actor, kind: Exclude<ConfigOwnerKind, "project">, organizationId: string | null): boolean => {
        const held = permissionsOf(actor);
        if (!held.has(MANAGE)) return false;
        const side = sideOf(actor);
        if (side === "tester") return false;
        const here = control.projects.allowed(actor);
        // The platform's configurations are Crowd4Test's money: only people who reach every project manage them.
        if (kind === "platform") return side !== "customer" && held.has("ai_studio.platform.settings") && here === null;
        if (side === "customer") return Boolean(actor.organizationId) && organizationId === actor.organizationId;
        if (here === null) return true;
        // Staff limited to some projects: only the organisations of those projects.
        return Boolean(organizationId) && [...here.keys()].some((pid) => (p.repo.getProject(pid)?.organization_id ?? null) === organizationId);
    };

    const viewOf = (c: AiConfiguration, uses: ReadonlyMap<string, number>) => ({
        id: c.id,
        label: c.label,
        provider: c.provider,
        providerName: PROVIDER_WORDS[c.provider] ?? c.provider,
        model: c.model,
        fastModel: c.fastModel,
        baseUrl: c.baseUrl,
        keyEnding: c.keyHint,
        ownerKind: c.ownerKind,
        ownerName: c.ownerKind === "platform" ? "Crowd4Test" : c.ownerKind === "organization" ? (orgName(c.organizationId) ?? "Organisation") : (projectName(c.projectId ?? "") ?? "This project"),
        status: c.status,
        statusNote: c.statusNote,
        lastValidatedAt: c.lastValidatedAt,
        usedBy: uses.get(c.id) ?? 0,
    });

    const visible = async (req: FastifyRequest, id: string): Promise<AiConfiguration> => {
        const c = await store.get(id);
        if (!c || !manages(who(req), c)) throw new HttpError(404, CONFIGURATION_NOT_FOUND);
        return c;
    };

    // `hasKey`: whether Crowd4Test's managed AI can answer here, from the server's own key or a working Crowd4Test configuration.
    const serverFacts = async () => {
        const runs = runsCanStartHere(p);
        return { hasKey: (await platformAi(p, p.llm.modelName)).configured, runsHere: runs.ok };
    };
    const providers = () => LLM_PROVIDERS.map((id) => ({ id, name: PROVIDER_WORDS[id], defaultModel: defaultModelOf(id), needsAddress: id === "openai-compatible" }));

    /** The project's AI as this person may see it: a tester learns only whether AI is available, and nothing that would tell them more. */
    const projectAnswer = async (req: FastifyRequest, id: string) => {
        const actor = who(req);
        const held = control.projects.permissionsIn(actor, id) ?? permissionsOf(actor);
        const canManage = held.has(MANAGE) && sideOf(actor) !== "tester";
        const seesUsage = held.has("ai_studio.usage.view") && sideOf(actor) !== "tester";
        const gate = await projectAiGate(p, id);
        const ai = await resolveProjectAi(p, id);
        const server = await serverFacts();
        // A key known not to work does not count: nobody is told AI is available until it is fixed and tested again.
        const ready = gate.ok && !(ai.mode === "own" && ai.configuration?.status === "failed");
        const answer: Record<string, unknown> = { available: ready && server.runsHere, ready, runsHere: server.runsHere };
        if (!canManage && !seesUsage) return answer;

        const choice = await store.choice(id);
        const organizationId = projectOrg(id);
        answer.canManage = canManage;
        answer.mode = choice.mode satisfies AiMode;
        answer.billingOwner = choice.mode === "own" ? "organization" : "crowd4test";
        answer.organizationName = orgName(organizationId);
        answer.serverHasKey = server.hasKey;
        if (seesUsage) {
            const usage = usageStoreFor(p.db, p.config);
            const now = Date.now();
            const month = monthOf(now);
            const rows = usage.rows(monthBounds(month).from, dayOf(now), id);
            answer.budget = { ...usage.projectBudget(id), usedTokens: usage.monthTokens(month, id), warnPercent: usage.platformBudget().warnPercent };
            answer.usageByOwner = groupRows(rows, "billing", usage.prices()).map((g) => ({ owner: g.key, calls: g.calls, totalTokens: g.totalTokens, cost: g.cost }));
            answer.currency = usage.currency();
        }
        if (canManage) {
            const all = await store.list();
            const uses = await store.useCounts();
            const chosen = choice.configurationId ? all.find((c) => c.id === choice.configurationId) : undefined;
            answer.configurationId = choice.configurationId;
            // A customer on one of the platform's configurations knows its name, never anything about its key.
            answer.configuration = chosen && manages(actor, chosen) ? viewOf(chosen, uses) : null;
            answer.problem = ai.source === "blocked" ? (ai.problem ?? null) : null;
            answer.ownOptions = all.filter((c) => belongsTo(c, id, organizationId)).map((c) => viewOf(c, uses));
            answer.managedOptions = all.filter((c) => c.ownerKind === "platform").map((c) => ({ id: c.id, label: c.label, model: c.model, providerName: PROVIDER_WORDS[c.provider] ?? c.provider }));
            answer.providers = providers();
        }
        return answer;
    };

    app.get("/api/projects/:id/ai", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return projectAnswer(req, id);
    });

    app.put("/api/projects/:id/ai", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const body = parsePlain(ChoiceBody, req.body);
        const actor = who(req);
        const configurationId = body.configurationId ?? null;
        const before = await store.choice(id);
        if (configurationId) {
            const c = await store.get(configurationId);
            const allowed = c && (body.mode === "own" ? belongsTo(c, id, projectOrg(id)) : c.ownerKind === "platform");
            if (!allowed) throw new HttpError(404, CONFIGURATION_NOT_FOUND);
        } else if (body.mode === "own") {
            throw new HttpError(400, "Choose the configuration this project uses, or add one first.");
        }
        await store.setChoice(id, { mode: body.mode, configurationId }, actorLabel(actor));
        // AI-03: who pays changing is never silent.
        if (before.mode !== body.mode || before.configurationId !== configurationId) note(actor, "ai-configuration-changed", body.mode === "own" ? "The project now uses its own AI key; its organisation pays." : "The project now uses Crowd4Test’s managed AI; Crowd4Test pays.", id);
        return projectAnswer(req, id);
    });

    app.post("/api/projects/:id/ai/configurations", async (req, reply) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        const actor = who(req);
        const body = parsePlain(ProjectConfigBody, req.body);
        const baseUrl = await checkedAddress(body.provider, body.baseUrl);
        if ((await store.countOf(projectOrg(id))) >= MAX_CONFIGURATIONS_PER_ORGANIZATION) throw new HttpError(409, CONFIGURATION_CAP);
        const created = await store.create({ ...body, ownerKind: "project", projectId: id, baseUrl, fastModel: body.fastModel || null, createdBy: actorLabel(actor) });
        note(actor, "ai-configuration-added", `AI configuration “${created.label}” added.`, id);
        return reply.code(201).send(viewOf(created, new Map()));
    });

    app.get("/api/ai-configurations", async (req) => {
        const actor = who(req);
        const uses = await store.useCounts();
        const mine = (await store.list()).filter((c) => manages(actor, c));
        const orgs = control.projects.store.organizations().filter((o) => mayOwn(actor, "organization", o.id));
        const customerOrg = sideOf(actor) === "customer" && actor.organizationId && !orgs.some((o) => o.id === actor.organizationId) ? [{ id: actor.organizationId, name: orgName(actor.organizationId) }] : [];
        return { configurations: mine.map((c) => viewOf(c, uses)), organizations: [...orgs.map((o) => ({ id: o.id, name: o.name })), ...customerOrg], canAddPlatform: mayOwn(actor, "platform", null), providers: providers(), server: await serverFacts() };
    });

    app.post("/api/ai-configurations", async (req, reply) => {
        const actor = who(req);
        const body = parsePlain(GlobalConfigBody, req.body);
        const { owner, organizationId, ...fields } = body;
        let org: string | null = null;
        if (owner === "organization") {
            org = sideOf(actor) === "customer" ? (actor.organizationId ?? null) : (organizationId ?? null);
            if (sideOf(actor) === "customer" && organizationId && organizationId !== actor.organizationId) throw new HttpError(403, CANNOT_MANAGE);
            if (!org) throw new HttpError(400, "Choose the organisation this configuration belongs to.");
        }
        if (!mayOwn(actor, owner, org)) throw new HttpError(403, owner === "platform" ? "Only Crowd4Test staff with platform settings manage the platform’s AI configurations." : CANNOT_MANAGE);
        const baseUrl = await checkedAddress(fields.provider, fields.baseUrl);
        if ((await store.countOf(org)) >= MAX_CONFIGURATIONS_PER_ORGANIZATION) throw new HttpError(409, CONFIGURATION_CAP);
        if (org) control.projects.store.ensureOrganization(org);
        const created = await store.create({ ...fields, ownerKind: owner, organizationId: org, baseUrl, fastModel: fields.fastModel || null, createdBy: actorLabel(actor) });
        note(actor, "ai-configuration-added", `AI configuration “${created.label}” added.`);
        return reply.code(201).send(viewOf(created, new Map()));
    });

    app.patch("/api/ai-configurations/:configId", async (req) => {
        const { configId } = req.params as { configId: string };
        const cur = await visible(req, configId);
        const actor = who(req);
        const body = parsePlain(ChangeBody, req.body);
        const provider = body.provider ?? cur.provider;
        const baseUrl = await checkedAddress(provider, body.baseUrl === undefined ? cur.baseUrl : body.baseUrl);
        if ((provider !== cur.provider || baseUrl !== cur.baseUrl) && !body.apiKey) throw new HttpError(400, NEW_KEY_NEEDED);
        const { fastModel, ...rest } = body;
        const next = await store.update(configId, { ...rest, baseUrl, ...(fastModel === undefined ? {} : { fastModel: fastModel || null }) });
        if (!next) throw new HttpError(404, CONFIGURATION_NOT_FOUND);
        note(actor, "ai-configuration-changed", `AI configuration “${next.label}” changed${body.apiKey ? ", with a new key" : ""}.`, cur.projectId);
        return viewOf(next, await store.useCounts());
    });

    app.delete("/api/ai-configurations/:configId", async (req, reply) => {
        const { configId } = req.params as { configId: string };
        const cur = await visible(req, configId);
        const inUse = (await store.useCounts()).get(configId) ?? 0;
        if (inUse > 0) throw new HttpError(409, `${inUse === 1 ? "A project uses" : `${inUse} projects use`} this configuration. Move ${inUse === 1 ? "it" : "them"} to another one first.`);
        await store.remove(configId);
        note(who(req), "ai-configuration-removed", `AI configuration “${cur.label}” removed.`, cur.projectId);
        return reply.code(204).send();
    });

    app.post("/api/ai-configurations/:configId/test", async (req) => {
        const { configId } = req.params as { configId: string };
        const c = await visible(req, configId);
        const now = Date.now();
        if (running.has(configId)) throw new HttpError(409, "This key is being tested already.");
        if (now - (lastTest.get(configId) ?? 0) < TEST_MIN_INTERVAL_MS) throw new HttpError(429, "Wait a few seconds before testing again.");
        running.add(configId);
        lastTest.set(configId, now);
        try {
            const r = await testConfiguration(p, c);
            await store.setStatus(configId, r.ok ? "working" : "failed", r.ok ? null : (r.problem ?? keyProblemWords("unknown")), true);
            try {
                // One small call is still a call: it counts, for whoever pays for this key.
                usageStoreFor(p.db, p.config).addUsage({ jobId: `key-test-${configId}`, projectId: c.projectId ?? CONNECTION_CHECK_PROJECT, purpose: "other", model: r.model, at: new Date(), calls: 1, failedCalls: r.ok ? 0 : 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, images: 0, estimatedCalls: 0, billing: await billingOfConfiguration(p.sql, c) });
            } catch {
                // Counting must not hide the answer.
            }
            note(who(req), "ai-key-tested", `“${c.label}” was tested: ${r.ok ? "it worked" : "it did not work"}.`, c.projectId);
            return { ok: r.ok, message: r.message, latencyMs: r.latencyMs, configuration: viewOf((await store.get(configId))!, await store.useCounts()) };
        } finally {
            running.delete(configId);
        }
    });
}
