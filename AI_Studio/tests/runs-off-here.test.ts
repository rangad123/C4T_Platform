/**
 * Tests switched off on the server (WORKER_EMBEDDED=false and no worker heartbeat, as in production): every route that queues a job a
 * worker must pick up refuses with a plain 409 (`cannotRunHere`) before anything is queued, an import keeps its tests and says they
 * were not run, the setup checklist and /api/config say so, and a worker in another process that said it is alive just now is enough.
 * Real server routes via `inject`, a real database, no model, no browser, no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { writeHeartbeat } from "../src/platform/ops/heartbeat.js";
import { buildServer } from "../src/platform/server.js";
import { EXPLORING_OFF_MESSAGE, IMPORTED_NOT_RUN, PLAIN_OFF_MESSAGE, RUNS_OFF_MESSAGE } from "../src/platform/suite-run.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";

let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
let shop: Seed;
let testId: string;

const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const jobs = () => platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM generation_jobs")!.n;
const apiSpec = (title: string) => ({ title, kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/x" }, { action: "assertResponse", check: "status", expected: 200 }] });

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runs-off-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "runs-off-here-secret-key-0123456789" }));
    app = await buildServer(platform);
    await app.ready();
    shop = seedProject(platform, "Hosted shop", "https://shop.example.test");
    testId = addTest(platform, shop, "a");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("tests switched off on this server", () => {
    it("refuses a run, an exploration, a test's own run, an environment run, a browsers check and a described test, and queues nothing", async () => {
        const pid = shop.projectId;
        const refused: Array<[string, string, unknown, string]> = [
            ["runs", `/api/projects/${pid}/runs`, {}, RUNS_OFF_MESSAGE],
            ["exploring", `/api/projects/${pid}/test-generation`, { url: "https://shop.example.test" }, EXPLORING_OFF_MESSAGE],
            ["a plan", `/api/projects/${pid}/test-generation`, { url: "https://shop.example.test", plan: true }, EXPLORING_OFF_MESSAGE],
            ["one test", `/api/tests/${testId}/validate`, {}, RUNS_OFF_MESSAGE],
            ["an environment", `/api/projects/${pid}/environments/staging/runs`, {}, RUNS_OFF_MESSAGE],
            ["other browsers", `/api/projects/${pid}/variants`, { variants: ["firefox"] }, RUNS_OFF_MESSAGE],
            ["a described test", `/api/projects/${pid}/plain-tests`, { description: "Open the home page and check the title" }, PLAIN_OFF_MESSAGE],
            ["the CI validation", `/api/projects/${pid}/validation`, {}, RUNS_OFF_MESSAGE],
        ];
        const apps = platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE project_id = ?", pid)!.n;
        for (const [what, url, body, message] of refused) {
            const r = await call("POST", url, body);
            expect({ what, status: r.status }).toEqual({ what, status: 409 });
            expect(r.body.error).toBe(message);
            expect(r.body.details).toEqual({ cannotRunHere: true });
        }
        expect(jobs()).toBe(0);
        // Nothing was saved on the way either (an exploration keeps its settings on a new application only when it starts).
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE project_id = ?", pid)!.n).toBe(apps);
    });

    it("keeps imported tests and says they were not run", async () => {
        const r = await call("POST", `/api/projects/${shop.projectId}/specs`, { specs: [apiSpec("Imported one")], validate: true });
        expect(r.status).toBe(202);
        expect(r.body.jobId).toBeNull();
        expect(r.body.notRun).toBe(IMPORTED_NOT_RUN);
        expect(r.body.tests).toHaveLength(1);
        expect(platform.repo.getTest(r.body.tests[0].id)?.validationStatus).toBe("PENDING");
        expect(jobs()).toBe(0);
    });

    it("says so in the setup checklist and in the server's facts", async () => {
        const items = (await call("GET", `/api/projects/${shop.projectId}/setup-check`)).body.items as Array<{ key: string; ok: boolean; text: string }>;
        expect(items.find((i) => i.key === "runner")).toEqual({ key: "runner", ok: false, text: "Tests are switched off on this server, so no run starts here. Tests you make are kept." });
        expect((await call("GET", "/api/config")).body.runsHere).toBe(false);
    });

    it("a schedule's Run now is refused and queues nothing, and the schedules list says schedules do not fire", async () => {
        const made = await call("POST", `/api/projects/${shop.projectId}/schedules`, { kind: "validate", cadence: { type: "daily", time: "03:00" } });
        expect(made.status).toBe(201);
        const r = await call("POST", `/api/projects/${shop.projectId}/schedules/${made.body.id}/run`);
        expect(r.status).toBe(409);
        expect(r.body.error).toBe(RUNS_OFF_MESSAGE);
        expect(jobs()).toBe(0);
        const listed = (await call("GET", `/api/projects/${shop.projectId}/schedules`)).body;
        expect(listed).toMatchObject({ schedulerEnabled: false, schedulesFire: false, executionMode: "local" });
        expect(listed.schedulesNote).toMatch(/^Schedules are switched off on this server/); // SCHEDULER_ENABLED=false here; with it on, the note is NO_WORKER_MESSAGE
        expect((await call("GET", "/api/config")).body.executionMode).toBe("local");
        expect((await call("DELETE", `/api/projects/${shop.projectId}/schedules/${made.body.id}`)).status).toBe(204);
    });

    it("starts again once a worker in another process says it is alive, and stops when its word is old", async () => {
        writeHeartbeat(platform.db);
        expect((await call("GET", "/api/config")).body.runsHere).toBe(true);
        const items = (await call("GET", `/api/projects/${shop.projectId}/setup-check`)).body.items as Array<{ key: string; ok: boolean; text: string }>;
        expect(items.find((i) => i.key === "runner")).toMatchObject({ ok: true, text: "Tests run on this server." });
        const r = await call("POST", `/api/projects/${shop.projectId}/runs`, { testIds: [testId] });
        expect(r.status).toBe(202);
        expect(jobs()).toBe(1);
        platform.repo.setJobStatus(r.body.jobId, "COMPLETED");

        writeHeartbeat(platform.db, Date.now() - 10 * 60_000);
        expect((await call("POST", `/api/projects/${shop.projectId}/runs`, { testIds: [testId] })).status).toBe(409);
        expect(jobs()).toBe(1);
    });
});
