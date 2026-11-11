/**
 * The start scripts and runner updates: exit code 75 means "the runner switched to a new version of itself, start it again now" (no
 * 5 second pause, no "stopped unexpectedly"), and a new Node.js staged by the update in .update/node-next is swapped into the node folder
 * while nothing runs it (the old one kept in .update/node-previous). Also the company-network follow-up: npm gets NODE_USE_SYSTEM_CA=1 and,
 * when no proxy variable is set, runner.json's "proxy" as HTTPS_PROXY, for npm only and never printed.
 *
 * start-runner.cmd runs under cmd.exe, start-runner.sh under Git Bash, in a folder laid out like a download, with a stand-in runner.mjs
 * (it exits 75 on its first start and 0 on its second, and says which Node.js folder and which variables it sees) and a stand-in npm.
 * Node.js is this computer's own (a hard link for node.exe, a two-line shim for node/bin/node); no Node.js is on the PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { START_CMD, START_SH, withLineEnding } from "../src/platform/runner-kit-scripts.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-upd-scripts-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const fwd = (p: string) => p.replace(/\\/g, "/");
const msys = (p: string) => (process.platform === "win32" ? fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`) : p);
function findBash(): string | undefined {
    for (const c of [process.env.KIT_TEST_BASH, "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "/bin/bash"]) {
        if (!c || !fs.existsSync(c)) continue;
        const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8", timeout: 20_000 });
        if (r.status === 0 && r.stdout.trim() === "ok") return c;
    }
    return undefined;
}
const BASH = findBash();
/** The start scripts refuse a Node.js older than 24, and these tests use this computer's own Node.js as the download's, so on an older one
 * they can only show the "too old" message: they run on Node.js 24 (as CI does) and are skipped, for that reason, on anything older. */
const NODE_24 = Number(process.versions.node.split(".")[0]) >= 24;
const PROXY = "http://maya:Pr0xyPass9@proxy.example:8080";

const STAND_IN = `import fs from "node:fs";
const n = Number(fs.existsSync("count.txt") ? fs.readFileSync("count.txt", "utf8") : "0") + 1;
fs.writeFileSync("count.txt", String(n));
const which = fs.existsSync("node/which.txt") ? fs.readFileSync("node/which.txt", "utf8").trim() : "none";
console.log("STAND-IN start=" + n + " node=" + which + " proxy=" + (process.env.HTTPS_PROXY ? "set" : "none") + " ca=" + (process.env.NODE_USE_SYSTEM_CA ?? "none"));
process.exit(n === 1 ? 75 : 0);
`;
/** What npm saw, written by the stand-in npm into the folder. */
const NPM_JS = `const fs = require("fs"); fs.writeFileSync("npm-saw.json", JSON.stringify({ args: process.argv.slice(2), proxy: process.env.HTTPS_PROXY || "", ca: process.env.NODE_USE_SYSTEM_CA || "" })); fs.mkdirSync("node_modules/@playwright/test", { recursive: true }); fs.writeFileSync("node_modules/@playwright/test/package.json", "{}");`;

function kitFolder(label: string, runnerJson: Record<string, unknown> = {}): string {
    const kit = fs.mkdtempSync(path.join(tmp, `${label}-`));
    fs.writeFileSync(path.join(kit, "start-runner.cmd"), withLineEnding(START_CMD, "\r\n"));
    fs.writeFileSync(path.join(kit, "start-runner.sh"), withLineEnding(START_SH, "\n"));
    fs.writeFileSync(path.join(kit, "runner.mjs"), STAND_IN);
    fs.writeFileSync(path.join(kit, "runner.json"), JSON.stringify({ url: "https://platform.example", name: "Maya", kitVersion: "1.0.0+aaaa", ...runnerJson }));
    fs.writeFileSync(path.join(kit, "runner.token"), "aitg_never-printed-token-123456\n");
    fs.writeFileSync(path.join(kit, "npm-stand-in.cjs"), NPM_JS);
    return kit;
}
const linkNode = (to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.linkSync(process.execPath, to);
    } catch {
        fs.copyFileSync(process.execPath, to);
    }
};
const shim = (to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, `#!/bin/sh\nexec "${msys(process.execPath)}" "$@"\n`, { mode: 0o755 });
};

function pathWithoutNode(): string {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    return [path.join(sys, "System32"), sys, path.join(sys, "System32", "Wbem"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";");
}
const bashPathWithoutNode = () => ["/usr/bin", "/bin", msys(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"))].join(":");

function run(command: string, args: string[], cwd: string, env: Record<string, string>): { code: number | null; out: string } {
    const r = spawnSync(command, args, {
        cwd,
        env: { SystemRoot: process.env.SystemRoot ?? "", SYSTEMROOT: process.env.SystemRoot ?? "", ComSpec: process.env.ComSpec ?? "", PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", TEMP: tmp, TMP: tmp, AITP_KIT_NO_PAUSE: "1", AITP_KIT_SKIP_SHELL_SEARCH: "1", ...env } as NodeJS.ProcessEnv,
        encoding: "utf8",
        windowsHide: true,
        timeout: 90_000,
    });
    return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const cmdEnv = () => ({ PATH: pathWithoutNode(), Path: pathWithoutNode(), LOCALAPPDATA: path.join(tmp, "no-localappdata"), APPDATA: path.join(tmp, "no-appdata") });

describe("start-runner.cmd", () => {
    it("names exit code 75 in both scripts", () => {
        expect(START_CMD).toContain('if "%CODE%"=="75" goto updated');
        expect(START_SH).toMatch(/\n {8}75\)\n/);
    });

    it.skipIf(process.platform !== "win32" || !NODE_24)("restarts the runner at once on exit code 75 and swaps in the Node.js the update staged", () => {
        const kit = kitFolder("cmd-swap");
        linkNode(path.join(kit, "node", "node.exe"));
        fs.writeFileSync(path.join(kit, "node", "which.txt"), "old");
        linkNode(path.join(kit, ".update", "node-next", "node.exe"));
        fs.writeFileSync(path.join(kit, ".update", "node-next", "which.txt"), "new");
        const started = Date.now();
        const r = run("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { ...cmdEnv(), AITP_KIT_SKIP_INSTALL: "1" });
        expect(r.out).toContain("STAND-IN start=1 node=old");
        expect(r.out).toContain("The runner updated itself. Starting the new version.");
        expect(r.out).toContain("STAND-IN start=2 node=new");
        expect(r.out).not.toContain("stopped unexpectedly");
        expect(r.out).toContain("The runner stopped.");
        expect(r.code).toBe(0);
        // No 5 second pause.
        expect(Date.now() - started).toBeLessThan(30_000);
        expect(fs.readFileSync(path.join(kit, ".update", "node-previous", "which.txt"), "utf8")).toBe("old");
        expect(fs.existsSync(path.join(kit, ".update", "node-next"))).toBe(false);
        expect(r.out).not.toContain("never-printed-token");
    });

    it.skipIf(process.platform !== "win32" || !NODE_24)("gives npm the company certificate store and runner.json's proxy, for npm only, without printing it", () => {
        const kit = kitFolder("cmd-npm", { proxy: PROXY });
        linkNode(path.join(kit, "node", "node.exe"));
        fs.writeFileSync(path.join(kit, "node", "npm.cmd"), "@echo off\r\nnode npm-stand-in.cjs %*\r\n");
        const r = run("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, cmdEnv());
        expect(r.out).toContain("First start: installing the test tools.");
        const saw = JSON.parse(fs.readFileSync(path.join(kit, "npm-saw.json"), "utf8"));
        expect(saw).toEqual({ args: ["install", "--no-audit", "--no-fund"], proxy: PROXY, ca: "1" });
        // The runner itself reads runner.json's proxy on its own (its source stays "runner.json"): the variables were for npm only.
        expect(r.out).toContain("STAND-IN start=1 node=none proxy=none ca=none");
        expect(r.out).not.toContain("Pr0xyPass9");
        expect(r.code).toBe(0);
    });

    it.skipIf(process.platform !== "win32" || !NODE_24)("leaves a proxy variable that is already set alone", () => {
        const kit = kitFolder("cmd-npm-env", { proxy: PROXY });
        linkNode(path.join(kit, "node", "node.exe"));
        fs.writeFileSync(path.join(kit, "node", "npm.cmd"), "@echo off\r\nnode npm-stand-in.cjs %*\r\n");
        run("cmd.exe", ["/d", "/c", ".\\start-runner.cmd"], kit, { ...cmdEnv(), HTTPS_PROXY: "http://other.example:3128" });
        expect(JSON.parse(fs.readFileSync(path.join(kit, "npm-saw.json"), "utf8")).proxy).toBe("http://other.example:3128");
    });
});

describe("start-runner.sh (Git Bash)", () => {
    it.skipIf(!BASH || !NODE_24)("restarts the runner at once on exit code 75 and swaps in the Node.js the update staged", () => {
        const kit = kitFolder("sh-swap");
        shim(path.join(kit, "node", "bin", "node"));
        fs.writeFileSync(path.join(kit, "node", "which.txt"), "old");
        shim(path.join(kit, ".update", "node-next", "bin", "node"));
        fs.writeFileSync(path.join(kit, ".update", "node-next", "which.txt"), "new");
        const r = run(BASH!, ["start-runner.sh"], kit, { PATH: bashPathWithoutNode(), HOME: msys(path.join(tmp, "home")), AITP_KIT_SKIP_INSTALL: "1" });
        expect(r.out).toContain("STAND-IN start=1 node=old");
        expect(r.out).toContain("The runner updated itself. Starting the new version.");
        expect(r.out).toContain("STAND-IN start=2 node=new");
        expect(r.out).not.toContain("stopped unexpectedly");
        expect(r.code).toBe(0);
        expect(fs.readFileSync(path.join(kit, ".update", "node-previous", "which.txt"), "utf8")).toBe("old");
    });

    it.skipIf(!BASH || !NODE_24)("gives npm the company certificate store and runner.json's proxy, for npm only, without printing it", () => {
        const kit = kitFolder("sh-npm", { proxy: PROXY });
        shim(path.join(kit, "node", "bin", "node"));
        fs.writeFileSync(path.join(kit, "node", "bin", "npm"), `#!/bin/sh\nexec node npm-stand-in.cjs "$@"\n`, { mode: 0o755 });
        const r = run(BASH!, ["start-runner.sh"], kit, { PATH: bashPathWithoutNode(), HOME: msys(path.join(tmp, "home2")) });
        const saw = JSON.parse(fs.readFileSync(path.join(kit, "npm-saw.json"), "utf8"));
        expect(saw).toEqual({ args: ["install", "--no-audit", "--no-fund"], proxy: PROXY, ca: "1" });
        expect(r.out).toContain("STAND-IN start=1 node=none proxy=none ca=none");
        expect(r.out).not.toContain("Pr0xyPass9");
        expect(r.code).toBe(0);
    });
});
