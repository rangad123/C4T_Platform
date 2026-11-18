/**
 * A person's labels are bound to the trial they were made for (src/eval/bench/labels.ts): test keys (WEB-028) repeat across trials, so a
 * label applies only to the result whose app has the project the label names. Old files (keys `<app>/<testKey>` only) are refused with a
 * sentence, and the migration binds one to its result without changing a label. Pure functions plus the read-only command on a temporary
 * folder: no app, platform or model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { benchReportMain } from "../src/eval/bench/cli.js";
import { bindLabels, migrateLabels, parseLabels } from "../src/eval/bench/labels.js";
import { categorize } from "../src/eval/bench/metrics.js";
import { withLabels } from "../src/eval/bench/observed.js";
import type { BenchFinding, Benchmark } from "../src/eval/bench/schema.js";

const unverified = (testKey: string): BenchFinding => {
    const replay = { seeded: "passed" as const, clean: null, single: {} };
    return { id: `id-${testKey}`, testKey, title: `Test ${testKey}`, source: "authoring", replay, ...categorize(replay), firstSeenAt: null };
};
const metrics = { seeded: 1, detected: 0, missed: 1, detectedLabeled: 0, findings: 1, truePositives: 0, falsePositives: 0, unreproduced: 1, selectedForVerification: 1, reproduced: 0, detectionRate: 0, precision: 0, precisionVerified: null, falsePositiveRate: 0, reproductionRate: 0, detectionTimeMs: null, cost: null, costPerConfirmedDefect: null, testsGenerated: 1, workflows: 1, workflowsCovered: 1, executionFailures: 0, flaky: 0, durationMs: 1, aiCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** One trial of bench-shop: its project id stands for the trial; both trials below have a WEB-028. */
const trial = (projectId: string | undefined, keys = ["WEB-028"]): Benchmark => ({
    format: 1,
    mode: "discovery",
    baseline: false,
    config: {
        engineCommit: "abc1234",
        engineDirty: false,
        prompts: [],
        model: { provider: "scripted", model: "m", fastModel: null, planningModel: null, temperature: "default" },
        catalogueVersion: "2026-11-14.1",
        apps: [{ id: "bench-shop", version: "v1" }],
        options: {},
        prices: null,
        approvedBudget: null,
        dailyCallCap: null,
        resumes: 0,
        runtime: { node: "v24", platform: "linux" },
    },
    apps: [{ id: "bench-shop", entryId: "bench-shop", ...(projectId ? { projectId } : {}), status: "done", appVersion: "v1", seededDefects: ["BS-06"], defects: [], findings: keys.map(unverified), metrics }],
    metrics,
    notes: [],
});
const A = "11111111-aaaa-4aaa-8aaa-111111111111";
const B = "22222222-bbbb-4bbb-8bbb-222222222222";
const v2 = { format: 2, _APPROVED: "Owner approved", trials: [{ result: "eval/results/a/x-benchmark-discovery.json", startedAt: "2026-11-16T19:52:25.836Z", projects: { "bench-shop": A }, labels: { "bench-shop/WEB-028": "BS-06" } }] };
const OLD = { "bench-shop/WEB-028": "BS-06", "bench-shop/WEB-030": "false_positive", _APPROVED: "Owner approved 2026-11-17" };
const labelOf = (b: Benchmark, key = "WEB-028") => b.apps[0]!.findings.find((x) => x.testKey === key)?.label;

describe("labels are bound to their trial", () => {
    it("the same test key in two trials: only the labelled trial gets the label, the other says a label for another trial was ignored", () => {
        const set = parseLabels(v2, "labels.json");
        const a = withLabels(trial(A), set);
        const b = withLabels(trial(B), set);
        expect(labelOf(a.benchmark)).toBe("BS-06");
        expect(a.notes).toEqual([]);
        expect(labelOf(b.benchmark)).toBeUndefined();
        expect(b.notes.join("\n")).toMatch(/1 label for another trial ignored/);
    });

    it("a result with no project id (written before results kept one) gets no label, and says why", () => {
        const r = withLabels(trial(undefined), parseLabels(v2, "labels.json"));
        expect(labelOf(r.benchmark)).toBeUndefined();
        expect(r.notes.join("\n")).toMatch(/bench-shop has no project id/);
    });

    it("binding by app list (a resumed run): only the apps whose project the label names", () => {
        const set = parseLabels(v2, "labels.json");
        expect(bindLabels(set, [{ id: "bench-shop", projectId: A }]).labels).toEqual({ "bench-shop/WEB-028": "BS-06" });
        expect(bindLabels(set, [{ id: "bench-shop", projectId: B }]).labels).toEqual({});
    });

    it("an old-format file (keys <app>/<testKey> only) is refused with a sentence, never applied to every trial", () => {
        expect(() => parseLabels(OLD, "d1-p1.json")).toThrow(/d1-p1\.json is an old labels file.*which trial/s);
    });

    it("a label for an app the trial entry has no project for is a bad file", () => {
        const bad = { format: 2, trials: [{ projects: { "bench-shop": A }, labels: { "other-app/WEB-001": "false_positive" } }] };
        expect(() => parseLabels(bad, "x.json")).toThrow(/other-app/);
    });
});

describe("migrating an old labels file to its trial", () => {
    const run = (b: Benchmark) => ({ format: 1, startedAt: "2026-11-16T19:52:25.836Z", finishedAt: "2026-11-17T02:05:52.054Z", benchmark: b });

    it("binds every label to the result's project and keeps each label and the approval as they were", () => {
        const out = migrateLabels(OLD, run(trial(A, ["WEB-028", "WEB-030"])), "eval/results/a/x-benchmark-discovery.json", "d1-p1.json");
        expect(out).toEqual({
            format: 2,
            _APPROVED: "Owner approved 2026-11-17",
            migratedFrom: "d1-p1.json",
            trials: [{ result: "eval/results/a/x-benchmark-discovery.json", startedAt: "2026-11-16T19:52:25.836Z", projects: { "bench-shop": A }, labels: { "bench-shop/WEB-028": "BS-06", "bench-shop/WEB-030": "false_positive" } }],
        });
        expect(parseLabels(out, "d1-p1.v2.json").trials[0]!.labels).toEqual({ "bench-shop/WEB-028": "BS-06", "bench-shop/WEB-030": "false_positive" });
    });

    it("refuses a result that does not have every labelled finding (the labels were made for another trial)", () => {
        expect(() => migrateLabels(OLD, run(trial(A, ["WEB-028"])), "r.json", "d1-p1.json")).toThrow(/WEB-030/);
    });

    it("refuses a result with no project id to bind to", () => {
        expect(() => migrateLabels(OLD, run(trial(undefined, ["WEB-028", "WEB-030"])), "r.json", "d1-p1.json")).toThrow(/project id/);
    });
});

describe("bench-report --labels", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const folder = (files: Record<string, unknown>): string => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), "bench-labels-"));
        dirs.push(d);
        for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify(body));
        return d;
    };
    const run = (b: Benchmark) => ({ format: 1, startedAt: "2026-11-17T01:29:00.000Z", finishedAt: "2026-11-17T02:00:00.000Z", benchmark: b });
    const cli = async (argv: string[]) => {
        const lines: string[] = [];
        const code = await benchReportMain(argv, { log: (s) => lines.push(s) });
        return { code, out: lines.join("\n") };
    };

    it("two trials with the same test key: the label shows only on its trial, and the other trial's report notes it was ignored", async () => {
        const one = folder({ "a-benchmark-discovery.json": run(trial(A)) });
        const two = folder({ "b-benchmark-discovery.json": run(trial(B)) });
        const labels = path.join(folder({ "l.json": v2 }), "l.json");
        const r = await cli(["--observed", one, two, "--labels", labels]);
        expect(r.code).toBe(0);
        const [first, second] = r.out.split(/^### /m).slice(1);
        expect(first).toMatch(/\| bench-shop \| WEB-028 \|.*\| BS-06 \|/);
        expect(second).not.toMatch(/BS-06/);
        expect(second).toMatch(/label for another trial ignored/);
    });

    it("an old-format labels file: exit 2 with the reason, nothing printed as labelled", async () => {
        const one = folder({ "a-benchmark-discovery.json": run(trial(A)) });
        const labels = path.join(folder({ "d1-p1.json": OLD }), "d1-p1.json");
        const r = await cli(["--observed", one, "--labels", labels]);
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/old labels file/);
        expect(r.out).not.toMatch(/Observed vs fails on the seeded app/);
    });

    it("--migrate-labels writes the bound copy next to the original and leaves the original untouched", async () => {
        const result = path.join(folder({ "a-benchmark-discovery.json": run(trial(A, ["WEB-028", "WEB-030"])) }), "a-benchmark-discovery.json");
        const dir = folder({ "d1-p1.json": OLD });
        const original = fs.readFileSync(path.join(dir, "d1-p1.json"), "utf8");
        const to = path.join(dir, "d1-p1.v2.json");
        const r = await cli(["--migrate-labels", path.join(dir, "d1-p1.json"), "--result", result, "--to", to]);
        expect(r.code).toBe(0);
        expect(fs.readFileSync(path.join(dir, "d1-p1.json"), "utf8")).toBe(original);
        const out = JSON.parse(fs.readFileSync(to, "utf8"));
        expect(out.trials[0].projects).toEqual({ "bench-shop": A });
        expect(out.trials[0].labels).toEqual({ "bench-shop/WEB-028": "BS-06", "bench-shop/WEB-030": "false_positive" });
        // Never overwrites a copy already there.
        expect((await cli(["--migrate-labels", path.join(dir, "d1-p1.json"), "--result", result, "--to", to])).code).toBe(2);
    });
});
