/**
 * Framework settings applied by the REAL runners, without any application or browser: the scripts here are hand-written Playwright
 * Test files that only report what the runner gave them (the time limit and worker count Playwright was configured with, whether
 * a visible window was asked for). Nothing opens a window.
 *
 *  1. The real agent program against a fake platform: a task that carries `testTimeoutMs` and `env.headless = false` is run with that
 *     limit and PW_HEADLESS=false; a task without them runs exactly as before (60 s, headless). A device task's limit reaches the
 *     Taqwright runner (stand-in CLI, no emulator).
 *  2. The platform's own runner: the settings wrapper around the local executor puts the project's limit in the generated config; web
 *     and API scripts of one batch each get their own limit.
 *
 * Playwright starts a node process: run with  node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/framework-settings-agent.test.ts
 * Ports: fake platform 5952.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import type { AgentConfig } from "../src/agent/config.js";
import { memoryLogger } from "../src/agent/log.js";
import { REPO_ROOT } from "../src/config.js";
import { localExecutor } from "../src/engine/frameworks/index.js";
import { clampSettings, describeDeviations, effectiveSettings, FrameworkSettingsInput, mergeSettings, defaultFrameworkSettings } from "../src/engine/frameworks/settings.js";
import { withFrameworkSettings } from "../src/engine/frameworks/settings-executor.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { FakePlatform } from "./fixtures/fake-platform.js";

const TOKEN = "aitg_SettingsToken0123456789abcdefghijk";
const FAKE_CLI = path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs");
const OBSERVED = path.join(os.tmpdir(), "aitp-fake-taqwright-observed.json");

let tmp: string;
let workDir: string;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-fwset-agent-"));
    workDir = path.join(tmp, "work"); // outside the checkout on purpose: the agent links the checkout's node_modules into it
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A Playwright Test file with no browser: it fails on purpose with what the runner configured, so the result carries the facts. */
const probeScript = (testId: string) => ({
    testId,
    filename: `${testId}.spec.ts`,
    content: `import { test } from "@playwright/test";\ntest("probe", async ({}, testInfo) => {\n    throw new Error("LIMIT=" + testInfo.timeout + " WORKERS=" + testInfo.config.workers + " HEADLESS=" + process.env.PW_HEADLESS);\n});\n`,
});
const factsOf = (error: string | undefined) => /LIMIT=(\d+) WORKERS=(\d+) HEADLESS=(\w+)/.exec(error ?? "")?.slice(1);

let counter = 0;
const offer = (adapterId: string, scripts: TaskOffer["scripts"], extra: Partial<TaskOffer> = {}, env: Partial<TaskOffer["env"]> = {}): TaskOffer => ({
    taskId: `task-${++counter}-${Math.random().toString(16).slice(2, 8)}`,
    jobId: "job-1",
    adapterId,
    leaseSeconds: 60,
    workers: 1,
    timeoutMs: 120_000,
    scripts,
    env: { baseUrl: "http://127.0.0.1:1", headless: true, ...env },
    ...extra,
});

const waitFor = async (what: string, cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
};

describe("the real agent program applies what the task carries", () => {
    let fake: FakePlatform;
    let agent: Agent;
    let done: Promise<number>;

    beforeAll(async () => {
        fake = new FakePlatform(5952, { token: TOKEN });
        await fake.start();
        const avdHome = path.join(tmp, "avd");
        fs.mkdirSync(avdHome, { recursive: true });
        fs.writeFileSync(path.join(avdHome, "Pixel_Test.ini"), "target=android-34\n");
        const probe = new CapabilityProbe({
            env: { ANDROID_AVD_HOME: avdHome, TAQWRIGHT_HOME: path.join(tmp, "no-taqwright") },
            exec: async (_file, args) => (args[0] === "version" ? "Android Debug Bridge" : args[0] === "devices" ? "List of devices attached\n" : undefined),
        });
        const { log } = memoryLogger();
        const config: AgentConfig = { baseUrl: fake.url, token: TOKEN, name: "Settings agent", concurrency: 1, workDir, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env" };
        agent = new Agent({ config, log, env: { ...process.env, MOBILE_RUNNER_CLI: FAKE_CLI, ANDROID_AVD_HOME: avdHome, AITP_AGENT_TOKEN: TOKEN }, probe, heartbeatMs: 300, backoff: { baseMs: 50, maxMs: 200 } });
        done = agent.run();
        await waitFor("the agent to say hello", () => fake.hellos.length > 0);
    }, 60_000);
    afterAll(async () => {
        agent?.stop();
        await done;
        await fake?.stop();
    });

    it("a task without the new fields runs with the usual 60 s limit and no visible window", async () => {
        const t = offer("playwright", [probeScript("PRB-001")]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(factsOf(r.runs[0]!.error)).toEqual(["60000", "1", "true"]);
    }, 120_000);

    it("a task with testTimeoutMs and a visible window is run with that limit and PW_HEADLESS=false", async () => {
        const t = offer("playwright", [probeScript("PRB-002")], { testTimeoutMs: 45_000, workers: 1 }, { headless: false });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(factsOf(r.runs[0]!.error)).toEqual(["45000", "1", "false"]);
    }, 120_000);

    it("an older agent's view of the same task is unchanged: the fields it does not know are simply ignored by the schema", async () => {
        const { TaskOffer: Schema } = await import("../src/agent-protocol/schema.js");
        const t = offer("playwright", [probeScript("PRB-003")], { testTimeoutMs: 45_000, startTimeoutMs: 30_000 });
        // an agent built before these fields existed parses with a schema that does not list them (zod objects drop unknown keys)
        const old = Schema.omit({ testTimeoutMs: true, startTimeoutMs: true }).parse(t);
        expect(old).not.toHaveProperty("testTimeoutMs");
        expect(old.scripts).toEqual(t.scripts);
        expect(old.workers).toBe(t.workers);
    });

    it("a device task's limit reaches the Taqwright runner, and without one it keeps the usual 180 s", async () => {
        const mobile = (id: string) => ({ testId: id, filename: `${id}.mobile.spec.ts`, content: renderScript(TestSpecSchema.parse({ testId: id, title: "Network settings are listed", kind: "mobile", category: "Agent", steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Network" } }] }), "taqwright", { baseUrl: "android-app://com.android.settings" }).content });
        const usual = offer("taqwright", [mobile("MOB-001")], { mobile: { appPackage: "com.android.settings", avd: "Pixel_Test" }, timeoutMs: undefined });
        fake.enqueue({ offer: usual });
        expect((await fake.result(usual.taskId, 60_000)).ok).toBe(true);
        expect(JSON.parse(fs.readFileSync(OBSERVED, "utf8")).env.MOBILE_TEST_TIMEOUT_MS).toBe("180000");
        const longer = offer("taqwright", [mobile("MOB-002")], { mobile: { appPackage: "com.android.settings", avd: "Pixel_Test" }, testTimeoutMs: 240_000, timeoutMs: undefined });
        fake.enqueue({ offer: longer });
        expect((await fake.result(longer.taskId, 60_000)).ok).toBe(true);
        expect(JSON.parse(fs.readFileSync(OBSERVED, "utf8")).env.MOBILE_TEST_TIMEOUT_MS).toBe("240000");
    }, 120_000);
});

describe("the platform's own runner, through the settings wrapper", () => {
    const run = async (patch: unknown, scripts: Array<{ testId: string; framework: string }>) => {
        const s = clampSettings(mergeSettings(defaultFrameworkSettings(), FrameworkSettingsInput.parse(patch))).settings;
        const e = effectiveSettings(s, { onAgent: false, platformWorkers: 3 });
        const executor = withFrameworkSettings(localExecutor, e, describeDeviations(s, e).length > 0);
        const scratch = path.join(REPO_ROOT, ".validation");
        fs.mkdirSync(scratch, { recursive: true });
        const runs = await executor.execute("playwright", { scratchDir: scratch, scripts: scripts.map((x) => ({ ...probeScript(x.testId), framework: x.framework })) }, { run: { baseUrl: "http://127.0.0.1:1", headless: true } }, { workers: 3 });
        return Object.fromEntries(runs.map((r) => [r.testId, factsOf(r.error)]));
    };

    it("with the default settings Playwright is configured exactly as always: 60 s, the platform's workers", async () => {
        expect(await run({}, [{ testId: "WEB-001", framework: "playwright" }])).toEqual({ "WEB-001": ["60000", "3", "true"] });
    }, 120_000);

    it("the project's limit and worker cap land in the generated Playwright configuration", async () => {
        expect(await run({ web: { testTimeoutSeconds: 120, workers: 1 } }, [{ testId: "WEB-001", framework: "playwright" }])).toEqual({ "WEB-001": ["120000", "1", "true"] });
    }, 120_000);

    it("web and API scripts of one batch each run with their own limit", async () => {
        const facts = await run({ api: { testTimeoutSeconds: 90 } }, [
            { testId: "WEB-001", framework: "playwright" },
            { testId: "API-001", framework: "playwright-api" },
        ]);
        expect(facts["WEB-001"]![0]).toBe("60000");
        expect(facts["API-001"]![0]).toBe("90000");
    }, 180_000);
});
