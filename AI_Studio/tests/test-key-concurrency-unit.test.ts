/**
 * A new test's key (WEB-003) is taken when the test is saved, so concurrent writers never meet on it (queue row 164). In the C1 calibration
 * 7 of 74 scenarios failed on "UNIQUE constraint failed: test_cases.project_id, test_cases.test_key": the engine asks for the next key,
 * a defect scenario then replays its failure twice in fresh browsers (~11 s), and another scenario of the same job asks for a key and
 * saves its test meanwhile, with the same key. Here the same order runs through the real sink and database, without browsers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";

const later = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

let platform: Platform;
let dataDir: string;

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-test-key-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
});

afterAll(() => {
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const project = () => {
    const { repo } = platform;
    const projectId = repo.createProject({ name: `Keys ${Math.random()}` }).id as string;
    const applicationId = repo.createApplication(projectId, "http://127.0.0.1:1", { ...DEFAULT_JOB_OPTIONS }, undefined);
    return { projectId, applicationId };
};
const jobIn = async (p: { projectId: string; applicationId: string }) => {
    const job = await platform.repo.createJob(p.projectId, p.applicationId, { ...DEFAULT_JOB_OPTIONS });
    return { id: job.id, projectId: p.projectId, applicationId: p.applicationId };
};
const spec = (testId: string, title: string): TestSpec =>
    TestSpecSchema.parse({ testId, title, kind: "web", steps: [{ action: "navigate", url: "/" }], source: { origin: "browser-agent" } });
const stored = (projectId: string) =>
    platform.repo.db
        .all<{ test_key: string; title: string; spec_json: string }>("SELECT test_key, title, spec_json FROM test_cases WHERE project_id = ? ORDER BY test_key", projectId)
        .map((r) => ({ key: r.test_key, title: r.title, specKey: (JSON.parse(r.spec_json) as TestSpec).testId }));

describe("a new test's key", () => {
    it("is never taken twice when a scenario saves while another sits between taking its key and saving (the defect's independence check)", async () => {
        const p = project();
        // Two jobs of the project: within one job the sink never hands a key out twice (main's handed keys), so the key a defect asked for
        // can still be taken before it saves only by another job's sink.
        const sink = new RepoSink(platform.repo, platform.store, await jobIn(p));
        const other = new RepoSink(platform.repo, platform.store, await jobIn(p));
        // Scenario A found a defect: it takes its key, then replays the failure before saving.
        const defect = (async () => {
            const key = await sink.nextTestKey("WEB");
            await later(20);
            return sink.createTest({ spec: spec(key, "The cart total is wrong"), framework: "playwright", validation: "NEEDS_REVIEW", reason: "defect" });
        })();
        // Scenario B, meanwhile: takes a key and saves at once.
        const plain = (async () => {
            await later(5);
            const key = await other.nextTestKey("WEB");
            return other.createTest({ spec: spec(key, "Open the cart"), framework: "playwright", validation: "PENDING" });
        })();
        const [a, b] = await Promise.all([defect, plain]);
        expect(new Set([a.testId, b.testId]).size).toBe(2);
        // The handle names the key the test was saved under, and its stored spec says the same.
        expect(stored(p.projectId)).toEqual([
            { key: b.testId, title: "Open the cart", specKey: b.testId },
            { key: a.testId, title: "The cart total is wrong", specKey: a.testId },
        ]);
        expect([a.testId, b.testId].sort()).toEqual(["WEB-001", "WEB-002"]);
    });

    it("holds for many scenarios at once, and for two jobs of the same project", async () => {
        const p = project();
        const sinks = [new RepoSink(platform.repo, platform.store, await jobIn(p)), new RepoSink(platform.repo, platform.store, await jobIn(p))];
        const handles = await Promise.all(
            Array.from({ length: 12 }, async (_, i) => {
                const sink = sinks[i % 2]!;
                const key = await sink.nextTestKey("WEB");
                await later(i % 3 === 0 ? 15 : 1);
                return sink.createTest({ spec: spec(key, `Scenario ${i}`), framework: "playwright", validation: "PENDING" });
            }),
        );
        const keys = handles.map((h) => h.testId);
        expect(new Set(keys).size).toBe(12);
        const rows = stored(p.projectId);
        expect(rows.map((r) => r.key).sort()).toEqual([...keys].sort());
        for (const r of rows) expect(r.specKey).toBe(r.key);
    });

    it("keeps the saved key when the engine later writes the test's steps with the key it asked for", async () => {
        const p = project();
        const sink = new RepoSink(platform.repo, platform.store, await jobIn(p));
        const first = await sink.nextTestKey("WEB");
        await sink.createTest({ spec: spec(first, "Taken first"), framework: "playwright", validation: "PENDING" });
        const h = await sink.createTest({ spec: spec(first, "Asked for the same key"), framework: "playwright", validation: "PENDING" });
        expect(h.testId).toBe("WEB-002");
        await sink.updateTest(h, { spec: spec(first, "Asked for the same key"), validation: "VALIDATED" });
        expect(stored(p.projectId).find((r) => r.title === "Asked for the same key")).toEqual({ key: "WEB-002", title: "Asked for the same key", specKey: "WEB-002" });
    });
});
