/**
 * People, the Activity list and single sign-on settings (owners only; the route-to-role table in auth/roles.ts says so).
 *
 *   GET    /api/users                        everyone with an account
 *   POST   /api/users                        { email, name, role } → the person and a one-time invite link (shown once, 7 days)
 *   PATCH  /api/users/:userId                { name?, role?, status? }   (the last active owner cannot be demoted or turned off)
 *   DELETE /api/users/:userId                (not yourself, not the last active owner)
 *   POST   /api/users/:userId/reset-link     a one-time link to set a new password (24 hours; an invite link if none was set yet)
 *   POST   /api/users/:userId/sign-out       ends every session of the person
 *   GET    /api/activity                     ?actor=&kind=&project=&q=&since=&until=&before=&limit=
 *   GET    /api/sso-settings                 the settings without the client secret (hasSecret says whether one is stored)
 *   PUT    /api/sso-settings                 { issuer, clientId, clientSecret?, allowedDomain, defaultRole, label? } (checked against the provider)
 *   DELETE /api/sso-settings
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { accessControlOf, actorOf } from "../auth/access.js";
import { clearSsoCaches, discover, idpUrlProblem, SsoError } from "../auth/oidc.js";
import { MAX_PEOPLE, type Person } from "../user-store.js";
import { Email, publicBase } from "./auth.js";
import type { RouteCtx } from "./types.js";

const RoleSchema = z.enum(["owner", "editor", "viewer"]);
const UserId = z.object({ userId: z.string().min(1).max(64) });
export const EVERY_PROJECT_NEEDED = "Only someone who reaches every project can change people and their access.";

const publicPerson = (u: Person) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, hasPassword: u.hasPassword, sso: u.sso, invitePending: u.invitePending, createdAt: u.createdAt, lastSignInAt: u.lastSignInAt });

export function registerUserRoutes(ctx: RouteCtx): void {
    const { app } = ctx;
    const users = accessControlOf(app).users;
    const link = (req: FastifyRequest, token: string) => `${publicBase(req)}/#/invite/${token}`;
    /**
     * With Crowd4Test sign-in on, `ai_studio.platform.settings` gets past the project check on purpose (auth/project-scope.ts), and someone who holds
     * it without reaching every project must not make themselves a way into all of them: only a person who already reaches every project hands out access.
     */
    const reachesEveryProject = (req: FastifyRequest) => {
        const control = accessControlOf(app);
        if (control.crowd4test && control.projects.allowed(actorOf(req)) !== null) throw new HttpError(403, EVERY_PROJECT_NEEDED);
    };

    const person = (id: string) => {
        const u = users.get(id);
        if (!u) throw new HttpError(404, "Person not found");
        return u;
    };
    /** Would this change leave the platform without an active owner? */
    const projectAccess = accessControlOf(app).projects.store;
    const seesAll = (id: string) => projectAccess.accessOf(id).mode === "all";
    // ... or the last active owner with access to all projects (the only one who could still manage people; routes/project-access.ts).
    const lastOwner = (u: Person) => u.role === "owner" && u.status === "active" && (users.activeOwners() <= 1 || (seesAll(u.id) && users.list().filter((x) => x.role === "owner" && x.status === "active" && seesAll(x.id)).length <= 1));

    // `access`: all projects, or only some with a role in each (per-project access, routes/project-access.ts).
    app.get("/api/users", async () => ({ people: users.list().map((u) => ({ ...publicPerson(u), access: projectAccess.view(u.id, u.role) })), maxPeople: MAX_PEOPLE }));

    app.post("/api/users", async (req, reply) => {
        reachesEveryProject(req);
        const body = z.object({ email: Email, name: z.string().trim().max(120).default(""), role: RoleSchema }).parse(req.body);
        if (users.peopleCount() >= MAX_PEOPLE) throw new HttpError(409, `This platform can have at most ${MAX_PEOPLE} people.`);
        if (users.byEmail(body.email)) throw new HttpError(409, "Someone with this email already has an account.");
        if (users.emailTakenByBuiltIn(body.email)) throw new HttpError(400, "That address is reserved by the platform. Use the person's own email address.");
        const made = users.create({ email: body.email, name: body.name, role: body.role });
        const invite = users.createInvite(made.id, "invite");
        return reply.code(201).send({ person: publicPerson(users.get(made.id)!), inviteLink: link(req, invite.token), expiresAt: invite.expiresAt, note: "Send this link to the person yourself; it is shown only once and works for 7 days." });
    });

    app.patch("/api/users/:userId", async (req) => {
        const { userId } = UserId.parse(req.params);
        const body = z.object({ name: z.string().trim().max(120).optional(), role: RoleSchema.optional(), status: z.enum(["active", "disabled"]).optional() }).strict().parse(req.body);
        if (body.role !== undefined) reachesEveryProject(req);
        const u = person(userId);
        if (lastOwner(u) && ((body.role && body.role !== "owner") || body.status === "disabled")) throw new HttpError(409, "This is the only active owner. Make someone else an owner first.");
        users.update(userId, body);
        return { person: publicPerson(users.get(userId)!) };
    });

    app.delete("/api/users/:userId", async (req) => {
        const { userId } = UserId.parse(req.params);
        const u = person(userId);
        if (actorOf(req)?.id === userId) throw new HttpError(409, "You cannot remove yourself. Ask another owner.");
        if (lastOwner(u)) throw new HttpError(409, "This is the only active owner. Make someone else an owner first.");
        users.remove(userId);
        return { removed: true };
    });

    app.post("/api/users/:userId/reset-link", async (req) => {
        const { userId } = UserId.parse(req.params);
        reachesEveryProject(req);
        const u = person(userId);
        if (u.crowd4testLinked) throw new HttpError(409, "This person signs in with Crowd4Test, so there is no reset link for them here.");
        if (u.status !== "active") throw new HttpError(409, "Turn the account on first.");
        const purpose = u.hasPassword ? "reset" : "invite";
        const made = users.createInvite(userId, purpose);
        return { link: link(req, made.token), purpose, expiresAt: made.expiresAt, note: "Send this link to the person yourself; it is shown only once." };
    });

    app.post("/api/users/:userId/sign-out", async (req) => {
        const { userId } = UserId.parse(req.params);
        person(userId);
        return { sessionsEnded: users.endAllSessions(userId) };
    });

    app.get("/api/activity", async (req) => {
        const q = z
            .object({
                actor: z.string().max(64).optional(),
                kind: z.enum(["user", "key", "open", "runner", "schedule", "trigger", "system"]).optional(),
                project: z.string().max(64).optional(),
                q: z.string().trim().max(100).optional(),
                since: z.string().datetime({ offset: true }).optional(),
                until: z.string().datetime({ offset: true }).optional(),
                before: z.coerce.number().int().min(1).optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
            })
            .parse(req.query);
        const rows = users.activity({ actorId: q.actor, actorKind: q.kind, projectId: q.project, action: q.q || undefined, since: q.since, until: q.until, before: q.before, limit: q.limit });
        return { activity: rows, next: rows.length === q.limit ? rows[rows.length - 1]!.id : null, keep: { rows: 20_000, days: 180 } };
    });

    // ── single sign-on settings ─────────────────────────────────────────────
    const ssoView = () => {
        const s = users.ssoSettings();
        return s ? { configured: true, ...s, redirectPath: "/api/auth/sso/callback" } : { configured: false, redirectPath: "/api/auth/sso/callback" };
    };

    app.get("/api/sso-settings", async (req) => ({ ...ssoView(), redirectUri: `${publicBase(req)}/api/auth/sso/callback` }));

    app.put("/api/sso-settings", async (req) => {
        const body = z
            .object({
                issuer: z.string().trim().url().max(500),
                clientId: z.string().trim().min(1).max(500),
                clientSecret: z.string().min(1).max(4000).optional(),
                allowedDomain: z.string().trim().toLowerCase().min(3).max(253).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain such as example.com"),
                defaultRole: z.enum(["viewer", "editor"]).default("viewer"),
                label: z.string().trim().max(60).default(""),
            })
            .parse(req.body);
        const problem = idpUrlProblem(body.issuer);
        if (problem) throw new HttpError(400, problem);
        if (!body.clientSecret && !users.ssoSettings()?.hasSecret) throw new HttpError(400, "Enter the client secret.");
        // Check the provider before saving, so a typo shows now and not at someone's first sign-in.
        clearSsoCaches();
        try {
            await discover(body.issuer, true);
        } catch (e) {
            throw new HttpError(400, e instanceof SsoError ? e.message : "The sign-in provider could not be checked.");
        }
        users.saveSso({ issuer: body.issuer, clientId: body.clientId, allowedDomain: body.allowedDomain, defaultRole: body.defaultRole, label: body.label }, body.clientSecret);
        return { ...ssoView(), redirectUri: `${publicBase(req)}/api/auth/sso/callback` };
    });

    app.delete("/api/sso-settings", async () => {
        users.removeSso();
        clearSsoCaches();
        return { removed: true };
    });
}
