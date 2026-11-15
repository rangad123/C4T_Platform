/**
 * Masking on write, the remaining places: a run's error, its step errors and the reasons of browser / environment results are stored
 * masked; an environment's own secrets (and the Basic-auth and header-value forms of every sign-in) are on the job's mask list; and the
 * shared auth-scheme rule hides credentials without hiding English that follows the word "Basic", "Bearer" or "Token".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { protectedFamily } from "../src/engine/quarantine/rules.js";
import { SECURITY_FAILURE_PREFIX } from "../src/engine/security/checks.js";
import { parseSecurityReason } from "../src/engine/security/specs.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { basicAuthForms } from "../src/platform/agent-routing.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { environmentStore, prepareEnvironmentRun } from "../src/platform/environment-run.js";
import { runJob } from "../src/platform/job-runner.js";
import { maskText } from "../src/platform/redact-text.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";
import { redactText } from "../src/shared/redact-text.js";
import { redactText as redactFinding } from "../src/security/findings/redact.js";

const PASSWORD = "Sup3r-Secret-Pw!";
const ENV_PASSWORD = "Stag1ng-Only-Pw#";
const EMAIL = "ada.person@shop.example";
const ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const LEAKY = `expected 200, got 401 for POST /login {"password":"${PASSWORD}"} as ${EMAIL}`;

const spec = (testId: string): TestSpec => TestSpecSchema.parse({ testId, title: `Home ${testId}`, kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });

describe("the auth-scheme rule", () => {
    it("keeps English after Basic, Bearer and Token", () => {
        for (const text of ["Basic security checks, Access checks", "Bearer tokens are refused here", "Token Expired after login", "Basic Security checks", "token authentication failed"]) {
            expect(redactText(text)).toBe(text);
            expect(maskText(text)).toBe(text);
            expect(redactFinding(text)).toBe(text);
        }
    });

    it("hides credentials: base64, mixed case, digits, punctuation, JWTs", () => {
        const basic = basicAuthForms("ada", PASSWORD)[0]!;
        expect(redactText(`Authorization: Basic ${basic}`)).not.toContain(basic);
        expect(redactText("sent Basic dXNlcjpwYXNz to the API")).toBe("sent Basic [hidden] to the API");
        expect(redactText("sent Bearer abc123def456 then")).toBe("sent Bearer [hidden] then");
        expect(redactText("sent bearer s3cr3t-value then")).toBe("sent bearer [hidden] then");
        expect(redactText("header Token a.b_c~d+e/f=")).toBe("header Token [hidden]");
        expect(redactText("header Digest QwErTyUiOp")).toBe("header Digest [hidden]");
        expect(redactText("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln")).toBe("Bearer [hidden]");
        // A security finding's evidence goes through the same rule.
        expect(redactFinding(`Authorization: Basic ${basic}`)).not.toContain(basic);
        expect(redactFinding("Authorization header carried Bearer AbCdEf123456")).toBe("Authorization header carried Bearer [hidden]");
    });

    it("a value that is already masked is left exactly as it is, with the punctuation after it", () => {
        const API = "http://127.0.0.1:9773";
        for (const text of [
            `cannot read a record through the API (GET ${API}/v1/note?id=2&access_token=•••)`,
            `GET ${API}/v1/notes/2?access_token=•••, then again; token=[hidden], and "password": "•••" stays`,
            "session=[hidden]; password: ••••••",
        ]) {
            expect(redactText(text)).toBe(text);
            expect(maskText(text)).toBe(text);
        }
    });

    it("a secret value is still hidden, and sentence punctuation after it stays", () => {
        expect(redactText("(GET /v1/note?id=2&access_token=abc123XYZ)")).toBe("(GET /v1/note?id=2&access_token=[hidden])");
        expect(redactText("tried /a?token=abc123XYZ, then /b?api_key=k-99; done")).toBe("tried /a?token=[hidden], then /b?api_key=[hidden]; done");
        expect(redactText("/a?token=abc,def&x=1")).toBe("/a?token=[hidden]&x=1");
        expect(redactText("password: hunter2)")).toBe("password: [hidden])");
        expect(redactText('{"password": "hunter2"}')).toBe('{"password": "[hidden]"}');
        // A value that only starts like a mask is a value.
        expect(redactText("/a?token=•••abc")).toBe("/a?token=[hidden]");
    });

    it("run-log links by record id and the quarantine heads are kept", () => {
        expect(maskText(`Basic security checks for ${ID} failed`)).toBe(`Basic security checks for ${ID} failed`);
        expect(maskText(`/jobs/${ID}/log?event=${ID}`)).toBe(`/jobs/${ID}/log?event=${ID}`);
    });
});

describe("masking on write: run errors and environment secrets", () => {
    let platform: Platform;
    let dataDir: string;

    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-masking-runs-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const newJob = async (options: Partial<typeof DEFAULT_JOB_OPTIONS> = {}, credentials?: { username: string; password: string }): Promise<JobRow> => {
        const { repo } = platform;
        const projectId = repo.createProject({ name: `Masking runs ${Math.random()}` }).id as string;
        const appId = repo.createApplication(projectId, "http://127.0.0.1:9770", { ...DEFAULT_JOB_OPTIONS }, credentials);
        const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [], ...options });
        const row = repo.claimNextJob(60_000, "owner-m2");
        expect(row?.id).toBe(job.id);
        return row!;
    };
    const executions = (testId: string) =>
        platform.db.all<{ id: string; error: string | null }>("SELECT id, error FROM test_executions WHERE test_case_id = ? ORDER BY started_at", testId);
    const stepErrors = (executionId: string) => platform.db.all<{ error: string | null }>("SELECT error FROM test_execution_steps WHERE execution_id = ? ORDER BY idx", executionId).map((r) => r.error);
    const run = (error: string): ScriptRun => ({
        testId: "TC-951",
        status: "failed",
        durationMs: 10,
        error,
        failedStepIndex: 1,
        steps: [
            { index: 0, title: "Open the sign-in page", status: "passed" },
            { index: 1, title: "Sign in", status: "failed", error },
        ],
        artifacts: [],
        responses: [],
    } as unknown as ScriptRun);

    it("a run's error and its step errors are stored masked", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        sink.addSecrets([PASSWORD]);
        const h = await sink.createTest({ spec: spec("TC-951"), framework: "playwright", validation: "PENDING" });
        await sink.recordExecution(h, null, 1, run(LEAKY), new Date().toISOString());
        const [e] = executions(h.id);
        expect(e!.error).toBe('expected 200, got 401 for POST /login {"password":"[hidden]"} as [email hidden]');
        expect(stepErrors(e!.id)).toEqual([null, e!.error]);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("browser and environment results: reasons and step errors masked; a repeated masked skip is still recognised", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        sink.addSecrets([PASSWORD]);
        const h = await sink.createTest({ spec: spec("TC-952"), framework: "playwright", validation: "PENDING" });
        const at = () => new Date().toISOString();
        await sink.recordVariant!(h, null, { variant: "firefox", status: "failed", reason: LEAKY, run: run(LEAKY) } as any, at());
        await sink.recordVariant!(h, null, { variant: "webkit", status: "skipped", reason: `No browser for ${PASSWORD}` } as any, at());
        await sink.recordVariant!(h, null, { variant: "webkit", status: "skipped", reason: `No browser for ${PASSWORD}` } as any, at());
        await sink.recordEnvironment!(h, null, { environment: "staging", status: "failed", reason: LEAKY, run: run(LEAKY) } as any, at());
        const rows = executions(h.id);
        expect(rows).toHaveLength(3);
        for (const r of rows) {
            expect(r.error).not.toContain(PASSWORD);
            expect(r.error).not.toContain(EMAIL);
            for (const s of stepErrors(r.id)) if (s) expect(s).not.toContain(PASSWORD);
        }
        expect(rows.map((r) => r.error)).toContain("No browser for [hidden]");
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("a finding awaiting review keeps its evidence while every sensitive value in its reason and its event is masked", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        sink.addSecrets([PASSWORD]);
        const bearer = "AbCdEf0123456789xyzQ";
        const cookieValue = "s%3Ak9Jq2LmPzX7";
        const apiKey = "ak_live_51HxYz9";
        const reason = [
            `Sign in — ${SECURITY_FAILURE_PREFIX} 1 session cookie sent without protection`,
            `- [high] Cookie: sid=${cookieValue} was set without Secure on http://127.0.0.1:9770/account?api_key=${apiKey}&tab=2 (status 200). Request carried Authorization: Bearer ${bearer} for ${EMAIL} after typing ${PASSWORD}. Expected the cookie to be marked Secure.`,
        ].join("\n");
        const h = await sink.createTest({ spec: spec("TC-953"), framework: "playwright", validation: "NEEDS_REVIEW", reason });
        sink.event({ stage: "validation", kind: "validation_needs_review", level: "warn", message: `TC-953 needs review: ${reason}`, data: { reason } });
        await sink.writes.flush();
        const stored = platform.db.get<{ validation_status: string; validation_reason: string }>("SELECT validation_status, validation_reason FROM test_cases WHERE id = ?", h.id)!;
        const ev = platform.db.get<{ message: string; data_json: string }>("SELECT message, data_json FROM agent_events WHERE job_id = ? AND kind = 'validation_needs_review'", job.id)!;
        expect(stored.validation_status).toBe("NEEDS_REVIEW");
        for (const text of [stored.validation_reason, ev.message, ev.data_json]) {
            for (const bad of [bearer, cookieValue, apiKey, PASSWORD, EMAIL]) expect(text).not.toContain(bad);
        }
        const kept = stored.validation_reason;
        // The useful evidence stays: step, check headline, severity, status and the assertion.
        expect(kept.startsWith(`Sign in — ${SECURITY_FAILURE_PREFIX} 1 session cookie sent without protection\n- [high] `)).toBe(true);
        expect(kept).toContain("was set without Secure on http://127.0.0.1:9770/account?api_key=[hidden]&tab=2 (status 200)");
        expect(kept).toContain("[email hidden]");
        expect(kept).toContain("Expected the cookie to be marked Secure.");
        expect(parseSecurityReason(kept).severity).toBe("high");
        expect(protectedFamily({ spec: spec("TC-953"), reason: kept })).toBe("security");
        // Nothing beyond the reason itself is kept.
        expect(kept.length).toBeLessThanOrEqual(reason.length);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("the application's sign-in goes on the mask list with its Basic-auth forms and the auth header's value", async () => {
        const job = await newJob({}, { username: "ada", password: PASSWORD });
        const added: string[] = [];
        vi.spyOn(RepoSink.prototype, "addSecrets").mockImplementation(function (this: RepoSink, list) {
            for (const s of list) if (typeof s === "string") added.push(s);
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm }, job, "owner-m2");
        expect(added).toContain(PASSWORD);
        for (const form of basicAuthForms("ada", PASSWORD)) expect(added).toContain(form);
    });

    it("an environment's own secrets, with their Basic-auth and header-value forms, are handed to the job's mask list", async () => {
        const job = await newJob({ mode: "environment", environment: "staging" } as any);
        const store = environmentStore(platform.repo, platform.config);
        const env = store.create(job.projectId, { name: "staging", baseUrl: "http://127.0.0.1:9772", production: false, useProjectAccounts: false, variables: {} });
        store.patchSecrets(env, { username: "stage-user", password: ENV_PASSWORD, apiAuthHeader: "X-Api-Key: kv-Stag1ng-9f8e7d" });
        const app = platform.repo.getApplication(job.applicationId)!;
        const prepared = await prepareEnvironmentRun(platform.repo, platform.config, job, { url: app.url as string, config: (app.config ?? {}) as Record<string, any> }, []);
        expect(prepared.secrets).toEqual(expect.arrayContaining([ENV_PASSWORD, ...basicAuthForms("stage-user", ENV_PASSWORD), "X-Api-Key: kv-Stag1ng-9f8e7d", "kv-Stag1ng-9f8e7d"]));
    });
});
