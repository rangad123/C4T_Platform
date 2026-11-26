/**
 * C5 invariant probe (Phase 4 T13) against bench-shop. The three invariants are the layers-only trial's scripted proposal (requirements
 * 3.9, 4.1 and 4.5); the engine's own validation keeps them against the app's API document. For each seed alone, the probe on the
 * seeded app finds the failure and the saved script (the minimal case with its seed) is red at a relation step there and green on the
 * clean app from a dirty start (leftover cart lines, SAVE10 and an extra order on the main account). On the clean app the probe holds.
 * Ports 9475-9476.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { fetchClient, probeInvariant, type ProbeEnv } from "../src/engine/api/probes.js";
import { renderScript } from "../src/engine/generators/index.js";
import { parseRequirementsDeterministic } from "../src/engine/requirements/parse.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { proposeInvariants, type Invariant } from "../src/engine/validation/invariants.js";
import { runScripts } from "../src/engine/validation/runner.js";
import { BENCH_SHOP_INVARIANTS, layersOnlyLlm } from "../src/eval/bench/layers-only.js";
import { startBenchApp } from "../src/eval/bench/verify/app.js";
import { readFileSync } from "node:fs";
import { benchOpenApi } from "./fixtures/bench-openapi.js";

const PASSWORD = "Password1!";
const doc = await benchOpenApi("bench-shop");
const SEEDED = 9475;
const CLEAN = 9476;
const apisAt = (port: number) => parseOpenApi(doc, `http://127.0.0.1:${port}/openapi.json`).operations;
const envAt = (base: string, port: number): ProbeEnv => ({ apis: apisAt(port), dataChanges: true, newClient: async () => fetchClient(base) });

async function dirty(base: string) {
    const a = fetchClient(base);
    await a.send("POST", "/api/login", { email: "alice@example.test", password: PASSWORD });
    await a.send("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
    await a.send("POST", "/api/checkout/address", { address: "1 Leftover Road" });
    await a.send("POST", "/api/orders");
    for (const [p, q] of [["p3", 2], ["p4", 1], ["p5", 3], ["p1", 10]] as const) await a.send("POST", "/api/cart/items", { productId: p, quantity: q });
    await a.send("POST", "/api/cart/discount", { code: "SAVE10" });
}
async function run(base: string, specs: TestSpec[]) {
    const scripts = specs.map((spec) => {
        const r = renderScript(spec, "playwright-api", { baseUrl: base });
        return { testId: spec.testId, filename: r.filename, content: r.content };
    });
    return runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: base, credentials: { username: "alice@example.test", password: PASSWORD }, headless: true }, { workers: 2 });
}
const SEED_OF: Record<string, string> = { "3.9": "BS-02", "4.1": "BS-01", "4.5": "BS-11" };

describe("invariant probe on bench-shop", () => {
    it("the scripted proposal's invariants are all kept by the engine's validation", async () => {
        const text = readFileSync("examples/bench-shop/requirements/requirements.md", "utf8");
        const apis = apisAt(CLEAN);
        const p = await proposeInvariants({ llm: layersOnlyLlm() }, { requirements: parseRequirementsDeterministic(text), apis, origins: new Set([`http://127.0.0.1:${CLEAN}`]), dataChanges: true, secrets: [] });
        // The scripted three, and the line-total rule requirement 3.8 states (statedLineTotals), kept beside them.
        expect(p.report).toMatchObject({ proposed: 4, kept: 4, dropped: [] });
        expect(p.invariants.find((i) => i.requirementId === "3.8")?.expression).toBe("lines[*].lineTotal == lines[*].unitPrice * lines[*].quantity");
    });

    it.each(BENCH_SHOP_INVARIANTS as Invariant[])("requirement $requirementId: red on its seed alone with the saved case, green clean from a dirty start", async (inv) => {
        const seeded = await startBenchApp("bench-shop", SEEDED, SEED_OF[inv.requirementId]!);
        const clean = await startBenchApp("bench-shop", CLEAN, "none");
        try {
            const r = await probeInvariant(inv, envAt(seeded.base, SEEDED), { seed: 20261122 });
            expect(r.outcome, r.reason).toBe("failed");
            const spec = TestSpecSchema.parse({ ...r.spec, testId: "API-001" });
            expect(spec.testData.probeSeed).toBe("20261122");
            const held = await probeInvariant(inv, envAt(clean.base, CLEAN), { seed: 20261122 });
            expect(held.outcome, held.reason).toBe("held");
            const heldSpec = TestSpecSchema.parse({ ...held.spec, testId: "API-002" });

            const [red] = await run(seeded.base, [spec]);
            expect(red!.status).toBe("failed");
            expect(spec.steps[red!.failedStepIndex]).toMatchObject({ action: "assertResponse", check: "relation" });
            await dirty(clean.base);
            const green = await run(clean.base, [spec, heldSpec]);
            expect(green.map((g) => [g.status, g.error?.split("\n")[0]])).toEqual([["passed", undefined], ["passed", undefined]]);
        } finally {
            await seeded.stop();
            await clean.stop();
        }
    }, 240_000);

    // Paid shop-4/-5 (eng-fix2): the model's own proposals for 4.1 and 4.5 signed up and in as setup, and every probe stopped at
    // "the setup POST /api/login answered HTTP 401". With that setup the probe now runs on the real app and finds both seeds.
    it.each(BENCH_SHOP_INVARIANTS.filter((i) => i.requirementId !== "3.9") as Invariant[])("requirement $requirementId with the model's sign-up and sign-in setup still probes and fails on its seed", async (inv) => {
        const seeded = await startBenchApp("bench-shop", SEEDED, SEED_OF[inv.requirementId]!);
        try {
            const withSignIn = { ...inv, setup: ["POST /api/register", "POST /api/login", ...inv.setup], ...(inv.setupBodies ? { setupBodies: [{}, {}, ...inv.setupBodies] } : {}) };
            const r = await probeInvariant(withSignIn, envAt(seeded.base, SEEDED), { seed: 20261122 });
            expect(r.reason).toBeUndefined();
            expect(r.outcome).toBe("failed");
        } finally {
            await seeded.stop();
        }
    }, 240_000);
});
