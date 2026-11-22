/**
 * Phase 7 B3: the effectiveness metrics of one trial (eval/bench/effectiveness.ts) on a hand-built trial whose values are worked out by
 * hand below; a metric without its own input is "not measured", never 0. The saved-trial reader is checked on a small platform DB.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { effectiveness, readSavedTrial, type SavedTrial } from "../src/eval/bench/effectiveness.js";
import type { BenchAppResult } from "../src/eval/bench/schema.js";

const finding = (id: string, testKey: string, category: string, defects: string[] = [], firstSeenAt: string | null = null) => ({ id, testKey, category, defects, firstSeenAt });
const trial = {
    seededDefects: ["BS-01", "BS-02"],
    findings: [finding("t1", "WEB-001", "confirmed", ["BS-01"], "2026-11-20T10:30:00.000Z"), finding("t2", "WEB-002", "confirmed", ["BS-02"], "2026-11-20T10:50:00.000Z"), finding("t3", "WEB-003", "false_positive")],
    metrics: { reproductionRate: 0.75, selectedForVerification: 4, workflows: 8, workflowsCovered: 6 },
} as unknown as BenchAppResult;
const ev = (kind: string, at: string, data: unknown = null, message = "") => ({ jobId: "j1", kind, message, data, at });
const saved: SavedTrial = {
    events: [
        ev("job_started", "2026-11-20T10:00:00.000Z"),
        ev("job_started", "2026-11-20T10:05:00.000Z"),
        // WEB-002 is named first by its message (10:20), WEB-001 by its data (10:25): the first confirmed seed is BS-02 at 20 minutes.
        ev("possible_defect", "2026-11-20T10:25:00.000Z", { testKey: "WEB-001" }),
        ev("defect_unverified", "2026-11-20T10:20:00.000Z", null, "WEB-002 Cart subtotal: not reported as a finding"),
        ev("possible_defect", "2026-11-20T10:01:00.000Z", { testKey: "WEB-003" }),
        // Scored twice: the later score counts. 4 of 5 + 2 of 4 = 6 of 9.
        ev("strength_scored", "2026-11-20T11:00:00.000Z", { testId: "WEB-010", caught: 1, total: 5 }),
        ev("strength_scored", "2026-11-20T11:10:00.000Z", { testId: "WEB-010", caught: 4, total: 5 }),
        ev("strength_scored", "2026-11-20T11:00:00.000Z", { testId: "WEB-011", caught: 2, total: 4 }),
    ],
    tests: [],
    rules: null,
    coverage: { workflowSteps: { total: 24, exercised: 6 } },
    layers: null,
};
const runs = [
    { id: "a", testId: "WEB-010", firstRun: "passed", reruns: ["passed", "passed"] },
    { id: "b", testId: "WEB-011", firstRun: "passed", reruns: ["failed", "not_run"] },
    { id: "c", testId: "WEB-001", firstRun: "failed", reruns: ["failed", "failed"] },
];

describe("effectiveness", () => {
    it("gives the hand-computed values", () => {
        const e = effectiveness({ ...trial, verification: { findings: [], added: { cost: null, durationMs: null } } } as BenchAppResult, saved, runs as never);
        expect(e.timeToFirstConfirmedSeed).toEqual({ measured: true, value: 20 * 60_000, seed: "BS-02", testKey: "WEB-002" });
        // The saved suite: a and b passed when made (c did not). Runs that ran: a 2 passed, b 1 failed: 2 of 3, b unstable.
        expect(e.stability).toEqual({ measured: true, value: 2 / 3, n: 3, tests: 2, unstable: ["WEB-011"] });
        expect(e.workflowCoverage).toEqual({ record: { measured: true, value: 0.25, n: 24 }, catalogue: { value: 0.75, n: 8 } });
        expect(e.mutationScore).toEqual({ measured: true, value: 6 / 9, n: 9, tests: 2 });
        expect(e.reproduction.replay).toEqual({ value: 0.75, n: 4 });
        expect(e.reproduction.verification).toEqual({ measured: true, value: null, n: 0, note: "Verification decided no finding." });
    });

    it("reads Phase 5 reproduction: reproduced and what follows it, over the findings verification decided", () => {
        const f = (state: string) => ({ id: state, testId: null, state, reason: null, groupId: null, findingClass: null, confidence: null });
        const v = { findings: ["reproduced", "confirmed", "reported", "unconfirmed", "flaky", "duplicate", "candidate", "verification_pending"].map(f), added: { cost: null, durationMs: null } };
        // Decided: reproduced, confirmed, reported, unconfirmed, flaky (duplicate and unfinished ones left out): 3 of 5.
        expect(effectiveness({ ...trial, verification: v } as BenchAppResult, saved).reproduction.verification).toEqual({ measured: true, value: 3 / 5, n: 5 });
    });

    it("says not measured for each metric whose input is missing, never 0", () => {
        const e = effectiveness(trial, undefined, undefined);
        expect(e.timeToFirstConfirmedSeed.measured).toBe(false);
        expect(e.stability.measured).toBe(false);
        expect(e.workflowCoverage.record.measured).toBe(false);
        expect(e.mutationScore.measured).toBe(false);
        expect(e.reproduction.verification.measured).toBe(false);
        // Events without a job start; a suite with no rerun; no strength score.
        const bare = effectiveness(trial, { ...saved, events: [ev("possible_defect", "2026-11-20T10:00:00.000Z")], coverage: null }, [{ id: "a", testId: "WEB-010", firstRun: "passed", reruns: ["not_run"] }] as never);
        expect(bare.timeToFirstConfirmedSeed.measured).toBe(false);
        expect(bare.stability.measured).toBe(false);
        expect(bare.mutationScore.measured).toBe(false);
    });

    it("measures no confirmed seed as a time of null with its reason, and falls back to the platform's first failure", () => {
        const none = effectiveness({ ...trial, findings: [finding("t3", "WEB-003", "false_positive")] } as unknown as BenchAppResult, saved);
        expect(none.timeToFirstConfirmedSeed).toEqual({ measured: true, value: null, seed: null, testKey: null, note: "No seed was confirmed." });
        // No event names WEB-001: its first failure (10:30) from the job start (10:00).
        const quiet = effectiveness({ ...trial, findings: [trial.findings[0]] } as unknown as BenchAppResult, { ...saved, events: saved.events.filter((e) => e.kind === "job_started") });
        expect(quiet.timeToFirstConfirmedSeed).toMatchObject({ measured: true, value: 30 * 60_000, seed: "BS-01" });
        // A confirmed finding pinned to a defect not seeded in this trial is not a seed.
        const other = effectiveness({ ...trial, findings: [finding("t9", "WEB-009", "confirmed", ["BS-07"], "2026-11-20T10:10:00.000Z")] } as unknown as BenchAppResult, saved);
        expect(other.timeToFirstConfirmedSeed).toMatchObject({ value: null, note: "No seed was confirmed." });
    });
});

describe("readSavedTrial", () => {
    it("reads one project's jobs, events, tests, rules, coverage record and layer report, read-only", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saved-trial-"));
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
        const db = new DatabaseSync(path.join(dir, "platform.db"));
        db.exec(`CREATE TABLE generation_jobs (id TEXT, project_id TEXT);
            CREATE TABLE agent_events (id INTEGER PRIMARY KEY, job_id TEXT, kind TEXT, message TEXT, data_json TEXT, created_at TEXT);
            CREATE TABLE test_cases (id TEXT, project_id TEXT, test_key TEXT, title TEXT, validation_status TEXT, validation_reason TEXT, generation_meta_json TEXT);
            CREATE TABLE artifacts (project_id TEXT, job_id TEXT, kind TEXT, path TEXT, created_at TEXT, pruned_at TEXT);
            INSERT INTO generation_jobs VALUES ('j1','p1'),('j2','p2');
            INSERT INTO agent_events (job_id, kind, message, data_json, created_at) VALUES ('j1','job_started','go',NULL,'2026-11-20T10:00:00.000Z'),('j1','strength_scored','m','{"testId":"WEB-1","caught":1,"total":2}','2026-11-20T10:01:00.000Z'),('j2','job_started','other project',NULL,'2026-11-20T09:00:00.000Z');
            INSERT INTO test_cases VALUES ('t1','p1','WEB-1','A','NEEDS_REVIEW','why','{"authoring":"defect"}'),('t2','p2','WEB-1','B','VALIDATED',NULL,NULL);
            INSERT INTO artifacts VALUES ('p1','j1','exploration','p1/_artifacts/j1/exploration.json','2026-11-20T10:02:00.000Z',NULL),('p1','j1','layer-report','p1/_artifacts/j1/layers.json','2026-11-20T10:02:00.000Z',NULL);`);
        db.close();
        fs.mkdirSync(path.join(dir, "generated-tests/p1/_artifacts/j1"), { recursive: true });
        fs.writeFileSync(path.join(dir, "generated-tests/p1/_artifacts/j1/exploration.json"), JSON.stringify({ coverage: { workflowSteps: { total: 4, exercised: 1, notExercised: [], more: 0 } } }));
        const layers = { page: { status: "ran", tests: 3 }, api: { status: "unavailable", reason: "Not checked: no API test was made." }, storedData: { status: "unavailable", reason: "x" }, database: { status: "unavailable", reason: "y" } };
        fs.writeFileSync(path.join(dir, "generated-tests/p1/_artifacts/j1/layers.json"), JSON.stringify(layers));
        const before = fs.readFileSync(path.join(dir, "platform.db"));

        const s = readSavedTrial(dir, "p1");
        expect(s.events.map((e) => e.kind)).toEqual(["job_started", "strength_scored"]);
        expect(s.events[1]!.data).toEqual({ testId: "WEB-1", caught: 1, total: 2 });
        expect(s.tests).toEqual([{ id: "t1", key: "WEB-1", title: "A", validationStatus: "NEEDS_REVIEW", validationReason: "why", meta: { authoring: "defect" } }]);
        expect(s.rules).toBeNull(); // the DB has no app_rules table: not recorded
        expect(s.coverage?.workflowSteps).toMatchObject({ total: 4, exercised: 1 });
        expect(s.layers).toEqual(layers);
        expect(fs.readFileSync(path.join(dir, "platform.db")).equals(before)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
