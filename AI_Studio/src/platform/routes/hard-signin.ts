/**
 * Hard sign-ins (Builder WA): saved signed-in sessions per project and test account, "Sign in once yourself", the "Still signed in?"
 * check, the project's test mailbox, and the inbound address mail can be forwarded to. Contract in docs/features/hard-sign-ins.md.
 *
 * Secrets are write-only: a session's cookies and storage, the mailbox password and the inbound address token are never returned (the
 * address is shown once, when it is made). The inbound route is the only one without the API key or a person's sign-in: its address
 * token is its credential (compared by hash), it accepts only mail, and only for the project that owns the token.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mailFromFields, parseRawMail, MAX_MAIL_BYTES } from "../../engine/auth/mail.js";
import { parseStorageState, StorageStateError } from "../../engine/auth/storage-state.js";
import { browserInstalled, hasDisplay } from "../recorder-service.js";
import { HardSignInService, type HardSignInOptions } from "../hard-signin-service.js";
import { HttpError } from "../http-error.js";
import { IdentityStore } from "../identity-store.js";
import { plainImapProblem, testImap, type ImapOptions } from "../mailbox/imap.js";
import { assertAllowedTarget } from "../net-guard.js";
import { SecretBox } from "../secrets.js";
import { ACCOUNT_NAME, MAIN_ACCOUNT, type ImapConfig } from "../session-store.js";
import type { RouteCtx } from "./types.js";

/** Tests set the browser launcher, the address guard and IMAP TLS options here before building the server. Normal runs leave it empty. */
export const hardSignInOptions: HardSignInOptions & { imap?: ImapOptions } = {};
const services = new WeakMap<FastifyInstance, HardSignInService>();
/** The service of a built server (tests drive the sign-in browser's page through it). */
export const hardSignInOf = (app: FastifyInstance): HardSignInService | undefined => services.get(app);

/** The inbound address: exact, anchored (the token is the credential of this route only). */
export const INBOUND_ROUTE = "/api/inbound-mail/:token";
export const inboundPath = (token: string) => `/api/inbound-mail/${token}`;

const StartBody = z.object({
    /** Where the browser opens (default: the project's application). Must be on the application's site or an address the guard allows. */
    url: z.string().min(1).max(2000).optional(),
    headed: z.boolean().optional(),
});
const UploadBody = z.object({
    /** A Playwright storage state (the file `--save-storage` writes), as an object or as its JSON text. */
    storageState: z.union([z.string().max(1_000_000), z.record(z.unknown())]),
    /** The signed-in page the "Still signed in?" check opens (default: the application's address). */
    checkUrl: z.string().min(1).max(2000).optional(),
});
const ImapBody = z.object({
    host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$|^\[?[0-9a-fA-F:.]+\]?$/, "Use a host name or an IP address"),
    port: z.number().int().min(1).max(65535).default(993),
    tls: z.boolean().default(true),
    user: z.string().min(1).max(300),
    /** Omitted = keep the saved password. */
    password: z.string().min(1).max(300).optional(),
    mailbox: z.string().min(1).max(100).optional(),
});
const MailboxBody = z.discriminatedUnion("kind", [z.object({ kind: z.literal("imap"), imap: ImapBody }), z.object({ kind: z.literal("inbound") })]);
const InboundJson = z.object({
    to: z.union([z.string().max(2000), z.array(z.string().max(320)).max(50)]),
    from: z.string().max(320).optional(),
    subject: z.string().max(1000).optional(),
    text: z.string().max(MAX_MAIL_BYTES).optional(),
    html: z.string().max(MAX_MAIL_BYTES).optional(),
});
const InboundRaw = z.object({ raw: z.string().min(1).max(MAX_MAIL_BYTES) });

/** At most this many forwarded messages per token per minute (a forwarding loop must not fill the database). */
const INBOUND_PER_MINUTE = 60;

const accountParam = (raw: string): string => {
    if (!ACCOUNT_NAME.test(raw)) throw new HttpError(400, "Use “main” or the name of a test account.");
    return raw;
};

export function registerHardSignInRoutes(ctx: RouteCtx): void {
    const { app, p, repo, project } = ctx;
    const service = HardSignInService.for(p.db, p.config, hardSignInOptions);
    services.set(app, service);
    app.addHook("onClose", async () => {
        await service.dispose();
    });
    const store = service.sessions;
    const guard = hardSignInOptions.guard ?? assertAllowedTarget;

    const appUrlOf = (projectId: string): string => {
        const a = repo.getLatestApplicationPublic(projectId);
        if (!a) throw new HttpError(409, "This project has no application address yet. Add one (or run an exploration) first.");
        return String(a.url);
    };
    const knownAccount = (projectId: string, account: string) => {
        if (account === MAIN_ACCOUNT) return;
        let names: string[] = [];
        try {
            names = new IdentityStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).get(projectId).map((r) => r.name);
        } catch {
            /* unreadable accounts: none known */
        }
        if (!names.includes(account)) throw new HttpError(404, `There is no test account named “${account}”. Add it under Test accounts first.`);
    };
    const accountsOf = (projectId: string): string[] => {
        try {
            return [MAIN_ACCOUNT, ...new IdentityStore(p.db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).get(projectId).map((r) => r.name)];
        } catch {
            return [MAIN_ACCOUNT];
        }
    };

    // ── overview ───────────────────────────────────────────────────────────
    app.get("/api/projects/:id/hard-sign-in", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const a = repo.getLatestApplicationPublic(id);
        return {
            appUrl: a ? String(a.url) : null,
            accounts: accountsOf(id),
            sessions: store.listSessions(id),
            capture: service.capture(id) ?? null,
            mailbox: store.publicMailbox(id) ?? null,
            browser: { installed: browserInstalled(), display: hasDisplay() },
        };
    });

    // ── "Sign in once yourself" ────────────────────────────────────────────
    app.post("/api/projects/:id/sessions/:account/capture", async (req, reply) => {
        const { id, account: raw } = req.params as { id: string; account: string };
        project(id);
        const account = accountParam(raw);
        knownAccount(id, account);
        const body = StartBody.parse(req.body ?? {});
        const appUrl = appUrlOf(id);
        const startUrl = body.url ? new URL(body.url, appUrl).toString() : appUrl;
        if (!/^https?:$/.test(new URL(startUrl).protocol)) throw new HttpError(400, "Only http(s) addresses can be opened.");
        if (new URL(startUrl).username || new URL(startUrl).password) throw new HttpError(400, "Leave the user name and password out of the address.");
        await guard(startUrl);
        const headed = body.headed ?? true;
        if (headed && !hasDisplay()) throw new HttpError(422, "This computer has no screen for the sign-in window. Upload a saved sign-in file instead, or run the platform on a machine with a screen.");
        if (!hardSignInOptions.launch && !browserInstalled()) throw new HttpError(422, "No browser is installed on the machine that runs the platform. Run: npx playwright install chromium");
        reply.code(201);
        return service.startCapture(id, account, appUrl, startUrl, headed);
    });

    app.get("/api/projects/:id/sessions/capture", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const c = service.capture(id);
        if (!c) throw new HttpError(404, "There is no sign-in browser for this project.");
        return c;
    });

    app.post("/api/projects/:id/sessions/capture/save", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        return { session: await service.saveCapture(id) };
    });

    app.delete("/api/projects/:id/sessions/capture", async (req, reply) => {
        const id = (req.params as { id: string }).id;
        project(id);
        await service.cancelCapture(id);
        reply.code(204);
    });

    // ── a saved session ────────────────────────────────────────────────────
    app.put("/api/projects/:id/sessions/:account", async (req) => {
        const { id, account: raw } = req.params as { id: string; account: string };
        project(id);
        const account = accountParam(raw);
        knownAccount(id, account);
        const body = UploadBody.parse(req.body);
        let state;
        try {
            state = parseStorageState(body.storageState);
        } catch (e) {
            throw new HttpError(400, e instanceof StorageStateError ? e.message : "The saved sign-in could not be read.");
        }
        const appUrl = appUrlOf(id);
        const checkUrl = body.checkUrl ? new URL(body.checkUrl, appUrl).toString() : appUrl;
        if (new URL(checkUrl).origin !== new URL(appUrl).origin) throw new HttpError(400, "The page to check must be on the application's own site.");
        return { session: store.saveSession(id, account, { state, appUrl, checkUrl, how: "file" }) };
    });

    app.post("/api/projects/:id/sessions/:account/check", async (req) => {
        const { id, account: raw } = req.params as { id: string; account: string };
        project(id);
        const account = accountParam(raw);
        if (!hardSignInOptions.launch && !browserInstalled()) throw new HttpError(422, "No browser is installed on the machine that runs the platform. Run: npx playwright install chromium");
        const v = await service.check(id, account);
        return { signedIn: v.signedIn, reason: v.reason, ...(v.unreachable ? { unreachable: true } : {}), session: v.session ?? null };
    });

    app.delete("/api/projects/:id/sessions/:account", async (req, reply) => {
        const { id, account: raw } = req.params as { id: string; account: string };
        project(id);
        if (!store.forgetSession(id, accountParam(raw))) throw new HttpError(404, "No sign-in is saved for this account.");
        reply.code(204);
    });

    // ── the test mailbox ───────────────────────────────────────────────────
    app.put("/api/projects/:id/mailbox", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const body = MailboxBody.parse(req.body);
        if (body.kind === "inbound") {
            const { token } = store.setMailbox(id, { kind: "inbound" });
            // The address is shown this once: only its hash is kept.
            return { mailbox: store.publicMailbox(id), inboundPath: inboundPath(token!) };
        }
        const old = store.mailbox(id);
        const password = body.imap.password ?? (old?.kind === "imap" ? old.imap.password : undefined);
        if (!password) throw new HttpError(400, "The mailbox needs a password.");
        const imap: ImapConfig = { host: body.imap.host.replace(/^\[|\]$/g, ""), port: body.imap.port, tls: body.imap.tls, user: body.imap.user, password, ...(body.imap.mailbox ? { mailbox: body.imap.mailbox } : {}) };
        const problem = plainImapProblem(imap);
        if (problem) throw new HttpError(400, problem);
        await guard(`http://${imap.host.includes(":") ? `[${imap.host}]` : imap.host}:${imap.port}/`);
        store.setMailbox(id, { kind: "imap", imap });
        return { mailbox: store.publicMailbox(id) };
    });

    app.post("/api/projects/:id/mailbox/test", async (req) => {
        const id = (req.params as { id: string }).id;
        project(id);
        const box = store.mailbox(id);
        if (!box) throw new HttpError(404, "This project has no test mailbox yet.");
        if (box.kind === "inbound") return { ok: true, note: `Forwarded mail is kept for a day. ${store.publicMailbox(id)?.messages ?? 0} message(s) are kept now.` };
        const problem = await testImap(box.imap, hardSignInOptions.imap);
        return problem ? { ok: false, problem } : { ok: true, note: "The platform signed in to the mailbox and opened its folder." };
    });

    app.delete("/api/projects/:id/mailbox", async (req, reply) => {
        const id = (req.params as { id: string }).id;
        project(id);
        store.removeMailbox(id);
        reply.code(204);
    });

    // ── the inbound address (forwarded mail) ───────────────────────────────
    const recent = new Map<string, number[]>();
    app.register(async (scope) => {
        // Raw messages (what most mail forwarders can send) arrive as message/rfc822 or plain text.
        scope.addContentTypeParser(["message/rfc822", "text/plain"], { parseAs: "string", bodyLimit: MAX_MAIL_BYTES + 64_000 }, (_req, body, done) => done(null, { raw: String(body) }));
        scope.post(INBOUND_ROUTE, { bodyLimit: MAX_MAIL_BYTES * 2 + 64_000 }, async (req, reply) => {
            const token = (req.params as { token: string }).token;
            const projectId = store.projectForToken(token);
            if (!projectId) throw new HttpError(404, "Not found");
            const now = Date.now();
            const times = (recent.get(projectId) ?? []).filter((t) => t > now - 60_000);
            if (times.length >= INBOUND_PER_MINUTE) throw new HttpError(429, "Too many messages a minute for this address.");
            times.push(now);
            recent.set(projectId, times);
            const raw = InboundRaw.safeParse(req.body);
            const fields = raw.success ? undefined : InboundJson.safeParse(req.body);
            if (!raw.success && !fields?.success) throw new HttpError(400, "Send the message as JSON { to, subject, text, html }, as JSON { raw }, or as message/rfc822.");
            const mail = raw.success ? parseRawMail(raw.data.raw, now) : mailFromFields(fields!.data!, now);
            if (!mail.to.length) throw new HttpError(400, "The message has no recipient address.");
            store.addInbound(projectId, mail);
            reply.code(202);
            return { received: true };
        });
    });
}
