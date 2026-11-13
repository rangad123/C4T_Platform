/**
 * "Show the browser while exploring" (Settings, Your runner): the runner's decision, the hidden fallback of a visible launch that cannot show
 * a window (engine/discovery/browser.ts), the offer rule (web explorations and web Describe it only, only when on), and explore-child: the
 * exploring browser shown while the test runs inside the exploration stay hidden. No real browser opens: Playwright's launch, the engine
 * entries and the local executor are stand-ins.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ exploring: [] as boolean[], runs: [] as boolean[], launchedInEngine: false }));
const engine = async (ctx: { config: { HEADLESS: boolean }; executor: { execute(a: string, b: unknown, e: unknown, o: unknown): Promise<unknown> } }) => {
    seen.exploring.push(ctx.config.HEADLESS);
    if (seen.launchedInEngine) {
        const { launchChromium } = await import("../src/engine/discovery/browser.js");
        await launchChromium(ctx.config.HEADLESS);
    }
    // The engine hands its test runs the same HEADLESS it explores with (orchestrator.ts, validate-only.ts).
    await ctx.executor.execute("playwright", { scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "//" }] }, { run: { baseUrl: "https://shop.example/", headless: ctx.config.HEADLESS } }, { workers: 1 });
    return { model: null, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, errors: [] };
};
vi.mock("../src/engine/orchestrator.js", async (orig) => ({ ...(await orig<object>()), runGeneration: engine }));
vi.mock("../src/engine/authoring/plain.js", async (orig) => ({ ...(await orig<object>()), runPlainAuthoring: engine }));
vi.mock("../src/engine/frameworks/index.js", async (orig) => ({
    ...(await orig<object>()),
    localExecutor: {
        name: "local",
        execute: async (_a: string, _b: unknown, e: { run: { headless: boolean } }) => {
            seen.runs.push(e.run.headless);
            return [];
        },
    },
}));

const { runExplore } = await import("../src/agent/explore-child.js");
const { BROWSER_HIDDEN_NOTE, browserWindowFor, once } = await import("../src/agent/show-browser.js");
const { fallBackToHidden, launchChromium } = await import("../src/engine/discovery/browser.js");
const { exploreOffer, showsBrowserWindow } = await import("../src/platform/explore-task.js");
import type { FromChild } from "../src/agent/child-protocol.js";

const NO_X = "browserType.launch: Target page, context or browser has been closed\nLooks like you launched a headed browser without having a XServer running.";
const fakeBrowser = { close: async () => undefined } as unknown as Awaited<ReturnType<typeof chromium.launch>>;
afterEach(() => {
    vi.restoreAllMocks();
    fallBackToHidden(undefined);
});

describe("the runner decides once, without opening anything", () => {
    it("hidden while the switch is off; shown where a screen can be; hidden with the sentence on Linux without one", () => {
        expect(browserWindowFor(false, { platform: "linux", env: { DISPLAY: ":0" } })).toEqual({ headless: true });
        expect(browserWindowFor(true, { platform: "linux", env: { DISPLAY: ":0" } })).toEqual({ headless: false });
        expect(browserWindowFor(true, { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toEqual({ headless: false });
        expect(browserWindowFor(true, { platform: "win32", env: {} })).toEqual({ headless: false });
        expect(browserWindowFor(true, { platform: "darwin", env: {} })).toEqual({ headless: false });
        expect(browserWindowFor(true, { platform: "linux", env: {} })).toEqual({ headless: true, note: BROWSER_HIDDEN_NOTE });
        expect(BROWSER_HIDDEN_NOTE).toBe("The browser window could not be shown on this computer, so it runs hidden.");
        const say = vi.fn();
        const sayOnce = once(say);
        sayOnce();
        sayOnce();
        expect(say).toHaveBeenCalledTimes(1);
    });
});

describe("a visible launch that cannot show a window opens hidden instead", () => {
    it("launches visible directly; on a display error relaunches hidden, says so, and later launches go hidden at once", async () => {
        const launch = vi.spyOn(chromium, "launch").mockImplementation(async (o) => {
            if (o?.headless === false) throw new Error(NO_X);
            return fakeBrowser;
        });
        const said = vi.fn();
        fallBackToHidden(said);
        expect(await launchChromium(false)).toBe(fakeBrowser);
        expect(launch.mock.calls.map((c) => c[0]?.headless)).toEqual([false, true]);
        expect(said).toHaveBeenCalledTimes(1);
        await launchChromium(false);
        expect(launch.mock.calls.map((c) => c[0]?.headless)).toEqual([false, true, true]);
        expect(said).toHaveBeenCalledTimes(1);
    });
    it("a visible launch that works is the only launch; any other failure, or no fallback set, fails as before", async () => {
        const ok = vi.spyOn(chromium, "launch").mockResolvedValue(fakeBrowser);
        fallBackToHidden(vi.fn());
        await launchChromium(false);
        expect(ok.mock.calls.map((c) => c[0]?.headless)).toEqual([false]);
        ok.mockRejectedValue(new Error("Executable doesn't exist at /ms-playwright/chromium"));
        await expect(launchChromium(false)).rejects.toThrow("Executable doesn't exist");
        fallBackToHidden(undefined);
        ok.mockRejectedValue(new Error(NO_X));
        await expect(launchChromium(false)).rejects.toThrow("XServer");
    });
});

describe("the offer carries it only for work that drives a web browser, and only when on", () => {
    const offer = (mode: "generate" | "plain" | "agent" | "mobile" | "assessment", request: Record<string, unknown>, showBrowser?: boolean) =>
        exploreOffer({ taskId: "t1", job: { id: "j1" }, mode, request: { url: "https://shop.example/", ...request } as never, modelName: "m", secrets: [], leaseSeconds: 60, ...(showBrowser === undefined ? {} : { showBrowser }) });

    it("web exploration and web Describe it: yes; API Describe it, agent runs, phone and assessments: never", () => {
        expect(offer("generate", { targets: ["web"] }, true).explore?.showBrowser).toBe(true);
        expect(offer("plain", { kind: "web" }, true).explore?.showBrowser).toBe(true);
        for (const [mode, req] of [["plain", { kind: "api" }], ["agent", {}], ["mobile", {}], ["assessment", {}]] as const) expect(offer(mode, req, true).explore, mode).not.toHaveProperty("showBrowser");
        expect(showsBrowserWindow("generate", {})).toBe(true);
        expect(showsBrowserWindow("plain", { kind: "api" })).toBe(false);
    });
    it("off or not given: absent, and the offer's own browser setting stays hidden either way", () => {
        expect(offer("generate", {}, false).explore).not.toHaveProperty("showBrowser");
        expect(offer("generate", {}).explore).not.toHaveProperty("showBrowser");
        expect(offer("generate", {}, true).env.headless).toBe(true);
    });
    it("only the exploration dispatch reads the switch: a run's offer never does", () => {
        const src = path.resolve(__dirname, "../src");
        const readers: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f);
                else if (f.endsWith(".ts") && /token\??\.showBrowser/.test(fs.readFileSync(f, "utf8"))) readers.push(path.relative(src, f).replaceAll("\\", "/"));
            }
        };
        walk(src);
        expect(readers.sort()).toEqual(["platform/explore-dispatch.ts"]);
    });
});

describe("explore-child: one window, the exploring browser's; its test runs stay hidden", () => {
    const dirs: string[] = [];
    afterAll(() => {
        for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    });
    const go = async (explore: Record<string, unknown>, env: NodeJS.ProcessEnv = { DISPLAY: ":0" }) => {
        const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-show-browser-"));
        dirs.push(scratchDir);
        const sent: FromChild[] = [];
        seen.exploring.length = 0;
        seen.runs.length = 0;
        await runExplore(
            { type: "explore", scratchDir, explore: { request: { url: "https://shop.example/" }, modelName: "m", secrets: [], ...explore } as never },
            { send: async (m) => void sent.push(m), post: async () => ({ ok: true, value: undefined }) as never, signal: new AbortController().signal, env },
        );
        expect(sent.at(-1), JSON.stringify(sent.at(-1))).toMatchObject({ type: "explored" });
        return { exploring: [...seen.exploring], runs: [...seen.runs], hiddenNotes: sent.filter((m) => m.type === "engine" && (m as { event: { kind: string } }).event.kind === "browser_hidden").length };
    };

    it("switch off: everything hidden, as before", async () => {
        expect(await go({})).toEqual({ exploring: [true], runs: [true], hiddenNotes: 0 });
    });
    it("switch on: the exploring browser is shown and the executor still gets headless (an exploration, Describe it, and a project set to a visible browser)", async () => {
        expect(await go({ showBrowser: true })).toEqual({ exploring: [false], runs: [true], hiddenNotes: 0 });
        expect(await go({ showBrowser: true, mode: "plain", request: { url: "https://shop.example/", kind: "web" } })).toEqual({ exploring: [false], runs: [true], hiddenNotes: 0 });
        expect(await go({ showBrowser: true, frameworkSettings: { web: { headless: false } } })).toEqual({ exploring: [false], runs: [true], hiddenNotes: 0 });
    });
    it("Linux without a screen: hidden at once, said once", async () => {
        if (process.platform !== "linux") return;
        expect(await go({ showBrowser: true }, {})).toEqual({ exploring: [true], runs: [true], hiddenNotes: 1 });
    });
    it("a visible launch that fails for want of a window: the exploration carries on hidden and says so once", async () => {
        const launch = vi.spyOn(chromium, "launch").mockImplementation(async (o) => {
            if (o?.headless === false) throw new Error(NO_X);
            return fakeBrowser;
        });
        seen.launchedInEngine = true;
        try {
            expect((await go({ showBrowser: true })).hiddenNotes).toBe(1);
            expect(launch.mock.calls.map((c) => c[0]?.headless)).toEqual([false, true]);
        } finally {
            seen.launchedInEngine = false;
        }
    });
});
