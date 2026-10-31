/**
 * Windows desktop tests without a desktop (fast tier, any operating system): the target and step rules, the hard deny-list,
 * allow-list matching on resolved paths, injection attempts travelling as data, the JSON-lines protocol against a fake
 * PowerShell, redaction, the capability decision table, the generated script (shape, self-contained, no forbidden literals)
 * and the agent's command line. Nothing here starts a real process.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Capabilities } from "../src/agent-protocol/schema.js";
import { parseAgentArgs } from "../src/agent/config.js";
import { CapabilityProbe, describeCapabilities } from "../src/agent/capabilities.js";
import { DESKTOP_HELPER_SOURCE, loadDesktopRuntime, type DesktopDeps } from "../src/engine/desktop/helper.js";
import { UIA_HOST_SCRIPT } from "../src/engine/desktop/host-script.js";
import { checkApp, targetOfScript, withPolicy } from "../src/engine/desktop/policy.js";
import { desktopUnavailableReason, parseProbe, probeDesktop } from "../src/engine/desktop/probe.js";
import { describeDesktopStep, desktopSpecIssues } from "../src/engine/desktop/spec.js";
import { parseLedger } from "../src/engine/desktop/sweep.js";
import { appProblem, argProblem, DesktopTargetSchema, isAppUri, isDeniedProgram } from "../src/engine/desktop/target.js";
import { EVIDENCE_HELPER_SOURCE } from "../src/engine/evidence/capture.js";
import { WindowsAdapter } from "../src/engine/frameworks/windows.js";
import { getAdapter, renderWithAdapter } from "../src/engine/frameworks/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { capabilityProblem } from "../src/platform/agent-routing.js";
import { agentAllows, agentDesktopProblem, hostDesktopProblem } from "../src/platform/desktop-guard.js";

const CALC = "C:\\Windows\\System32\\calc.exe";
const FORBIDDEN = ["sk-", "api_key", "TEST_PASSWORD", "password:"];

const spec = (over: Record<string, unknown> = {}): TestSpec =>
    TestSpecSchema.parse({
        testId: "DSK-001",
        title: "Counter goes up",
        kind: "desktop",
        desktop: { app: CALC },
        steps: [
            { action: "launchApp" },
            { action: "click", locator: { by: "testId", value: "btnAdd" } },
            { action: "assert", check: "text", locator: { by: "testId", value: "lblCount" }, expected: "Count: 1" },
        ],
        ...over,
    });

describe("target rules", () => {
    it("accepts program names and absolute drive paths", () => {
        expect(appProblem("calc.exe")).toBeUndefined();
        expect(appProblem("calc")).toBeUndefined();
        expect(appProblem("C:\\Program Files\\My Tool\\tool.exe")).toBeUndefined();
        expect(appProblem("D:/apps/tool.exe")).toBeUndefined();
    });
    it.each([
        ["", /Name the application/],
        ["\\\\server\\share\\x.exe", /network share/],
        ["//server/share/x.exe", /network share/],
        ["https://evil.example/x.exe", /web address/],
        ["file://C:/x.exe", /web address/],
        ["..\\x.exe", /Relative paths|characters/],
        ["C:\\apps\\..\\Windows\\x.exe", /\.\./],
        ["apps\\tool.exe", /Relative paths/],
        ["tool.exe & calc.exe", /characters that aren't allowed/],
        ["tool.exe; calc", /characters that aren't allowed/],
        ["tool`calc`.exe", /characters that aren't allowed/],
        ["$(calc).exe", /characters that aren't allowed/],
        ["tool\n.exe", /control characters/],
        ["run.bat", /Only \.exe/],
        ["run.ps1", /Only \.exe/],
        ["run.lnk", /Only \.exe/],
        ["C:\\x\\setup.msi", /Only \.exe/],
        ["C:\\x\\a.dll", /Only \.exe/],
        ["C:\\x\\tool.exe.txt", /Only \.exe/],
        ["C:\\x\\tool.", /end with a program file name/],
        ["C:\\x\\NUL", /device name/],
        ["a:b.exe", /program name \(calc\.exe\)/],
    ])("refuses %j", (app, why) => {
        expect(appProblem(app)).toMatch(why);
    });

    it.each(["cmd", "CMD.EXE", "powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "pwsh", "wscript", "cscript.exe", "mshta", "rundll32", "regsvr32", "msbuild", "node", "python.exe", "bash", "wsl", "certutil", "explorer", "reg", "schtasks", "msiexec", "curl", "taskkill"])(
        "the hard deny-list refuses %s even as a spec target",
        (app) => {
            expect(isDeniedProgram(app)).toBe(true);
            expect(appProblem(app)).toMatch(/can't be started by a test|never allowed/);
            expect(DesktopTargetSchema.safeParse({ app }).success).toBe(false);
        },
    );

    it("arguments are plain data: nothing a shell would act on", () => {
        for (const ok of ["--mode=fast", "C:\\data\\a.txt", "plain words", "/flag", "-v"]) expect(argProblem(ok)).toBeUndefined();
        for (const bad of ['"quoted"', "it's", "a;b", "a&b", "a|b", "a>b", "a<b", "`x`", "$(x)", "%PATH%", "a^b", "line\nbreak", "..\\secret", "--file=..\\x", "http://x/y", "--url=https://x", "\\\\server\\share\\f"]) {
            expect(argProblem(bad), bad).toBeTypeOf("string");
        }
        expect(DesktopTargetSchema.safeParse({ app: CALC, args: ["--ok", "$(calc)"] }).success).toBe(false);
        expect(DesktopTargetSchema.safeParse({ app: CALC, args: Array(21).fill("a") }).success).toBe(false);
        expect(DesktopTargetSchema.safeParse({ app: CALC, startTimeoutMs: 60_001 }).success).toBe(false);
        expect(DesktopTargetSchema.safeParse({ app: CALC, startTimeoutMs: 60_000, extra: 1 }).success).toBe(false);
        expect(DesktopTargetSchema.safeParse({ app: CALC, windowTitle: "Calc", args: ["--a"], startTimeoutMs: 20_000 }).success).toBe(true);
    });

    it("pseudo addresses of device and desktop projects are not web addresses", () => {
        expect(isAppUri("windows-app://desktop")).toBe(true);
        expect(isAppUri("android-app://com.x.y")).toBe(true);
        expect(isAppUri("https://example.com")).toBe(false);
    });
});

describe("step vocabulary", () => {
    it("a good spec has no issues", () => expect(desktopSpecIssues(spec())).toEqual([]));
    it("needs a target and a first launchApp step", () => {
        expect(desktopSpecIssues({ ...spec(), desktop: undefined }).join()).toMatch(/needs a desktop target/);
        expect(desktopSpecIssues(spec({ steps: [{ action: "click", locator: { by: "testId", value: "a" } }] })).join()).toMatch(/start with a launchApp/);
        expect(desktopSpecIssues(spec({ steps: [{ action: "launchApp" }, { action: "launchApp" }] })).join()).toMatch(/once/);
        expect(desktopSpecIssues(spec({ steps: [{ action: "launchApp" }, { action: "closeApp" }, { action: "wait", ms: 5 }] })).join()).toMatch(/closeApp can only be the last/);
    });
    it("refuses what would need the mouse, the keyboard or a browser, and page-style locators", () => {
        const bad = (step: unknown) => desktopSpecIssues(spec({ steps: [{ action: "launchApp" }, step] })).join();
        expect(bad({ action: "navigate", url: "https://x" })).toMatch(/web addresses/);
        expect(bad({ action: "press", key: "Enter" })).toMatch(/keyboard/);
        expect(bad({ action: "hover", locator: { by: "testId", value: "a" } })).toMatch(/mouse/);
        expect(bad({ action: "request", method: "GET", path: "/" })).toMatch(/API/);
        expect(bad({ action: "click", locator: { by: "css", value: "#a" } })).toMatch(/css/);
        expect(bad({ action: "click", locator: { by: "role", role: "Teapot" } })).toMatch(/control type/);
        expect(bad({ action: "assert", check: "url", expected: "x" })).toMatch(/web page/);
        expect(bad({ action: "assert", check: "text", expected: "x" })).toMatch(/Name the element/);
        expect(bad({ action: "assert", check: "count", locator: { by: "text", value: "a" }, expected: "many" })).toMatch(/whole number/);
    });
    it("a non-desktop spec must not carry a desktop target", () => {
        expect(desktopSpecIssues({ kind: "web", steps: [], desktop: { app: CALC } } as never).join()).toMatch(/Only desktop tests/);
    });
    it("describes steps in plain words", () => {
        expect(describeDesktopStep({ action: "click", locator: { by: "testId", value: "btnAdd" }, description: "" })).toBe('Click the element with automation id "btnAdd"');
        expect(describeDesktopStep({ action: "fill", locator: { by: "role", role: "Edit", value: "Name" }, value: "Ann", description: "" })).toBe('Enter "Ann" into the edit named "Name"');
    });
});

// ── a fake PowerShell host ──────────────────────────────────────────────────

interface Fake {
    spawned: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }>;
    requests: Array<Record<string, unknown>>;
    wire: string[];
    files: Map<string, string>;
    session: ReturnType<ReturnType<typeof loadDesktopRuntime>["desktopSession"]>;
    rt: ReturnType<typeof loadDesktopRuntime>;
}

function fakeRuntime(opts: { env?: Record<string, string>; existing?: string[]; ready?: Record<string, unknown>; answers?: (req: Record<string, any>) => Record<string, unknown> } = {}) {
    const existing = new Set((opts.existing ?? [CALC]).map((p) => p.toLowerCase()));
    const spawned: Fake["spawned"] = [];
    const requests: Fake["requests"] = [];
    const wire: string[] = [];
    const files = new Map<string, string>();
    const fakeFs = {
        mkdirSync: () => undefined,
        writeFileSync: (p: string, c: string) => void files.set(p, c),
        rmSync: () => undefined,
        statSync: (p: string) => {
            if (!existing.has(String(p).toLowerCase())) throw new Error("ENOENT");
            return { isFile: () => true };
        },
        realpathSync: Object.assign((p: string) => p, { native: (p: string) => p }),
    };
    const fakeSpawn = (file: string, args: string[], o: { env: Record<string, string | undefined> }) => {
        const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
        const stdout = new EventEmitter();
        const stdin = Object.assign(new EventEmitter(), {
            write(line: string) {
                wire.push(line);
                const req = JSON.parse(line) as Record<string, any>;
                requests.push(req);
                const answer = opts.answers?.(req) ?? { ok: true };
                setImmediate(() => stdout.emit("data", Buffer.from(`${JSON.stringify({ ...answer, id: req.id })}\n`)));
                return true;
            },
            end() {
                setImmediate(() => child.emit("exit", 0));
            },
        });
        Object.assign(child, { pid: 4242, stdin, stdout, stderr: new EventEmitter(), kill: () => undefined });
        spawned.push({ file, args, env: o.env });
        // The helper script itself is what announces readiness.
        if (path.win32.basename(file).toLowerCase() === "powershell.exe") setImmediate(() => stdout.emit("data", Buffer.from(`${JSON.stringify({ ready: true, elevated: false, interactive: true, ...opts.ready })}\n`)));
        return child;
    };
    const fakeProcess = { platform: "win32", env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", SECRET_THING: "must-not-reach-host", ...opts.env } };
    const rt = loadDesktopRuntime({ fs: fakeFs, path, os, spawn: fakeSpawn, process: fakeProcess }, EVIDENCE_HELPER_SOURCE);
    return { rt, spawned, requests, wire, files };
}

const target = { app: CALC, startTimeoutMs: 5000 };

describe("allow-list and deny-list on the resolved path", () => {
    const deps = (files: Record<string, string>): DesktopDeps => ({
        dirs: ["C:\\Windows\\System32", "C:\\Tools"],
        isFile: (p) => p.toLowerCase() in files || Object.values(files).some((v) => v.toLowerCase() === p.toLowerCase()),
        real: (p) => files[p.toLowerCase()] ?? p,
    });
    const { rt } = fakeRuntime();
    it("a name is looked up on the PATH and matched as the file it really is", () => {
        const d = deps({ "c:\\windows\\system32\\calc.exe": "C:\\Windows\\System32\\calc.exe" });
        expect(rt.desktopCheckApp("calc.exe", [CALC], d)).toEqual({ ok: true, full: CALC });
        expect(rt.desktopCheckApp("CALC", ["calc.exe"], d)).toEqual({ ok: true, full: CALC });
        expect(rt.desktopCheckApp(CALC.toUpperCase(), [CALC.toLowerCase()], d).ok).toBe(true);
    });
    it("an application that is not on the list is refused with the plain sentence", () => {
        const d = deps({ "c:\\windows\\system32\\calc.exe": CALC });
        const r = rt.desktopCheckApp("calc.exe", ["C:\\Other\\app.exe"], d);
        expect(r).toMatchObject({ ok: false, code: "notallowed" });
        expect(rt.desktopRefusalText(r as never, "agent")).toBe("This computer isn't set up to start calc.exe. Add it with --allow-app, then run again.");
        expect(rt.desktopRefusalText(r as never, "host")).toMatch(/DESKTOP_ALLOWED_APPS/);
        expect(rt.desktopCheckApp("calc.exe", [], d)).toMatchObject({ ok: false, code: "notallowed" });
    });
    it("no wildcards: a folder or a pattern does not allow what is inside it", () => {
        const d = deps({ "c:\\windows\\system32\\calc.exe": CALC });
        expect(rt.desktopCheckApp("calc.exe", ["C:\\Windows\\System32\\*", "C:\\Windows\\System32", "C:\\Windows\\System32\\*.exe"], d).ok).toBe(false);
    });
    it("a same-named program in another folder is a different program", () => {
        const d = deps({ "c:\\tools\\calc.exe": "C:\\Tools\\calc.exe", "c:\\windows\\system32\\calc.exe": CALC });
        expect(rt.desktopCheckApp("C:\\Tools\\calc.exe", [CALC], d)).toMatchObject({ ok: false, code: "notallowed" });
    });
    it("the deny-list wins over the allow-list, by name and by the file a link or copy really is", () => {
        const d = deps({ "c:\\windows\\system32\\cmd.exe": "C:\\Windows\\System32\\cmd.exe", "c:\\tools\\innocent.exe": "C:\\Windows\\System32\\cmd.exe" });
        expect(rt.desktopCheckApp("cmd.exe", ["cmd.exe", "C:\\Windows\\System32\\cmd.exe"], d)).toMatchObject({ ok: false, code: "denied" });
        expect(rt.desktopCheckApp("C:\\Tools\\innocent.exe", ["C:\\Tools\\innocent.exe"], d)).toMatchObject({ ok: false, code: "denied" });
        expect(rt.desktopCheckApp("powershell", ["powershell.exe"], d)).toMatchObject({ ok: false, code: "denied" });
    });
    it("allowed but missing is reported as not found, not as a test failure", () => {
        expect(rt.desktopCheckApp("C:\\Gone\\x.exe", ["C:\\Gone\\x.exe"], deps({}))).toMatchObject({ ok: false, code: "notfound" });
    });
    it("the list text is split on semicolons", () => expect(rt.desktopParseList(" a.exe ;; C:\\b\\c.exe ;")).toEqual(["a.exe", "C:\\b\\c.exe"]));
    it("checkApp refuses on a computer that is not Windows, before looking at anything", () => {
        expect(checkApp(CALC, [CALC], "agent", "linux")).toMatchObject({ ok: false, code: "platform" });
    });
});

describe("a session against a fake PowerShell", () => {
    it("refuses an unlisted application before any process is started", async () => {
        const f = fakeRuntime();
        const s = f.rt.desktopSession(target, { allow: [], via: "agent", dir: "C:\\tmp\\x" });
        await expect(s.launch()).rejects.toThrow(/^DESKTOP_REFUSED: This computer isn't set up to start .*calc\.exe\. Add it with --allow-app, then run again\.$/);
        expect(f.spawned).toHaveLength(0);
    });
    it("refuses a denied program even if the allow-list names it", async () => {
        const f = fakeRuntime({ existing: ["C:\\Windows\\System32\\cmd.exe"] });
        const s = f.rt.desktopSession({ app: "cmd.exe" }, { allow: ["cmd.exe"], via: "agent", dir: "C:\\tmp\\x" });
        await expect(s.launch()).rejects.toThrow(/DESKTOP_REFUSED: .*never allowed/);
        expect(f.spawned).toHaveLength(0);
    });
    it("refuses to run elevated or without an interactive desktop, and ends the helper", async () => {
        for (const [ready, text] of [[{ elevated: true }, /elevated/], [{ interactive: false }, /interactive desktop/]] as const) {
            const f = fakeRuntime({ ready });
            const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
            await expect(s.launch()).rejects.toThrow(text);
            expect(f.requests.some((r) => r.cmd === "launch")).toBe(false);
        }
    });
    it("starts ONE hidden powershell with no profile and no prompt, running a script file, with a clean environment", async () => {
        const f = fakeRuntime();
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        const ps = f.spawned.filter((x) => /powershell\.exe$/i.test(x.file));
        expect(ps).toHaveLength(1);
        expect(ps[0]!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-STA"]);
        expect(ps[0]!.env.SECRET_THING).toBeUndefined();
        expect([...f.files.values()].some((c) => c === UIA_HOST_SCRIPT)).toBe(true);
        // the command line holds no value from the spec
        expect(ps[0]!.args.join(" ")).not.toContain("calc");
        await s.end();
    });
    it("sends the application path and arguments as JSON data, never inside a command", async () => {
        const f = fakeRuntime();
        const s = f.rt.desktopSession({ app: CALC, args: ["--echo=two words", "plain"], windowTitle: "Calc'; Remove-Item *; '" }, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        const launch = f.requests.find((r) => r.cmd === "launch")!;
        expect(launch.path).toBe(CALC);
        expect(launch.args).toEqual(["--echo=two words", "plain"]);
        expect(launch.windowTitle).toBe("Calc'; Remove-Item *; '");
        await s.end();
    });
    it.each(["x'; calc; '", "a`b", "$(calc)", "a;b", "line1\nline2", 'quote"s', "${env:USERNAME}", "é ü 日本語", "\u2028"])("a locator or text containing %j stays data on the wire", async (nasty) => {
        const f = fakeRuntime();
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        await s.click({ by: "testId", value: nasty });
        await s.fill({ by: "label", value: nasty }, nasty);
        const click = f.requests.find((r) => r.cmd === "click")!;
        const type = f.requests.find((r) => r.cmd === "type")!;
        expect((click.locator as { automationId: string }).automationId).toBe(nasty);
        expect(type.text).toBe(nasty);
        // one request per line, ASCII only: a newline inside a value cannot start a second request
        for (const line of f.wire) {
            expect(line.endsWith("\n")).toBe(true);
            expect(line.slice(0, -1)).not.toContain("\n");
            expect(/^[\x20-\x7e]*$/.test(line.slice(0, -1))).toBe(true);
        }
        await s.end();
    });
    it("the host script never builds code from request values", () => {
        // No Invoke-Expression, no scriptblock creation from data, no cmd or shell, no input synthesis.
        for (const banned of [/Invoke-Expression|\biex\b/i, /\[scriptblock\]::Create/i, /SendKeys|SendInput|mouse_event|keybd_event|SetCursorPos|SendMessage|PostMessage/i, /cmd\.exe|powershell\.exe|Start-Process|ShellExecute\(/i, /SetForegroundWindow|BringWindowToTop/i]) {
            expect(UIA_HOST_SCRIPT, String(banned)).not.toMatch(banned);
        }
        expect(UIA_HOST_SCRIPT).toContain("UseShellExecute = $false");
        expect(UIA_HOST_SCRIPT).toContain("ProcessIdProperty");
    });
    it("a refusal from the host itself is passed on as a refusal", async () => {
        const f = fakeRuntime({ answers: (r) => (r.cmd === "launch" ? { ok: false, code: "refused", error: "That program is never started by a test." } : { ok: true }) });
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await expect(s.launch()).rejects.toThrow(/^DESKTOP_REFUSED: That program is never started/);
    });
    it("a missing element fails with a plain sentence and a compact element tree", async () => {
        const nodes = [{ d: 0, t: "Window", i: "", n: "AITP Fixture" }, { d: 1, t: "Button", i: "btnAdd", n: "Add one" }, { d: 1, t: "Edit", i: "txtSecret", n: "[hidden]", p: true }];
        const f = fakeRuntime({ answers: (r) => (r.cmd === "click" ? { ok: false, code: "ambiguous", count: 3 } : r.cmd === "tree" ? { ok: true, nodes, more: 2 } : { ok: true }) });
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        await expect(s.click({ by: "text", value: "Add" })).rejects.toThrow(/Click failed: 3 elements matched the element named "Add" .*nth/s);
        const err = await s.click({ by: "text", value: "Add" }).catch((e: Error) => e.message);
        expect(err).toContain('Button #btnAdd "Add one"');
        expect(err).toContain('Edit #txtSecret "[hidden]"');
        expect(err).toContain("... and 2 more");
        await s.end();
    });
    it("retries a missing element for a few seconds, then gives up", async () => {
        let n = 0;
        const f = fakeRuntime({ answers: (r) => (r.cmd === "click" ? (++n < 3 ? { ok: false, code: "notfound" } : { ok: true }) : { ok: true }) });
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        await s.click({ by: "testId", value: "late" });
        expect(n).toBe(3);
        await s.end();
    });
    it("expect text: equals and contains on the name or the value; a password field is never compared", async () => {
        const state = { ok: true, count: 1, element: { type: "Edit", name: "Name field", value: "Ann", enabled: true, offscreen: false, isPassword: false } };
        const f = fakeRuntime({ answers: (r) => (r.cmd === "state" ? state : { ok: true }) });
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        await s.expect("text", { by: "testId", value: "t" }, "Ann");
        await s.expect("value", { by: "testId", value: "t" }, "Ann");
        await s.expect("enabled", { by: "testId", value: "t" });
        await s.expect("visible", { by: "testId", value: "t" });
        await s.expect("count", { by: "testId", value: "t" }, 1);
        state.element = { ...state.element, isPassword: true, name: "[hidden]", value: undefined as never };
        await expect(s.expect("value", { by: "testId", value: "t" }, "hunter2")).rejects.toThrow(/password field is never read/);
        await s.end();
    });
    it("ends cleanly: close, exit, and the helper is asked to stop", async () => {
        const f = fakeRuntime();
        const s = f.rt.desktopSession(target, { allow: [CALC], via: "agent", dir: "C:\\tmp\\x" });
        await s.launch();
        await s.end();
        await s.end();
        expect(f.requests.map((r) => r.cmd).filter((c) => c === "close" || c === "exit")).toEqual(["close", "exit"]);
    });
});

describe("redaction of what is read from an application", () => {
    it("masks this run's credentials and token shapes before they reach an error", () => {
        const secret = "Sup3rSecretValue";
        // The run's credentials come from the environment variables a script is given (here: the helper's own process object).
        const f = fakeRuntime({ env: { TEST_UNIT_PASSWORD: secret } });
        const out = (f.rt as unknown as { desktopTreeText(n: unknown[]): string }).desktopTreeText([{ d: 0, t: "Text", i: "lbl", n: `token ${secret} Bearer abcdef1234567890abcdef` }]);
        expect(out).not.toContain(secret);
        expect(out).not.toContain("abcdef1234567890abcdef");
    });
    it("caps the tree text", () => {
        const f = fakeRuntime();
        const nodes = Array.from({ length: 200 }, (_, i) => ({ d: 1, t: "Text", i: `id${i}`, n: `name number ${i}` }));
        const out = (f.rt as unknown as { desktopTreeText(n: unknown[], m?: number): string }).desktopTreeText(nodes);
        expect(out.length).toBeLessThan(1600);
        expect(out).toMatch(/\.\.\. and \d+ more$/);
    });
});

describe("the generated script", () => {
    const script = renderWithAdapter(spec({ tags: ["smoke"] }), "windows-uia", { baseUrl: "https://unused.example" });
    it("has the expected shape and the right id", () => {
        expect(script.framework).toBe("windows-uia");
        expect(script.filename).toBe("DSK-001.desktop.spec.ts");
        expect(script.content).toContain('import { test } from "@playwright/test";');
        expect(script.content).not.toMatch(/\{ page \}|page\.goto|chromium/);
        expect(script.content).toContain('await test.step("1. Start the application"');
        expect(script.content).toContain('await desk.click({ by: "testId", value: "btnAdd" });');
        expect(script.content).toContain('await desk.expect("text", { by: "testId", value: "lblCount" }, "Count: 1");');
        expect(script.content).toContain("test.afterEach");
        expect(script.content).toMatch(/^const DESKTOP_TARGET = \{.*\}; \/\/ aitp:target$/m);
        expect(script.content).toContain("const DESKTOP_POLICY = null; // aitp:policy");
    });
    it("is self-contained: the helper text is in it and it imports only node and playwright", () => {
        expect(script.content).toContain(DESKTOP_HELPER_SOURCE);
        const imports = [...script.content.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
        expect(imports.sort()).toEqual(["@playwright/test", "node:child_process", "node:fs", "node:os", "node:path"]);
    });
    it.each(FORBIDDEN)("does not contain the forbidden literal %s", (lit) => {
        expect(script.content).not.toContain(lit);
        expect(DESKTOP_HELPER_SOURCE).not.toContain(lit);
        expect(UIA_HOST_SCRIPT).not.toContain(lit);
    });
    it("carries nothing from the spec as code: placeholders are data lookups, text is a JSON literal", () => {
        const nasty = "x\"; process.exit(1); //";
        const s = renderWithAdapter(spec({ steps: [{ action: "launchApp" }, { action: "fill", locator: { by: "label", value: nasty }, value: "{{unique}}`${1}" }] }), "windows-uia", { baseUrl: "https://x" });
        expect(s.content).toContain(JSON.stringify(nasty));
        expect(s.content).not.toContain(`value: "x"; process`);
        expect(s.content).toContain("\\${1}");
    });
    it("the target is read back from the script text, and the policy line is replaced for a run only", () => {
        expect(targetOfScript(script.content)).toMatchObject({ app: CALC });
        const run = withPolicy(script.content, { allow: [CALC], via: "agent", dir: "C:\\tmp\\run" });
        expect(run).toContain('"allow":["C:\\\\Windows\\\\System32\\\\calc.exe"]');
        expect(run).not.toContain("DESKTOP_POLICY = null");
        expect(script.content).toContain("DESKTOP_POLICY = null"); // the stored text is untouched
        expect(targetOfScript("// nothing here")).toBeUndefined();
    });
    it("refuses specs that break the desktop rules or use data sets", () => {
        expect(() => renderWithAdapter({ ...spec(), desktop: { app: "cmd.exe" } as never }, "windows-uia", { baseUrl: "x" })).toThrow(/cannot be rendered/);
        expect(() => renderWithAdapter({ ...spec(), steps: [{ action: "navigate", url: "/", description: "" }] }, "windows-uia", { baseUrl: "x" })).toThrow(/cannot be rendered/);
        expect(() => renderWithAdapter(spec({ testData: { dataSet: "x" } }), "windows-uia", { baseUrl: "x" })).toThrow();
    });
    it("the other generators refuse desktop specs", () => {
        expect(() => renderWithAdapter(spec(), "playwright", { baseUrl: "https://x" })).toThrow();
        expect(() => renderWithAdapter(spec(), "taqwright", { baseUrl: "https://x" })).toThrow();
    });
});

describe("the adapter", () => {
    const a = getAdapter("windows-uia");
    it("is registered with the right needs", () => {
        expect(a.kinds).toEqual(["desktop"]);
        expect(a.needs).toEqual({ node: true, windows: true });
        expect(a.executable).toBe(true);
        expect(a.traits).toEqual({ visionJudgement: false, cleanupLedger: false, browserRepair: false });
        expect(a.describe().id).toBe("windows-uia");
    });
    const batch = (content: string) => ({ scratchDir: os.tmpdir(), scripts: [{ testId: "DSK-001", filename: "DSK-001.desktop.spec.ts", content }] });
    const env = { run: { baseUrl: "x", headless: true } };
    const good = renderWithAdapter(spec(), "windows-uia", { baseUrl: "x" }).content;
    it("on another operating system every script is refused as an infrastructure answer, without running anything", async () => {
        let ran = false;
        const adapter = new WindowsAdapter({ platform: "linux", run: async () => ((ran = true), []) });
        const [r] = await adapter.execute(batch(good), env, { workers: 1 });
        expect(r).toMatchObject({ status: "error", error: "Windows desktop tests can only run on a Windows computer." });
        expect(ran).toBe(false);
    });
    it("an application that is not on the list is refused and nothing is run", async () => {
        let ran = false;
        const adapter = new WindowsAdapter({ platform: "win32", probe: async () => ({ uiautomation: true, interactive: true, elevated: false }), hostAllow: () => [], run: async () => ((ran = true), []) });
        const [r] = await adapter.execute(batch(good), env, { workers: 1 });
        expect(r!.status).toBe("error");
        expect(r!.error).toBe("This computer isn't set up to start C:\\Windows\\System32\\calc.exe. Add it to DESKTOP_ALLOWED_APPS, then run again.");
        expect(ran).toBe(false);
    });
    it("an agent's own list is used, and its wording points at --allow-app", async () => {
        const adapter = new WindowsAdapter({ platform: "win32", probe: async () => ({ uiautomation: true, interactive: true, elevated: false }), run: async () => [] });
        const [r] = await adapter.execute(batch(good), { ...env, desktop: { allowApps: [] } }, { workers: 1 });
        expect(r!.error).toMatch(/--allow-app/);
    });
    it("elevated and non-interactive sessions are refused", async () => {
        for (const [probe, text] of [[{ uiautomation: true, interactive: true, elevated: true }, /administrator/], [{ uiautomation: true, interactive: false, elevated: false }, /interactive desktop/], [{ uiautomation: false, interactive: true, elevated: false }, /UI Automation is not available/]] as const) {
            const adapter = new WindowsAdapter({ platform: "win32", probe: async () => probe, hostAllow: () => [CALC], run: async () => [] });
            const [r] = await adapter.execute(batch(good), env, { workers: 1 });
            expect(r!.error).toMatch(text);
            expect(r!.status).toBe("error");
        }
    });
    it("a script without a valid target is refused", async () => {
        const adapter = new WindowsAdapter({ platform: "win32", probe: async () => ({ uiautomation: true, interactive: true, elevated: false }), run: async () => [] });
        const [r] = await adapter.execute(batch("test('x', () => {})"), env, { workers: 1 });
        expect(r!.error).toMatch(/not a Windows desktop test/);
    });
    it("a refusal raised inside the script becomes an infrastructure answer, not a failing test", async () => {
        const adapter = new WindowsAdapter({
            platform: "win32",
            probe: async () => ({ uiautomation: true, interactive: true, elevated: false }),
            hostAllow: () => [CALC],
            // CALC does not exist on a non-Windows machine, so give the adapter a resolvable target through the fake run only.
            run: async () => [{ testId: "DSK-001", status: "failed", durationMs: 5, error: "Error: DESKTOP_REFUSED: nope.", failedStepIndex: 0, steps: [{ index: 0, title: "1. Start", status: "failed", error: "DESKTOP_REFUSED: nope." }], artifacts: [], responses: [] }],
        });
        // the pre-flight needs the real file; skip it where the file is missing
        if (!fs.existsSync(CALC)) return;
        const [r] = await adapter.execute(batch(good), env, { workers: 1 });
        expect(r).toMatchObject({ status: "error", error: "nope.", steps: [] });
    });
});

describe("capability and routing decisions", () => {
    const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ os: "win32", arch: "x64", node: "v24", browsers: [], windows: { uiautomation: true, interactive: true, elevated: false }, ...over });
    const a = getAdapter("windows-uia");
    it("decision table", () => {
        expect(capabilityProblem(a, caps())).toBeUndefined();
        expect(capabilityProblem(a, caps({ os: "linux" }))).toMatch(/not a Windows computer/);
        expect(capabilityProblem(a, caps({ os: "darwin" }))).toMatch(/not a Windows computer/);
        expect(capabilityProblem(a, caps({ windows: undefined }))).toMatch(/UI Automation is not available/);
        expect(capabilityProblem(a, caps({ windows: { winappdriver: true } }))).toMatch(/UI Automation is not available/);
        expect(capabilityProblem(a, caps({ windows: { uiautomation: false } }))).toMatch(/UI Automation is not available/);
        expect(capabilityProblem(a, caps({ windows: { uiautomation: true, elevated: true } }))).toMatch(/administrator/);
        expect(capabilityProblem(a, caps({ windows: { uiautomation: true, interactive: false } }))).toMatch(/interactive desktop/);
    });
    it("a desktop agent needs no browser", () => expect(capabilityProblem(a, caps({ browsers: [] }))).toBeUndefined());
    it("the protocol still accepts the old windows capability and the new fields", () => {
        expect(Capabilities.safeParse({ os: "win32", arch: "x64", node: "v24", browsers: [], windows: { winappdriver: false } }).success).toBe(true);
        expect(Capabilities.safeParse(caps({ windows: { uiautomation: true, interactive: true, elevated: false, allowedApps: [CALC] } })).success).toBe(true);
    });
    it("the platform host: not Windows, or an application that is not allowed, is refused early with a plain sentence", () => {
        expect(hostDesktopProblem([CALC], { platform: "linux", allow: [CALC] })).toMatch(/need a Windows computer/);
        expect(hostDesktopProblem([], { platform: "linux" })).toBeUndefined();
        expect(hostDesktopProblem(["cmd.exe"], { platform: "win32", allow: ["cmd.exe"] })).toMatch(/never allowed|can't be started/);
        expect(hostDesktopProblem([CALC], { platform: "win32", allow: [] })).toMatch(/isn't set up to start .*DESKTOP_ALLOWED_APPS/);
    });
    it("an agent must be allowed to start each application", () => {
        const withList = { capabilities: caps({ windows: { uiautomation: true, interactive: true, elevated: false, allowedApps: [CALC] } }) };
        expect(agentAllows(withList.capabilities, CALC)).toBe(true);
        expect(agentAllows(withList.capabilities, "calc.exe")).toBe(true);
        expect(agentAllows(withList.capabilities, "C:\\Other\\calc.exe")).toBe(false);
        expect(agentDesktopProblem([CALC], [withList])).toBeUndefined();
        expect(agentDesktopProblem(["C:\\Apps\\x.exe"], [withList])).toBe("This computer isn't set up to start C:\\Apps\\x.exe. Add it with --allow-app, then run again.");
        expect(agentDesktopProblem(["powershell.exe"], [withList])).toMatch(/never allowed/);
        expect(agentDesktopProblem([CALC], [{ capabilities: caps() }])).toMatch(/--allow-app/);
    });
});

describe("the probe", () => {
    it("parses its one line and treats anything else as not available", () => {
        expect(parseProbe("uiautomation=True;interactive=True;elevated=False")).toEqual({ uiautomation: true, interactive: true, elevated: false });
        expect(parseProbe("noise\nuiautomation=True;interactive=False;elevated=True\n")).toEqual({ uiautomation: true, interactive: false, elevated: true });
        expect(parseProbe("garbage")).toEqual({ uiautomation: false, interactive: false, elevated: false });
        expect(parseProbe(undefined)).toEqual({ uiautomation: false, interactive: false, elevated: false });
    });
    it("runs nothing on another operating system", async () => {
        let ran = false;
        const r = await probeDesktop({ platform: "linux", run: async () => ((ran = true), "uiautomation=True;interactive=True;elevated=False") });
        expect(r.uiautomation).toBe(false);
        expect(ran).toBe(false);
    });
    it("explains why desktop tests cannot run", () => {
        expect(desktopUnavailableReason("linux", undefined)).toMatch(/Windows computer/);
        expect(desktopUnavailableReason("win32", { uiautomation: true, interactive: true, elevated: false })).toBeUndefined();
        expect(desktopUnavailableReason("win32", undefined)).toBeUndefined();
    });
    it("the capability probe reports Windows UI Automation, interactivity, elevation and the allow-list", async () => {
        const probe = new CapabilityProbe({ platform: "win32", env: {}, exec: async () => undefined, browsers: () => [], desktop: async () => ({ uiautomation: true, interactive: true, elevated: false }), allowApps: [] });
        const c = await probe.discover();
        expect(c.windows).toMatchObject({ uiautomation: true, interactive: true, elevated: false });
        expect(describeCapabilities(c)).toMatch(/Windows desktop apps: ready, no application is allowed yet \(use --allow-app\)/);
        const none = await new CapabilityProbe({ platform: "linux", env: {}, exec: async () => undefined, browsers: () => [] }).discover();
        expect(none.windows).toBeUndefined();
    });
});

describe("the agent's allow-list options", () => {
    const TOKEN = "aitg_UnitTestToken0123456789abcdefghijk";
    const base = ["--url", "https://tests.example.com"];
    const run = (argv: string[], env: Record<string, string> = {}) => {
        const r = parseAgentArgs([...base, ...argv], { AITP_AGENT_TOKEN: TOKEN, ...env });
        if (r.kind !== "run") throw new Error(JSON.stringify(r));
        return r.config;
    };
    it("nothing is allowed by default", () => expect(run([]).allowApps).toEqual([]));
    it("--allow-app is repeatable and AITP_ALLOW_APPS is semicolon-separated; duplicates are dropped", () => {
        expect(run(["--allow-app", CALC, "--allow-app", "notepad.exe"], { AITP_ALLOW_APPS: "notepad.exe;C:\\x\\y.exe" }).allowApps).toEqual([CALC, "notepad.exe", "C:\\x\\y.exe"]);
    });
    it("an allow-list file has one entry per line and may have comments", () => {
        const file = path.join(os.tmpdir(), `aitp-allow-${Date.now()}.txt`);
        fs.writeFileSync(file, "# apps\nnotepad.exe\n\nC:\\x\\y.exe\n");
        try {
            expect(run(["--allow-apps-file", file]).allowApps).toEqual(["notepad.exe", "C:\\x\\y.exe"]);
        } finally {
            fs.rmSync(file, { force: true });
        }
        expect(parseAgentArgs([...base, "--allow-apps-file", path.join(os.tmpdir(), "nope-not-here.txt")], { AITP_AGENT_TOKEN: TOKEN })).toMatchObject({ kind: "error" });
    });
    it("a shell on the list is dropped with a plain note", () => {
        const c = run(["--allow-app", "cmd.exe", "--allow-app", "powershell", "--allow-app", CALC]);
        expect(c.allowApps).toEqual([CALC]);
        expect(c.allowAppNotes?.join(" ")).toMatch(/cmd\.exe is never allowed/);
        expect(c.allowAppNotes?.join(" ")).toMatch(/powershell is never allowed/);
    });
    it("odd entries are ignored", () => expect(run(["--allow-app", "a|b", "--allow-app", "*.exe"]).allowApps).toEqual([]));
});

describe("ledger of started processes", () => {
    it("skips half-written and invalid lines", () => {
        // a Windows file time is larger than a JavaScript number holds exactly, so it is kept as digits
        const text = ['{"kind":"host","pid":12,"start":"133999999999999999"}', "{broken", '{"kind":"app","pid":-1,"start":"1234567890123"}', '{"kind":"app","pid":77,"start":"134000000000000001"}', '{"kind":"app","pid":78,"start":134000000000000001}', '{"kind":"evil","pid":5,"start":"1234567890123"}', '{"kind":"app","pid":6,"start":"12; calc"}'].join("\n");
        expect(parseLedger(text)).toEqual([{ kind: "host", pid: 12, start: "133999999999999999" }, { kind: "app", pid: 77, start: "134000000000000001" }]);
    });
});

describe("the spec schema stays compatible", () => {
    it("a web spec is unchanged by the new optional field", () => {
        const web = TestSpecSchema.parse({ testId: "WEB-001", title: "Home page", kind: "web", steps: [{ action: "navigate", url: "/" }] });
        expect(web.desktop).toBeUndefined();
    });
});
