/**
 * An exploration whose planning call failed, so nothing was planned, fails with one sentence naming the cause, through real jobs:
 * HTTP API -> queue -> worker -> real discovery of a local site -> understanding and planning with a scripted model double (never a
 * real model). Page health checks are on in every case, so the job would otherwise still create tests and end partly completed.
 *   - understanding answers, planning fails: the job is FAILED with the sentence, and no test is created;
 *   - with a requirements document, the requirements' planning call fails and the other answers with no test ideas: the same, naming
 *     the failed call;
 *   - functional test cases are off for the project (an empty plan on purpose): the job ends as before, with its checks;
 *   - planning answers with no test ideas (nothing failed): the job ends as before, with its checks.
 * Fixture site: port 9741 (tests/fixtures/memory-site.ts). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/empty-plan-fails.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 9741;
const URL = `http://127.0.0.1:${PORT}`;
const CAUSE = "The AI did not answer within 300 seconds";

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

/** What the planning call does in the current case. */
let planning: "fail" | "first fails" | "nothing" = "fail";
let planningCalls = 0;
const scripted: LlmClient = {
    modelName: "scripted",
    get model(): never {
        throw new Error("no agent model in this test");
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    text: async () => "",
    imageObject: async () => {
        throw new Error("no image calls in this test");
    },
    object: (async ({ system, purpose }: { system: string; purpose?: string }) => {
        if (/analysing a web application/.test(system)) {
            return {
                siteType: "ecommerce",
                purpose: "A small shop",
                features: ["Browse products"],
                pagePurposes: [],
                journeys: [{ name: "Browse products", description: "Look at products", steps: ["Open products"], priority: "high", pages: ["/", "/products"], requiresAuth: false }],
                authenticationMechanisms: [],
            };
        }
        // Reading the requirements document answers with nothing (the requirements found by the parser are kept).
        if (/normalise software requirements/.test(system)) return { requirements: [] };
        if (purpose === "planning") {
            planningCalls++;
            if (planning === "fail" || (planning === "first fails" && planningCalls === 1)) throw new Error(CAUSE);
            return { scenarios: [] };
        }
        throw new Error(`unexpected model call: ${purpose ?? system.slice(0, 60)}`);
    }) as LlmClient["object"],
};

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-empty-plan-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => scripted }, 100);
    worker.start();
}, 60_000);

afterAll(async () => {
    await worker?.stop();
    await server?.close();
    platform?.db.close();
    site?.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await server.inject({ method, url, payload: payload as never });
    return { status: res.statusCode, body: res.body.startsWith("{") || res.body.startsWith("[") ? JSON.parse(res.body) : res.body };
};

/**
 * One exploration of the site by a project tested by the AI agent with these testing agents. A choice with the Test Case Generation Agent
 * is not saved: that would make a Test Case Generation project, whose explorations stop at a plan (case-agent.ts). With no saved choice the
 * project plans functional test cases and runs the checks asked for (page health here), as such a choice did before.
 */
async function explore(name: string, agents: string[], extra: Record<string, unknown> = {}) {
    const made = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], ...(agents.includes("test-generation") ? {} : { agents }) });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    planningCalls = 0;
    const queued = await call("POST", `/api/projects/${made.body.id}/test-generation`, { url: URL, targets: ["web"], maxPages: 10, healthChecks: true, ...(agents.includes("test-generation") ? { inputChecks: false } : {}), ...extra });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    let job: { status: string; error?: string | null } | undefined;
    for (let i = 0; i < 480; i++) {
        job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
        await new Promise((r) => setTimeout(r, 400));
    }
    const tests = platform.repo.listTests(made.body.id);
    const events = (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body as Array<{ kind: string; message: string }>;
    return { job: job!, tests: tests.length, events };
}

describe("an empty plan after a failed planning call", () => {
    it("fails the job with one sentence naming the cause; nothing is created", async () => {
        planning = "fail";
        const r = await explore("Planning fails", ["test-generation", "ux"]);
        expect(planningCalls).toBeGreaterThan(0);
        expect(r.job.status).toBe("FAILED");
        expect(r.job.error).toBe(`No test ideas were planned because planning failed: ${CAUSE}.`);
        expect(r.tests).toBe(0);
        expect(r.events.find((e) => e.kind === "job_failed")?.message).toBe(r.job.error);
    }, 300_000);

    it("one planning call fails and the other plans nothing: the job fails the same way, naming the failed call", async () => {
        planning = "first fails";
        // A requirement about no page of the site: no area call shows it (planner.ts retrieves the ones about an area's pages), so the
        // catch-all requirements pass plans it, the second planning call.
        const doc = "# Billing\n\n- Refunds reach the customer's bank within five working days.\n";
        const r = await explore("One planning call fails", ["test-generation", "ux"], { requirements: { filename: "requirements.md", contentBase64: Buffer.from(doc).toString("base64") } });
        expect(planningCalls).toBeGreaterThan(1);
        expect(r.job.status).toBe("FAILED");
        expect(r.job.error).toMatch(new RegExp(`^No test ideas were planned because planning failed: ${CAUSE}: 1 of 2 planning call\\(s\\) did not finish, so the plan has the 0 test idea\\(s\\) made before that\\.$`));
        expect(r.tests).toBe(0);
    }, 300_000);

    it("functional test cases off (empty on purpose): no planning call, and the job ends with its checks as before", async () => {
        planning = "fail";
        const r = await explore("Functional tests off", ["ux"]);
        expect(planningCalls).toBe(0);
        expect(r.events.some((e) => e.kind === "functional_tests_off")).toBe(true);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(r.job.status);
        expect(r.tests).toBeGreaterThan(0);
    }, 300_000);

    it("planning answers with no test ideas (no call failed): the job ends with its checks as before", async () => {
        planning = "nothing";
        const r = await explore("Nothing planned", ["test-generation", "ux"]);
        expect(planningCalls).toBeGreaterThan(0);
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(r.job.status);
        expect(r.tests).toBeGreaterThan(0);
    }, 300_000);
});
