/**
 * API contract checks: the validator itself (a table of cases), generation, and a real run in which a fixture API
 * returns conforming and non-conforming responses against its own OpenAPI description.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { CONTRACT_FAILURE_PREFIX, loadContractRuntime } from "../src/engine/contracts/check.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const rt = loadContractRuntime();
/** The failure lines for a value, or [] when it conforms. */
function lines(value: unknown, schema: unknown): string[] {
    try {
        rt.contractAssert(value, schema);
        return [];
    } catch (e) {
        return String((e as Error).message).split("\n").slice(1);
    }
}

describe("contract validator", () => {
    const item = {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "integer" }, name: { type: "string", minLength: 1, maxLength: 20 }, price: { type: "number", minimum: 0 }, tags: { type: "array", items: { type: "string" } }, kind: { type: "string", enum: ["a", "b"] }, at: { type: "string", format: "date-time" }, note: { type: "string", nullable: true } },
    };

    it("accepts conforming responses, including optional, nullable and integer-as-number", () => {
        expect(lines({ id: 1, name: "x" }, item)).toEqual([]);
        expect(lines({ id: 1, name: "x", price: 3, tags: ["a"], kind: "a", at: "2024-01-01T10:00:00Z", note: null }, item)).toEqual([]);
        expect(lines({ id: 1, name: "x", extra: true }, item)).toEqual([]); // extras are fine unless the schema forbids them
        expect(lines([{ id: 1, name: "x" }, { id: 2, name: "y" }], { type: "array", items: item })).toEqual([]);
        expect(lines(null, { type: "object", nullable: true })).toEqual([]);
        expect(lines(5, { type: "number" })).toEqual([]);
    });

    it("reports missing required fields and wrong types as high", () => {
        expect(lines({ id: 1 }, item)).toEqual(["- [high] response.name: is missing, but the documentation marks it required"]);
        expect(lines({ id: "1", name: "x" }, item)).toEqual(["- [high] response.id: expected integer, got string"]);
        expect(lines({ id: 1.5, name: "x" }, item)).toEqual(["- [high] response.id: expected integer, got number"]);
        expect(lines({ id: 1, name: "x", tags: "no" }, item)).toEqual(["- [high] response.tags: expected array, got string"]);
        expect(lines({ id: 1, name: null }, item)).toEqual(["- [high] response.name: is null, but the documentation says string"]);
        expect(lines("text", { type: "object" })).toEqual(["- [high] response: expected object, got string"]);
    });

    it("reports values outside enum, length, range and pattern as medium, and bad formats as low", () => {
        expect(lines({ id: 1, name: "x", kind: "z" }, item)).toEqual(["- [medium] response.kind: \"z\" is not one of the documented values (a, b)"]);
        expect(lines({ id: 1, name: "" }, item)[0]).toMatch(/\[medium\] response\.name: is shorter than the documented minimum of 1/);
        expect(lines({ id: 1, name: "x".repeat(21) }, item)[0]).toMatch(/\[medium\] .*longer than the documented maximum of 20/);
        expect(lines({ id: 1, name: "x", price: -1 }, item)[0]).toMatch(/\[medium\] response\.price: -1 is below the documented minimum of 0/);
        expect(lines("abc", { type: "string", pattern: "^\\d+$" })[0]).toMatch(/\[medium\] .*does not match the documented pattern/);
        expect(lines({ id: 1, name: "x", at: "yesterday" }, item)[0]).toMatch(/\[low\] response\.at: "yesterday" is not a valid date-time/);
        expect(lines("not-an-email", { type: "string", format: "email" })[0]).toMatch(/\[low\]/);
        expect(lines("123e4567-e89b-12d3-a456-426614174000", { type: "string", format: "uuid" })).toEqual([]);
    });

    it("flags extra fields only when the schema forbids them", () => {
        expect(lines({ a: 1, b: 2 }, { type: "object", properties: { a: { type: "integer" } }, additionalProperties: false })).toEqual(["- [low] response.b: is not documented (the documentation allows no extra fields)"]);
    });

    it("orders by severity, reports a repeated problem in a list once, and shortens long reports", () => {
        const out = lines({ id: "1", kind: "z" }, item);
        expect(out[0]).toContain("[high]");
        expect(out.at(-1)).toContain("[medium]");
        const many = lines([{ id: "1", name: "a" }, { id: "2", name: "b" }, { id: "3", name: "c" }], { type: "array", items: item });
        expect(many).toEqual(["- [high] response[].id: expected integer, got string"]);
        const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, { type: "integer" }])) };
        const tooMany = lines(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"])), wide);
        expect(tooMany).toHaveLength(7);
        expect(tooMany.at(-1)).toBe("- [low] ...and 3 more");
    });

    it("skips nodes the parser could only partly keep (oneOf / anyOf), and says so when the body is not JSON", () => {
        expect(lines({ b: 3 }, { type: "object", required: ["a"], "x-aitp-lossy": true })).toEqual([]);
        expect(lines(undefined, item)).toEqual(["- [high] response: the body is not JSON, but the documentation describes a JSON body"]);
    });

    it("starts every failure with the stable prefix and a one-line summary", () => {
        expect(() => rt.contractAssert({ id: "x" }, item)).toThrow(new RegExp(`^${CONTRACT_FAILURE_PREFIX} 2 differences between the response and its documentation`));
    });
});

describe("generation", () => {
    const doc = {
        openapi: "3.0.0",
        info: { title: "t", version: "1" },
        paths: {
            "/items": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } } } } } },
            "/either": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { oneOf: [{ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { type: "object", required: ["b"], properties: { b: { type: "integer" } } }] } } } } } } },
        },
    };
    const endpoints = parseOpenApi(doc, "http://x/openapi.json").operations;
    const happy = (opts: Record<string, unknown>) => generateApiSpecs(endpoints, { allowMutating: false, maxPerEndpoint: 6, ...opts }).specs.filter((s) => s.title.endsWith("succeeds with a valid request"));
    const contractSteps = (specs: ReturnType<typeof happy>) => specs.map((s) => s.steps.filter((x) => x.action === "assertResponse" && x.check === "matchesSchema").length);

    it("adds the schema check to the happy path of documented object responses, and can be switched off", () => {
        const on = happy({});
        const items = on.find((s) => s.title.startsWith("GET /items"))!;
        expect(items.steps.filter((x) => x.action === "assertResponse" && x.check === "matchesSchema")).toHaveLength(1);
        expect(contractSteps(happy({ contractChecks: false })).every((n) => n === 0)).toBe(true);
    });

    it("marks collapsed oneOf nodes so they are not judged", () => {
        const either = happy({}).find((s) => s.title.startsWith("GET /either"));
        const step = either?.steps.find((x) => x.action === "assertResponse" && x.check === "matchesSchema");
        // the response is described by oneOf: the schema (if attached at all) must be flagged lossy
        if (step && step.action === "assertResponse") expect(JSON.stringify(step.schema)).toContain("x-aitp-lossy");
    });
});

// ── a real run ────────────────────────────────────────────────────────────────
const PORT = 5320;
const BASE = `http://127.0.0.1:${PORT}`;
const OPENAPI = {
    openapi: "3.0.0",
    info: { title: "Fixture", version: "1.0" },
    servers: [{ url: BASE }],
    paths: {
        "/api/ok": { get: { summary: "ok", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } }, price: { type: "number", minimum: 0 }, createdAt: { type: "string", format: "date-time" }, note: { type: "string", nullable: true } } } } } } } } },
        "/api/bad": { get: { summary: "bad", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" }, status: { type: "string", enum: ["active", "disabled"] }, price: { type: "number", minimum: 0 }, tags: { type: "array", items: { type: "string" } } } } } } } } } },
        "/api/either": { get: { summary: "either", responses: { "200": { description: "ok", content: { "application/json": { schema: { oneOf: [{ type: "object", required: ["a"], properties: { a: { type: "string" } } }, { type: "object", required: ["b"], properties: { b: { type: "integer" } } }] } } } } } } },
        "/api/strict": { get: { summary: "strict", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "integer" } } } } } } } } },
    },
};
const BODIES: Record<string, unknown> = {
    "/api/ok": { id: 1, name: "Widget", tags: ["a", "b"], price: 9.5, createdAt: "2024-01-01T00:00:00Z", note: null },
    "/api/bad": { id: "7", status: "archived", price: -1, tags: "nope" },
    "/api/either": { b: 3 },
    "/api/strict": { id: 1, secret: "leaked" },
};
const api = http.createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0]!;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(p === "/openapi.json" ? OPENAPI : (BODIES[p] ?? { error: "not found" })));
});

describe("on a real API", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };
    async function runJob(extra: Record<string, unknown>) {
        const project = (await call("POST", "/api/projects", { name: `Contracts ${Math.random()}` })).body.id as string;
        const queued = await call("POST", `/api/projects/${project}/test-generation`, { url: BASE, targets: ["api"], securityChecks: false, ...extra });
        for (let i = 0; i < 240; i++) {
            const j = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const tests = (await call("GET", `/api/projects/${project}/tests`)).body as Array<{ id: string; title: string; validationStatus: string; validationReason: string | null; severity: { severity: string; basis: string } | null }>;
        return Object.fromEntries(tests.filter((t) => t.title.endsWith("succeeds with a valid request")).map((t) => [t.title.split(":")[0]!, t]));
    }

    beforeAll(async () => {
        await new Promise<void>((r) => api.listen(PORT, "127.0.0.1", r));
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-contracts-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        await new Promise((r) => api.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("passes conforming and oneOf responses, and flags the rest with the right severity", async () => {
        const by = await runJob({});
        expect(by["GET /api/ok"]!.validationStatus).toBe("VALIDATED");
        expect(by["GET /api/either"]!.validationStatus).toBe("VALIDATED"); // oneOf is not judged: no false alarm

        const bad = by["GET /api/bad"]!;
        expect(bad.validationStatus).toBe("NEEDS_REVIEW");
        expect(bad.validationReason).toMatch(/^API contract check failed: 5 differences between the response and its documentation/);
        for (const line of [
            "- [high] response.id: expected integer, got string",
            "- [high] response.name: is missing, but the documentation marks it required",
            "- [high] response.tags: expected array, got string",
            '- [medium] response.status: "archived" is not one of the documented values (active, disabled)',
            "- [medium] response.price: -1 is below the documented minimum of 0",
        ]) expect(bad.validationReason).toContain(line);
        expect(bad.validationReason).toContain("How to fix:");
        expect(bad.severity).toEqual({ severity: "high", basis: "response differs from the API documentation" });

        const strict = by["GET /api/strict"]!;
        expect(strict.validationStatus).toBe("NEEDS_REVIEW");
        expect(strict.validationReason).toContain("response.secret: is not documented");
        expect(strict.severity!.severity).toBe("low");
    }, 240_000);

    it("does nothing when the option is off: the older generic checks apply, as before", async () => {
        const by = await runJob({ contractChecks: false });
        // no schema comparison: a response that merely has the right shape passes...
        expect(by["GET /api/strict"]!.validationStatus).toBe("VALIDATED");
        // ...and a missing required key still fails the old generic "contains <key>" step, which is a plain test failure, not a contract finding
        const bad = by["GET /api/bad"]!;
        expect(bad.validationStatus).toBe("FAILED_VALIDATION");
        expect(bad.validationReason ?? "").not.toContain(CONTRACT_FAILURE_PREFIX);
    }, 240_000);

    it("carries the schema in the spec and the validator in the script, with no secrets", async () => {
        const by = await runJob({});
        const detail = (await call("GET", `/api/tests/${by["GET /api/ok"]!.id}`)).body;
        const step = detail.spec.steps.find((s: { check?: string }) => s.check === "matchesSchema");
        expect(step.schema.required).toEqual(["id", "name"]);
        expect(step.description).toBe("Response matches the documented schema");
        const script = detail.scripts[0].content as string;
        expect(script).toContain("function contractAssert");
        expect(script).toContain("contractAssert(last.json,");
        expect(script).not.toMatch(/sk-|password/i);
    }, 240_000);
});
