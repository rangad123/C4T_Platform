/**
 * Routes that save through another route of this server (app.inject to POST /specs) pass the caller's own sign-in on, so a person
 * signed in with a session (cookie + CSRF token), not only the access key, can write a test as text and import Maestro flows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import type { FastifyRequest } from "fastify";
import { callerCredentials } from "../src/platform/auth/access.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

type App = Awaited<ReturnType<typeof buildServer>>;

/** Keeps the cookies the platform sets and echoes the CSRF cookie on changes, like the web page does. */
class Browser {
    jar = new Map<string, string>();
    constructor(private readonly app: App) {}
    async call(method: string, url: string, body?: unknown) {
        const cookie = [...this.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
        const csrf = this.jar.get("aitp_csrf");
        const res = await this.app.inject({
            method: method as "GET",
            url,
            headers: { host: "localhost:80", ...(cookie ? { cookie } : {}), ...(csrf && method !== "GET" ? { "x-csrf-token": csrf, origin: "http://localhost:80" } : {}) },
            ...(body !== undefined ? { payload: body as object } : {}),
        });
        const set = res.headers["set-cookie"];
        for (const c of Array.isArray(set) ? set : set ? [set] : []) {
            const [pair] = c.split(";");
            const i = pair!.indexOf("=");
            this.jar.set(pair!.slice(0, i), decodeURIComponent(pair!.slice(i + 1)));
        }
        return { status: res.statusCode, body: res.body && (res.body.startsWith("{") || res.body.startsWith("[")) ? JSON.parse(res.body) : res.body };
    }
}

let platform: Platform;
let app: App;
let dir: string;
let projectId = "";
const olga = () => browser;
let browser: Browser;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "inner-test-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    browser = new Browser(app);
    expect((await olga().call("POST", "/api/auth/setup", { email: "owner@example.com", name: "Olga", password: "a fine long password" })).status).toBe(201);
    projectId = (await olga().call("POST", "/api/projects", { name: "Signed in" })).body.id;
    const imp = await olga().call("POST", `/api/projects/${projectId}/specs`, { specs: [{ title: "Starter page opens", kind: "web", steps: [{ action: "navigate", url: "/" }] }], baseUrl: "http://127.0.0.1:6297", validate: false });
    expect(imp.status).toBe(202);
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a person signed in with a session", () => {
    it("writes a test as text", async () => {
        const r = await olga().call("POST", `/api/projects/${projectId}/dsl-tests`, { text: "Test: Products answer as a list\nKind: api\n\nSend a GET request to /api/products\nExpect the status to be 200\n" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(platform.repo.listTests(projectId).map((t) => t.title)).toContain("Products answer as a list");
    });

    it("imports a Maestro flow", async () => {
        const r = await olga().call("POST", `/api/projects/${projectId}/import/maestro`, { validate: false, files: [{ name: "search.yaml", content: "url: http://127.0.0.1:6297/start\n---\n- tapOn: Search\n- assertVisible: Results\n" }] });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
    });

    it("is still refused without the CSRF token, inner call or not", async () => {
        const cookie = [...browser.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
        const r = await app.inject({ method: "POST", url: `/api/projects/${projectId}/dsl-tests`, headers: { host: "localhost:80", cookie }, payload: { text: "Test: No token\nKind: api\n\nSend a GET request to /\n" } });
        expect(r.statusCode).toBe(403);
    });
});

describe("who is asking, passed on to the inner call", () => {
    it("passes the user-agent, and the caller's address as this server believes it, never the header as sent", () => {
        const req = { headers: { cookie: "c4t_access=t", "user-agent": "Browser/1.0", "x-forwarded-for": "198.51.100.7, 10.0.0.1", "x-real-ip": "1.2.3.4" }, ip: "203.0.113.9" } as unknown as FastifyRequest;
        expect(callerCredentials(req)).toEqual({ cookie: "c4t_access=t", "user-agent": "Browser/1.0", "x-forwarded-for": "203.0.113.9" });
    });

    it("behind a trusted proxy, the inner call sees the outer request's address, and a forged one stays untrusted", async () => {
        const key = "inner-proxy-key-0123456789";
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inner-proxy-"));
        const pl = bootstrap(loadConfig({ DATA_DIR: d, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "inner-test-secret-key-0123456789", API_KEY: key, PUBLIC_URL: "https://studio.example" }));
        const srv = await buildServer(pl);
        const seen: Array<{ ip: string; ua: unknown }> = [];
        srv.addHook("onRequest", (req, _reply, done) => {
            if (req.url.endsWith("/specs")) seen.push({ ip: req.ip, ua: req.headers["user-agent"] });
            done();
        });
        await srv.ready();
        try {
            const pid = pl.repo.createProject({ name: "Proxy shop" }).id as string;
            pl.repo.createApplication(pid, "http://127.0.0.1:6297", { ...DEFAULT_JOB_OPTIONS });
            const text = { text: "Test: Products answer\nKind: api\n\nSend a GET request to /api/products\nExpect the status to be 200\n" };
            // Through the proxy on this machine: the proxy's word for the visitor is believed, for the inner call too.
            const viaProxy = await srv.inject({ method: "POST", url: `/api/projects/${pid}/dsl-tests`, remoteAddress: "127.0.0.1", headers: { "x-api-key": key, "x-forwarded-for": "198.51.100.20", "user-agent": "Browser/2.0" }, payload: text });
            expect(viaProxy.statusCode, viaProxy.body).toBe(201);
            expect(seen.pop()).toEqual({ ip: "198.51.100.20", ua: "Browser/2.0" });
            // Straight from a visitor who writes their own header: not believed outside, and not believed by the inner call either.
            const direct = await srv.inject({ method: "POST", url: `/api/projects/${pid}/dsl-tests`, remoteAddress: "203.0.113.50", headers: { "x-api-key": key, "x-forwarded-for": "10.9.8.7", "user-agent": "Browser/3.0" }, payload: { text: text.text.replace("Products answer", "Products answer again") } });
            expect(direct.statusCode, direct.body).toBe(201);
            expect(seen.pop()).toEqual({ ip: "203.0.113.50", ua: "Browser/3.0" });
        } finally {
            await srv.close();
            pl.db.close();
            fs.rmSync(d, { recursive: true, force: true });
        }
    });
});
