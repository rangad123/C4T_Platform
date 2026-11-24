/**
 * The Responsive UI agent's screen sizes (Agent Workspace W2c, gaps 1 and 2):
 *
 *   - a Responsive UI run checks a phone (375) and a tablet (768) beside the desktop base run (1280), unless it names its sizes;
 *     other agents' runs get no sizes;
 *   - on those two sizes its visual checks are repeated too (one picture per page per size), each size in a Playwright run of its own,
 *     because the pictures of all sizes share one name; on any other variant a visual check is still not repeated;
 *   - a repeat on those sizes keeps its picture when it passes, not only when it fails; other variants keep nothing on a pass.
 *
 * Browser-free (the executor is a stand-in): node scripts/with-lock.mjs tsc -- npx vitest run tests/responsive-sizes.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { runVariantChecks, SIZE_VARIANT_IDS, VARIANTS, variantEligibility, variantFits, type VariantRecord } from "../src/engine/validation/variants.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { agentRunOptions } from "../src/platform/testing-agents.js";
import { seedProject } from "./fixtures/dashboard-seed.js";

const visual = TestSpecSchema.parse({ testId: "WEB-001", title: "Home looks the same (/)", kind: "web", type: "visual", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "screenshot", expected: 100 }] });
const journey = TestSpecSchema.parse({ testId: "WEB-002", title: "Open products", kind: "web", steps: [{ action: "navigate", url: "/products" }, { action: "assert", check: "visible", locator: { by: "text", value: "Products" } }] });
const NOT_REPEATED = /Visual comparisons use one approved screenshot/;

let platform: Platform;
let dir = "";
beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sizes-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "responsive-sizes-secret-0123456789", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" } as never));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Responsive UI run's sizes", () => {
    it("are a phone 375 wide and a tablet 768 wide, beside the desktop base run 1280 wide", () => {
        expect(SIZE_VARIANT_IDS).toEqual(["phone-375", "tablet-768"]);
        expect(VARIANTS["phone-375"]).toMatchObject({ label: "Phone", browser: "chromium", viewport: { width: 375 } });
        expect(VARIANTS["tablet-768"]).toMatchObject({ label: "Tablet", browser: "chromium", viewport: { width: 768 } });
        expect(VARIANTS["chromium-desktop"].viewport.width).toBe(1280);
    });

    it("are on by default for a Responsive UI run, as named when the run names them, and never for another agent", () => {
        const o = { ...DEFAULT_JOB_OPTIONS };
        expect(agentRunOptions("responsive-ui", o, {}).variants).toEqual(["phone-375", "tablet-768"]);
        expect(agentRunOptions("responsive-ui", { ...o, variants: ["tablet-768"] }, { variants: ["tablet-768"] }).variants).toEqual(["tablet-768"]);
        // Both unticked: desktop only.
        expect(agentRunOptions("responsive-ui", o, { variants: [] }).variants ?? []).toEqual([]);
        expect(agentRunOptions("security", o, {}).variants ?? []).toEqual([]);
        expect(agentRunOptions("accessibility", o, {}).variants ?? []).toEqual([]);
    });

    it("repeat a visual check on those sizes only; elsewhere it stays not repeated, as before", () => {
        expect(variantEligibility(visual, "VALIDATED").eligible).toBe(false);
        expect(variantEligibility(visual, "VALIDATED", { pictures: true }).eligible).toBe(true);
        // A changed page is pictured on the other sizes too.
        expect(variantEligibility(visual, "NEEDS_REVIEW", { pictures: true }).eligible).toBe(true);
        expect(variantFits("phone-375", visual).fits).toBe(true);
        const other = variantFits("mobile-chrome", visual);
        expect(other.fits).toBe(false);
        expect(!other.fits && other.reason).toMatch(NOT_REPEATED);
        expect(variantFits("phone-375", journey).fits).toBe(true);
    });
});

describe("runVariantChecks on the sizes", () => {
    const run = async (requested: string[], statuses: Record<string, string> = {}) => {
        const calls: string[][] = [];
        const records: Array<{ testId: string; r: VariantRecord }> = [];
        const executor = {
            name: "stand-in",
            execute: async (_f: string, batch: { scripts: Array<{ testId: string }> }, _e: unknown, o: { projects?: Array<{ name: string }> }) => {
                calls.push((o.projects ?? []).map((p) => p.name));
                return batch.scripts.flatMap((s) => (o.projects ?? []).map((p) => ({ testId: s.testId, variant: p.name, status: "passed", durationMs: 5, failedStepIndex: -1, steps: [], artifacts: [{ kind: "screenshot", path: "/x.png" }], responses: [] }) as unknown as ScriptRun));
            },
        };
        const ctx = { emit: () => undefined, signal: undefined } as never;
        await runVariantChecks(
            ctx,
            { scratchDir: dir, env: { baseUrl: "http://127.0.0.1:9" } as never, render: { baseUrl: "http://127.0.0.1:9" } as never, workers: 2, executor: executor as never, detect: () => ({ chromium: true, firefox: true, webkit: true }), sink: { counters: async () => undefined, recordVariant: async (h, _s, r) => void records.push({ testId: h.testId, r }) } },
            [visual, journey].map((spec) => ({ handle: { id: spec.testId, testId: spec.testId }, spec, validationStatus: statuses[spec.testId] ?? "VALIDATED" })),
            requested,
        );
        return { calls, records };
    };

    it("pictures every page on each size, one size per Playwright run, pass or not on desktop", async () => {
        const { calls, records } = await run(["phone-375", "tablet-768"], { "WEB-001": "NEEDS_REVIEW" });
        expect(calls).toEqual([["phone-375"], ["tablet-768"]]);
        expect(records.map((x) => `${x.testId} ${x.r.variant} ${x.r.status}`).sort()).toEqual(["WEB-001 phone-375 passed", "WEB-001 tablet-768 passed", "WEB-002 phone-375 passed", "WEB-002 tablet-768 passed"]);
    });

    it("leaves other variants as they were: the visual check is not repeated, the others run together", async () => {
        const { calls, records } = await run(["mobile-chrome", "tablet"]);
        expect(calls).toEqual([["mobile-chrome", "tablet"]]);
        const v = records.filter((x) => x.testId === "WEB-001");
        expect(v.map((x) => x.r.status)).toEqual(["skipped", "skipped"]);
        expect(v[0]!.r.reason).toMatch(NOT_REPEATED);
    });
});

describe("what a repeat keeps", () => {
    it("keeps the picture of a passed repeat on the sizes, and nothing of a passed repeat elsewhere", async () => {
        const s = seedProject(platform, "Sizes shop", "http://127.0.0.1:9");
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        const h = await sink.createTest({ spec: visual, framework: "playwright", validation: "PENDING", meta: { visual: true } });
        await sink.writes.flush();
        const png = path.join(dir, "shot.png");
        fs.writeFileSync(png, "png");
        const passed = (variant: string): VariantRecord => ({ variant: variant as never, status: "passed", run: { testId: "WEB-001", status: "passed", durationMs: 5, failedStepIndex: -1, steps: [], responses: [], artifacts: [{ kind: "screenshot", path: png }, { kind: "video", path: png }] } as unknown as ScriptRun });
        await sink.recordVariant!(h, null, passed("phone-375"), new Date().toISOString());
        await sink.recordVariant!(h, null, passed("mobile-chrome"), new Date().toISOString());
        const kept = platform.repo.db.all<{ variant: string; kind: string }>("SELECT e.variant, a.kind FROM artifacts a JOIN test_executions e ON e.id = a.execution_id WHERE a.test_case_id = ?", h.id);
        expect(kept).toEqual([{ variant: "phone-375", kind: "screenshot" }]);
    });
});
