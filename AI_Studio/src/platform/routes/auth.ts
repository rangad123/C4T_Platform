/**
 * Signing in and out, and a person's own account (USR, docs/features/people-and-access.md).
 *
 *   GET    /api/auth/state                 public: is the platform open or protected, who is asking, is single sign-on on
 *   POST   /api/auth/sign-in               public: { email, password } → session cookie (rate-limited, lockout after wrong passwords)
 *   POST   /api/auth/sign-out              public: ends this browser's session (if any) and clears the cookies
 *   POST   /api/auth/setup                 the access-key holder (or anyone while the platform is open) creates the first owner
 *   POST   /api/auth/invite/check          public: { token } → whose link it is
 *   POST   /api/auth/invite/accept         public: { token, password } → sets the password and signs in
 *   GET    /api/auth/sso/start             public: sends the browser to the sign-in provider
 *   GET    /api/auth/sso/callback          public: the provider sends the browser back here
 *   PUT    /api/me/password                { current, next }
 *   POST   /api/me/sign-out-everywhere     ends every session of the person (this one too)
 *   GET    /api/me/tokens                  the person's API tokens (names and last four characters only)
 *   POST   /api/me/tokens                  { name, role?, expiresInDays? } → the token, shown once
 *   DELETE /api/me/tokens/:tokenId
 *
 * The /api/auth/ routes record their own events in the Activity list (the generic recorder skips them); /api/me/ changes are
 * recorded by the generic recorder like every other change.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { accessControlOf, actorOf, crowd4testStatusOf, isOriginAllowed } from "../auth/access.js";
import { atLeast, permissionsOf, ROLE_WORDS, sideOf, type Actor } from "../auth/actor.js";
import { ROLE_PERMISSIONS, sortedPermissions } from "../auth/permissions.js";
import { clearSessionCookies, readCookie, SESSION_COOKIE, setSessionCookies } from "../auth/cookies.js";
import { SignInLimiter } from "../auth/limiter.js";
import { finishSignIn, SsoError, startSignIn } from "../auth/oidc.js";
import { hashPassword, PASSWORD_MAX, passwordProblem, verifyPassword } from "../auth/password.js";
import { MAX_PEOPLE, normEmail, sha256, type Person } from "../user-store.js";
import type { RouteCtx } from "./types.js";

export const Email = z.string().trim().min(3).max(254).regex(/^[^@\s]+@[^@\s]+$/, "Enter an email address such as name@example.com");
const Password = z.string().min(1).max(PASSWORD_MAX);
const Name = z.string().trim().max(120);
export const C4T_OWN_SIGN_IN = "This account signs in with Crowd4Test, so it has no password here.";
export const WRONG_SIGN_IN = "That email and password don’t match an account. Check them and try again.";

/** The address people reach the platform at: PUBLIC_URL, else what this request used. */
export function publicBase(req: FastifyRequest): string {
    const configured = (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    return `${req.protocol}://${req.headers.host ?? "localhost"}`;
}

/**
 * What the page may know about the person asking. `permissions`: the `ai_studio.*` codes held platform-wide (a project can narrow
 * them: GET /api/projects/:id says what counts there); `side`: admin, customer, tester (Crowd4Test accounts) or local; a customer's
 * `organizationId`. `role` stays for local accounts; for Crowd4Test accounts the permissions decide.
 */
export function meOf(actor: Actor | undefined, person?: Person) {
    if (!actor) return null;
    return {
        kind: actor.kind,
        name: actor.name,
        role: actor.role,
        ...(actor.kind === "user" ? { id: actor.id, email: person?.email ?? null, via: actor.via ?? "session" } : {}),
        permissions: sortedPermissions(permissionsOf(actor)),
        side: sideOf(actor),
        organizationId: actor.organizationId ?? null,
    };
}

export function registerAuthRoutes(ctx: RouteCtx): void {
    const { app, p } = ctx;
    const access = accessControlOf(app);
    const users = access.users;
    const limiter = new SignInLimiter();
    const ipOf = (req: FastifyRequest) => req.ip || "unknown";

    const event = (actor: { kind: Actor["kind"]; id?: string | null; name: string }, action: string, detail?: string) =>
        users.addActivity({ actorKind: actor.kind, actorId: actor.id ?? null, actorName: actor.name, action, detail: detail ?? null });

    const signIn = (req: FastifyRequest, reply: FastifyReply, person: Person, via: string) => {
        // Rotation: whatever session this browser had ends; a new one starts.
        const old = readCookie(req, SESSION_COOKIE);
        if (old) users.endSession(sha256(old));
        const { token, session } = users.createSession(person.id, via, String(req.headers["user-agent"] ?? ""));
        users.markSignedIn(person.id);
        setSessionCookies(req, reply, token, session.csrf);
        return {
            kind: "user" as const,
            id: person.id,
            name: person.name || person.email,
            email: person.email,
            role: person.role,
            via: "session" as const,
            permissions: sortedPermissions(ROLE_PERMISSIONS[person.role]),
            side: "local" as const,
            organizationId: null,
        };
    };

    /** Sign-in style forms only come from the platform's own page (a site elsewhere cannot sign a browser into an account of its choosing). */
    const ownPage = (req: FastifyRequest) => {
        if (!isOriginAllowed(req)) throw new HttpError(403, "This form did not come from the platform's own page. Reload the page and try again.");
    };

    const ssoPublic = () => {
        const s = users.ssoSettings();
        return s && s.hasSecret ? { enabled: true, label: s.label || "Sign in with single sign-on" } : null;
    };

    app.get("/api/auth/state", async (req) => {
        const actor = actorOf(req);
        const person = actor?.kind === "user" && actor.id ? users.get(actor.id) : undefined;
        const people = users.peopleCount();
        return {
            // open: anyone who reaches the server can use it; protected: a key, a token or a sign-in is needed.
            mode: access.isOpen() ? "open" : "protected",
            accessKeyConfigured: Boolean(p.config.API_KEY),
            hasPeople: people > 0,
            sso: ssoPublic(),
            me: meOf(actor, person),
            // "only": this person sees some projects only (per-project access); the page then hides platform-wide settings.
            projectAccess: person ? access.projects.store.accessOf(person.id).mode : "all",
            // Signing in happens on crowd4test.com: where to send the page, and what the check found ("expired": renew and ask again).
            crowd4test: access.crowd4test
                ? { ...(crowd4testStatusOf(req) ?? { status: "none" }), signInUrl: access.crowd4test.signInUrl, refreshUrl: access.crowd4test.refreshUrl, portalUrl: access.crowd4test.portalUrl }
                : null,
        };
    });

    app.post("/api/auth/sign-in", async (req, reply) => {
        ownPage(req);
        const body = z.object({ email: Email, password: Password }).parse(req.body);
        const email = normEmail(body.email);
        const wait = limiter.hit(ipOf(req));
        if (wait) throw new HttpError(429, `Too many sign-in attempts from this computer. Wait ${wait} minute${wait === 1 ? "" : "s"} and try again.`);
        const lockedFor = limiter.locked(email);
        if (lockedFor) throw new HttpError(429, `Too many wrong passwords for this email. Wait ${lockedFor} minute${lockedFor === 1 ? "" : "s"} and try again, or ask an owner for a reset link.`);
        const person = users.byEmail(email);
        // The hash is always computed (also for an unknown email) so the answer time says nothing about which emails exist.
        const ok = await verifyPassword(body.password, person?.passwordHash);
        if (!ok || !person || person.status !== "active") {
            const lockedNow = limiter.failed(email);
            event({ kind: "user", id: person?.id ?? null, name: email.slice(0, 120) }, "sign-in failed", lockedNow ? "Locked for 15 minutes after repeated wrong passwords" : undefined);
            throw new HttpError(401, WRONG_SIGN_IN);
        }
        // A password left from before the account was linked opens nothing: a suspension on Crowd4Test must hold here too.
        if (person.crowd4testLinked) throw new HttpError(403, C4T_OWN_SIGN_IN);
        limiter.succeeded(email);
        const me = signIn(req, reply, person, "password");
        event({ kind: "user", id: person.id, name: me.name }, "sign-in");
        return { me };
    });

    app.post("/api/auth/sign-out", async (req, reply) => {
        const actor = actorOf(req);
        // Only a session that passed the CSRF check is ended (a page elsewhere cannot sign people out); the cookies are cleared either way.
        if (actor?.kind === "user" && actor.via === "session" && actor.sessionId) {
            users.endSession(actor.sessionId);
            event(actor, "sign-out");
        }
        clearSessionCookies(req, reply);
        return { signedOut: true };
    });

    app.post("/api/auth/setup", async (req, reply) => {
        ownPage(req);
        const actor = actorOf(req);
        if (users.peopleCount() > 0) throw new HttpError(409, "This platform already has people. Ask an owner to add you.");
        if (!actor || (actor.kind !== "key" && actor.kind !== "open")) throw new HttpError(401, "Enter the access key first: only the holder of the access key can create the first owner.");
        const body = z.object({ email: Email, name: Name.min(1, "Enter your name"), password: Password }).parse(req.body);
        const problem = passwordProblem(body.password, body.email);
        if (problem) throw new HttpError(400, problem);
        if (users.emailTakenByBuiltIn(body.email)) throw new HttpError(400, "That address is reserved by the platform. Use your own email address.");
        const person = users.create({ email: body.email, name: body.name, role: "owner", passwordHash: await hashPassword(body.password) });
        const me = signIn(req, reply, person, "setup");
        event(actor, "first owner created", `${person.name} <${person.email}>`);
        return reply.code(201).send({ me });
    });

    const Token = z.object({ token: z.string().min(10).max(200) });
    const LINK_GONE = "This link is not valid any more (it was used, replaced or is too old). Ask an owner for a new one.";

    app.post("/api/auth/invite/check", async (req) => {
        const { token } = Token.parse(req.body);
        const inv = users.inviteFor(token);
        const person = inv && users.get(inv.userId);
        if (!inv || !person || person.status !== "active" || person.crowd4testLinked) throw new HttpError(404, LINK_GONE);
        return { email: person.email, name: person.name, purpose: inv.purpose };
    });

    app.post("/api/auth/invite/accept", async (req, reply) => {
        ownPage(req);
        const body = Token.extend({ password: Password, name: Name.optional() }).parse(req.body);
        const wait = limiter.hit(ipOf(req));
        if (wait) throw new HttpError(429, `Too many attempts from this computer. Wait ${wait} minute${wait === 1 ? "" : "s"} and try again.`);
        const inv = users.inviteFor(body.token);
        const person = inv && users.get(inv.userId);
        if (!inv || !person || person.status !== "active" || person.crowd4testLinked) throw new HttpError(404, LINK_GONE);
        const problem = passwordProblem(body.password, person.email);
        if (problem) throw new HttpError(400, problem);
        users.setPassword(person.id, await hashPassword(body.password));
        if (body.name && !person.name) users.update(person.id, { name: body.name });
        users.useInvite(body.token);
        // A new password ends every earlier session (a reset is often because someone else may have had access).
        users.endAllSessions(person.id);
        limiter.succeeded(person.email);
        const me = signIn(req, reply, users.get(person.id)!, "invite");
        event({ kind: "user", id: person.id, name: me.name }, inv.purpose === "invite" ? "joined from an invite link" : "password set from a reset link");
        return { me };
    });

    // ── single sign-on ──────────────────────────────────────────────────────
    const ssoFailed = (reply: FastifyReply, req: FastifyRequest, message: string) => reply.redirect(`${publicBase(req)}/#/?ssoError=${encodeURIComponent(message)}`, 302);

    app.get("/api/auth/sso/start", async (req, reply) => {
        const s = users.ssoSettings();
        const secret = users.ssoSecret();
        if (!s || !secret) return ssoFailed(reply, req, "Single sign-on is not set up on this platform.");
        const redirectUri = `${publicBase(req)}/api/auth/sso/callback`;
        try {
            const start = await startSignIn({ issuer: s.issuer, clientId: s.clientId, redirectUri });
            users.addPending({ state: start.state, nonce: start.nonce, verifier: start.verifier, redirectUri });
            return reply.redirect(start.url, 302);
        } catch (e) {
            return ssoFailed(reply, req, e instanceof SsoError ? e.message : "The sign-in provider could not be reached.");
        }
    });

    app.get("/api/auth/sso/callback", async (req, reply) => {
        const q = z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional(), error_description: z.string().max(500).optional() }).parse(req.query);
        const pending = q.state ? users.takePending(q.state) : undefined;
        if (q.error) return ssoFailed(reply, req, `The sign-in provider said: ${(q.error_description ?? q.error).slice(0, 200)}`);
        if (!pending || !q.code) return ssoFailed(reply, req, "This sign-in was not started here or took too long. Try again.");
        const s = users.ssoSettings();
        const secret = users.ssoSecret();
        if (!s || !secret) return ssoFailed(reply, req, "Single sign-on is not set up on this platform.");
        try {
            const who = await finishSignIn({ issuer: s.issuer, clientId: s.clientId, clientSecret: secret, code: q.code, redirectUri: pending.redirectUri, verifier: pending.verifier, nonce: pending.nonce, allowedDomain: s.allowedDomain });
            let person: Person | undefined = users.byEmail(who.email);
            if (person) {
                if (person.status !== "active") return ssoFailed(reply, req, "Your account is turned off. Ask an owner of this platform.");
                const linked = users.db.get<{ sso_subject: string | null }>("SELECT sso_subject FROM users WHERE id = ?", person.id)?.sso_subject;
                if (linked && linked !== who.subject) return ssoFailed(reply, req, "This email is linked to a different single sign-on identity. Ask an owner of this platform.");
                if (!linked) users.setSsoSubject(person.id, who.subject);
            } else {
                if (users.emailTakenByBuiltIn(who.email)) return ssoFailed(reply, req, "That address is reserved by the platform.");
                if (users.peopleCount() >= MAX_PEOPLE) return ssoFailed(reply, req, "This platform has reached its limit of people. Ask an owner.");
                person = users.create({ email: who.email, name: who.name || who.email.split("@")[0]!, role: s.defaultRole, ssoSubject: who.subject });
                event({ kind: "user", id: person.id, name: person.name }, "joined with single sign-on", `${ROLE_WORDS[s.defaultRole]}, ${person.email}`);
            }
            const me = signIn(req, reply, users.get(person!.id)!, "sso");
            event({ kind: "user", id: person.id, name: me.name }, "sign-in", "With single sign-on");
            return reply.redirect(`${publicBase(req)}/#/`, 302);
        } catch (e) {
            event({ kind: "user", id: null, name: "Single sign-on" }, "sign-in failed", e instanceof SsoError ? e.message : "Unexpected error");
            return ssoFailed(reply, req, e instanceof SsoError ? e.message : "Single sign-on did not work. Try again.");
        }
    });

    // ── the person's own account ────────────────────────────────────────────
    /** The signed-in person behind this request (the access key and open access have no account). */
    const self = (req: FastifyRequest) => {
        const a = actorOf(req);
        const person = a?.kind === "user" && a.id ? users.get(a.id) : undefined;
        if (!a || !person) throw new HttpError(400, "Sign in with your own account to do this (the access key has no account).");
        return { actor: a, person };
    };

    app.put("/api/me/password", async (req) => {
        const { actor, person } = self(req);
        if (actor.via === "crowd4test" || person.crowd4testLinked) throw new HttpError(403, C4T_OWN_SIGN_IN);
        const body = z.object({ current: z.string().max(PASSWORD_MAX).optional(), next: Password }).parse(req.body);
        if (person.passwordHash && !(await verifyPassword(body.current ?? "", person.passwordHash))) throw new HttpError(400, "The current password is not right.");
        const problem = passwordProblem(body.next, person.email);
        if (problem) throw new HttpError(400, problem);
        users.setPassword(person.id, await hashPassword(body.next));
        // Other browsers signed in as this person are signed out; this one stays.
        const ended = users.endAllSessions(person.id, actor.via === "session" ? actor.sessionId : undefined);
        return { changed: true, otherSessionsEnded: ended };
    });

    app.post("/api/me/sign-out-everywhere", async (req, reply) => {
        const { person } = self(req);
        const ended = users.endAllSessions(person.id);
        clearSessionCookies(req, reply);
        return { sessionsEnded: ended };
    });

    app.get("/api/me/tokens", async (req) => ({ tokens: users.tokens(self(req).person.id) }));

    app.post("/api/me/tokens", async (req, reply) => {
        const { actor, person } = self(req);
        // A token cannot make tokens: only a person signed in to the page can (so a leaked token cannot multiply itself).
        // Nor a Crowd4Test sign-in: a token would keep working after the Crowd4Test account was suspended, which this server cannot see.
        if (actor.via === "crowd4test") throw new HttpError(403, "Personal API tokens are not available when you sign in with Crowd4Test. Ask an owner for an access key.");
        if (actor.via !== "session") throw new HttpError(403, "Make API tokens from the page while signed in, not with another token.");
        const body = z.object({ name: z.string().trim().min(1, "Give the token a name").max(80), role: z.enum(["owner", "editor", "viewer"]).optional(), expiresInDays: z.number().int().min(1).max(365).optional() }).parse(req.body);
        const role = body.role ?? person.role;
        if (!atLeast(person.role, role)) throw new HttpError(400, `A token cannot have more than your own role (${ROLE_WORDS[person.role]}).`);
        try {
            const made = users.createToken(person.id, { name: body.name, role, expiresInDays: body.expiresInDays });
            return reply.code(201).send({ token: made.token, info: made.info, note: "Copy the token now: it is shown only once." });
        } catch (e) {
            throw new HttpError(409, e instanceof Error ? e.message : String(e));
        }
    });

    app.delete("/api/me/tokens/:tokenId", async (req) => {
        const { person } = self(req);
        const { tokenId } = z.object({ tokenId: z.string().min(1).max(64) }).parse(req.params);
        if (!users.removeToken(person.id, tokenId)) throw new HttpError(404, "Token not found");
        return { removed: true };
    });
}
