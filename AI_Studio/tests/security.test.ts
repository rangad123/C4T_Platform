/**
 * Regression tests for the security/correctness review findings. Each test pins one fix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { redactQuery } from "../src/engine/discovery/network.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { weakensApiTest } from "../src/engine/validation/repair.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const LS = String.fromCharCode(0x2028);
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dataDir: string;

beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: "secret-key-123" }));
    server = await buildServer(platform);
});
afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.BLOCK_PRIVATE_TARGETS;
});

const get = (url: string, key?: string) => server.inject({ method: "GET", url, headers: key ? { "x-api-key": key } : {} });

describe("API-key auth", () => {
    it("cannot be bypassed with percent-encoded paths", async () => {
        expect((await get("/api/projects")).statusCode).toBe(401);
        expect((await get("/%61pi/projects")).statusCode).toBe(401);
        expect((await get("/ap%69/projects")).statusCode).toBe(401);
        expect((await get("/api/projects", "secret-key-123")).statusCode).toBe(200);
        expect((await get("/api/health")).statusCode).toBe(200);
    });
});

describe("SSRF guard (BLOCK_PRIVATE_TARGETS=true)", () => {
    it("rejects IPv4-mapped IPv6, unspecified and CGNAT targets", async () => {
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        const p = await server.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": "secret-key-123" }, payload: { name: "ssrf" } });
        const id = JSON.parse(p.body).id as string;
        for (const url of ["http://[::ffff:127.0.0.1]:4000/", "http://[::ffff:a9fe:a9fe]/", "http://[::]/", "http://100.64.0.1/", "http://127.0.0.1/"]) {
            const r = await server.inject({ method: "POST", url: `/api/projects/${id}/test-generation`, headers: { "x-api-key": "secret-key-123" }, payload: { url } });
            expect(r.statusCode, url).toBe(400);
        }
    });
});

describe("download", () => {
    it("treats includeUnvalidated=false as false", async () => {
        const p = await server.inject({ method: "POST", url: "/api/projects", headers: { "x-api-key": "secret-key-123" }, payload: { name: "dl" } });
        const id = JSON.parse(p.body).id as string;
        expect((await get(`/api/projects/${id}/download?includeUnvalidated=false`, "secret-key-123")).statusCode).toBe(200);
        expect((await get(`/api/projects/${id}/download?includeUnvalidated=maybe`, "secret-key-123")).statusCode).toBe(400);
    });
});

describe("generated scripts", () => {
    it("cannot be injected through titles or step descriptions", () => {
        const api = TestSpecSchema.parse({
            testId: "API-001",
            title: `GET /items${LS}require("child_process").execSync("calc")//`,
            kind: "api",
            steps: [
                { action: "request", method: "GET", path: "/x" },
                { action: "assertResponse", check: "status", expected: 200 },
            ],
        });
        const web = TestSpecSchema.parse({
            testId: "WEB-001",
            title: "Hover menu",
            kind: "web",
            steps: [{ action: "hover", locator: { by: "text", value: "Menu" }, description: `hover\rrequire("fs").rmSync("/")` }],
        });
        for (const out of [renderScript(api, "playwright-api", { baseUrl: "http://x" }).content, renderScript(web, "taqwright", { baseUrl: "http://x" }).content]) {
            expect(out.includes(LS) || out.includes("\r")).toBe(false);
            expect(out.split("\n").some((l) => /^\s*require\(/.test(l))).toBe(false);
        }
    });

    it("run without the platform's own secrets in their environment", async () => {
        process.env.ANTHROPIC_API_KEY = "must-not-leak";
        process.env.SECRET_KEY = "must-not-leak-either";
        try {
            const content = `import { test, expect } from "@playwright/test";
test("env", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.SECRET_KEY).toBeUndefined();
    expect(process.env.BASE_URL).toBe("http://example.test");
});
`;
            const [run] = await runScripts(loadConfig({}).scratchDir, [{ testId: "ENV-001", filename: "ENV-001.spec.ts", content }], { baseUrl: "http://example.test", headless: true });
            expect(run!.status, run!.error).toBe("passed");
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.SECRET_KEY;
        }
    }, 90_000);
});

describe("API repair guard", () => {
    const original = TestSpecSchema.parse({
        testId: "API-002",
        title: "GET /me rejects requests without credentials",
        kind: "api",
        type: "security",
        tags: ["api", "auth"],
        steps: [
            { action: "request", method: "GET", path: "/me", auth: "none" },
            { action: "assertResponse", check: "statusClass", expected: "4xx" },
        ],
    });
    const steps = (s: unknown[]) => s as Step[];

    it("rejects changed requests, removed assertions and loosened security expectations", () => {
        expect(weakensApiTest(original, steps([{ action: "request", method: "GET", path: "/me", auth: "default" }, original.steps[1]]))).toMatch(/requests changed/);
        expect(weakensApiTest(original, steps([original.steps[0]]))).toMatch(/assertions removed/);
        expect(weakensApiTest(original, steps([original.steps[0], { action: "assertResponse", check: "statusClass", expected: "2xx" }]))).toMatch(/security test/);
    });

    it("accepts a legitimate expectation correction on a non-security test", () => {
        const neg = TestSpecSchema.parse({ ...original, type: "negative", tags: ["api"] });
        expect(weakensApiTest(neg, steps([original.steps[0], { action: "assertResponse", check: "status", expected: 422 }]))).toBeUndefined();
    });
});

describe("network redaction", () => {
    it("redacts credential-like query parameters but keeps ordinary ones", () => {
        const q = redactQuery(new URL("https://a.test/api/feed?access_token=XYZ&page=2&api_key=K&postcode=12345"));
        expect(q).not.toContain("XYZ");
        expect(q).not.toContain("=K");
        expect(q).toContain("page=2");
        expect(q).toContain("postcode=12345");
    });
});
