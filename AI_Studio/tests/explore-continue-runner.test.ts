/**
 * Queue row 208: Continue a stopped exploration only on a runner that knows how to carry on (capability `exploreResume`). A runner program
 * older than that ignores the request's `carry` and `resume` and starts from the beginning, which can make the same checks twice. So:
 *
 * - Continue on such a runner is refused with a 409 and one sentence, and no job is made (Start over is the usual Explore again);
 * - a runner that reports `exploreResume` gets the continued exploration;
 * - a continue made while the runner could, polled by an older runner program afterwards, is never offered to it and ends with the sentence.
 *
 * A real platform on real HTTP in runners mode with its dispatch worker; hand-driven protocol-2 runners. No browser, no AI call (the
 * exploration never runs: the runner only takes the offer). Ports: platform 6751.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { loadConfig } from "../src/config.js";
import { getAgentServices } from "../src/platform/agent-services.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { continueNeedsUpdate } from "../src/platform/explore-task.js";
import { removeServerExecutionGuard } from "../src/platform/runner-only.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { personalRunner, testPerson } from "./helpers/personal-runner.js";

const PORT = 6751;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "http://127.0.0.1:6752";
const API_KEY = "explore-continue-runner-admin-key-208";
const ENV_KEYS = ["AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "AGENT_ACCEPT_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
/** What a runner reports: `resume` false is a runner program from before row 208. */
const caps = (resume: boolean) => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"], runnerSwitches: true, explore: true, exploreModes: ["plain", "agent"], ...(resume ? { exploreResume: true } : {}) });

let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let dispatch: Worker;
let dataDir: string;

const call = async (method: string, url: string, body?: unknown, key = API_KEY) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
};
const agentApi = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
};
const until = async (what: string, check: () => boolean | Promise<boolean>, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
};
const jobDone = async (jobId: string, ms = 60_000) => {
    let j: any;
    await until("the job to finish", () => ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes((j = platform.repo.getJob(jobId)!).status), ms);
    return j;
};
type Raw = { token: string; agentId: string; resume: boolean };
async function hello(token: string, name: string, resume: boolean): Promise<Raw> {
    const r = await agentApi(token, "POST", "/api/agent/hello", { protocol: 1, protocols: [1, 2], name, version: "52.0.0", concurrency: 1, capabilities: caps(resume) });
    expect(r.status).toBe(200);
    return { token, agentId: r.body.agentId as string, resume };
}
const pollOnce = async (a: Raw) => {
    const r = await agentApi(a.token, "POST", "/api/agent/poll", { agentId: a.agentId, freeSlots: 1, capabilities: caps(a.resume) });
    return r.status === 200 ? r.body : undefined;
};
const poll = async (a: Raw) => {
    for (let i = 0; i < 30; i++) {
        const offer = await pollOnce(a);
        if (offer) return offer;
    }
    throw new Error("no offer");
};
const stop = async (jobId: string) => {
    platform.repo.requestCancel(jobId);
    return jobDone(jobId);
};

beforeAll(async () => {
    Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "60", AGENT_WATCH_MS: "50", AGENT_NO_AGENT_GRACE_SECONDS: "30", AGENT_ACCEPT_SECONDS: "20" });
    delete process.env.BLOCK_PRIVATE_TARGETS;
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-explore-continue-runner-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY, EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "false", SECRET_KEY: "explore-continue-runner-secret-0123456789", DISPATCH_CONCURRENCY: "4", MAX_REPAIR_ATTEMPTS: "0", LLM_PROVIDER: "anthropic" }));
    server = await buildServer(platform);
    await server.listen({ port: PORT, host: "127.0.0.1" });
    dispatch = Worker.dispatch(platform, 100);
    dispatch.start();
}, 60_000);

afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await dispatch?.stop();
    server?.server.closeAllConnections();
    await server?.close();
    platform?.db.close();
    removeServerExecutionGuard();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Continue a stopped exploration needs a runner that can carry on", () => {
    it("the runner program reports it", async () => {
        const c = await new CapabilityProbe({ platform: "linux", env: {}, exec: async () => undefined, browsers: () => [] }).discover();
        expect(c.exploreResume).toBe(true);
    });

    it("an older runner gets the 409 sentence and no job; a new one continues; a continue an older one polls for is never offered to it", async () => {
        const p = testPerson(platform);
        const projectId = (await call("POST", "/api/projects", { name: "Continue on a runner" }, p.token)).body.id as string;
        const { secret } = personalRunner(platform, { ownerId: p.id, label: "Priya laptop" });
        const now = await hello(secret, "Priya laptop", true);

        // An exploration that stops at a plan, stopped once the runner took it.
        const s = await call("POST", `/api/projects/${projectId}/test-generation`, { url: SITE, targets: ["web"], maxPages: 2, plan: true, useMemory: false }, p.token);
        expect(s.status, s.text).toBe(202);
        expect(await poll(now)).toMatchObject({ kind: "explore", jobId: s.body.jobId });
        expect(await stop(s.body.jobId)).toMatchObject({ status: "FAILED", error: "Cancelled" });

        // The same computer, now running an older runner program: refused with the sentence, and nothing is made.
        const old = await hello(secret, "Priya laptop", false);
        const jobsBefore = platform.repo.listJobs(projectId).length;
        const refused = await call("POST", `/api/projects/${projectId}/explorations/${s.body.jobId}/continue`, undefined, p.token);
        expect(refused).toMatchObject({ status: 409, body: { error: continueNeedsUpdate("Priya laptop") } });
        expect(refused.body.error).toBe("Your runner “Priya laptop” is too old to continue an exploration; download the runner again, or choose Start over.");
        expect(platform.repo.listJobs(projectId).length).toBe(jobsBefore);
        expect(getAgentServices(platform).store.tasksOfJob(s.body.jobId).filter((t) => t.status === "queued")).toEqual([]);

        // A runner that can carry on: the continue is made and handed to it.
        const again = await hello(secret, "Priya laptop", true);
        const r = await call("POST", `/api/projects/${projectId}/explorations/${s.body.jobId}/continue`, undefined, p.token);
        expect(r.status, r.text).toBe(202);
        expect(platform.repo.getJob(r.body.jobId)!.options.resumeFrom).toBe(s.body.jobId);
        expect(await poll(again)).toMatchObject({ kind: "explore", jobId: r.body.jobId });
        expect((await stop(r.body.jobId)).status).toBe("FAILED");

        // Continued while the runner could, then polled by an older program: never offered to it; the continue ends with the sentence.
        await hello(secret, "Priya laptop", true);
        const r2 = await call("POST", `/api/projects/${projectId}/explorations/${r.body.jobId}/continue`, undefined, p.token);
        expect(r2.status, r2.text).toBe(202);
        for (let i = 0; i < 3; i++) expect(await pollOnce(old)).toBeUndefined();
        const ended = await jobDone(r2.body.jobId);
        expect(ended.status).toBe("FAILED");
        expect(ended.error).toContain(continueNeedsUpdate("Priya laptop"));
    }, 120_000);
});
