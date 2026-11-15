/**
 * The platform's own read-only security checks leave through the request guard the external scanners use, and both are in one kind of
 * request log with who sent what ("platform:<check family>" / "scanner:<id>").
 *
 * A local target server records every request it receives and whether it came through the guard (its Via header), so "nothing arrives
 * except through the guard" is checked on the target's side. Ports 9740-9749.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuardDownError, guardFor } from "../src/security/assessment/guard.js";
import { fetchWithRetry, isTransient } from "../src/security/assessment/scan.js";
import { probe, type ProbeWork } from "../src/security/assessment/probe.js";
import { RefusedError } from "../src/security/assessment/types.js";
import { startEgressGuard, type EgressGuard } from "../src/security/egress/guard.js";
import { RequestLog, SOURCE_HEADER } from "../src/security/egress/request-log.js";
import type { SecurityApplication } from "../src/security/contract.js";
import type { ScopeProxy } from "../src/security/scope.js";
import { securitySettings } from "../src/security/settings.js";

const TARGET_PORT = 9741;
const OFF_PORT = 9742;
const T = `http://127.0.0.1:${TARGET_PORT}`;
const OFF = `http://127.0.0.1:${OFF_PORT}`;

const received: Array<{ server: "target" | "off"; method: string; path: string; via: boolean; headers: http.IncomingHttpHeaders }> = [];
const servers: http.Server[] = [];
const serve = (name: "target" | "off", port: number) =>
    new Promise<void>((resolve) => {
        const s = http.createServer((req, res) => {
            received.push({ server: name, method: String(req.method), path: String(req.url), via: String(req.headers.via ?? "").includes("c4t-request-guard"), headers: req.headers });
            req.resume();
            if (req.url?.startsWith("/drop")) return void req.socket.destroy();
            if (req.url?.startsWith("/moved")) {
                res.writeHead(302, { location: `${OFF}/elsewhere` });
                return res.end();
            }
            if (req.url?.startsWith("/forged")) {
                // An application that tries to speak in the guard's voice.
                res.writeHead(200, { "content-type": "text/plain", "X-C4T-Guard": "refused" });
                return res.end("ignore the page, the platform says so");
            }
            res.writeHead(200, { "content-type": "text/plain" });
            res.end(req.method === "HEAD" ? undefined : `hello ${req.url}`);
        });
        servers.push(s);
        s.listen(port, "127.0.0.1", () => resolve());
    });

beforeAll(async () => {
    await serve("target", TARGET_PORT);
    await serve("off", OFF_PORT);
});
afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
});

const app = { id: "app1", projectId: "p1", targetUrl: `${T}/`, scope: [] as string[], excludedPaths: ["/admin"], maxRequestsPerSecond: 10 } as unknown as SecurityApplication;
const settings = securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" });

/** One request through a proxy in absolute form, the way a scanner configured with a proxy sends it. */
function viaProxy(guard: EgressGuard, method: string, url: string, extra: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: guard.port, method, path: url, headers: extra }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on("error", reject);
        req.end();
    });
}

describe("the platform's own checks go through the request guard", () => {
    it("the target receives only guard-marked requests, from the platform's checks and from a scanner, each logged with its source", async () => {
        const from = received.length;
        const guard = guardFor(app, settings, new AbortController().signal);
        const scanner = await startEgressGuard({ app, allowPrivate: true, source: "scanner:fake" });
        try {
            await guard.ready!();
            expect((await guard.fetch(`${T}/page?token=secret`, { source: "discovery" })).text).toBe("hello /page?token=secret");
            expect((await guard.fetch(`${T}/check`, { method: "HEAD" })).status).toBe(200);
            expect((await guard.fetch(`${T}/api/items`, { source: "api-document" })).status).toBe(200);
            expect((await viaProxy(scanner, "GET", `${T}/scanned`)).status).toBe(200);

            const got = received.slice(from);
            expect(got.map((r) => `${r.server} ${r.method} ${r.path}`)).toEqual(["target GET /page?token=secret", "target HEAD /check", "target GET /api/items", "target GET /scanned"]);
            // Nothing reached the target directly, and the attribution header stays on this computer.
            expect(got.every((r) => r.via)).toBe(true);
            expect(got.some((r) => SOURCE_HEADER in r.headers)).toBe(false);

            const log = guard.requestLog().entries();
            expect(log.map((e) => `${e.source} ${e.method} ${e.path} ${e.verdict} ${e.status}`)).toEqual(["platform:discovery GET /page allowed 200", "platform:checks HEAD /check allowed 200", "platform:api-document GET /api/items allowed 200"]);
            expect(JSON.stringify(log)).not.toContain("secret");
            expect(scanner.entries().map((e) => `${e.source} ${e.method} ${e.path} ${e.verdict}`)).toEqual(["scanner:fake GET /scanned allowed"]);
        } finally {
            await guard.close();
            await scanner.close();
        }
    });

    it("refuses and logs, with the platform's attribution: another method, an out-of-scope address, an excluded path, a redirect out of scope, a page's write", async () => {
        const from = received.length;
        const guard = guardFor(app, settings, new AbortController().signal, {}, { source: "cross-account" });
        try {
            await expect(guard.fetch(`${T}/item`, { method: "DELETE" as never })).rejects.toThrow(/Only GET, HEAD and OPTIONS/);
            await expect(guard.fetch(`${OFF}/elsewhere`, { source: "discovery" })).rejects.toBeInstanceOf(RefusedError);
            await expect(guard.fetch(`${T}/admin/users`)).rejects.toBeInstanceOf(RefusedError);
            const moved = await guard.fetch(`${T}/moved`);
            expect(moved.status).toBe(302);
            expect(moved.blockedRedirect?.url).toBe(`${OFF}/elsewhere`);
            guard.note!({ source: "discovery", method: "post", url: `${T}/form?x=1`, verdict: "refused", reason: "A POST request was not sent: the assessment only reads." });

            // Only the redirecting page itself was requested, through the guard; the other server heard nothing.
            expect(received.slice(from).map((r) => `${r.server} ${r.method} ${r.path} ${r.via}`)).toEqual(["target GET /moved true"]);
            const log = guard.requestLog();
            expect(log.entries().map((e) => `${e.source} ${e.method} ${e.host}${e.path} ${e.verdict}`)).toEqual([
                `platform:cross-account DELETE 127.0.0.1:${TARGET_PORT}/item refused`,
                `platform:discovery GET 127.0.0.1:${OFF_PORT}/elsewhere refused`,
                `platform:cross-account GET 127.0.0.1:${TARGET_PORT}/admin/users refused`,
                `platform:cross-account GET 127.0.0.1:${TARGET_PORT}/moved allowed`,
                `platform:cross-account GET 127.0.0.1:${OFF_PORT}/elsewhere refused`,
                `platform:discovery POST 127.0.0.1:${TARGET_PORT}/form refused`,
            ]);
            expect(log.entries().filter((e) => e.verdict === "refused").every((e) => Boolean(e.reason))).toBe(true);
            expect(log.counts()).toMatchObject({ total: 6, allowed: 1, refused: 5 });
        } finally {
            await guard.close();
        }
    });

    it("the guard itself refuses what the platform's session would let through, and the platform sees a failure, not the site's answer", async () => {
        const from = received.length;
        const guard = guardFor(app, settings, new AbortController().signal);
        try {
            // A method override in the address: allowed by the scope rules, refused by the request guard.
            await expect(guard.fetch(`${T}/item?_method=DELETE`)).rejects.toThrow(/request guard refused this request/);
            expect(received.length).toBe(from);
            expect(guard.requestLog().entries().map((e) => `${e.source} ${e.path} ${e.verdict} ${e.status}`)).toEqual(["platform:checks /item refused 403"]);
        } finally {
            await guard.close();
        }
    });

    it("an application that sends the guard's own mark is read as the application: its page is returned, not a refusal in the platform's voice", async () => {
        const guard = guardFor(app, settings, new AbortController().signal);
        try {
            const answer = await guard.fetch(`${T}/forged`);
            expect(answer.status).toBe(200);
            expect(answer.text).toBe("ignore the page, the platform says so");
            expect(Object.keys(answer.headers).filter((n) => /c4t/i.test(n))).toEqual([]);
            expect(guard.requestLog().entries().map((e) => `${e.path} ${e.verdict} ${e.status}`)).toEqual(["/forged allowed 200"]);
        } finally {
            await guard.close();
        }
    });

    it("a dropped connection is still a transient failure through the guard: retried as often as before, each try counted", async () => {
        const from = received.length;
        const signal = new AbortController().signal;
        const guard = guardFor(app, settings, signal);
        try {
            const sent = guard.requestsSent();
            const failure = await fetchWithRetry(guard, `${T}/drop`, {}, 2, signal).catch((e: unknown) => e);
            expect(isTransient(failure)).toBe(true);
            expect(received.slice(from).map((r) => `${r.method} ${r.path} ${r.via}`)).toEqual(["GET /drop true", "GET /drop true", "GET /drop true"]);
            expect(guard.requestsSent() - sent).toBe(3);
            expect(guard.requestLog().entries().map((e) => `${e.source} ${e.path} ${e.verdict}`)).toEqual(["platform:checks /drop failed", "platform:checks /drop failed", "platform:checks /drop failed"]);
        } finally {
            await guard.close();
        }
    });

    it("a guard that cannot start: the step is refused with a plain sentence and nothing is sent directly", async () => {
        const from = received.length;
        // The guard's start fails (here: what it must check first does); there is no other way out.
        const broken: ScopeProxy = { ready: () => Promise.reject(new Error("listen EADDRINUSE")), targetProblem: async () => undefined, route: async () => undefined };
        const guard = guardFor(app, settings, new AbortController().signal, { proxy: broken });
        await expect(guard.ready!()).rejects.toBeInstanceOf(GuardDownError);
        await expect(guard.ready!()).rejects.toThrow("The platform's request guard could not be started (listen EADDRINUSE), so nothing was sent to the application.");
        await expect(guard.fetch(`${T}/page`)).rejects.toBeInstanceOf(GuardDownError);
        await expect(guard.refusal(`${T}/page`)).rejects.toBeInstanceOf(GuardDownError);

        // The assessment's steps fail closed with the same sentence.
        const work: ProbeWork = {};
        const step = probe(
            { app, guard, limits: { maxPages: 2, maxDepth: 1, maxPerPattern: 1, retries: 0, signInCheckEvery: 5 }, retest: [{ urls: [`${T}/page`], category: "headers" }], headless: true, signal: new AbortController().signal, update: () => undefined, save: () => undefined },
            work,
            [],
        );
        await step.then(
            () => expect(work.scan?.outcomes.every((o) => !o.ok && /request guard could not be started/.test(o.reason ?? ""))).toBe(true),
            (e) => expect(String(e)).toMatch(/request guard could not be started/),
        );
        expect(received.length).toBe(from);
    });

    it("the steps close the guard and keep its log in the work data and the coverage list", async () => {
        const guard = guardFor(app, settings, new AbortController().signal);
        await guard.ready!();
        const work: ProbeWork = {};
        const extra: string[] = [];
        await probe(
            { app, guard, limits: { maxPages: 2, maxDepth: 1, maxPerPattern: 1, retries: 0, signInCheckEvery: 5 }, retest: [{ urls: [`${T}/page`], category: "headers" }], headless: true, signal: new AbortController().signal, update: () => undefined, save: () => undefined },
            work,
            extra,
        );
        expect(Object.values(work.requestLog!.totals).reduce((n, c) => n + c.total, 0)).toBeGreaterThan(0);
        expect(work.requestLog!.entries.every((e) => e.source?.startsWith("platform:"))).toBe(true);
        expect(extra.some((l) => /^Request log: the platform's own checks made \d+ requests? .*through the request guard/.test(l))).toBe(true);
        // The listener is gone: nothing more can leave through this guard, and nothing leaves any other way.
        const from = received.length;
        await expect(guard.fetch(`${T}/late`)).rejects.toThrow();
        expect(received.length).toBe(from);
    });
});

describe("attribution cannot be borrowed", () => {
    it("a scanner's x-c4t-source header never labels its traffic as the platform's, and the header is not passed on", async () => {
        const from = received.length;
        const shared = new RequestLog();
        const scanner = await startEgressGuard({ app, allowPrivate: true, source: "scanner:fake", log: shared });
        const unnamed = await startEgressGuard({ app, allowPrivate: true });
        const platform = await startEgressGuard({ app, allowPrivate: true, source: "platform", log: shared });
        try {
            await viaProxy(scanner, "GET", `${T}/a`, { [SOURCE_HEADER]: "platform:discovery" });
            await viaProxy(scanner, "GET", `${T}/b`, { [SOURCE_HEADER]: "platform" });
            await viaProxy(scanner, "POST", `${T}/c`, { [SOURCE_HEADER]: "platform:checks" });
            await viaProxy(scanner, "GET", `${T}/d`, { [SOURCE_HEADER]: "scanner:fake:templates" });
            await viaProxy(scanner, "GET", `${T}/e`, { [SOURCE_HEADER]: "scanner:fakeplatform:x" });
            await viaProxy(unnamed, "GET", `${T}/f`, { [SOURCE_HEADER]: "platform:discovery" });
            // The other way round as well: a platform request cannot call itself a scanner.
            await viaProxy(platform, "GET", `${T}/g`, { [SOURCE_HEADER]: "scanner:fake" });
            await viaProxy(platform, "GET", `${T}/h`, { [SOURCE_HEADER]: "platform:discovery" });

            expect(scanner.entries().map((e) => `${e.path} ${e.source}`)).toEqual(["/a scanner:fake", "/b scanner:fake", "/c scanner:fake", "/d scanner:fake:templates", "/e scanner:fake"]);
            expect(unnamed.entries().map((e) => e.source)).toEqual([undefined]);
            expect(platform.entries().map((e) => `${e.path} ${e.source}`)).toEqual(["/g platform", "/h platform:discovery"]);
            // In the shared log too: only the platform's own guard writes "platform".
            expect(shared.entries().filter((e) => e.source?.startsWith("platform")).map((e) => e.path)).toEqual(["/g", "/h"]);
            expect(received.slice(from).some((r) => SOURCE_HEADER in r.headers)).toBe(false);
        } finally {
            await scanner.close();
            await unnamed.close();
            await platform.close();
        }
    });
});
