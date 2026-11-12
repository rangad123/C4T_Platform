/**
 * The macOS installer ("AI Testing Runner.app"), fast tier: no browser, no platform. Part 1 reads what the build writes (the app tree,
 * Info.plist, modes, hashes, manifest) and scans the shell files for syntax errors and for anything a Mac's /bin/sh (bash 3.2, POSIX
 * mode) or dash cannot run. Part 2 RUNS runner-setup.sh and the launcher under Git Bash (or any POSIX shell) against simulated Macs: the
 * system and processor are announced by test-only variables, `launchctl`, `osascript`, `open` and `xattr` are stubs on the PATH that
 * record what they were asked, nodejs.org is a local HTTP server that serves a real `.tar.gz` holding a Node.js shim (which runs this
 * computer's real Node.js), and npm / the browser download are stubs too. Nothing is installed, no external site is contacted, no
 * process is touched but the ones started here.
 *
 * What this cannot prove (never run on a Mac): Terminal opening the .command file, the real osascript dialogs, launchctl loading the
 * agent, Gatekeeper, App Translocation, Rosetta detection with sysctl, the real nodejs.org download, hdiutil, signing.
 *
 * Ports: 6611 is the stand-in for nodejs.org. (6610 is the platform in tests/installer-mac.test.ts.)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { APP_NAME, buildInstallerMac } from "../scripts/build-installer-mac.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
// Starting a shell, a download stand-in and a runner takes seconds each on Windows; a slow machine must not fail a test for that.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
const DIST_PORT = 6611;
const DIST = `http://127.0.0.1:${DIST_PORT}`;
const fwd = (p: string) => p.replaceAll("\\", "/");
/** The form Git Bash uses for a path: /c/Users/x (C:/Users/x would be read as a relative path). */
const msys = (p: string) => (process.platform === "win32" ? fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let tmp: string;
let built: { appDir: string; entries: Array<{ path: string; mode: number; sha256: string }>; version: string };
let counter = 0;
const fresh = (...parts: string[]) => {
    const dir = path.join(tmp, `d${++counter}`, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

function findShell(name: string): string | undefined {
    const dirs = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin"] : ["/bin", "/usr/bin"];
    for (const d of dirs) {
        const p = path.join(d, process.platform === "win32" ? `${name}.exe` : name);
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}
const BASH = [process.env.KIT_TEST_BASH, findShell("bash")].find((p) => p && fs.existsSync(p));
const DASH = findShell("dash");
/** Standard tools only (sh, tar, awk, curl, cmp, mktemp, sha256sum ...): no node and no shasum, so the sha256sum fallback is the one in use. */
const TOOLS = BASH ? (process.platform === "win32" ? [msys(path.dirname(BASH)), msys(path.join(path.dirname(BASH), "..", "..", "mingw64", "bin"))] : ["/usr/bin", "/bin"]) : [];
const REAL_NODE = fwd(process.execPath);

const read = (file: string) => fs.readFileSync(file, "utf8");
const code = (text: string) =>
    text
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-inst-mac-"));
    built = buildInstallerMac({ outDir: path.join(tmp, "built") });
});
afterAll(() => {
    try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
        /* the operating system cleans the temp folder later */
    }
});

// ── Part 1: what the build writes ───────────────────────────────────────────

/** A small well-formedness check for the property lists: tags nest and close, text has no stray < or &. */
function wellFormed(xml: string): string | undefined {
    const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "").replace(/<!--[\s\S]*?-->/g, "");
    const stack: string[] = [];
    let pos = 0;
    const re = /<(\/?)([A-Za-z][A-Za-z0-9]*)([^>]*?)(\/?)>/g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
        const text = body.slice(pos, m.index);
        if (/[<]/.test(text)) return `stray < near ${text.slice(0, 30)}`;
        if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return `unescaped & in ${text.slice(0, 40)}`;
        pos = m.index + m[0].length;
        if (m[4]) continue;
        if (m[1]) {
            if (stack.pop() !== m[2]) return `closing </${m[2]}> does not match`;
        } else stack.push(m[2]!);
    }
    if (stack.length) return `unclosed <${stack[stack.length - 1]}>`;
    if (/[<]/.test(body.slice(pos))) return "stray < at the end";
    return undefined;
}
const plistValues = (xml: string) => [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));

describe("the build: the app tree, Info.plist, modes, hashes and the manifest", () => {
    const entryPaths = () => built.entries.map((e) => e.path);

    it("writes exactly the four files of the app, under 'AI Testing Runner.app', and a manifest in the contract's shape", () => {
        expect(entryPaths()).toEqual([
            `${APP_NAME}/Contents/Info.plist`,
            `${APP_NAME}/Contents/MacOS/AITestingRunner`,
            `${APP_NAME}/Contents/Resources/README.txt`,
            `${APP_NAME}/Contents/Resources/runner-setup.sh`,
        ]);
        expect(APP_NAME).toBe("AI Testing Runner.app");
        const manifest = JSON.parse(read(path.join(tmp, "built", "manifest-part.json")));
        expect(manifest.version).toBe(1);
        expect(manifest.entries).toEqual(built.entries);
        for (const e of manifest.entries) {
            expect(Object.keys(e).sort()).toEqual(["mode", "path", "sha256"]);
            expect(e.path.startsWith("/")).toBe(false);
            expect(e.path).not.toContain("\\");
            expect(Number.isInteger(e.mode)).toBe(true);
        }
    });

    it("gives the launcher and the setup script mode 0755 (493) and the rest 0644 (420)", () => {
        const mode = (suffix: string) => built.entries.find((e) => e.path.endsWith(suffix))!.mode;
        expect(mode("Contents/MacOS/AITestingRunner")).toBe(0o755);
        expect(mode("Contents/MacOS/AITestingRunner")).toBe(493);
        expect(mode("Contents/Resources/runner-setup.sh")).toBe(493);
        expect(mode("Contents/Info.plist")).toBe(420);
        expect(mode("Contents/Resources/README.txt")).toBe(420);
        if (process.platform !== "win32") {
            expect(fs.statSync(path.join(built.appDir, "Contents/MacOS/AITestingRunner")).mode & 0o777).toBe(0o755);
        }
    });

    it("records the sha256 of the bytes that were written", () => {
        for (const e of built.entries) {
            const bytes = fs.readFileSync(path.join(tmp, "built", ...e.path.split("/")));
            expect(crypto.createHash("sha256").update(bytes).digest("hex"), e.path).toBe(e.sha256);
        }
    });

    it("has a well-formed Info.plist with the bundle id, name, executable, minimum system and the package version", () => {
        const plist = read(path.join(built.appDir, "Contents", "Info.plist"));
        expect(wellFormed(plist)).toBeUndefined();
        const pairs = new Map([...plist.matchAll(/<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\/>)/g)].map((m) => [m[1]!, m[2] ?? m[3]!]));
        expect(pairs.get("CFBundleIdentifier")).toBe("app.aitesting.runner");
        expect(pairs.get("CFBundleName")).toBe("AI Testing Runner");
        expect(pairs.get("CFBundleExecutable")).toBe("AITestingRunner");
        expect(pairs.get("CFBundlePackageType")).toBe("APPL");
        expect(pairs.get("LSMinimumSystemVersion")).toBe("11.0");
        expect(pairs.get("LSUIElement")).toBe("false");
        expect(pairs.get("CFBundleShortVersionString")).toBe(JSON.parse(read(path.join(REPO, "package.json"))).version);
        expect(plist).not.toContain("@VERSION@");
        // The named executable exists where macOS looks for it.
        expect(fs.existsSync(path.join(built.appDir, "Contents", "MacOS", pairs.get("CFBundleExecutable")!))).toBe(true);
    });

    it("writes LF line ends only, no byte order mark, in every file (a CRLF shell script does not run on a Mac)", () => {
        for (const e of built.entries) {
            const bytes = fs.readFileSync(path.join(tmp, "built", ...e.path.split("/")));
            expect(bytes.includes(13), `${e.path} has a carriage return`).toBe(false);
            expect(bytes[0] === 0xef && bytes[1] === 0xbb, `${e.path} has a byte order mark`).toBe(false);
        }
        for (const f of ["installer/mac/app/Contents/Resources/runner-setup.sh", "installer/mac/app/Contents/MacOS/AITestingRunner", "scripts/make-dmg.sh"]) {
            expect(fs.readFileSync(path.join(REPO, f)).includes(13), `${f} (source) has a carriage return`).toBe(false);
        }
        expect(read(path.join(REPO, "installer/mac/.gitattributes"))).toContain("eol=lf");
    });

    it("holds no secrets and nothing from the machine that built it", () => {
        for (const e of built.entries) {
            const text = read(path.join(tmp, "built", ...e.path.split("/")));
            expect(text, e.path).not.toMatch(/sk-[A-Za-z0-9]{10}|api[_-]?key\s*[=:]|password\s*[=:]|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{12}|ghp_[A-Za-z0-9]{20}/i);
            for (const home of [REPO, fwd(REPO), os.homedir(), fwd(os.homedir())]) expect(text, `${e.path} mentions ${home.slice(0, 6)}...`).not.toContain(home);
            expect(text, e.path).not.toMatch(/runner\.token['"]?\s*[:=]\s*['"][A-Za-z0-9_-]{16,}/);
        }
        // The build reads only the installer's own folder and package.json, never .env or the data folder.
        const script = read(path.join(REPO, "scripts/build-installer-mac.mjs"));
        expect(script).not.toMatch(/\.env\b|["'`]data["'`]|process\.env\./);
    });

    it("leaves other files in the output folder alone and can be built twice with identical output", () => {
        const out = fresh("twice");
        fs.writeFileSync(path.join(out, "keep.txt"), "mine");
        const a = buildInstallerMac({ outDir: out });
        const b = buildInstallerMac({ outDir: out });
        expect(b.entries).toEqual(a.entries);
        expect(read(path.join(out, "keep.txt"))).toBe("mine");
    });
});

// ── Part 1b: syntax and portability of the shell files ──────────────────────

const SHELL_FILES: Array<[string, string]> = [
    ["runner-setup.sh", path.join(REPO, "installer/mac/app/Contents/Resources/runner-setup.sh")],
    ["AITestingRunner (launcher)", path.join(REPO, "installer/mac/app/Contents/MacOS/AITestingRunner")],
    ["make-dmg.sh", path.join(REPO, "scripts/make-dmg.sh")],
];

describe.skipIf(!BASH)("the shell files: syntax and portability", () => {
    it("pass a syntax check under bash, bash in POSIX mode, dash and sh", () => {
        for (const [name, file] of SHELL_FILES) {
            const shells: Array<[string, string[]]> = [[BASH!, ["-n"]], [BASH!, ["--posix", "-n"]]];
            if (DASH) shells.push([DASH, ["-n"]]);
            const sh = findShell("sh");
            if (sh) shells.push([sh, ["-n"]]);
            for (const [shell, args] of shells) {
                const r = spawnSync(shell, [...args, file], { encoding: "utf8", timeout: 20_000 });
                expect(r.status, `${name} under ${path.basename(shell)} ${args.join(" ")}: ${r.stderr}`).toBe(0);
            }
            expect(read(file).startsWith("#!/bin/sh\n"), `${name} starts with #!/bin/sh`).toBe(true);
        }
    });

    it("use no bashism and nothing a Mac's /bin/sh, dash or Git Bash lacks (scanned, with a short allow-list)", () => {
        const banned: Array<[string, RegExp]> = [
            ["[[ ]]", /\[\[(?!:)/],
            ["local", /^\s*local\s/m],
            ["function keyword", /^\s*function\s/m],
            ["array assignment", /\w=\(/],
            ["process substitution", /<\(|>\(/],
            ["pattern substitution", /\$\{[A-Za-z_]+\/\/?/],
            ["$'...' quoting", /\$'/],
            ["echo -e", /\becho\s+-[a-zA-Z]*e/],
            ["source", /^\s*source\s/m],
            ["&> redirect", /&>/],
            ["== inside [ ]", /(^|\s)\[ [^\]]*\s==\s[^\]]*\]/m],
            ["readlink -f", /readlink\s+-f/],
            ["sed -i", /\bsed\s+-i/],
            ["sed -E / -r", /\bsed\s+-[Er]\b/],
            ["timeout command", /(^|[\s;|&(`])timeout\s+[0-9]/m],
            ["mktemp -p", /mktemp\s+-p/],
            ["grep -P", /\bgrep\s+(-\w*P|--perl)/],
            ["date -d", /\bdate\s+-d/],
            ["stat -c", /\bstat\s+-c/],
            ["find -printf", /-printf/],
            ["xargs -r", /\bxargs\s+-r/],
            ["$RANDOM and BASH variables", /\$RANDOM|\$BASH_|\$\{BASH_/],
            ["let", /^\s*let\s/m],
            ["select", /^\s*select\s/m],
            ["declare / typeset", /^\s*(declare|typeset)\s/m],
            ["pushd / popd", /^\s*(pushd|popd)\b/m],
            ["test -a / -o", /\[ [^\]]*\s-[ao]\s[^\]]*\]/],
            ["realpath", /\brealpath\b/],
            ["seq", /(^|[\s;|&(`])seq\s/m],
            ["shuf", /\bshuf\b/],
            ["md5sum", /\bmd5sum\b/],
        ];
        for (const [name, file] of SHELL_FILES) {
            const body = code(read(file));
            for (const [what, re] of banned) expect(re.test(body), `${name} uses ${what}`).toBe(false);
        }
        // sha256sum exists on Linux and Git Bash but not on a Mac: it may only appear after `shasum -a 256`, as the fallback.
        const setup = code(read(SHELL_FILES[0]![1]));
        expect(setup).toContain("shasum -a 256");
        expect(setup.indexOf("shasum -a 256")).toBeLessThan(setup.indexOf("sha256sum"));
        expect(setup).toMatch(/command -v shasum/);
        // ps -o command= is the BSD and Linux form; /proc is only the fallback for Git Bash.
        expect(setup).toContain("ps -p");
    });

    it("never uses sudo, never writes outside the install folder, the LaunchAgents folder and the shared browser cache", () => {
        const body = code(read(SHELL_FILES[0]![1]));
        expect(body).not.toMatch(/\bsudo\b|\bosascript[^\n]*administrator|\bdefaults write|\bspctl\b|\bcsrutil\b|\/etc\/|\/Library\/(?!Caches|LaunchAgents|Application)|chmod -R 777/);
        expect(body).toContain("launchctl bootstrap");
        expect(body).toContain("launchctl load");
        expect(body).toContain("launchctl bootout");
        expect(body).toContain("com.apple.quarantine");
    });
});

// ── Part 2: running them against simulated Macs ─────────────────────────────

/**
 * The part of the shim that runs this computer's real Node.js. Git Bash only: a path argument is handed over in Windows form, because
 * its own conversion trips over an ampersand in a folder name (a Mac has no such step).
 */
const SHIM_RUN = [
    "    *) n=$#; i=0",
    '       if command -v cygpath >/dev/null 2>&1; then while [ $i -lt $n ]; do a=$1; shift; case "$a" in /*) a=$(cygpath -m "$a") ;; esac; set -- "$@" "$a"; i=$((i+1)); done; fi',
    `       exec "${REAL_NODE}" "$@" ;;`,
].join("\n");

/** A "node" that says it is `version` and otherwise runs this computer's Node.js. */
function shim(file: string, version: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n    --version|-v) echo ${version} ;;\n${SHIM_RUN}\nesac\n`, { mode: 0o755 });
    return file;
}

/** A stub program on the PATH: it appends one line with its arguments to $STUB_LOG and then runs `body` (shell). */
function stub(dir: string, name: string, body = "exit 0"): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\n`, { mode: 0o755 });
    return file;
}

const RUNNER_STUB = `console.log("RUNNER-RAN " + process.version + " in " + process.cwd());
console.log('Connected to the platform as "stub"');
process.exit(0);
`;

/** Nothing listens here: the platform check ends at once with "refused" instead of waiting for a name lookup. */
const DEAD_PLATFORM = "http://127.0.0.1:6619";
interface Kit {
    kit: string;
    setup: string;
    app: string;
}
/** An unzipped kit folder (spaces and brackets on purpose) with the app beside the runner files. */
function makeKit(opts: { dependencies?: Record<string, string>; url?: string; name?: string; runner?: string; withFiles?: boolean } = {}): Kit {
    const kit = fresh("Maya Singh", "runner (1)");
    if (opts.withFiles !== false) {
        fs.writeFileSync(path.join(kit, "runner.mjs"), opts.runner ?? RUNNER_STUB);
        fs.writeFileSync(path.join(kit, "task-child.mjs"), "// task child\n");
        fs.writeFileSync(path.join(kit, "record-child.mjs"), "// record child\n");
        fs.writeFileSync(path.join(kit, "package.json"), `${JSON.stringify({ name: "stub-kit", type: "module", dependencies: opts.dependencies ?? { "fake-a": "1.0.0" } })}\n`);
        fs.writeFileSync(path.join(kit, "LICENSES.txt"), "licences\n");
        fs.writeFileSync(path.join(kit, "runner.json"), `${JSON.stringify({ url: opts.url ?? DEAD_PLATFORM, name: opts.name ?? 'Maya\'s "laptop" & co' })}\n`);
        fs.writeFileSync(path.join(kit, "runner.token"), "t0ken-sentinel-4f1c9a\n", { mode: 0o600 });
    }
    const app = path.join(kit, APP_NAME);
    fs.cpSync(built.appDir, app, { recursive: true });
    return { kit, app, setup: path.join(app, "Contents", "Resources", "runner-setup.sh") };
}

/** Round 50: the download as the platform now builds it, the app alone with the kit inside it (Contents/Resources/kit) and nothing beside it. */
function makeAppKit(opts: { code: string; runner?: string }): Kit {
    const beside = makeKit({ withFiles: true, ...(opts.runner ? { runner: opts.runner } : {}) });
    const kit = path.join(beside.app, "Contents", "Resources", "kit");
    fs.mkdirSync(kit);
    for (const n of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt", "runner.json"]) fs.renameSync(path.join(beside.kit, n), path.join(kit, n));
    fs.rmSync(path.join(beside.kit, "runner.token"));
    fs.writeFileSync(path.join(kit, "runner.enroll"), `${opts.code}\n`, { mode: 0o600 });
    const alone = path.join(fresh("Downloads"), APP_NAME);
    fs.renameSync(beside.app, alone);
    return { kit, app: alone, setup: path.join(alone, "Contents", "Resources", "runner-setup.sh") };
}

interface Ran {
    status: number | null;
    out: string;
}
interface RunOptions {
    stubDir?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
}
const BASE_ENV = (home: string, stubDir: string | undefined, log: string): NodeJS.ProcessEnv => ({
    HOME: msys(home),
    PATH: [...(stubDir ? [msys(stubDir)] : []), ...TOOLS].join(":"),
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    TMPDIR: fwd(os.tmpdir()),
    SHELL: "/nonexistent/shell",
    STUB_LOG: fwd(log),
    AITP_INSTALLER_UNAME_S: "Darwin",
    AITP_INSTALLER_UNAME_M: "arm64",
    AITP_INSTALLER_PROC_TRANSLATED: "0",
    AITP_INSTALLER_NO_UI: "1",
    AITP_INSTALLER_NO_PAUSE: "1",
    AITP_KIT_SKIP_SHELL_SEARCH: "1",
});
function mkEnv(home: string, o: RunOptions, log: string): NodeJS.ProcessEnv {
    const env = BASE_ENV(home, o.stubDir, log);
    for (const [k, v] of Object.entries(o.env ?? {})) {
        if (v === undefined) delete env[k];
        else env[k] = v;
    }
    return env;
}

/** Run the setup script (or any script) with the simulated environment. */
function runScript(script: string, args: string[], home: string, o: RunOptions = {}, log = o.stubDir ? path.join(path.dirname(o.stubDir), "stub.log") : path.join(tmp, "stub.log")): Ran {
    const r = spawnSync(BASH!, [msys(script), ...args], { encoding: "utf8", timeout: o.timeout ?? 90_000, stdio: ["ignore", "pipe", "pipe"], env: mkEnv(home, o, log), cwd: tmp });
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\r/g, "") };
}

interface World {
    home: string;
    install: string;
    log: string;
    stubDir: string;
}
/** A fresh home folder, install folder (with a space, brackets and an ampersand) and stub folder. */
function world(): World {
    const root = fresh("world");
    const home = path.join(root, "Users", "Maya Singh");
    fs.mkdirSync(home, { recursive: true });
    const stubDir = path.join(root, "stubs");
    fs.mkdirSync(stubDir, { recursive: true });
    return { home, install: path.join(root, "My Mac [work] (x)", "Runner (1)"), log: path.join(root, "stub.log"), stubDir };
}
const stubLog = (w: World) => (fs.existsSync(w.log) ? read(w.log).replace(/\r/g, "") : "");
const sameFile = (out: string, p: string) => out.includes(msys(p));
const SETUP_FLAGS = (w: World) => ["--install-dir", msys(w.install), "--silent", "--no-start"];

describe.skipIf(!BASH)("runner-setup.sh --check: says what would be downloaded and changes nothing", () => {
    it("with a Node.js 24+ on the search path: found, skipped; exit 10 because the test tools would be downloaded (the browser is left to the runner); nothing is written", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("nvm", "v26.1.0", "bin");
        shim(path.join(nodeDir, "node"), "v26.1.0");
        const r = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir) } });
        expect(r.status, r.out).toBe(10);
        expect(r.out).toMatch(new RegExp(`\\[1/5\\] Node\\.js 24 or newer \\.\\.\\. found \\(v26\\.1\\.0 at \\S*${escapeRe(msys(nodeDir).split("/").slice(-4).join("/"))}\\), skipped`));
        expect(r.out).toContain("[2/5] Runner files ... would copy 7 files from the unzipped kit (no download)");
        expect(r.out).toMatch(/\[3\/5\] Test tools \.\.\. not complete, would install with npm/);
        expect(r.out).toContain("[4/5] Browser for web tests ... left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)");
        expect(r.out).toMatch(/\[5\/5\] Platform connection \.\.\. not checked here \(http:\/\/127\.0\.0\.1:6619\)/);
        expect(r.out).toContain("Nothing was changed.");
        expect(fs.existsSync(w.install), "check created the install folder").toBe(false);
        expect(fs.existsSync(path.join(w.home, "Library"))).toBe(false);
    });

    it("exit 0 when every step is already done: the runner files copied, the packages at the pinned versions (the browser is the runner's business)", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v25.2.0");
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), PLAYWRIGHT_BROWSERS_PATH: msys(fresh("browsers")) };
        // Do the setup once with the stubs standing in for npm and the browser download, then ask again.
        installStubTools(w, nodeDir, env.PLAYWRIGHT_BROWSERS_PATH);
        const first = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(first.status, first.out).toBe(0);
        const check = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env });
        expect(check.status, check.out).toBe(0);
        expect(check.out).toContain("[2/5] Runner files ... found, up to date, skipped");
        expect(check.out).toContain("[3/5] Test tools ... found (all packages are installed at the pinned versions), skipped");
        expect(check.out).toContain("[4/5] Browser for web tests ... left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)");
        expect(check.out).toContain("Check finished: nothing needs to be downloaded.");
    });

    it("a Node.js that is too old is reported as too old, with its version and place, and counts as a download", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("old", "bin");
        shim(path.join(nodeDir, "node"), "v20.11.0");
        const r = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir) } });
        expect(r.status, r.out).toBe(10);
        expect(r.out).toMatch(/\[1\/5\] Node\.js 24 or newer \.\.\. found v20\.11\.0 at \S+\/node, too old for the runner/);
        expect(r.out).toMatch(/\[1\/5\] Node\.js 24 or newer \.\.\. not found, would download the Apple silicon build from nodejs\.org/);
    });

    it("exit 1 with a plain message when the runner files are not beside the app and nothing is installed", () => {
        const w = world();
        const { setup } = makeKit({ withFiles: false });
        const r = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir });
        expect(r.status).toBe(1);
        expect(r.out).toContain("I could not find the runner files (runner.mjs, runner.json and runner.enroll) next to this app. Unzip the whole runner kit you downloaded from the platform and open the app from inside the unzipped folder.");
    });

    it("rejects an option it does not know and an option that needs a value, in plain words", () => {
        const w = world();
        const { setup } = makeKit();
        const a = runScript(setup, ["--frobnicate"], w.home, { stubDir: w.stubDir });
        expect(a.status).toBe(1);
        expect(a.out).toContain("Unknown option: --frobnicate");
        const b = runScript(setup, ["--install-dir"], w.home, { stubDir: w.stubDir });
        expect(b.status).toBe(1);
        expect(b.out).toContain("The option --install-dir needs a value.");
        const h = runScript(setup, ["--help"], w.home, { stubDir: w.stubDir });
        expect(h.status).toBe(0);
        expect(h.out).toContain("--check");
        expect(h.out).toContain("--uninstall");
    });
});

describe.skipIf(!BASH)("which Mac it is: Apple silicon, Intel, Rosetta, and the systems it refuses", () => {
    const table: Array<[string, Record<string, string>, RegExp]> = [
        ["Darwin arm64", { AITP_INSTALLER_UNAME_M: "arm64" }, /This Mac: macOS, Apple silicon/],
        ["Darwin x86_64", { AITP_INSTALLER_UNAME_M: "x86_64" }, /This Mac: macOS, Intel/],
        ["Darwin x86_64 under Rosetta", { AITP_INSTALLER_UNAME_M: "x86_64", AITP_INSTALLER_PROC_TRANSLATED: "1" }, /This Mac: macOS, Apple silicon, seen through Rosetta/],
    ];
    for (const [label, env, expected] of table) {
        it(`${label}: ${expected.source.slice(0, 40)}...`, () => {
            const w = world();
            const { setup } = makeKit();
            const r = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { ...env, AITP_INSTALLER_NODE_SEARCH_ONLY: "" } });
            expect(r.status, r.out).toBe(10);
            expect(r.out).toMatch(expected);
        });
    }

    it("refuses Linux with a plain message that points at start-runner.sh, and writes nothing", () => {
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_UNAME_S: "Linux", AITP_INSTALLER_UNAME_M: "x86_64" } });
        expect(r.status).toBe(1);
        expect(r.out).toContain('This installer is for macOS, and this computer reports "Linux". On Linux, use start-runner.sh from the runner kit.');
        expect(fs.existsSync(w.install)).toBe(false);
    });

    it("refuses a processor it does not know, and refuses when the system is not Darwin without being told (this test machine)", () => {
        const w = world();
        const { setup } = makeKit();
        const odd = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_UNAME_M: "riscv64" } });
        expect(odd.status).toBe(1);
        expect(odd.out).toContain('does not know the processor "riscv64"');
        if (process.platform !== "darwin") {
            const real = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_UNAME_S: undefined, AITP_INSTALLER_UNAME_M: undefined } });
            expect(real.status).toBe(1);
            expect(real.out).toContain("This installer is for macOS");
        }
    });
});

// ── nodejs.org stand-in ──────────────────────────────────────────────────────
// It runs in its OWN process: the setup script is started with spawnSync, which blocks this process, and a server in here would never answer.

type DistMode = "ok" | "badsum" | "truncate" | "noindex" | "nosums";
const LTS_VERSION = "24.12.1";
let distChild: ChildProcess | undefined;

/** A real .tar.gz holding node-v<version>-darwin-<arch>/bin/node (a shim that runs this computer's Node.js) and bin/npm. */
function writeTarball(root: string, version: string, arch: string): void {
    const top = `node-v${version}-darwin-${arch}`;
    const src = fresh("tarball-src");
    shim(path.join(src, top, "bin", "node"), `v${version}`);
    fs.writeFileSync(path.join(src, top, "bin", "npm"), '#!/bin/sh\necho "private-npm $*" >> "$STUB_LOG"\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, top, "LICENSE"), "fake node\n");
    const out = path.join(src, `${top}.tar.gz`);
    const r = spawnSync(BASH!, ["-c", 'cd "$1" && tar -czf "$2" "$3"', "sh", msys(src), msys(out), top], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
    fs.mkdirSync(path.join(root, `v${version}`), { recursive: true });
    fs.copyFileSync(out, path.join(root, `v${version}`, `${top}.tar.gz`));
}

const DIST_SERVER = String.raw`
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [root, port, lts] = process.argv.slice(2);
let mode = "ok";
let requests = [];
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/__mode/")) { mode = url.slice(8); requests = []; return void res.writeHead(200).end("ok"); }
    if (url === "/__requests") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
    requests.push(req.method + " " + url);
    if (url === "/index.json") {
        if (mode === "noindex") return void res.writeHead(404).end("no");
        return void res.writeHead(200).end('[{"version":"v25.2.0","date":"2026-01-01","files":["osx-arm64-tar"],"npm":"11.7.0","lts":false,"security":false},{"version":"v' + lts + '","date":"2025-12-01","files":["osx-arm64-tar","osx-x64-tar"],"npm":"11.6.1","lts":"Krypton","security":false},{"version":"v22.20.0","date":"2025-09-01","files":["osx-arm64-tar"],"npm":"10.9.3","lts":"Jod","security":false}]');
    }
    const sums = /^\/v(\d+\.\d+\.\d+)\/SHASUMS256\.txt$/.exec(url);
    if (sums) {
        if (mode === "nosums") return void res.writeHead(404).end("no");
        const v = sums[1];
        const lines = ["arm64", "x64"].flatMap((a) => {
            const file = path.join(root, "v" + v, "node-v" + v + "-darwin-" + a + ".tar.gz");
            return fs.existsSync(file) ? [(mode === "badsum" ? "0".repeat(64) : sha(file)) + "  node-v" + v + "-darwin-" + a + ".tar.gz"] : [];
        });
        return void res.writeHead(200).end("f".repeat(64) + "  node-v" + v + "-linux-x64.tar.xz\n" + lines.join("\n") + "\n");
    }
    const tar = /^\/v(\d+\.\d+\.\d+)\/(node-v\d+\.\d+\.\d+-darwin-(?:arm64|x64)\.tar\.gz)$/.exec(url);
    if (tar && fs.existsSync(path.join(root, "v" + tar[1], tar[2]))) {
        const body = fs.readFileSync(path.join(root, "v" + tar[1], tar[2]));
        if (req.method === "HEAD") return void res.writeHead(200, { "content-length": String(body.length) }).end();
        if (mode === "truncate") {
            res.writeHead(200, { "content-length": String(body.length + 5000) });
            res.write(body.subarray(0, Math.floor(body.length / 2)));
            return void setTimeout(() => res.destroy(), 50);
        }
        return void res.writeHead(200, { "content-length": String(body.length) }).end(body);
    }
    res.writeHead(404).end("no");
}).listen(Number(port), "127.0.0.1");
`;

beforeAll(async () => {
    const root = fresh("dist");
    for (const v of [LTS_VERSION, "24.11.0"]) for (const a of ["arm64", "x64"]) writeTarball(root, v, a);
    const script = path.join(root, "dist-server.mjs");
    fs.writeFileSync(script, DIST_SERVER);
    distChild = spawn(process.execPath, [script, fwd(root), String(DIST_PORT), LTS_VERSION], { stdio: "ignore", windowsHide: true });
    const end = Date.now() + 15_000;
    for (;;) {
        try {
            if ((await fetch(`${DIST}/__requests`)).ok) break;
        } catch {
            /* not listening yet */
        }
        if (Date.now() > end) throw new Error("The nodejs.org stand-in did not start");
        await sleep(100);
    }
});
afterAll(() => {
    // Only the process started above.
    if (distChild && distChild.exitCode === null) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(distChild.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else distChild.kill("SIGKILL");
    }
});
const distMode = async (mode: DistMode) => void (await fetch(`${DIST}/__mode/${mode}`));
const distRequests = async (): Promise<string[]> => (await (await fetch(`${DIST}/__requests`)).json()) as string[];

/** Stubs for npm (it records the call and lays out node_modules like a real install) and for Playwright's browser download. */
function installStubTools(w: World, nodeDir: string, browsers: string): void {
    const js = path.join(w.stubDir, "npm-stub.mjs");
    fs.writeFileSync(
        js,
        `import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.STUB_LOG, "npm " + process.argv.slice(2).join(" ") + " | cwd=" + process.cwd().split(path.sep).slice(-2).join("/") + " | PATH-first=" + process.env.PATH.split(path.delimiter)[0] + "\\n");
const nm = path.join(process.cwd(), "node_modules");
fs.mkdirSync(path.join(nm, "fake-a"), { recursive: true });
fs.writeFileSync(path.join(nm, "fake-a", "package.json"), JSON.stringify({ name: "fake-a", version: "1.0.0" }));
fs.mkdirSync(path.join(nm, "playwright-core"), { recursive: true });
fs.writeFileSync(path.join(nm, "playwright-core", "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium", revision: "1243" }, { name: "chromium-headless-shell", revision: "1243" }, { name: "ffmpeg", revision: "1011" }] }));
fs.writeFileSync(path.join(nm, "playwright-core", "cli.js"), ${JSON.stringify(`import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.STUB_LOG, "playwright-cli " + process.argv.slice(2).join(" ") + "\\n");
for (const d of ["chromium-1243", "chromium_headless_shell-1243", "ffmpeg-1011"]) {
    fs.mkdirSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, d), { recursive: true });
    fs.writeFileSync(path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, d, "INSTALLATION_COMPLETE"), "");
}
`)});
`,
    );
    fs.writeFileSync(path.join(nodeDir, "npm"), `#!/bin/sh\nexec "${REAL_NODE}" "${fwd(js)}" "$@"\n`, { mode: 0o755 });
    fs.mkdirSync(browsers, { recursive: true });
}

describe.skipIf(!BASH)("Node.js: found and skipped, or downloaded from nodejs.org's stand-in and verified", () => {
    const downloadEnv = (extra: Record<string, string> = {}) => ({ AITP_NODE_DIST_URL: DIST, AITP_INSTALLER_NODE_SEARCH_ONLY: "", AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1", ...extra });
    const reset = (mode: DistMode = "ok") => distMode(mode);

    it("downloads the newest long-term Node.js of 24 or newer, checks its SHA-256 with shasum -a 256, unpacks it into its own folder and uses it", async () => {
        await reset();
        const w = world();
        const { setup } = makeKit();
        // `shasum` is a stub that records the call and does the work with sha256sum, so the Mac's tool name is the one exercised.
        stub(w.stubDir, "shasum", 'if [ "$1" = "-a" ] && [ "$2" = "256" ]; then shift 2; exec sha256sum "$@"; fi; exit 2');
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toMatch(/\[1\/5\] Node\.js 24 or newer \.\.\. downloading (less than 1|\d+) MB/);
        expect(r.out).toMatch(new RegExp(`\\[1/5\\] Node\\.js 24 or newer \\.\\.\\. done \\(v${escapeRe(LTS_VERSION)} at \.*/node/bin\\)`));
        // It asked for the right files: the index, the checksum list, then the arm64 tarball of the newest LTS (not the newer odd release, not 22).
        expect((await distRequests())).toContain("GET /index.json");
        expect((await distRequests())).toContain(`GET /v${LTS_VERSION}/SHASUMS256.txt`);
        expect((await distRequests())).toContain(`GET /v${LTS_VERSION}/node-v${LTS_VERSION}-darwin-arm64.tar.gz`);
        expect((await distRequests()).some((q) => /v25\.2\.0|v22\.20\.0/.test(q.split(" ")[1]!) && /tar\.gz/.test(q))).toBe(false);
        expect(stubLog(w)).toMatch(/shasum -a 256 .*node-v24\.12\.1-darwin-arm64\.tar\.gz/);
        // It is in the private folder, runs, and the folder it was unpacked in is cleaned up.
        const privateNode = path.join(w.install, "node", "bin", "node");
        expect(fs.existsSync(privateNode)).toBe(true);
        expect(spawnSync(BASH!, [msys(privateNode), "--version"], { encoding: "utf8" }).stdout.trim()).toBe(`v${LTS_VERSION}`);
        expect(fs.readdirSync(path.join(w.install, "tmp"))).toEqual([]);
        expect(fs.readFileSync(path.join(w.install, "node-path"), "utf8").trim()).toContain("/node/bin/node");
        // The test setting is announced.
        expect(r.out).toContain("test setting: downloading from");
    });

    it("the second run finds that Node.js and downloads nothing (found, skipped)", async () => {
        await reset();
        const w = world();
        const { setup } = makeKit();
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() }).status).toBe(0);
        await reset();
        const started = Date.now();
        const second = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(second.status, second.out).toBe(0);
        expect(second.out).toMatch(new RegExp(`\\[1/5\\] Node\\.js 24 or newer \\.\\.\\. found \\(v${escapeRe(LTS_VERSION)} at \.*/node/bin\\), skipped`));
        expect(second.out).toContain("[2/5] Runner files ... found, up to date, skipped");
        expect((await distRequests())).toEqual([]);
        expect(Date.now() - started).toBeLessThan(30_000);
    });

    const arches: Array<[string, Record<string, string>, string]> = [
        ["Apple silicon", { AITP_INSTALLER_UNAME_M: "arm64" }, "arm64"],
        ["Intel", { AITP_INSTALLER_UNAME_M: "x86_64" }, "x64"],
        ["Intel shell under Rosetta (picks the native build)", { AITP_INSTALLER_UNAME_M: "x86_64", AITP_INSTALLER_PROC_TRANSLATED: "1" }, "arm64"],
    ];
    for (const [label, env, arch] of arches) {
        it(`${label}: asks for the darwin-${arch} tarball`, async () => {
            await reset();
            const w = world();
            const { setup } = makeKit();
            const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv(env) });
            expect(r.status, r.out).toBe(0);
            const tarballs = (await distRequests()).filter((q) => q.endsWith(".tar.gz") && q.startsWith("GET"));
            expect(tarballs).toEqual([`GET /v${LTS_VERSION}/node-v${LTS_VERSION}-darwin-${arch}.tar.gz`]);
        });
    }

    it("a wrong checksum is refused, the file is deleted, nothing is installed, and the message says what to do", async () => {
        await reset("badsum");
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(r.status).toBe(1);
        expect(r.out).toContain("failed: the download does not match the checksum that nodejs.org publishes, so I deleted it");
        expect(r.out).toContain("Setup stopped. Nothing was installed.");
        expect(fs.existsSync(path.join(w.install, "node"))).toBe(false);
        expect(fs.readdirSync(path.join(w.install, "tmp")).filter((f) => f.endsWith(".tar.gz"))).toEqual([]);
    });

    it("a truncated download fails plainly (the download was cut off), and nothing is installed", async () => {
        await reset("truncate");
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(r.status).toBe(1);
        expect(r.out).toContain("[1/5] Node.js 24 or newer ... failed: the download was cut off");
        expect(fs.existsSync(path.join(w.install, "node"))).toBe(false);
        expect(fs.readdirSync(path.join(w.install, "tmp")).filter((f) => f.endsWith(".tar.gz"))).toEqual([]);
    });

    it("falls back to the pinned version when the list of versions cannot be read, and says so", async () => {
        await reset("noindex");
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain("the list of Node.js versions could not be read, so I use 24.11.0");
        expect((await distRequests())).toContain("GET /v24.11.0/node-v24.11.0-darwin-arm64.tar.gz");
    });

    it("refuses to continue when the server has no checksum list, rather than trusting an unchecked file", async () => {
        await reset("nosums");
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv() });
        expect(r.status).toBe(1);
        expect(r.out).toContain("failed: could not read the checksum list");
        expect((await distRequests()).some((q) => q.endsWith(".tar.gz"))).toBe(false);
    });

    it("a Node.js that was already on the Mac is used and nothing is requested (the first candidate that is 24 or newer wins, an older one is skipped)", async () => {
        await reset();
        const w = world();
        const { setup } = makeKit();
        const oldDir = fresh("old", "bin");
        shim(path.join(oldDir, "node"), "v20.11.0");
        const goodDir = fresh("good", "bin");
        shim(path.join(goodDir, "node"), "v24.9.0");
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: downloadEnv({ AITP_INSTALLER_NODE_SEARCH_ONLY: `${msys(oldDir)}:${msys(goodDir)}` }) });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toMatch(/Node\.js 24 or newer \.\.\. found \(v24\.9\.0 at \S*good\/bin\), skipped/);
        expect((await distRequests())).toEqual([]);
        expect(fs.existsSync(path.join(w.install, "node"))).toBe(false);
    });

    it("finds a Node.js the way start-runner.sh does when the search is not narrowed: nvm layout under HOME, Volta, then Homebrew-style folders", async () => {
        await reset();
        for (const layout of [".nvm/versions/node/v26.0.0/bin", ".volta/bin", ".asdf/shims", "Library/Application Support/fnm/node-versions/v25.0.0/installation/bin"]) {
            const w = world();
            const { setup } = makeKit();
            shim(path.join(w.home, ...layout.split("/"), "node"), "v26.0.0");
            const r = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: undefined } });
            // On a computer with a Node.js in /usr/bin the PATH wins; the layout is only decisive where none is there.
            expect(r.out, layout).toMatch(/Node\.js 24 or newer \.\.\. found \(v\d+\.\d+\.\d+ at /);
        }
    });
});

describe.skipIf(!BASH)("test tools: skipped when present at the pinned versions, installed with that Node's own npm when not; no browser download", () => {
    it("runs npm install --no-audit --no-fund in the runner folder with the chosen Node.js first on the PATH, never downloads a browser; a second run does nothing", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("pinned", "bin");
        shim(path.join(nodeDir, "node"), "v24.9.0");
        const browsers = fresh("pw-cache");
        installStubTools(w, nodeDir, browsers);
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), PLAYWRIGHT_BROWSERS_PATH: msys(browsers) };

        const first = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(first.status, first.out).toBe(0);
        expect(first.out).toContain("[3/5] Test tools ... installing with npm");
        expect(first.out).toContain("[3/5] Test tools ... done");
        expect(first.out).toContain("[4/5] Browser for web tests ... left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)");
        const log1 = stubLog(w);
        expect(log1).toMatch(/npm install --no-audit --no-fund \| cwd=Runner \(1\)\/runner \| PATH-first=.*pinned.bin/);
        // Round 17: the setup no longer downloads a browser; the runner itself uses installed Chrome or Edge, or downloads one.
        expect(log1).not.toContain("playwright-cli");

        const second = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(second.status, second.out).toBe(0);
        expect(second.out).toContain("[3/5] Test tools ... found (all packages are installed at the pinned versions), skipped");
        expect(second.out).toContain("[4/5] Browser for web tests ... left to the runner (it uses Google Chrome or Microsoft Edge from this Mac, or downloads Chromium once when it first starts)");
        expect(stubLog(w)).toBe(log1);
    });

    it("installs again when one package is at another version", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("repair", "bin");
        shim(path.join(nodeDir, "node"), "v24.9.0");
        const browsers = fresh("pw-cache");
        installStubTools(w, nodeDir, browsers);
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), PLAYWRIGHT_BROWSERS_PATH: msys(browsers) };
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env }).status).toBe(0);
        const before = stubLog(w).split("\n").filter((l) => l.startsWith("npm ")).length;
        fs.writeFileSync(path.join(w.install, "runner", "node_modules", "fake-a", "package.json"), JSON.stringify({ name: "fake-a", version: "0.9.0" }));
        const again = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(again.status, again.out).toBe(0);
        expect(stubLog(w).split("\n").filter((l) => l.startsWith("npm ")).length).toBe(before + 1);
        expect(again.out).toContain("[3/5] Test tools ... done");
    });

    it("a failed npm install stops with the reason, the last lines of its output and the next step", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("failing", "bin");
        shim(path.join(nodeDir, "node"), "v24.9.0");
        fs.writeFileSync(path.join(nodeDir, "npm"), '#!/bin/sh\necho "npm ERR! network request failed" >&2\nexit 1\n', { mode: 0o755 });
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir) } });
        expect(r.status).toBe(1);
        expect(r.out).toContain("[3/5] Test tools ... failed: npm could not install them (code 1)");
        expect(r.out).toContain("npm ERR! network request failed");
        expect(r.out).toContain("Check that this Mac can reach the internet, then open this app again.");

    });
});

describe.skipIf(!BASH)("a complete download (its own Node.js and node_modules next to the app): copied, nothing downloaded", () => {
    /** What the complete download adds to a kit: node/bin/node (a shim answering v24.19.0 and running this computer's Node.js) and a marked node_modules. */
    function makeCompleteKit(): Kit {
        const k = makeKit();
        shim(path.join(k.kit, "node", "bin", "node"), "v24.19.0");
        fs.writeFileSync(path.join(k.kit, "node", "LICENSE"), "MIT\n");
        const nm = path.join(k.kit, "node_modules");
        fs.mkdirSync(path.join(nm, "fake-a"), { recursive: true });
        fs.writeFileSync(path.join(nm, "fake-a", "package.json"), JSON.stringify({ name: "fake-a", version: "1.0.0" }));
        fs.mkdirSync(path.join(nm, "@playwright", "test"), { recursive: true });
        fs.writeFileSync(path.join(nm, "@playwright", "test", "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.63.0" }));
        fs.writeFileSync(path.join(nm, ".aitp-complete"), '{"target":"mac-arm64","nodeVersion":"v24.19.0"}\n');
        fs.writeFileSync(path.join(k.kit, "complete-kit.json"), '{"format":1,"target":"mac-arm64"}\n');
        return k;
    }

    it("--check says both came with the download and exits 0 with no Node.js anywhere else; setup copies them, never runs npm, and a second run skips both", () => {
        const w = world();
        const { setup } = makeCompleteKit();
        // No Node.js on the search path at all, and an npm that would log if it were ever called.
        const nowhere = fresh("no-node");
        installStubTools(w, nowhere, fresh("pw-cache"));
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nowhere) };
        const check = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env });
        expect(check.status, check.out).toBe(0);
        expect(check.out).toContain("[1/5] Node.js 24 or newer ... came with this download (v24.19.0), would copy it (no download)");
        expect(check.out).toContain("[3/5] Test tools ... came with this download, would copy them (no download)");
        expect(check.out).toContain("Check finished: nothing needs to be downloaded.");
        expect(fs.existsSync(w.install)).toBe(false);

        const first = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(first.status, first.out).toBe(0);
        expect(first.out).toContain("[1/5] Node.js 24 or newer ... came with this download (v24.19.0), copied (no download)");
        expect(first.out).toContain("[3/5] Test tools ... done (copied from this download, nothing downloaded)");
        expect(read(path.join(w.install, "node", "bin", "node"))).toContain("echo v24.19.0");
        expect(fs.existsSync(path.join(w.install, "runner", "node_modules", ".aitp-complete"))).toBe(true);
        expect(fs.existsSync(path.join(w.install, "runner", "node_modules", "@playwright", "test", "package.json"))).toBe(true);
        // The installed copy is what later starts use, so the unzipped folder can go.
        expect(read(path.join(w.install, "node-path")).trim()).toBe(msys(path.join(w.install, "node", "bin", "node")));
        expect(stubLog(w)).not.toMatch(/^npm /m);
        expect(stubLog(w)).not.toContain("playwright-cli");

        const second = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(second.status, second.out).toBe(0);
        expect(second.out).toContain("[1/5] Node.js 24 or newer ... came with this download (v24.19.0), already copied, skipped");
        expect(second.out).toContain("[3/5] Test tools ... came with this download, already copied, skipped");
    });

    it("a Node.js in the download that does not start (another processor) is passed over for one found on the Mac", () => {
        const w = world();
        const { kit, setup } = makeCompleteKit();
        fs.writeFileSync(path.join(kit, "node", "bin", "node"), "not a program\n", { mode: 0o755 });
        const nodeDir = fresh("brew", "bin");
        shim(path.join(nodeDir, "node"), "v26.1.0");
        const check = runScript(setup, ["--check", "--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir) } });
        expect(check.status, check.out).toBe(0);
        expect(check.out).toMatch(/\[1\/5\] Node\.js 24 or newer \.\.\. found \(v26\.1\.0 at \S+\), skipped/);
        expect(check.out).toContain("[3/5] Test tools ... came with this download, would copy them (no download)");
    });
});

describe.skipIf(!BASH)("the runner files and the install folder", () => {
    it("copies the seven files, keeps the token private, replaces only what differs, keeps work/, copies itself, and clears the quarantine flag silently", () => {
        const w = world();
        const { setup, kit } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "xattr");
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1" };
        const first = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(first.status, first.out).toBe(0);
        const runner = path.join(w.install, "runner");
        for (const f of ["runner.mjs", "task-child.mjs", "record-child.mjs", "package.json", "LICENSES.txt", "runner.json", "runner.token"]) {
            expect(read(path.join(runner, f)), f).toBe(read(path.join(kit, f)));
        }
        if (process.platform !== "win32") expect(fs.statSync(path.join(runner, "runner.token")).mode & 0o777).toBe(0o600);
        expect(read(path.join(w.install, "runner-setup.sh"))).toBe(read(setup));
        expect(first.out).toContain("[2/5] Runner files ... done (7 of 7 files copied to ");
        expect(stubLog(w)).toContain(`xattr -dr com.apple.quarantine ${msys(w.install)}`);
        expect(first.out).not.toMatch(/quarantine/i);

        // Work files stay; an unchanged kit copies nothing; a changed token is copied alone.
        fs.mkdirSync(path.join(runner, "work", "runs"), { recursive: true });
        fs.writeFileSync(path.join(runner, "work", "runs", "keep.txt"), "kept");
        const second = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(second.out).toContain("[2/5] Runner files ... found, up to date, skipped");
        fs.writeFileSync(path.join(kit, "runner.token"), "new-token-9e1\n");
        const third = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(third.out).toContain("[2/5] Runner files ... done (1 of 7 files copied to ");
        expect(read(path.join(runner, "runner.token"))).toBe("new-token-9e1\n");
        expect(read(path.join(runner, "work", "runs", "keep.txt"))).toBe("kept");
        // The token is not in the log, the setup output or the stub log.
        expect(first.out + second.out + third.out + read(path.join(w.install, "logs", "setup.log"))).not.toMatch(/t0ken-sentinel|new-token-9e1/);
    });

    it("works from the earlier install when the app is opened without the kit beside it, and says plainly what to do when there is nothing", () => {
        const w = world();
        const withKit = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1" };
        expect(runScript(withKit.setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env }).status).toBe(0);
        const bare = makeKit({ withFiles: false });
        const reuse = runScript(bare.setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(reuse.status, reuse.out).toBe(0);
        expect(reuse.out).toContain("[2/5] Runner files ... found in ");
        const none = runScript(bare.setup, ["--install-dir", msys(world().install), "--silent", "--no-start"], w.home, { stubDir: w.stubDir, env });
        expect(none.status).toBe(1);
        expect(none.out).toContain("I could not find the runner files");
    });

    it("explains App Translocation when the app is running from a temporary place", () => {
        const w = world();
        const { app } = makeKit({ withFiles: false });
        const moved = path.join(fresh("var", "folders", "AppTranslocation", "ABC123", "d"), APP_NAME);
        fs.cpSync(app, moved, { recursive: true });
        const r = runScript(path.join(moved, "Contents", "Resources", "runner-setup.sh"), ["--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
        expect(r.status).toBe(1);
        expect(r.out).toContain("macOS started this app from a temporary place");
        expect(r.out).toContain("xattr -dr com.apple.quarantine");
    });

    it("round 50: finds the kit inside the app first, with nothing beside it, also when macOS runs the app from a translocated copy", () => {
        const w = world();
        const { app } = makeAppKit({ code: "aite_InsideTheApp0123456789abcdefghijklmnop" });
        expect(fs.readdirSync(path.dirname(app))).toEqual([APP_NAME]);
        const moved = path.join(fresh("var", "folders", "AppTranslocation", "DEF456", "d"), APP_NAME);
        fs.cpSync(app, moved, { recursive: true });
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        const r = runScript(path.join(moved, "Contents", "Resources", "runner-setup.sh"), SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1" } });
        expect(r.status, r.out).toBe(0);
        expect(r.out).not.toContain("temporary place");
        for (const n of ["runner.mjs", "runner.json", "runner.enroll"]) expect(fs.existsSync(path.join(w.install, "runner", n)), n).toBe(true);
        expect(read(path.join(w.install, "runner", "runner.enroll")).trim()).toBe("aite_InsideTheApp0123456789abcdefghijklmnop");
        // Only the code's hash is kept, and the kit itself is not copied into the install folder twice.
        expect(read(path.join(w.install, "enroll-copied"))).not.toContain("aite_");
        expect(fs.existsSync(path.join(w.install, "runner", "kit"))).toBe(false);
    });

    it("refuses an install folder that already holds files it did not create, and changes nothing there", () => {
        const w = world();
        const { setup } = makeKit();
        fs.mkdirSync(w.install, { recursive: true });
        fs.writeFileSync(path.join(w.install, "precious.txt"), "mine");
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: "" } });
        expect(r.status).toBe(1);
        expect(r.out).toContain("already holds files that this app did not put there");
        expect(fs.readdirSync(w.install)).toEqual(["precious.txt"]);
        const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
        expect(un.status).toBe(0);
        expect(un.out).toContain("was not created by this app, so I left it alone");
        expect(read(path.join(w.install, "precious.txt"))).toBe("mine");
    });
});

describe.skipIf(!BASH)("reaching the platform", () => {
    it("says plainly when the platform does not answer, and does not stop; plain http on a public address is not contacted", () => {
        const w = world();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        const env = { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1" };
        const down = runScript(makeKit({ url: "http://127.0.0.1:6619" }).setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env });
        expect(down.status, down.out).toBe(0);
        expect(down.out).toMatch(/\[5\/5\] Platform connection \.\.\. failed: http:\/\/127\.0\.0\.1:6619 could not be reached \(nothing answered there, or the connection was refused\)/);
        expect(down.out).toContain("The runner keeps trying.");
        const w2 = world();
        const pub = runScript(makeKit({ url: "http://203.0.113.9:5174" }).setup, SETUP_FLAGS(w2), w2.home, { stubDir: w2.stubDir, env });
        expect(pub.out).toContain("[5/5] Platform connection ... not checked: http://203.0.113.9:5174 is plain http on a public network (the runner will still try it)");
        const w3 = world();
        const bad = runScript(makeKit({ url: "ftp://x.test" }).setup, SETUP_FLAGS(w3), w3.home, { stubDir: w3.stubDir, env });
        expect(bad.status).toBe(1);
        expect(bad.out).toContain("is not an http or https address");
    });

    it("reaches a platform that answers (any HTTP answer counts)", async () => {
        const server = http.createServer((_req, res) => res.writeHead(401).end("no"));
        await new Promise<void>((r) => server.listen(6612, "127.0.0.1", () => r()));
        try {
            const w = world();
            const nodeDir = fresh("bin");
            shim(path.join(nodeDir, "node"), "v26.0.0");
            // spawnSync would block this process's event loop and the server with it: use the async spawn.
            const { setup } = makeKit({ url: "http://127.0.0.1:6612" });
            const out = await new Promise<string>((resolve) => {
                const child = spawn(BASH!, [msys(setup), ...SETUP_FLAGS(w)], { env: mkEnv(w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1" } }, w.log), stdio: ["ignore", "pipe", "pipe"] });
                let text = "";
                child.stdout.on("data", (d) => (text += d));
                child.stderr.on("data", (d) => (text += d));
                child.on("exit", () => resolve(text.replace(/\r/g, "")));
            });
            expect(out).toContain("[5/5] Platform connection ... found (http://127.0.0.1:6612 answers), skipped");
        } finally {
            server.closeAllConnections?.();
            await new Promise((r) => server.close(r));
        }
    });
});

// ── starting the runner, the pid file, uninstall ────────────────────────────

describe.skipIf(!BASH)("starting the runner, the pid file, and uninstall", () => {
    const quick = { AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1" };
    const withNode = (): Record<string, string> => {
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        return { ...quick, AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir) };
    };

    it("without --no-start the runner runs under the chosen Node.js, its output is shown, and the run ends when the runner exits 0", () => {
        const w = world();
        const { setup } = makeKit();
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: withNode() });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('Starting the runner. Look for the line "Connected to the platform" below');
        expect(r.out).toMatch(/RUNNER-RAN v\d+\.\d+\.\d+ in .*Runner \(1\).runner/);
        expect(r.out).toContain('Connected to the platform as "stub"');
        expect(r.out).toContain("The runner stopped.");
        expect(fs.existsSync(path.join(w.install, "runner.pid")), "the pid file is removed when the runner ends").toBe(false);
    });

    it("explains each reason the runner gives up (settings, revoked token, versions, refused) and exits with its code", () => {
        for (const [code, text] of [
            [2, "The runner could not read its settings."],
            [3, "The platform no longer accepts this runner."],
            [4, "This runner and the platform are different versions."],
            [5, "The platform refused this runner."],
        ] as const) {
            const w = world();
            const { setup } = makeKit({ runner: `console.log("bye"); process.exit(${code});\n` });
            const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: withNode() });
            expect(r.status, r.out).toBe(code);
            expect(r.out).toContain(text);
        }
    });

    it("a second launch while the runner is running only shows its status; it neither starts another nor stops this one", async () => {
        const w = world();
        const { setup } = makeKit({ runner: 'console.log(\'Connected to the platform as "stub"\'); setInterval(() => {}, 1000);\n' });
        const env = withNode();
        const first = spawn(BASH!, [msys(setup), "--install-dir", msys(w.install), "--silent", "--no-autostart"], { env: mkEnv(w.home, { stubDir: w.stubDir, env }, w.log), stdio: ["ignore", "pipe", "pipe"] });
        let firstOut = "";
        first.stdout.on("data", (d) => (firstOut += d));
        try {
            await waitFor(() => firstOut.includes('Connected to the platform as "stub"'), 40_000, () => firstOut);
            expect(fs.existsSync(path.join(w.install, "runner.pid"))).toBe(true);
            const second = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env });
            expect(second.status, second.out).toBe(0);
            expect(second.out).toMatch(/The AI Testing runner is already running on this Mac \(process \d+\)\./);
            expect(second.out).toContain('It belongs to http://127.0.0.1:6619 and is named "Maya\'s "laptop" & co".');
            expect(second.out).toContain("Connected to the platform");
            // The first one is still going.
            expect(first.exitCode).toBeNull();
            // --uninstall stops it (it recorded that process) and removes the folder.
            // (This stand-in runner ignores --forget-credential and keeps running: the uninstall gives it 2 seconds, then goes on.)
            const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir, env: { ...env, AITP_INSTALLER_FORGET_SECONDS: "2" } });
            expect(un.status, un.out).toBe(0);
            expect(un.out).toMatch(/Stopping the runner this app started \(process \d+\)\./);
            expect(un.out).toContain("The runner could not remove its saved access");
            await waitFor(() => first.exitCode !== null, 30_000, () => firstOut);
            expect(fs.existsSync(w.install)).toBe(false);
        } finally {
            if (first.exitCode === null) first.kill();
        }
    }, 120_000);

    it("round 50: a new download (an unused one-time code) stops the runner that is running and starts the new one; opening it again only shows the status", async () => {
        const w = world();
        const forever = 'console.log(\'Connected to the platform as "stub" \' + process.argv.slice(2).join(" ")); setInterval(() => {}, 1000);\n';
        const env = withNode();
        const start = (setup: string) => {
            const child = spawn(BASH!, [msys(setup), "--install-dir", msys(w.install), "--silent", "--no-autostart"], { env: mkEnv(w.home, { stubDir: w.stubDir, env }, w.log), stdio: ["ignore", "pipe", "pipe"] });
            const ran = { child, out: "" };
            child.stdout.on("data", (d) => (ran.out += d));
            child.stderr.on("data", (d) => (ran.out += d));
            return ran;
        };
        const first = start(makeAppKit({ code: "aite_FirstDownload0123456789abcdefghijklmnop", runner: forever }).setup);
        let second: ReturnType<typeof start> | undefined;
        try {
            await waitFor(() => first.out.includes("Connected to the platform as"), 40_000, () => first.out);
            const pid = read(path.join(w.install, "runner.pid")).trim();
            const next = makeAppKit({ code: "aite_SecondDownload123456789abcdefghijklmnop", runner: forever });
            second = start(next.setup);
            await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null, 40_000, () => `${first.out}\n--- second ---\n${second!.out}`);
            await waitFor(() => second!.out.includes("Connected to the platform as"), 40_000, () => second!.out);
            expect(second.out).toContain(`Stopping the runner this app started (process ${pid}).`);
            expect(second.out).not.toContain("already running");
            expect(read(path.join(w.install, "runner", "runner.enroll")).trim()).toBe("aite_SecondDownload123456789abcdefghijklmnop");
            expect(fs.existsSync(path.join(w.install, "runner.pid")), `${second.out}\n--- first ---\n${first.out}`).toBe(true);
            expect(read(path.join(w.install, "runner.pid")).trim()).not.toBe(pid);
            // The same download opened again: its code was copied already, so the running runner stays and only its status is shown.
            const again = runScript(next.setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env });
            expect(again.status, again.out).toBe(0);
            expect(again.out).toMatch(/The AI Testing runner is already running on this Mac \(process \d+\)\./);
            expect(second.child.exitCode).toBeNull();
        } finally {
            for (const r of [first, second]) if (r && r.child.exitCode === null) r.child.kill("SIGTERM");
            await sleep(1500);
        }
    }, 150_000);

    it("a pid file that is stale, or points at some other program, is ignored and that program is never killed", () => {
        const w = world();
        const { setup } = makeKit();
        const env = withNode();
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env }).status).toBe(0);
        // A live program that is not the runner: a sleeping shell started here (its pid in the shell's own numbering).
        const started = spawnSync(BASH!, ["-c", "sleep 120 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
        const other = Number(started.stdout.trim());
        expect(other).toBeGreaterThan(0);
        const alive = (pid: number) => spawnSync(BASH!, ["-c", `kill -0 ${pid} 2>/dev/null && echo alive`], { encoding: "utf8" }).stdout.includes("alive");
        try {
            expect(alive(other)).toBe(true);
            fs.writeFileSync(path.join(w.install, "runner.pid"), `${other}\n`);
            // Running again does not treat it as the runner: it sets up and starts normally (the stub runner exits 0 at once).
            const run = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env });
            expect(run.status, run.out).toBe(0);
            expect(run.out).not.toContain("already running");
            expect(alive(other), "the other program was killed").toBe(true);
            // Uninstall does not kill it either.
            fs.writeFileSync(path.join(w.install, "runner.pid"), `${other}\n`);
            const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
            expect(un.status, un.out).toBe(0);
            expect(un.out).not.toContain("Stopping the runner");
            expect(alive(other), "uninstall killed the other program").toBe(true);
            // Garbage and dead pids are ignored too.
            fs.mkdirSync(w.install, { recursive: true });
            fs.writeFileSync(path.join(w.install, ".created-by-ai-testing-runner"), "x");
            fs.writeFileSync(path.join(w.install, "runner.pid"), "not-a-number\n");
            expect(runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir }).status).toBe(0);
        } finally {
            spawnSync(BASH!, ["-c", `kill ${other} 2>/dev/null; true`]);
        }
    });

    it("--uninstall removes only what the installer created: sentinels beside it, a Node.js found elsewhere and the browser cache survive", () => {
        const w = world();
        const { setup } = makeKit();
        const foundNodeDir = fresh("homebrew", "bin");
        shim(path.join(foundNodeDir, "node"), "v26.0.0");
        const cache = fresh("ms-playwright");
        fs.writeFileSync(path.join(cache, "chromium-1243-sentinel"), "browser");
        const outside = path.join(path.dirname(w.install), "sibling.txt");
        fs.mkdirSync(path.dirname(w.install), { recursive: true });
        fs.writeFileSync(outside, "mine");
        const env = { ...quick, AITP_INSTALLER_NODE_SEARCH_ONLY: msys(foundNodeDir), PLAYWRIGHT_BROWSERS_PATH: msys(cache) };
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env }).status).toBe(0);
        expect(fs.existsSync(path.join(w.install, "runner", "runner.mjs"))).toBe(true);
        const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir, env });
        expect(un.status, un.out).toBe(0);
        expect(un.out).toContain("Removed ");
        expect(un.out).toMatch(/The browser cache \S+ is shared with other tools and was left alone\./);
        expect(fs.existsSync(w.install)).toBe(false);
        expect(read(outside)).toBe("mine");
        expect(fs.existsSync(path.join(foundNodeDir, "node"))).toBe(true);
        expect(read(path.join(cache, "chromium-1243-sentinel"))).toBe("browser");
        // Again: nothing to remove, said plainly.
        const again = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir, env });
        expect(again.status).toBe(0);
        expect(again.out).toContain("Nothing to remove");
    });

    it("works in a folder whose name has spaces, brackets and an ampersand (the install folder and the kit folder both do)", () => {
        const w = world();
        w.install = path.join(path.dirname(path.dirname(w.install)), "My Mac [work] & co", "Runner (1)");
        const { setup, kit } = makeKit();
        expect(w.install).toMatch(/ \[work\] & /);
        expect(kit).toMatch(/runner \(1\)/);
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: withNode() });
        expect(r.status, r.out).toBe(0);
        expect(fs.existsSync(path.join(w.install, "runner", "runner.mjs"))).toBe(true);
        expect(r.out).toContain("RUNNER-RAN");
    });
});

async function waitFor(probe: () => boolean, ms: number, context: () => string): Promise<void> {
    const end = Date.now() + ms;
    while (!probe()) {
        if (Date.now() > end) throw new Error(`Timed out. Output so far:\n${context()}`);
        await sleep(200);
    }
}

// ── the LaunchAgent ──────────────────────────────────────────────────────────

describe.skipIf(!BASH)("the LaunchAgent: a well-formed property list, launchctl called but never really loaded", () => {
    const quick = (nodeDir: string) => ({ AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1", AITP_INSTALLER_WAIT_SECONDS: "1" });

    it("--autostart writes ~/Library/LaunchAgents/app.aitesting.runner.plist (paths with spaces and &), bootstraps it in the user's gui domain, and starts no second runner", () => {
        const w = world();
        w.install = path.join(path.dirname(path.dirname(w.install)), "My Mac [work] & co", "Runner (1)");
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "launchctl");
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain("The runner now runs in the background while you are signed in, and starts again when you sign in.");
        expect(r.out).not.toContain("RUNNER-RAN");
        const plistPath = path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist");
        const plist = read(plistPath);
        expect(wellFormed(plist)).toBeUndefined();
        expect(plist).toContain("&amp;"); // the & in the folder name, escaped
        expect(plist).not.toMatch(/&(?!amp;|lt;|gt;)/);
        const values = plistValues(plist);
        expect(values[0]).toBe("app.aitesting.runner");
        expect(values.slice(1, 6)).toEqual(["/bin/sh", `${msys(w.install)}/runner-setup.sh`, "--run-loop", "--install-dir", msys(w.install)]);
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        // Started again only after a failure: a stop for good (access removed) stays stopped until the next sign-in.
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
        expect(values).toContain(`${msys(w.install)}/logs/launchd.log`);
        // launchctl was asked, in this order: take any old copy out, then bootstrap into gui/<uid>.
        const calls = stubLog(w).split("\n").filter((l) => l.startsWith("launchctl "));
        expect(calls[0]).toMatch(/^launchctl bootout gui\/\d+\/app\.aitesting\.runner$/);
        expect(calls[1]).toBe(`launchctl bootstrap gui/${calls[0]!.match(/gui\/(\d+)\//)![1]} ${msys(plistPath)}`);
        // The copy of the script that launchd runs is in the install folder and is the same text.
        expect(read(path.join(w.install, "runner-setup.sh"))).toBe(read(setup));
    });

    it("falls back to launchctl load when bootstrap is refused (older macOS), and --uninstall boots it out and removes the plist", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "launchctl", 'case "$1" in bootstrap) exit 5 ;; esac\nexit 0');
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(r.status, r.out).toBe(0);
        const plistPath = path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist");
        expect(stubLog(w)).toContain(`launchctl load -w ${msys(plistPath)}`);
        const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
        expect(un.status, un.out).toBe(0);
        expect(un.out).toContain("Removing the sign-in start (the LaunchAgent app.aitesting.runner).");
        expect(stubLog(w)).toMatch(/launchctl bootout gui\/\d+\/app\.aitesting\.runner/);
        expect(fs.existsSync(plistPath)).toBe(false);
        expect(fs.existsSync(w.install)).toBe(false);
    });

    it("--run-loop (what launchd runs) starts the runner under the recorded Node.js, writes the pid file and its log, and stops on SIGTERM", async () => {
        const w = world();
        const { setup } = makeKit({ runner: 'console.log("LOOP-RAN " + process.version); setInterval(() => {}, 1000);\n' });
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) }).status).toBe(0);
        const loop = spawn(BASH!, [msys(path.join(w.install, "runner-setup.sh")), "--run-loop", "--install-dir", msys(w.install)], { env: mkEnv(w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: "" } }, w.log), stdio: ["ignore", "pipe", "pipe"] });
        try {
            const runLog = path.join(w.install, "logs", "runner.log");
            await waitFor(() => fs.existsSync(runLog) && read(runLog).includes("LOOP-RAN"), 40_000, () => (fs.existsSync(runLog) ? read(runLog) : "(no log)"));
            expect(fs.existsSync(path.join(w.install, "runner.pid"))).toBe(true);
            // Stopped the way launchd and --uninstall stop it.
            const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
            expect(un.out).toMatch(/Stopping the runner this app started/);
            await waitFor(() => loop.exitCode !== null, 30_000, () => "loop did not stop");
        } finally {
            if (loop.exitCode === null) loop.kill();
        }
    }, 120_000);

    it("writes the plist the same way for a Mac user name with an apostrophe, angle brackets and quotes in the install path", () => {
        const w = world();
        const odd = path.join(path.dirname(w.install), "Maya's <Mac> & \"co\" $HOME;x".replace(/[<>"]/g, (c) => ({ "<": "(", ">": ")", '"': "'" })[c]!));
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "launchctl");
        const r = runScript(setup, ["--install-dir", msys(odd), "--silent", "--autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(r.status, r.out).toBe(0);
        const plist = read(path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist"));
        expect(wellFormed(plist)).toBeUndefined();
        expect(plistValues(plist)).toContain(msys(odd));
    });
});

// ── dialogs (osascript is a stub that answers from a list) ──────────────────

describe.skipIf(!BASH)("the dialogs: shown by osascript with the text in argv, skipped when asked, and answered by the person", () => {
    /** An osascript stub: it logs the AppleScript and its arguments, a notification gets no answer, a dialog takes the next answer from the list (CANCEL = the Cancel button). */
    function osascript(w: World, answers: string[]): string {
        const answersFile = fwd(path.join(w.stubDir, "answers.txt"));
        fs.writeFileSync(path.join(w.stubDir, "answers.txt"), answers.map((a) => `${a}\n`).join(""));
        const file = path.join(w.stubDir, "osascript");
        fs.writeFileSync(
            file,
            `#!/bin/sh
{ echo "osascript:"; cat "$1"; for a in "$@"; do [ "$a" = "$1" ] || echo "  arg: $a"; done; } >> "$STUB_LOG"
if grep -q 'display notification' "$1"; then exit 0; fi
answer=$(head -n 1 "${answersFile}" 2>/dev/null)
tail -n +2 "${answersFile}" > "${answersFile}.next" 2>/dev/null; mv -f "${answersFile}.next" "${answersFile}"
if [ "$answer" = "CANCEL" ]; then echo "execution error: User canceled. (-128)" >&2; exit 1; fi
echo "$answer"
exit 0
`,
            { mode: 0o755 },
        );
        return file;
    }
    const withDialogs = (nodeDir: string, extra: Record<string, string | undefined> = {}) => ({ AITP_INSTALLER_NO_UI: undefined, AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1", AITP_INSTALLER_WAIT_SECONDS: "1", ...extra });

    it("the first screen asks, in the owner's words, before anything is downloaded; Cancel changes nothing", () => {
        const w = world();
        const { setup } = makeKit();
        osascript(w, ["CANCEL"]);
        const r = runScript(setup, ["--install-dir", msys(w.install), "--no-start"], w.home, { stubDir: w.stubDir, env: withDialogs(fresh("none"), { AITP_INSTALLER_NODE_SEARCH_ONLY: "" }) });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain("Cancelled. Nothing was changed.");
        expect(fs.existsSync(w.install)).toBe(false);
        const log = stubLog(w);
        expect(log).toContain("This will set up the AI Testing runner on this Mac. It only downloads what is missing: Node.js, the test tools. Nothing is installed system-wide.");
        expect(log).toContain("arg: Cancel");
        expect(log).toContain("arg: Set up");
        expect(log).toContain("arg: AI Testing Runner");
    });

    it("Set up goes ahead; then the sign-in question is asked once, and 'Not now' is remembered", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "launchctl");
        osascript(w, ["Set up", "Not now"]);
        const first = runScript(setup, ["--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: withDialogs(nodeDir) });
        expect(first.status, first.out).toBe(0);
        expect(first.out).toContain("RUNNER-RAN"); // 'Not now' runs it in this window
        const log = stubLog(w);
        expect(log).toContain("Run the runner in the background, and start it again whenever you sign in?");
        expect(log).toContain("arg: Not now");
        expect(fs.existsSync(path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist"))).toBe(false);
        expect(read(path.join(w.install, "autostart-asked")).trim()).toBe("no");
        // Second time: neither question comes back (nothing is missing, and the sign-in question was answered).
        fs.writeFileSync(w.log, "");
        osascript(w, ["Set up", "Yes"]);
        const second = runScript(setup, ["--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: withDialogs(nodeDir) });
        expect(second.status, second.out).toBe(0);
        expect(stubLog(w)).not.toContain("Run the runner in the background");
        // The test tools are still missing here (npm is switched off), so the first question comes back; the sign-in one does not.
        expect(stubLog(w)).toContain("It only downloads what is missing: the test tools.");
    });

    it("answering Yes to the sign-in question writes the LaunchAgent and bootstraps it", () => {
        const w = world();
        const { setup } = makeKit();
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        stub(w.stubDir, "launchctl");
        osascript(w, ["Set up", "Yes"]);
        const r = runScript(setup, ["--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: withDialogs(nodeDir) });
        expect(r.status, r.out).toBe(0);
        expect(fs.existsSync(path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist"))).toBe(true);
        expect(stubLog(w)).toMatch(/launchctl bootstrap gui\/\d+ /);
    });

    it("tells the person with a dialog when the setup fails, and the dialog holds the same plain text", () => {
        const w = world();
        const { setup } = makeKit({ withFiles: false });
        osascript(w, ["CANCEL", "OK"]);
        const r = runScript(setup, ["--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: withDialogs(fresh("none")) });
        expect(r.status).toBe(1);
        expect(stubLog(w)).toContain("I could not find the runner files (runner.mjs, runner.json and runner.enroll) next to this app.");
        expect(stubLog(w)).toContain("choose folder with prompt");
    });

    it("never calls osascript with --silent or AITP_INSTALLER_NO_UI=1", () => {
        for (const mode of ["silent", "no-ui"]) {
            const w = world();
            const { setup } = makeKit();
            const nodeDir = fresh("bin");
            shim(path.join(nodeDir, "node"), "v26.0.0");
            stub(w.stubDir, "osascript");
            const args = mode === "silent" ? ["--install-dir", msys(w.install), "--silent"] : ["--install-dir", msys(w.install)];
            const env = mode === "silent" ? withDialogs(nodeDir) : withDialogs(nodeDir, { AITP_INSTALLER_NO_UI: "1" });
            const r = runScript(setup, args, w.home, { stubDir: w.stubDir, env });
            expect(r.status, `${mode}: ${r.out}`).toBe(0);
            expect(stubLog(w), mode).not.toContain("osascript");
        }
    });

    it("sends a 'Connected to <platform> as <name>' notification when the runner connects", () => {
        const w = world();
        const { setup } = makeKit({ runner: 'console.log(\'Connected to the platform as "stub"\'); setTimeout(() => process.exit(0), 3500);\n', name: "Maya laptop" });
        const nodeDir = fresh("bin");
        shim(path.join(nodeDir, "node"), "v26.0.0");
        osascript(w, ["Set up", "Not now"]);
        const r = runScript(setup, ["--install-dir", msys(w.install)], w.home, { stubDir: w.stubDir, env: withDialogs(nodeDir) });
        expect(r.status, r.out).toBe(0);
        expect(stubLog(w)).toContain("display notification");
        expect(stubLog(w)).toContain("arg: Connected to http://127.0.0.1:6619 as Maya laptop");
    });
});

// ── the launcher ─────────────────────────────────────────────────────────────

describe.skipIf(!BASH)("the launcher (Contents/MacOS/AITestingRunner)", () => {
    it("opens Terminal on a .command file that runs the setup with every argument intact, whatever characters the paths and arguments hold", () => {
        const w = world();
        const dir = path.join(fresh("app"), "it's [a] & $HOME;x");
        fs.mkdirSync(dir, { recursive: true });
        const app = path.join(dir, APP_NAME);
        fs.cpSync(built.appDir, app, { recursive: true });
        // A setup script that only prints what it was given, one argument per line.
        fs.writeFileSync(path.join(app, "Contents", "Resources", "runner-setup.sh"), '#!/bin/sh\nfor a in "$@"; do echo "ARG<$a>"; done\necho "SELF<$0>"\n');
        stub(w.stubDir, "open", 'cp "$3" "$STUB_OPENED"');
        const opened = path.join(w.stubDir, "opened.command");
        const args = ["--install-dir", "/x/it's a \"q\" & $HOME; `id` $(id) [b]", "--log", "a b"];
        const r = spawnSync(BASH!, [msys(path.join(app, "Contents", "MacOS", "AITestingRunner")), ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...mkEnv(w.home, { stubDir: w.stubDir }, w.log), STUB_OPENED: fwd(opened) },
        });
        expect(r.status, r.stdout + r.stderr).toBe(0);
        expect(stubLog(w)).toMatch(/^open -a Terminal \S+ai-testing-runner\.\w+\.command$/m);
        const cmd = read(opened);
        expect(cmd.startsWith("#!/bin/sh\n")).toBe(true);
        expect(cmd).toContain('rm -f "$0"');
        // Run the .command file the way Terminal does and read back what the setup script received.
        const ran = spawnSync(BASH!, [msys(opened)], { encoding: "utf8", env: mkEnv(w.home, { stubDir: w.stubDir }, w.log) });
        const got = [...ran.stdout.matchAll(/ARG<([\s\S]*?)>(?=\r?\n)/g)].map((m) => m[1]);
        expect(got).toEqual(args);
        expect(ran.stdout).toContain(`SELF<${msys(path.join(app, "Contents", "Resources", "runner-setup.sh"))}>`);
    });

    it("runs the setup in its own shell when started from a terminal (AITP_INSTALLER_NO_TERMINAL), and complains plainly when the setup script is missing", () => {
        const w = world();
        const app = path.join(fresh("app2"), APP_NAME);
        fs.cpSync(built.appDir, app, { recursive: true });
        const launcher = msys(path.join(app, "Contents", "MacOS", "AITestingRunner"));
        const help = spawnSync(BASH!, [launcher, "--help"], { encoding: "utf8", env: { ...mkEnv(w.home, { stubDir: w.stubDir }, w.log), AITP_INSTALLER_NO_TERMINAL: "1" } });
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain("--install-dir");
        fs.rmSync(path.join(app, "Contents", "Resources", "runner-setup.sh"));
        stub(w.stubDir, "osascript");
        const broken = spawnSync(BASH!, [launcher], { encoding: "utf8", env: mkEnv(w.home, { stubDir: w.stubDir }, w.log) });
        expect(broken.status).toBe(1);
        expect(broken.stderr).toContain("runner-setup.sh is missing from this app.");
        expect(stubLog(w)).toContain("osascript -e display dialog");
    });
});

describe("the dmg", () => {
    it("is built only on macOS: elsewhere the build says so plainly and does nothing; the script refuses to run off a Mac", () => {
        const out = fresh("dmg");
        const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "build-installer-mac.mjs"), "--out", out, "--dmg"], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        expect(fs.existsSync(path.join(out, "manifest-part.json"))).toBe(true);
        if (process.platform !== "darwin") {
            expect(r.stdout).toContain("A .dmg can only be built on macOS (it needs hdiutil).");
            expect(fs.readdirSync(out).some((f) => f.endsWith(".dmg"))).toBe(false);
            if (BASH) {
                const sh = spawnSync(BASH, [msys(path.join(REPO, "scripts", "make-dmg.sh")), "a", "b"], { encoding: "utf8" });
                expect(sh.status).toBe(1);
                expect(sh.stderr).toContain("make-dmg.sh needs macOS (hdiutil). It was not run.");
            }
        }
        const text = read(path.join(REPO, "scripts", "make-dmg.sh"));
        expect(text).toContain('hdiutil create -volname "AI Testing Runner" -srcfolder');
        expect(text).toContain("-ov -format UDZO");
    });
});


// ── Round 39: one-time codes, background by default, lock file, logs, stop for good, the credential on uninstall, the .pkg ──────────

describe.skipIf(!BASH)("round 39: the one-time code, background by default, npm ci, log rotation, stop for good, forgetting the credential", () => {
    const quick = (nodeDir: string) => ({ AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_NPM: "1", AITP_INSTALLER_SKIP_BROWSER: "1", AITP_INSTALLER_WAIT_SECONDS: "1" });
    /** A runner stub that records how it was started ("[arguments]" per start) and exits at once. */
    const ENROLL_RUNNER = 'import fs from "node:fs";\nfs.appendFileSync("started.txt", "[" + process.argv.slice(2).join(" ") + "]\\n");\nconsole.log(\'Connected to the platform as "stub"\');\nprocess.exit(0);\n';
    /** A download from round 39 on: runner.enroll instead of runner.token, and a lock file. */
    function enrollKit(runner = ENROLL_RUNNER) {
        const k = makeKit({ runner });
        fs.rmSync(path.join(k.kit, "runner.token"));
        fs.writeFileSync(path.join(k.kit, "runner.enroll"), "aite_ONE-TIME-code-sentinel-7d2\n", { mode: 0o600 });
        fs.writeFileSync(path.join(k.kit, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
        return k;
    }
    const nodeBin = () => {
        const d = fresh("bin");
        shim(path.join(d, "node"), "v26.0.0");
        return d;
    };

    it("copies the one-time code once (0600), never the same code twice, lets it replace an older token, and keeps the code out of every log", () => {
        const w = world();
        const { setup, kit } = enrollKit();
        const nodeDir = nodeBin();
        const runner = path.join(w.install, "runner");
        fs.mkdirSync(runner, { recursive: true });
        fs.writeFileSync(path.join(runner, "runner.token"), "old-token\n");
        fs.writeFileSync(path.join(w.install, ".created-by-ai-testing-runner"), "");
        const first = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(first.status, first.out).toBe(0);
        expect(read(path.join(runner, "runner.enroll"))).toBe(read(path.join(kit, "runner.enroll")));
        if (process.platform !== "win32") expect(fs.statSync(path.join(runner, "runner.enroll")).mode & 0o777).toBe(0o600);
        expect(fs.existsSync(path.join(runner, "runner.token"))).toBe(false);
        expect(read(path.join(runner, "package-lock.json"))).toBe(read(path.join(kit, "package-lock.json")));
        expect(first.out).toContain("[2/5] Runner files ... done (8 of 8 files copied to ");
        // The runner traded the code and deleted it; opening the app again from the same folder does not bring the used code back.
        fs.rmSync(path.join(runner, "runner.enroll"));
        const second = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(second.out).toContain("[2/5] Runner files ... found, up to date, skipped");
        expect(fs.existsSync(path.join(runner, "runner.enroll"))).toBe(false);
        // Only the sha256 of the code is kept, never the code.
        expect(read(path.join(w.install, "enroll-copied"))).toMatch(/^[0-9a-f]{64}\n$/);
        // A new download (a new code) is copied.
        fs.writeFileSync(path.join(kit, "runner.enroll"), "aite_SECOND-code-sentinel-1b9\n");
        const third = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(third.out).toContain("[2/5] Runner files ... done (1 of 8 files copied to ");
        const all = first.out + second.out + third.out + read(path.join(w.install, "logs", "setup.log")) + stubLog(w);
        expect(all).not.toMatch(/ONE-TIME-code-sentinel|SECOND-code-sentinel/);
    });

    it("starts the runner with --enroll-file while the code is there, then with no credential argument (the Keychain); an older install with --token-file", () => {
        const w = world();
        const { setup } = enrollKit();
        const nodeDir = nodeBin();
        const r = runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(r.status, r.out).toBe(0);
        const runner = path.join(w.install, "runner");
        const starts = () => read(path.join(runner, "started.txt")).trim().split("\n");
        expect(starts()).toEqual(["[--enroll-file runner.enroll]"]);
        fs.rmSync(path.join(runner, "runner.enroll"));
        runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(starts().pop()).toBe("[]");
        fs.writeFileSync(path.join(runner, "runner.token"), "t\n");
        runScript(setup, ["--install-dir", msys(w.install), "--silent", "--no-autostart"], w.home, { stubDir: w.stubDir, env: quick(nodeDir) });
        expect(starts().pop()).toBe("[--token-file runner.token]");
    });

    it("runs in the background by default: --silent and --yes set up the LaunchAgent; the dialog preselects Yes; an earlier LaunchAgent is written again", () => {
        for (const flag of ["--silent", "--yes"]) {
            const w = world();
            const { setup } = makeKit();
            stub(w.stubDir, "launchctl");
            const r = runScript(setup, ["--install-dir", msys(w.install), flag], w.home, { stubDir: w.stubDir, env: quick(nodeBin()) });
            expect(r.status, r.out).toBe(0);
            expect(fs.existsSync(path.join(w.home, "Library", "LaunchAgents", "app.aitesting.runner.plist")), flag).toBe(true);
            expect(r.out).not.toContain("RUNNER-RAN");
        }
        const text = read(path.join(REPO, "installer/mac/app/Contents/Resources/runner-setup.sh"));
        expect(text).toMatch(/confirm "Run the runner in the background[^"]*" "Not now" "Yes" yes/);
        expect(text).not.toMatch(/LaunchDaemons|sudo /);
    });

    it("installs the test tools with npm ci --ignore-scripts when the download has a lock file", () => {
        const w = world();
        const { setup } = enrollKit();
        const nodeDir = nodeBin();
        stub(nodeDir, "npm", 'mkdir -p node_modules/fake-a && printf \'{"version":"1.0.0"}\' > node_modules/fake-a/package.json');
        const r = runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: msys(nodeDir), AITP_INSTALLER_SKIP_BROWSER: "1" } });
        expect(r.status, r.out).toBe(0);
        expect(stubLog(w)).toMatch(/^npm ci --ignore-scripts --no-audit --no-fund$/m);
        expect(stubLog(w)).not.toMatch(/^npm install/m);
    });

    it("rotates runner.log and launchd.log while running (size-capped, three kept), and stops for good after exit code 3 under launchd", async () => {
        const w = world();
        // A runner that writes a lot, then says its access was removed.
        const { setup } = makeKit({ runner: 'for (let i = 0; i < 400; i++) console.log("x".repeat(100));\nsetTimeout(() => process.exit(3), 3500);\n' });
        const nodeDir = nodeBin();
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) }).status).toBe(0);
        const logs = path.join(w.install, "logs");
        fs.mkdirSync(logs, { recursive: true });
        fs.writeFileSync(path.join(logs, "launchd.log"), "y".repeat(30_000));
        const started = Date.now();
        const loop = spawn(BASH!, [msys(path.join(w.install, "runner-setup.sh")), "--run-loop", "--install-dir", msys(w.install)], { env: mkEnv(w.home, { stubDir: w.stubDir, env: { AITP_INSTALLER_NODE_SEARCH_ONLY: "", AITP_INSTALLER_LOG_MAX_BYTES: "20000", AITP_INSTALLER_LOG_CHECK_SECONDS: "1" } }, w.log), stdio: ["ignore", "pipe", "pipe"] });
        try {
            // Exit code 3 under launchd: the loop ends by itself, without an error (no hourly retry), so launchd leaves it stopped.
            await waitFor(() => loop.exitCode !== null, 40_000, () => "the loop did not stop after code 3");
            expect(loop.exitCode).toBe(0);
            expect(Date.now() - started).toBeLessThan(40_000);
            expect(read(path.join(logs, "runner.log")) + (fs.existsSync(path.join(logs, "runner.log.1")) ? read(path.join(logs, "runner.log.1")) : "")).toMatch(/stopped for good/);
            expect(fs.existsSync(path.join(logs, "runner.log.1"))).toBe(true);
            expect(fs.existsSync(path.join(logs, "launchd.log.1"))).toBe(true);
            expect(fs.statSync(path.join(logs, "launchd.log")).size).toBeLessThan(20_000);
            expect(fs.existsSync(path.join(logs, "runner.log.4"))).toBe(false);
        } finally {
            if (loop.exitCode === null) loop.kill();
        }
    }, 120_000);

    it("--uninstall asks the runner to forget its saved credential, and removes a code or token left behind even when the folder is kept", () => {
        const w = world();
        const { setup } = enrollKit();
        const nodeDir = nodeBin();
        expect(runScript(setup, SETUP_FLAGS(w), w.home, { stubDir: w.stubDir, env: quick(nodeDir) }).status).toBe(0);
        const runner = path.join(w.install, "runner");
        const un = runScript(setup, ["--uninstall", "--install-dir", msys(w.install), "--silent"], w.home, { stubDir: w.stubDir });
        expect(un.status, un.out).toBe(0);
        expect(un.out).toContain("Removed the runner's saved access from this Mac.");
        expect(fs.existsSync(w.install)).toBe(false);
        void runner;
    });
});

describe("the .pkg", () => {
    it("is built only on macOS, says so plainly elsewhere, installs the app only (no install scripts) for one person or the whole Mac", () => {
        const script = path.join(REPO, "scripts", "build-runner-pkg.sh");
        if (process.platform !== "darwin" && BASH) {
            const r = spawnSync(BASH, [msys(script)], { encoding: "utf8" });
            expect(r.status).toBe(1);
            expect(r.stderr).toContain("build-runner-pkg.sh needs macOS (pkgbuild and productbuild). It was not run.");
        }
        const text = read(script);
        expect(text).toContain("pkgbuild --root");
        expect(text).toContain("productbuild --distribution");
        expect(text).toContain('enable_currentUserHome="true" enable_localSystem="true"');
        expect(text).toContain("BundleIsRelocatable false");
        expect(text).not.toMatch(/--scripts|preinstall|postinstall|LaunchDaemons|sudo /);
        expect(text).not.toMatch(/runner\.(token|enroll)"?\s*(>|cp)/);
        if (DASH) expect(spawnSync(DASH, ["-n", script]).status).toBe(0);
    });
});
