/**
 * Task R, R4: the job's AI call summary (no new table): per purpose, latency and output tokens (median, 95th percentile) and how many
 * answers needed which repair, with the job's stored and uploaded bytes. A scripted client sets each call's time, tokens and repair; the
 * summary must give back exactly that script.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineEvent } from "../src/engine/context.js";
import { percentile } from "../src/engine/llm/health.js";
import { JobMeter, type MeterBackend } from "../src/engine/llm/metered.js";
import { countStructured, type LlmClient } from "../src/engine/llm/provider.js";
import { Db } from "../src/platform/db.js";
import { DEFAULT_JOB_OPTIONS, Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { meterFor } from "../src/platform/usage-store.js";

type Step = { ms: number; out: number; repair?: "cleaned" | "partial" | "reasked" | "failed"; dropped?: number };

/** A client whose calls move a fake clock by `ms` and the usage counters as the step says. */
function scripted(steps: Step[], clock: { t: number }): LlmClient {
    const usage: LlmClient["usage"] = { inputTokens: 0, outputTokens: 0 };
    const call = async () => {
        const s = steps.shift()!;
        clock.t += s.ms;
        usage.inputTokens += 10;
        usage.outputTokens += s.out;
        if (s.repair === "reasked" || s.repair === "failed") usage.repairs = (usage.repairs ?? 0) + 1;
        if (s.repair && s.repair !== "reasked") countStructured(usage, s.repair);
        if (s.dropped) countStructured(usage, "itemsDropped", s.dropped);
        if (s.repair === "failed") throw Object.assign(new Error("no structured output"), { name: "LlmCallError", cls: "bad_output" });
        return { ok: true };
    };
    return { modelName: "m", model: {} as never, usage, object: call as unknown as LlmClient["object"], text: async () => (await call(), "t") };
}
const backend = (bytes?: { artifactBytes: number; uploadBytes: number }): MeterBackend => ({
    addUsage: () => {},
    totalsFor: () => ({ job: 0, project: 0, month: 0 }),
    capsFor: () => ({ caps: {}, warnPercent: 80 }),
    recordStop: () => {},
    ...(bytes ? { runBytes: () => bytes } : {}),
});

describe("percentile", () => {
    it("is the nearest rank", () => {
        const v = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
        expect(percentile(v, 50)).toBe(5);
        expect(percentile(v, 95)).toBe(10);
        expect(percentile([7], 95)).toBe(7);
        expect(percentile([], 50)).toBe(0);
    });
});

describe("the job's AI call summary", () => {
    it("gives back the scripted latency, output tokens and repairs per purpose", async () => {
        const clock = { t: 1_000_000 };
        const planning: Step[] = [
            { ms: 100, out: 1000 },
            { ms: 300, out: 3000, repair: "partial", dropped: 2 },
            { ms: 200, out: 2000, repair: "cleaned" },
            { ms: 900, out: 9000, repair: "reasked" },
        ];
        const repair: Step[] = [
            { ms: 50, out: 40 },
            { ms: 70, out: 0, repair: "failed" },
        ];
        const events: EngineEvent[] = [];
        const meter = new JobMeter({ backend: backend({ artifactBytes: 1234, uploadBytes: 567 }), jobId: "j", projectId: "p", emit: (e) => void events.push(e), now: () => new Date(clock.t) });
        const llm = meter.wrap(scripted([...planning, ...repair], clock));
        for (let i = 0; i < planning.length; i++) await llm.object({ system: "s", prompt: "p", schema: {} as never, purpose: "planning" });
        await llm.object({ system: "s", prompt: "p", schema: {} as never, purpose: "repair" });
        await llm.object({ system: "s", prompt: "p", schema: {} as never, purpose: "repair" }).catch(() => undefined);
        meter.finish();

        const summary = events.filter((e) => e.kind === "ai_call_summary");
        expect(summary).toHaveLength(1);
        expect(summary[0]!.data).toEqual({
            artifactBytes: 1234,
            uploadBytes: 567,
            purposes: {
                planning: { calls: 4, failed: 0, latencyMs: { p50: 200, p95: 900 }, outputTokens: { p50: 2000, p95: 9000, total: 15000 }, repairs: { partial: 1, cleaned: 1, reasked: 1 }, itemsDropped: 2 },
                repair: { calls: 2, failed: 1, latencyMs: { p50: 50, p95: 70 }, outputTokens: { p50: 0, p95: 40, total: 40 }, repairs: { failed: 1 }, itemsDropped: 0 },
            },
        });
        // A second finish (a job handed over finishes twice) adds no second summary.
        meter.finish();
        expect(events.filter((e) => e.kind === "ai_call_summary")).toHaveLength(1);
    });

    it("is kept with the job, with the bytes its artifacts and runner uploads take", async () => {
        const db = new Db(":memory:");
        const repo = new Repo(db, new SecretBox("", "a-test-secret-key-of-enough-length"));
        const projectId = String(repo.createProject({ name: "P" }).id);
        const appId = repo.createApplication(projectId, "http://example.test", { ...DEFAULT_JOB_OPTIONS });
        const jobId = (await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] })).id;
        db.run("INSERT INTO artifacts (id, project_id, job_id, kind, path, size, created_at) VALUES ('a1', ?, ?, 'screenshot', 'x.png', 1000, 'now'), ('a2', ?, ?, 'trace', 'x.zip', 500, 'now'), ('a3', ?, 'other-job', 'trace', 'y.zip', 9999, 'now')", projectId, jobId, projectId, jobId, projectId);
        db.run("INSERT INTO agent_tasks (id, project_id, job_id, adapter_id, status, payload_enc, created_ms) VALUES ('t1', ?, ?, 'x', 'done', '', 0)", projectId, jobId);
        db.run("INSERT INTO agent_task_files (task_id, direction, ref, path, size, sha256) VALUES ('t1', 'out', 'r1', 'p1', 300, 's'), ('t1', 'in', 'r2', 'p2', 7000, 's')");
        const clock = { t: 0 };
        const meter = meterFor(repo, loadConfig({}), { id: jobId, projectId })!;
        const llm = meter.wrap(scripted([{ ms: 42, out: 7, repair: "cleaned" }], clock));
        await llm.text({ system: "s", prompt: "p", purpose: "analysis" });
        meter.finish();
        const stored = repo.listEvents(jobId).find((e) => e.kind === "ai_call_summary");
        expect(stored?.data).toMatchObject({ artifactBytes: 1500, uploadBytes: 300, purposes: { analysis: { calls: 1, outputTokens: { total: 7 }, repairs: { cleaned: 1 } } } });
    });
});
