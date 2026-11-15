/**
 * Masking on write (approved policy): job events, job errors, validation reasons, agent run summaries and objective run steps are
 * stored with the run's own secrets and the shared patterns (e-mail addresses, bearer tokens, JWTs, secret query parameters) masked, and
 * authoring agents' tool calls are not stored at all (their agent_actions table was dropped in migration slot 63).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { A11Y_FAILURE_PREFIX } from "../src/engine/a11y/audit.js";
import { AGENT_LIMITS } from "../src/engine/agent/objective.js";
import { protectedFamily } from "../src/engine/quarantine/rules.js";
import { SECURITY_FAILURE_PREFIX } from "../src/engine/security/checks.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { AgentRunStore } from "../src/platform/agent-run-store.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { runJob } from "../src/platform/job-runner.js";
import { memoryContext } from "../src/engine/memory/context.js";
import { distillKnowledge, scrubText } from "../src/engine/memory/distill.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { scrubLogText } from "../src/platform/ops/logger.js";
import { maskText, maskValue } from "../src/platform/redact-text.js";
import { DEFAULT_JOB_OPTIONS, type JobRow } from "../src/platform/repo.js";
import { RepoSink } from "../src/platform/repo-sink.js";

const PASSWORD = "Sup3r-Secret-Pw!";
const TOKEN_URL = "http://127.0.0.1:9771/reset?token=abc123def456&page=2";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
const EMAIL = "ada.person@shop.example";
const ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
/** Text an application error could carry: every kind of thing the masking takes out. */
const LEAKY = `Sign in failed with ${PASSWORD} for ${EMAIL} at ${TOKEN_URL}; header Bearer ${JWT}`;

const clean = (s: string | null | undefined) => {
    expect(s).toBeTruthy();
    for (const bad of [PASSWORD, EMAIL, "abc123def456", JWT]) expect(s).not.toContain(bad);
};

const spec = (testId: string): TestSpec => TestSpecSchema.parse({ testId, title: `Home ${testId}`, kind: "web", category: "Smoke", priority: "high", steps: [{ action: "navigate", url: "/" }] });

describe("the shared masking", () => {
    it("masks the run's secrets and the security module's patterns, and keeps ordinary text", () => {
        const out = maskText(LEAKY, [PASSWORD]);
        clean(out);
        expect(out).toContain("[hidden]");
        expect(out).toContain("[email hidden]");
        expect(out).toContain("http://127.0.0.1:9771/reset?token=[hidden]&page=2");
        expect(out.startsWith("Sign in failed with [hidden] for")).toBe(true);
    });

    it("keeps record ids, unless one is the value of a secret-named parameter", () => {
        expect(maskText(`test ${ID} failed`)).toBe(`test ${ID} failed`);
        expect(maskText(`open /reset?token=${ID}`)).toBe("open /reset?token=[hidden]");
        expect(maskText(`${ID} then ${ID.replace("3f", "4f")}`)).toBe(`${ID} then ${ID.replace("3f", "4f")}`);
    });

    it("masks every string inside data and leaves numbers, booleans and keys", () => {
        expect(maskValue({ taskId: ID, attempt: 2, ok: false, error: LEAKY, steps: [{ url: TOKEN_URL }] }, [PASSWORD])).toEqual({
            taskId: ID,
            attempt: 2,
            ok: false,
            error: maskText(LEAKY, [PASSWORD]),
            steps: [{ url: "http://127.0.0.1:9771/reset?token=[hidden]&page=2" }],
        });
    });

    it("keeps the prefixes the quarantine family check reads", () => {
        const base = { spec: { type: "functional", category: "Smoke", tags: [], steps: [], source: { origin: "explorer" } } } as unknown as Parameters<typeof protectedFamily>[0];
        expect(protectedFamily({ ...base, reason: maskText(`${SECURITY_FAILURE_PREFIX} the cookie for ${EMAIL} is not HttpOnly`) })).toBe("security");
        expect(protectedFamily({ ...base, reason: maskText(`${A11Y_FAILURE_PREFIX} 3 issues at ${TOKEN_URL}`) })).toBe("accessibility");
        const flaky = maskText(`Flaky: passed 1 of 2 runs. The failing run stopped at step 2 "Sign in": ${LEAKY}`, [PASSWORD]);
        expect(flaky.startsWith("Flaky: passed 1 of 2 runs. The failing run stopped at step 2")).toBe(true);
        expect(maskText(`Validation crashed: ${LEAKY}`).startsWith("Validation crashed: ")).toBe(true);
    });
});

describe("masking on write in the stores", () => {
    let platform: Platform;
    let dataDir: string;

    beforeAll(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-masking-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const newJob = async (testIds: string[] = [], credentials?: { username: string; password: string }): Promise<JobRow> => {
        const { repo } = platform;
        const projectId = repo.createProject({ name: `Masking ${Math.random()}` }).id as string;
        const appId = repo.createApplication(projectId, "http://127.0.0.1:9770", { ...DEFAULT_JOB_OPTIONS }, credentials);
        const job = await repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds });
        const row = repo.claimNextJob(60_000, "owner-m1");
        expect(row?.id).toBe(job.id);
        return row!;
    };
    const stored = (jobId: string) => platform.db.all<{ kind: string; message: string; data_json: string | null }>("SELECT kind, message, data_json FROM agent_events WHERE job_id = ? ORDER BY id", jobId);

    it("a job's events through its sink: the run's secrets and the patterns are masked in message and data", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        sink.addSecrets([PASSWORD, undefined, "abc"]);
        sink.event({ stage: "validation", kind: "validation_failed", level: "warn", message: `TC-001 failed: ${LEAKY}`, data: { testId: ID, attempt: 1, error: LEAKY, nested: { url: TOKEN_URL } } });
        await sink.writes.flush();
        const [e] = stored(job.id);
        clean(e!.message);
        expect(e!.message.startsWith("TC-001 failed: Sign in failed with [hidden]")).toBe(true);
        clean(e!.data_json);
        const data = JSON.parse(e!.data_json!);
        expect(data.testId).toBe(ID);
        expect(data.attempt).toBe(1);
        expect(data.nested.url).toBe("http://127.0.0.1:9771/reset?token=[hidden]&page=2");
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("events written straight to the store (runner live events, model events) get the patterns too", async () => {
        const job = await newJob();
        // The runner path masks the run's own secrets first (agent-services.ts), then stores the event here.
        platform.repo.addEvent(job.id, { stage: "validation", kind: "runner_step", level: "warn", message: `Runner: step 3 failed: ${EMAIL} at ${TOKEN_URL}`, data: { taskId: ID, error: `Bearer ${JWT}` } });
        const [e] = stored(job.id);
        expect(e!.message).toBe("Runner: step 3 failed: [email hidden] at http://127.0.0.1:9771/reset?token=[hidden]&page=2");
        expect(JSON.parse(e!.data_json!)).toEqual({ taskId: ID, error: "Bearer [hidden]" });
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("validation reasons and agent run summaries are masked on write, a cancel puts back the masked reason", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        sink.addSecrets([PASSWORD]);
        const h = await sink.createTest({ spec: spec("TC-901"), framework: "playwright", validation: "NEEDS_REVIEW", reason: `Validation crashed: ${LEAKY}` });
        const first = platform.repo.getTest(h.id)!.validationReason as string;
        clean(first);
        expect(first.startsWith("Validation crashed: Sign in failed with [hidden]")).toBe(true);
        await sink.updateTest(h, { validation: "VALIDATING" });
        await sink.updateTest(h, { reason: `${SECURITY_FAILURE_PREFIX} session cookie of ${EMAIL} sent over http; ${PASSWORD}` });
        const second = platform.repo.getTest(h.id)!.validationReason as string;
        clean(second);
        expect(protectedFamily({ spec: spec("TC-901"), reason: second })).toBe("security");
        await sink.restoreTest!(h);
        expect(platform.repo.getTest(h.id)!.validationReason).toBe(first);

        const runId = await sink.startAgentRun("web-authoring", "Sign in");
        await sink.finishAgentRun(runId, "done", `Wrote one test; signed in as ${EMAIL} with ${PASSWORD}`);
        expect(platform.db.get<{ summary: string }>("SELECT summary FROM agent_runs WHERE id = ?", runId)!.summary).toBe("Wrote one test; signed in as [email hidden] with [hidden]");
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("no agent action is stored, whatever the agent reports", async () => {
        const job = await newJob();
        const sink = new RepoSink(platform.repo, platform.store, job);
        const runId = await sink.startAgentRun("web-authoring", "A scenario");
        for (let i = 0; i < 20; i++) sink.agentAction(runId, { tool: "fill", args: { value: PASSWORD }, ok: true, observation: `url=${TOKEN_URL}` });
        await sink.finishAgentRun(runId, "done", "ok");
        await sink.writes.flush();
        expect(platform.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'agent_actions'")!.n).toBe(0);
        platform.repo.setJobStatus(job.id, "FAILED", "test over");
    });

    it("a failed job's error, its failure event, its server log line and the reason of a test it interrupted are masked", async () => {
        const job0 = await newJob([], { username: "ada", password: PASSWORD });
        // A test this job had started: an interrupted validation gives it a reason.
        const sink0 = new RepoSink(platform.repo, platform.store, job0);
        const h = await sink0.createTest({ spec: spec("TC-902"), framework: "playwright", validation: "PENDING" });
        await sink0.updateTest(h, { validation: "VALIDATING" });
        platform.repo.setJobStatus(job0.id, "FAILED", "test over");
        const job = await newJob([h.id], { username: "ada", password: PASSWORD });
        vi.spyOn(platform.repo, "getTest").mockImplementation(() => {
            throw new Error(LEAKY);
        });
        const logged: string[] = [];
        vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
        await runJob({ repo: platform.repo, store: platform.store, config: platform.config, llm: platform.llm }, job, "owner-m1");
        vi.restoreAllMocks();
        const after = platform.repo.getJob(job.id)!;
        expect(after.status).toBe("FAILED");
        clean(after.error);
        expect(after.error!.startsWith("Sign in failed with [hidden] for [email hidden]")).toBe(true);
        const failed = stored(job.id).find((e) => e.kind === "job_failed")!;
        clean(failed.message);
        const line = logged.find((l) => l.includes("job_failed"))!;
        clean(line);
        const reason = platform.repo.getTest(h.id)!.validationReason as string;
        clean(reason);
        expect(reason.startsWith("Validation interrupted: Sign in failed with [hidden]")).toBe(true);
    });

    it("an objective run's steps, reasoning and stop reason are masked on write", async () => {
        const runs = new AgentRunStore(platform.repo.db.sql);
        const projectId = platform.repo.createProject({ name: "Masking agent run" }).id as string;
        const limits = { maxSteps: AGENT_LIMITS.steps.default, maxMinutes: AGENT_LIMITS.minutes.default, maxTokens: AGENT_LIMITS.tokens.default, approvalSeconds: AGENT_LIMITS.approvalSeconds.default };
        const run = await runs.create({ projectId, objective: "Reset the password", startAddress: "http://127.0.0.1:9770/", limits, startedBy: { id: null, name: "test" } });
        await runs.started(run.id);
        await runs.addStep(run.id, { seq: 1, tool: "click", summary: `Clicked the link for ${EMAIL}`, status: "failed", detail: `Bearer ${JWT} refused`, url: TOKEN_URL });
        await runs.finish(run.id, { state: "finished", verdict: "failed", reasoning: `The page showed ${EMAIL}`, stopReason: `Stopped at ${TOKEN_URL}` });
        const [s] = await runs.steps(run.id);
        expect(s).toMatchObject({ summary: "Clicked the link for [email hidden]", detail: "Bearer [hidden] refused", url: "http://127.0.0.1:9771/reset?token=[hidden]&page=2" });
        const done = (await runs.get(run.id))!;
        expect(done.reasoning).toBe("The page showed [email hidden]");
        expect(done.stopReason).toBe("Stopped at http://127.0.0.1:9771/reset?token=[hidden]&page=2");
    });
});

describe("the auth header rule (one shared rule for stored text, logs and site memory)", () => {
    // Shapes the bare-scheme rule keeps as English: all lower case, one capitalised word, one character.
    const SHAPES = ["mysecrettokenvalue", "Sunshine", "x", "abc123", "mfrggzdfmztwq"];
    const forms = (scheme: string, v: string): Array<[string, string]> => [
        [`Authorization: ${scheme} ${v}`, `Authorization: ${scheme} [hidden]`],
        [`proxy-authorization: ${scheme} ${v}`, `proxy-authorization: ${scheme} [hidden]`],
        [`curl -H 'Authorization: ${scheme} ${v}' http://127.0.0.1:9771/api`, `curl -H 'Authorization: ${scheme} [hidden]' http://127.0.0.1:9771/api`],
        [`request carried Authorization: ${scheme} ${v}, then failed`, `request carried Authorization: ${scheme} [hidden], then failed`],
    ];

    it("hides the credential after an Authorization header name whatever its letters or length", () => {
        for (const v of SHAPES)
            for (const scheme of ["Bearer", "Basic", "bearer"])
                for (const [text, want] of forms(scheme, v)) {
                    expect(maskText(text), text).toBe(want);
                    expect(scrubLogText(text, []), text).toBe(want);
                }
    });

    it("hides it in JSON, escaped JSON, name/value pairs and a header with no scheme, and a whole Digest value", () => {
        for (const v of SHAPES) {
            for (const text of [`{"authorization":"Bearer ${v}"}`, `{\\"Authorization\\": \\"Bearer ${v}\\"}`, `headers: { authorization: "Basic ${v}" }`, `{"name":"Authorization","value":"Bearer ${v}"}`, `["Authorization", "Bearer ${v}"]`, `Authorization: ${v}`, `Authorization=${v}`]) {
                for (const out of [maskText(text), scrubLogText(text, []), scrubText(text, [], 500)]) {
                    expect(out, text).not.toContain(v);
                    expect(out, text).toMatch(/\[hidden\]|\[token\]/);
                }
            }
        }
        const digest = 'Authorization: Digest username="ada", realm="shop", nonce="abc", response="lowercaseresponse"';
        expect(maskText(digest)).toBe("Authorization: Digest [hidden]");
        expect(scrubLogText(digest, [])).toBe("Authorization: Digest [hidden]");
        expect(scrubText("Authorization: Bearer mysecrettokenvalue")).toBe("Authorization: [token]");
    });

    it("keeps English readable and leaves masked values and the rest of the line alone", () => {
        for (const text of ["Basic security checks, Access checks", "Bearer tokens are refused here", "Token Expired after login", "The Authorization header was missing", "Authorization failed for the admin page", "Basic OAuth settings"]) {
            expect(maskText(text), text).toBe(text);
            // The server log and site memory hide every word after a bare "bearer" (approved policy), so that sentence is masked there.
            if (/bearer/i.test(text)) continue;
            expect(scrubLogText(text, []), text).toBe(text);
            expect(scrubText(text), text).toBe(text);
        }
        expect(scrubLogText("Bearer tokens are refused here", [])).toBe("Bearer [hidden] are refused here");
        expect(maskText("Authorization: Bearer [hidden] then 200")).toBe("Authorization: Bearer [hidden] then 200");
        expect(maskText("Authorization: Bearer mysecrettokenvalue status=200 for /orders")).toBe("Authorization: Bearer [hidden] status=200 for /orders");
        // A bare scheme word still hides what looks like a credential, short ones with a digit included.
        expect(maskText("sent Bearer abc123 then")).toBe("sent Bearer [hidden] then");
        expect(scrubLogText("sent Basic dXNlcjpwYXNz to the API", [])).toBe("sent Basic [hidden] to the API");
    });
});

describe("secret-named keys followed by prose (over-masking regressions)", () => {
    it("keeps words that only start like a secret key name, and prose after a secret-named key", () => {
        for (const text of ["authored: The release notes", "Author: Ada wrote this", "authority: the city council", "authenticated: yes", "secret: is not documented", "password: required", "token: missing", "api_key: none", "Authorization: none", "authorization: is required"]) {
            expect(maskText(text), text).toBe(text);
        }
    });
    it("still hides real values after the same keys", () => {
        expect(maskText("secret: s3cr3t-value")).toBe("secret: [hidden]");
        expect(maskText("password: hunter2isme")).toBe("password: [hidden]");
        expect(maskText("auth_token=lowercaseword")).toBe("auth_token=[hidden]");
        expect(maskText("Authorization: noneofyourbusiness")).toBe("Authorization: [hidden]");
    });
});

describe("auth-named keys: only the prose words are exempt", () => {
    it("hides authorization / authentication values and their compounds everywhere", () => {
        const cases: Array<[string, string]> = [
            ["https://x.example/cb?authorization=s3cr3tValue99", "s3cr3tValue99"],
            ["https://x.example/cb?authorisation=s3cr3tValue99&page=2", "s3cr3tValue99"],
            ["authentication: hunter2pass", "hunter2pass"],
            ["x_authentication=lowercasesecret", "lowercasesecret"],
            ["authenticationKey=k3y-value-77", "k3y-value-77"],
            ['{"authorizationKey":"zz-secret-41"}', "zz-secret-41"],
            ['"proxyAuthorization":"Bearer abcdefghij"', "abcdefghij"],
            ["authorId: 42", "42"],
        ];
        for (const [text, secret] of cases) {
            expect(maskText(text), text).not.toContain(secret);
            expect(maskText(text), text).toContain("[hidden]");
        }
        expect(maskText("https://x.example/cb?authorization=s3cr3tValue99")).toBe("https://x.example/cb?authorization=[hidden]");
    });
    it("keeps the prose words author, authored, authoring, authors, authority, authorities, authentic", () => {
        for (const text of ["author: Ada Writer", "authors: Ada and Bo", "authored: The release notes", "authoring: done by hand", "authority: the city council", "authorities: two councils", "authentic: certainly"]) {
            expect(maskText(text), text).toBe(text);
        }
    });
});

describe("no numeric exemptions", () => {
    it("keeps a number after a secret-looking name hidden", () => {
        expect(maskText("Session: 3 tests")).toBe("Session: [hidden] tests");
        expect(maskText("password: 1234")).toBe("password: [hidden]");
        expect(maskText("secret_pin=4821 then")).toBe("secret_pin=[hidden] then");
        expect(maskText('{"sessionPin": 4821}')).toBe('{"sessionPin": "[hidden]"}');
        expect(maskText("https://x.example/a?token=4821")).toBe("https://x.example/a?token=[hidden]");
    });
});

describe("a bare bearer in the server log and site memory (strict)", () => {
    it("hides every value after a bare bearer, any case and shape", () => {
        for (const text of ["sent bearer abcdefghijklmnop to the api", "sent Bearer abcdefghijklmnop to the api", "sent BEARER Sunshine to the api", "sent bearer x to the api", "sent Basic dXNlcmxvd2Vy to the api"]) {
            const secret = text.split(" ")[2]!;
            expect(scrubLogText(text, []), text).not.toContain(` ${secret} `);
            expect(scrubText(text, [], 500), text).not.toContain(` ${secret} `);
        }
        expect(scrubLogText("sent bearer abcdefghijklmnop to the api", [])).toBe("sent bearer [hidden] to the api");
        expect(scrubText("sent bearer abcdefghijklmnop to the api", [], 500)).toBe("sent [token] to the api");
        // Header-named values and authorization/authentication values stay hidden in both.
        for (const text of ["Authorization: Bearer lowercasevalue", "proxy-authorization: lowercasevalue", "https://x.example/cb?authorization=s3cr3tValue99", "https://x.example/cb?authentication=s3cr3tValue99"]) {
            for (const out of [scrubLogText(text, []), maskText(text)]) {
                expect(out, text).toMatch(/\[hidden\]|\[token\]/);
                expect(out, text).not.toMatch(/lowercasevalue|s3cr3tValue99/);
            }
        }
        expect(maskText("authentication: hunter2pass")).toBe("authentication: [hidden]");
        expect(scrubText("Authorization: Bearer lowercasevalue")).toBe("Authorization: [token]");
    });
    it("masks before the site memory is stored and before it is sent to the model", () => {
        const secret = "abcdefghijklmnop";
        const m = {
            url: "http://shop.test/", origin: "http://shop.test", siteType: "ecommerce", purpose: `Uses bearer ${secret} for the api`, features: [], navigation: [], apis: [],
            pages: [{ url: "http://shop.test/", path: "/", title: `Home bearer ${secret}`, type: "content", depth: 1, status: 200, headings: ["h"], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] }],
            journeys: [], externalDependencies: [], documentedTestCases: [], authentication: { required: false, mechanisms: [], loggedIn: false },
            stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
        } as unknown as AppModel;
        const knowledge = distillKnowledge(m, { secrets: [] });
        expect(JSON.stringify(knowledge)).not.toContain(secret);
        for (const stage of ["understanding", "planning"] as const) {
            const prompt = memoryContext(knowledge, stage);
            expect(prompt).toContain("[token]");
            expect(prompt).not.toContain(secret);
        }
    });
});
