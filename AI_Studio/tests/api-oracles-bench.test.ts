/**
 * C2 (Phase 4) against the bench apps: each documented case is red on its seed alone and green on the clean app from a dirty start
 * (leftover cart lines, SAVE10 and an extra order on bench-shop; an extra note on bench-rbac, as Wave 0's api-checks.mjs). The cases
 * are generated from the apps' own API documents and run as the validator runs them, signed in as the project's account (C1).
 * Ports 9473-9474. BS-19's oracle is the response-schema check (total in integer cents), the others' the documented status.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp, type BenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PASSWORD = "Password1!";

/** A cookie-keeping client for the dirty start. */
async function signedIn(base: string, email: string) {
    let cookie = "";
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    return (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const DIRTY: Record<BenchApp, (base: string) => Promise<void>> = {
    "bench-shop": async (b) => {
        const a = await signedIn(b, "alice@example.test");
        await a("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
        await a("POST", "/api/checkout/address", { address: "1 Leftover Road" });
        await a("POST", "/api/orders");
        for (const [p, q] of [["p3", 2], ["p4", 1], ["p5", 3], ["p1", 10]] as const) await a("POST", "/api/cart/items", { productId: p, quantity: q });
        await a("POST", "/api/cart/discount", { code: "SAVE10" });
    },
    "bench-rbac": async (b) => {
        await (await signedIn(b, "ana@example.test"))("POST", "/api/notes", { title: "Leftover note" });
    },
};

/** Seeds whose case is told by the documented response schema, not by the status. */
const SCHEMA_ORACLE = new Set(["BS-19"]);

const CASES: Record<BenchApp, { doc: object; port: number; account: string; seeds: Record<string, string> }> = {
    "bench-shop": {
        doc: await benchOpenApi("bench-shop"),
        port: 9473,
        account: "alice@example.test",
        seeds: { "BS-03": 'POST /api/cart/items: rejects "quantity" above its maximum (10)', "BS-04": 'POST /api/register: rejects "email" not an email address', "BS-09": 'POST /api/cart/items: rejects an unknown "productId"', "BS-17": 'POST /api/register: rejects an "email" already used, in other letter case', "BS-19": "GET /api/orders/{id}: succeeds with a valid request" },
    },
    "bench-rbac": {
        doc: await benchOpenApi("bench-rbac"),
        port: 9474,
        account: "ana@example.test",
        seeds: { "BR-07": 'POST /api/register: rejects "password" shorter than 8 characters', "BR-08": 'POST /api/notes: rejects "title" empty' },
    },
};

describe.each(Object.keys(CASES) as BenchApp[])("%s documented cases", (app) => {
    const c = CASES[app];
    const all = generateApiSpecs(parseOpenApi(c.doc, `http://127.0.0.1:${c.port}/openapi.json`).operations, { allowMutating: true, maxPerEndpoint: 6 }).specs;
    const specs = new Map<string, TestSpec>(
        Object.entries(c.seeds).map(([seed, title], i) => {
            const d = all.find((s) => s.title === title);
            if (!d) throw new Error(`no test "${title}"`);
            return [seed, TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` })];
        }),
    );
    async function runOn(defects: string, seeds: string[]): Promise<Record<string, string>> {
        const running = await startBenchApp(app, c.port, defects);
        try {
            await DIRTY[app](running.base);
            const scripts = seeds.map((seed) => {
                const spec = specs.get(seed)!;
                const r = renderScript(spec, "playwright-api", { baseUrl: running.base });
                return { testId: spec.testId, filename: r.filename, content: r.content };
            });
            const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: running.base, credentials: { username: c.account, password: PASSWORD }, headless: true }, { workers: 2 });
            // Red only counts on the oracle step itself (the documented status or schema), never on a step before it (sign-in, fresh account, real id).
            const statusStep = (seed: string) => specs.get(seed)!.steps.findIndex((s) => s.action === "assertResponse" && s.check === (SCHEMA_ORACLE.has(seed) ? "matchesSchema" : "status"));
            return Object.fromEntries(seeds.map((seed, i) => [seed, runs[i]!.status === "passed" ? "green" : `red at step ${runs[i]!.failedStepIndex === statusStep(seed) ? "oracle" : runs[i]!.failedStepIndex}: ${(runs[i]!.error ?? runs[i]!.status).split("\n")[0]}`]));
        } finally {
            await running.stop();
        }
    }

    it("each case is green on the clean app from a dirty start", async () => {
        const clean = await runOn("none", [...specs.keys()]);
        expect(clean).toEqual(Object.fromEntries([...specs.keys()].map((s) => [s, "green"])));
    }, 240_000);

    it.each(Object.keys(c.seeds))("%s alone turns its case red", async (seed) => {
        const r = await runOn(seed, [seed]);
        expect(r[seed]).toMatch(/^red at step oracle: /);
    }, 240_000);
});
