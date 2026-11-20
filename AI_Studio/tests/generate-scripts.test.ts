/**
 * "Generate test scripts using AI" in a web project through a real platform (Fastify inject, a real database, a local fake AI provider
 * over HTTP, no browser, no worker: the jobs are not run here; tests/case-scripts-account.test.ts runs them): each written case of type
 * Automated becomes the job Test scripts, Describe it starts, with the case's words as its description, one case after the other;
 * Manual cases, cases that already have a script and cases whose words a described test refuses are skipped; when a case's job ends its
 * test is linked to the case and its requirement and the next case's job starts (not after a cancel, a job that made nothing, or while
 * another run goes on); the dry run counts without the AI; no AI is a 422 in plain words; an agent project is a 409; another
 * project's id is a 404; viewers are refused.
 *
 *   npx vitest run tests/generate-scripts.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { givePersonalKeys } from "./fixtures/ai-key.js";
import { loadConfig } from "../src/config.js";
import { afterCaseJob, caseDescription } from "../src/platform/case-scripts.js";
import { MAX_SCRIPTS_PER_CALL } from "../src/engine/authoring/case-script.js";
import { expectedOf, startPathOf } from "../src/engine/authoring/describe.js";
import { buildXlsx } from "../src/security/findings/xlsx.js";
import { ANOTHER_RUN, NO_ADDRESS_FOR_SCRIPTS, SCRIPTS_BEING_WRITTEN } from "../src/platform/routes/generate-scripts.js";
import { accessControlOf } from "../src/platform/auth/access.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";
import { startFakeProvider, type FakeProvider } from "./fixtures/fake-llm-provider.js";

const KEY = "gen-scripts-key-7c2e9a41";
const MODEL = "script-model";
let fake: FakeProvider;
const dirs: string[] = [];
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let bare: { platform: Platform; app: Awaited<ReturnType<typeof buildServer>> };
let editor = "";
let viewer = "";
let A = "";
let B = "";
let agentOnly = "";

const boot = async (extra: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-genscripts-"));
    dirs.push(dir);
    const pl = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "gen-scripts-secret-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false", ...extra }));
    const a = await buildServer(pl);
    await a.ready();
    return { platform: pl, app: a };
};
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = { "x-api-key": KEY }, srv = app) => {
    const res = await srv.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
};
const gen = (pid: string, body: unknown = {}, headers?: Record<string, string>, srv = app) => call("POST", `/api/projects/${pid}/manual-cases/generate-scripts`, body, headers, srv);
const addCase = async (pid: string, title: string, automation: "automated" | "manual", extra: Record<string, unknown> = {}, srv = app) => {
    const r = await call("POST", `/api/projects/${pid}/manual-cases`, { title, priority: "high", automation, steps: [{ action: "Open the sign-in page and sign in", expected: "The dashboard shows Welcome" }], ...extra }, undefined, srv);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; ref: string; automation: string; linkedTestIds: string[] };
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    fake = await startFakeProvider(7861);
    ({ platform, app } = await boot({ LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${fake.url}/openai/v1`, LLM_MODEL: MODEL, LLM_API_KEY: "fake-key" }));
    bare = await boot({});
    A = platform.repo.createProject({ name: "Atlas shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    platform.repo.createApplication(A, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
    B = platform.repo.createProject({ name: "Other shop", platforms: ["web"], testingModes: ["code"] }).id as string;
    agentOnly = platform.repo.createProject({ name: "Agent shop", platforms: ["web"], testingModes: ["agent"] }).id as string;
    const control = accessControlOf(app);
    const e = control.users.create({ email: "erin@example.com", name: "Erin", role: "editor" });
    editor = control.users.createToken(e.id, { name: "t", role: "editor" }).token;
    // A signed-in person uses their own key on the stand-in provider (round 57: never the server's key).
    await givePersonalKeys(platform, [e.id], { baseUrl: `${fake.url}/openai/v1`, model: MODEL });
    const v = control.users.create({ email: "vic@example.com", name: "Vic", role: "viewer" });
    viewer = control.users.createToken(v.id, { name: "t", role: "viewer" }).token;
}, 60_000);

afterAll(async () => {
    await app?.close();
    await bare?.app.close();
    platform?.db.close();
    bare?.platform.db.close();
    await fake?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("generate test scripts", () => {
    it("starts each Automated case as a described test, built in a real browser one case after the other; skips the rest", async () => {
        const req = await call("POST", `/api/projects/${A}/requirements`, { ref: "REQ-1", title: "People can sign in" });
        expect(req.status, JSON.stringify(req.body)).toBe(201);
        const auto = await addCase(A, "Verify sign in with a valid password", "automated", { requirementId: req.body.id });
        const manual = await addCase(A, "Verify the welcome email reads well", "manual");
        const second = await addCase(A, "Verify the basket keeps its items", "automated");
        fake.reset();

        const dry = await gen(A, { dryRun: true });
        expect(dry.status, JSON.stringify(dry.body)).toBe(200);
        expect(dry.body.eligible).toEqual([auto.id, second.id]);
        expect(dry.body.skipped).toEqual([expect.objectContaining({ caseId: manual.id, reason: "manual" })]);

        const r = await gen(A, {}, { authorization: `Bearer ${editor}` });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body).toMatchObject({ form: "text", created: [], started: { caseIds: [auto.id, second.id] } });
        expect(r.body.skipped.map((s: any) => [s.caseId, s.reason])).toEqual([[manual.id, "manual"]]);
        // Nothing is written without the application: the AI is asked only by the job, in the browser.
        expect(fake.seen).toHaveLength(0);
        const job = platform.repo.getJob(r.body.started.jobId)!;
        // The same job Test scripts, Describe it starts, with the case's own words as its description and the next case queued after it.
        expect(job.options).toMatchObject({ mode: "plain", plainKind: "web", plainCaseId: auto.id, plainCaseQueue: [second.id], plainDescription: caseDescription(auto as any) });
        expect(job.options.plainDescription).toBe("Verify sign in with a valid password\n1. Open the sign-in page and sign in\nCheck that The dashboard shows Welcome");

        // While it is going on, a second call is refused in the page's words, and no second job is queued.
        const again = await gen(A, {});
        expect(again).toMatchObject({ status: 409, body: { error: SCRIPTS_BEING_WRITTEN } });
        expect(platform.repo.listJobs(A)).toHaveLength(1);
        platform.repo.setJobStatus(job.id, "FAILED", "Cancelled");
    });

    it("gives an Automated case imported from the test case workbook its page, preconditions and expected result, not its steps (SPEC R6.5)", async () => {
        const pid = platform.repo.createProject({ name: "Imported shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        const wb = buildXlsx([
            {
                name: "Test cases",
                header: true,
                rows: [
                    ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement"],
                    ["TC-004", "Keep the basket after signing in again", "Automated", "High", "/cart", "Two items are in the basket\nAn address is saved", "Click here => ignored", "The basket lists two items\nIts total is unchanged", ""],
                ],
            },
        ]);
        const imp = await call("POST", `/api/projects/${pid}/manual-cases/import`, { format: "xlsx", content: Buffer.from(wb).toString("base64") });
        expect(imp.status, JSON.stringify(imp.body)).toBe(201);
        expect(imp.body).toMatchObject({ created: 1, stepsIgnored: 1 });
        const r = await gen(pid, {}, { authorization: `Bearer ${editor}` });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const job = platform.repo.getJob(r.body.started.jobId)!;
        expect(job.options.plainDescription).toBe(
            [
                "Keep the basket after signing in again",
                "Start on /cart",
                "Before it starts: Two items are in the basket",
                "Before it starts: An address is saved",
                "Check that The basket lists two items",
                "Check that Its total is unchanged",
            ].join("\n"),
        );
        // The description reader takes the page as where the test starts and each line of the expected result as a check.
        expect(startPathOf(job.options.plainDescription!)).toBe("/cart");
        expect(expectedOf(job.options.plainDescription!)).toEqual(["The basket lists two items", "Its total is unchanged"]);
        platform.repo.setJobStatus(job.id, "FAILED", "Cancelled");
    });

    it("skips a case whose words would be refused for a described test, with that sentence", async () => {
        const pid = platform.repo.createProject({ name: "Pay shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        const pay = await addCase(pid, "Pay for the order", "automated", { steps: [{ action: "Enter the card number and pay", expected: "Paid" }] });
        const r = await gen(pid, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.started).toBeUndefined();
        expect(r.body.skipped).toEqual([expect.objectContaining({ caseId: pay.id, reason: "refused", detail: expect.stringMatching(/pay for something/) })]);
        expect(platform.repo.listJobs(pid)).toHaveLength(0);
    });

    it("refuses plainly without an AI model (422, modelMissing), and dry runs still count", async () => {
        const pid = bare.platform.repo.createProject({ name: "No AI shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        bare.platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        const c = await addCase(pid, "Verify search finds boots", "automated", {}, bare.app);
        const r = await gen(pid, {}, undefined, bare.app);
        expect(r.status).toBe(422);
        expect(r.body.details).toEqual({ modelMissing: true });
        expect(r.body.error).toMatch(/AI model isn’t set up/);
        expect((await gen(pid, { dryRun: true }, undefined, bare.app)).body.eligible).toEqual([c.id]);
    });

    it("is for code-based projects (409 for an agent project), and another project's case is not found", async () => {
        const r = await gen(agentOnly, {});
        expect(r.status).toBe(409);
        expect(r.body.error).toMatch(/code-based projects/);
        const other = await addCase(B, "Verify the other shop opens", "automated");
        const cross = await gen(A, { caseIds: [other.id], dryRun: true });
        expect(cross.body.skipped).toEqual([expect.objectContaining({ caseId: other.id, reason: "not-found" })]);
        expect((await gen("no-such-project", {})).status).toBe(404);
    });

    it("needs the permission to add tests", async () => {
        const r = await gen(A, { dryRun: true }, { authorization: `Bearer ${viewer}` });
        expect(r.status).toBe(403);
    });
});

describe("before and while the AI writes", () => {
    it("refuses a project without an application address before any AI call, in the dry run too", async () => {
        const pid = platform.repo.createProject({ name: "No address shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        await addCase(pid, "Verify sign in", "automated");
        fake.reset();
        for (const body of [{ dryRun: true }, {}]) expect(await gen(pid, body)).toMatchObject({ status: 409, body: { error: NO_ADDRESS_FOR_SCRIPTS } });
        expect(fake.seen).toHaveLength(0);
        expect(platform.repo.listTests(pid)).toHaveLength(0);
    });

    it("another run of the project goes first: the call is refused in plain words and nothing is queued", async () => {
        const pid = platform.repo.createProject({ name: "Busy shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        const appId = platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        await addCase(pid, "Verify sign in twice", "automated");
        const other = await platform.repo.createJob(pid, appId, { ...DEFAULT_JOB_OPTIONS });
        expect(await gen(pid, {})).toMatchObject({ status: 409, body: { error: ANOTHER_RUN } });
        expect(platform.repo.listJobs(pid).map((j) => j.id)).toEqual([other.id]);
        platform.repo.setJobStatus(other.id, "FAILED", "Cancelled");
    });
});

describe("after a test case's job", () => {
    /** A project with three Automated cases, and the first case's job (as the call starts it), not run. */
    async function chain(name: string) {
        const pid = platform.repo.createProject({ name, platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        const req = await call("POST", `/api/projects/${pid}/requirements`, { ref: "REQ-9", title: "Sign in" });
        const cs = [await addCase(pid, "Verify one", "automated", { requirementId: req.body.id }), await addCase(pid, "Verify two", "automated"), await addCase(pid, "Verify three", "automated")];
        const r = await gen(pid, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return { pid, cs, job: platform.repo.getJob(r.body.started.jobId)! };
    }
    /** What the job made: a test of the project stored with the job's id. */
    async function madeBy(pid: string, jobId: string | null) {
        const imported = await call("POST", `/api/projects/${pid}/specs`, { validate: false, specs: [{ title: "Verify one", kind: "web", category: "Plain English", steps: [{ action: "navigate", url: "/" }] }] });
        expect(imported.status, JSON.stringify(imported.body)).toBe(202);
        const id = imported.body.tests[0].id as string;
        if (jobId) platform.db.run("UPDATE test_cases SET job_id = ? WHERE id = ?", jobId, id);
        return id;
    }

    it("links the test it made to its case and the case's requirement, then starts the next case that still needs a script", async () => {
        const { pid, cs, job } = await chain("Chain shop");
        const testId = await madeBy(pid, job.id);
        // The second case got a script meanwhile (by hand): the next job is the third case's.
        platform.db.run("UPDATE manual_cases SET linked_json = ? WHERE id = ?", JSON.stringify([await madeBy(pid, null)]), cs[1]!.id);
        platform.repo.setJobStatus(job.id, "PARTIALLY_COMPLETED");
        const next = await afterCaseJob(platform.repo, job);
        expect((await call("GET", `/api/projects/${pid}/manual-cases/${cs[0]!.id}`)).body.linkedTestIds).toEqual([testId]);
        expect(JSON.stringify((await call("GET", `/api/tests/${testId}/requirements`)).body)).toContain("REQ-9");
        expect(next?.options).toMatchObject({ mode: "plain", plainCaseId: cs[2]!.id, plainCaseQueue: [], plainDescription: "Verify three\n1. Open the sign-in page and sign in\nCheck that The dashboard shows Welcome", startedBy: job.options.startedBy });
        platform.repo.setJobStatus(next!.id, "FAILED", "Cancelled");
    });

    it("8 cases in one call: each case's job starts the next, and all 8 get their script (sheet #12)", async () => {
        const pid = platform.repo.createProject({ name: "Eight chain shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        const cs: Array<{ id: string }> = [];
        for (let i = 0; i < 8; i++) cs.push(await addCase(pid, `Verify part ${i + 1}`, "automated"));
        const r = await gen(pid, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.started.caseIds).toEqual(cs.map((c) => c.id));
        let job: any = platform.repo.getJob(r.body.started.jobId)!;
        for (let i = 0; i < 8; i++) {
            expect(job.options.plainCaseId).toBe(cs[i]!.id);
            // The jobs list says which case each job builds (the card follows them).
            expect((await call("GET", `/api/projects/${pid}/jobs`)).body[0]).toMatchObject({ jobId: job.id, caseId: cs[i]!.id });
            await madeBy(pid, job.id);
            platform.repo.setJobStatus(job.id, "COMPLETED");
            job = await afterCaseJob(platform.repo, job);
        }
        expect(job).toBeNull();
        const list = (await call("GET", `/api/projects/${pid}/manual-cases`)).body.cases;
        expect(list.filter((c: any) => c.linkedTestIds.length === 1)).toHaveLength(8);
    });

    it("queues every case of a web project in one call, more than the per-call limit of phone scripts", async () => {
        const pid = platform.repo.createProject({ name: "Many chain shop", platforms: ["web"], testingModes: ["code"] }).id as string;
        platform.repo.createApplication(pid, "http://127.0.0.1:7862", { ...DEFAULT_JOB_OPTIONS });
        for (let i = 0; i < MAX_SCRIPTS_PER_CALL + 3; i++) await addCase(pid, `Verify item ${i + 1}`, "automated");
        const r = await gen(pid, {});
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.started.caseIds).toHaveLength(MAX_SCRIPTS_PER_CALL + 3);
        expect(r.body.skipped.filter((s: any) => s.reason === "later")).toEqual([]);
        platform.repo.setJobStatus(r.body.started.jobId, "FAILED", "Cancelled");
    });

    it("goes on past a case whose job made no test; stops when the next one fails for the same reason", async () => {
        const empty = await chain("Empty shop");
        platform.repo.setJobStatus(empty.job.id, "FAILED", "The button could not be found");
        const second = await afterCaseJob(platform.repo, empty.job);
        expect(second?.options).toMatchObject({ plainCaseId: empty.cs[1]!.id, plainCaseFailed: "The button could not be found" });
        // A different reason: about that case, so the chain goes on to the third.
        platform.repo.setJobStatus(second!.id, "FAILED", "The page did not load");
        const third = await afterCaseJob(platform.repo, second!);
        expect(third?.options).toMatchObject({ plainCaseId: empty.cs[2]!.id, plainCaseFailed: "The page did not load" });
        platform.repo.setJobStatus(third!.id, "FAILED", "Cancelled");

        const same = await chain("Same reason shop");
        platform.repo.setJobStatus(same.job.id, "FAILED", "The AI model isn’t set up yet");
        const next = await afterCaseJob(platform.repo, same.job);
        expect(next?.options.plainCaseId).toBe(same.cs[1]!.id);
        platform.repo.setJobStatus(next!.id, "FAILED", "The AI model isn’t set up yet");
        expect(await afterCaseJob(platform.repo, next!)).toBeNull();
        // A case that got its script clears the reason carried on.
        const ok = await chain("Clears shop");
        platform.repo.setJobStatus(ok.job.id, "FAILED", "The page did not load");
        const n2 = (await afterCaseJob(platform.repo, ok.job))!;
        await madeBy(ok.pid, n2.id);
        platform.repo.setJobStatus(n2.id, "COMPLETED");
        const n3 = await afterCaseJob(platform.repo, n2);
        expect(n3?.options.plainCaseId).toBe(ok.cs[2]!.id);
        expect(n3?.options.plainCaseFailed).toBeUndefined();
        platform.repo.setJobStatus(n3!.id, "FAILED", "Cancelled");
    });

    it("stops at a cancel, and while another run is going on", async () => {
        const cancelled = await chain("Cancel shop");
        await madeBy(cancelled.pid, cancelled.job.id);
        platform.repo.setJobStatus(cancelled.job.id, "FAILED", "Cancelled");
        expect(await afterCaseJob(platform.repo, cancelled.job)).toBeNull();

        const busy = await chain("Busy chain shop");
        await madeBy(busy.pid, busy.job.id);
        platform.repo.setJobStatus(busy.job.id, "COMPLETED");
        const other = await platform.repo.createJob(busy.pid, busy.job.applicationId, { ...DEFAULT_JOB_OPTIONS });
        expect(await afterCaseJob(platform.repo, busy.job)).toBeNull();
        platform.repo.setJobStatus(other.id, "FAILED", "Cancelled");

        // Not ended yet (handed over to the next platform process): nothing is linked or started.
        const going = await chain("Going shop");
        await madeBy(going.pid, going.job.id);
        expect(await afterCaseJob(platform.repo, going.job)).toBeNull();
        expect((await call("GET", `/api/projects/${going.pid}/manual-cases/${going.cs[0]!.id}`)).body.linkedTestIds).toEqual([]);
        platform.repo.setJobStatus(going.job.id, "FAILED", "Cancelled");
    });
});
