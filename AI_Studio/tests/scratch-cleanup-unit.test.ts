/**
 * Scratch run folders do not outlive their job (P5 L-8): a job's runs write under `<scratch>/job-<id>`, removed when the job ends, and a
 * worker that starts removes the folders an earlier process left (older than an hour, unless their job is still going). Folders that are
 * not run folders are left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { cleanScratch } from "../src/platform/job-runner.js";
import { Worker } from "../src/platform/worker.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-scratch-clean-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 60 * 60_000;
/** A folder with a page snapshot in it, last changed `ageMs` ago. */
function folder(dir: string, name: string, ageMs: number): string {
    const full = path.join(dir, name);
    fs.mkdirSync(path.join(full, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(full, "test-results", "error-context.md"), '- textbox "Password": CnryFdPw!1x9');
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(full, at, at);
    return full;
}

describe("old scratch folders are removed", () => {
    it("run and finished-job folders older than an hour go; a running job's folder, new folders and other folders stay", async () => {
        const dir = path.join(tmp, "direct");
        const running = "11111111-1111-4111-8111-111111111111";
        const done = "22222222-2222-4222-8222-222222222222";
        const unknown = "33333333-3333-4333-8333-333333333333";
        const statuses: Record<string, string> = { [running]: "RUNNING", [done]: "COMPLETED" };
        const repo = { getJob: (id: string) => (statuses[id] ? ({ id, status: statuses[id] } as never) : undefined) };
        const gone = [folder(dir, "run-1700000000000-aaaaaaaa", 2 * HOUR), folder(dir, `job-${done}`, 2 * HOUR), folder(dir, `job-${unknown}`, 2 * HOUR)];
        const kept = [folder(dir, `job-${running}`, 5 * HOUR), folder(dir, "run-1790000000000-bbbbbbbb", 10 * 60_000), folder(dir, "jobs-archive", 2 * HOUR), folder(dir, "maestro-check-abc", 2 * HOUR)];
        await cleanScratch(dir, repo);
        for (const f of gone) expect(fs.existsSync(f), f).toBe(false);
        for (const f of kept) expect(fs.existsSync(f), f).toBe(true);
    });

    it("a worker that starts removes what an earlier process left behind", async () => {
        const dataDir = path.join(tmp, "data");
        const platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "scratch-clean-secret-key-0123456789", SCHEDULER_ENABLED: "false" }));
        const scratchDir = path.join(tmp, "worker");
        const left = folder(scratchDir, "job-44444444-4444-4444-8444-444444444444", 3 * HOUR);
        const fresh = folder(scratchDir, "run-1790000000000-cccccccc", 60_000);
        const worker = new Worker({ ...platform, config: { ...platform.config, scratchDir } }, 50);
        try {
            worker.start();
            for (let i = 0; i < 100 && fs.existsSync(left); i++) await new Promise((r) => setTimeout(r, 20));
            expect(fs.existsSync(left)).toBe(false);
            expect(fs.existsSync(fresh)).toBe(true);
        } finally {
            await worker.stop();
            platform.db.close();
        }
    });
});
