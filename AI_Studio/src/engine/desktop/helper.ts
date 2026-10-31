/**
 * The Node side of Windows desktop tests, as plain JavaScript text.
 *
 * One source of truth, like the evidence and TOTP helpers: the Windows generator pastes `DESKTOP_HELPER_SOURCE` verbatim into
 * every desktop script (so a downloaded script is self-contained), and `loadDesktopRuntime()` compiles the very same text for
 * the platform (the pre-flight allow-list check) and for tests, with the Node modules it needs handed in, so tests can run the
 * logic against a fake PowerShell on any operating system.
 *
 * What the helper does, per test:
 *   1. decides whether this computer may start the application (hard deny-list first, then the allow-list, on the RESOLVED
 *      full path) and refuses otherwise;
 *   2. writes the PowerShell host (./host-script.ts) to a private temp folder and starts ONE `powershell.exe -NoProfile
 *      -NonInteractive -STA` that reads JSON lines on stdin and answers JSON lines on stdout (ASCII only);
 *   3. translates steps into those requests, waiting and retrying for a few seconds like Playwright does;
 *   4. on a failed step, adds a compact tree of the window's elements to the error; after a failed test, attaches a picture
 *      of the application's window only;
 *   5. always closes the application and the host at the end; the host also exits (and closes the application) when its input
 *      goes away, and records the processes it starts in a ledger file so the caller can check none is left.
 *
 * No value from a spec is ever composed into a command line or into PowerShell text: the program is started by the host with
 * `Process.Start` (no shell) and every value travels as JSON data.
 *
 * Free variables the text expects: fs, path, os, spawn, process, Buffer. Optional: evidenceText / evidenceSecrets (the evidence
 * helper's masking), used on anything read from the application. Keep this source free of backticks and of "${".
 */
import { DESKTOP_CONTROL_TYPES, DESKTOP_DENIED_PROGRAMS } from "./target.js";
import { UIA_HOST_SCRIPT } from "./host-script.js";

/** Prefix of an error the helper throws when this computer will not start the application (an infrastructure answer, not a test result). */
export const DESKTOP_REFUSED_PREFIX = "DESKTOP_REFUSED:";

/** Escape what JSON leaves raw but a JavaScript source file must not carry (line separators). */
export const jsLit = (v: unknown): string => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export const DESKTOP_HELPER_SOURCE = String.raw`const DESKTOP_REFUSED = ${jsLit(DESKTOP_REFUSED_PREFIX)};
const DESKTOP_DENIED = ${jsLit(DESKTOP_DENIED_PROGRAMS)};
const DESKTOP_CONTROLS = ${jsLit(DESKTOP_CONTROL_TYPES)};
const DESKTOP_HOST_SCRIPT = ${jsLit(UIA_HOST_SCRIPT)};
const DESKTOP_EXPECT_MS = 8000;
const DESKTOP_ACTION_MS = 10000;
const DESKTOP_CALL_MS = 30000;
const DESKTOP_TREE_CHARS = 1400;
const DESKTOP_RETRY_CODES = ["notfound", "disabled", "offscreen", "stale", "error", "noitem"];

function desktopSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function desktopClip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "..." : s; }
/** Anything read from the application is masked (this run's credentials, token shapes) and shortened before it reaches an error or a log. */
function desktopSafe(s, n) {
    const raw = String(s == null ? "" : s);
    let masked = raw;
    try { if (typeof evidenceText === "function") masked = evidenceText(raw, typeof evidenceSecrets === "function" ? evidenceSecrets() : [], n); } catch (e) { masked = raw; }
    return desktopClip(masked, n);
}

// ── which program may be started ────────────────────────────────────────────

function desktopProgramName(app) {
    const base = String(app).split(/[\\/]/).pop() || "";
    return base.replace(/\.exe$/i, "").toLowerCase();
}
function desktopIsDenied(app) { return DESKTOP_DENIED.indexOf(desktopProgramName(app)) !== -1; }
function desktopKey(p) { return path.win32.normalize(String(p)).replace(/[\\/]+$/, "").toLowerCase(); }

function desktopParseList(raw) {
    return String(raw == null ? "" : raw).split(";").map((x) => x.trim()).filter((x) => x.length > 0);
}

function desktopRealDeps() {
    const env = process.env;
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || "C:\\Windows";
    const dirs = String(env.PATH || env.Path || "").split(";").map((d) => d.trim()).filter((d) => /^[A-Za-z]:[\\/]/.test(d));
    dirs.push(path.win32.join(root, "System32"), root);
    return {
        dirs: dirs,
        isFile: (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } },
        real: (p) => { try { return fs.realpathSync.native(p); } catch (e) { return p; } },
    };
}

/** { full } (the file this name or path really is) or { candidate } (where it would be, but it is not there). */
function desktopResolve(app, deps) {
    const d = deps || desktopRealDeps();
    let name = String(app);
    if (!/\.exe$/i.test(name)) name = name + ".exe";
    if (/^[A-Za-z]:[\\/]/.test(name)) {
        const candidate = path.win32.resolve(name);
        return d.isFile(candidate) ? { full: d.real(candidate), candidate: candidate } : { candidate: candidate };
    }
    for (const dir of d.dirs) {
        const candidate = path.win32.join(dir, name);
        if (d.isFile(candidate)) return { full: d.real(candidate), candidate: candidate };
    }
    return { candidate: name };
}

/**
 * May this computer start the application? Hard deny-list first (by name, and again by the file the name really is, so a
 * renamed copy or a link to a shell does not pass), then the allow-list on the resolved full path.
 * Returns { ok: true, full } or { ok: false, code: "denied" | "notallowed" | "notfound", app }.
 */
function desktopCheckApp(app, allowList, deps) {
    const shown = desktopClip(String(app).replace(/[\u0000-\u001f]/g, " "), 80);
    if (desktopIsDenied(app)) return { ok: false, code: "denied", app: shown };
    const res = desktopResolve(app, deps);
    if (res.full && desktopIsDenied(res.full)) return { ok: false, code: "denied", app: shown };
    const allowed = new Set();
    for (const entry of allowList || []) {
        if (desktopIsDenied(entry)) continue;
        const r = desktopResolve(entry, deps);
        if (r.full && desktopIsDenied(r.full)) continue;
        allowed.add(desktopKey(r.full || r.candidate));
    }
    if (res.full) return allowed.has(desktopKey(res.full)) ? { ok: true, full: res.full } : { ok: false, code: "notallowed", app: shown };
    return allowed.has(desktopKey(res.candidate)) ? { ok: false, code: "notfound", app: shown } : { ok: false, code: "notallowed", app: shown };
}

/** The plain sentence for a refusal. "via" says where the allow-list is kept: "agent" (--allow-app) or "host" (DESKTOP_ALLOWED_APPS). */
function desktopRefusalText(check, via) {
    if (check.code === "denied") return check.app + " can't be started by a test: command shells, script hosts and similar programs are never allowed, even if they are on the allow-list.";
    if (check.code === "notfound") return "The application " + check.app + " is allowed on this computer but was not found. Check the path, then run again.";
    return "This computer isn't set up to start " + check.app + ". " + (via === "host" ? "Add it to DESKTOP_ALLOWED_APPS, then run again." : "Add it with --allow-app, then run again.");
}

function desktopRefused(text) {
    const e = new Error(DESKTOP_REFUSED + " " + text);
    e.desktopRefused = true;
    return e;
}

// ── locators ────────────────────────────────────────────────────────────────

function desktopControlType(role) {
    if (!role) return undefined;
    const want = String(role).toLowerCase();
    return DESKTOP_CONTROLS.find((c) => c.toLowerCase() === want);
}

/** The spec's locator (Playwright-style) as the host understands it. testId = automation id; label/text = name; role = control type. */
function desktopLocator(l) {
    const out = {};
    const value = l.value == null ? undefined : String(l.value);
    if (l.by === "testId") out.automationId = value;
    else if (l.by === "label" || l.by === "text") { out.name = value; out.nameMatch = l.exact ? "exact" : "contains"; }
    else if (l.by === "role") { if (value !== undefined && value !== "") { out.name = value; out.nameMatch = l.exact ? "exact" : "contains"; } }
    else throw new Error("Desktop tests can't locate elements by " + l.by + ". Use testId, label, text or role.");
    const type = desktopControlType(l.by === "role" ? l.role : l.role);
    if (l.by === "role" && !type) throw new Error('"' + l.role + '" is not a control type.');
    if (l.role && !type) throw new Error('"' + l.role + '" is not a control type.');
    if (type) out.controlType = type;
    if (l.nth !== undefined) out.nth = l.nth;
    return out;
}

function desktopDescribeLocator(l) {
    const parts = [];
    if (l.by === "testId") parts.push("with automation id " + JSON.stringify(desktopClip(l.value, 60)));
    else if (l.value !== undefined && l.value !== "") parts.push("named " + JSON.stringify(desktopClip(l.value, 60)));
    const type = desktopControlType(l.role);
    return "the " + (type ? type.toLowerCase() : "element") + (parts.length ? " " + parts.join(" ") : "") + (l.nth !== undefined ? " (number " + (l.nth + 1) + ")" : "");
}

function desktopTreeText(nodes, more) {
    const lines = [];
    let used = 0;
    let shown = 0;
    for (const n of nodes) {
        const line = "  ".repeat(Math.max(0, n.d)) + n.t + (n.i ? " #" + desktopSafe(n.i, 40) : "") + (n.n ? " " + JSON.stringify(desktopSafe(n.n, 40)) : "");
        if (used + line.length + 1 > DESKTOP_TREE_CHARS) break;
        lines.push(line);
        used += line.length + 1;
        shown++;
    }
    const left = nodes.length - shown + (more || 0);
    if (left > 0) lines.push("... and " + left + " more");
    return lines.join("\n");
}

// ── the PowerShell host ─────────────────────────────────────────────────────

function desktopAscii(json) { return json.replace(/[\u007f-\uffff]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4)); }

function desktopHostEnv(extra) {
    const keep = ["SystemRoot", "windir", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "COMPUTERNAME", "USERNAME", "USERDOMAIN", "SESSIONNAME", "HOMEDRIVE", "HOMEPATH", "SystemDrive", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
    const out = {};
    for (const k of Object.keys(process.env)) if (keep.some((x) => x.toLowerCase() === k.toLowerCase())) out[k] = process.env[k];
    return Object.assign(out, extra);
}

function desktopPowerShellPath() {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || "C:\\Windows";
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * One test's connection to its application. Create it with the target and the policy, then call launch(), the step methods,
 * and finish(testInfo) (or end()) at the end. policy = { allow: [full paths or names], dir: folder for the ledger } or null.
 */
function desktopSession(target, policy, hooks) {
    const h = hooks || {};
    const via = policy && policy.via ? policy.via : (policy ? "agent" : "host");
    const allow = policy && Array.isArray(policy.allow) ? policy.allow : desktopParseList(process.env.DESKTOP_ALLOWED_APPS);
    const keepDir = Boolean(policy && policy.dir);
    const dir = policy && policy.dir ? policy.dir : path.join(os.tmpdir(), "aitp-uia-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
    const s = { child: null, exited: false, exitText: "", buf: "", err: "", seq: 0, pending: new Map(), ready: null, launched: false, ended: false, hostFile: "", ledger: "" };

    function onData(chunk) {
        s.buf += chunk.toString("utf8");
        let at;
        while ((at = s.buf.indexOf("\n")) !== -1) {
            const line = s.buf.slice(0, at).trim();
            s.buf = s.buf.slice(at + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { s.err = (s.err + line + "\n").slice(-600); continue; }
            if (msg.ready !== undefined && s.ready) { const r = s.ready; s.ready = null; r(msg); continue; }
            const p = s.pending.get(msg.id);
            if (p) { s.pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); }
        }
    }

    function killHost() {
        const child = s.child;
        if (!child || !child.pid) return;
        try {
            // taskkill /T also removes the application and anything it started.
            const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
            spawn(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => { try { child.kill(); } catch (e) { /* gone */ } });
        } catch (e) { try { child.kill(); } catch (e2) { /* gone */ } }
    }

    function startHost() {
        fs.mkdirSync(dir, { recursive: true });
        const id = Math.random().toString(36).slice(2, 8);
        s.hostFile = path.join(dir, "host-" + id + ".ps1");
        s.ledger = path.join(dir, "ledger-" + id + ".jsonl");
        fs.writeFileSync(s.hostFile, DESKTOP_HOST_SCRIPT, "utf8");
        const command = "& ([scriptblock]::Create([System.IO.File]::ReadAllText($env:AITP_UIA_HOST)))";
        const child = spawn(desktopPowerShellPath(), ["-NoProfile", "-NonInteractive", "-STA", "-Command", command], {
            env: desktopHostEnv({ AITP_UIA_HOST: s.hostFile, AITP_UIA_LEDGER: s.ledger }),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        s.child = child;
        child.stdout.on("data", onData);
        child.stderr.on("data", (c) => { s.err = (s.err + c.toString("utf8")).slice(-600); });
        child.stdin.on("error", () => { /* the host is gone: the pending calls say so */ });
        child.on("error", (e) => { s.exited = true; s.exitText = String(e && e.message); failPending(); });
        child.on("exit", (code) => { s.exited = true; s.exitText = "exit code " + code; failPending(); });
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { s.ready = null; killHost(); reject(new Error("The Windows UI Automation helper did not start within 30 seconds.")); }, 30000);
            s.ready = (msg) => { clearTimeout(timer); resolve(msg); };
            child.on("exit", () => { clearTimeout(timer); if (s.ready) { s.ready = null; reject(new Error("The Windows UI Automation helper stopped while starting" + (s.err ? ": " + desktopClip(s.err.replace(/\s+/g, " "), 200) : "."))); } });
        });
    }

    function failPending() {
        for (const [, p] of s.pending) { clearTimeout(p.timer); p.resolve({ ok: false, code: "gone", error: "The Windows UI Automation helper stopped" + (s.exitText ? " (" + s.exitText + ")" : "") + "." }); }
        s.pending.clear();
    }

    function call(cmd, payload, timeoutMs) {
        if (!s.child || s.exited) return Promise.resolve({ ok: false, code: "gone", error: "The Windows UI Automation helper is not running." });
        const id = ++s.seq;
        const body = desktopAscii(JSON.stringify(Object.assign({ id: id, cmd: cmd }, payload || {})));
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                s.pending.delete(id);
                killHost();
                resolve({ ok: false, code: "gone", error: "The Windows UI Automation helper stopped responding (" + cmd + ")." });
            }, timeoutMs || DESKTOP_CALL_MS);
            s.pending.set(id, { resolve: resolve, timer: timer });
            try { s.child.stdin.write(body + "\n"); } catch (e) { s.pending.delete(id); clearTimeout(timer); resolve({ ok: false, code: "gone", error: "The Windows UI Automation helper is not running." }); }
        });
    }

    /** Throw an error that tells the person what can be located: the message plus a compact tree of the application's elements. */
    async function failWith(message) {
        let tree = "";
        try {
            const r = s.launched && !s.exited ? await call("tree", {}, 15000) : null;
            if (r && r.ok) tree = r.nodes && r.nodes.length ? desktopTreeText(r.nodes, r.more) : "(the application has no open windows)";
        } catch (e) { /* the message alone is still useful */ }
        const text = desktopSafe(message, 600) + (tree ? "\nWhat the window contains (type #automation-id \"name\"):\n" + tree : "");
        throw new Error(text);
    }

    const api = {
        session: s,
        call: call,

        /** Start the application. Refuses, before anything is started, when this computer may not start it. */
        async launch() {
            if (s.launched) throw new Error("The application was already started in this test.");
            if (process.platform !== "win32") throw desktopRefused("Windows desktop tests only run on Windows.");
            const check = desktopCheckApp(target.app, allow);
            if (!check.ok) throw desktopRefused(desktopRefusalText(check, via));
            const ready = await startHost();
            if (ready.ready === false) throw desktopRefused(ready.error || "Windows UI Automation is not available on this computer.");
            if (ready.elevated) { await api.end(); throw desktopRefused("The tests were started from an elevated (administrator) session. Desktop tests do not run elevated: start the platform or the agent as a normal user."); }
            if (ready.interactive === false) { await api.end(); throw desktopRefused("This session has no interactive desktop. Desktop tests need a signed-in user session (not a Windows service), and the screen must not be locked."); }
            const timeout = target.startTimeoutMs || 15000;
            const r = await call("launch", { path: check.full, args: target.args || [], windowTitle: target.windowTitle, timeoutMs: timeout }, timeout + 15000);
            if (!r.ok) {
                if (r.code === "refused") { await api.end(); throw desktopRefused(desktopSafe(r.error, 300)); }
                s.launched = true;
                return failWith("The application could not be started: " + (r.error || "unknown problem"));
            }
            s.launched = true;
            return r;
        },

        /** Run a UI action with retries while the element is missing, disabled or off screen. */
        async act(cmd, loc, extra, what) {
            const deadline = Date.now() + DESKTOP_ACTION_MS;
            const hostLoc = desktopLocator(loc);
            let last;
            for (;;) {
                last = await call(cmd, Object.assign({ locator: hostLoc }, extra || {}), DESKTOP_CALL_MS);
                if (last.ok) return last;
                if (DESKTOP_RETRY_CODES.indexOf(last.code) === -1 || Date.now() > deadline) break;
                await desktopSleep(150);
            }
            const who = desktopDescribeLocator(loc);
            const err = String(last.error || "failed").replace(/[.]+$/, "");
            const why = last.code === "notfound" ? "nothing matched " + who : last.code === "ambiguous" ? last.count + " elements matched " + who + " (add a control type or a position, nth, to pick one)" : last.code === "disabled" ? who + " is disabled" : last.code === "offscreen" ? who + " is not visible" : who + ": " + err;
            return failWith(what + " failed: " + why + ".");
        },

        async click(loc) { return api.act("click", loc, {}, "Click"); },
        async fill(loc, text) { return api.act("type", loc, { text: String(text) }, "Enter text"); },
        async select(loc, value) { return api.act("select", loc, { value: String(value) }, "Choose"); },
        async check(loc, checked) { return api.act("toggle", loc, { checked: Boolean(checked) }, checked ? "Check" : "Uncheck"); },
        async wait(ms) { await desktopSleep(Math.max(0, Math.min(10000, Number(ms) || 0))); },

        /** assert visible | hidden | text | value | enabled | disabled | count. Polls for up to 8 seconds. */
        async expect(check, loc, expected) {
            const deadline = Date.now() + DESKTOP_EXPECT_MS;
            const hostLoc = desktopLocator(loc);
            const who = desktopDescribeLocator(loc);
            let problem = "";
            for (;;) {
                const r = await call("state", { locator: hostLoc }, DESKTOP_CALL_MS);
                if (!r.ok) { problem = r.error || "the application did not answer"; if (r.code === "gone") break; }
                else {
                    const el = r.element;
                    const many = r.count > 1 && loc.nth === undefined && check !== "count";
                    if (check === "count") { if (r.count === Number(expected)) return; problem = "expected " + expected + " matching element(s) but found " + r.count; }
                    else if (many) problem = r.count + " elements match " + who + ". Add a control type or a position (nth) to pick one";
                    else if (check === "hidden") { if (!el || el.offscreen) return; problem = who + " is visible"; }
                    else if (!el) problem = "nothing matched " + who;
                    else if (check === "visible") { if (!el.offscreen) return; problem = who + " exists but is not on screen"; }
                    else if (check === "enabled") { if (el.enabled) return; problem = who + " is disabled"; }
                    else if (check === "disabled") { if (!el.enabled) return; problem = who + " is enabled"; }
                    else if (check === "text" || check === "value") {
                        if (el.isPassword) { problem = "the content of a password field is never read"; break; }
                        const want = String(expected == null ? "" : expected);
                        if (check === "text") {
                            const hay = [el.name, el.value].filter((x) => typeof x === "string");
                            if (hay.some((x) => x.indexOf(want) !== -1)) return;
                            problem = who + " does not contain " + JSON.stringify(desktopClip(want, 80)) + ' (it shows ' + JSON.stringify(desktopSafe(typeof el.value === "string" && el.value !== "" ? el.value : el.name, 120)) + ")";
                        } else {
                            const actual = typeof el.value === "string" ? el.value : el.name;
                            if (actual === want) return;
                            problem = who + " has the value " + JSON.stringify(desktopSafe(actual, 120)) + " but " + JSON.stringify(desktopClip(want, 80)) + " was expected";
                        }
                    }
                }
                if (Date.now() > deadline) break;
                await desktopSleep(150);
            }
            return failWith("Check " + check + " failed: " + String(problem).replace(/[.]+$/, "") + ".");
        },

        /** A picture (PNG bytes) of the application's own window, or null. */
        async screenshot() {
            if (!s.launched || s.exited) return null;
            const r = await call("screenshot", {}, 30000);
            return r.ok && r.png ? Buffer.from(r.png, "base64") : null;
        },

        async closeApp() {
            const r = await call("close", {}, 30000);
            if (!r.ok && r.code !== "gone") return failWith("The application could not be closed: " + (r.error || "unknown problem"));
        },

        /** After a test: attach the picture of a failed test, then close everything. Never throws. */
        async finish(testInfo) {
            try {
                if (testInfo && testInfo.status !== testInfo.expectedStatus) {
                    const png = await api.screenshot();
                    if (png) await testInfo.attach("screenshot", { body: png, contentType: "image/png" });
                }
            } catch (e) { /* a missing picture must not hide the failure */ }
            await api.end();
        },

        /** Close the application and the host. Safe to call twice. */
        async end() {
            if (s.ended) return;
            s.ended = true;
            try {
                if (s.child && !s.exited) {
                    await call("close", {}, 15000);
                    await call("exit", {}, 5000);
                    try { s.child.stdin.end(); } catch (e) { /* closed */ }
                    for (let i = 0; i < 20 && !s.exited; i++) await desktopSleep(100);
                    if (!s.exited) killHost();
                }
            } catch (e) { killHost(); }
            if (!keepDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp folder: the system cleans it */ } }
        },
    };
    return api;
}
`;

/** The helper's functions, compiled for the platform and for tests (the very text a script carries). */
export interface DesktopRuntime {
    desktopParseList(raw: string): string[];
    desktopIsDenied(app: string): boolean;
    desktopResolve(app: string, deps?: DesktopDeps): { full?: string; candidate: string };
    desktopCheckApp(app: string, allow: string[], deps?: DesktopDeps): { ok: true; full: string } | { ok: false; code: "denied" | "notallowed" | "notfound"; app: string };
    desktopRefusalText(check: { code: string; app: string }, via: "agent" | "host"): string;
    desktopLocator(l: { by: string; value?: string; role?: string; exact?: boolean; nth?: number }): Record<string, unknown>;
    desktopTreeText(nodes: Array<{ d: number; t: string; i?: string; n?: string }>, more?: number): string;
    desktopSession(target: unknown, policy: unknown, hooks?: unknown): DesktopSession;
}

export interface DesktopDeps {
    dirs: string[];
    isFile(p: string): boolean;
    real(p: string): string;
}

export interface DesktopSession {
    launch(): Promise<unknown>;
    click(loc: unknown): Promise<unknown>;
    fill(loc: unknown, text: string): Promise<unknown>;
    select(loc: unknown, value: string): Promise<unknown>;
    check(loc: unknown, checked: boolean): Promise<unknown>;
    wait(ms: number): Promise<void>;
    expect(check: string, loc: unknown, expected?: unknown): Promise<void>;
    screenshot(): Promise<Buffer | null>;
    closeApp(): Promise<void>;
    finish(testInfo?: unknown): Promise<void>;
    end(): Promise<void>;
}

/** The modules the helper text expects as free variables. Tests hand in fakes. */
export interface DesktopModules {
    fs: unknown;
    path: unknown;
    os: unknown;
    spawn: unknown;
    process: unknown;
}

export function loadDesktopRuntime(mods: DesktopModules, extraSource = ""): DesktopRuntime {
    return new Function(
        "fs",
        "path",
        "os",
        "spawn",
        "process",
        "Buffer",
        `${extraSource}\n${DESKTOP_HELPER_SOURCE}\nreturn { desktopParseList, desktopIsDenied, desktopResolve, desktopCheckApp, desktopRefusalText, desktopLocator, desktopTreeText, desktopSession };`,
    )(mods.fs, mods.path, mods.os, mods.spawn, mods.process, Buffer) as DesktopRuntime;
}
