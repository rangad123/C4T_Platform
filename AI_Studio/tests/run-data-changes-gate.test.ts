/**
 * Lead decision (eng-all): `POST /api/projects/:id/runs` `allowMutatingApiTests` is honoured only on this server's benchmark setting
 * (BENCH_RISKY_CHECKS). Everywhere else the project's own "Include API tests that change data" setting applies, so a run starter cannot
 * turn data changes on (or off) for a customer app. Real platform through Fastify inject, no worker, no browser: the queued job's options
 * are what the worker would run with.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject } from "./fixtures/dashboard-seed.js";

type Server = Awaited<ReturnType<typeof buildServer>>;
const made: Array<{ platform: Platform; server: Server; dir: string }> = [];

async function platformWith(env: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-run-gate-"));
    const platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "run-gate-secret-key-0123456789", SCHEDULER_ENABLED: "false", ...env }));
    const server = await buildServer(platform);
    made.push({ platform, server, dir });
    return { platform, server };
}

/** A project whose saved "Include API tests that change data" is `projectSetting`, one test, and a run started with `body`. */
async function startRun(p: { platform: Platform; server: Server }, projectSetting: boolean, body: Record<string, unknown>) {
    const s = seedProject(p.platform, `Shop ${made.length}-${Math.random()}`, null);
    p.platform.repo.createApplication(s.projectId, "http://127.0.0.1:5590", { ...DEFAULT_JOB_OPTIONS, allowMutatingApiTests: projectSetting });
    addTest(p.platform, s, "one");
    const res = await p.server.inject({ method: "POST", url: `/api/projects/${s.projectId}/runs`, payload: body });
    expect(res.statusCode, res.body).toBe(202);
    return p.platform.repo.getJob(JSON.parse(res.body).jobId)!.options.allowMutatingApiTests;
}

let customer: { platform: Platform; server: Server };
let bench: { platform: Platform; server: Server };

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    customer = await platformWith({});
    bench = await platformWith({ BENCH_RISKY_CHECKS: "true" });
}, 60_000);

afterAll(async () => {
    for (const m of made) {
        await m.server.close();
        m.platform.db.close();
        fs.rmSync(m.dir, { recursive: true, force: true });
    }
});

describe("a run's data changes", () => {
    it("on a customer server, the project's setting applies whatever the run asks", async () => {
        expect(await startRun(customer, false, { allowMutatingApiTests: true })).toBe(false);
        expect(await startRun(customer, true, { allowMutatingApiTests: false })).toBe(true);
        expect(await startRun(customer, true, {})).toBe(true);
        expect(await startRun(customer, false, {})).toBe(false);
    });

    it("on the benchmark's own server, the run's choice is honoured; without one the project's setting applies", async () => {
        expect(await startRun(bench, false, { allowMutatingApiTests: true })).toBe(true);
        expect(await startRun(bench, true, { allowMutatingApiTests: false })).toBe(false);
        expect(await startRun(bench, true, {})).toBe(true);
    });
});
