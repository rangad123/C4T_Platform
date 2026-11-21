/**
 * C7 stateful sequences (Phase 4 T16) against bench-shop, from its own API document. BS-10: the precondition skip (an order placed
 * without step 1, the delivery address) must get the documented 409. BS-05: the Shipped order of the project's account (ord-1000, a
 * state no new account reaches) must refuse Cancel with the documented 409. Each saved test is red on its seed alone and green on the
 * clean app from a dirty start (leftover cart lines, SAVE10 and an extra order on the main account), and the clean app's sequences hold.
 * Ports 9477-9478.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { fetchClient, type ProbeEnv } from "../src/engine/api/probes.js";
import { runSequences, stateCheckSpecs, stateModels } from "../src/engine/api/stateful.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PASSWORD = "Password1!";
const doc = await benchOpenApi("bench-shop");
const SEEDED = 9477;
const CLEAN = 9478;
const modelAt = (port: number) => stateModels(parseOpenApi(doc, `http://127.0.0.1:${port}/openapi.json`).operations)[0]!;
const envAt = (base: string, port: number): ProbeEnv => ({ apis: parseOpenApi(doc, `http://127.0.0.1:${port}/openapi.json`).operations, dataChanges: true, newClient: async () => fetchClient(base) });
async function alice(base: string) {
    const a = fetchClient(base);
    await a.send("POST", "/api/login", { email: "alice@example.test", password: PASSWORD });
    return a;
}
async function dirty(base: string) {
    const a = await alice(base);
    await a.send("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
    await a.send("POST", "/api/checkout/address", { address: "1 Leftover Road" });
    await a.send("POST", "/api/orders");
    for (const [p, q] of [["p3", 2], ["p4", 1], ["p5", 3]] as const) await a.send("POST", "/api/cart/items", { productId: p, quantity: q });
    await a.send("POST", "/api/cart/discount", { code: "SAVE10" });
}
async function run(base: string, specs: TestSpec[]) {
    const scripts = specs.map((spec) => {
        const r = renderScript(spec, "playwright-api", { baseUrl: base });
        return { testId: spec.testId, filename: r.filename, content: r.content };
    });
    return runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: base, credentials: { username: "alice@example.test", password: PASSWORD }, headless: true }, { workers: 1 });
}
const parse = (d: object, n: number) => TestSpecSchema.parse({ ...d, testId: `API-${String(n).padStart(3, "0")}` });

describe("stateful sequences on bench-shop", () => {
    it("BS-10 alone: the sequence fails at the documented 409, the saved one is red there and green on the clean app; the clean app's sequences hold", async () => {
        const seeded = await startBenchApp("bench-shop", SEEDED, "BS-10");
        const clean = await startBenchApp("bench-shop", CLEAN, "none");
        try {
            const r = await runSequences(modelAt(SEEDED), envAt(seeded.base, SEEDED), { seed: 20261122 });
            expect(r.outcome, r.reason).toBe("failed");
            expect(r.log.at(-1)).toMatchObject({ request: "POST /api/orders", status: 201, expected: "HTTP 409" });
            const spec = parse(r.spec!, 1);
            const held = await runSequences(modelAt(CLEAN), envAt(clean.base, CLEAN), { seed: 20261122 });
            expect(held.outcome, held.message).toBe("held");
            expect(held.sequences).toBe(6);

            const [red] = await run(seeded.base, [spec]);
            expect(red!.status).toBe("failed");
            expect(spec.steps[red!.failedStepIndex]).toMatchObject({ action: "assertResponse", check: "status", expected: 409 });
            await dirty(clean.base);
            const green = await run(clean.base, [spec, parse(held.spec!, 2)]);
            expect(green.map((g) => [g.status, g.error?.split("\n")[0]])).toEqual([["passed", undefined], ["passed", undefined]]);
        } finally {
            await seeded.stop();
            await clean.stop();
        }
    }, 240_000);

    it("BS-05 alone: the Shipped order of the project's account refuses Cancel with the documented 409", async () => {
        const seeded = await startBenchApp("bench-shop", SEEDED, "BS-05");
        const clean = await startBenchApp("bench-shop", CLEAN, "none");
        try {
            const r = await runSequences(modelAt(SEEDED), envAt(seeded.base, SEEDED), { seed: 7 });
            expect(r.outcome, r.message).toBe("held");
            expect(r.seen).not.toContain("shipped");
            const specs = await stateCheckSpecs(modelAt(SEEDED), await alice(seeded.base), r.seen, true);
            const cancel = specs.find((s) => s.title.startsWith("POST /api/orders/{id}/cancel: a shipped order"));
            expect(cancel?.steps[2]).toMatchObject({ path: "/api/orders/ord-1000/cancel" });
            const spec = parse(cancel!, 3);

            const [red] = await run(seeded.base, [spec]);
            expect(red!.status).toBe("failed");
            expect(red!.failedStepIndex).toBe(3);
            await dirty(clean.base);
            const green = await run(clean.base, specs.map((s, i) => parse(s, 10 + i)));
            expect(green.map((g) => [g.status, g.error?.split("\n")[0]])).toEqual(specs.map(() => ["passed", undefined]));
        } finally {
            await seeded.stop();
            await clean.stop();
        }
    }, 240_000);
});
