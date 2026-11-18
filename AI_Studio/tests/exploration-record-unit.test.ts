/**
 * Row 184: the coverage record of an exploration by objectives on a runner. The runner's explore result carries it (ResultRequest
 * explore.exploration); it is checked against ExplorationRecord on both ends: its shape, the action log's 2,000 rows and a byte cap.
 */
import { describe, expect, it } from "vitest";
import { EXPLORATION_ACTION_LOG_MAX, EXPLORATION_MAX_BYTES, ExplorationRecord, parseExploration } from "../src/agent-protocol/exploration.js";
import { ResultRequest } from "../src/agent-protocol/schema.js";
import { memoryLogger } from "../src/agent/log.js";
import { explorationForResult } from "../src/agent/task-runner.js";
import { ACTION_LOG_CAP, type ExplorationSummary } from "../src/engine/orchestrator.js";
import { sampleExploration } from "./fixtures/exploration-record.js";

const row = (seq: number, action = "click") => ({ seq, objectiveId: "OBJ-0123456789abcdef:as_stated", state: "/products|abc123abc123", action, atMs: seq, result: "performed" as const });
const explore = { testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };

describe("the coverage record in a runner's explore result", () => {
    it("a record as the engine writes it is kept whole, and it is the engine's ExplorationSummary", () => {
        const r = parseExploration(sampleExploration());
        expect(r).toEqual({ ok: true, value: sampleExploration() });
        // Both ways at the type level: what the platform keeps is an ExplorationSummary, and the engine's record is what the schema reads.
        const kept: ExplorationSummary | undefined = r.ok ? r.value : undefined;
        const asWire: ExplorationRecord = sampleExploration();
        expect(kept).toEqual(asWire);
        expect(EXPLORATION_ACTION_LOG_MAX).toBe(ACTION_LOG_CAP);
    });

    it("a malformed record is refused with a short reason; a field it does not know is dropped, not refused", () => {
        expect(parseExploration({ ...sampleExploration(), stopReason: "bored" })).toMatchObject({ ok: false, problem: expect.stringMatching(/^stopReason: /) });
        const { coverage: _c, ...noCoverage } = sampleExploration();
        expect(parseExploration(noCoverage)).toMatchObject({ ok: false, problem: expect.stringMatching(/^coverage: /) });
        expect(parseExploration("a sentence")).toMatchObject({ ok: false });
        expect(parseExploration(null)).toMatchObject({ ok: false });
        expect(parseExploration({ ...sampleExploration(), actionLog: [{ ...row(1), result: "maybe" }] })).toMatchObject({ ok: false, problem: expect.stringMatching(/^actionLog\.0\.result: /) });
        const newer = parseExploration({ ...sampleExploration(), fromANewerEngine: { x: 1 } });
        expect(newer.ok && newer.value).toEqual(sampleExploration());
    });

    it("the action log is at most 2,000 rows, and the whole record at most EXPLORATION_MAX_BYTES of JSON", () => {
        expect(parseExploration(sampleExploration({ actionLog: Array.from({ length: 2_000 }, (_, i) => row(i)) })).ok).toBe(true);
        expect(parseExploration(sampleExploration({ actionLog: Array.from({ length: 2_001 }, (_, i) => row(i)) }))).toMatchObject({ ok: false, problem: expect.stringMatching(/^actionLog: /) });
        // Every row is well formed (each action within its own length cap); only the size of the whole is too much.
        const long = "x".repeat(1_100);
        const under = sampleExploration({ actionLog: Array.from({ length: 1_500 }, (_, i) => row(i, long)) });
        const over = sampleExploration({ actionLog: Array.from({ length: 2_000 }, (_, i) => row(i, long)) });
        expect(Buffer.byteLength(JSON.stringify(under))).toBeLessThan(EXPLORATION_MAX_BYTES);
        expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(EXPLORATION_MAX_BYTES);
        expect(parseExploration(under).ok).toBe(true);
        expect(parseExploration(over)).toEqual({ ok: false, problem: "it is larger than 2 MB" });
    });

    it("the result's field takes any value (checked on arrival, so a bad record never refuses the result), and a field it does not know is dropped", () => {
        for (const exploration of [sampleExploration(), { stopReason: "bored" }, "junk", undefined]) {
            const r = ResultRequest.safeParse({ ok: true, runs: [], explore: { ...explore, exploration } });
            expect(r.success).toBe(true);
            expect(r.data?.explore?.exploration).toEqual(exploration);
        }
        // What an older platform does with this field: its explore object is not strict, so an unknown field is stripped, never refused.
        const future = ResultRequest.safeParse({ ok: true, runs: [], explore: { ...explore, somethingNewer: { a: 1 } }, alsoNewer: true });
        expect(future.success).toBe(true);
        expect(future.data?.explore).toEqual(explore);
        expect(future.data).not.toHaveProperty("alsoNewer");
    });

    it("the runner sends a good record with its text masked, and leaves a bad one out with a line in its log", () => {
        const { log, lines } = memoryLogger();
        log.addSecrets(["s3cret-Pass"]);
        const record = sampleExploration({ actionLog: [row(1, 'fill {"target":"Password","value":"s3cret-Pass"}')] });
        const sent = explorationForResult(record, log, "task-1");
        expect(sent.exploration?.actionLog[0]!.action).toBe('fill {"target":"Password","value":"***"}');
        expect(JSON.stringify(sent)).not.toContain("s3cret-Pass");
        expect(sent.exploration?.coverage).toEqual(record.coverage);
        expect(lines).toEqual([]);
        expect(explorationForResult(undefined, log, "task-1")).toEqual({});
        expect(explorationForResult({ ...record, stopReason: "bored" }, log, "task-1")).toEqual({});
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/WARN .*Task task-1: the coverage record was left out \(stopReason: /);
        // What it sends passes the result's own check.
        expect(ResultRequest.safeParse({ ok: true, runs: [], explore: { ...explore, ...sent } }).success).toBe(true);
    });
});
