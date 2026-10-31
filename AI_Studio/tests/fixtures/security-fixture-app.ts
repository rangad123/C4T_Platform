/**
 * A small web application WE own, with deliberate configuration mistakes, for the passive Security Assessment tests (round 18, RUN).
 * Everything here is local and fake: the ".env" holds made-up values, the session cookie is meaningless.
 *
 * Deliberate problems:
 *  - no browser security headers anywhere (no CSP, X-Frame-Options, nosniff, Referrer-Policy)
 *  - a session cookie without HttpOnly / SameSite (Secure is not judged on plain http)
 *  - a readable /.env with fake values
 *  - version banners (Server: Apache/2.4.1, X-Powered-By: Express 4.17.1)
 *  - a directory listing at /uploads/
 *  - an API that echoes any Origin with credentials (CORS)
 *  - /go-away redirects to another host (the "outside" server: out of scope, must never be reached)
 *  - a link to a private address (http://10.0.0.5/), a link to an excluded path (/admin/billing), a link to the outside host
 *  - a sign-in form posting to /login (must never be submitted) and a page script that tries a POST on load (must be blocked)
 *
 * Every request is logged (method + path) so a test can prove what was and was not requested.
 *
 * Signed-in area (round 20, SIGN), reachable only with the cookie FIXTURE_SESSION_COOKIE=FIXTURE_SESSION_VALUE (a test puts it in a saved
 * sign-in; nothing here signs anyone in, and an anonymous visitor sees exactly what it saw before):
 *  - the home page then also links "My account" (/account);
 *  - /account echoes the session value in its text (redaction and scrubbing must hide it), sets a cookie, and links /account/orders,
 *    /account/payments (a sensitive workflow in the tests: must never be requested), /logout ("Log out") and /session/end ("Sign out",
 *    only its words say so): both sign-out addresses must never be requested;
 *  - /api/me and /api/orders answer JSON only when signed in; /api/search needs ?q=; /api/logout signs out.
 *  Without the cookie (or with another value) /account and the APIs answer 401 with a sign-in form.
 *  Round 21: `expireSessionAfter(n)` ends that session on the server mid-run (refused from then on, its cookie removed).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureRequest {
    method: string;
    path: string;
    headers: http.IncomingHttpHeaders;
}

export interface SecurityFixture {
    origin: string;
    port: number;
    /** Every request the application received, in order. */
    requests: FixtureRequest[];
    /** Every request the outside (out-of-scope) server received: must stay empty. */
    outsideRequests: FixtureRequest[];
    outsideOrigin: string;
    /** Delay (ms) before every page answer; tests raise it to make an assessment slow (cancel, timeout). */
    setDelay(ms: number): void;
    /** Requests for this path get their connection dropped (a network error that does not go away), or null for none. */
    setBroken(path: string | null): void;
    /** The owner "fixes" the .env exposure: /.env then answers 404 (for retests). */
    fixEnv(): void;
    /**
     * Round 21: the signed-in session ends on the server after this many more requests that carried it (null: it never ends). From then on
     * the cookie is refused like a stranger's (401 and a sign-in form on the signed-in pages) and every answer removes it (Max-Age=0), as
     * applications do when a session has run out.
     */
    expireSessionAfter(requests: number | null): void;
    close(): Promise<void>;
}

/** The signed-in area's cookie (round 20). Made-up values, long enough to be treated as secrets. */
export const FIXTURE_SESSION_COOKIE = "fixture_auth";
export const FIXTURE_SESSION_VALUE = "signed-in-secret-token-777";
/** A value a test keeps in the saved sign-in's local storage (never sent by the app; must never be stored by the platform either). */
export const FIXTURE_STORAGE_TOKEN = "local-storage-token-888abc";
export const FIXTURE_ACCOUNT_EMAIL = "ana@fixture.example";

/** An OpenAPI document (YAML) for the fixture: 11 operations, of which GET without required parameters: /api/items, /api/me, /api/orders, /account/payments/history, /admin/stats. */
export const FIXTURE_API_DOCUMENT = `openapi: 3.0.3
info:
  title: Fixture shop API
  version: "1.0"
paths:
  /api/items:
    get: {}
    post:
      requestBody:
        required: true
  /api/me:
    get: {}
  /api/orders:
    get:
      parameters:
        - name: page
          in: query
          required: false
    post: {}
  /api/orders/{id}:
    get: {}
    delete: {}
  /api/search:
    get:
      parameters:
        - $ref: "#/components/parameters/Query"
  /api/logout:
    get: {}
  /account/payments/history:
    get: {}
  /admin/stats:
    get: {}
components:
  parameters:
    Query:
      name: q
      in: query
      required: true
`;

const page = (title: string, body: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

function listen(server: http.Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
}

/**
 * Starts the application on 127.0.0.1:`port` and the outside server on localhost:`outsidePort` (a different host name, so it is out of
 * the application's scope even though both are this computer).
 */
export async function startSecurityFixture(port: number, outsidePort: number, opts: { pages?: number } = {}): Promise<SecurityFixture> {
    const requests: FixtureRequest[] = [];
    const outsideRequests: FixtureRequest[] = [];
    let delay = 0;
    let broken: string | null = null;
    let envFixed = false;
    /** Requests the session still answers signed in (null: no end). */
    let sessionLeft: number | null = null;
    const extraPages = opts.pages ?? 3;
    const outsideOrigin = `http://localhost:${outsidePort}`;

    const banners = { Server: "Apache/2.4.1 (Unix)", "X-Powered-By": "Express 4.17.1" };
    const html = (res: http.ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}) => {
        // A cookie removal set earlier (a session that ran out) is kept next to the page's own cookies.
        const removal = res.getHeader("set-cookie");
        if (removal && extra["set-cookie"]) extra = { ...extra, "set-cookie": [String(removal), ...[extra["set-cookie"]].flat()] };
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...banners, ...extra });
        res.end(body);
    };

    const app = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers: req.headers });
        const answer = () => {
            const p = url.pathname;
            const withSession = String(req.headers.cookie ?? "")
                .split(";")
                .some((c) => c.trim() === `${FIXTURE_SESSION_COOKIE}=${FIXTURE_SESSION_VALUE}`);
            // Round 21: a session that ran out is refused, and its cookie removed with every answer.
            if (withSession && sessionLeft !== null) sessionLeft--;
            const ended = withSession && sessionLeft !== null && sessionLeft < 0;
            const signedIn = withSession && !ended;
            if (ended) res.setHeader("set-cookie", `${FIXTURE_SESSION_COOKIE}=; Path=/; Max-Age=0`);
            const signInFirst = () => html(res, 401, page("Please sign in", `<form action="/login" method="post"><input name="username"><input name="password" type="password"><button>Sign in</button></form>`));
            if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
                // Anything that would change data: the tests assert this is never reached.
                res.writeHead(405, banners);
                return res.end("not allowed");
            }
            if (p === "/") {
                const more = Array.from({ length: extraPages }, (_, i) => `<a href="/page-${i + 1}">Page ${i + 1}</a>`).join(" ");
                return html(
                    res,
                    200,
                    page(
                        "Fixture shop",
                        `<nav><a href="/about">About</a> <a href="/products">Products</a> <a href="/uploads/">Uploads</a> <a href="/go-away">Partner</a>
                         <a href="http://10.0.0.5/internal">Intranet</a> <a href="/admin/billing">Billing</a> <a href="${outsideOrigin}/elsewhere">Elsewhere</a> ${more}${signedIn ? ` <a href="/account">My account</a>` : ""}</nav>
                         <form action="/login" method="post"><label>User <input name="username" type="text"></label>
                         <label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>
                         <script>
                           fetch("/api/items").then(function (r) { return r.json(); }).catch(function () {});
                           fetch("/api/track", { method: "POST", body: "{}" }).catch(function () {});
                         </script>`,
                    ),
                    { "set-cookie": ["sessionid=fake-session-value-123; Path=/", "theme=light; Path=/"] },
                );
            }
            if (p === "/about") return html(res, 200, page("About us", `<p>Contact sales@fixture.example for prices.</p><a href="/">Home</a>`));
            if (p === "/products") return html(res, 200, page("Products", `<ul><li><a href="/products/1">One</a></li></ul><a href="/">Home</a>`));
            if (p === "/products/1") return html(res, 200, page("Product one", `<a href="/products">Back</a>`));
            const m = /^\/page-(\d+)$/.exec(p);
            if (m && Number(m[1]) <= extraPages) return html(res, 200, page(`Page ${m[1]}`, `<a href="/">Home</a>`));
            if (p === "/uploads/" || p === "/uploads") {
                return html(res, 200, `<html><head><title>Index of /uploads</title></head><body><h1>Index of /uploads</h1><a href="/uploads/a.txt">a.txt</a></body></html>`);
            }
            if (p === "/.env" && !envFixed) {
                res.writeHead(200, { "content-type": "text/plain", ...banners });
                return res.end("APP_NAME=fixture\nDB_PASSWORD=fake-db-password-123\nAPI_TOKEN=fake0token0abcdef0123456789\n");
            }
            if (p === "/go-away") {
                res.writeHead(302, { location: `${outsideOrigin}/landing`, ...banners });
                return res.end();
            }
            if (p === "/admin/billing") return html(res, 200, page("Billing", "excluded area"));
            if (p === "/api/items") {
                const origin = String(req.headers.origin ?? "");
                res.writeHead(200, {
                    "content-type": "application/json",
                    ...banners,
                    ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {}),
                });
                return res.end(JSON.stringify([{ id: 1, name: "One" }]));
            }
            if (p === "/openapi.json") {
                res.writeHead(200, { "content-type": "application/json", ...banners });
                return res.end(JSON.stringify({ openapi: "3.0.0", info: { title: "Fixture", version: "1" }, paths: { "/api/items": { get: {} } } }));
            }
            // ── the signed-in area (round 20) ──
            if (p === "/logout" || p === "/session/end" || p === "/api/logout") {
                res.writeHead(200, { "content-type": "text/html", ...banners, "set-cookie": `${FIXTURE_SESSION_COOKIE}=; Path=/; Max-Age=0` });
                return res.end(page("Signed out", "You are signed out."));
            }
            if (p === "/account") {
                if (!signedIn) return signInFirst();
                return html(
                    res,
                    200,
                    page(
                        "Your account",
                        `<p>Signed in as ${FIXTURE_ACCOUNT_EMAIL}. Session reference: ${FIXTURE_SESSION_VALUE}</p>
                         <a href="/account/orders">Orders</a> <a href="/account/payments">Payments</a> <a href="/logout">Log out</a> <a href="/session/end">Sign out</a> <a href="/">Home</a>`,
                    ),
                    { "set-cookie": "prefs=compact; Path=/" },
                );
            }
            if (p === "/account/orders") return signedIn ? html(res, 200, page("Your orders", `<p>No orders yet.</p><a href="/account">Account</a>`)) : signInFirst();
            if (p.startsWith("/account/payments")) return signedIn ? html(res, 200, page("Payments", "sensitive area")) : signInFirst();
            if (p === "/api/me" || p === "/api/orders" || p === "/api/search") {
                if (!signedIn) {
                    res.writeHead(401, { "content-type": "application/json", ...banners });
                    return res.end(JSON.stringify({ error: "sign in first" }));
                }
                if (p === "/api/search" && !url.searchParams.get("q")) {
                    res.writeHead(400, { "content-type": "application/json", ...banners });
                    return res.end(JSON.stringify({ error: "q is required" }));
                }
                res.writeHead(200, { "content-type": "application/json", ...banners });
                return res.end(JSON.stringify(p === "/api/me" ? { name: "Ana", email: FIXTURE_ACCOUNT_EMAIL, session: FIXTURE_SESSION_VALUE } : []));
            }
            return html(res, 404, page("Not found", "404 not found"));
        };
        if (broken && url.pathname === broken) return req.socket.destroy();
        if (delay > 0 && !url.pathname.startsWith("/api/")) setTimeout(answer, delay);
        else answer();
    });

    const outside = http.createServer((req, res) => {
        outsideRequests.push({ method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers });
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page("Outside", "should never be reached"));
    });

    const appPort = await listen(app, port);
    await listen(outside, outsidePort);
    const sockets = new Set<import("node:net").Socket>();
    for (const s of [app, outside]) s.on("connection", (c) => (sockets.add(c), c.on("close", () => sockets.delete(c))));

    return {
        origin: `http://127.0.0.1:${appPort}`,
        port: appPort,
        requests,
        outsideRequests,
        outsideOrigin,
        setDelay: (ms) => (delay = ms),
        setBroken: (path) => (broken = path),
        fixEnv: () => (envFixed = true),
        expireSessionAfter: (n) => (sessionLeft = n),
        close: async () => {
            for (const c of sockets) c.destroy();
            await Promise.all([app, outside].map((s) => new Promise<void>((r) => s.close(() => r()))));
        },
    };
}
