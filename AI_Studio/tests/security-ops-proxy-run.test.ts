/**
 * A real passive assessment through the company proxy (SECURITY_USE_PROXY): a real Chromium, the real assessment loop, the local
 * security fixture app (tests/fixtures/security-fixture-app.ts) reached only by a name the proxy fixture knows (shop.test), and the
 * local CONNECT proxy (tests/fixtures/connect-proxy.ts). Proves that every request the assessment sent reached the app through the
 * proxy, the deliberate problems are still found, and nothing out of scope reached the proxy or the outside server.
 *
 * Ports 7180-7182 (OPS range). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-ops-proxy-run.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { FINISHED_STATES } from "../src/security/contract.js";
import { guardFor } from "../src/security/assessment/guard.js";
import { AssessmentLoop } from "../src/security/assessment/runner.js";
import { SecurityProxy } from "../src/security/proxy.js";
import { loopDeps } from "../src/security/routes/assessments.js";
import type { Resolver } from "../src/security/scope.js";
import { securitySettings } from "../src/security/settings.js";
import { SecurityStore } from "../src/security/store.js";
import { ConnectProxy } from "./fixtures/connect-proxy.js";
import { startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

const APP_PORT = 7180;
const OUTSIDE_PORT = 7181;
const PROXY_PORT = 7182;

let dir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let fixture: SecurityFixture;
let proxy: ConnectProxy;
const launched: Browser[] = [];

beforeAll(async () => {
    fixture = await startSecurityFixture(APP_PORT, OUTSIDE_PORT);
    proxy = new ConnectProxy(PROXY_PORT);
    await proxy.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-proxyrun-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECURITY_ALLOW_PRIVATE_TARGETS: "true" }));
    server = await buildServer(platform);
}, 60_000);
afterAll(async () => {
    for (const b of launched) await b.close().catch(() => undefined);
    await server?.close();
    platform?.db.close?.();
    await proxy?.stop();
    await fixture?.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const api = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const r = await server.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}) });
    return { status: r.statusCode, json: r.json() as any };
};

describe("a passive assessment through the company proxy", () => {
    it("sends every request through the proxy and still finds the problems", async () => {
        const store = new SecurityStore(platform.db);
        const projectId = platform.repo.createProject({ name: "Proxy client" }).id as string;
        const created = await api("POST", `/api/v1/security/projects/${projectId}/applications`, { name: "Shop behind the proxy", targetUrl: `http://shop.test:${APP_PORT}/`, environment: "staging", excludedPaths: ["/admin"], maxRequestsPerSecond: 10 });
        expect(created.status, JSON.stringify(created.json)).toBe(201);
        const appId = created.json.application.id as string;
        expect((await api("POST", `/api/v1/security/applications/${appId}/authorizations`, { basis: "owner", approverName: "Test Owner", confirm: true })).status).toBe(201);
        const started = await api("POST", `/api/v1/security/applications/${appId}/assessments`, {});
        expect(started.status).toBe(201);
        const id = started.json.assessment.id as string;

        // The platform's own check resolves shop.test to this computer (allowed here by SECURITY_ALLOW_PRIVATE_TARGETS); the connection
        // itself goes to the proxy, which is the only one that can reach the name.
        const resolver: Resolver = async (host) => {
            if (host === "shop.test") return [{ address: "127.0.0.1", family: 4 }];
            throw new Error("ENOTFOUND");
        };
        const settings = { ...securitySettings(platform.config), useProxy: true, allowPrivateProxy: true };
        const loop = new AssessmentLoop(
            {
                ...loopDeps({ p: platform, settings }),
                guardFor: (app, signal, signIn) => guardFor(app, settings, signal, { resolver, proxy: new SecurityProxy({ http: proxy.url, https: proxy.url }, { allowPrivateProxy: true }) }, signIn),
                limits: { maxPages: 8 },
                launch: async () => {
                    const b = await launchChromium(true);
                    launched.push(b);
                    return b;
                },
            },
            100,
        );
        loop.start();
        let done;
        try {
            const end = Date.now() + 150_000;
            for (;;) {
                const a = store.getAssessment(id)!;
                if (FINISHED_STATES.includes(a.state)) {
                    done = a;
                    break;
                }
                if (Date.now() > end) throw new Error("timed out waiting for the assessment");
                await new Promise((r) => setTimeout(r, 200));
            }
        } finally {
            await loop.stop();
        }
        expect(["COMPLETED", "PARTIALLY_COMPLETED"], `${done.state}: ${done.error}`).toContain(done.state);
        expect(done.coverage!.pagesSeen).toBeGreaterThan(1);

        // Every request the app received came through the proxy, in absolute form to the name only the proxy knows.
        expect(fixture.requests.length).toBeGreaterThan(5);
        const viaProxy = proxy.hits.filter((h) => h.target.startsWith(`http://shop.test:${APP_PORT}/`)).map((h) => `${h.method} ${new URL(h.target).pathname}${new URL(h.target).search}`);
        const atApp = fixture.requests.map((r) => `${r.method} ${r.path}`);
        expect(viaProxy.sort()).toEqual(atApp.sort());
        expect(proxy.hits.every((h) => h.target.startsWith(`http://shop.test:${APP_PORT}/`))).toBe(true);
        expect(fixture.requests.every((r) => r.headers.host === `shop.test:${APP_PORT}`)).toBe(true);
        // Nothing out of scope or excluded reached the proxy or the outside server; only reads were sent.
        expect(fixture.outsideRequests).toEqual([]);
        expect(atApp.some((r) => r.includes("/admin"))).toBe(false);
        expect(fixture.requests.every((r) => ["GET", "HEAD", "OPTIONS"].includes(r.method))).toBe(true);

        // The deliberate problems are found as usual.
        const findings = store.listFindings({ projectId });
        const categories = new Set(findings.map((f) => f.category));
        expect(categories.has("headers")).toBe(true);
        expect(categories.has("exposed-files")).toBe(true);
    });
});
