/**
 * Seams between the independently built features: a browser-compatibility check (cross-browser feature)
 * must not be recorded as a run of the suite by the schedules/trends feature.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { getScheduleServices } from "../src/platform/schedule-services.js";

let platform: Platform;
let dir: string;
beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-integration-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
});
afterAll(() => {
    platform.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

async function finishedJob(mode: "validate" | "variants") {
    const { repo } = platform;
    const project = repo.createProject({ name: `p-${mode}` }) as { id: string };
    const appId = repo.createApplication(project.id, "http://127.0.0.1:9", { ...DEFAULT_JOB_OPTIONS });
    const job = await repo.createJob(project.id, appId, { ...DEFAULT_JOB_OPTIONS, mode, testIds: [] } as never);
    repo.setJobStatus(job.id, "COMPLETED");
    return { projectId: project.id, job: repo.getJob(job.id)! };
}
const summaries = (projectId: string) => platform.db.all("SELECT job_id FROM run_summaries WHERE project_id = ?", projectId).length;

describe("run summaries and browser checks", () => {
    it("records an ordinary re-run", async () => {
        const { projectId, job } = await finishedJob("validate");
        await getScheduleServices(platform).onJobFinished(job);
        expect(summaries(projectId)).toBe(1);
    });
    it("does not record a browser-compatibility check as a run", async () => {
        const { projectId, job } = await finishedJob("variants");
        await getScheduleServices(platform).onJobFinished(job);
        expect(summaries(projectId)).toBe(0);
    });
});
