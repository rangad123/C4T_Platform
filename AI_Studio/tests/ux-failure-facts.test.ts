/**
 * UXP item 5: a failure says what was expected and what came back, and a missing API token is named as such. The facts are read
 * from the error the real Playwright runner reported (API checks and a web check against a tiny page), and shown in the test-detail
 * answer as structured fields. Also: the stale advice "edit it and import it again" is gone from the product.
 * Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/ux-failure-facts.test.ts
 * Ports: fixture app 6355.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, loadConfig } from "../src/config.js";
import { MISSING_API_TOKEN_REASON, failureFacts, isMissingApiToken, missingApiTokenReason } from "../src/engine/evidence/failure-facts.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 6355;
const APP = `http://127.0.0.1:${PORT}`;

describe("reading expected and actual from a runner error", () => {
    const real = (lines: string[]) => lines.join("\n");
    it("a status check", () => {
        const err = real(["Error: expect(received).toBe(expected) // Object.is equality", "", "Expected: 200", "Received: 404"]);
        expect(failureFacts(err)).toEqual({ expected: "200", actual: "404" });
        expect(failureFacts(err, { action: "assertResponse", check: "status", expected: 200, description: "" } as never)).toEqual({ expected: "HTTP 200", actual: "HTTP 404" });
    });
    it("a status class says 2xx, not the digit the script compared", () => {
        const err = real(["Error: expect(received).toBe(expected) // Object.is equality", "", "Expected: 2", "Received: 4"]);
        expect(failureFacts(err, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" } as never)).toEqual({ expected: "2xx", actual: "4xx" });
    });
    it("a status below a limit", () => {
        const err = real(["Error: expect(received).toBeLessThan(expected)", "", "Expected: < 500", "Received:   503"]);
        expect(failureFacts(err, { action: "assertResponse", check: "statusBelow", expected: 500, description: "" } as never)).toEqual({ expected: "below 500", actual: "HTTP 503" });
    });
    it("a text on the page, with colours in the message", () => {
        const err = ["\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoContainText\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m) failed\u001b[22m", "", "Locator: getByRole('status')", 'Expected substring: \u001b[32m"Added to the cart"\u001b[39m', 'Received string:    \u001b[31m"Added"\u001b[39m', "Timeout: 8000ms"].join("\n");
        expect(failureFacts(err)).toEqual({ expected: "Added to the cart", actual: "Added" });
    });
    it("an element that was not there", () => {
        expect(failureFacts("Locator: getByRole('button')\nExpected: visible\nReceived: <element(s) not found>")).toEqual({ expected: "visible", actual: "not found on the page" });
    });
    it("nothing to read means no facts, and long values are cut", () => {
        expect(failureFacts("TimeoutError: the element couldn't be found in time")).toBeUndefined();
        expect(failureFacts(undefined)).toBeUndefined();
        expect(failureFacts(`Expected: ${"x".repeat(500)}\nReceived: y`)!.expected!.length).toBeLessThanOrEqual(200);
    });
    it("a missing token is named only when the application answered 401 to a request that sends the credential, and none is saved", () => {
        const spec = { kind: "api", steps: [{ action: "request", method: "GET", path: "/x", auth: "default", description: "" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" }] } as never;
        const run = (status: number) => ({ status: "failed", steps: [{ index: 1, status: "failed" }], responses: [{ status }] });
        expect(missingApiTokenReason(spec, run(401), {})).toBe(MISSING_API_TOKEN_REASON);
        expect(missingApiTokenReason(spec, run(401), { apiToken: "t" })).toBeUndefined();
        expect(missingApiTokenReason(spec, run(401), { apiAuthHeader: "X-Key: k" })).toBeUndefined();
        expect(missingApiTokenReason(spec, run(403), {})).toBeUndefined();
        expect(missingApiTokenReason(spec, run(500), {})).toBeUndefined();
        const noAuth = { kind: "api", steps: [{ action: "request", method: "GET", path: "/x", auth: "none", description: "" }, { action: "assertResponse", check: "status", expected: 401, description: "" }] } as never;
        expect(missingApiTokenReason(noAuth, run(401), {})).toBeUndefined();
        expect(isMissingApiToken(MISSING_API_TOKEN_REASON)).toBe(true);
        expect(MISSING_API_TOKEN_REASON).toMatch(/^The test needs the project's API token, and none is saved\./);
    });
});

describe("the stale advice is gone", () => {
    it("no message tells the person to edit a test and import it again", () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
            }
        };
        walk(path.join(REPO_ROOT, "src"));
        walk(path.join(REPO_ROOT, "web/src"));
        const hits = files.filter((f) => /edit it and import it again|then import it again/i.test(fs.readFileSync(f, "utf8")));
        expect(hits).toEqual([]);
    });
});

describe("on real runs", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let fixture: http.Server;
    let dataDir: string;

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-ux-facts-"));
        // No repair attempts: a failure stays exactly what the run reported.
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 100);
        worker.start();
        fixture = http.createServer((req, res) => {
            if (req.url === "/page") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Shop</title><main><div role="status">Added</div></main>`);
            if (req.url === "/api/secret") {
                const ok = req.headers.authorization === "Bearer good-token";
                return void res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { ok: true } : { error: "no" }));
            }
            res.writeHead(404, { "content-type": "application/json" }).end("{}");
        });
        await new Promise<void>((r) => fixture.listen(PORT, "127.0.0.1", r));
    }, 30_000);

    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        fixture?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body } as { status: number; body: any };
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    async function done(jobId: string) {
        for (let i = 0; i < 400; i++) {
            const job = (await call("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) return job;
            await sleep(250);
        }
        throw new Error("job did not finish");
    }
    const api = (title: string, p: string, check: Record<string, unknown>) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", ...check }] });
    const detailOf = async (projectId: string, title: string) => {
        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string }>;
        return (await call("GET", `/api/tests/${tests.find((t) => t.title === title)!.id}`)).body;
    };

    it("a protected answer with no API token saved says so, in words and in a field", async () => {
        const project = (await call("POST", "/api/projects", { name: "No token" })).body.id as string;
        const imp = await call("POST", `/api/projects/${project}/specs`, { baseUrl: APP, specs: [api("Secret answers", "/api/secret", { check: "statusClass", expected: "2xx" })] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        await done(imp.body.jobId);
        const t = await detailOf(project, "Secret answers");
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(t.validationReason).toBe(MISSING_API_TOKEN_REASON);
        expect(t.failure).toEqual({ kind: "missing-api-token" });
    }, 120_000);

    it("with a token saved the mismatch is shown as expected and actual", async () => {
        const project = (await call("POST", "/api/projects", { name: "Wrong token" })).body.id as string;
        const imp = await call("POST", `/api/projects/${project}/specs`, {
            baseUrl: APP,
            credentials: { apiToken: "not-the-right-token" },
            specs: [api("Secret answers", "/api/secret", { check: "statusClass", expected: "2xx" }), api("Gone page", "/api/missing", { check: "status", expected: 200 })],
        });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        await done(imp.body.jobId);
        const secret = await detailOf(project, "Secret answers");
        // A token exists, so this is not "no token saved": it is a plain mismatch, with both sides.
        expect(secret.validationReason).not.toBe(MISSING_API_TOKEN_REASON);
        expect(secret.failure).toMatchObject({ kind: "mismatch", step: { index: 1 }, expected: "2xx", actual: "4xx" });
        const gone = await detailOf(project, "Gone page");
        expect(gone.failure).toMatchObject({ kind: "mismatch", expected: "HTTP 200", actual: "HTTP 404" });
        // The same facts sit on the failed step of the run.
        const failedStep = gone.executions[0].steps.find((s: any) => s.status === "failed");
        expect(failedStep).toMatchObject({ expected: "HTTP 200", actual: "HTTP 404" });
        // A passing step, and a test that did not fail, carry no such fields.
        expect(gone.executions[0].steps.find((s: any) => s.status === "passed")).not.toHaveProperty("expected");
    }, 120_000);

    it("a text that is not what the test expected: both texts", async () => {
        const project = (await call("POST", "/api/projects", { name: "Web text" })).body.id as string;
        const spec = {
            title: "Cart message",
            kind: "web",
            category: "Shop",
            steps: [{ action: "navigate", url: "/page" }, { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Added to the cart" }],
        };
        const imp = await call("POST", `/api/projects/${project}/specs`, { baseUrl: APP, specs: [spec] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        await done(imp.body.jobId);
        const t = await detailOf(project, "Cart message");
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        expect(t.failure).toMatchObject({ kind: "mismatch", step: { index: 1 }, expected: "Added to the cart", actual: "Added" });
    }, 180_000);
});
