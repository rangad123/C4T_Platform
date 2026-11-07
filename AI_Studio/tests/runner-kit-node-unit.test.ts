/**
 * How the runner kit's start scripts find Node.js (fast tier: no browser, no platform, no ports).
 *
 * The scripts used to say "Node.js is not installed" whenever `node` was not on the PATH of the window that started them, which is the
 * normal case for a double-clicked file on a Mac (nvm, fnm, Volta, asdf and Homebrew set the PATH in a shell profile that a double-click
 * never reads) and for per-user and nvm-windows installs on Windows. These tests read the script texts and then RUN them: start-runner.sh
 * under Git Bash's bash, dash and `bash --posix` (when present), start-runner.cmd under cmd.exe on Windows, each against fake Node.js
 * installs laid out the way nvm, Volta, Homebrew, fnm and nvm-windows lay theirs out, with a stub runner.mjs in place of the real
 * runner (the real runner connecting to a real platform is tests/runner-kit-node.test.ts).
 *
 * A "fake Node.js" is a small shim that answers --version with the version it claims and otherwise runs this machine's real Node.js,
 * or (for the Windows "too old" case) a node.cmd that only prints a version. Nothing is installed, no process is touched but the ones
 * started here, and the real Node.js of this computer is hidden from the scripts by an explicit PATH and HOME.
 *
 * The two test-only variables are AITP_KIT_EXTRA_NODE_DIRS and AITP_KIT_SKIP_SHELL_SEARCH (see runner-kit-scripts.ts).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NODE_MIN_MAJOR, START_CMD, START_COMMAND, START_SH, withLineEnding } from "../src/platform/runner-kit-scripts.js";

const SH = withLineEnding(START_SH, "\n");
const CMD = withLineEnding(START_CMD, "\r\n");
const COMMAND = withLineEnding(START_COMMAND, "\n");
const fwd = (p: string) => p.replaceAll("\\", "/");
/** The form Git Bash uses for a path inside a colon separated list (C:/x/y would be split at the colon): /c/x/y. */
const msys = (p: string) => (process.platform === "win32" ? fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);

/** A script's text without its comment-only lines (comments may name things the code must not use). */
const code = (text: string) =>
    text
        .split("\n")
        .filter((l) => !/^\s*#/.test(l))
        .join("\n");

// ── what the texts say ──────────────────────────────────────────────────────

describe("start-runner.sh: where it looks and what it says", () => {
    it("looks in every place a Mac or Linux person's Node.js can be", () => {
        for (const place of [
            "command -v node",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/usr/bin",
            "$HOME/.volta/bin",
            "$HOME/.asdf/shims",
            "$HOME/.local/share/mise/shims",
            "/versions/node/*/bin",
            "/.local/share/fnm/node-versions/*/installation/bin",
            "$HOME/Library/Application Support",
            "$HOME/.nodenv/shims",
            "$HOME/.n/bin",
            "/usr/local/n/versions/node/*/bin",
            "nvm.sh",
            "nvm use default",
            `-ilc 'command -v node'`,
        ]) {
            expect(SH, place).toContain(place);
        }
    });

    it("tests every candidate for the version instead of trusting the first one, and puts the one it uses first on the PATH", () => {
        expect(SH).toContain('"$1" --version');
        expect(SH).toContain('[ "$tn_major" -ge "$NODE_MIN" ]');
        expect(SH).toContain(`NODE_MIN=${NODE_MIN_MAJOR}`);
        expect(SH).toContain('PATH="$(dirname "$NODE_BIN"):$PATH"');
        expect(SH).toContain("export PATH");
    });

    it("has three different sentences: nothing found, found but too old (which one, where), and the one it uses", () => {
        expect(SH).toContain("Node.js was not found on this computer. The runner needs Node.js $NODE_MIN or newer.");
        expect(SH).toContain("I looked on the PATH, in the Homebrew, nvm, fnm, Volta, asdf, mise, nodenv and n folders, and asked your login shell.");
        expect(SH).toContain("Found Node.js v$tn_ver at $1. That is too old, the runner needs $NODE_MIN or newer.");
        expect(SH).toContain('say "Using Node.js $NODE_VER from $NODE_BIN."');
        // The old wording blamed a missing install even when a Node.js had been found.
        expect(SH).not.toMatch(/not installed/i);
        expect(SH).toContain("nvm install $NODE_MIN");
        expect(SH).toContain("brew install node");
        expect(SH).toContain("https://nodejs.org");
    });

    it("keeps the switches the tests and people use, and asks before installing anything", () => {
        expect(SH).toContain('"$AITP_KIT_SKIP_INSTALL" != "1"');
        expect(SH).toContain('"$AITP_KIT_NO_PAUSE" != "1"');
        expect(SH.indexOf("read -r answer")).toBeGreaterThan(-1);
        expect(SH.indexOf("read -r answer")).toBeLessThan(SH.indexOf("brew install node; then"));
    });

    it("bounds the slow searches, so a heavy shell profile cannot hang it", () => {
        expect(SH).toContain("bounded 8");
        expect(SH).toContain("bounded 10");
        expect(SH).toContain("kill -9");
        expect(SH).toContain("</dev/null"); // a shell that waits for input gets none
    });

    it("clears macOS's quarantine flag on its own folder, silently", () => {
        expect(SH).toContain('"$(uname -s 2>/dev/null)" = "Darwin"');
        expect(SH).toContain("xattr -dr com.apple.quarantine . >/dev/null 2>&1");
        // Only the folder the script is in.
        expect(SH.indexOf("xattr")).toBeGreaterThan(SH.indexOf('cd "$(dirname "$0")"'));
    });

    it("uses no bashism and nothing a Mac's /bin/sh, dash or Git Bash lacks", () => {
        const body = code(SH);
        const banned: Array<[string, RegExp]> = [
            ["[[", /\[\[/],
            ["local", /^\s*local\s/m],
            ["function keyword", /^\s*function\s/m],
            ["array assignment", /\w=\(/],
            ["process substitution", /<\(|>\(/],
            ["pattern substitution", /\$\{[A-Za-z_]+\/\/?/],
            ["echo -e", /\becho\s+-[a-zA-Z]*e/],
            ["source", /^\s*source\s/m],
            ["&> redirect", /&>/],
            ["==", /\[[^\]]*==[^\]]*\]/],
            ["readlink -f", /readlink\s+-f/],
            ["sed -i", /\bsed\s+-i/],
            ["timeout command", /(^|[\s;|&(])timeout\s+[0-9]/m],
            ["mktemp -p", /mktemp\s+-p/],
            ["$RANDOM", /\$RANDOM|\$BASH_/],
            ["let", /^\s*let\s/m],
            ["select", /^\s*select\s/m],
        ];
        for (const [name, re] of banned) expect(re.test(body), name).toBe(false);
        expect(SH.startsWith("#!/bin/sh\n")).toBe(true);
    });

    it("start-runner.command hands over to start-runner.sh without a login-shell detour (it breaks for fish)", () => {
        expect(COMMAND).toBe('#!/bin/sh\nexec sh "$(dirname "$0")/start-runner.sh"\n');
    });
});

describe("start-runner.cmd: where it looks and what it says", () => {
    const lines = CMD.split("\r\n");

    it("looks in every place a Windows person's Node.js can be", () => {
        for (const place of [
            "where node",
            "%ProgramFiles%\\nodejs",
            "%ProgramW6432%\\nodejs",
            "%ProgramFiles(x86)%\\nodejs",
            "%LOCALAPPDATA%\\Programs\\nodejs",
            "%NVM_SYMLINK%",
            "%NVM_HOME%\\v*",
            "%LOCALAPPDATA%\\Volta\\bin",
            "%APPDATA%\\fnm\\node-versions\\*",
            "%LOCALAPPDATA%\\fnm_multishells\\*",
            "powershell",
            "DoNotExpandEnvironmentNames",
        ]) {
            expect(CMD, place).toContain(place);
        }
    });

    it("tests every candidate for the version, only trusts a line shaped like a version, and puts the one it uses first on the PATH", () => {
        expect(CMD).toContain('--version 2^>nul ^| findstr /r /c:"^v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*[.0-9A-Za-z-]*$"');
        expect(CMD).toContain(`if %TN_MAJOR% GEQ ${NODE_MIN_MAJOR}`);
        expect(CMD).toContain('set "PATH=%NODE_DIR%;%PATH%"');
        // node.cmd shims are run with call, and so is the runner itself, or control would never come back from a .cmd.
        expect(CMD).toContain("call node runner.mjs --token-file runner.token");
    });

    it("has three different sentences: nothing found, found but too old (which one, where), and the one it uses", () => {
        expect(CMD).toContain(`Node.js was not found on this computer. The runner needs Node.js ${NODE_MIN_MAJOR} or newer.`);
        expect(CMD).toContain("I looked on the PATH, in Program Files, in the nvm-windows, Volta and fnm folders, and in the PATH saved in Windows.");
        expect(CMD).toContain(`Found Node.js !OLDVER1! at !OLDBIN1!. That is too old, the runner needs ${NODE_MIN_MAJOR} or newer.`);
        expect(CMD).toContain("Using Node.js !NODE_VER! from !NODE_BIN!.");
        expect(CMD).not.toMatch(/not installed/i);
        expect(CMD).toContain("winget install OpenJS.NodeJS.LTS");
        expect(CMD).toContain("https://nodejs.org");
        // It asks before it installs anything.
        expect(CMD.indexOf("set /p")).toBeLessThan(CMD.indexOf("winget install OpenJS.NodeJS.LTS\r\nif errorlevel"));
    });

    it("keeps the switches the tests and people use", () => {
        expect(CMD).toContain('"%AITP_KIT_SKIP_INSTALL%"=="1"');
        expect(CMD).toContain('"%AITP_KIT_NO_PAUSE%"=="1"');
    });

    it("is ASCII with CRLF line ends only", () => {
        expect(CMD).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
        expect(CMD.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    });

    it("has balanced quotes on every line, so a path with spaces cannot split a command", () => {
        for (const l of lines) {
            if (/^\s*rem\b/i.test(l)) continue;
            expect((l.match(/"/g) ?? []).length % 2, l).toBe(0);
        }
    });

    it("never opens a ( ) block, so a ) inside a path (Program Files (x86), runner (1)) cannot end one early", () => {
        for (const l of lines) {
            if (/^\s*rem\b/i.test(l)) continue;
            expect(l, "a line that opens a block").not.toMatch(/\(\s*$/);
            expect(l, "a line that closes a block").not.toMatch(/^\s*\)/);
        }
        // The only parentheses outside quotes are the ones around a for-loop's list.
        for (const l of lines) {
            if (/^\s*rem\b/i.test(l)) continue;
            if (/^echo\b/i.test(l)) {
                // A message is plain text; the only thing it expands is the runner's exit code. Paths are echoed through delayed expansion (!NODE_BIN!), which is not re-read as commands.
                expect(l, "echo with a path variable").not.toMatch(/%(NODE|OLD|TN_|~|PSEXE)/);
                continue;
            }
            const outside = l.replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, "``").replace(/'[^']*'/g, "''");
            expect(outside, "else").not.toMatch(/\belse\b/i);
            // A for-loop list is the one place a pair of parentheses is needed (after an optional "if defined X").
            const rest = outside.replace(/\bfor (?:\/\w )?(?:"" )?%%\w in \([^()]*\) do\b/gi, "for-loop do");
            expect(rest, l).not.toMatch(/[()]/);
        }
    });

    it("has a label for every goto and every call, and the labels are plain lower-case words", () => {
        const labels = new Set(lines.flatMap((l) => (/^:([a-z]+)\s*$/.test(l) ? [l.slice(1).trim()] : [])));
        for (const l of lines) {
            if (/^:/.test(l) && !/^:[a-z]+\s*$/.test(l)) throw new Error(`label with odd characters: ${l}`);
        }
        const gotos = [...CMD.matchAll(/goto ([a-z]+)/g)].map((m) => m[1]!);
        const calls = [...CMD.matchAll(/call :([a-z]+)/g)].map((m) => m[1]!);
        expect(gotos.length).toBeGreaterThan(20);
        expect(calls.length).toBeGreaterThan(10);
        for (const t of [...gotos, ...calls]) expect(labels.has(t), t).toBe(true);
    });

    it("keeps PowerShell's work free of percent signs and double quotes, which cmd.exe would read as its own", () => {
        const ps = CMD.split("\r\n").find((l) => l.includes("DoNotExpandEnvironmentNames"))!;
        const command = ps.slice(ps.indexOf("-Command ") + "-Command ".length);
        const inner = command.slice(command.indexOf('"') + 1, command.lastIndexOf('" 2^>nul'));
        expect(inner).not.toContain("%");
        expect(inner).not.toContain('"');
    });
});

// ── running them ────────────────────────────────────────────────────────────

let tmp: string;
beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-kit-node-"));
});
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

const REAL_NODE = fwd(process.execPath);

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
/** Only the standard tools (dirname, uname, tr, mktemp, cat, rm, sleep): no node. */
const TOOLS = BASH ? (process.platform === "win32" ? msys(path.dirname(BASH)) : "/usr/bin:/bin") : "";
/** A real node on the usual Unix places would be found by design, so the "nothing found" cases cannot run on such a computer. */
const HOST_HAS_UNIX_NODE = ["/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node", "/opt/local/bin/node"].some((p) => fs.existsSync(p));

let counter = 0;
const fresh = (...parts: string[]) => {
    const dir = path.join(tmp, `${++counter}`, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/** A "node" that says it is `version` and otherwise runs this computer's Node.js. */
function shim(file: string, version: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n    --version|-v) echo ${version} ;;\n    *) exec "${REAL_NODE}" "$@" ;;\nesac\n`, { mode: 0o755 });
    return file;
}

/** A kit folder with the start scripts and a stub runner.mjs that says which Node.js ran it. Folder names have spaces and brackets on purpose. */
function kitWith(scripts: Array<[string, string]>): string {
    const dir = fresh("Maya Singh", "runner (1)");
    for (const [name, text] of scripts) fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "runner.mjs"), 'console.log("RUNNER-RAN " + process.version); process.exit(0);\n');
    return dir;
}

/** Git Bash prints C:/Users/.../Temp/x as /tmp/x, so the path is compared by its tail inside the temp folder. */
function expectUsing(out: string, version: string, file: string): void {
    const tail = fwd(path.relative(tmp, file));
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(out).toMatch(new RegExp(`Using Node\\.js ${escape(version)} from \\S*${escape(tail)}\\.`));
}

function expectFound(out: string, version: string, file: string): void {
    const tail = fwd(path.relative(tmp, file));
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(out).toMatch(new RegExp(`Found Node\\.js ${escape(version)} at \\S*${escape(tail)}\\.`));
}

interface Ran {
    status: number | null;
    out: string;
}
function runSh(kit: string, home: string, env: Record<string, string> = {}, shell: string | undefined = BASH, args: string[] = []): Ran {
    const r = spawnSync(shell!, [...args, "start-runner.sh"], {
        cwd: kit,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { HOME: fwd(home), PATH: TOOLS, SYSTEMROOT: process.env.SYSTEMROOT ?? "", TMPDIR: fwd(os.tmpdir()), AITP_KIT_SKIP_INSTALL: "1", AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", ...env } as NodeJS.ProcessEnv,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\r/g, "") };
}

describe.skipIf(!BASH)("start-runner.sh really runs", () => {
    const kitDir = () => kitWith([["start-runner.sh", SH]]);

    it("passes a syntax check under bash, bash in POSIX mode and dash (and sh when it is another shell)", () => {
        const dir = kitDir();
        for (const [shell, args] of [[BASH, ["-n"]], [BASH, ["--posix", "-n"]], [DASH, ["-n"]], [findShell("sh"), ["-n"]]] as const) {
            if (!shell) continue;
            const r = spawnSync(shell, [...args, "start-runner.sh"], { cwd: dir, encoding: "utf8", timeout: 20_000 });
            expect(r.status, `${path.basename(shell)} ${args.join(" ")}: ${r.stderr}`).toBe(0);
        }
        const c = kitWith([["start-runner.command", COMMAND]]);
        expect(spawnSync(BASH!, ["-n", "start-runner.command"], { cwd: c, encoding: "utf8" }).status).toBe(0);
    });

    for (const [label, shell] of [["bash", BASH], ["dash", DASH]] as const) {
        it.skipIf(!shell)(`${label}: finds an nvm install that is not on the PATH, says which one it uses, and runs the runner with it`, () => {
            const home = fresh("home");
            const node = shim(path.join(home, ".nvm", "versions", "node", "v26.1.0", "bin", "node"), "v26.1.0");
            const r = runSh(kitDir(), home, {}, shell);
            expectUsing(r.out, "v26.1.0", node);
            expect(r.out).toContain("RUNNER-RAN");
            expect(r.out).not.toMatch(/not installed|was not found|too old/);
            expect(r.status).toBe(0);
        });
    }

    it("finds a Volta install", () => {
        const home = fresh("home");
        const node = shim(path.join(home, ".volta", "bin", "node"), "v25.2.0");
        const r = runSh(kitDir(), home);
        expectUsing(r.out, "v25.2.0", node);
        expect(r.status).toBe(0);
    });

    it("finds fnm's (both layouts), asdf's and mise's", () => {
        for (const rel of [
            [".local", "share", "fnm", "node-versions", "v26.0.0", "installation", "bin"],
            ["Library", "Application Support", "fnm", "node-versions", "v26.0.0", "installation", "bin"],
            [".asdf", "shims"],
            [".local", "share", "mise", "shims"],
            [".nodenv", "shims"],
            [".n", "bin"],
        ]) {
            const home = fresh("home");
            const node = shim(path.join(home, ...rel, "node"), "v26.0.0");
            const r = runSh(kitDir(), home);
            expectUsing(r.out, "v26.0.0", node);
        }
    });

    it("finds a Homebrew-style folder (the tests name it with AITP_KIT_EXTRA_NODE_DIRS, the real script looks in /opt/homebrew/bin)", () => {
        const home = fresh("home");
        const brew = fresh("opt", "homebrew (arm)", "bin");
        const node = shim(path.join(brew, "node"), "v26.0.0");
        const r = runSh(kitDir(), home, { AITP_KIT_EXTRA_NODE_DIRS: `${msys(fresh("elsewhere"))}:${msys(brew)}` });
        expectUsing(r.out, "v26.0.0", node);
        expect(r.status).toBe(0);
    });

    it("puts the Node.js it chose first on the PATH, so npm, npx and the runner use the same one", () => {
        const home = fresh("home");
        shim(path.join(home, ".nvm", "versions", "node", "v26.1.0", "bin", "node"), "v26.1.0");
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.mjs"), 'import path from "node:path";\nconsole.log("FIRST-ON-PATH " + process.env.PATH.split(path.delimiter)[0]);\nprocess.exit(0);\n');
        const r = runSh(dir, home);
        expect(r.out).toMatch(/FIRST-ON-PATH .*v26\.1\.0.bin/);
    });

    it("skips an old Node.js that comes first and uses a newer one found later", () => {
        const home = fresh("home");
        shim(path.join(home, ".volta", "bin", "node"), "v20.11.0"); // looked at first
        const good = shim(path.join(home, ".nvm", "versions", "node", "v26.0.0", "bin", "node"), "v26.0.0");
        const r = runSh(kitDir(), home);
        expectUsing(r.out, "v26.0.0", good);
        expect(r.out).not.toContain("too old"); // it only complains when nothing usable is left
        expect(r.status).toBe(0);
    });

    it("skips an old Node.js that is first on the PATH itself", () => {
        const home = fresh("home");
        const oldDir = fresh("pathold");
        const newDir = fresh("pathnew");
        shim(path.join(oldDir, "node"), "v18.19.0");
        const good = shim(path.join(newDir, "node"), "v24.3.0");
        const r = runSh(kitDir(), home, { PATH: `${msys(oldDir)}:${msys(newDir)}:${TOOLS}` });
        expectUsing(r.out, "v24.3.0", good);
    });

    it("reads nvm the way a terminal would when it lives somewhere unusual", () => {
        const home = fresh("home");
        const nvmDir = fresh("my nvm (custom)");
        const good = path.join(fresh("custom node", "bin"), "node");
        shim(good, "v26.0.0");
        fs.writeFileSync(path.join(nvmDir, "nvm.sh"), `nvm() { PATH="${msys(path.dirname(good))}:$PATH"; export PATH; }\n`);
        const r = runSh(kitDir(), home, { NVM_DIR: fwd(nvmDir) });
        expectUsing(r.out, "v26.0.0", good);
    });

    it("asks the person's own login shell as a last resort, and takes the answer past the noise a profile prints", () => {
        const home = fresh("home");
        const good = shim(path.join(fresh("shellnode", "bin"), "node"), "v26.0.0");
        const shell = path.join(fresh("fakeshell"), "myshell");
        fs.writeFileSync(shell, `#!/bin/sh\necho "Welcome back! (printed by a profile)"\necho "not a path"\necho ${msys(good)}\n`, { mode: 0o755 });
        const r = runSh(kitDir(), home, { SHELL: fwd(shell), AITP_KIT_SKIP_SHELL_SEARCH: "0" });
        expectUsing(r.out, "v26.0.0", good);
        expect(r.out).not.toContain("Welcome back"); // the profile's noise is not echoed
    });

    it("gives up on a login shell that never answers, after a few seconds, without hanging", () => {
        const home = fresh("home");
        const shell = path.join(fresh("slowshell"), "myshell");
        fs.writeFileSync(shell, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
        const started = Date.now();
        const r = runSh(kitDir(), home, { SHELL: fwd(shell), AITP_KIT_SKIP_SHELL_SEARCH: "0" });
        const seconds = (Date.now() - started) / 1000;
        expect(seconds).toBeLessThan(40);
        if (!HOST_HAS_UNIX_NODE) {
            expect(r.out).toContain("Node.js was not found on this computer");
            expect(r.status).toBe(1);
        }
        expect(r.out).not.toMatch(/Killed|Terminated/); // no shell job messages leak out
    }, 90_000);

    it.skipIf(HOST_HAS_UNIX_NODE)("a Node.js that is too old is reported as too old, with its version and where it is, never as missing", () => {
        const home = fresh("home");
        const old = shim(path.join(home, ".nvm", "versions", "node", "v20.11.0", "bin", "node"), "v20.11.0");
        const r = runSh(kitDir(), home);
        expect(r.status).toBe(1);
        expectFound(r.out, "v20.11.0", old);
        expect(r.out).toContain(". That is too old, the runner needs 24 or newer.");
        expect(r.out).toContain("To update, install the LTS version from https://nodejs.org");
        expect(r.out).not.toMatch(/not installed|was not found/);
        expect(r.out).not.toContain("RUNNER-RAN");
    });

    it.skipIf(HOST_HAS_UNIX_NODE)("says which of several old ones it found", () => {
        const home = fresh("home");
        const a = shim(path.join(home, ".volta", "bin", "node"), "v18.19.0");
        const b = shim(path.join(home, ".nvm", "versions", "node", "v22.4.1", "bin", "node"), "v22.4.1");
        const r = runSh(kitDir(), home);
        expectFound(r.out, "v18.19.0", a);
        expectFound(r.out, "v22.4.1", b);
    });

    it.skipIf(HOST_HAS_UNIX_NODE)("with no Node.js anywhere it says so, says where it looked, how to install, and starts nothing", () => {
        const r = runSh(kitDir(), fresh("emptyhome"));
        expect(r.status).toBe(1);
        expect(r.out).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(r.out).toContain("I looked on the PATH, in the Homebrew, nvm, fnm, Volta, asdf, mise, nodenv and n folders, and asked your login shell.");
        for (const how of ["https://nodejs.org", "brew install node", "nvm install 24"]) expect(r.out, how).toContain(how);
        expect(r.out).not.toMatch(/not installed|too old/);
        expect(r.out).not.toContain("RUNNER-RAN");
    });

    it("treats a node that prints rubbish for --version as unusable, not as a version", () => {
        const home = fresh("home");
        const junk = path.join(home, ".volta", "bin", "node");
        fs.mkdirSync(path.dirname(junk), { recursive: true });
        fs.writeFileSync(junk, "#!/bin/sh\necho 'command not found: node (no version is set)'\nexit 1\n", { mode: 0o755 });
        const good = shim(path.join(home, ".nvm", "versions", "node", "v26.0.0", "bin", "node"), "v26.0.0");
        const r = runSh(kitDir(), home);
        expectUsing(r.out, "v26.0.0", good);
    });

    it("a runner that asks to stop for good ends the script with that code and a plain message", () => {
        const home = fresh("home");
        shim(path.join(home, ".volta", "bin", "node"), "v26.0.0");
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.mjs"), "process.exit(3);\n");
        const r = runSh(dir, home);
        expect(r.status).toBe(3);
        expect(r.out).toContain("The platform no longer accepts this runner.");
    });
});

// ── Windows ─────────────────────────────────────────────────────────────────

const WIN = process.platform === "win32";
const SYS32 = WIN ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "";

/** An environment where every place the script looks is an empty folder of ours, and the PATH holds only Windows' own tools. */
function winEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const d = (...p: string[]) => {
        const x = path.join(root, ...p);
        fs.mkdirSync(x, { recursive: true });
        return x;
    };
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NVM_|VOLTA|PATH$|PROGRAMFILES|PROGRAMW6432|LOCALAPPDATA$|APPDATA$|AITP_)/i.test(k)));
    return {
        ...keep,
        PATH: SYS32,
        // Windows gives a 64-bit process its ProgramFiles from ProgramW6432, so the two are the same folder here too.
        ProgramFiles: d("pf64", "Program Files"),
        ProgramW6432: d("pf64", "Program Files"),
        "ProgramFiles(x86)": d("pf86", "Program Files (x86)"),
        LOCALAPPDATA: d("local"),
        APPDATA: d("roaming"),
        AITP_KIT_SKIP_INSTALL: "1",
        AITP_KIT_NO_PAUSE: "1",
        AITP_KIT_SKIP_SHELL_SEARCH: "1",
        ...extra,
    };
}
/** node.exe for a fake install: a hard link to this computer's Node.js (a copy if the disks differ), so it really runs and reports its real version. */
function realNodeExe(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
        fs.linkSync(process.execPath, file);
    } catch {
        fs.copyFileSync(process.execPath, file);
    }
    return file;
}
/** A node.cmd that only prints a version: the "too old" install (and one that claims a newer version than it is). */
function oldNodeCmd(file: string, version: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `@echo ${version}\r\n`);
    return file;
}
function runCmd(kit: string, env: NodeJS.ProcessEnv): Ran {
    const r = spawnSync("cmd.exe", ["/d", "/c", `.\\start-runner.cmd`], { cwd: kit, env, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/\r/g, "") };
}

describe.skipIf(!WIN)("start-runner.cmd really runs", () => {
    const kitDir = () => kitWith([["start-runner.cmd", CMD]]);
    const dirOf = (file: string) => path.dirname(file);

    it("finds a Node.js in Program Files (x86), in a folder with spaces and brackets, and says which one it uses", () => {
        const root = fresh("env");
        const env = winEnv(root);
        const exe = realNodeExe(path.join(env["ProgramFiles(x86)"]!, "nodejs", "node.exe"));
        const r = runCmd(kitDir(), env);
        expect(r.out).toContain(`Using Node.js ${process.version} from ${exe}.`);
        expect(r.out).toContain(`RUNNER-RAN ${process.version}`);
        expect(r.out).not.toMatch(/not installed|was not found|too old/);
        expect(r.status).toBe(0);
    });

    it("finds Volta, nvm-windows (NVM_HOME and the NVM_SYMLINK folder), fnm and the per-user install", () => {
        const cases: Array<[string, (env: NodeJS.ProcessEnv, root: string) => string]> = [
            ["volta", (env) => realNodeExe(path.join(env.LOCALAPPDATA!, "Volta", "bin", "node.exe"))],
            ["nvm-windows", (env, root) => realNodeExe(path.join((env.NVM_HOME = path.join(root, "nvm home (a)")), "v26.0.0", "node.exe"))],
            ["nvm symlink", (env, root) => realNodeExe(path.join((env.NVM_SYMLINK = path.join(root, "nvm symlink")), "node.exe"))],
            ["nvm in %APPDATA%", (env) => realNodeExe(path.join(env.APPDATA!, "nvm", "v26.0.0", "node.exe"))],
            ["fnm", (env) => realNodeExe(path.join(env.APPDATA!, "fnm", "node-versions", "v26.0.0", "installation", "node.exe"))],
            ["fnm multishell", (env) => realNodeExe(path.join(env.LOCALAPPDATA!, "fnm_multishells", "12345_678", "node.exe"))],
            ["per-user install", (env) => realNodeExe(path.join(env.LOCALAPPDATA!, "Programs", "nodejs", "node.exe"))],
            ["Program Files", (env) => realNodeExe(path.join(env.ProgramFiles!, "nodejs", "node.exe"))],
        ];
        for (const [name, setup] of cases) {
            const root = fresh("env");
            const env = winEnv(root);
            const exe = setup(env, root);
            const r = runCmd(kitDir(), env);
            expect(r.out, name).toContain(`Using Node.js ${process.version} from ${exe}.`);
            expect(r.status, name).toBe(0);
        }
    });

    it("honours VOLTA_HOME", () => {
        const root = fresh("env");
        const env = winEnv(root, { VOLTA_HOME: path.join(root, "my volta") });
        const exe = realNodeExe(path.join(root, "my volta", "bin", "node.exe"));
        expect(runCmd(kitDir(), env).out).toContain(`Using Node.js ${process.version} from ${exe}.`);
    });

    it("takes a folder from AITP_KIT_EXTRA_NODE_DIRS even when its name has brackets and spaces", () => {
        const root = fresh("env");
        const a = path.join(root, "first (empty)");
        fs.mkdirSync(a, { recursive: true });
        const exe = realNodeExe(path.join(root, "Node (portable)", "bin", "node.exe"));
        const env = winEnv(root, { AITP_KIT_EXTRA_NODE_DIRS: `${a};${dirOf(exe)}` });
        const r = runCmd(kitDir(), env);
        expect(r.out).toContain(`Using Node.js ${process.version} from ${exe}.`);
    });

    it("skips an old Node.js that comes first and uses a newer one found later", () => {
        const root = fresh("env");
        const env = winEnv(root);
        oldNodeCmd(path.join(env.ProgramFiles!, "nodejs", "node.cmd"), "v20.11.0");
        const good = realNodeExe(path.join(env.LOCALAPPDATA!, "Volta", "bin", "node.exe"));
        const r = runCmd(kitDir(), env);
        expect(r.out).toContain(`Using Node.js ${process.version} from ${good}.`);
        expect(r.out).not.toContain("too old");
        expect(r.status).toBe(0);
    });

    it("a Node.js that is too old is reported as too old, with its version and where it is, never as missing", () => {
        const root = fresh("env");
        const env = winEnv(root);
        const old = oldNodeCmd(path.join(env["ProgramFiles(x86)"]!, "nodejs", "node.cmd"), "v20.11.0");
        const r = runCmd(kitDir(), env);
        expect(r.status).toBe(1);
        expect(r.out).toContain(`Found Node.js v20.11.0 at ${old}. That is too old, the runner needs 24 or newer.`);
        expect(r.out).toContain("To update: install the LTS version from https://nodejs.org");
        expect(r.out).not.toMatch(/not installed|was not found/);
        expect(r.out).not.toContain("RUNNER-RAN");
    });

    it("says which of several old ones it found", () => {
        const root = fresh("env");
        const env = winEnv(root);
        const a = oldNodeCmd(path.join(env.ProgramFiles!, "nodejs", "node.cmd"), "v18.19.0");
        const b = oldNodeCmd(path.join(env.LOCALAPPDATA!, "Volta", "bin", "node.cmd"), "v22.4.1");
        const r = runCmd(kitDir(), env);
        expect(r.out).toContain(`Found Node.js v18.19.0 at ${a}.`);
        expect(r.out).toContain(`Found Node.js v22.4.1 at ${b}.`);
    });

    it("with no Node.js anywhere it says so, says where it looked, how to install, and starts nothing", () => {
        const r = runCmd(kitDir(), winEnv(fresh("env")));
        expect(r.status).toBe(1);
        expect(r.out).toContain("Node.js was not found on this computer. The runner needs Node.js 24 or newer.");
        expect(r.out).toContain("I looked on the PATH, in Program Files, in the nvm-windows, Volta and fnm folders, and in the PATH saved in Windows.");
        expect(r.out).toContain("https://nodejs.org");
        expect(r.out).not.toMatch(/not installed|too old/);
        expect(r.out).not.toContain("RUNNER-RAN");
    });

    it("never runs text a node prints for --version (a line that is not shaped like a version is ignored)", () => {
        const root = fresh("env");
        const env = winEnv(root);
        const marker = path.join(root, "INJECTED.txt");
        oldNodeCmd(path.join(env.ProgramFiles!, "nodejs", "node.cmd"), `v26.1.0 ^& echo hacked ^> "${marker}"`);
        const r = runCmd(kitDir(), env);
        expect(fs.existsSync(marker)).toBe(false);
        expect(r.out).not.toContain("hacked");
        expect(r.out).toContain("was not found");
    });

    it("does not break on odd characters in the Node.js path (an ampersand and an exclamation mark)", () => {
        const root = fresh("env");
        const env = winEnv(root);
        const exe = realNodeExe(path.join(env.ProgramFiles!, "Node & Co!", "node.exe"));
        env.AITP_KIT_EXTRA_NODE_DIRS = dirOf(exe);
        const r = runCmd(kitDir(), env);
        expect(r.out).toContain(`Using Node.js ${process.version} from ${exe}.`);
        expect(r.status).toBe(0);
    });

    it("asks PowerShell as a last resort, which reads the PATH Windows has saved (this computer's own Node.js, when it has one there)", () => {
        // Probe the same thing the script does, so the test is honest about what it can prove on this computer.
        const probe = spawnSync(path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", "foreach ($s in 'Machine','User') { $p = [Environment]::GetEnvironmentVariable('Path', $s); if ($p) { foreach ($d in $p.Split(';')) { if ($d -and (Test-Path -LiteralPath (Join-Path $d 'node.exe'))) { 'yes' } } } }"], { encoding: "utf8", timeout: 30_000 });
        if (!/yes/.test(probe.stdout)) return; // this computer has no Node.js in its saved PATH: nothing to find
        const env = winEnv(fresh("env"), { AITP_KIT_SKIP_SHELL_SEARCH: "0" });
        const r = runCmd(kitDir(), env);
        expect(r.out).toMatch(/Using Node\.js v\d+\.\d+\.\d+ from .*node\.exe\./);
        expect(r.out).toContain("RUNNER-RAN");
        expect(r.status).toBe(0);
    }, 120_000);

    it("works from a folder with spaces and brackets and keeps the runner's exit code 3 as its own plain message", () => {
        const root = fresh("env");
        const env = winEnv(root);
        realNodeExe(path.join(env.ProgramFiles!, "nodejs", "node.exe"));
        const dir = kitDir();
        fs.writeFileSync(path.join(dir, "runner.mjs"), "process.exit(3);\n");
        const r = runCmd(dir, env);
        expect(dir).toMatch(/Maya Singh.runner \(1\)$/);
        expect(r.status).toBe(1);
        expect(r.out).toContain("The platform no longer accepts this runner.");
    });
});
