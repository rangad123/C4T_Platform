/**
 * Deploy triggers with real work: a token starts a run, the real worker validates the project's tests under Playwright against a
 * fixture endpoint that can be broken on demand, the status endpoint reports the run, and the callback is delivered to a local
 * receiver. Runs a browser: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/triggers-run.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { getScheduleServices, type ScheduleServices } from "../src/platform/schedule-services.js";
import { buildServer } from "../src/platform/server.js";
import { getTriggerServices } from "../src/platform/trigger-services.js";
import { Worker } from "../src/platform/worker.js";

const API_KEY = "test-api-key-0123456789";
const FIXTURE_PORT = 5532;
const RECEIVER_PORT = 5533;
const DEAD_PORT = 5534; // nothing listens here
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

let dataDir: string;
let platform: Platform;
let svc: ScheduleServices;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let fixture: http.Server;
let receiver: http.Server;
let clockNow = Date.now();
let broken = false;
/** Callbacks the receiver got, and whether it should refuse the next ones (to see the retry). */
const received: any[] = [];
let refuseNext = 0;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-trigrun-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", API_KEY, CONCURRENCY: "2", PUBLIC_URL: "https://qa.example.test" }));
    getTriggerServices(platform, { clock: () => clockNow, delivery: { backoffMs: [20, 20], timeoutMs: 2_000 } });
    svc = getScheduleServices(platform);
    server = await buildServer(platform);
    worker = new Worker({ ...platform, onJobFinished: svc.onJobFinished }, 100);
    worker.start();

    fixture = http.createServer((req, res) => {
        const json = (status: number, body: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(body)));
        if (req.url === "/api/stable") return json(200, { ok: true });
        if (req.url === "/api/deploy-sensitive") return broken ? json(500, { error: "boom" }) : json(200, { ok: true });
        json(404, { error: "not found" });
    });
    receiver = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            if (refuseNext > 0) {
                refuseNext--;
                return void res.writeHead(503).end("busy");
            }
            received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(200).end("ok");
        });
    });
    await Promise.all([new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r)), new Promise<void>((r) => receiver.listen(RECEIVER_PORT, "127.0.0.1", r))]);
}, 30_000);

afterAll(async () => {
    await worker?.stop();
    await svc?.flush();
    await server?.close();
    fixture?.close();
    receiver?.close();
    platform?.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const send = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, key = true) => {
    const res = await server.inject({ method, url, payload: payload as never, headers: key ? { "x-api-key": API_KEY } : {} });
    return { status: res.statusCode, body: res.body && /^[{[]/.test(res.body) ? JSON.parse(res.body) : res.body };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the pipeline's status endpoint (no API key) until the run is finished. */
async function untilFinished(token: string, jobId: string) {
    const seen: string[] = [];
    for (let i = 0; i < 400; i++) {
        const s = await send("GET", `/api/triggers/${token}/status/${jobId}`, undefined, false);
        expect(s.status).toBe(200);
        if (seen.at(-1) !== s.body.state) seen.push(s.body.state);
        if (s.body.finished) return { status: s.body, seen };
        await sleep(300);
    }
    throw new Error("run did not finish");
}
/**
 * The job row turns terminal a moment before the worker's finished-job hook queues the callback, so "flush" alone can run too
 * early and find nothing to wait for. Wait until the callback has reached a final state (sent or failed).
 */
async function callbackSettled(jobId: string) {
    for (let i = 0; i < 300; i++) {
        await svc.flush();
        const state = getTriggerServices(platform).store.getRun(jobId)?.callbackState;
        if (state === "sent" || state === "failed") return;
        await sleep(100);
    }
    throw new Error("the callback never reached a final state");
}
const apiSpec = (title: string, p: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: p }, { action: "assertResponse", check: "status", expected: 200 }] });

describe("a deploy trigger, end to end", () => {
    let projectId: string;
    let token: string;
    let tokenId: string;

    it("a project with two tests that pass is ready", async () => {
        projectId = (await send("POST", "/api/projects", { name: "Deployed shop" })).body.id;
        const imp = await send("POST", `/api/projects/${projectId}/specs`, { baseUrl: FIXTURE, specs: [apiSpec("Stable endpoint answers", "/api/stable"), apiSpec("Deploy-sensitive endpoint answers", "/api/deploy-sensitive")] });
        expect(imp.status, JSON.stringify(imp.body)).toBe(202);
        for (let i = 0; i < 300; i++) {
            const j = (await send("GET", `/api/test-generation/${imp.body.jobId}`)).body;
            if (j.finishedAt) {
                expect(j.status).toBe("COMPLETED");
                break;
            }
            await sleep(300);
        }
        ({ token, id: tokenId } = (await send("POST", `/api/projects/${projectId}/triggers`, { label: "GitHub Actions" })).body);
    }, 120_000);

    it("a good deploy: the run starts, the status goes from queued to passed and the callback arrives once with the result", async () => {
        const run = await send("POST", `/api/triggers/${token}/run`, { commit: "9b1f0c2", environment: "staging", callbackUrl: `http://127.0.0.1:${RECEIVER_PORT}/deployed?secret=abc` }, false);
        expect(run.status, JSON.stringify(run.body)).toBe(202);
        const { status, seen } = await untilFinished(token, run.body.jobId);
        expect(seen[0]).toMatch(/queued|running/);
        expect(status).toMatchObject({ state: "passed", finished: true, passed: true, commit: "9b1f0c2", environment: "staging", failures: [], summary: { total: 2, passed: 2, failed: 0, needsReview: 0, passRate: 100 } });
        expect(status.finishedAt).toBeTruthy();

        await callbackSettled(run.body.jobId);
        expect(received).toHaveLength(1);
        expect(received[0].path).toBe("/deployed?secret=abc");
        expect(received[0].body).toMatchObject({
            event: "deploy_run_finished",
            state: "passed",
            passed: true,
            jobId: run.body.jobId,
            commit: "9b1f0c2",
            environment: "staging",
            project: { id: projectId, name: "Deployed shop" },
            link: `https://qa.example.test/#/projects/${projectId}/runs`,
            summary: { total: 2, passed: 2 },
        });
        expect(getTriggerServices(platform).store.getRun(run.body.jobId)).toMatchObject({ callbackState: "sent", tokenId });
        // the callback address (it may carry a secret) is stored encrypted and never shown
        platform.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        for (const f of [platform.config.dbPath, `${platform.config.dbPath}-wal`].filter((x) => fs.existsSync(x))) expect(fs.readFileSync(f).includes(Buffer.from("secret=abc"))).toBe(false);
        expect(JSON.stringify(status)).not.toContain("secret=abc");
    }, 180_000);

    it("the run is labelled as started by a deploy in the runs list and in the run summary", async () => {
        const jobs = (await send("GET", `/api/projects/${projectId}/jobs`)).body as any[];
        const triggered = jobs.find((j) => j.trigger === "deploy")!;
        expect(triggered).toMatchObject({ mode: "validate", status: "COMPLETED", deploy: { commit: "9b1f0c2", environment: "staging", label: "GitHub Actions" } });
        const summary = (await send("GET", `/api/projects/${projectId}/runs/${triggered.jobId}/summary`)).body;
        expect(summary).toMatchObject({ trigger: "deploy", total: 2, validated: 2 });
    });

    it("a bad deploy: the failing test is named, the state is failed, and the callback reports it (after a receiver hiccup)", async () => {
        broken = true;
        clockNow += 60_000;
        refuseNext = 1; // the first delivery attempt is refused with 503; the retry gets through
        const run = await send("POST", `/api/triggers/${token}/run`, { commit: "c0ffee1", callbackUrl: `http://127.0.0.1:${RECEIVER_PORT}/deployed` }, false);
        expect(run.status).toBe(202);
        const { status } = await untilFinished(token, run.body.jobId);
        expect(status).toMatchObject({ state: "failed", finished: true, passed: false, commit: "c0ffee1", summary: { total: 2, passed: 1, needsReview: 1, passRate: 50 } });
        expect(status.failures).toEqual([expect.objectContaining({ title: "Deploy-sensitive endpoint answers", status: "NEEDS_REVIEW" })]);

        await callbackSettled(run.body.jobId);
        expect(received).toHaveLength(2);
        expect(received[1].body).toMatchObject({ event: "deploy_run_finished", state: "failed", passed: false, commit: "c0ffee1", jobId: run.body.jobId, failures: [{ title: "Deploy-sensitive endpoint answers" }] });
        expect(getTriggerServices(platform).store.getRun(run.body.jobId)!.callbackState).toBe("sent");
        broken = false;
    }, 180_000);

    it("a callback that cannot be delivered is recorded and never fails the run", async () => {
        clockNow += 60_000;
        const run = await send("POST", `/api/triggers/${token}/run`, { callbackUrl: `http://127.0.0.1:${DEAD_PORT}/nobody` }, false);
        expect(run.status).toBe(202);
        const { status } = await untilFinished(token, run.body.jobId);
        expect(status.state).toBe("passed");
        await callbackSettled(run.body.jobId);
        const row = getTriggerServices(platform).store.getRun(run.body.jobId)!;
        expect(row.callbackState).toBe("failed");
        expect(row.callbackDetail).toMatch(/Could not reach the receiver/);
        expect(received).toHaveLength(2);
    }, 180_000);

    it("a revoked token can no longer read its runs", async () => {
        const jobs = (await send("GET", `/api/projects/${projectId}/jobs`)).body as any[];
        const last = jobs.find((j) => j.trigger === "deploy")!.jobId as string;
        expect((await send("GET", `/api/triggers/${token}/status/${last}`, undefined, false)).status).toBe(200);
        expect((await send("DELETE", `/api/projects/${projectId}/triggers/${tokenId}`)).status).toBe(200);
        expect((await send("GET", `/api/triggers/${token}/status/${last}`, undefined, false)).status).toBe(404);
    });
});
