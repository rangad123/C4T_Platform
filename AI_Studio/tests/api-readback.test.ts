/**
 * C9 read-back chains against the real bench shop (Phase 4 T14), port 9602. The chains are generated from the shop's own API document
 * and run as the validator runs them, signed in as the project's account (C1), from a dirty start (leftover cart lines, SAVE10 and an
 * extra order for alice). Clean, both are green; BS-06 alone (the profile is not stored, req 7.3) turns the profile chain red on a
 * read-back check, and BS-12 alone (the newest order is missing from the list, req 6.3) turns the order chain red on the list check.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiWorkflowSpecs } from "../src/engine/api/workflows.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PORT = 9602;
const alice = { username: "alice@example.test", password: "Password1!" };

const all = generateApiWorkflowSpecs(parseOpenApi(await benchOpenApi("bench-shop"), `http://127.0.0.1:${PORT}/openapi.json`).operations, { allowMutating: true, maxWorkflows: 50 }).specs;
const pick = (title: string, testId: string): TestSpec => {
    const d = all.find((s) => s.title.startsWith(title));
    if (!d) throw new Error(`no workflow "${title}"`);
    return TestSpecSchema.parse({ ...d, testId });
};
const CHAINS = {
    profile: pick("Workflow: what is written is read back (PUT /api/profile", "API-001"),
    orders: pick("Workflow: order lifecycle", "API-002"),
};

async function dirty(base: string) {
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: alice.username, password: alice.password }) });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const a = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    await a("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
    await a("POST", "/api/checkout/address", { address: "1 Leftover Road" });
    await a("POST", "/api/orders");
    for (const [p, q] of [["p3", 2], ["p1", 10]] as const) await a("POST", "/api/cart/items", { productId: p, quantity: q });
    await a("POST", "/api/cart/discount", { code: "SAVE10" });
}

/** Per chain: "green", or "red at <the failed step's check>: <first error line>". */
async function runOn(defects: string): Promise<Record<keyof typeof CHAINS, string>> {
    const app = await startBenchApp("bench-shop", PORT, defects);
    try {
        await dirty(app.base);
        const specs = Object.values(CHAINS);
        const scripts = specs.map((spec) => ({ testId: spec.testId, ...renderScript(spec, "playwright-api", { baseUrl: app.base }) }));
        const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: app.base, credentials: alice, headless: true }, { workers: 2 });
        const verdict = (spec: TestSpec, i: number) => {
            const r = runs[i]!;
            if (r.status === "passed") return "green";
            const step = r.failedStepIndex === undefined ? undefined : spec.steps[r.failedStepIndex];
            return `red at ${step?.action === "assertResponse" ? `${step.check}${step.path ? ` ${step.path}` : ""}` : step?.action}: ${(r.error ?? r.status).split("\n")[0]}`;
        };
        return Object.fromEntries(Object.keys(CHAINS).map((k, i) => [k, verdict(specs[i]!, i)])) as Record<keyof typeof CHAINS, string>;
    } finally {
        await app.stop();
    }
}

describe("C9 read-back chains on bench-shop", () => {
    it("clean, from a dirty start: both chains are green", async () => {
        expect(await runOn("none")).toEqual({ profile: "green", orders: "green" });
    }, 240_000);

    it("BS-06 alone: the profile read-back is red on a written field; the orders chain stays green", async () => {
        const r = await runOn("BS-06");
        expect(r.profile).toMatch(/^red at jsonPath (name|address): /);
        expect(r.orders).toBe("green");
    }, 240_000);

    it("BS-12 alone: the list check is red (the newest order is missing); the profile chain stays green", async () => {
        const r = await runOn("BS-12");
        expect(r.orders).toMatch(/^red at relation: /);
        expect(r.profile).toBe("green");
    }, 240_000);
});
