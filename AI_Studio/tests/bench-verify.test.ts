/**
 * The benchmark's seeded defects are independently verifiable: for every defect in src/eval/bench/catalogue.json its verifier sees the
 * correct behaviour when everything is switched off, the defective behaviour when only it is switched on (and when all are), and no
 * other verifier of the same application fires when only one defect is on (so a finding can be pinned to one defect). Ports 9460-9469.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startBenchApp, type BenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import { VERIFIERS } from "../src/eval/bench/verify/index.js";

const catalogue = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../src/eval/bench/catalogue.json"), "utf8")) as {
    version: string;
    defects: Array<{ id: string; app: BenchApp; verifier: string; category: string }>;
};
let port = 9460;
const nextPort = () => (port = port >= 9469 ? 9460 : port + 1);
let running: RunningBenchApp | undefined;
afterEach(async () => {
    await running?.stop();
    running = undefined;
});

async function verdicts(app: BenchApp, defects: string): Promise<Record<string, boolean>> {
    running = await startBenchApp(app, nextPort(), defects);
    const out: Record<string, boolean> = {};
    for (const d of catalogue.defects.filter((x) => x.app === app)) {
        await running.reset();
        out[d.id] = await VERIFIERS[d.verifier]!(running.base);
    }
    await running.stop();
    running = undefined;
    return out;
}

describe("the defect catalogue", () => {
    it("has 15-25 defects with every field, a verifier each, and the categories the phase asks for", () => {
        expect(catalogue.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
        expect(catalogue.defects.length).toBeGreaterThanOrEqual(15);
        expect(catalogue.defects.length).toBeLessThanOrEqual(25);
        expect(new Set(catalogue.defects.map((d) => d.id)).size).toBe(catalogue.defects.length);
        for (const d of catalogue.defects as Array<Record<string, unknown>>) {
            for (const k of ["id", "app", "workflow", "category", "expected", "actual", "preconditions", "reproduction", "verifier", "severity", "impact", "detectableWithCurrentInfrastructure"]) expect(d[k], `${d.id} ${k}`).toBeTruthy();
            expect(VERIFIERS[d.verifier as string], String(d.id)).toBeTypeOf("function");
        }
        const cats = new Set(catalogue.defects.map((d) => d.category));
        for (const c of ["business-logic", "validation", "boundary", "state-transition", "persistence", "duplicate-operation", "authorization", "api-contract", "calculation", "workflow"]) expect(cats.has(c), c).toBe(true);
    });
});

describe.each(["bench-shop", "bench-rbac"] as const)("%s", (app) => {
    const ids = catalogue.defects.filter((d) => d.app === app).map((d) => d.id);

    it("shows the correct behaviour everywhere with nothing switched", async () => {
        const v = await verdicts(app, "none");
        expect(Object.entries(v).filter(([, present]) => present).map(([id]) => id)).toEqual([]);
    }, 60_000);

    it("shows every defect with all switched", async () => {
        const v = await verdicts(app, "all");
        expect(Object.entries(v).filter(([, present]) => !present).map(([id]) => id)).toEqual([]);
    }, 60_000);

    it.each(ids)("%s alone: its verifier fires and no other one does", async (id) => {
        const v = await verdicts(app, id);
        expect(Object.entries(v).filter(([, present]) => present).map(([d]) => d)).toEqual([id]);
    }, 60_000);
});
