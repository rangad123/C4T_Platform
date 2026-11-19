/**
 * CP3b R-5: a defect test's `meta.capturedCheck.observed` and `meta.ownReplay.summary` are what the page and a replay said, so they are
 * masked with the run's secrets and the shared patterns when the test is stored, as `meta.finding` is (CP3 N-5): GET /api/tests/:id
 * serves none of the run's secrets from them, on create and on update.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { buildServer } from "../src/platform/server.js";
import { seedProject } from "./fixtures/dashboard-seed.js";

const KEY = "defect-meta-owner-key-1234";
const CLIENT_SECRET = "oauthClientSecret-Zq7";
const API_TOKEN = "apitok-Zq7-live";
const BEARER = "abcDEF1234567890qq";

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "defect-meta-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "defect-meta-secret-key-0123456789abcdef", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
});
afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const spec = { testId: "WEB-001", title: "Shows the key", category: "Settings", priority: "medium", type: "functional", kind: "web", preconditions: [], steps: [{ action: "navigate", url: "/settings" }], source: { requirements: [] }, tags: [] } as never;
const meta = (n: number) => ({
    capture: "captured",
    capturedCheck: { source: "R-1", observed: `Expected "hidden" but the page shows ${CLIENT_SECRET} (${n})` },
    ownReplay: { label: "Replay", outcome: "failed", failedStep: 1, summary: `Replay ${n}: stopped at step 1: token ${API_TOKEN} rejected, Authorization: Bearer ${BEARER}` },
});

it("capturedCheck.observed and ownReplay.summary are served without the run's secrets, on create and on update", async () => {
    const s = seedProject(platform, "Meta shop", "http://127.0.0.1:9");
    const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
    const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
    sink.addSecrets([CLIENT_SECRET, API_TOKEN]);
    const h = await sink.createTest({ spec, framework: "playwright", validation: "NEEDS_REVIEW", reason: "a defect", meta: meta(1) });
    await sink.writes.flush();
    const get = async () => {
        const res = await app.inject({ method: "GET", url: `/api/tests/${h.id}`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        return res;
    };
    const first = await get();
    for (const secret of [CLIENT_SECRET, API_TOKEN, BEARER]) expect(first.body).not.toContain(secret);
    const m = JSON.parse(first.body).generationMeta;
    // Masked, not dropped: the rest of each sentence and the other fields stay.
    expect(m.capturedCheck).toMatchObject({ source: "R-1", observed: expect.stringMatching(/^Expected "hidden" but the page shows \[hidden\] \(1\)$/) });
    expect(m.ownReplay).toMatchObject({ label: "Replay", outcome: "failed", failedStep: 1, summary: expect.stringMatching(/^Replay 1: stopped at step 1: token \[hidden\] rejected/) });

    await sink.updateTest(h, { spec, validation: "NEEDS_REVIEW", reason: "a defect", attempts: 2, meta: meta(2) } as never);
    await sink.writes.flush();
    const second = await get();
    for (const secret of [CLIENT_SECRET, API_TOKEN, BEARER]) expect(second.body).not.toContain(secret);
    expect(JSON.parse(second.body).generationMeta.capturedCheck.observed).toContain("(2)");
});

/**
 * CP3c T-6: every string of the stored meta is masked, not a list of fields: `explanation` and `visionObservations` (the test writer's
 * and the vision model's words, which quote the page) were served raw, and the next field added must not leak either. Only id-like
 * fields (the model, the test and scenario ids, the capture and independence verdicts, a check's source) are kept as given.
 */
it("every string of the meta is masked (explanation, visionObservations, a field added later); id-like fields are kept (CP3c T-6)", async () => {
    const s = seedProject(platform, "Meta shop all", "http://127.0.0.1:9");
    const job = await platform.repo.createJob(s.projectId, s.appId, { ...DEFAULT_JOB_OPTIONS });
    const sink = new RepoSink(platform.repo, platform.store, { id: job.id, projectId: s.projectId, applicationId: s.appId });
    sink.addSecrets([CLIENT_SECRET, API_TOKEN]);
    const all = (n: number) => ({
        model: "scripted-model-1",
        authoring: "defect",
        capture: "captured",
        explanation: `Blocked (${n}): the header value ${API_TOKEN} with client_secret ${CLIENT_SECRET}`,
        visionObservations: [`The banner shows ${CLIENT_SECRET}`, `Authorization: Bearer ${BEARER}`],
        scenario: { scenarioId: "S-KEY-1", title: `Key ${API_TOKEN}`, expectedResults: [`hides ${CLIENT_SECRET}`] },
        leftovers: [{ step: 2, text: `uses ${API_TOKEN}` }],
        aFieldAddedLater: { deep: [`note ${CLIENT_SECRET}`] },
        capturedCheck: { source: "expected:1", observed: `shows ${CLIENT_SECRET}` },
    });
    const h = await sink.createTest({ spec, framework: "playwright", validation: "NEEDS_REVIEW", reason: "a defect", meta: all(1) });
    await sink.writes.flush();
    const get = async () => {
        const res = await app.inject({ method: "GET", url: `/api/tests/${h.id}`, headers: { "x-api-key": KEY } });
        expect(res.statusCode).toBe(200);
        return res;
    };
    const first = await get();
    for (const secret of [CLIENT_SECRET, API_TOKEN, BEARER]) expect(first.body).not.toContain(secret);
    const m = JSON.parse(first.body).generationMeta;
    expect(m.explanation).toMatch(/^Blocked \(1\): the header value \[hidden\]/);
    expect(m.visionObservations[0]).toBe("The banner shows [hidden]");
    expect(m.leftovers[0].step).toBe(2);
    expect(m).toMatchObject({ authoring: "defect", capture: "captured", scenario: { scenarioId: "S-KEY-1" }, capturedCheck: { source: "expected:1" } });

    await sink.updateTest(h, { spec, validation: "NEEDS_REVIEW", reason: "a defect", attempts: 2, meta: all(2) } as never);
    await sink.writes.flush();
    const second = await get();
    for (const secret of [CLIENT_SECRET, API_TOKEN, BEARER]) expect(second.body).not.toContain(secret);
    expect(JSON.parse(second.body).generationMeta.explanation).toContain("(2)");
});
