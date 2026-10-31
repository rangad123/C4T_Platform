/**
 * Security Assessment through the company proxy (SECURITY_USE_PROXY, src/security/proxy.ts), against the local CONNECT proxy fixture
 * (tests/fixtures/connect-proxy.ts, which maps every name to 127.0.0.1, so a name such as shop.test only "exists" behind it) and local
 * apps. Nothing leaves this computer: the names are resolved by a test resolver for the platform-side check, and by the proxy fixture.
 *
 * Proves: plain http goes to the proxy in absolute form and https through a CONNECT tunnel (the TLS session is the site's: a test-only
 * company certificate behind the tunnel); the scope guard still checks the DNS answers on the platform first (a private answer is
 * refused before anything reaches the proxy); NO_PROXY and this computer go direct; the proxy's password is sent but never shown; a 407,
 * a 403 and an unreachable proxy are plain sentences; a proxy on a private address is refused unless allowed, cloud metadata always; the
 * proxy itself is never a target; the scan's TLS handshake goes through the tunnel; an assessment whose proxy may not be used fails at
 * start with the reason, before any request.
 *
 * Ports 7171-7179 (OPS range). Run under the lock (it starts servers):
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ops-proxy.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { guardFor } from "../src/security/assessment/guard.js";
import { AssessmentLoop } from "../src/security/assessment/runner.js";
import { observeTls } from "../src/security/assessment/scan.js";
import { RefusedError } from "../src/security/assessment/types.js";
import type { SecurityApplication } from "../src/security/contract.js";
import { ProxyError, SecurityProxy, securityProxyFor } from "../src/security/proxy.js";
import { createScopeSession, guardedFetch, ScopeError, type Resolver } from "../src/security/scope.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { ConnectProxy, tlsFront } from "./fixtures/connect-proxy.js";
import { companyTls, removeMintedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";

const PROXY_PORT = 7171;
const APP_PORT = 7172;
const TLS_PORT = 7173;
const AUTH_PROXY_PORT = 7174;
const REFUSING_PROXY_PORT = 7175;
const DEAD_PORT = 7176; // nothing listens here
const PASSWORD = "Pr0xy-S3cret-ops-7174";

const COMPANY = companyTls();
if (!COMPANY) console.warn(TLS_SKIP_REASON);
const appHits: Array<{ path: string; host: string }> = [];
let appServer: http.Server;
let front: { stop(): Promise<void> };
let proxy: ConnectProxy;
let authProxy: ConnectProxy;
let refusingProxy: ConnectProxy;
const dirs: string[] = [];

beforeAll(async () => {
    appServer = http.createServer((req, res) => {
        appHits.push({ path: req.url ?? "", host: String(req.headers.host ?? "") });
        res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
        res.end(`<html><body>app ${req.url}</body></html>`);
    });
    await new Promise<void>((r) => appServer.listen(APP_PORT, "127.0.0.1", r));
    if (!COMPANY) return;
    front = await tlsFront(TLS_PORT, APP_PORT, {
        cert: fs.readFileSync(COMPANY.cert, "utf8") + fs.readFileSync(COMPANY.ca, "utf8"),
        key: fs.readFileSync(COMPANY.key, "utf8"),
    });
    proxy = new ConnectProxy(PROXY_PORT);
    authProxy = new ConnectProxy(AUTH_PROXY_PORT, { user: "svc", password: PASSWORD });
    refusingProxy = new ConnectProxy(REFUSING_PROXY_PORT, { refuse: ["blocked.test"] });
    await Promise.all([proxy.start(), authProxy.start(), refusingProxy.start()]);
});
afterAll(async () => {
    await Promise.all([proxy?.stop(), authProxy?.stop(), refusingProxy?.stop(), front?.stop()]);
    removeMintedTls();
    await new Promise((r) => appServer?.close(r));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** The platform-side DNS answers (the proxy fixture resolves every name to 127.0.0.1 on its side). */
const dns =
    (map: Record<string, string>): Resolver =>
    async (host) => {
        const a = map[host];
        if (!a) throw new Error("ENOTFOUND");
        return [{ address: a, family: 4 }];
    };
const LOCAL = dns({ "shop.test": "127.0.0.1", "secure.test": "127.0.0.1", "direct.test": "127.0.0.1", "blocked.test": "127.0.0.1", "proxy.corp.test": "127.0.0.1", "meta.corp.test": "169.254.169.254" });

const app = (targetUrl: string, over: Partial<SecurityApplication> = {}): SecurityApplication => ({
    id: "a1",
    projectId: "p1",
    name: "Shop",
    targetUrl,
    environment: "staging",
    scope: [],
    excludedPaths: [],
    maxRequestsPerSecond: 10,
    apiSpecUrl: null,
    notes: null,
    createdAt: "",
    updatedAt: "",
    ...over,
});

const proxyOf = (env: { https?: string; http?: string; noProxy?: string }, allowPrivateProxy = true, resolver: Resolver = LOCAL) => new SecurityProxy(env, { allowPrivateProxy, resolver });
const session = (a: SecurityApplication, p: SecurityProxy | undefined, allowPrivate = true) => createScopeSession(a, { allowPrivate, resolver: LOCAL, ...(p ? { proxy: p } : {}), timeoutMs: 5_000 });

describe.skipIf(!COMPANY)("settings", () => {
    it("is off by default; only an explicit on turns it on; a private proxy needs its own switch", () => {
        expect(securitySettings({})).toMatchObject({ useProxy: false, allowPrivateProxy: false });
        expect(securitySettings({ SECURITY_USE_PROXY: "on", SECURITY_PROXY_ALLOW_PRIVATE: "true" })).toMatchObject({ useProxy: true, allowPrivateProxy: true });
        expect(securitySettings({ SECURITY_USE_PROXY: "maybe" }).useProxy).toBe(false);
        // Off: no proxy object at all, so requests connect directly to the checked address exactly as before.
        expect(securityProxyFor({ useProxy: false }, { HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}` })).toBeUndefined();
        expect(securityProxyFor({ useProxy: true }, { HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}` })?.display).toEqual([`http://127.0.0.1:${PROXY_PORT}`]);
    });
});

describe.skipIf(!COMPANY)("requests through the proxy", () => {
    it("sends a plain-http address to the proxy in absolute form; the site's answer comes back", async () => {
        const before = proxy.hits.length;
        const s = session(app(`http://shop.test:${APP_PORT}/`), proxyOf({ http: `http://127.0.0.1:${PROXY_PORT}` }));
        const r = await guardedFetch(s, `http://shop.test:${APP_PORT}/products?x=1`);
        expect(r.status).toBe(200);
        expect(r.body.toString()).toContain("app /products?x=1");
        expect(proxy.hits.slice(before)).toEqual([{ method: "GET", target: `http://shop.test:${APP_PORT}/products?x=1`, auth: "" }]);
        // The site saw its own name as Host (the proxy fixture forwards the headers it got).
        expect(appHits.at(-1)).toEqual({ path: "/products?x=1", host: `shop.test:${APP_PORT}` });
    });

    it("tunnels an https address with CONNECT: the certificate seen is the site's own", async () => {
        const before = proxy.hits.length;
        const s = session(app(`https://secure.test:${TLS_PORT}/`), proxyOf({ https: `http://127.0.0.1:${PROXY_PORT}` }));
        const r = await guardedFetch(s, `https://secure.test:${TLS_PORT}/account`, { allowInvalidCertificate: true });
        expect(r.status).toBe(200);
        expect(r.body.toString()).toContain("app /account");
        expect(proxy.hits.slice(before)).toEqual([{ method: "CONNECT", target: `secure.test:${TLS_PORT}`, auth: "" }]);
        // The test-only company certificate is not trusted here: the TLS session is end to end with the site, not with the proxy.
        expect(r.tls).toMatchObject({ authorized: false });
        expect(r.tls?.authorizationError).toBeTruthy();
        // Without allowing an invalid certificate the request fails, as it would directly.
        await expect(guardedFetch(s, `https://secure.test:${TLS_PORT}/account`)).rejects.toThrow();
    });

    it("still checks the DNS answers on the platform first: a private answer is refused and never reaches the proxy", async () => {
        const before = proxy.hits.length;
        const s = session(app(`http://shop.test:${APP_PORT}/`), proxyOf({ http: `http://127.0.0.1:${PROXY_PORT}` }), false);
        const e = await guardedFetch(s, `http://shop.test:${APP_PORT}/`).catch((x) => x);
        expect(e).toBeInstanceOf(ScopeError);
        expect((e as ScopeError).code).toBe("blocked-address");
        // Out of scope and excluded addresses are refused the same way.
        const s2 = session(app(`http://shop.test:${APP_PORT}/`, { excludedPaths: ["/admin"] }), proxyOf({ http: `http://127.0.0.1:${PROXY_PORT}` }));
        await expect(guardedFetch(s2, `http://shop.test:${APP_PORT}/admin/users`)).rejects.toMatchObject({ code: "excluded-path" });
        await expect(guardedFetch(s2, `http://other.test:${APP_PORT}/`)).rejects.toMatchObject({ code: "out-of-scope" });
        expect(proxy.hits.length).toBe(before);
    });

    it("reaches NO_PROXY names and this computer directly", async () => {
        const before = proxy.hits.length;
        const p = proxyOf({ http: `http://127.0.0.1:${PROXY_PORT}`, noProxy: "direct.test" });
        const s = session(app(`http://direct.test:${APP_PORT}/`, { scope: [`127.0.0.1:${APP_PORT}`] }), p);
        expect((await guardedFetch(s, `http://direct.test:${APP_PORT}/d`)).body.toString()).toContain("app /d");
        expect((await guardedFetch(s, `http://127.0.0.1:${APP_PORT}/local`)).body.toString()).toContain("app /local");
        expect(proxy.hits.length).toBe(before);
    });

    it("never assesses the proxy itself", async () => {
        const p = proxyOf({ http: `http://proxy.corp.test:${PROXY_PORT}` });
        await p.ready();
        const before = proxy.hits.length;
        // Its address and port, and its name on any port.
        const s = session(app(`http://127.0.0.1:${PROXY_PORT}/`, { scope: [`proxy.corp.test:${APP_PORT}`] }), p);
        const e = await guardedFetch(s, `http://127.0.0.1:${PROXY_PORT}/`).catch((x) => x);
        expect(e).toMatchObject({ code: "proxy" });
        expect(String(e.message)).toMatch(/is the company proxy itself/);
        await expect(guardedFetch(s, `http://proxy.corp.test:${APP_PORT}/`)).rejects.toMatchObject({ code: "proxy" });
        expect(proxy.hits.length).toBe(before);
    });
});

describe.skipIf(!COMPANY)("the proxy's own answers, in plain words", () => {
    it("sends the password as Proxy-Authorization and never shows it; a missing or wrong one is a plain 407 sentence", async () => {
        const good = proxyOf({ https: `http://svc:${PASSWORD}@127.0.0.1:${AUTH_PROXY_PORT}`, http: `http://svc:${PASSWORD}@127.0.0.1:${AUTH_PROXY_PORT}` });
        expect(good.display.join(" ")).not.toContain(PASSWORD);
        const s = session(app(`https://secure.test:${TLS_PORT}/`, { scope: [`shop.test:${APP_PORT}`] }), good);
        expect((await guardedFetch(s, `https://secure.test:${TLS_PORT}/`, { allowInvalidCertificate: true })).status).toBe(200);
        expect((await guardedFetch(s, `http://shop.test:${APP_PORT}/`)).status).toBe(200);
        const expected = `Basic ${Buffer.from(`svc:${PASSWORD}`).toString("base64")}`;
        expect(authProxy.hits.slice(-2).map((h) => h.auth)).toEqual([expected, expected]);
        // The site never receives the proxy's sign-in.
        expect(JSON.stringify(appHits)).not.toContain(expected);

        const none = session(app(`https://secure.test:${TLS_PORT}/`, { scope: [`shop.test:${APP_PORT}`] }), proxyOf({ https: `http://127.0.0.1:${AUTH_PROXY_PORT}`, http: `http://127.0.0.1:${AUTH_PROXY_PORT}` }));
        const e1 = await guardedFetch(none, `https://secure.test:${TLS_PORT}/`, { allowInvalidCertificate: true }).catch((x) => x);
        expect(e1).toBeInstanceOf(ProxyError);
        expect(e1.message).toMatch(/asks for a user name and password \(HTTP 407\)/);
        const e2 = await guardedFetch(none, `http://shop.test:${APP_PORT}/`).catch((x) => x);
        expect(e2.message).toMatch(/asks for a user name and password \(HTTP 407\)/);

        const wrong = session(app(`https://secure.test:${TLS_PORT}/`), proxyOf({ https: `http://svc:wrong-${PASSWORD}@127.0.0.1:${AUTH_PROXY_PORT}` }));
        const e3 = await guardedFetch(wrong, `https://secure.test:${TLS_PORT}/`, { allowInvalidCertificate: true }).catch((x) => x);
        expect(e3.message).toMatch(/did not accept the user name and password \(HTTP 407\)/);
        for (const e of [e1, e2, e3]) expect(String(e.message)).not.toContain(PASSWORD);
    });

    it("a refused address (403) and an unreachable proxy are plain sentences", async () => {
        const s = session(app(`https://blocked.test:${TLS_PORT}/`), proxyOf({ https: `http://127.0.0.1:${REFUSING_PROXY_PORT}` }));
        await expect(guardedFetch(s, `https://blocked.test:${TLS_PORT}/`, { allowInvalidCertificate: true })).rejects.toThrow(/refused the connection to blocked\.test:7173 \(HTTP 403\)/);
        const dead = session(app(`https://secure.test:${TLS_PORT}/`), proxyOf({ https: `http://127.0.0.1:${DEAD_PORT}` }));
        await expect(guardedFetch(dead, `https://secure.test:${TLS_PORT}/`, { allowInvalidCertificate: true })).rejects.toThrow(/could not be reached \(ECONNREFUSED\)/);
    });
});

describe.skipIf(!COMPANY)("which proxies may be used", () => {
    it("refuses a proxy on a private address unless allowed, and a cloud metadata proxy always", async () => {
        await expect(proxyOf({ https: `http://127.0.0.1:${PROXY_PORT}` }, false).ready()).rejects.toThrow(/is on a loopback address .*SECURITY_PROXY_ALLOW_PRIVATE=true/);
        await expect(proxyOf({ https: `http://proxy.corp.test:${PROXY_PORT}` }, false).ready()).rejects.toThrow(/SECURITY_PROXY_ALLOW_PRIVATE/);
        await expect(proxyOf({ https: "http://169.254.169.254:80" }, true).ready()).rejects.toThrow(/cloud metadata/);
        await expect(proxyOf({ https: "http://meta.corp.test:3128" }, true).ready()).rejects.toThrow(/cloud metadata/);
        await expect(proxyOf({ https: "http://metadata.google.internal:80" }, true).ready()).rejects.toThrow(/cloud metadata/);
        await expect(proxyOf({ https: `http://127.0.0.1:${PROXY_PORT}` }, true).ready()).resolves.toBeUndefined();
    });

    it("refuses when it is switched on without a proxy, or with one it cannot read", async () => {
        await expect(new SecurityProxy({}).ready()).rejects.toThrow(/SECURITY_USE_PROXY is on, but no company proxy is set/);
        await expect(new SecurityProxy({ https: "socks5://127.0.0.1:1080" }).ready()).rejects.toThrow(/HTTPS_PROXY could not be used for assessments: SOCKS proxies are not supported/);
    });
});

describe.skipIf(!COMPANY)("in the assessment", () => {
    it("the scan's one TLS handshake goes through the tunnel", async () => {
        const settings = { ...securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" }), useProxy: true };
        const before = proxy.hits.length;
        const ctl = new AbortController();
        const guard = guardFor(app(`https://secure.test:${TLS_PORT}/`), settings, ctl.signal, { resolver: LOCAL, proxy: proxyOf({ https: `http://127.0.0.1:${PROXY_PORT}` }) });
        await guard.ready?.();
        const obs = await observeTls(guard, `https://secure.test:${TLS_PORT}/`, ctl.signal);
        expect(obs.authError?.code).toBeTruthy(); // the test-only certificate, as received from the site through the tunnel
        expect(proxy.hits.slice(before)).toEqual([{ method: "CONNECT", target: `secure.test:${TLS_PORT}`, auth: "" }]);
        // A refused address is refused before any tunnel is asked for.
        await expect(guard.tunnel!(`https://elsewhere.test:${TLS_PORT}/`, ctl.signal)).rejects.toBeInstanceOf(RefusedError);
        expect(proxy.hits.length).toBe(before + 1);
    });

    it("an assessment whose proxy may not be used fails at start with the reason, before any request", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-proxy-"));
        dirs.push(dir);
        const db = new Db(path.join(dir, "t.db"));
        try {
            const repo = new Repo(db, new SecretBox(dir));
            const projectId = repo.createProject({ name: "Client A" }).id;
            const store = new SecurityStore(db);
            const a = store.createApplication(projectId, { name: "Shop", targetUrl: `http://shop.test:${APP_PORT}/`, environment: "staging" });
            const auth = store.addAuthorization(a.id, { basis: "owner", approverName: "Olga", statement: "I confirm.", confirmedByName: "Olga" });
            const run = store.createAssessment({ applicationId: a.id, authorizationId: auth.id, startedBy: "Olga" });
            const settings = { ...securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" }), useProxy: true, allowPrivateProxy: false };
            const before = { proxy: proxy.hits.length, app: appHits.length };
            const loop = new AssessmentLoop({
                db,
                settings,
                headless: true,
                guardFor: (x, signal) => guardFor(x, settings, signal, { resolver: LOCAL, proxy: proxyOf({ http: `http://127.0.0.1:${PROXY_PORT}` }, false) }),
                launch: async () => {
                    throw new Error("the browser must not be started");
                },
                log: () => undefined,
            });
            const claimed = store.claimAssessment(loop.leaseOwner, 60_000)!;
            expect(claimed.id).toBe(run.id);
            await loop.runOne(run.id);
            const done = store.getAssessment(run.id)!;
            expect(done.state).toBe("FAILED");
            expect(done.error).toMatch(/The company proxy http:\/\/127\.0\.0\.1:7171 is on a loopback address/);
            expect({ proxy: proxy.hits.length, app: appHits.length }).toEqual(before);
        } finally {
            db.close();
        }
    });
});
