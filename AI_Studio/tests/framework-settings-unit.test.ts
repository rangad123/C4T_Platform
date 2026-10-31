/**
 * Per-project framework settings, the pure parts (fast tier, no browser, no server): the schema, defaults (golden: they equal what the
 * runners always did), clamping, merge, the effective values per place a run executes (headed only on an agent), the wrapper that
 * applies them to a run (identity with defaults), and the Windows time limits laid over a script.
 */
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { configFor } from "../src/engine/validation/runner.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import type { ExecutionBatch, ExecutionEnv, ExecutionOptions, ScriptExecutor, ScriptRun } from "../src/engine/frameworks/types.js";
import {
    clampSettings,
    DEFAULT_FRAMEWORK_SETTINGS,
    defaultFrameworkSettings,
    describeChange,
    describeDeviations,
    effectiveSettings,
    firstTurnedOff,
    FrameworkSettingsInput,
    inputProblem,
    mergeSettings,
    normalizeSettings,
    turnedOffMessage,
} from "../src/engine/frameworks/settings.js";
import { withFrameworkSettings } from "../src/engine/frameworks/settings-executor.js";
import { DESKTOP_STARTUP_DEFAULT_MS } from "../src/engine/desktop/target.js";
import { withDesktopTimings } from "../src/engine/desktop/timings.js";
import { WindowsAdapter } from "../src/engine/frameworks/windows.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";

const host = { onAgent: false, platformWorkers: 3 };
const agent = { onAgent: true, platformWorkers: 3 };
const eff = (patch: unknown, ctx = host) => {
    const s = clampSettings(mergeSettings(defaultFrameworkSettings(), FrameworkSettingsInput.parse(patch))).settings;
    return { s, e: effectiveSettings(s, ctx) };
};

describe("defaults are what the platform always did (golden)", () => {
    it("the web limit is the Playwright config's 60 s, the Android limit the Taqwright runner's 180 s", () => {
        const runner = fs.readFileSync("src/engine/validation/runner.ts", "utf8");
        expect(runner).toContain("timeout: 60_000,");
        expect(DEFAULT_FRAMEWORK_SETTINGS.web.testTimeoutSeconds).toBe(60);
        expect(DEFAULT_FRAMEWORK_SETTINGS.api.testTimeoutSeconds).toBe(60);
        const mobile = fs.readFileSync("src/engine/validation/mobile-runner.ts", "utf8");
        expect(mobile).toContain("process.env.MOBILE_TEST_TIMEOUT_MS ?? 180000");
        expect(DEFAULT_FRAMEWORK_SETTINGS.android.testTimeoutSeconds).toBe(180);
    });

    it("the Windows defaults are the generator's: 15 s to start, a 120 s test limit", () => {
        expect(DEFAULT_FRAMEWORK_SETTINGS.windows.startTimeoutSeconds * 1000).toBe(DESKTOP_STARTUP_DEFAULT_MS);
        const spec: TestSpec = TestSpecSchema.parse({ testId: "DSK-001", title: "Counter test", kind: "desktop", desktop: { app: "C:\\Windows\\System32\\calc.exe" }, steps: [{ action: "launchApp" }] });
        const script = renderWithAdapter(spec, "windows-uia", { baseUrl: "http://x.test" }).content;
        expect(script).toContain(`test.setTimeout(${DEFAULT_FRAMEWORK_SETTINGS.windows.testTimeoutSeconds * 1000});`);
    });

    it("everything is on, headless, with the platform's workers and no emulator choice", () => {
        const d = DEFAULT_FRAMEWORK_SETTINGS;
        expect(d.enabled).toEqual({ playwright: true, "playwright-api": true, taqwright: true, "windows-uia": true, "taqwright-ios": true });
        expect(d.web).toEqual({ headless: true, workers: null, testTimeoutSeconds: 60 });
        expect(d.android).toEqual({ keepEmulator: false, defaultAvd: "", testTimeoutSeconds: 180 });
        expect(Object.isFrozen(d)).toBe(true);
        // a fresh copy each time, so a caller can never change the defaults
        const a = defaultFrameworkSettings();
        a.web.testTimeoutSeconds = 99;
        expect(defaultFrameworkSettings().web.testTimeoutSeconds).toBe(60);
    });

    it("the generated Playwright config is byte-identical unless a limit other than 60 s is asked for", () => {
        const base = configFor([]);
        expect(configFor([], undefined)).toBe(base);
        expect(configFor([], 60_000)).toBe(base);
        const projects = [{ name: "firefox", device: "Desktop Firefox" }];
        expect(configFor(projects, 60_000)).toBe(configFor(projects));
        const changed = configFor([], 120_000);
        expect(changed).not.toBe(base);
        expect(changed.replace("timeout: 120000,", "timeout: 60_000,")).toBe(base);
        expect(configFor(projects, 90_000)).toContain("timeout: 90000,");
    });

    it("with default settings nothing is deviating and the executor is not wrapped", () => {
        const d = defaultFrameworkSettings();
        const e = effectiveSettings(d, host);
        expect(describeDeviations(d, e)).toEqual([]);
        const inner = spy().exec;
        expect(withFrameworkSettings(inner, e, describeDeviations(d, e).length > 0)).toBe(inner);
    });
});

describe("clamping and merge", () => {
    it("moves a time limit into 30-300 s and says so", () => {
        const { settings, adjusted } = clampSettings(mergeSettings(defaultFrameworkSettings(), FrameworkSettingsInput.parse({ web: { testTimeoutSeconds: 900 }, api: { testTimeoutSeconds: 3 } })));
        expect(settings.web.testTimeoutSeconds).toBe(300);
        expect(settings.api.testTimeoutSeconds).toBe(30);
        expect(adjusted).toEqual(["The web test time limit was set to 300 seconds, the most allowed.", "The API test time limit was set to 30 seconds, the least allowed."]);
    });

    it("bounds workers to 1-8, the start limit to 5-60, and rounds without complaining", () => {
        const c = (patch: unknown) => clampSettings(mergeSettings(defaultFrameworkSettings(), FrameworkSettingsInput.parse(patch)));
        expect(c({ web: { workers: 0 } }).settings.web.workers).toBe(1);
        expect(c({ web: { workers: 50 } }).settings.web.workers).toBe(8);
        expect(c({ web: { workers: null } }).settings.web.workers).toBeNull();
        expect(c({ windows: { startTimeoutSeconds: 600 } }).settings.windows.startTimeoutSeconds).toBe(60);
        expect(c({ windows: { startTimeoutSeconds: 1 } }).settings.windows.startTimeoutSeconds).toBe(5);
        const rounded = c({ web: { testTimeoutSeconds: 89.6 } });
        expect(rounded.settings.web.testTimeoutSeconds).toBe(90);
        expect(rounded.adjusted).toEqual([]);
    });

    it("merges field by field and leaves the rest alone", () => {
        const base = mergeSettings(defaultFrameworkSettings(), FrameworkSettingsInput.parse({ web: { testTimeoutSeconds: 120 }, enabled: { taqwright: false } }));
        const next = mergeSettings(base, FrameworkSettingsInput.parse({ web: { workers: 2 } }));
        expect(next.web).toEqual({ headless: true, workers: 2, testTimeoutSeconds: 120 });
        expect(next.enabled.taqwright).toBe(false);
        expect(next.enabled.playwright).toBe(true);
        expect(base.web.workers).toBeNull(); // the input is not changed
    });

    it("refuses wrong types and unknown settings with a plain sentence", () => {
        const bad = (v: unknown) => {
            const r = FrameworkSettingsInput.safeParse(v);
            return r.success ? undefined : inputProblem(r.error);
        };
        expect(bad({ web: { testTimeoutSeconds: "soon" } })).toBe("The web test time limit must be a number.");
        expect(bad({ enabled: { taqwright: "no" } })).toBe("Android tests must be on or off.");
        expect(bad({ web: { retries: 2 } })).toMatch(/Unknown setting: retries/);
        expect(bad({ retries: 2 })).toMatch(/Unknown setting: retries/);
    });

    it("reading a damaged stored value keeps the valid fields and defaults the rest", () => {
        const s = normalizeSettings({ web: { testTimeoutSeconds: "x", headless: true, workers: 2 }, api: { testTimeoutSeconds: 120 }, enabled: { taqwright: false, bogus: false } });
        expect(s.web.testTimeoutSeconds).toBe(60);
        expect(s.web.workers).toBe(2);
        expect(s.api.testTimeoutSeconds).toBe(120);
        expect(s.enabled.taqwright).toBe(false);
        expect(normalizeSettings(null)).toEqual(defaultFrameworkSettings());
        expect(normalizeSettings("junk")).toEqual(defaultFrameworkSettings());
    });
});

describe("what a run would use", () => {
    it("a headed browser is refused on the platform host and allowed on a runner agent", () => {
        const onHost = eff({ web: { headless: false } }, host);
        expect(onHost.s.web.headless).toBe(false); // what the project asked for is kept
        expect(onHost.e.web.headless).toBe(true); // what a run uses here is not headed
        expect(onHost.e.notes[0]).toMatch(/only open on a runner agent/);
        const onAgent = eff({ web: { headless: false } }, agent);
        expect(onAgent.e.web.headless).toBe(false);
        expect(onAgent.e.notes).toEqual([]);
        expect(describeDeviations(onAgent.s, onAgent.e)).toContain("a visible browser window");
        expect(describeDeviations(onHost.s, onHost.e)).toEqual([]);
    });

    it("workers can lower the platform's value but never raise it", () => {
        expect(eff({}).e.web.workers).toBe(3);
        expect(eff({ web: { workers: 1 } }).e.web).toMatchObject({ workers: 1, workersLimit: 1 });
        const above = eff({ web: { workers: 6 } });
        expect(above.e.web.workers).toBe(3);
        expect(above.e.notes[0]).toMatch(/allows 3 browser workers at most/);
    });

    it("says in plain words only what differs from the defaults", () => {
        const { s, e } = eff({ enabled: { "playwright-api": false }, web: { testTimeoutSeconds: 120 }, android: { keepEmulator: true }, windows: { startTimeoutSeconds: 30 } });
        expect(describeDeviations(s, e)).toEqual(["api tests turned off", "a 120 s test timeout for web tests", "the emulator kept running", "a 30 s start timeout for Windows applications"]);
    });

    it("names a switched-off framework the way the product does", () => {
        expect(turnedOffMessage("taqwright")).toBe("Android tests are turned off for this project. Turn them on under Runners, Frameworks.");
        const s = mergeSettings(defaultFrameworkSettings(), { enabled: { "playwright-api": false } });
        expect(firstTurnedOff(s, ["playwright", "playwright-api"])).toBe("API tests are turned off for this project. Turn them on under Runners, Frameworks.");
        expect(firstTurnedOff(s, ["playwright", "taqwright"])).toBeUndefined();
        expect(firstTurnedOff(s, ["some-plugin"])).toBeUndefined();
    });

    it("summarises a change for the log", () => {
        const a = defaultFrameworkSettings();
        const b = mergeSettings(a, { enabled: { taqwright: false }, web: { testTimeoutSeconds: 120 } });
        expect(describeChange(a, b)).toBe("Android tests turned off; Web time limit 60 s to 120 s");
        expect(describeChange(a, a)).toBe("Saved with no changes");
    });
});

// ── the wrapper ──────────────────────────────────────────────────────────────

const okRun = (testId: string): ScriptRun => ({ testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

function spy(remote = false) {
    const calls: Array<{ adapterId: string; ids: string[]; env: ExecutionEnv; opts: ExecutionOptions }> = [];
    const exec: ScriptExecutor = {
        name: "spy",
        remote,
        async execute(adapterId, batch, env, opts) {
            calls.push({ adapterId, ids: batch.scripts.map((s) => s.testId), env, opts });
            return batch.scripts.map((s) => okRun(s.testId));
        },
    };
    return { exec, calls };
}
const batchOf = (...scripts: Array<[string, string?]>): ExecutionBatch => ({ scratchDir: "x", scripts: scripts.map(([testId, framework]) => ({ testId, filename: `${testId}.spec.ts`, content: "", ...(framework ? { framework } : {}) })) });
const runEnv = (): ExecutionEnv => ({ run: { baseUrl: "http://x.test", headless: true } });

describe("the wrapper applies the settings to every run", () => {
    const wrap = (patch: unknown, remote = false) => {
        const { s, e } = eff(patch, remote ? agent : host);
        const sp = spy(remote);
        return { ...sp, wrapped: withFrameworkSettings(sp.exec, e, describeDeviations(s, e).length > 0) };
    };

    it("a web limit and a worker cap reach the runner; the API limit does not leak into web", async () => {
        const { wrapped, calls } = wrap({ web: { testTimeoutSeconds: 120, workers: 1 } });
        await wrapped.execute("playwright", batchOf(["WEB-001", "playwright"]), runEnv(), { workers: 3 });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.opts).toMatchObject({ workers: 1, testTimeoutMs: 120_000 });
        await wrapped.execute("playwright-api", batchOf(["API-001", "playwright-api"]), runEnv(), { workers: 3 });
        expect(calls[1]!.opts.testTimeoutMs).toBeUndefined();
        expect(calls[1]!.opts.workers).toBe(1);
    });

    it("a mixed web and API batch is split only when the two would be run differently, and results keep their order", async () => {
        const { wrapped, calls } = wrap({ api: { testTimeoutSeconds: 90 } });
        const out = await wrapped.execute("playwright", batchOf(["A-1", "playwright-api"], ["W-1", "playwright"], ["A-2", "playwright-api"]), runEnv(), { workers: 3 });
        expect(out.map((r) => r.testId)).toEqual(["A-1", "W-1", "A-2"]);
        expect(calls.map((c) => c.ids)).toEqual([["A-1", "A-2"], ["W-1"]]);
        expect(calls[0]!.opts.testTimeoutMs).toBe(90_000);
        expect(calls[1]!.opts.testTimeoutMs).toBeUndefined();
    });

    it("a mixed batch stays one call when nothing about web and API differs", async () => {
        const { wrapped, calls } = wrap({ enabled: { taqwright: false } });
        await wrapped.execute("playwright", batchOf(["A-1", "playwright-api"], ["W-1", "playwright"]), runEnv(), { workers: 3 });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.ids).toEqual(["A-1", "W-1"]);
        expect(calls[0]!.opts.testTimeoutMs).toBeUndefined();
    });

    it("headed reaches the run only when the scripts run on a runner agent", async () => {
        const onAgent = wrap({ web: { headless: false } }, true);
        await onAgent.wrapped.execute("playwright", batchOf(["W-1", "playwright"]), runEnv(), { workers: 3 });
        expect(onAgent.calls[0]!.env.run.headless).toBe(false);
        // the same settings with a local executor: the effective values already say headless, and the wrapper agrees
        const { s } = eff({ web: { headless: false } }, host);
        const sp = spy(false);
        const forced = withFrameworkSettings(sp.exec, { ...effectiveSettings(s, agent), web: { ...effectiveSettings(s, agent).web, headless: false } }, true);
        await forced.execute("playwright", batchOf(["W-1", "playwright"]), runEnv(), { workers: 3 });
        expect(sp.calls[0]!.env.run.headless).toBe(true); // a local executor never gets a visible window
    });

    it("a switched-off framework is not run: its scripts get a plain answer and nothing is sent", async () => {
        const { wrapped, calls } = wrap({ enabled: { "playwright-api": false } });
        const out = await wrapped.execute("playwright", batchOf(["A-1", "playwright-api"], ["W-1", "playwright"]), runEnv(), { workers: 3 });
        expect(out[0]).toMatchObject({ testId: "A-1", status: "error", error: "API tests are turned off for this project. Turn them on under Runners, Frameworks." });
        expect(out[1]!.status).toBe("passed");
        expect(calls.map((c) => c.ids)).toEqual([["W-1"]]);
        const mobile = await wrapped.execute("taqwright", batchOf(["M-1"]), { ...runEnv() }, { workers: 1 });
        expect(mobile[0]!.status).toBe("passed");
        const off = wrap({ enabled: { taqwright: false } });
        const refused = await off.wrapped.execute("taqwright", batchOf(["M-1"]), runEnv(), { workers: 1 });
        expect(refused[0]).toMatchObject({ status: "error", error: expect.stringContaining("Android tests are turned off") });
        expect(off.calls).toHaveLength(0);
    });

    it("the Android limit, kept emulator and default emulator reach a device run", async () => {
        const { wrapped, calls } = wrap({ android: { testTimeoutSeconds: 240, keepEmulator: true, defaultAvd: "Pixel_6" } });
        const env: ExecutionEnv = { run: { baseUrl: "http://x.test", headless: true }, mobile: { target: { appPackage: "com.x" }, avd: "Other" } };
        await wrapped.execute("taqwright", batchOf(["M-1"]), env, { workers: 1 });
        expect(calls[0]!.opts.testTimeoutMs).toBe(240_000);
        expect(calls[0]!.env.mobile).toMatchObject({ keepEmulator: true, avd: "Pixel_6" });
        // an emulator named by the project's own app settings wins
        const named: ExecutionEnv = { run: env.run, mobile: { target: { appPackage: "com.x", avd: "Mine" }, avd: "Mine" } };
        await wrapped.execute("taqwright", batchOf(["M-2"]), named, { workers: 1 });
        expect(calls[1]!.env.mobile!.avd).toBe("Mine");
    });

    it("the Windows limits travel as options and keep the executor's identity flags", async () => {
        const { wrapped, calls } = wrap({ windows: { testTimeoutSeconds: 200, startTimeoutSeconds: 40 } }, true);
        expect(wrapped.remote).toBe(true);
        expect(wrapped.name).toBe("spy");
        await wrapped.execute("windows-uia", batchOf(["D-1"]), runEnv(), { workers: 1 });
        expect(calls[0]!.opts).toMatchObject({ testTimeoutMs: 200_000, startTimeoutMs: 40_000 });
    });
});

describe("Windows time limits are laid over a script for one run", () => {
    const script = () => {
        const spec: TestSpec = TestSpecSchema.parse({ testId: "DSK-001", title: "Counter test", kind: "desktop", desktop: { app: "C:\\Windows\\System32\\calc.exe" }, steps: [{ action: "launchApp" }] });
        return renderWithAdapter(spec, "windows-uia", { baseUrl: "http://x.test" }).content;
    };

    it("changes nothing when nothing is asked", () => {
        expect(withDesktopTimings(script(), {})).toBe(script());
    });

    it("sets the test limit and the start limit, and a spec that names its own start keeps it", () => {
        const out = withDesktopTimings(script(), { testTimeoutMs: 200_000, startTimeoutMs: 40_000 });
        expect(out).toContain("test.setTimeout(200000);");
        expect(out).toMatch(/const DESKTOP_TARGET = \{.*"startTimeoutMs":40000.*\}; \/\/ aitp:target/);
        const spec: TestSpec = TestSpecSchema.parse({ testId: "DSK-002", title: "Counter test", kind: "desktop", desktop: { app: "C:\\Windows\\System32\\calc.exe", startTimeoutMs: 20000 }, steps: [{ action: "launchApp" }] });
        const own = withDesktopTimings(renderWithAdapter(spec, "windows-uia", { baseUrl: "http://x.test" }).content, { startTimeoutMs: 40_000 });
        expect(own).toContain('"startTimeoutMs":20000');
        expect(own).not.toContain('"startTimeoutMs":40000');
    });

    it("a longer start also lengthens the default test limit the way the generator does", () => {
        expect(withDesktopTimings(script(), { startTimeoutMs: 60_000 })).toContain("test.setTimeout(150000);");
        expect(withDesktopTimings(script(), { startTimeoutMs: 20_000 })).toContain("test.setTimeout(120000);");
    });
});

describe("the Windows adapter applies the project's limits to the script it runs", () => {
    const CALC = "C:\Windows\System32\calc.exe";
    const adapterWith = (seen: Array<{ content: string; opts: Record<string, unknown> }>) =>
        new WindowsAdapter({
            platform: "win32",
            probe: async () => ({ uiautomation: true, interactive: true, elevated: false }),
            hostAllow: () => [CALC],
            run: async (_dir, scripts, _env, opts) => {
                seen.push({ content: scripts[0]!.content, opts: { ...opts } });
                return scripts.map((s) => okRun(s.testId));
            },
        });
    const good = () => renderWithAdapter(TestSpecSchema.parse({ testId: "DSK-001", title: "Counter test", kind: "desktop", desktop: { app: CALC }, steps: [{ action: "launchApp" }] }), "windows-uia", { baseUrl: "x" }).content;
    const batch = () => ({ scratchDir: os.tmpdir(), scripts: [{ testId: "DSK-001", filename: "DSK-001.desktop.spec.ts", content: good() }] });
    const env = { run: { baseUrl: "x", headless: true } };

    it("changes the limits only when the project did", async () => {
        // The pre-flight resolves the program on the real disk, so this only runs where calc.exe exists (a Windows computer).
        if (!fs.existsSync(CALC)) return;
        const seen: Array<{ content: string; opts: Record<string, unknown> }> = [];
        const adapter = adapterWith(seen);
        await adapter.execute(batch(), env, { workers: 1 });
        await adapter.execute(batch(), env, { workers: 1, testTimeoutMs: 200_000, startTimeoutMs: 40_000 });
        expect(seen[0]!.content).toContain("test.setTimeout(120000);");
        expect(seen[0]!.opts.testTimeoutMs).toBeUndefined();
        expect(seen[1]!.content).toContain("test.setTimeout(200000);");
        expect(seen[1]!.content).toContain('"startTimeoutMs":40000');
        expect(seen[1]!.opts.testTimeoutMs).toBe(200_000);
    });
});
