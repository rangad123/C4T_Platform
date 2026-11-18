/**
 * What a runner may store as a job artifact through the sink (CP2 L-2), on a real platform database and object store, no browser:
 * the text artifacts the platform writes itself from a validated part of the result (the exploration record) or the job's summary
 * (plan, application model) cannot be planted through saveTextArtifact, nor a text under one of their file names; a finding's screenshot
 * must be a JPEG (by its bytes) under a .jpg name and within the size a finding keeps.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FRAME_LIMITS } from "../src/engine/frames/shoot.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { forgetExploreSink, handleExploreSink } from "../src/platform/explore-sink.js";
import type { ExploreTaskRef } from "../src/platform/explore-task.js";
import { HttpError } from "../src/platform/http-error.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";

let platform: Platform;
let dataDir: string;

beforeAll(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-artifacts-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
});

afterAll(() => {
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

let n = 0;
async function newTask(): Promise<{ task: ExploreTaskRef }> {
    const { repo } = platform;
    const projectId = repo.createProject({ name: `Artifacts ${Math.random()}` }).id as string;
    const appId = repo.createApplication(projectId, "http://127.0.0.1:9045", { ...DEFAULT_JOB_OPTIONS }, undefined);
    const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS });
    return { task: { taskId: `artifacts-task-${++n}`, attempt: 1, jobId: job.id, projectId, agentId: "agent-1" } };
}

describe("artifacts a runner sends", () => {
    const refusal = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(HttpError);

    it("a text artifact the platform keeps from a result field, or one under such a file name, cannot be planted (CP2 L-2)", async () => {
        const { task } = await newTask();
        const record = JSON.stringify({ stopReason: "objectives_done", actionLog: [], coverage: {} });
        for (const [kind, name] of [["exploration", "exploration.json"], ["exploration", "other.json"], ["plan", "plan.json"], ["app-model", "application-model.json"], ["screenshot", "x.json"], ["report", "exploration.json"], ["report", "plan.json"], ["report", "WEB-001-finding-1.jpg"]] as const)
            await refusal(handleExploreSink(platform, task, { calls: [{ method: "saveTextArtifact", kind, name, content: record }] }));
        expect(platform.repo.listArtifacts({ jobId: task.jobId })).toEqual([]);
        // The engine's own text artifacts still arrive.
        await handleExploreSink(platform, task, { calls: [{ method: "saveTextArtifact", kind: "requirements-coverage", name: "requirements-coverage.json", content: "{}" }] });
        expect((platform.repo.listArtifacts({ jobId: task.jobId }) as Array<{ kind: string }>).map((a) => a.kind)).toEqual(["requirements-coverage"]);
        await forgetExploreSink(task.taskId);
    });

    it("a finding's screenshot must be a JPEG under a .jpg name and within the cap (CP2 L-2)", async () => {
        const { task } = await newTask();
        const img = (name: string, bytes: Buffer) => handleExploreSink(platform, task, { calls: [{ method: "saveImageArtifact", kind: "screenshot", file: { name, data: bytes.toString("base64") } }] });
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
        await refusal(img("WEB-001-finding-1.jpg", Buffer.from("<html><script>alert(1)</script></html>")));
        await refusal(img("WEB-001-finding-1.jpg", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
        await refusal(img("exploration.json", jpeg));
        await refusal(img("WEB-001-finding-1.html", jpeg));
        await refusal(img("WEB-001-finding-1.jpg", Buffer.concat([jpeg, Buffer.alloc(FRAME_LIMITS.maxBytes)])));
        expect(platform.repo.listArtifacts({ jobId: task.jobId })).toEqual([]);
        const ok = (await img("WEB-001-finding-1.jpg", jpeg)) as { results: unknown[] };
        expect(typeof ok.results[0]).toBe("string");
        await forgetExploreSink(task.taskId);
    });
});
