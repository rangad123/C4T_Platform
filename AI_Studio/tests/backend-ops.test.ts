/**
 * C6 backend operations against the real bench shop (Phase 4 T15), port 9603. The chains are generated from the shop's own API document
 * and run as the validator runs them, signed in as the project's account (C1), from a dirty start (leftover cart lines, SAVE10 and an
 * extra order for alice). Clean, every chain is green. BS-07 alone (the cart is kept after an order, req 5.8) turns the duplicate chain
 * red on its documented 409. BS-15 alone (a refused code removes the one applied before, req 4.7) turns the discount transaction red on
 * the cart's code.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { backendOpsChains } from "../src/engine/api/backend-ops.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PORT = 9603;
const alice = { username: "alice@example.test", password: "Password1!" };
const specs: TestSpec[] = backendOpsChains(parseOpenApi(await benchOpenApi("bench-shop"), `http://127.0.0.1:${PORT}/openapi.json`).operations).map((c, i) =>
    TestSpecSchema.parse({ ...c.spec, testId: `API-${String(i + 1).padStart(3, "0")}` }),
);
const DUPLICATE = "Backend: the same write twice makes one record (POST /api/orders)";
const DISCOUNT = 'Backend: a refused write changes nothing (POST /api/cart/discount, "code" broken)';

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

/** Per chain title: "green", or "red at <the failed step's check>: <first error line>". */
async function runOn(defects: string): Promise<Record<string, string>> {
    const app = await startBenchApp("bench-shop", PORT, defects);
    try {
        await dirty(app.base);
        const scripts = specs.map((spec) => ({ testId: spec.testId, ...renderScript(spec, "playwright-api", { baseUrl: app.base }) }));
        const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: app.base, credentials: alice, headless: true }, { workers: 2 });
        return Object.fromEntries(
            specs.map((spec, i) => {
                const r = runs[i]!;
                const step = r.failedStepIndex === undefined ? undefined : spec.steps[r.failedStepIndex];
                const at = step?.action === "assertResponse" ? (step.check === "relation" ? `relation ${step.expression}` : step.check) : step?.action;
                return [spec.title, r.status === "passed" ? "green" : `red at ${at}: ${(r.error ?? r.status).split("\n")[0]}`];
            }),
        );
    } finally {
        await app.stop();
    }
}
const allGreen = (except: string[] = []) => Object.fromEntries(specs.filter((s) => !except.includes(s.title)).map((s) => [s.title, "green"]));
const without = (r: Record<string, string>, ...titles: string[]) => Object.fromEntries(Object.entries(r).filter(([t]) => !titles.includes(t)));

describe("C6 backend operations on bench-shop", () => {
    it("generates the duplicate and the discount transaction chains", () => {
        expect(specs.map((s) => s.title)).toEqual(expect.arrayContaining([DUPLICATE, DISCOUNT]));
    });

    it("clean, from a dirty start: every chain is green", async () => {
        expect(await runOn("none")).toEqual(allGreen());
    }, 240_000);

    it("BS-07 alone: the repeated order is not refused (the duplicate chain is red on its 409); the others stay green", async () => {
        const r = await runOn("BS-07");
        expect(r[DUPLICATE]).toMatch(/^red at status: /);
        expect(without(r, DUPLICATE)).toEqual(allGreen([DUPLICATE]));
    }, 240_000);

    it("BS-15 alone: the refused code took the applied one away (red on the cart's code); the others stay green", async () => {
        const r = await runOn("BS-15");
        expect(r[DISCOUNT]).toMatch(/^red at relation code == \$recordBefore\.code: /);
        expect(without(r, DISCOUNT)).toEqual(allGreen([DISCOUNT]));
    }, 240_000);
});
