/**
 * The Integrations place: connections set up once for an organisation, and the projects that use them (shared-integrations.ts).
 *
 *   GET    /api/shared-integrations                       → { connections, ownUses, organizations, projects, canAddPlatform }, narrowed to the person
 *   POST   /api/shared-integrations                       { kind, name?, organizationId?, verify?, ...settings } a new shared connection
 *   PATCH  /api/shared-integrations/:sid                  change it; every project using it gets the change. A new address or target needs the secret again
 *   DELETE /api/shared-integrations/:sid                  refused while a project uses it
 *   POST   /api/shared-integrations/:sid/test             "Test the connection": one real call (a test message for an alert channel)
 *   GET    /api/projects/:id/shared-integrations          which of the project's connections came from here (the settings panels mark them)
 *   PUT    /api/projects/:id/shared-integrations/:sid     the project uses it
 *   DELETE /api/projects/:id/shared-integrations/:sid     the project stops using it
 *
 * Setting one up needs "manage keys and connections" (ai_studio.ai_keys.manage), the code that already guards these very connections in a
 * project, limited to the person's own organisation exactly like an organisation's AI configuration. Choosing which projects use it is a
 * project setting (ai_studio.project.settings in that project). The secret goes in and never comes out. Every outbound call goes through the
 * guarded fetch (no redirect, no private address with BLOCK_PRIVATE_TARGETS on), and the address is checked when it is saved too.
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { deliver, teamsPayload, testContent, testSlackPayload, testWebhookPayload, type AlertSubject } from "../alerts.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, permissionsOf, sideOf, type Actor } from "../auth/actor.js";
import type { Permission } from "../auth/permissions.js";
import { visibleProjectsOf } from "../auth/project-scope.js";
import { HttpError } from "../http-error.js";
import { TrackerError } from "../issues/http.js";
import { providerFor, splitSettings } from "../issues/store.js";
import { GithubSettings, JiraSettings, NotionSettings, type IntegrationConfig } from "../issues/types.js";
import { assertAllowedTarget } from "../net-guard.js";
import { SecretBox } from "../secrets.js";
import { SentryClient, SentrySettings, type SentryConfig } from "../sentry/client.js";
import { isAlertKind, LinkRefused, MAX_SHARED_PER_OWNER, SHARED_KINDS, SharedIntegrationStore, type SharedIntegration, type SharedKind } from "../shared-integrations.js";
import type { RouteCtx } from "./types.js";

export const SHARED_NOT_FOUND = "Integration not found";
const MANAGE: Permission = "ai_studio.ai_keys.manage";
const LINK: Permission = "ai_studio.project.settings";
const CANNOT_MANAGE = "You can set up integrations only for your own organisation.";
export const NEW_SECRET_NEEDED = "Enter the token or the webhook address again when you change where it goes: a stored secret is only sent where it was entered for.";
/** The same rule for a password or an access key kept with a server's address (an alert channel's mail server, a device farm, the test mailbox). */
export const NEW_PASSWORD_NEEDED = "Enter the password or access key again when you change the server: a stored one is only sent where it was entered for.";
const LABEL: Record<SharedKind, string> = { jira: "Jira", github: "GitHub Issues", notion: "Notion", sentry: "Sentry", slack: "Slack", teams: "Microsoft Teams", webhook: "Webhook" };

const HttpUrl = z
    .string()
    .trim()
    .url("Paste the full webhook address, starting with https://")
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "Use an http(s) address");
const Name = z.string().trim().min(1).max(120).optional();
const OrgId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, "An organisation id is letters, digits, - and _ (at most 64).");
const Head = z.object({ kind: z.enum(SHARED_KINDS, { message: "Choose which integration to set up." }), name: Name, organizationId: OrgId.nullable().optional(), verify: z.boolean().optional() });

/** The settings of a new connection: what is kept in the clear, and the secret. */
function settingsOf(kind: SharedKind, body: Record<string, unknown>): { config: Record<string, unknown>; secret: Record<string, unknown>; address?: string } {
    const fields = { ...body, kind };
    const issue = (e: z.ZodError) => new HttpError(400, e.issues[0]?.message ?? "Some settings are not valid.");
    if (kind === "slack" || kind === "teams" || kind === "webhook") {
        const r = z.object({ url: HttpUrl }).safeParse(body);
        if (!r.success) throw issue(r.error);
        return { config: { host: new URL(r.data.url).host }, secret: { url: r.data.url }, address: r.data.url };
    }
    if (kind === "sentry") {
        const r = SentrySettings.safeParse(body);
        if (!r.success) throw issue(r.error);
        const { token, ...config } = r.data;
        return { config, secret: { token }, address: config.baseUrl };
    }
    const schema = kind === "github" ? GithubSettings : kind === "notion" ? NotionSettings : JiraSettings;
    const r = schema.safeParse(fields);
    if (!r.success) throw issue(r.error);
    const { config, token } = splitSettings(r.data);
    const { kind: _k, ...rest } = config as IntegrationConfig & Record<string, unknown>;
    return { config: rest, secret: { token }, address: (rest.apiUrl ?? rest.baseUrl) as string | undefined };
}

const defaultName = (kind: SharedKind, config: Record<string, unknown>): string => {
    if (kind === "github") return `GitHub ${config.owner}/${config.repo}`;
    if (kind === "jira") return `Jira ${config.projectKey}`;
    if (kind === "notion") return `Notion database ${String(config.databaseId).slice(0, 8)}`;
    if (kind === "sentry") return `Sentry ${config.organization}/${config.project}`;
    return `${LABEL[kind]} · ${config.host}`;
};

/** The address a connection sends its secret to: changing it needs the secret again. */
const addressOf = (kind: SharedKind, config: Record<string, unknown>): string => (isAlertKind(kind) ? String(config.host ?? "") : String(config.apiUrl ?? config.baseUrl ?? (kind === "github" ? "https://api.github.com" : kind === "notion" ? "https://api.notion.com" : "")));
/** Where a tracker files with its secret: the address and the project, repository or database there. Changing any of it needs the secret again. */
const targetOf = (kind: SharedKind, config: Record<string, unknown>): string =>
    JSON.stringify([addressOf(kind, config), ...(isAlertKind(kind) ? [] : [config.projectKey, config.owner, config.repo, config.databaseId].map((v) => (v === undefined ? null : String(v).trim())))]);

/** One real call with the stored secret. A failed check is an answer, not a server error. */
async function check(s: SharedIntegration, secret: Record<string, unknown>, link: string): Promise<{ ok: boolean; message: string }> {
    if (isAlertKind(s.kind)) {
        const subject: AlertSubject = { project: { id: s.id, name: s.name, url: null }, link };
        const body = s.kind === "slack" ? testSlackPayload(subject) : s.kind === "teams" ? teamsPayload(testContent(subject)) : testWebhookPayload(subject);
        const r = await deliver(String(secret.url), body, { backoffMs: [] });
        return r.ok ? { ok: true, message: `A test message was sent to ${s.config.host}.` } : { ok: false, message: r.error ?? "The test message was not accepted." };
    }
    try {
        if (s.kind === "sentry") return { ok: true, message: await new SentryClient({ kind: "sentry", ...(s.config as Omit<SentryConfig, "kind">) }, String(secret.token)).verify() };
        return { ok: true, message: await providerFor({ kind: s.kind, ...s.config } as IntegrationConfig, String(secret.token)).verify() };
    } catch (e) {
        if (e instanceof TrackerError) return { ok: false, message: e.message };
        throw e;
    }
}

/** The last check per connection, so one person cannot hammer a tracker with someone's token. */
const lastTest = new Map<string, number>();
const running = new Set<string>();
const TEST_MIN_INTERVAL_MS = 2_000;
/** Tests only: forget the last checks. */
export function resetSharedChecks(): void {
    lastTest.clear();
    running.clear();
}

export function registerSharedIntegrationRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const control = accessControlOf(app);
    const store = new SharedIntegrationStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));
    const who = (req: FastifyRequest): Actor => actorOf(req) ?? currentActor();
    const note = (actor: Actor, action: string, detail: string, projectId?: string | null) => control.users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail, projectId: projectId ?? null });
    const orgName = (id: string | null): string | null => (id ? (control.projects.store.organizations().find((o) => o.id === id)?.name ?? null) : null);
    const orgOf = (projectId: string): string | null => (p.repo.getProject(projectId)?.organization_id as string | null | undefined) ?? null;

    /** May this person set up connections for this owner (an organisation, or the whole platform when null)? Same rule as an organisation's AI configuration. */
    const mayOwn = (actor: Actor, organizationId: string | null): boolean => {
        if (!permissionsOf(actor).has(MANAGE)) return false;
        const side = sideOf(actor);
        if (side === "tester") return false;
        const here = control.projects.allowed(actor);
        if (organizationId === null) return side !== "customer" && here === null;
        if (side === "customer") return Boolean(actor.organizationId) && organizationId === actor.organizationId;
        if (here === null) return true;
        return [...here.keys()].some((pid) => orgOf(pid) === organizationId);
    };
    /** Can this project use this connection? Its own organisation's, or (for Crowd4Test staff and local installs) the platform's. */
    const fits = (actor: Actor, s: SharedIntegration, projectId: string): boolean => (s.organizationId === null ? sideOf(actor) !== "customer" : orgOf(projectId) === s.organizationId);
    const mayLinkIn = (actor: Actor, projectId: string): boolean => Boolean(control.projects.permissionsIn(actor, projectId)?.has(LINK)) && sideOf(actor) !== "tester";

    const reachable = (req: FastifyRequest) => {
        const here = visibleProjectsOf(req, who(req));
        return p.repo.listProjects().filter((r) => !here || here.has(r.id as string));
    };
    /** What the person may see of a connection: theirs to manage, or one a project of theirs can use or uses. */
    const visibleTo = (req: FastifyRequest, s: SharedIntegration): boolean => {
        const actor = who(req);
        if (mayOwn(actor, s.organizationId)) return true;
        const projects = reachable(req);
        return projects.some((r) => mayLinkIn(actor, r.id as string) && fits(actor, s, r.id as string)) || store.linksOf(s.id).some((l) => projects.some((r) => r.id === l.projectId));
    };
    const visible = (req: FastifyRequest, id: string): SharedIntegration => {
        const s = store.get(id);
        if (!s || !visibleTo(req, s)) throw new HttpError(404, SHARED_NOT_FOUND);
        return s;
    };
    /** How many projects using this connection lie outside the person's reach (none for someone who reaches every project). */
    const unreachedLinks = (req: FastifyRequest, s: SharedIntegration): number => {
        const here = visibleProjectsOf(req, who(req));
        return here ? store.linksOf(s.id).filter((l) => !here.has(l.projectId)).length : 0;
    };
    /** Changing, testing or removing a connection: "manage keys and connections" for its owner AND every project that uses it within reach. */
    const managed = (req: FastifyRequest, id: string): SharedIntegration => {
        const s = visible(req, id);
        if (!mayOwn(who(req), s.organizationId)) throw new HttpError(403, CANNOT_MANAGE);
        const out = unreachedLinks(req, s);
        if (out > 0) throw new HttpError(403, `${out === 1 ? "A project you cannot open uses" : `${out} projects you cannot open use`} this integration. Only someone who can open every project that uses it may change, test or remove it.`);
        return s;
    };

    const viewOf = (req: FastifyRequest, s: SharedIntegration) => {
        const actor = who(req);
        const projects = reachable(req);
        const names = new Map(projects.map((r) => [r.id as string, r.name as string]));
        const links = store.linksOf(s.id);
        return {
            id: s.id,
            kind: s.kind,
            kindName: LABEL[s.kind],
            name: s.name,
            organizationId: s.organizationId,
            ownerName: s.organizationId === null ? "Every organisation" : (orgName(s.organizationId) ?? "Organisation"),
            config: s.config,
            status: s.status,
            statusNote: s.statusNote,
            checkedAt: s.checkedAt,
            canManage: mayOwn(actor, s.organizationId) && unreachedLinks(req, s) === 0,
            // Projects outside the person's reach are counted, never named.
            projects: links.filter((l) => names.has(l.projectId)).map((l) => ({ id: l.projectId, name: names.get(l.projectId)!, present: l.present, canChange: mayLinkIn(actor, l.projectId) })),
            otherProjects: links.filter((l) => !names.has(l.projectId)).length,
            linkable: projects.filter((r) => mayLinkIn(actor, r.id as string) && fits(actor, s, r.id as string) && !links.some((l) => l.projectId === r.id)).map((r) => ({ id: r.id as string, name: r.name as string })),
        };
    };
    const publicLink = (req: FastifyRequest) => `${(p.config.PUBLIC_URL || `${req.protocol}://${req.headers.host}`).replace(/\/+$/, "")}/#/integrations`;

    app.get("/api/shared-integrations", async (req) => {
        const actor = who(req);
        const projects = reachable(req);
        const names = new Map(projects.map((r) => [r.id as string, r.name as string]));
        const connections = store.list().filter((s) => visibleTo(req, s));
        // Connections each project set up in its own settings: by kind, only projects the person can see.
        const ownUses: Record<string, Array<{ id: string; name: string }>> = {};
        for (const u of store.ownUses()) {
            const name = names.get(u.projectId);
            if (!name) continue;
            const list = (ownUses[u.kind] ??= []);
            if (!list.some((x) => x.id === u.projectId)) list.push({ id: u.projectId, name });
        }
        const organizations = control.projects.store
            .organizations()
            .filter((o) => mayOwn(actor, o.id))
            .map((o) => ({ id: o.id, name: o.name }));
        if (sideOf(actor) === "customer" && actor.organizationId && mayOwn(actor, actor.organizationId) && !organizations.some((o) => o.id === actor.organizationId)) organizations.push({ id: actor.organizationId, name: orgName(actor.organizationId) });
        return {
            connections: connections.map((s) => viewOf(req, s)),
            ownUses,
            organizations,
            canAddPlatform: mayOwn(actor, null),
            canManage: permissionsOf(actor).has(MANAGE) && sideOf(actor) !== "tester",
            server: { blocksPrivate: process.env.BLOCK_PRIVATE_TARGETS === "true" },
        };
    });

    app.post("/api/shared-integrations", async (req, reply) => {
        const actor = who(req);
        const head = Head.safeParse(req.body ?? {});
        if (!head.success) throw new HttpError(400, head.error.issues[0]?.message ?? "Choose which integration to set up.");
        const { kind, name, organizationId, verify } = head.data;
        const { kind: _k, name: _n, organizationId: _o, verify: _v, ...fields } = (req.body ?? {}) as Record<string, unknown>;
        // A customer's connections are their organisation's; staff choose one, or none for the whole platform.
        const org = sideOf(actor) === "customer" ? (actor.organizationId ?? null) : (organizationId ?? null);
        if (sideOf(actor) === "customer" && organizationId && organizationId !== actor.organizationId) throw new HttpError(403, CANNOT_MANAGE);
        if (!mayOwn(actor, org)) throw new HttpError(403, org === null && sideOf(actor) === "customer" ? CANNOT_MANAGE : org === null ? "Only people who reach every project set up integrations for the whole platform. Choose an organisation." : CANNOT_MANAGE);
        const settings = settingsOf(kind, fields);
        if (settings.address) await assertAllowedTarget(settings.address);
        if (store.countOf(org) >= MAX_SHARED_PER_OWNER) throw new HttpError(409, `An organisation can have at most ${MAX_SHARED_PER_OWNER} shared integrations. Remove one first.`);
        // Trackers and Sentry are proven before they are saved, as in a project's settings, so a typo is caught here.
        const draft: SharedIntegration = { id: "new", organizationId: org, kind, name: name || defaultName(kind, settings.config), config: settings.config, status: "unchecked", statusNote: null, checkedAt: null, createdBy: null, createdAt: "", updatedAt: "" };
        let checked: { ok: boolean; message: string } | undefined;
        if (!isAlertKind(kind) && verify !== false) {
            checked = await check(draft, settings.secret, publicLink(req));
            if (!checked.ok) throw new HttpError(502, checked.message);
        }
        if (org) control.projects.store.ensureOrganization(org);
        const created = store.create({ organizationId: org, kind, name: draft.name, config: settings.config, secret: settings.secret, createdBy: actorLabel(actor) });
        if (checked) store.setStatus(created.id, true, null);
        note(actor, "integration-added", `${LABEL[kind]} integration “${created.name}” set up${org ? ` for ${orgName(org) ?? "an organisation"}` : " for the whole platform"}.`);
        return reply.code(201).send(viewOf(req, store.get(created.id)!));
    });

    app.patch("/api/shared-integrations/:sid", async (req) => {
        const { sid } = req.params as { sid: string };
        const cur = managed(req, sid);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const name = Name.safeParse(body.name);
        if (!name.success) throw new HttpError(400, "A name is 1 to 120 characters.");
        const { name: _n, kind: _k, organizationId: _o, verify: _v, ...fields } = body;
        let patch: { name?: string; config?: Record<string, unknown>; secret?: Record<string, unknown> } = { name: name.data };
        if (Object.keys(fields).length) {
            const secretGiven = isAlertKind(cur.kind) ? typeof fields.url === "string" : typeof fields.token === "string";
            // Validate the settings the connection would end up with; a placeholder stands in for a secret that is kept.
            const merged = isAlertKind(cur.kind) ? { url: secretGiven ? fields.url : `https://${cur.config.host}/` } : { ...cur.config, ...fields, ...(secretGiven ? {} : { token: "kept" }) };
            const next = settingsOf(cur.kind, merged);
            if (!secretGiven && targetOf(cur.kind, next.config) !== targetOf(cur.kind, cur.config)) throw new HttpError(400, NEW_SECRET_NEEDED);
            if (next.address) await assertAllowedTarget(next.address);
            patch = { ...patch, config: next.config, ...(secretGiven ? { secret: next.secret } : {}) };
        }
        const after = store.update(sid, patch);
        if (!after) throw new HttpError(404, SHARED_NOT_FOUND);
        note(who(req), "integration-changed", `Integration “${after.name}” changed${patch.secret ? ", with a new secret" : ""}; ${store.linksOf(sid).length} project(s) use it.`);
        return viewOf(req, after);
    });

    app.delete("/api/shared-integrations/:sid", async (req, reply) => {
        const { sid } = req.params as { sid: string };
        const cur = managed(req, sid);
        const inUse = store.linksOf(sid).length;
        if (inUse > 0) throw new HttpError(409, `${inUse === 1 ? "A project uses" : `${inUse} projects use`} this integration. Stop using it in ${inUse === 1 ? "that project" : "them"} first.`);
        store.remove(sid);
        note(who(req), "integration-removed", `Integration “${cur.name}” removed.`);
        return reply.code(204).send();
    });

    app.post("/api/shared-integrations/:sid/test", async (req) => {
        const { sid } = req.params as { sid: string };
        const s = managed(req, sid);
        const t = Date.now();
        if (running.has(sid)) throw new HttpError(409, "This connection is being tested already.");
        if (t - (lastTest.get(sid) ?? 0) < TEST_MIN_INTERVAL_MS) throw new HttpError(429, "Wait a few seconds before testing again.");
        running.add(sid);
        lastTest.set(sid, t);
        try {
            const r = await check(s, store.secretOf<Record<string, unknown>>(sid), publicLink(req));
            store.setStatus(sid, r.ok, r.ok ? null : r.message);
            note(who(req), "integration-tested", `“${s.name}” was tested: ${r.ok ? "it worked" : "it did not work"}.`);
            return { ok: r.ok, message: r.message, connection: viewOf(req, store.get(sid)!) };
        } finally {
            running.delete(sid);
        }
    });

    // ── a project and the shared connections ───────────────────────────────────
    app.get("/api/projects/:id/shared-integrations", async (req) => {
        const { id } = req.params as { id: string };
        ctx.project(id);
        return store.linksOfProject(id).map((l) => {
            const s = store.get(l.integrationId)!;
            return { integrationId: s.id, kind: s.kind, kindName: LABEL[s.kind], name: s.name, targetId: l.targetId, present: l.present };
        });
    });

    const linkable = (req: FastifyRequest, projectId: string, sid: string): SharedIntegration => {
        ctx.project(projectId);
        const s = visible(req, sid);
        if (!fits(who(req), s, projectId)) throw new HttpError(404, SHARED_NOT_FOUND);
        return s;
    };

    app.put("/api/projects/:id/shared-integrations/:sid", async (req) => {
        const { id, sid } = req.params as { id: string; sid: string };
        const s = linkable(req, id, sid);
        try {
            const l = store.link(sid, id, actorLabel(who(req)));
            note(who(req), "integration-linked", `The project now uses the ${LABEL[s.kind]} integration “${s.name}”.`, id);
            return { integrationId: sid, projectId: id, targetId: l.targetId, present: l.present };
        } catch (e) {
            if (e instanceof LinkRefused) throw new HttpError(409, e.message);
            throw e;
        }
    });

    app.delete("/api/projects/:id/shared-integrations/:sid", async (req, reply) => {
        const { id, sid } = req.params as { id: string; sid: string };
        const s = linkable(req, id, sid);
        if (!store.unlink(sid, id)) throw new HttpError(404, "This project does not use that integration.");
        note(who(req), "integration-unlinked", `The project stopped using the ${LABEL[s.kind]} integration “${s.name}”.`, id);
        return reply.code(204).send();
    });
}

