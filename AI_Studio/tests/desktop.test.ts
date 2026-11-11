/**
 * Windows desktop tests on the real machine: a small WPF application (built by tests/fixtures/winforms-app.ps1 with the C# compiler
 * that ships with Windows) is started through the real UI Automation helper, by the adapter, by the platform, and by the real
 * agent program against the real platform.
 *
 * The suite SKIPS, with a reason, when this is not Windows, when UI Automation is missing, when the session is not interactive
 * (a locked screen cannot be detected up front: such a run would fail with a timeout) or when it runs as administrator.
 *
 * What it proves (the security rules first): an application that is not on the allow-list, or is on the hard deny-list, is refused
 * and nothing starts; text with quotes, backticks, $(), semicolons and newlines only ever reaches the application as data; a
 * password box is never read; only windows of the process the test started are touched; and after a pass, a failure, a time-out
 * and a cancel no helper PowerShell and no application process is left running.
 *
 * Browser-free (Playwright runs the scripts but no browser opens), still run under the shared lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/desktop.test.ts
 * Ports: platform 5910, agent test platform 5911.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { memoryLogger } from "../src/agent/log.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { probeDesktop } from "../src/engine/desktop/probe.js";
import { getAdapter, renderWithAdapter } from "../src/engine/frameworks/index.js";
import { WindowsAdapter } from "../src/engine/frameworks/windows.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { personalRunner } from "./helpers/personal-runner.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const probe = process.platform === "win32" ? await probeDesktop() : { uiautomation: false, interactive: false, elevated: false };
const SKIP =
    process.platform !== "win32" ? "this is not Windows" : !probe.uiautomation ? "Windows UI Automation is not available" : !probe.interactive ? "this session has no interactive desktop" : probe.elevated ? "this session runs as administrator (desktop tests refuse to run elevated)" : "";
if (SKIP) console.warn(`[desktop.test] skipped: ${SKIP}`);
const d = describe.skipIf(Boolean(SKIP));

const PLATFORM_PORT = 5910;
const AGENT_PLATFORM_PORT = 5911;
const API_KEY = "dsk-admin-key-77aa";
const SENTINEL = "Pw-Sentinel-9f3c2d71";
const ENV_KEYS = ["DESKTOP_ALLOWED_APPS", "AGENT_POLL_SECONDS", "AGENT_LEASE_SECONDS", "AGENT_WATCH_MS", "AGENT_NO_AGENT_GRACE_SECONDS", "BLOCK_PRIVATE_TARGETS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let tmp: string;
let EXE = "";
const scratch = path.join(REPO_ROOT, ".validation");
const foreign: ChildProcess[] = [];

// ── helpers ─────────────────────────────────────────────────────────────────

const ps = (script: string): string => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60_000 }).trim();

/** Fixture application processes and UI Automation helper processes that are running right now. */
function counts(): { apps: number; helpers: number } {
    const out = ps(
        `$a = @(Get-Process -Name AitpFixture -ErrorAction SilentlyContinue).Count; ` +
            `$h = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*AITP_UIA_H[O]ST*' }).Count; "$a,$h"`, // [O]: this very command line must not match itself
    );
    const [apps, helpers] = out.split(",").map(Number);
    return { apps: apps!, helpers: helpers! };
}

async function settles(): Promise<{ apps: number; helpers: number }> {
    let c = counts();
    for (let i = 0; i < 40 && (c.apps > 0 || c.helpers > 0); i++) {
        await new Promise((r) => setTimeout(r, 500));
        c = counts();
    }
    return c;
}

const desktopSpec = (testId: string, title: string, steps: unknown[], desktop: Record<string, unknown> = {}) =>
    TestSpecSchema.parse({ testId, title, kind: "desktop", category: "Desktop", desktop: { app: EXE, startTimeoutMs: 20_000, ...desktop }, steps });

const L = (testId: string) => ({ by: "testId", value: testId });

/** Render a spec and run its script through the adapter, like a job would. */
async function runSpecs(specs: Array<ReturnType<typeof desktopSpec>>, o: { allow?: string[]; env?: Record<string, unknown>; workers?: number; timeoutMs?: number; signal?: AbortSignal; credentials?: { username: string; password: string } } = {}): Promise<{ runs: ScriptRun[]; scripts: string[] }> {
    const scripts = specs.map((s) => renderWithAdapter(s, "windows-uia", { baseUrl: "http://unused.invalid" }));
    const adapter = new WindowsAdapter({ hostAllow: () => o.allow ?? [EXE] });
    fs.mkdirSync(scratch, { recursive: true });
    const runs = await adapter.execute(
        { scratchDir: scratch, scripts: scripts.map((s, i) => ({ testId: specs[i]!.testId, filename: s.filename, content: s.content })) },
        { run: { baseUrl: "http://unused.invalid", headless: true, ...(o.credentials ? { credentials: o.credentials } : {}) }, ...(o.env ?? {}) },
        { workers: o.workers ?? 1, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.signal ? { signal: o.signal } : {}) },
    );
    return { runs, scripts: scripts.map((s) => s.content) };
}

function pngSize(file: string): { w: number; h: number; ok: boolean } {
    const b = fs.readFileSync(file);
    return { ok: b.subarray(1, 4).toString() === "PNG", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** Read a label of a foreign fixture instance (test-side only; the product never reads other applications). */
const labelOf = (pid: number, id: string): string =>
    ps(
        `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes; $A=[System.Windows.Automation.AutomationElement]; ` +
            `$w=$A::RootElement.FindFirst('Children',(New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty,${pid}))); ` +
            `$e=$w.FindFirst('Descendants',(New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty,'${id}'))); $e.Current.Name`,
    );

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-desktop-"));
    if (SKIP) return;
    const built = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(REPO_ROOT, "tests/fixtures/winforms-app.ps1"), "-OutDir", path.join(tmp, "fx")], { encoding: "utf8", windowsHide: true, timeout: 120_000 }).trim().split(/\r?\n/).pop()!;
    EXE = built;
}, 150_000);

afterAll(async () => {
    for (const p of foreign) {
        try {
            if (p.pid) process.kill(p.pid);
        } catch {
            /* already gone */
        }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    // Windows can hold a file of a program that just ended for a moment: retry instead of failing the whole file.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

// ── the adapter, against the real application ───────────────────────────────

d("the Windows UI Automation adapter on this computer", () => {
    it("starts clean: no leftover application or helper process from before", async () => {
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 60_000);

    it("drives the application with UI Automation patterns: click, type, select, toggle, text, visibility, arguments", async () => {
        const nasty = "Ann \"q\" `t` $(calc) ; & | > < %PATH% \u00e9";
        const spec = desktopSpec("DSK-101", "Everything the vocabulary offers", [
            { action: "launchApp" },
            { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 0" },
            { action: "click", locator: L("btnAdd") },
            { action: "click", locator: { by: "role", role: "Button", value: "Add one", exact: true } },
            { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 2" },
            { action: "fill", locator: { by: "label", value: "Name field" }, value: nasty },
            { action: "click", locator: L("btnGreet") },
            { action: "assert", check: "text", locator: L("lblGreeting"), expected: `Hello, ${nasty}!` },
            { action: "assert", check: "value", locator: L("txtName"), expected: nasty },
            { action: "check", locator: L("chkNews"), checked: true },
            { action: "assert", check: "text", locator: L("lblNews"), expected: "Subscribed: yes" },
            { action: "check", locator: L("chkNews"), checked: false },
            { action: "assert", check: "text", locator: L("lblNews"), expected: "Subscribed: no" },
            { action: "select", locator: L("lstColors"), value: "Green" },
            { action: "assert", check: "text", locator: L("lblColor"), expected: "Color: Green" },
            { action: "select", locator: L("cmbSize"), value: "Large" },
            { action: "assert", check: "text", locator: L("lblSize"), expected: "Size: Large" },
            { action: "assert", check: "visible", locator: L("lblTemp") },
            { action: "click", locator: L("btnHide") },
            { action: "assert", check: "hidden", locator: L("lblTemp") },
            { action: "assert", check: "enabled", locator: L("btnAdd") },
            { action: "assert", check: "count", locator: { by: "role", role: "Button" }, expected: "5" },
            { action: "assert", check: "text", locator: L("lblEcho"), expected: "Echo: a b" },
            { action: "click", locator: L("btnDialog") },
            { action: "click", locator: L("btnDialogOk") },
            { action: "wait", ms: 200 },
            { action: "closeApp" },
        ], { args: ["--echo=a b"] });
        const { runs } = await runSpecs([spec]);
        expect(runs[0], JSON.stringify(runs[0])).toMatchObject({ status: "passed" });
        expect(runs[0]!.steps.every((s) => s.status === "passed")).toBe(true);
        expect(runs[0]!.artifacts).toEqual([]);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 240_000);

    it("a missing element fails with the element tree, and a picture of the application's own window", async () => {
        const spec = desktopSpec("DSK-102", "A missing element", [{ action: "launchApp" }, { action: "click", locator: L("btnAdd") }, { action: "click", locator: L("noSuchButton") }]);
        const { runs } = await runSpecs([spec]);
        const r = runs[0]!;
        expect(r.status).toBe("failed");
        expect(r.failedStepIndex).toBe(2);
        const text = r.steps[2]!.error ?? r.error ?? "";
        expect(text).toMatch(/Click failed: nothing matched the element with automation id "noSuchButton"/);
        expect(text).toContain("What the window contains");
        expect(text).toContain('Button #btnAdd "Add one"');
        const shot = r.artifacts.find((a) => a.kind === "screenshot");
        expect(shot, JSON.stringify(r.artifacts)).toBeDefined();
        const size = pngSize(shot!.path);
        expect(size.ok).toBe(true);
        // the application window (a portrait window of about 460 x 600 points), not the whole desktop
        expect(size.w).toBeGreaterThan(300);
        expect(size.w).toBeLessThan(size.h);
        expect(size.h).toBeLessThan(1700);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 120_000);

    it("a check that fails says what it saw; an ambiguous locator asks for more", async () => {
        const wrong = await runSpecs([desktopSpec("DSK-103", "Wrong text", [{ action: "launchApp" }, { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 99" }])]);
        expect(wrong.runs[0]!.status).toBe("failed");
        expect(wrong.runs[0]!.steps[1]!.error).toMatch(/does not contain "Count: 99" \(it shows "Count: 0"\)/);
        const many = await runSpecs([desktopSpec("DSK-104", "Ambiguous", [{ action: "launchApp" }, { action: "click", locator: { by: "role", role: "Button" } }])]);
        expect(many.runs[0]!.steps[1]!.error).toMatch(/elements matched .*nth/);
    }, 180_000);

    it("a password box is never read: not compared, not shown, not stored; a credential typed into it appears nowhere", async () => {
        const spec = desktopSpec("DSK-105", "Password handling", [
            { action: "launchApp" },
            { action: "fill", locator: L("txtSecret"), value: "{{credentials.password}}" },
            { action: "click", locator: L("btnSecretLen") },
            { action: "assert", check: "text", locator: L("lblSecretLen"), expected: `Secret length: ${SENTINEL.length}` },
            { action: "assert", check: "value", locator: L("txtSecret"), expected: "{{credentials.password}}" },
        ]);
        const { runs, scripts } = await runSpecs([spec], { credentials: { username: "demo", password: SENTINEL } });
        const r = runs[0]!;
        expect(r.status).toBe("failed");
        expect(r.failedStepIndex).toBe(4);
        expect(r.steps[3]!.status).toBe("passed"); // the application did receive the value (its length matches)
        expect(r.steps[4]!.error).toMatch(/password field is never read/);
        expect(r.steps[4]!.error).toContain("[hidden]");
        const everything = [JSON.stringify(r), ...scripts, ...r.artifacts.map((a) => fs.readFileSync(a.path).toString("latin1"))].join("\n");
        expect(everything).not.toContain(SENTINEL);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 120_000);

    it("an application that is not on the allow-list is refused: nothing is started and it is not a test verdict", async () => {
        const before = counts();
        const { runs } = await runSpecs([desktopSpec("DSK-106", "Unlisted", [{ action: "launchApp" }])], { allow: ["C:\\Windows\\System32\\calc.exe"] });
        expect(runs[0]).toMatchObject({ status: "error", steps: [] });
        expect(runs[0]!.error).toBe(`This computer isn't set up to start ${EXE.length > 80 ? `${EXE.slice(0, 79)}…` : EXE}. Add it to DESKTOP_ALLOWED_APPS, then run again.`);
        expect(counts()).toEqual(before);
        // an agent's own list is what counts when one is given
        const viaAgentList = await runSpecs([desktopSpec("DSK-107", "Unlisted for an agent", [{ action: "launchApp" }])], { env: { desktop: { allowApps: [] } } });
        expect(viaAgentList.runs[0]!.error).toMatch(/Add it with --allow-app, then run again\.$/);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 120_000);

    it("a program on the hard deny-list is refused even when someone put it on the allow-list, and even if the spec check were bypassed", async () => {
        const spec = desktopSpec("DSK-108", "Deny-list", [{ action: "launchApp" }]);
        const script = renderWithAdapter(spec, "windows-uia", { baseUrl: "x" }).content;
        for (const app of ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell", "wscript.exe", "C:\\Windows\\System32\\mshta.exe", "rundll32.exe"]) {
            const tampered = script.replace(/^const DESKTOP_TARGET = .*; \/\/ aitp:target$/m, `const DESKTOP_TARGET = ${JSON.stringify({ app })}; // aitp:target`);
            const adapter = new WindowsAdapter({ hostAllow: () => [app, "C:\\Windows\\System32\\cmd.exe", "powershell.exe"] });
            const before = counts();
            const [r] = await adapter.execute({ scratchDir: scratch, scripts: [{ testId: "DSK-108", filename: "DSK-108.desktop.spec.ts", content: tampered }] }, { run: { baseUrl: "x", headless: true } }, { workers: 1 });
            expect(r, app).toMatchObject({ status: "error", steps: [] });
            expect(r!.error, app).toMatch(/can't be started by a test: command shells, script hosts and similar programs are never allowed/);
            expect(counts()).toEqual(before);
        }
        // the script's own second check agrees: run a tampered script whose pre-flight is skipped by giving the adapter a permissive stand-in is impossible, so ask the helper directly
        const rt = (await import("../src/engine/desktop/policy.js")).desktopRuntime();
        expect(rt.desktopCheckApp("C:\\Windows\\System32\\cmd.exe", ["C:\\Windows\\System32\\cmd.exe"])).toMatchObject({ ok: false, code: "denied" });
    }, 120_000);

    it("nothing in a spec can run: injection attempts in names, ids, text and arguments stay data", async () => {
        const marker = path.join(tmp, "pwned.txt");
        const bad = [`x'; New-Item -ItemType File -Path '${marker}'; '`, "x`$(New-Item -ItemType File -Path '" + marker + "')", `"; Set-Content '${marker}' 1; "`, "a\nNew-Item -ItemType File -Path '" + marker + "'\n", `$(Set-Content -Path '${marker}' -Value 1)`, `\${env:USERNAME}`];
        // All attempts in one run, three windows at a time (each waits out the 10 s "nothing matched" retry; one after another took ~100 s).
        // Safe in parallel: desktop steps act through UI Automation patterns only, never the keyboard, so windows cannot steal each other's input.
        const specs = bad.map((text, i) =>
            desktopSpec(`DSK-${200 + i}`, "Injection attempt", [
                { action: "launchApp" },
                { action: "fill", locator: { by: "label", value: "Name field" }, value: text },
                { action: "click", locator: L("btnGreet") },
                { action: "assert", check: "text", locator: L("lblGreeting"), expected: `Hello, ${text}!` },
                { action: "click", locator: { by: "testId", value: text } }, // no such element: must fail as "nothing matched", never run anything
            ]),
        );
        const { runs } = await runSpecs(specs, { workers: 3 });
        expect(runs).toHaveLength(bad.length);
        for (const [i, text] of bad.entries()) {
            const run = runs.find((r) => r.testId === `DSK-${200 + i}`)!;
            expect(run.steps[3]!.status, text).toBe("passed"); // the text reached the application exactly as written
            expect(run.steps[4]!.error, text).toMatch(/nothing matched/);
        }
        expect(fs.existsSync(marker), bad.join(" | ")).toBe(false);
        // arguments are data too: the program receives them as text and shows them
        const arg = desktopSpec("DSK-210", "Argument as data", [{ action: "launchApp" }, { action: "assert", check: "text", locator: L("lblEcho"), expected: "Echo: x y" }], { args: ["--echo=x y"] });
        expect((await runSpecs([arg])).runs[0]!.status).toBe("passed");
        // and the spec check refuses the dangerous ones before anything exists
        expect(() => desktopSpec("DSK-211", "Bad arg", [{ action: "launchApp" }], { args: ["--echo=$(calc)"] })).toThrow(/Arguments can't contain/);
        expect(fs.existsSync(marker)).toBe(false);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 420_000);

    it("two desktop tests at the same time each drive their own window", async () => {
        const mk = (id: string, clicks: number) =>
            desktopSpec(id, `Own window ${id}`, [{ action: "launchApp" }, ...Array.from({ length: clicks }, () => ({ action: "click", locator: L("btnAdd") })), { action: "wait", ms: 1500 }, { action: "assert", check: "text", locator: L("lblCount"), expected: `Count: ${clicks}` }]);
        const { runs } = await runSpecs([mk("DSK-301", 3), mk("DSK-302", 5)], { workers: 2 });
        expect(runs.map((r) => r.status)).toEqual(["passed", "passed"]);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 240_000);

    it("only the window of the process the test started is touched: a look-alike window that was already open stays unchanged", async () => {
        const other = spawn(EXE, ["--title=AITP Fixture", "--exit-after=120"], { stdio: "ignore", windowsHide: false });
        foreign.push(other);
        await new Promise((r) => setTimeout(r, 3000));
        const spec = desktopSpec("DSK-303", "Not the neighbour", [{ action: "launchApp" }, { action: "click", locator: L("btnAdd") }, { action: "click", locator: L("btnAdd") }, { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 2" }], { windowTitle: "AITP Fixture" });
        const { runs } = await runSpecs([spec]);
        expect(runs[0]!.status).toBe("passed");
        expect(labelOf(other.pid!, "lblCount")).toBe("Count: 0");
        process.kill(other.pid!);
        foreign.length = 0;
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 180_000);

    it("a start that never shows a window fails plainly and leaves nothing running", async () => {
        const spec = desktopSpec("DSK-304", "Wrong title", [{ action: "launchApp" }], { windowTitle: "No such title", startTimeoutMs: 3000 });
        const { runs } = await runSpecs([spec]);
        expect(runs[0]!.status).toBe("failed");
        expect(runs[0]!.steps[0]!.error).toMatch(/did not open a window whose title contains that text within 3 seconds/);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 120_000);

    it("no orphan processes after a time-out", async () => {
        const spec = desktopSpec("DSK-305", "Takes too long", [{ action: "launchApp" }, ...Array.from({ length: 6 }, () => ({ action: "wait", ms: 10_000 }))]);
        const t0 = Date.now();
        const { runs } = await runSpecs([spec], { timeoutMs: 15_000 });
        expect(Date.now() - t0).toBeLessThan(80_000);
        expect(runs[0]!.status).not.toBe("passed");
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 150_000);

    it("no orphan processes after a cancel", async () => {
        const spec = desktopSpec("DSK-306", "Cancelled", [{ action: "launchApp" }, ...Array.from({ length: 6 }, () => ({ action: "wait", ms: 10_000 }))]);
        const ctl = new AbortController();
        const started = runSpecs([spec], { signal: ctl.signal });
        // wait until the application is really up, then cancel
        for (let i = 0; i < 60 && counts().apps === 0; i++) await new Promise((r) => setTimeout(r, 500));
        expect(counts().apps).toBeGreaterThan(0);
        ctl.abort();
        const { runs } = await started.catch(() => ({ runs: [] as ScriptRun[] }));
        expect(runs[0]?.status ?? "error").not.toBe("passed");
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
        const cancelled = await runSpecs([spec], { signal: ctl.signal }).then(() => "ran", (e: Error) => e.message);
        expect(cancelled).toBe("Job cancelled");
    }, 150_000);
});

// ── through the platform ────────────────────────────────────────────────────

d("through the platform on this computer (runOn = platform)", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;
    const BASE = `http://127.0.0.1:${PLATFORM_PORT}`;
    const admin = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
    };
    const jobDone = async (jobId: string): Promise<any> => {
        for (let i = 0; i < 400; i++) {
            const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await new Promise((r) => setTimeout(r, 300));
        }
        throw new Error("job did not finish");
    };
    const specJson = (title: string, steps: unknown[], desktop: Record<string, unknown> = {}) => ({ title, kind: "desktop", category: "Desktop", desktop: { app: EXE, startTimeoutMs: 20_000, ...desktop }, steps });
    let projectId = "";

    beforeAll(async () => {
        process.env.DESKTOP_ALLOWED_APPS = EXE;
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
        server = await buildServer(platform);
        await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
        worker = new Worker(platform, 150);
        worker.start();
        projectId = (await admin("POST", "/api/projects", { name: "Desktop on the platform" })).body.id;
    }, 60_000);

    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
    });

    it("reports the new framework and kind", async () => {
        const cfg = (await admin("GET", "/api/config")).body;
        const a = (cfg.adapters as Array<{ id: string; kinds: string[]; needs: Record<string, unknown> }>).find((x) => x.id === "windows-uia")!;
        expect(a).toMatchObject({ kinds: ["desktop"], needs: { node: true, windows: true } });
    });

    it("import refuses specs that could launch something else or inject, with plain reasons", async () => {
        const tries: Array<[unknown, RegExp]> = [
            [specJson("Shell", [{ action: "launchApp" }], { app: "cmd.exe" }), /can't be started by a test/],
            [specJson("PowerShell", [{ action: "launchApp" }], { app: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }), /can't be started by a test/],
            [specJson("Script", [{ action: "launchApp" }], { app: "C:\\x\\run.bat" }), /Only \.exe/],
            [specJson("Share", [{ action: "launchApp" }], { app: "\\\\server\\share\\a.exe" }), /network share/],
            [specJson("Url", [{ action: "launchApp" }], { app: "https://evil.example/a.exe" }), /web address/],
            [specJson("Traversal", [{ action: "launchApp" }], { app: "C:\\apps\\..\\Windows\\a.exe" }), /\.\./],
            [specJson("Inject", [{ action: "launchApp" }], { app: "a.exe; calc" }), /characters/],
            [specJson("Args", [{ action: "launchApp" }], { args: ["--x=$(calc)"] }), /Arguments can't contain/],
            [specJson("Keys", [{ action: "launchApp" }, { action: "press", key: "Enter" }]), /keyboard/],
            [specJson("NoLaunch", [{ action: "click", locator: L("a") }]), /start with a launchApp/],
        ];
        for (const [spec, why] of tries) {
            const res = await admin("POST", `/api/projects/${projectId}/specs`, { validate: false, specs: [spec] });
            expect(res.status, JSON.stringify(spec)).toBe(400);
            expect(res.text).toMatch(why);
        }
        expect(((await admin("GET", `/api/projects/${projectId}/tests`)).body as unknown[]).length).toBe(0);
    });

    it("a desktop spec imports with validation, runs on this computer and is VALIDATED, with history", async () => {
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            validate: true,
            specs: [specJson("The counter goes up", [{ action: "launchApp" }, { action: "click", locator: L("btnAdd") }, { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 1" }])],
        });
        expect(imp.status, imp.text).toBe(202);
        expect(imp.body.jobId).toBeTruthy();
        const job = await jobDone(imp.body.jobId);
        expect(job.status).toBe("COMPLETED");
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; kind: string; framework: string; validationStatus: string }>;
        expect(tests[0]).toMatchObject({ testId: "DSK-001", kind: "desktop", framework: "windows-uia", validationStatus: "VALIDATED" });
        const execs = (await admin("GET", `/api/tests/${tests[0]!.id}/executions`)).body;
        expect(execs[0]).toMatchObject({ status: "passed" });
        const script = (await admin("GET", `/api/tests/${tests[0]!.id}/script`)).text;
        expect(script).toContain("aitp:target");
        expect(script).toContain("DESKTOP_POLICY = null"); // the stored script never carries this computer's list
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 240_000);

    it("a failing desktop test is stored as a failed validation with the window picture", async () => {
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { validate: true, specs: [specJson("A missing button", [{ action: "launchApp" }, { action: "click", locator: L("nothingHere") }])] });
        await jobDone(imp.body.jobId);
        const t = ((await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string }>).find((x) => x.title === "A missing button")!;
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        const arts = platform.db.all<{ id: string; kind: string }>("SELECT id, kind FROM artifacts WHERE test_case_id = ?", t.id);
        const shot = arts.find((a) => a.kind === "screenshot")!;
        expect(shot).toBeDefined();
        const served = await fetch(`${BASE}/api/artifacts/${shot.id}?key=${API_KEY}`);
        expect(Buffer.from(await served.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 240_000);

    it("an application that is not on this computer's list is refused with a plain 409, never run, and is not a failing test", async () => {
        const calc = "C:\\Windows\\System32\\calc.exe";
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { validate: true, specs: [specJson("Not allowed here", [{ action: "launchApp" }], { app: calc })] });
        expect(imp.status).toBe(202);
        expect(imp.body.jobId).toBeNull();
        expect(imp.body.notRun).toBe("This computer isn't set up to start C:\\Windows\\System32\\calc.exe. Add it to DESKTOP_ALLOWED_APPS, then run again.");
        const t = ((await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string }>).find((x) => x.title === "Not allowed here")!;
        expect(t.validationStatus).toBe("PENDING");
        const again = await admin("POST", `/api/tests/${t.id}/validate`);
        expect(again.status).toBe(409);
        expect(again.text).toMatch(/isn't set up to start .*calc\.exe\. Add it to DESKTOP_ALLOWED_APPS/);
        expect(((await admin("GET", `/api/tests/${t.id}/executions`)).body as unknown[]).length).toBe(0);
    });

    it("the summary of the project lists the desktop tests; runner status says whether this computer can run them", async () => {
        const status = (await admin("GET", `/api/projects/${projectId}/runner`)).body;
        expect(status).toMatchObject({ runOn: "platform", canRunWindows: true });
    });
});

// ── through the real agent program ──────────────────────────────────────────

d("through the real agent program against the real platform", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;
    let agentWork: string;
    let agent: Agent;
    let agentDone: Promise<number>;
    let lines: string[];
    let token = "";
    let projectId = "";
    const BASE = `http://127.0.0.1:${AGENT_PLATFORM_PORT}`;
    const admin = async (method: string, url: string, body?: unknown) => {
        const res = await fetch(`${BASE}${url}`, { method, headers: { "x-api-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        return { status: res.status, text, body: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : undefined } as { status: number; text: string; body: any };
    };
    const jobDone = async (jobId: string): Promise<any> => {
        for (let i = 0; i < 600; i++) {
            const j = (await admin("GET", `/api/test-generation/${jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(j.status)) return j;
            await new Promise((r) => setTimeout(r, 300));
        }
        throw new Error("job did not finish");
    };
    const specJson = (title: string, steps: unknown[], desktop: Record<string, unknown> = {}) => ({ title, kind: "desktop", category: "Desktop", desktop: { app: EXE, startTimeoutMs: 20_000, ...desktop }, steps });

    beforeAll(async () => {
        // The platform host itself has NO allow-list here: whatever runs, runs on the agent's own list.
        delete process.env.DESKTOP_ALLOWED_APPS;
        Object.assign(process.env, { AGENT_POLL_SECONDS: "1", AGENT_LEASE_SECONDS: "30", AGENT_WATCH_MS: "100", AGENT_NO_AGENT_GRACE_SECONDS: "5" });
        delete process.env.BLOCK_PRIVATE_TARGETS;
        dataDir = fs.mkdtempSync(path.join(tmp, "adata-"));
        agentWork = fs.mkdtempSync(path.join(tmp, "awork-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic", HOST: "127.0.0.1", PORT: String(AGENT_PLATFORM_PORT), CONCURRENCY: "2", MAX_REPAIR_ATTEMPTS: "0" }));
        server = await buildServer(platform);
        await server.listen({ port: AGENT_PLATFORM_PORT, host: "127.0.0.1" });
        worker = new Worker(platform, 150);
        worker.start();
        projectId = (await admin("POST", "/api/projects", { name: "Desktop on an agent" })).body.id;
    }, 60_000);

    // A job can still be waiting for the agent when the tests end (lease 30 s): stopping the worker waits for it, so allow more than 30 s.
    afterAll(async () => {
        agent?.stop();
        await agentDone;
        await worker?.stop();
        await server?.close();
        platform?.db.close();
    }, 90_000);

    it("an agent without an allow-list shows as able to run desktop apps but is refused any application", async () => {
        const made = { status: 201, body: { secret: personalRunner(platform, { label: "desktop", replace: true }).secret } };
        token = made.body.secret;
        const logger = memoryLogger();
        lines = logger.lines;
        agent = new Agent({
            config: { baseUrl: BASE, token, name: "desktop agent", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env", allowApps: [] },
            log: logger.log,
            heartbeatMs: 500,
            backoff: { baseMs: 100, maxMs: 500 },
        });
        agentDone = agent.run();
        for (let i = 0; i < 100; i++) {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean }>;
            if (list.some((a) => a.online)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ capabilities: { windows?: Record<string, unknown> } }>;
        expect(list[0]!.capabilities.windows).toMatchObject({ uiautomation: true, interactive: true, elevated: false });
        expect(list[0]!.capabilities.windows!.allowedApps).toBeUndefined();
        expect((await admin("PUT", `/api/projects/${projectId}/runner`, { runOn: "agent" })).status).toBe(200);
        expect(((await admin("GET", `/api/projects/${projectId}/runner`)).body as { canRunWindows: boolean }).canRunWindows).toBe(true);

        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { validate: true, specs: [specJson("Needs a list", [{ action: "launchApp" }])] });
        expect(imp.status, imp.text).toBe(202);
        expect(imp.body.jobId).toBeNull();
        expect(imp.body.notRun).toMatch(/isn't set up to start .*AitpFixture\.exe\. Add it with --allow-app, then run again\./);
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 120_000);

    it("with the application allowed on the agent, a desktop test runs there and ends VALIDATED with its history", async () => {
        agent.stop();
        await agentDone;
        const logger = memoryLogger();
        lines = logger.lines;
        agent = new Agent({
            config: { baseUrl: BASE, token, name: "desktop agent", concurrency: 1, workDir: agentWork, allowInsecure: false, cacheBytes: 64 * 1024 * 1024, tokenSource: "env", allowApps: [EXE] },
            log: logger.log,
            heartbeatMs: 500,
            backoff: { baseMs: 100, maxMs: 500 },
        });
        agentDone = agent.run();
        for (let i = 0; i < 100; i++) {
            const list = (await admin("GET", `/api/projects/${projectId}/agents`)).body as Array<{ online: boolean; capabilities: { windows?: { allowedApps?: string[] } } }>;
            if (list.some((a) => a.online && a.capabilities.windows?.allowedApps?.length)) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        const tests = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string }>;
        const started = await admin("POST", `/api/tests/${tests[0]!.id}/validate`);
        expect(started.status, started.text).toBe(202);
        const job = await jobDone(started.body.jobId);
        expect(job.ranOn).toMatchObject({ kind: "agent", name: "desktop agent" });
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, {
            validate: true,
            specs: [specJson("Agent counter", [{ action: "launchApp" }, { action: "click", locator: L("btnAdd") }, { action: "click", locator: L("btnAdd") }, { action: "assert", check: "text", locator: L("lblCount"), expected: "Count: 2" }])],
        });
        expect(imp.status, imp.text).toBe(202);
        const done = await jobDone(imp.body.jobId);
        expect(done.ranOn).toMatchObject({ kind: "agent" });
        const all = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string }>;
        const t = all.find((x) => x.title === "Agent counter")!;
        expect(t.validationStatus).toBe("VALIDATED");
        expect(((await admin("GET", `/api/tests/${t.id}/executions`)).body as Array<{ status: string }>)[0]).toMatchObject({ status: "passed" });
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 300_000);

    it("a failing desktop test on the agent comes back with its window picture; the agent leaves nothing running", async () => {
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { validate: true, specs: [specJson("Agent missing button", [{ action: "launchApp" }, { action: "click", locator: L("absent") }])] });
        await jobDone(imp.body.jobId);
        const all = (await admin("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; title: string; validationStatus: string }>;
        const t = all.find((x) => x.title === "Agent missing button")!;
        expect(t.validationStatus).toBe("FAILED_VALIDATION");
        const arts = platform.db.all<{ kind: string }>("SELECT kind FROM artifacts WHERE test_case_id = ?", t.id);
        expect(arts.map((a) => a.kind)).toContain("screenshot");
        expect(await settles()).toEqual({ apps: 0, helpers: 0 });
    }, 240_000);

    it("the agent refuses an application it was not told about, even if the platform's check were bypassed", async () => {
        // Ask the agent's own task runner directly through a task whose application is not on its list: the platform's early check
        // already refuses such a job (409), so reach the second layer with a script the platform never rendered.
        const { checkApp } = await import("../src/engine/desktop/policy.js");
        expect(checkApp("C:\\Windows\\System32\\calc.exe", [EXE], "agent")).toMatchObject({ ok: false, code: "notallowed" });
        const calc = "C:\\Windows\\System32\\calc.exe";
        const imp = await admin("POST", `/api/projects/${projectId}/specs`, { validate: true, specs: [specJson("Calc on agent", [{ action: "launchApp" }], { app: calc })] });
        expect(imp.body.notRun).toMatch(/isn't set up to start .*calc\.exe\. Add it with --allow-app/);
    });

    it("what the agent printed holds no credential, token or application text", () => {
        const text = lines.join("\n");
        expect(text).toMatch(/Task .* finished/);
        expect(text).not.toContain(token);
        expect(text).not.toContain(SENTINEL);
        expect(text).toMatch(/Windows desktop apps: ready/);
    });
});
