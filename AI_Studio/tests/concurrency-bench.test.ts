/**
 * C8 controlled concurrency against the real bench shop (Phase 4 T24), port 9604. The checks are generated from the shop's own API
 * document behind the bench gate (loopback), and run as the validator runs them, signed in as the project's account (C1), from a dirty
 * start. Clean, both are green: one of three payments succeeds and one of three order creates (req 6.11, 5.7). With BS-14 alone (the
 * state check and the change are not done together), the payment check is red on its uniqueness relation. Run 5 times (plan T24).
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { generateConcurrencySpecs } from "../src/engine/api/concurrency.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PORT = 9604;
const alice = { username: "alice@example.test", password: "Password1!" };
const { specs: drafts } = generateConcurrencySpecs(parseOpenApi(await benchOpenApi("bench-shop"), `http://127.0.0.1:${PORT}/openapi.json`).operations, {
    dataChanges: true,
    appUrl: `http://127.0.0.1:${PORT}`,
    gate: "bench",
});
const specs: TestSpec[] = drafts.map((d, i) => TestSpecSchema.parse({ ...d, testId: `API-${String(i + 1).padStart(3, "0")}` }));
const PAY = "Concurrency: pay sent 3 times at once succeeds once (POST /api/orders/{id}/pay)";
const CREATE = "Concurrency: 3 identical creates at once make one record (POST /api/orders)";

async function dirty(base: string) {
    const res = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: alice.username, password: alice.password }) });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const a = (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    await a("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
    await a("POST", "/api/checkout/address", { address: "1 Leftover Road" });
    await a("POST", "/api/orders");
    await a("POST", "/api/cart/items", { productId: "p3", quantity: 2 });
}

async function runOn(defects: string): Promise<Record<string, string>> {
    const app = await startBenchApp("bench-shop", PORT, defects);
    try {
        await dirty(app.base);
        const scripts = specs.map((spec) => ({ testId: spec.testId, ...renderScript(spec, "playwright-api", { baseUrl: app.base }) }));
        const runs = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: app.base, credentials: alice, headless: true, riskyChecks: "bench" }, { workers: 1 });
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

describe("C8 controlled concurrency on bench-shop", () => {
    it("generates the payment and the order-create checks", () => {
        expect(specs.map((s) => s.title)).toEqual([PAY, CREATE]);
    });
    it("clean, from a dirty start: one of three succeeds each time", async () => {
        expect(await runOn("none")).toEqual({ [PAY]: "green", [CREATE]: "green" });
    }, 240_000);
    it("BS-14 alone: two payments arrive together and more than one succeeds; the create check stays green", async () => {
        const r = await runOn("BS-14");
        expect(r[PAY]).toMatch(/^red at relation ok == 1 and refused == 2: .*ok = 3/);
        expect(r[CREATE]).toBe("green");
    }, 240_000);
});
