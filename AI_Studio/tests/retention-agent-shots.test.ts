/**
 * Retention of an agent run's screenshots (vision-shot files written by agent-run.ts / agent-on-runner.ts with a job but no test run),
 * against a real platform (database, artifact store on disk; no browser, no model, no port). A fixed clock is handed to the pass.
 *  - they expire as a failed run's media: 7 days after the agent run's job started (6.9 days kept, 7.1 days removed), counted from
 *    the job even when the row itself is newer or older
 *  - old rows with no job expire by their own creation time
 *  - the file really leaves the disk and the row stays, marked pruned
 *  - approved baselines and other files without a test run (plans, app models, reports) are never touched
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { pruneProject, retentionStore } from "../src/platform/retention-runner.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { addBaseline, addTest, DAY, pastGrace, seedProject, type Seed } from "./fixtures/retention-seed.js";

let dataDir: string;
let platform: Platform;

beforeAll(() => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-retention-agent-shots-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    pastGrace(platform); // these rows are dated long before today: a platform past its first-deploy grace
}, 60_000);
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const NOW = Math.floor((Date.now() - 60 * DAY) / DAY) * DAY + 12 * 3_600_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

/** A finished agent-run job that started `daysAgo` days before NOW. */
async function job(s: Seed, daysAgo: number): Promise<string> {
    const j = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
    platform.db.run("UPDATE generation_jobs SET status = 'COMPLETED', created_at = ?, started_at = ?, finished_at = ? WHERE id = ?", iso(daysAgo), iso(daysAgo), iso(daysAgo), j.id);
    return j.id;
}

/** A file stored the way agent-run.ts stores a step screenshot: job, no test run; its row created `createdDaysAgo` days before NOW. */
function file(s: Seed, jobId: string | null, kind: string, createdDaysAgo: number, name: string) {
    const rel = path.posix.join(s.projectId, "_artifacts", jobId ?? "old", name);
    const abs = path.join(platform.config.artifactsDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.alloc(200, 3));
    const id = platform.repo.addArtifact({ projectId: s.projectId, ...(jobId ? { jobId } : {}), kind, path: rel, size: 200 });
    platform.db.run("UPDATE artifacts SET created_at = ? WHERE id = ?", iso(createdDaysAgo), id);
    return { id, abs };
}

const row = (id: string) => platform.db.get<{ pruned_at: string | null; pruned_reason: string | null }>("SELECT pruned_at, pruned_reason FROM artifacts WHERE id = ?", id)!;

describe("retention: agent-run screenshots expire with their job", () => {
    it("removes them 7 days after the job started, keeps them before, never touches baselines or other job files", async () => {
        const s = seedProject(platform, "Agent shots");
        const t = addTest(platform, s);
        const young = await job(s, 6.9);
        const old = await job(s, 7.1);
        // The age is the job's, not the row's: a row written late in an old job goes, an old row of a young job stays.
        const keep = file(s, young, "vision-shot", 30, "agent-step-001.jpg");
        const go = file(s, old, "vision-shot", 0, "agent-step-001.jpg");
        const goToo = file(s, old, "vision-shot", 7.1, "agent-step-002.jpg");
        // Rows stored before the link was used: no job, so their own creation time counts.
        const unlinkedKeep = file(s, null, "vision-shot", 6.9, "agent-step-a.jpg");
        const unlinkedGo = file(s, null, "vision-shot", 7.1, "agent-step-b.jpg");
        // Never removed: approved baselines, and files of an old job that are not screenshots (plans, app models, reports).
        const baseline = addBaseline(platform, s, t);
        platform.db.run("UPDATE artifacts SET created_at = ? WHERE id = ?", iso(400), baseline.id);
        const model = file(s, old, "app-model", 400, "model.json");
        const report = file(s, old, "report", 400, "report.html");

        const r = await pruneProject(platform, s.projectId, retentionStore(platform).effective(s.projectId), "manual", NOW);

        expect(r.files).toBe(3);
        expect(r.errors).toBe(0);
        for (const f of [go, goToo, unlinkedGo]) {
            expect(fs.existsSync(f.abs)).toBe(false);
            expect(row(f.id).pruned_at).toBe(new Date(NOW).toISOString());
            expect(row(f.id).pruned_reason).toBe("age-failed");
        }
        for (const f of [keep, unlinkedKeep, model, report]) {
            expect(fs.existsSync(f.abs)).toBe(true);
            expect(row(f.id).pruned_at).toBeNull();
        }
        expect(fs.existsSync(baseline.abs)).toBe(true);
        expect(row(baseline.id).pruned_at).toBeNull();

        // A second pass changes nothing.
        const again = await pruneProject(platform, s.projectId, retentionStore(platform).effective(s.projectId), "manual", NOW);
        expect(again.files).toBe(0);
    });
});
