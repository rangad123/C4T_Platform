/**
 * A passing run's footprint (the optional `footprint` section of its evidence JSON, stored as the same "evidence" artifact kind) expires
 * with the passing run's records: kept at 29 days, removed from the object store at 31 (default policy: passed runs 30 days), after which
 * the evidence reader says it expired instead of showing a footprint. Real platform (database, artifact store on disk, routes through
 * server.inject), no browser, no model, no listening port.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runScheduledRetention } from "../src/platform/retention-runner.js";
import { buildServer } from "../src/platform/server.js";
import { addRun, addTest, exists, pastGrace, type SeedFile, seedProject } from "./fixtures/retention-seed.js";

let dataDir: string;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-footprint-retention-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    pastGrace(platform); // an installation long past its first-deploy grace (the grace itself: retention-other-records.test.ts)
    server = await buildServer(platform);
}, 60_000);
afterAll(async () => {
    await server?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const footprintJson = JSON.stringify({
    v: 1,
    durationMs: 1200,
    counts: { requests: 2, requestsKept: 0, console: 0, consoleKept: 0 },
    steps: [],
    requests: [],
    console: [],
    footprint: { pages: [{ path: "/shop", step: 1 }], endpoints: [{ method: "GET", path: "/api/items", step: 1, n: 2, statuses: [200] }] },
});

/** Turn a seeded "evidence" file into a real footprint-only evidence JSON (as a passing run stores it). */
function writeFootprint(f: SeedFile): void {
    fs.writeFileSync(f.abs, footprintJson);
    platform.db.run("UPDATE artifacts SET size = ? WHERE id = ?", Buffer.byteLength(footprintJson), f.id);
}

const evidenceOf = async (testId: string, executionId: string) => {
    const r = await server.inject({ method: "GET", url: `/api/tests/${testId}/evidence?executionId=${executionId}` });
    expect(r.statusCode, r.body).toBe(200);
    return JSON.parse(r.body);
};

describe("a passing run's footprint expires with the passing run's records (30 days)", () => {
    it("keeps the 29-day-old footprint, removes the 31-day-old one from the store, and says it expired", async () => {
        const seed = seedProject(platform, "Footprint retention");
        const t = addTest(platform, seed, "The shop lists items", "web");
        const old = addRun(platform, seed, t, { daysAgo: 31, status: "passed", files: [{ kind: "evidence" }] });
        const young = addRun(platform, seed, t, { daysAgo: 29, status: "passed", files: [{ kind: "evidence" }] });
        writeFootprint(old.files[0]!);
        writeFootprint(young.files[0]!);

        // Before: both runs show their footprint.
        for (const run of [old, young]) {
            const v = await evidenceOf(t.id, run.executionId);
            expect(v.footprint?.endpoints?.[0]).toMatchObject({ method: "GET", path: "/api/items", n: 2 });
        }

        const result = (await runScheduledRetention(platform, Date.now())).find((r) => r.projectId === seed.projectId);
        expect(result).toMatchObject({ result: "pruned", files: 1 });

        // The 31-day-old footprint is gone from the object store and marked; the 29-day-old one stays.
        expect(exists(old.files[0]!)).toBe(false);
        expect(platform.db.get<{ pruned_at: string | null }>("SELECT pruned_at FROM artifacts WHERE id = ?", old.files[0]!.id)?.pruned_at).toBeTruthy();
        expect(exists(young.files[0]!)).toBe(true);

        const gone = await evidenceOf(t.id, old.executionId);
        expect(gone).toMatchObject({ available: false });
        expect(gone.footprint).toBeUndefined();
        expect(gone.message).toMatch(/expired and was removed on /);
        expect((await evidenceOf(t.id, young.executionId)).footprint?.pages).toEqual([{ path: "/shop", step: 1 }]);

        // The run rows themselves (history) are untouched.
        expect(platform.db.all("SELECT id FROM test_executions WHERE test_case_id = ?", t.id)).toHaveLength(2);
    });
});
