/**
 * An exploration whose AI reading of the application (the understanding call) failed, through real jobs: HTTP API -> queue -> worker ->
 * real discovery of a local site -> a scripted model double (never a real model). Page health checks are on in every case, so the job
 * would otherwise still create tests and end with them.
 *   - an AI model is set up and the reading call fails: the job is FAILED with one sentence naming the cause, and no test is created;
 *   - no AI model is set up (or no key): the job ends as before, with its checks.
 * Fixture site: port 9831 (tests/fixtures/memory-site.ts). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/reading-fails.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";
import { startMemorySite, type MemorySite } from "./fixtures/memory-site.js";

const PORT = 9831;
const URL = `http://127.0.0.1:${PORT}`;
const CAUSE = "The AI did not answer within 300 seconds";

let site: MemorySite;
let platform: Platform;
let server: Awaited<ReturnType<typeof buildServer>>;
let worker: Worker;
let dir: string;

let readingCalls = 0;
/** A model that is set up, whose reading call fails. */
const failing: LlmClient = {
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
            readingCalls++;
            throw new Error(CAUSE);
        }
        throw new Error(`unexpected model call: ${purpose ?? system.slice(0, 60)}`);
    }) as LlmClient["object"],
};
/** What the current case's job gets. */
let client: LlmClient = failing;

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    site = await startMemorySite(PORT);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-reading-fails-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic", CONCURRENCY: "1" }));
    server = await buildServer(platform);
    worker = new Worker({ ...platform, makeLlm: () => client }, 100);
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

/** One exploration of the site by a project tested by the AI agent. */
async function explore(name: string) {
    // Not a Test Case Generation project: that one explores plan-only and makes no checks (tests/case-agent-plan-only.test.ts).
    const made = await call("POST", "/api/projects", { name, platforms: ["web"], testingModes: ["agent"], agents: ["ux"] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    readingCalls = 0;
    const queued = await call("POST", `/api/projects/${made.body.id}/test-generation`, { url: URL, targets: ["web"], maxPages: 10, healthChecks: true, inputChecks: false });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    let job: { status: string; error?: string | null } | undefined;
    for (let i = 0; i < 480; i++) {
        job = (await call("GET", `/api/test-generation/${queued.body.jobId}`)).body;
        if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
        await new Promise((r) => setTimeout(r, 400));
    }
    const events = (await call("GET", `/api/test-generation/${queued.body.jobId}/events`)).body as Array<{ kind: string; message: string }>;
    return { job: job!, tests: platform.repo.listTests(made.body.id).length, events };
}

describe("a failed AI reading of the application", () => {
    it("with an AI model set up, fails the job with one sentence naming the cause; nothing is created", async () => {
        client = failing;
        const r = await explore("Reading fails");
        expect(readingCalls).toBeGreaterThan(0);
        expect(r.job.status).toBe("FAILED");
        expect(r.job.error).toBe(`The application could not be read with AI: ${CAUSE}.`);
        expect(r.tests).toBe(0);
        expect(r.events.find((e) => e.kind === "job_failed")?.message).toBe(r.job.error);
    }, 300_000);

    it("with no AI model set up, ends as before with its checks", async () => {
        client = unavailableLlmClient("No AI model is set up for this platform.");
        const r = await explore("No AI");
        expect(["COMPLETED", "PARTIALLY_COMPLETED"]).toContain(r.job.status);
        expect(r.tests).toBeGreaterThan(0);
    }, 300_000);
});
