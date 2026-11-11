/**
 * Signing in with the Crowd4Test session: AI Studio on aistudio.crowd4test.com has no sign-in form of its own there.
 *
 * crowd4test.com writes its session cookies for the parent domain (AUTH_COOKIE_DOMAIN in C4T_Platform/web), so this server
 * receives them too. It never trusts one by itself: it asks the Crowd4Test API who the access cookie belongs to (`GET
 * /v1/auth/me`), the same check every crowd4test.com page makes, so a sign-out, a revoked session or a suspended account
 * stops working here as well. Answers are kept for CHECK_CACHE_MS so a page making a dozen calls costs one question.
 *
 * Renewing is left to crowd4test.com. The access cookie lasts 15 minutes; when it is gone but the `c4t_shared` marker (or, on
 * browsers from before the refresh cookie stayed on crowd4test.com, the refresh cookie) is still there, the answer is "expired"
 * and the page asks crowd4test.com to renew it (its /app/ai-studio/refresh route) and tries again; if that does not help, the
 * page sends the person to sign in. This server never spends the refresh token itself: the API treats a refresh token presented twice as stolen and
 * ends the session, and crowd4test.com already guards against that for its own renewals.
 *
 * A Crowd4Test account becomes a person here the first time it arrives, linked by its Crowd4Test id. What it may do comes from
 * the `ai_studio.*` permissions Crowd4Test granted it (auth/permissions.ts; ADMIN holds them all), never from a role here: without
 * `ai_studio.access` it is refused. Which projects it reaches is given per project (D-27): ADMIN reaches every project, everyone
 * else only the projects they were added to (routes/members.ts), so nobody sees another customer's work until someone adds them.
 * The role kept here (ROLE_CEILING) is only shown; the permissions decide.
 */
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ProjectAccessStore } from "../project-access-store.js";
import { C4T_SUBJECT_PREFIX, MAX_PEOPLE, normEmail, type Person, type UserStore } from "../user-store.js";
import { lowerRole, ROLE_WORDS, type Role, type Side } from "./actor.js";
import { permissionsForC4t, type Permission } from "./permissions.js";
import { readCookie } from "./cookies.js";

export const C4T_ACCESS_COOKIE = "c4t_access";
export const C4T_REFRESH_COOKIE = "c4t_refresh";
/** crowd4test.com's marker that this browser has a shared session. Not a secret: it is what says "renewable" once the refresh cookie stays on crowd4test.com. */
export const C4T_SHARED_COOKIE = "c4t_shared";
export const CHECK_CACHE_MS = 30_000;
const CHECK_TIMEOUT_MS = 5_000;
const CACHE_MAX = 2_000;

export type C4tRole = "USER" | "CUSTOMER" | "TESTER" | "ADMIN" | "SUB_ADMIN";

/** The part of the API's SessionUser this server uses. */
export interface C4tUser {
    id: string;
    email: string;
    role: C4tRole;
    status: string;
    firstName: string | null;
    lastName: string | null;
    emailVerified: boolean;
    /** The codes granted on Crowd4Test (every group; only `ai_studio.*` counts here). Empty for ADMIN, who holds every code. */
    permissions: string[];
    /** The account's organisation on Crowd4Test, when it is a member of one. */
    organisationId: string | null;
}

export const NO_AI_STUDIO = "You don't have access to AI Studio. Ask your Crowd4Test administrator.";

/** The highest role each Crowd4Test role can have here; null: no AI Studio (an account still finishing its sign-up). */
export const ROLE_CEILING: Record<C4tRole, Role | null> = { ADMIN: "owner", SUB_ADMIN: "owner", CUSTOMER: "editor", TESTER: "editor", USER: null };

export type C4tCheck =
    /** No Crowd4Test cookie: not signed in on crowd4test.com. */
    | { kind: "none" }
    /** The access cookie has run out but the session can be renewed. */
    | { kind: "expired" }
    | { kind: "user"; user: C4tUser }
    /** Signed in, but the API will not let this account in (suspended, deactivated). */
    | { kind: "refused"; message: string }
    | { kind: "unreachable" };

export interface Crowd4TestOptions {
    /** The Crowd4Test API, as this server reaches it (http://127.0.0.1:4000 on the same machine). */
    apiOrigin: string;
    /** crowd4test.com as people reach it: where they sign in and where the portal is. */
    siteUrl: string;
    fetch?: typeof fetch;
    now?: () => number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** May crowd4test.com be able to renew this session? The marker says so; the refresh cookie itself still counts while crowd4test.com stops sharing it. */
const renewable = (req: FastifyRequest) => Boolean(readCookie(req, C4T_SHARED_COOKIE) || readCookie(req, C4T_REFRESH_COOKIE));
const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

export class Crowd4Test {
    private readonly cache = new Map<string, { at: number; check: C4tCheck }>();
    private readonly apiOrigin: string;
    readonly siteUrl: string;

    constructor(private readonly opts: Crowd4TestOptions) {
        this.apiOrigin = trimSlash(opts.apiOrigin);
        this.siteUrl = trimSlash(opts.siteUrl);
    }

    /** crowd4test.com's hand-off: signs a visitor in if needed, renews the session, then opens AI Studio at `?to=`. */
    get signInUrl(): string {
        return `${this.siteUrl}/app/ai-studio`;
    }
    /** Requested in the background by the page to renew an expired access cookie. */
    get refreshUrl(): string {
        return `${this.siteUrl}/app/ai-studio/refresh`;
    }
    /** The person's own Crowd4Test portal (crowd4test.com sends /app on to the right one). */
    get portalUrl(): string {
        return `${this.siteUrl}/app`;
    }

    async check(req: FastifyRequest): Promise<C4tCheck> {
        const token = readCookie(req, C4T_ACCESS_COOKIE);
        if (!token) return renewable(req) ? { kind: "expired" } : { kind: "none" };
        const key = sha256(token);
        const now = (this.opts.now ?? Date.now)();
        const hit = this.cache.get(key);
        if (hit && now - hit.at < CHECK_CACHE_MS) return hit.check;

        const check = await this.ask(req, token);
        // Only settled answers are kept: "expired" and "unreachable" must be asked again on the next call.
        if (check.kind === "user" || check.kind === "refused") {
            if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, { at: now, check });
        } else this.cache.delete(key);
        return check;
    }

    private async ask(req: FastifyRequest, token: string): Promise<C4tCheck> {
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
        // The API keeps one request budget per visitor; without these every person here would share this server's.
        const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || req.ip;
        if (ip) headers["x-c4t-client-ip"] = ip.slice(0, 45);
        const ua = req.headers["user-agent"];
        if (ua) headers["user-agent"] = String(ua).slice(0, 500);
        let res: Response;
        try {
            res = await (this.opts.fetch ?? fetch)(`${this.apiOrigin}/v1/auth/me`, { headers, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        } catch {
            return { kind: "unreachable" };
        }
        if (res.status === 401) return renewable(req) ? { kind: "expired" } : { kind: "none" };
        if (res.status === 403) {
            const body = (await res.json().catch(() => ({}))) as { error?: { message?: unknown }; message?: unknown };
            const said = body.error?.message ?? body.message;
            return { kind: "refused", message: typeof said === "string" && said ? said.slice(0, 200) : "Crowd4Test did not let this account in." };
        }
        if (!res.ok) return { kind: "unreachable" };
        const body = (await res.json().catch(() => null)) as { data?: { user?: Partial<C4tUser> } } | null;
        const u = body?.data?.user;
        if (!u || typeof u.id !== "string" || typeof u.email !== "string" || !u.role || !(u.role in ROLE_CEILING)) return { kind: "unreachable" };
        const permissions = Array.isArray(u.permissions) ? u.permissions.filter((c): c is string => typeof c === "string" && c.length <= 100).slice(0, 500) : [];
        const organisationId = typeof u.organisationId === "string" && u.organisationId && u.organisationId.length <= 64 ? u.organisationId : null;
        return {
            kind: "user",
            user: { id: u.id, email: u.email, role: u.role, status: String(u.status ?? ""), firstName: u.firstName ?? null, lastName: u.lastName ?? null, emailVerified: Boolean(u.emailVerified), permissions, organisationId },
        };
    }
}

/** On when C4T_API_ORIGIN is set; C4T_SITE_URL must be set with it. */
export function crowd4testFromConfig(config: { C4T_API_ORIGIN?: string; C4T_SITE_URL?: string }, fetchImpl?: typeof fetch): Crowd4Test | undefined {
    const apiOrigin = config.C4T_API_ORIGIN?.trim();
    const siteUrl = config.C4T_SITE_URL?.trim();
    if (!apiOrigin && !siteUrl) return undefined;
    if (!apiOrigin || !siteUrl) throw new Error("Set both C4T_API_ORIGIN and C4T_SITE_URL to sign in with Crowd4Test, or neither.");
    for (const [name, value] of [["C4T_API_ORIGIN", apiOrigin], ["C4T_SITE_URL", siteUrl]] as const) {
        if (!/^https?:\/\/[^/\s]+/.test(value)) throw new Error(`${name} must be an address such as https://crowd4test.com (got "${value.slice(0, 80)}").`);
    }
    return new Crowd4Test({ apiOrigin, siteUrl, fetch: fetchImpl });
}

export const subjectOf = (u: Pick<C4tUser, "id">) => `${C4T_SUBJECT_PREFIX}${u.id}`;
const displayName = (u: C4tUser) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email.split("@")[0]!;

export type Linked =
    | { person: Person; role: Role; joined: boolean; permissions: ReadonlySet<Permission>; side: Exclude<Side, "local">; organizationId?: string }
    | { refused: string };

export const sideOfC4t = (r: Exclude<C4tRole, "USER">): Exclude<Side, "local"> => (r === "ADMIN" || r === "SUB_ADMIN" ? "admin" : r === "CUSTOMER" ? "customer" : "tester");

/**
 * The person here for a Crowd4Test account, made on first arrival, with the permissions they act with (what Crowd4Test granted,
 * minus what their kind can never hold). `role` is only what the page shows: the lower of their role here and their Crowd4Test
 * ceiling. Each arrival also brings their reach up to date: ADMIN reaches every project, anyone else only their projects.
 */
export function personFor(users: UserStore, access: ProjectAccessStore, u: C4tUser, onOrganization?: (id: string) => void): Linked {
    const ceiling = ROLE_CEILING[u.role];
    if (!ceiling || u.role === "USER") return { refused: "Finish setting up your Crowd4Test account first, then open AI Studio again." };
    const permissions = permissionsForC4t(u.role, u.permissions ?? []);
    const subject = subjectOf(u);
    // Checked before a person is made: an account without AI Studio leaves nothing behind here. A person already here stops running
    // tests in their name (schedules, deploy triggers, their runner: AgentStore.ownerMayRun) until Crowd4Test lets them in again; their
    // status here is left alone, so being let in again on Crowd4Test is enough (a person turned off here stays an owner's decision).
    const cutOff = u.status !== "ACTIVE" ? "Your Crowd4Test account is not active." : !permissions.has("ai_studio.access") ? NO_AI_STUDIO : undefined;
    if (cutOff) {
        users.db.run("UPDATE users SET c4t_runs_tests = 0 WHERE sso_subject = ? AND role IS NOT NULL AND c4t_runs_tests IS DISTINCT FROM 0", subject);
        return { refused: cutOff };
    }
    const email = normEmail(u.email);
    let joined = false;

    const linkedId = users.db.get<{ id: string }>("SELECT id FROM users WHERE sso_subject = ? AND role IS NOT NULL", subject)?.id;
    let person: Person | undefined = linkedId ? users.get(linkedId) : undefined;
    if (!person) {
        const same = users.byEmail(email);
        if (same) {
            const linked = users.db.get<{ sso_subject: string | null }>("SELECT sso_subject FROM users WHERE id = ?", same.id)?.sso_subject;
            if (linked && linked !== subject) return { refused: "This email is linked to a different sign-in here. Ask an owner of AI Studio." };
            // An account made here before (a password or an invite) is joined to Crowd4Test only once Crowd4Test has verified the address.
            if (!u.emailVerified) return { refused: "Verify your email address on Crowd4Test first, then open AI Studio again." };
            users.setSsoSubject(same.id, subject);
            person = same;
        } else {
            if (users.emailTakenByBuiltIn(email)) return { refused: "That address is reserved by the platform." };
            if (users.peopleCount() >= MAX_PEOPLE) return { refused: "AI Studio has reached its limit of people. Ask an owner." };
            person = users.create({ email, name: displayName(u), role: ceiling, ssoSubject: subject });
            access.set(person.id, u.role === "ADMIN" ? { mode: "all" } : { mode: "only", projects: [] });
            users.addActivity({ actorKind: "user", actorId: person.id, actorName: person.name, action: "joined with Crowd4Test", detail: `${ROLE_WORDS[ceiling]}, ${person.email}` });
            joined = true;
        }
    }
    if (person.status !== "active") return { refused: "Your AI Studio access is turned off. Ask an owner of AI Studio." };
    const name = displayName(u);
    // A Crowd4Test role that went down lowers the role here for good, so nothing made with the old role keeps it.
    const role = lowerRole(person.role, ceiling);
    if (name !== person.name || role !== person.role) users.update(person.id, { name, role });
    // Only Crowd4Test ADMIN reaches every project (D-27; SUB_ADMIN no longer does): kept in step on every arrival, the person's
    // project rows untouched, so a promotion or demotion on Crowd4Test applies here on the next request.
    access.setMode(person.id, u.role === "ADMIN" ? "all" : "only");
    // Only a customer belongs to an organisation here: it is what keeps them inside it (staff and testers work across them).
    const organizationId = u.role === "CUSTOMER" && u.organisationId ? u.organisationId : undefined;
    if (u.organisationId) {
        access.ensureOrganization(u.organisationId);
        // Its name and status come from Crowd4Test's service, in the background (c4t-service.ts), when that is configured.
        onOrganization?.(u.organisationId);
    }
    access.recordCrowd4TestAccount(person.id, u.role, organizationId ?? null, permissions.has("ai_studio.tests.run"));
    return { person: { ...person, name, role }, role, joined, permissions, side: sideOfC4t(u.role), ...(organizationId ? { organizationId } : {}) };
}
