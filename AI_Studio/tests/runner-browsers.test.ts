/**
 * The runner opens the browser it chose, for real: a web test through Playwright's own Chromium (the channel-less path, nothing in the
 * run's config changes), the same test through the computer's installed Microsoft Edge (`--browser msedge`: the page really sees Edge),
 * a run on other browsers where the Chromium variant uses Edge and the Firefox variant keeps Firefox, and a recording opened in Edge.
 * The results say which browser was used. The runner is the real agent program against the fake platform of tests/fixtures.
 *
 * Edge is found the way the runner finds it: by its install path (never by looking at running programs). When this computer has no Edge
 * (or no Firefox, or no Playwright Chromium) the parts that need it are skipped with the reason. No download can reach the internet:
 * PLAYWRIGHT_DOWNLOAD_HOST points at a closed local port.
 *
 * Browser-launching: node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-browsers.test.ts
 * Ports: fixture application 6932, fake platforms 6933 and 6934, no-download host 6939 (closed on purpose).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { detectBrowsers, expectedRevisions, playwrightBrowsersDir } from "../src/agent/capabilities.js";
import type { RecordFromChild } from "../src/agent/child-protocol.js";
import type { AgentConfig } from "../src/agent/config.js";
import { memoryLogger } from "../src/agent/log.js";
import { RecordProcess } from "../src/agent/record-process.js";
import type { TaskOffer } from "../src/agent-protocol/schema.js";
import { bundledChromium, bundledReady, candidatePaths } from "../src/engine/browsers/choice.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { FakePlatform } from "./fixtures/fake-platform.js";

const APP_PORT = 6932;
const APP = `http://127.0.0.1:${APP_PORT}`;
const TOKEN = "aitg_BrowserE2EToken0123456789abcdefghijkl";
const NO_DOWNLOADS = "http://127.0.0.1:6939";

const bundled = bundledChromium();
const hasBundled = Boolean(bundled && bundledReady(playwrightBrowsersDir(process.env), bundled.revision));
const edgePath = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux" ? candidatePaths("msedge", process.platform, process.env).find((p) => fs.existsSync(p)) : undefined;
const hasFirefox = detectBrowsers(playwrightBrowsersDir(process.env), expectedRevisions()).includes("firefox");
if (!hasBundled) console.warn("runner-browsers: Playwright's Chromium is not installed here; the channel-less run is skipped.");
if (!edgePath) console.warn("runner-browsers: Microsoft Edge is not installed on this computer (looked at its usual install paths); the Edge runs are skipped.");
if (!hasFirefox) console.warn("runner-browsers: Playwright's Firefox is not installed here; the Firefox variant is skipped.");

let tmp: string;
let app: http.Server;
const agents: string[] = [];

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-browsers-e2e-"));
    // The page says which browser asked for it, and the server writes it down too.
    app = http.createServer((req, res) => {
        const ua = String(req.headers["user-agent"] ?? "");
        // The brand list a Chromium browser sends (sec-ch-ua) names Edge even when a device profile replaces the user agent text.
        if (req.url === "/" || req.url?.startsWith("/?")) agents.push(`${ua} | ${String(req.headers["sec-ch-ua"] ?? "")}`);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><head><title>Who is asking</title></head><body><main><h1>Seen by ${ua.replace(/[<>&]/g, "")}</h1><button>Go</button></main></body></html>`);
    });
    await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", r));
}, 30_000);

afterAll(async () => {
    app?.closeAllConnections();
    await new Promise((r) => app?.close(r));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const webScript = (testId: string, text: string) => {
    const spec = TestSpecSchema.parse({ testId, title: `The page names the browser (${text})`, kind: "web", category: "Browsers", steps: [{ action: "navigate", url: `${APP}/` }, { action: "assert", check: "visible", locator: { by: "text", value: text } }] });
    const r = renderScript(spec, "playwright", { baseUrl: APP });
    return { testId, filename: r.filename, content: r.content };
};
let counter = 0;
const offer = (scripts: TaskOffer["scripts"], extra: Partial<TaskOffer> = {}): TaskOffer => ({ taskId: `task-br-${++counter}`, jobId: "job-br", adapterId: "playwright", leaseSeconds: 60, workers: 1, timeoutMs: 120_000, scripts, env: { baseUrl: APP, apiBaseUrl: APP, headless: true }, ...extra });

function startAgent(fake: FakePlatform, over: Partial<AgentConfig> = {}) {
    const { log, lines } = memoryLogger();
    const config: AgentConfig = { baseUrl: fake.url, token: TOKEN, name: "browser-laptop", concurrency: 1, workDir: path.join(tmp, `work-${++counter}`), allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env", ...over };
    const agent = new Agent({ config, log, env: { ...process.env, PLAYWRIGHT_DOWNLOAD_HOST: NO_DOWNLOADS }, heartbeatMs: 300, backoff: { baseMs: 50, maxMs: 200 } });
    const done = agent.run();
    return { agent, lines, done, stop: async () => (agent.stop(), done) };
}
const waitFor = async (what: string, cond: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
};

describe.skipIf(!hasBundled)("Playwright's own Chromium (the default when it is here)", () => {
    let fake: FakePlatform;
    let a: ReturnType<typeof startAgent>;
    beforeAll(async () => {
        fake = new FakePlatform(6933, { token: TOKEN });
        await fake.start();
        a = startAgent(fake);
        await waitFor("hello", () => fake.hellos.length > 0);
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("says so before it is ready, reports it, runs the test channel-less, and the result names it", async () => {
        expect(a.lines.join("\n")).toContain(`Ready for web tests in Chromium ${bundled!.major}, the browser that comes with the test tools.`);
        const caps = fake.hellos[0]!.capabilities;
        expect(caps.browsers).toContain("chromium");
        expect(caps.browser).toEqual({ name: "chromium", version: bundled!.version, source: "bundled" });
        agents.length = 0;
        const t = offer([webScript("BR-001", "Seen by")]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs.map((x) => x.status)).toEqual(["passed"]);
        expect(r.browser).toEqual({ name: "chromium", version: bundled!.version, source: "bundled" });
        expect(agents.length).toBeGreaterThan(0);
        expect(agents.every((ua) => !ua.includes("Edg/"))).toBe(true);
    }, 120_000);
});

describe.skipIf(!edgePath)("the computer's Microsoft Edge (--browser msedge)", () => {
    let fake: FakePlatform;
    let a: ReturnType<typeof startAgent>;
    beforeAll(async () => {
        fake = new FakePlatform(6934, { token: TOKEN });
        await fake.start();
        a = startAgent(fake, { browser: "msedge" });
        await waitFor("hello", () => fake.hellos.length > 0);
    }, 60_000);
    afterAll(async () => {
        await a?.stop();
        await fake?.stop();
    });

    it("is found by its install path, reported with its version, and the test really runs in it", async () => {
        const caps = fake.hellos[0]!.capabilities;
        expect(caps.browser).toMatchObject({ name: "msedge", source: "installed" });
        expect(caps.browser!.version).toMatch(/^\d{2,4}\.\d+\.\d+\.\d+$/);
        expect(caps.installedBrowsers?.find((b) => b.name === "msedge")).toMatchObject({ usable: true, version: caps.browser!.version });
        // No path of this computer goes to the platform.
        expect(JSON.stringify(fake.hellos[0])).not.toContain("Application");
        expect(a.lines.join("\n")).toContain(`Ready for web tests in Microsoft Edge ${caps.browser!.version!.split(".")[0]}, installed on this computer.`);

        agents.length = 0;
        const t = offer([webScript("EDG-001", "Edg/")]);
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs.map((x) => [x.testId, x.status, x.error ?? ""])).toEqual([["EDG-001", "passed", ""]]);
        expect(r.browser).toEqual({ name: "msedge", version: caps.browser!.version, source: "installed" });
        expect(agents.some((ua) => ua.includes("Edg/"))).toBe(true);
    }, 120_000);

    it.skipIf(!hasFirefox)("a run on other browsers: the Chromium variant uses Edge, the Firefox variant keeps Firefox", async () => {
        agents.length = 0;
        const t = offer([webScript("VAR-001", "Seen by")], { projects: [{ name: "chromium-desktop", device: "Desktop Chrome", viewport: { width: 1280, height: 800 } }, { name: "firefox", device: "Desktop Firefox", viewport: { width: 1280, height: 800 } }] });
        fake.enqueue({ offer: t });
        const r = await fake.result(t.taskId, 180_000);
        expect(r.ok, r.error).toBe(true);
        expect(r.runs.map((x) => [x.variant, x.status]).sort()).toEqual([["chromium-desktop", "passed"], ["firefox", "passed"]]);
        expect(agents.some((ua) => ua.includes("Microsoft Edge")), agents.join("\n")).toBe(true);
        expect(agents.some((ua) => ua.includes("Firefox/") && !ua.includes("Edge"))).toBe(true);
    }, 200_000);

    it("a recording opens in Edge too", async () => {
        agents.length = 0;
        const states: string[] = [];
        let ended = false;
        const proc = new RecordProcess(process.env, (m: RecordFromChild) => {
            if (m.type === "state") {
                states.push(m.state.status);
                if (m.ended) ended = true;
            }
        });
        try {
            proc.send({ type: "record", startUrl: `${APP}/`, headed: false, idleMs: 60_000, totalMs: 120_000, maxSteps: 20, browser: { channel: "msedge", executablePath: edgePath! } });
            await waitFor("the recording to start", () => states.includes("recording") || states.includes("failed"), 60_000);
            expect(states).not.toContain("failed");
            await waitFor("the page to be asked for", () => agents.length > 0, 20_000);
            expect(agents.every((ua) => ua.includes("Edg/"))).toBe(true);
            proc.send({ type: "stop" });
            await waitFor("the recording to end", () => ended, 30_000);
            await proc.exit;
        } finally {
            if (!proc.hasExited) proc.kill(); // only the process this test started
        }
    }, 120_000);
});
