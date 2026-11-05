/**
 * Who may call what. One hook in front of every /api route decides who is asking and whether their role is enough:
 *
 * 1. Routes with their own credential pass straight through, exactly as before accounts existed: /api/health, the two deploy-trigger
 *    routes (trigger token), the runner protocol routes (runner token) and live-update streams opened with a ticket.
 * 2. The shared access key (`x-api-key: <API_KEY>`, or `?key=` on artifact links) is an owner-level key, for scripts, the MCP server,
 *    the `ai-test` command and runner kits. A person's own API token (`aitpu_…`) works in the same header or as `Authorization: Bearer`.
 * 3. A signed-in browser sends its session cookie; a state-changing request must also echo the session's CSRF token in `x-csrf-token`
 *    and, when the browser names an Origin, come from this platform's own address.
 * 4. With no API_KEY and nobody signed up yet the platform stays open, as it always was (and says so in Settings).
 *
 * The permission each route needs comes from one table (auth/roles.ts); a route the table does not know needs platform settings
 * (fail closed: owners only), and a test fails when a registered route is missing from the table. Crowd4Test accounts hold the
 * `ai_studio.*` codes Crowd4Test granted them; everyone else holds their role's codes (auth/permissions.ts), so for them every route
 * answers exactly as when the table named roles, refusals included. Answers to anyone without `ai_studio.usage.view` lose their
 * cost fields (auth/cost-hiding.ts).
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Platform } from "../bootstrap.js";
import { HttpError } from "../http-error.js";
import { SecretBox } from "../secrets.js";
import { isTriggerTokenRoute, redactTriggerUrl } from "../trigger-store.js";
import { isAgentRoute } from "../agent-routing.js";
import { isStreamTicketRequest } from "../routes/stream.js";
import { TOKEN_PREFIX, UserStore } from "../user-store.js";
import { ACTOR_WORDS, enterActor, isCrowd4TestActor, lowerRole, permissionRefusal, permissionsOf, type Actor, type Role } from "./actor.js";
import { CSRF_COOKIE, readCookie, SESSION_COOKIE } from "./cookies.js";
import { installCostHiding } from "./cost-hiding.js";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "./permissions.js";
import { permissionRuleFor, UNLISTED_NEEDS } from "./roles.js";
import { attachProjectScope, classifyRoute, createProjectScope, type ProjectScope } from "./project-scope.js";
import { isArchived, PROJECT_ARCHIVED } from "../project-folders.js";
import { crowd4testFromConfig, personFor, type Crowd4Test } from "./crowd4test.js";
import { c4tServiceOf, clientIpOf } from "../c4t-service.js";

export const KEY_REFUSED = "Missing or invalid x-api-key";
export const SIGN_IN_FIRST = "Sign in first, or send an access key or a personal API token";
export const CSRF_REFUSED = "This change did not come from the platform's own page. Reload the page and try again.";

export const C4T_SIGN_IN = "Sign in on Crowd4Test first";
export const C4T_RENEW = "Your Crowd4Test session needs renewing";
export const C4T_UNREACHABLE = "Crowd4Test sign-in could not be reached. Try again in a minute.";
/** What the page sends with every change when it is signed in with Crowd4Test (a page elsewhere cannot send it without asking first). */
export const C4T_REQUEST_HEADER = "x-requested-with";
export const C4T_REQUEST_VALUE = "ai-studio";

/**
 * The caller's own credentials, for a route that saves through another route of this server (app.inject), so the inner call checks
 * the same person: the key or token, the session with its CSRF token, the Crowd4Test cookie with the page's header, Origin and Host.
 * Also who is asking, as the Crowd4Test check tells the API (auth/crowd4test.ts): the browser's user-agent, and the caller's address
 * as `x-forwarded-for`. That address is `req.ip`, the one this server already believes for the outer request (a proxy's word only
 * when the proxy is trusted, PUBLIC_URL), never the header as the caller sent it: an inner call comes from this server itself, which a
 * trusted proxy setting would believe, so a forged header passed on would be believed where it was not before.
 */
export function callerCredentials(req: FastifyRequest): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of ["x-api-key", "authorization", "cookie", "x-csrf-token", "origin", "host", C4T_REQUEST_HEADER, "user-agent"]) {
        const v = req.headers[h];
        if (typeof v === "string" && v) out[h] = v;
    }
    if (req.ip) out["x-forwarded-for"] = req.ip;
    return out;
}

/**
 * For a route that needs a second permission beside its ROUTE_PERMISSIONS one (that table takes one per route): refuses with 403, in
 * the words the access hook uses, when the caller does not hold `code` in this project.
 */
export function assertHoldsHere(app: FastifyInstance, req: FastifyRequest, projectId: string, code: Permission): void {
    const actor = actorOf(req);
    if (!actor) return;
    if (accessControlOf(app).projects.permissionsIn(actor, projectId)?.has(code)) return;
    noteRefusedPermission(req, code);
    throw new HttpError(403, permissionRefusal(actor, code));
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The changes an archived project still accepts: restoring it and deleting it (routes/project-folders.ts). */
const ARCHIVE_EXEMPT = new Set(["POST /api/projects/:id/archive", "POST /api/projects/:id/unarchive", "DELETE /api/projects/:id"]);
const ACTOR = Symbol("aitp.actor");
const REFUSED = Symbol("aitp.refusedPermission");
const USED = Symbol("aitp.usedPermission");

/** Marks a request refused for a missing permission, so its Activity row names the permission. */
export function noteRefusedPermission(req: FastifyRequest, code: Permission): void {
    (req as unknown as Record<symbol, Permission>)[REFUSED] = code;
}
const C4T = Symbol("aitp.crowd4test");

/** What the Crowd4Test check found for this request: the person, or the refusal to send when nothing else signed it in. */
type C4tOutcome = { actor: Actor } | { error: HttpError; status: "none" | "expired" | "refused" | "unreachable" };
const c4tOutcomeOf = (req: FastifyRequest) => (req as unknown as Record<symbol, C4tOutcome | undefined>)[C4T];

/** For the auth state route: how the Crowd4Test check went ("user" when it signed the request in), and why it refused. */
export function crowd4testStatusOf(req: FastifyRequest): { status: "user" | "none" | "expired" | "refused" | "unreachable"; message?: string } | undefined {
    const o = c4tOutcomeOf(req);
    if (!o) return undefined;
    return "actor" in o ? { status: "user" } : { status: o.status, ...(o.status === "refused" ? { message: o.error.message } : {}) };
}

/** Routes as Fastify registered them ("METHOD /template"), for the route-to-role test. */
const registered = new WeakMap<FastifyInstance, Array<{ method: string; url: string }>>();
export function registeredRoutes(app: FastifyInstance): Array<{ method: string; url: string }> {
    return [...(registered.get(app) ?? [])];
}

/** The actor the access hook found for this request (undefined for routes with their own credential and for refused requests). */
export function actorOf(req: FastifyRequest): Actor | undefined {
    return (req as unknown as Record<symbol, Actor | undefined>)[ACTOR];
}

const sameSecret = (got: string, expected: string) => {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

/** The platform's own origin(s) a browser may send state-changing requests from. */
function originAllowed(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin GET-less fetches from older browsers omit it; the CSRF token still has to match
    if (origin === "null") return false;
    let o: URL;
    try {
        o = new URL(origin);
    } catch {
        return false;
    }
    if (process.env.PUBLIC_URL) {
        try {
            if (new URL(process.env.PUBLIC_URL).origin === o.origin) return true;
        } catch {
            /* an unusable PUBLIC_URL counts as not set */
        }
    }
    // Compare as URLs so a default port written out in Host ("example.com:443", "localhost:80") still matches the browser's Origin.
    try {
        return Boolean(req.headers.host) && o.host === new URL(`${o.protocol}//${req.headers.host}`).host;
    } catch {
        return false;
    }
}

export function isOriginAllowed(req: FastifyRequest): boolean {
    return originAllowed(req);
}

export interface AccessControl {
    users: UserStore;
    /** Per-project access: who is limited to which projects, and the check every route passes (auth/project-scope.ts). */
    projects: ProjectScope;
    /** Set when people sign in with their crowd4test.com session (C4T_API_ORIGIN; auth/crowd4test.ts). */
    crowd4test?: Crowd4Test;
    /** No API_KEY and nobody has an account: everyone who reaches the server is treated as an owner (today's behaviour). */
    isOpen(): boolean;
    /** Who is asking, from the key, a personal token or the session cookie; undefined when nothing valid was sent. */
    identify(req: FastifyRequest): Actor | undefined;
}

const access = new WeakMap<FastifyInstance, AccessControl>();
export function accessControlOf(app: FastifyInstance): AccessControl {
    const a = access.get(app);
    if (!a) throw new Error("installAccessControl has not run for this server");
    return a;
}

export function installAccessControl(app: FastifyInstance, p: Platform): AccessControl {
    const users = new UserStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY));
    const list: Array<{ method: string; url: string }> = [];
    registered.set(app, list);
    app.addHook("onRoute", (r) => {
        for (const m of Array.isArray(r.method) ? r.method : [r.method]) list.push({ method: String(m).toUpperCase(), url: r.url });
    });

    const crowd4test = crowd4testFromConfig(p.config);
    const c4tService = crowd4test ? c4tServiceOf(p) : undefined;
    // Signing in with Crowd4Test is never open access, even before anyone has arrived.
    const isOpen = () => !crowd4test && !p.config.API_KEY && users.peopleCount() === 0;
    const projects = createProjectScope(app, p.db);

    /**
     * The crowd4test.com session, checked before the access hook below (which cannot wait for the API's answer). Skipped when
     * the request brings its own key, token or session here, and for paths that are not the API.
     */
    if (crowd4test) {
        app.addHook("onRequest", async (req) => {
            const path = req.url.split("?")[0]!;
            if (!path.startsWith("/api/") || path === "/api/health") return;
            if (req.headers["x-api-key"] || String(req.headers.authorization ?? "").startsWith("Bearer ")) return;
            // Only a session that opens something here skips the check: a made-up cookie must not cost a signed-in person their Crowd4Test session.
            const session = readCookie(req, SESSION_COOKIE);
            const own = session ? users.sessionFor(session) : undefined;
            if (own && person(own.userId, undefined, {})) return;
            const check = await crowd4test.check(req);
            const links = { signInUrl: crowd4test.signInUrl, refreshUrl: crowd4test.refreshUrl, portalUrl: crowd4test.portalUrl };
            let outcome: C4tOutcome;
            if (check.kind === "user") {
                const linked = personFor(users, projects.store, check.user, c4tService && ((id) => c4tService.refreshOrganisation(projects.store, id, clientIpOf(req))));
                if ("refused" in linked) outcome = { status: "refused", error: new HttpError(403, linked.refused, { crowd4test: "refused", ...links }) };
                else {
                    if (linked.joined || !linked.person.lastSignInAt) users.markSignedIn(linked.person.id);
                    outcome = {
                        actor: {
                            kind: "user",
                            id: linked.person.id,
                            name: linked.person.name || linked.person.email,
                            role: linked.role,
                            via: "crowd4test",
                            permissions: linked.permissions,
                            side: linked.side,
                            ...(linked.organizationId ? { organizationId: linked.organizationId } : {}),
                        },
                    };
                }
            } else if (check.kind === "expired") outcome = { status: "expired", error: new HttpError(401, C4T_RENEW, { crowd4test: "renew", ...links }) };
            else if (check.kind === "refused") outcome = { status: "refused", error: new HttpError(403, check.message, { crowd4test: "refused", ...links }) };
            else if (check.kind === "unreachable") outcome = { status: "unreachable", error: new HttpError(503, C4T_UNREACHABLE, { crowd4test: "unreachable", ...links }) };
            else outcome = { status: "none", error: new HttpError(401, C4T_SIGN_IN, { crowd4test: "sign-in", ...links }) };
            (req as unknown as Record<symbol, C4tOutcome>)[C4T] = outcome;
        });
    }

    const person = (userId: string, role: Role | undefined, extra: Partial<Actor>): Actor | undefined => {
        const u = users.get(userId);
        // Someone linked to Crowd4Test comes in through Crowd4Test only: a session or a token of theirs must not outlive a suspension there.
        if (!u || u.status !== "active" || u.crowd4testLinked) return undefined;
        const r = role ? lowerRole(role, u.role) : u.role;
        return { kind: "user", id: u.id, name: u.name || u.email, role: r, permissions: ROLE_PERMISSIONS[r], side: "local", ...extra };
    };

    /** A key or token was sent: who it is, or "bad" when it is not valid. */
    const fromSecret = (got: string): Actor | "bad" => {
        const expected = p.config.API_KEY;
        if (expected && sameSecret(got, expected)) return { kind: "key", name: ACTOR_WORDS.key, role: "owner", permissions: ALL_PERMISSIONS, side: "local" };
        if (got.startsWith(TOKEN_PREFIX)) {
            const t = users.tokenFor(got);
            const a = t && person(t.userId, t.role, { via: "token", tokenId: t.tokenId });
            if (a) return a;
        }
        return "bad";
    };

    /** "bad": a key or token that is not valid; "csrf": a live session whose state-changing request lacks the CSRF token or comes from elsewhere. */
    const identify = (req: FastifyRequest, pathOnly?: string): Actor | undefined | "bad" | "csrf" => {
        const path = pathOnly ?? req.url.split("?")[0]!;
        // Browser links to artifacts (screenshots/traces) cannot set headers, so ?key= is accepted on that route only.
        const fromQuery = path.startsWith("/api/artifacts/") ? new URL(req.url, "http://x").searchParams.get("key") : null;
        const key = String(req.headers["x-api-key"] ?? fromQuery ?? "");
        // Without an API_KEY a key header that is not a personal token means nothing (as before accounts existed: it was ignored).
        if (key && (p.config.API_KEY || key.startsWith(TOKEN_PREFIX))) return fromSecret(key);
        const auth = String(req.headers.authorization ?? "");
        if (auth.startsWith(`Bearer ${TOKEN_PREFIX}`)) return fromSecret(auth.slice(7).trim());
        const cookie = readCookie(req, SESSION_COOKIE);
        if (cookie) {
            const s = users.sessionFor(cookie);
            const a = s && person(s.userId, undefined, { via: "session", sessionId: s.id });
            if (a) {
                if (!SAFE_METHODS.has(req.method)) {
                    const sent = String(req.headers["x-csrf-token"] ?? "");
                    if (!sent || !sameSecret(sent, s!.csrf) || !originAllowed(req)) return "csrf";
                }
                return a;
            }
        }
        const c4t = c4tOutcomeOf(req);
        if (c4t && "actor" in c4t) {
            // The Crowd4Test cookie goes with every request from any crowd4test.com page, so a change must also carry the page's
            // own header (which another site's script cannot add without this server agreeing first) and come from this address.
            if (!SAFE_METHODS.has(req.method) && (req.headers[C4T_REQUEST_HEADER] !== C4T_REQUEST_VALUE || !originAllowed(req))) return "csrf";
            return c4t.actor;
        }
        return undefined;
    };

    app.addHook("onRequest", (req, _reply, done) => {
        try {
            // Decide on the *decoded* path: the router decodes %xx, so a raw prefix check is bypassable (/%61pi/...).
            let pathOnly: string;
            try {
                pathOnly = decodeURIComponent(req.url.split("?")[0]!);
            } catch {
                throw new HttpError(400, "Malformed URL");
            }
            if (!pathOnly.startsWith("/api/") || pathOnly === "/api/health") return done();
            // List handlers narrow to the caller's projects through this (visibleProjectsOf in auth/project-scope.ts).
            attachProjectScope(req, projects);
            // The deploy-trigger token is the credential of exactly these two routes (an exact, anchored match; see trigger-store.ts).
            if (isTriggerTokenRoute(req.method, pathOnly)) return enter(req, { kind: "trigger", name: ACTOR_WORDS.trigger, role: "editor", permissions: ROLE_PERMISSIONS.editor, side: "local" }, done);
            // A runner agent's credential is its own token (checked by the agent routes themselves): exactly the protocol routes, same exact-match rule.
            if (isAgentRoute(req.method, pathOnly)) return enter(req, { kind: "runner", name: ACTOR_WORDS.runner, role: "editor", permissions: ROLE_PERMISSIONS.editor, side: "local" }, done);
            // A live-update stream opened by a browser carries a single-use ticket instead of the key; the stream route checks it (routes/stream.ts).
            if (isStreamTicketRequest(req.method, pathOnly, req.url)) return done();

            // The web app's catch-all page route ("/*") also catches an /api address that matches no route: that is no route at all,
            // so it needs a credential like any other /api address (and the 404 comes only after it), never the page route's "public".
            const matched = req.routeOptions?.url;
            const template = matched === "/*" ? undefined : matched;
            const rule = template ? permissionRuleFor(req.method, template) : undefined;
            const found = identify(req, pathOnly);
            if (rule === "public") {
                // A public route (sign-in, the auth state) ignores a stale or wrong credential instead of refusing.
                if (found && found !== "bad" && found !== "csrf") return enter(req, found, done);
                if (isOpen()) return enter(req, OPEN_ACTOR, done);
                return done();
            }
            let actor: Actor;
            if (found === "bad") throw new HttpError(401, KEY_REFUSED);
            if (found === "csrf") throw new HttpError(403, CSRF_REFUSED);
            if (found) actor = found;
            else if (isOpen()) actor = OPEN_ACTOR;
            else {
                const c4t = c4tOutcomeOf(req);
                if (c4t && "error" in c4t) throw c4t.error;
                throw new HttpError(401, p.config.API_KEY ? KEY_REFUSED : SIGN_IN_FIRST);
            }
            // Known before the permission check, so a refused change is still listed in Activity with who tried it.
            (req as unknown as Record<symbol, Actor>)[ACTOR] = actor;
            // No route matched: the router answers 404 for whoever passed authentication.
            if (template && rule !== "own") {
                const need: Permission = rule === undefined ? UNLISTED_NEEDS : rule === "read" ? "ai_studio.access" : rule;
                if (!permissionsOf(actor).has(need)) {
                    noteRefusedPermission(req, need);
                    throw new HttpError(403, permissionRefusal(actor, need));
                }
                // A person limited to some projects: 404 for anything of another project, and what they hold there counts (auth/project-scope.ts).
                projects.check(req, actor, template, need);
                // An archived project is read-only for everyone: every change to it or to anything in it is refused, except restoring
                // and deleting it (project-folders.ts). Reading, downloads and POSTs that store nothing ("read") stay open.
                if (!SAFE_METHODS.has(req.method) && rule !== "read" && !ARCHIVE_EXEMPT.has(`${req.method} ${template}`)) {
                    const scope = classifyRoute(req.method, template, rule);
                    const params = (req.params ?? {}) as Record<string, string | undefined>;
                    const projectId = scope?.kind === "project" ? params[scope.param] : scope?.kind === "object" ? projects.projectOf(scope.object, String(params[scope.param] ?? "")) : undefined;
                    if (projectId && isArchived(p.db, projectId)) throw new HttpError(409, PROJECT_ARCHIVED);
                }
                (req as unknown as Record<symbol, Permission>)[USED] = need;
            }
            return enter(req, actor, done);
        } catch (e) {
            done(e as Error);
        }
    });

    // The one route whose project is in its body (a live-update ticket names a run or a project): checked once the body is read.
    app.addHook("preHandler", (req, _reply, done) => {
        try {
            const actor = actorOf(req);
            if (actor && req.method === "POST" && req.routeOptions?.url === "/api/stream-tickets") projects.checkTicket(req, actor);
            done();
        } catch (e) {
            done(e as Error);
        }
    });

    // The Activity list: every change made through the API, with who made it. Reading is not recorded; neither are the runner protocol
    // and streams (machine traffic, many calls a minute) nor the auth routes (they record their own, plainer events).
    app.addHook("onResponse", (req, reply, done) => {
        try {
            const actor = actorOf(req);
            const template = req.routeOptions?.url;
            // The security assessment module records its own plainer events, and a fallback line for any change that did not (src/security/routes/index.ts).
            // So do a project's member changes once they succeed (routes/members.ts); a refused one is recorded here.
            const ownEvent = template?.startsWith("/api/projects/:id/members") && reply.statusCode < 400;
            if (actor && template && !ownEvent && !SAFE_METHODS.has(req.method) && actor.kind !== "runner" && !template.startsWith("/api/auth/") && !template.startsWith("/api/v1/security/")) {
                const params = (req.params ?? {}) as Record<string, string>;
                users.addActivity({
                    actorKind: actor.kind,
                    actorId: actor.id ?? null,
                    actorName: actor.name,
                    action: `${req.method} ${template}`,
                    // A deploy-trigger address carries its token: only the route template is kept for those, and any other address is
                    // stored without its query and with the trigger segment hidden all the same (belt and braces; see trigger-store.ts).
                    path: actor.kind === "trigger" ? null : redactTriggerUrl(req.url.split("?")[0]!),
                    projectId: template.startsWith("/api/projects/:id") ? (params.id ?? null) : null,
                    status: reply.statusCode,
                    detail: activityDetail(req, actor),
                });
            }
        } catch (e) {
            req.log.warn({ err: e }, "activity not recorded");
        }
        done();
    });

    installCostHiding(app, actorOf);

    const control: AccessControl = {
        users,
        projects,
        crowd4test,
        isOpen,
        identify: (req) => {
            const a = identify(req);
            return a === "bad" || a === "csrf" ? undefined : a;
        },
    };
    access.set(app, control);
    return control;
}

const OPEN_ACTOR: Actor = { kind: "open", name: ACTOR_WORDS.open, role: "owner", permissions: ALL_PERMISSIONS, side: "local" };

/**
 * The Activity row's detail: a personal token, the permission a refusal was missing, and for a Crowd4Test account the permission
 * the change used and a customer's organisation (local accounts' rows read as they always did).
 */
function activityDetail(req: FastifyRequest, actor: Actor): string | null {
    const parts: string[] = [];
    if (actor.via === "token") parts.push("With a personal API token");
    const refused = (req as unknown as Record<symbol, Permission | undefined>)[REFUSED];
    const used = (req as unknown as Record<symbol, Permission | undefined>)[USED];
    if (refused) parts.push(`Refused: needs ${refused}`);
    else if (used && isCrowd4TestActor(actor)) parts.push(`With ${used}`);
    if (actor.organizationId) parts.push(`Organization ${actor.organizationId}`);
    return parts.length ? parts.join(". ").slice(0, 500) : null;
}

function enter(req: FastifyRequest, actor: Actor, done: () => void): void {
    (req as unknown as Record<symbol, Actor>)[ACTOR] = actor;
    // Everything this request runs from here on (its handler and what it awaits) sees this actor: audit writes record it (auth/actor.ts).
    enterActor(actor);
    done();
}

export { CSRF_COOKIE };
