/**
 * Agent runs and approval gaps, the parts with no browser: what a run of approved tests does with a repair, the high-impact rule failing closed,
 * and the setting that keeps agent runs off a shared server.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import type { ScriptExecutor } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { REPAIR_WAITS_FOR_REVIEW, validateBatch, type ValidationDeps } from "../src/engine/validation/validator.js";

const failed = (testId: string): ScriptRun => ({ testId, status: "failed", durationMs: 1, failedStepIndex: 1, error: "expected 200, got 201", steps: [], artifacts: [], responses: [] });
const spec = TestSpecSchema.parse({
    testId: "API-001",
    title: "Things are listed",
    kind: "api",
    steps: [
        { action: "request", method: "GET", path: "/things", auth: "none" },
        { action: "assertResponse", check: "status", expected: 200 },
    ],
});

describe("a run of approved tests", () => {
    const answers = [
        { category: "assertion", fixable: true, reason: "The service answers 201." },
        { verdict: "fix", reason: "Expect 201.", steps: [{ action: "request", method: "GET", path: "/things", auth: "none" }, { action: "assertResponse", check: "status", expected: 201 }] },
    ];
    const run = async (repairsAreDrafts: boolean) => {
        let runs = 0;
        const executor: ScriptExecutor = { name: "fake", execute: async (_id, b) => b.scripts.map((s) => (runs++, failed(s.testId))) };
        const queue = [...answers];
        const ctx: EngineContext = {
            config: loadConfig({}),
            emit: () => undefined,
            llm: { modelName: "fake", model: undefined as never, usage: { inputTokens: 0, outputTokens: 0 }, object: (async () => queue.shift()) as never, text: async () => "" },
        };
        const deps: ValidationDeps = { scratchDir: "/scratch", env: { baseUrl: "http://x", headless: true }, render: { baseUrl: "http://x" }, model: { baseUrl: "http://x", pages: [], forms: [], apiEndpoints: [] } as never, maxRepairAttempts: 2, workers: 1, executor, ...(repairsAreDrafts ? { repairsAreDrafts } : {}) };
        const repaired: unknown[] = [];
        const [outcome] = await validateBatch(ctx, deps, [{ spec, framework: "playwright-api" }], { onAttempt: async () => undefined, onFinal: async () => undefined, onRepaired: async (_t, s) => void repaired.push(s) });
        return { runs, outcome: outcome!, repaired };
    };

    it("keeps the repair as a version for review, runs nothing more, and the failure stands", async () => {
        const r = await run(true);
        expect(r.runs).toBe(1);
        expect(r.repaired).toHaveLength(1);
        expect(r.outcome.status).toBe("FAILED_VALIDATION");
        expect(r.outcome.reason).toContain(REPAIR_WAITS_FOR_REVIEW);
    });

    it("while building a test, a repair is still tried with a run (drafts being made)", async () => {
        const r = await run(false);
        expect(r.runs).toBe(2);
    });
});

describe("agent runs on a shared server", () => {
    it("are off unless AGENT_RUNS_ON_SERVER is exactly true, and refused first whatever else is set", async () => {
        const { agentRunsCanStart, AGENT_RUNS_OFF } = await import("../src/platform/agent-run.js");
        expect(loadConfig({}).AGENT_RUNS_ON_SERVER).toBe(false);
        expect(loadConfig({ AGENT_RUNS_ON_SERVER: "yes" }).AGENT_RUNS_ON_SERVER).toBe(false);
        expect(loadConfig({ AGENT_RUNS_ON_SERVER: "true" }).AGENT_RUNS_ON_SERVER).toBe(true);
        const config = { ...loadConfig({}), WORKER_EMBEDDED: true };
        expect(await agentRunsCanStart({ config } as never, "p1")).toEqual({ ok: false, reason: AGENT_RUNS_OFF });
    });

    it("the deploy for the shared box does not set it", async () => {
        const fs = await import("node:fs");
        expect(fs.readFileSync(new URL("../deploy/c4t-box/deploy.sh", import.meta.url), "utf8")).not.toContain("AGENT_RUNS_ON_SERVER");
    });
});

describe("the high-impact pause fails closed (the review's proof, poc7)", () => {
    it("pauses what used to pass unchecked", async () => {
        const { highImpactOf } = await import("../src/engine/agent/high-impact.js");
        const post = { inForm: true, formMethod: "post" };
        // A span inside the submit button: readElement reads the nearest clickable ancestor, the button itself.
        expect(highImpactOf({ action: "click", locatorWords: "Save", element: { tag: "button", type: "submit", text: "Save", ...post } })?.kind).toBe("submit");
        expect(highImpactOf({ action: "click", element: { tag: "button", type: "button", text: "Save", ...post } })?.kind).toBe("submit");
        expect(highImpactOf({ action: "click", locatorWords: "#go" })?.why).toMatch(/could not be read/);
        expect(highImpactOf({ action: "press", key: "Enter" })?.kind).toBe("submit");
        expect(highImpactOf({ action: "click", element: { tag: "button", text: "Eliminar cuenta" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", element: { tag: "a", text: "Go", href: "https://s.example/api/deleteAccount" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "navigate", url: "/users/7/deleteUser" })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", element: { tag: "button", type: "button", text: "Yes", inDialog: true, dialogText: "Remove this project?" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "click", element: { tag: "button", type: "button", text: "OK", inDialog: true, dialogText: "Are you sure?" } })?.kind).toBe("submit");
    });

    it("typing, choosing and ticking go through the words check, without counting as sending a form", async () => {
        const { highImpactOf } = await import("../src/engine/agent/high-impact.js");
        expect(highImpactOf({ action: "select", value: "Delete selected", element: { tag: "select", ariaLabel: "Bulk action" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "check", element: { tag: "input", type: "checkbox", label: "Unsubscribe from all mail", inForm: true, formMethod: "post" } })?.kind).toBe("delete");
        expect(highImpactOf({ action: "fill", element: { tag: "input", label: "Amount to transfer", inForm: true, formMethod: "post" } })?.kind).toBe("pay");
        expect(highImpactOf({ action: "fill", element: { tag: "input", label: "Search", inForm: true, formMethod: "post" } })).toBeUndefined();
        expect(highImpactOf({ action: "check", element: { tag: "input", type: "checkbox", label: "Remember me", inForm: true, formMethod: "post" } })).toBeUndefined();
    });

    it("leaves ordinary links and reading forms alone", async () => {
        const { highImpactOf } = await import("../src/engine/agent/high-impact.js");
        expect(highImpactOf({ action: "click", element: { tag: "a", text: "Products", href: "https://s.example/products" } })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: { tag: "button", text: "Search", inForm: true, formMethod: "get" } })).toBeUndefined();
        expect(highImpactOf({ action: "click", element: { tag: "button", text: "Close", inDialog: true, dialogText: "Saved" } })).toBeUndefined();
    });
});

describe("sign-in details on an environment", () => {
    it("are the environment's own, with the project's filling gaps only on the application's own site", async () => {
        const { environmentCredentials } = await import("../src/platform/plain-run.js");
        const project = { username: "owner@shop.example", password: "project-password-1" };
        expect(environmentCredentials("https://shop.example/", project, "https://other.example", {})).toBeUndefined();
        expect(environmentCredentials("https://shop.example/", project, "https://other.example", { username: "e@x.example", password: "env-pass" })).toEqual({ username: "e@x.example", password: "env-pass" });
        expect(environmentCredentials("https://shop.example/", project, "https://shop.example/staging", { password: "" })).toEqual(project);
        expect(environmentCredentials("https://shop.example/", project, "https://shop.example", { password: "env-pass" })).toEqual({ ...project, password: "env-pass" });
    });
});

describe("hand-written scripts and runners that are no longer used", () => {
    it("a team or shared runner left in the database is offered nothing, even one that allows code scripts; the owner's own runner gets them", async () => {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const { randomUUID } = await import("node:crypto");
        const { bootstrap } = await import("../src/platform/bootstrap.js");
        const { getAgentServices } = await import("../src/platform/agent-services.js");
        const { hashToken, newAgentToken, OPEN_OWNER_ID } = await import("../src/platform/agent-store.js");
        const { TaskOffer } = await import("../src/agent-protocol/schema.js");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-b33-shared-"));
        const p = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false", SECRET_KEY: "b33-shared-runner-secret-key-0123456789" }));
        try {
            const projectId = p.repo.createProject({ name: "Shop" }).id as string;
            const svc = getAgentServices(p);
            const app = p.repo.createApplication(projectId, "http://x.example/", {});
            const jobId = (await p.repo.createJob(projectId, app as never, { mode: "validate", testIds: [], startedBy: { kind: "open", id: null } } as never)).id;
            const caps = { os: "linux", arch: "x64", node: "24", browsers: ["chromium"], record: false, customScripts: true, runnerSwitches: true } as never;
            const offer = TaskOffer.parse({ taskId: "11111111-1111-4111-8111-111111111111", jobId, adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "WEB-001", filename: "web-001.spec.ts", content: "//", custom: true }], env: { baseUrl: "http://x.example", headless: true } });
            svc.store.enqueue({ id: offer.taskId, projectId, jobId, adapterId: "playwright", payloadEnc: svc.encrypt(offer), files: [] });
            // A team runner of the project (as rounds 34-44 made them), with every switch on: it is offered nothing.
            const secret = newAgentToken();
            const teamId = randomUUID();
            p.db.run("INSERT INTO agent_tokens (id, project_id, label, token_hash, hint, created_at, kind, allow_code_scripts) VALUES (?,?,?,?,?,?,?,?)", teamId, projectId, "Lab", hashToken(secret), secret.slice(-4), new Date().toISOString(), "team", 1);
            const team = svc.store.upsertAgent(svc.store.getToken(teamId)!, { name: "lab", version: "1", capabilities: caps, concurrency: 1 });
            expect(svc.offerTo(team, 1)).toBeUndefined();
            expect(svc.store.claimFor(offer.taskId, team, 60_000)).toBeUndefined();
            expect(() => svc.authenticate(`Bearer ${secret}`)).toThrow(/Set up your own runner from Settings/);
            // The open server's own runner, code scripts on: it gets the task.
            const { record } = svc.store.createPersonalToken({ ownerId: OPEN_OWNER_ID, label: "mine", createdBy: "test" });
            const own = svc.store.upsertAgent(record, { name: "mine", version: "1", capabilities: caps, concurrency: 1 });
            expect(svc.offerTo(own, 1)?.taskId).toBe(offer.taskId);
        } finally {
            p.db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("what an agent run keeps out of the model", () => {
    it("includes the API header, its value alone, and the OAuth client secret", async () => {
        const { secretsOf } = await import("../src/platform/agent-run.js");
        const out = secretsOf({ password: "pw-123456", apiAuthHeader: "X-Api-Key: header-secret-9876", oauth2: { clientSecret: "client-secret-5555" } }, []);
        expect(out).toEqual(expect.arrayContaining(["pw-123456", "X-Api-Key: header-secret-9876", "header-secret-9876", "client-secret-5555"]));
    });
});

describe("the project's accounts on an environment", () => {
    it("count only on the application's own site", async () => {
        const { sameSite } = await import("../src/platform/plain-run.js");
        expect(sameSite("https://shop.example/", "https://shop.example/staging")).toBe(true);
        expect(sameSite("https://shop.example/", "https://other.example")).toBe(false);
        expect(sameSite("https://shop.example/", "http://shop.example")).toBe(false);
        expect(sameSite("https://shop.example/", "not an address")).toBe(false);
    });
});

describe("a run waiting for a person", () => {
    it("waits at most 10 minutes, so it cannot hold the worker for an hour", async () => {
        const { AGENT_LIMITS } = await import("../src/engine/agent/objective.js");
        expect(AGENT_LIMITS.approvalSeconds.max).toBe(600);
        expect(AGENT_LIMITS.approvalSeconds.default).toBeLessThanOrEqual(600);
    });
});
