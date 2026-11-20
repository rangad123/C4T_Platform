/**
 * CP3b R-4: every free-text field of an exploration's coverage record (the stop detail, the outcome and skip reasons, the coverage
 * lists' statuses and reasons) is masked when it is written, with the run's secrets and the shared patterns. On the platform that is
 * saveExploration (the record GET …/jobs/:jobId/coverage serves); on a runner, the record it sends (explorationForResult).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryLogger } from "../src/agent/log.js";
import { explorationForResult } from "../src/agent/task-runner.js";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { saveExploration } from "../src/platform/exploration-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { seedProject } from "./fixtures/dashboard-seed.js";
import { sampleExploration } from "./fixtures/exploration-record.js";

const KEY = "exploration-mask-owner-key-1234";
const PW = "Hunt3r!pw22";
const BEARER = "abcDEF1234567890qq";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX3Zh";
const LEAK = `Bad request (echo): Authorization: Bearer ${BEARER} id_token=${JWT} the password ${PW} was refused`;

/** A record whose every free-text field carries the leak. */
function leaky() {
    const e = sampleExploration();
    return sampleExploration({
        stopReason: "instability",
        stopDetail: `3 environment failures in a row; the last: ${LEAK}`,
        objectives: e.objectives.map((o) => ({ ...o, reason: `${o.reason} ${LEAK}` })),
        skipped: e.skipped.map((s) => ({ ...s, reason: LEAK })),
        outcomes: e.outcomes.map((o) => ({ ...o, status: "environment_failure" as const, reason: LEAK, ...(o.result ? { result: { ...o.result, ended: LEAK } } : {}) })),
        coverage: {
            ...e.coverage,
            unexplored: e.coverage.unexplored.map((u) => ({ ...u, reason: LEAK, status: `environment_failure: ${LEAK}` })),
            notRun: e.coverage.notRun.map((n) => ({ ...n, reason: LEAK })),
        },
        actionLog: e.actionLog.map((r) => ({ ...r, reason: LEAK })),
    });
}

/**
 * CP3c T-5: the coverage lists (a page path, an element's name, an endpoint) and an objective's source carry what the page showed or
 * where it went: a password in a reset path, an API token in an element's name or an endpoint. Every string is masked, not a field list.
 */
function leakyLists() {
    const e = sampleExploration();
    const t = (xs: string[]) => ({ total: xs.length + 1, exercised: 1, notExercised: xs, more: 0 });
    return sampleExploration({
        objectives: e.objectives.map((o) => ({ ...o, source: `/reset/${PW}` })),
        coverage: {
            ...e.coverage,
            pages: { ...t([`/reset/${PW}`, `/share?token=${JWT}`]), unknown: [`/reset/${PW}`, `/keys/Bearer ${BEARER}`] },
            elements: t([`/settings textbox "API token ${JWT}"`, `button "Use ${PW}"`]),
            workflowSteps: t([`step with ${PW}`]),
            transitions: t([`/a -> /reset/${PW}`]),
            inputClasses: t([`password ${PW}`]),
            rules: t([`R-1 ${PW}`]),
            endpoints: t([`GET /api/keys/${JWT}`, `POST /api/login?password=${PW}`]),
            unexplored: e.coverage.unexplored.map((u) => ({ ...u, source: `/reset/${PW}` })),
        },
        actionLog: e.actionLog.map((r) => ({ ...r, objectiveId: r.objectiveId, state: `/reset/${PW}|abc123abc123` })),
    });
}

const leaks = (text: string) => ({ pw: text.includes(PW), bearer: text.includes(BEARER), jwt: text.includes(JWT) });
const NONE = { pw: false, bearer: false, jwt: false };

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "exploration-mask-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "exploration-mask-secret-key-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
});
afterAll(async () => {
    await app?.close();
    platform?.db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the coverage record's free text is masked when it is written", () => {
    it("on the platform: the coverage route serves no run secret, bearer token or JWT from any field", async () => {
        const s = seedProject(platform, "Masked coverage", "http://127.0.0.1:9");
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        sink.addSecrets([PW]);
        await saveExploration(sink, leaky());
        await sink.writes.flush();
        const res = await app.inject({ method: "GET", url: `/api/projects/${s.projectId}/jobs/${job.id}/coverage`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        expect(leaks(res.body)).toEqual(NONE);
        const body = JSON.parse(res.body);
        // The text around the secrets stays readable, and what is not free text is kept as it was.
        expect(body.stopDetail).toMatch(/^3 environment failures in a row; the last: Bad request \(echo\)/);
        expect(body.coverage.notRun[0].operator).toBe("double_submit");
        expect(body.coverage.unexplored[0].objectiveId).toBe("OBJ-0123456789abcdef");
        // And the stored record as a whole (what a later reader of the artifact gets).
        const row = platform.repo.db.get<{ path: string }>("SELECT path FROM artifacts WHERE job_id = ? AND kind = 'exploration'", job.id)!;
        expect(leaks((await platform.store.getBytes(row.path)).toString("utf8"))).toEqual(NONE);
    });

    it("on the platform: every coverage list and an objective's source are masked too, ids are kept (CP3c T-5)", async () => {
        const s = seedProject(platform, "Masked coverage lists", "http://127.0.0.1:9");
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        sink.addSecrets([PW]);
        await saveExploration(sink, leakyLists());
        await sink.writes.flush();
        const res = await app.inject({ method: "GET", url: `/api/projects/${s.projectId}/jobs/${job.id}/coverage`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        expect(leaks(res.body)).toEqual(NONE);
        const body = JSON.parse(res.body);
        expect(body.coverage.pages.unknown[0]).toMatch(/^\/reset\//);
        expect(body.coverage.endpoints.notExercised[0]).toMatch(/^GET \/api\/keys\//);
        expect(body.coverage.unexplored[0].objectiveId).toBe("OBJ-0123456789abcdef");
        // The stored record (the route serves only part of it): no leak in any field, and the ids are as written.
        const row = platform.repo.db.get<{ path: string }>("SELECT path FROM artifacts WHERE job_id = ? AND kind = 'exploration'", job.id)!;
        const stored = (await platform.store.getBytes(row.path)).toString("utf8");
        expect(leaks(stored)).toEqual(NONE);
        const record = JSON.parse(stored);
        expect(record.objectives[0].id).toBe("OBJ-0123456789abcdef");
        expect(record.objectives[0].source).toMatch(/^\/reset\//);
        expect(record.outcomes[0].result.testKey).toBe("checkout-as-stated");
        expect(record.outcomes.map((o: { objectiveId: string }) => o.objectiveId)).toEqual(sampleExploration().outcomes.map((o) => o.objectiveId));
    });

    it("row 231: the job's sink keeps the record the engine hands it when the session ends, masked as saveExploration masks it", async () => {
        const s = seedProject(platform, "Kept at session end", "http://127.0.0.1:9");
        const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
        const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
        sink.addSecrets([PW]);
        await sink.saveExploration(leaky());
        await sink.writes.flush();
        const res = await app.inject({ method: "GET", url: `/api/projects/${s.projectId}/jobs/${job.id}/coverage`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).stopReason).toBe("instability");
        expect(leaks(res.body)).toEqual(NONE);
    });

    it("on a runner: every coverage list is masked with the shared patterns too (CP3c T-5)", () => {
        // No stored secret on this runner's log: only the shared patterns (bearer tokens, JWTs) can catch them.
        const { log } = memoryLogger();
        const sent = explorationForResult(leakyLists(), log, "task-1");
        expect(sent.exploration).toBeDefined();
        const text = JSON.stringify(sent);
        expect(text.includes(JWT)).toBe(false);
        expect(text.includes(BEARER)).toBe(false);
        expect(sent.exploration!.outcomes[0]!.result!.testKey).toBe("checkout-as-stated");
    });

    it("on a runner: the record it sends has no stored secret, bearer token or JWT in any field", () => {
        const { log } = memoryLogger();
        log.addSecrets([PW]);
        const sent = explorationForResult(leaky(), log, "task-1");
        expect(sent.exploration).toBeDefined();
        expect(leaks(JSON.stringify(sent))).toEqual(NONE);
        expect(sent.exploration!.stopDetail).toMatch(/^3 environment failures in a row; the last: Bad request \(echo\)/);
        expect(sent.exploration!.outcomes.map((o) => o.objectiveId)).toEqual(sampleExploration().outcomes.map((o) => o.objectiveId));
    });
});
