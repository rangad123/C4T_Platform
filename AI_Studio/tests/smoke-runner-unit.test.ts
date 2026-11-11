/**
 * The runner smoke script (scripts/smoke-runner.mjs) without a real platform: its arguments, the decisions it makes about a download
 * answer (including the plain skip when the complete download is not built), the PATH without Node.js, the environments it hands to the
 * platform and to the runner, the report and the secrets kept out of it, unpacking a zip with its Unix permissions, stopping ONLY the
 * processes it started (with what they started, while a process it did not start survives), and a whole run against a small stand-in
 * platform that ends in the "complete download missing" skip with everything it started stopped.
 *
 * The real run (a real platform, a real downloaded runner started by start-runner.cmd) is `node scripts/smoke-runner.mjs`; it was run on
 * this Windows laptop with the plain kit (see docs/features/real-machine-checks.md) and runs on six kinds of machine in
 * .github/workflows/runner-matrix.yml. Ports: stand-in platform 6960, sample app 6961.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript script (no type declarations)
import { Children, hostTarget, interpretKitAnswer, kitRequestBody, parseArgs, pathWithoutNode, plainCredentialsIn, platformEnv, redact, renderReport, runnerEnv, runSmoke, startCommand, unpackZip, usedBundledNode, UsageError, zipModes } from "../scripts/smoke-runner.mjs";

const WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-smoke-unit-"));
const ours: ChildProcess[] = [];
afterAll(() => {
    for (const c of ours) if (c.exitCode === null && c.signalCode === null) c.kill();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

const usage = (argv: string[]): string => {
    try {
        parseArgs(argv);
    } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        return (e as Error).message;
    }
    throw new Error("expected a usage error");
};

describe("arguments", () => {
    it("has plain defaults", () => {
        expect(parseArgs([])).toMatchObject({ kit: "files", port: 6950, noNodeOnPath: false, linkNodeModules: false, onlineTimeout: 900, testTimeout: 300, keep: false });
        expect(parseArgs([])).not.toHaveProperty("name"); // round 45: the runner is named after the computer
        expect(parseArgs(["--kit", "files", "--link-node-modules"]).onlineTimeout).toBe(180);
        expect(parseArgs(["--kit", "complete", "--no-node-on-path", "--port", "6954", "--online-timeout", "60", "--out", "rep"])).toMatchObject({ kit: "complete", noNodeOnPath: true, port: 6954, onlineTimeout: 60, out: path.resolve("rep") });
        expect(parseArgs(["--help"]).help).toBe(true);
    });

    it("explains mistakes in plain words", () => {
        expect(usage(["--kit", "zip"])).toBe("--kit must be one of: files, installer, complete.");
        expect(usage(["--port", "80"])).toBe("--port must be between 1024 and 65534.");
        expect(usage(["--port", "abc"])).toBe("--port needs a whole number.");
        expect(usage(["--port"])).toBe("--port needs a value.");
        expect(usage(["--no-node-on-path"])).toMatch(/only makes sense with --kit complete/);
        expect(usage(["--kit", "complete", "--link-node-modules"])).toBe("--link-node-modules only works with --kit files.");
        expect(usage(["--build-runner", "--runner-kit-dir", "x"])).toBe("Use --build-runner or --runner-kit-dir, not both.");
        expect(usage(["--name", "x"])).toBe("Unknown option --name. Run with --help to see the options.");
        expect(usage(["--frobnicate"])).toBe("Unknown option --frobnicate. Run with --help to see the options.");
    });

    it("the command line answers wrong arguments with exit code 2 and --help with 0, starting nothing", () => {
        const script = fileURLToPath(new URL("../scripts/smoke-runner.mjs", import.meta.url));
        const bad = spawnSync(process.execPath, [script, "--kit", "nope"], { encoding: "utf8", timeout: 30_000 });
        expect(bad.status).toBe(2);
        expect(bad.stderr.trim()).toBe("--kit must be one of: files, installer, complete.");
        const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 30_000 });
        expect(help.status).toBe(0);
        expect(help.stdout).toContain("--no-node-on-path");
    });
});

describe("decisions", () => {
    const win = hostTarget("win32", "x64");
    const mac = hostTarget("darwin", "arm64");
    const linux = hostTarget("linux", "arm64");

    it("names the computer the way the platform and a person do", () => {
        expect(win).toEqual({ system: "windows", kitPlatform: "windows", arch: "x64", id: "win-x64", label: "Windows x64" });
        expect(mac).toEqual({ system: "mac", kitPlatform: "unix", arch: "arm64", id: "mac-arm64", label: "macOS ARM64" });
        expect(linux).toMatchObject({ kitPlatform: "unix", id: "linux-arm64" });
    });

    it("asks for this computer's one download with the route's own fields: the system and the processor", () => {
        expect(kitRequestBody(win)).toEqual({ os: "windows", arch: "x64" });
        expect(kitRequestBody(mac)).toEqual({ os: "mac", arch: "arm64" });
        expect(kitRequestBody(linux)).toEqual({ os: "linux", arch: "arm64" });
    });

    it("skips plainly when the download cannot be started the asked way here, and fails on real refusals", () => {
        expect(interpretKitAnswer("complete", linux, { status: 200, kind: "files" }).skip).toMatch(/^The download for linux-arm64 does not carry its own Node\.js: .*npm run build:runner -- --complete --targets linux-arm64/);
        expect(interpretKitAnswer("complete", win, { status: 200, kind: "installer", target: "win-x64" })).toEqual({ ok: true });
        expect(interpretKitAnswer("files", win, { status: 503, message: "The runner kit has not been built on this server." }).fail).toMatch(/no runner download/);
        expect(interpretKitAnswer("files", win, { status: 403, message: "Sign in with your own account to set up your runner." }).fail).toBe("The download was refused (403): Sign in with your own account to set up your runner.");
        expect(interpretKitAnswer("installer", linux, { status: 200 }).skip).toMatch(/no installer for Linux/);
        expect(interpretKitAnswer("installer", win, { status: 200, kind: "files", note: "The Windows installer was not built." }).skip).toMatch(/sent plain files instead\. The Windows installer was not built\./);
        expect(interpretKitAnswer("installer", win, { status: 200, kind: "installer" })).toEqual({ ok: true });
        expect(interpretKitAnswer("files", linux, { status: 200, kind: "files" })).toEqual({ ok: true });
    });

    it("starts each download the way its README says", () => {
        const w = startCommand("files", win, "K", "I");
        expect(path.basename(w.command).toLowerCase()).toBe("cmd.exe");
        expect(w.args).toEqual(["/d", "/c", ".\\start-runner.cmd"]);
        expect(startCommand("complete", linux, "K", "I")).toEqual({ command: "sh", args: ["start-runner.sh"] });
        expect(startCommand("installer", win, "K", "I")).toEqual({ command: path.join("K", "AITestingRunnerSetup.exe"), args: ["--silent", "--no-start-at-sign-in", "--install-dir", "I"] });
        expect(startCommand("installer", mac, "K", "I")).toEqual({ command: "sh", args: [path.join("K", "AI Testing Runner.app", "Contents", "Resources", "runner-setup.sh"), "--silent", "--no-autostart", "--install-dir", "I"] });
    });

    it("builds a PATH without Node.js, and says when a system folder holds it", () => {
        const winDirs = new Set(["C:\\Program Files\\nodejs\\node.exe", "C:\\nvm4w\\nodejs\\npm.cmd"]);
        const w = pathWithoutNode("C:\\Windows\\System32;C:\\Program Files\\nodejs;C:\\nvm4w\\nodejs;C:\\Git\\usr\\bin", { platform: "win32", exists: (p: string) => winDirs.has(p) });
        expect(w).toEqual({ value: "C:\\Windows\\System32;C:\\Git\\usr\\bin", removed: ["C:\\Program Files\\nodejs", "C:\\nvm4w\\nodejs"], essential: [] });
        const u = pathWithoutNode("/opt/hostedtoolcache/node/24/bin:/usr/local/bin:/usr/bin:/bin", { platform: "linux", exists: (p: string) => p === "/opt/hostedtoolcache/node/24/bin/node" || p === "/usr/local/bin/npx" });
        expect(u).toEqual({ value: "/usr/bin:/bin", removed: ["/opt/hostedtoolcache/node/24/bin", "/usr/local/bin"], essential: [] });
        expect(pathWithoutNode("/usr/bin:/bin", { platform: "linux", exists: (p: string) => p === "/usr/bin/node" }).essential).toEqual(["/usr/bin"]);
    });

    it("recognises the start script using the Node.js inside the download", () => {
        expect(usedBundledNode("Using the Node.js that came with this download (v24.11.0).", "/k")).toBe(true);
        expect(usedBundledNode("Using Node.js v24.11.0 from C:\\T\\runner (1)\\node\\node.exe.\r\n", "C:\\T\\runner (1)")).toBe(true);
        expect(usedBundledNode("Using Node.js v24.11.0 from /usr/local/bin/node.", "/tmp/kit")).toBe(false);
        expect(usedBundledNode("Connected to the platform", "/tmp/kit")).toBe(false);
    });
});

describe("environments and secrets", () => {
    it("the platform gets the computer's basics and its own settings, never a developer's data folder or model keys", () => {
        const env = platformEnv({ PATH: "/bin", HOME: "/h", DATA_DIR: "./data", ANTHROPIC_API_KEY: "real-model-key-123456", SMTP_HOST: "mail", RANDOM_THING: "x" }, { dataDir: "/t/data", apiKey: "k".repeat(20), port: 6960 });
        expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", DATA_DIR: "/t/data", PORT: "6960", HOST: "127.0.0.1", PUBLIC_URL: "http://127.0.0.1:6960", ANTHROPIC_API_KEY: "", WORKER_EMBEDDED: "true", SCHEDULER_ENABLED: "false" });
        expect(env.SMTP_HOST).toBeUndefined();
        expect(env.RANDOM_THING).toBeUndefined();
        expect(env.RUNNER_KIT_DIR).toBeUndefined();
        expect(platformEnv({}, { dataDir: "d", apiKey: "k", port: 1, runnerKitDir: "/kit", installerDir: "/inst" })).toMatchObject({ RUNNER_KIT_DIR: "/kit", RUNNER_INSTALLER_DIR: "/inst" });
    });

    it("the runner gets the person's environment without the platform's settings, and the clean PATH when asked", () => {
        const env = runnerEnv({ Path: "C:\\a", HOME: "/h", AGENT_URL: "x", RUNNER_KIT_DIR: "y", AITP_LOCK_HELD: "browser", API_KEY: "z", DATA_DIR: "d" }, { linkNodeModules: true, path: "C:\\clean" });
        expect(env).toEqual({ HOME: "/h", PATH: "C:\\clean", AITP_KIT_NO_PAUSE: "1", AITP_INSTALLER_NO_PAUSE: "1", AITP_INSTALLER_NO_UI: "1", AITP_KIT_SKIP_INSTALL: "1" });
        expect(runnerEnv({ PATH: "/bin" }).PATH).toBe("/bin");
        expect(runnerEnv({ PATH: "/bin" }).AITP_KIT_SKIP_INSTALL).toBeUndefined();
    });

    it("keeps the access key and any project token out of reports and logs", () => {
        expect(redact("key smoke-abcdef0123456789 token aitg_AbC123_xyz-987 end", ["smoke-abcdef0123456789"])).toBe("key *** token aitg_*** end");
        expect(redact("short", ["abc"])).toBe("short");
    });

    it("renders a short report for each outcome", () => {
        const base = { kit: "files", target: hostTarget("win32", "x64"), node: "v24.1.0", durationMs: 65_000, steps: [{ name: "Start the platform", status: "ok", ms: 1200, detail: "http://127.0.0.1:6950" }], tests: [{ title: "Home", kind: "web", status: "passed", where: 'ran on the runner "R"' }], notes: [] };
        const passed = renderReport({ ...base, verdict: "passed", outDir: "/out" });
        expect(passed).toContain("Runner smoke check passed: plain files, Windows x64, Node.js v24.1.0, 1 min 5 s.");
        expect(passed).toContain("  ok    Start the platform (1.2 s): http://127.0.0.1:6950");
        expect(passed).toContain('  ok    Home (web): passed, ran on the runner "R"');
        expect(passed).toContain("Report and logs: /out");
        const skipped = renderReport({ ...base, kit: "complete", noNodeOnPath: true, verdict: "skipped", skipReason: "not built", tests: [], steps: [{ name: "Download", status: "skipped", ms: 10, detail: "not built" }] });
        expect(skipped).toMatch(/^Runner smoke check skipped: complete download with no Node\.js on the PATH, /);
        expect(skipped).toContain("Skipped: not built");
        expect(skipped).toContain("  skip  Download (0.0 s): not built");
        expect(renderReport({ ...base, verdict: "failed", error: "It ended failed." })).toContain("Problem: It ended failed.");
    });
});

describe("unpacking", () => {
    const zip = (): string => {
        const file = path.join(tmp, "kit.zip");
        const attrs = (m: number) => (0o100000 | m) * 65536;
        fs.writeFileSync(
            file,
            zipSync({
                "runner-x/start-runner.sh": [new TextEncoder().encode("echo hi\n"), { os: 3, attrs: attrs(0o755) }],
                "runner-x/node/bin/node": [new TextEncoder().encode("#!/bin/sh\n"), { os: 3, attrs: attrs(0o755) }],
                "runner-x/runner.token": [new TextEncoder().encode("aitg_secret\n"), { os: 3, attrs: attrs(0o600) }],
                "runner-x/README.txt": [new TextEncoder().encode("read me\n"), { os: 3, attrs: attrs(0o644) }],
            }),
        );
        return file;
    };

    it("reads the Unix permissions the zip carries", () => {
        const modes = zipModes(fs.readFileSync(zip()));
        expect(Object.fromEntries(modes)).toEqual({ "runner-x/start-runner.sh": 0o755, "runner-x/node/bin/node": 0o755, "runner-x/runner.token": 0o600, "runner-x/README.txt": 0o644 });
    });

    it("unpacks with the built-in reader, keeping the permission bits", async () => {
        const dest = path.join(tmp, "built in (1)");
        expect(await unpackZip(zip(), dest, { builtInOnly: true })).toBe("built-in unzip");
        expect(fs.readFileSync(path.join(dest, "runner-x", "README.txt"), "utf8")).toBe("read me\n");
        if (!WIN) {
            expect(fs.statSync(path.join(dest, "runner-x", "node", "bin", "node")).mode & 0o777).toBe(0o755);
            expect(fs.statSync(path.join(dest, "runner-x", "runner.token")).mode & 0o777).toBe(0o600);
        }
    });

    it("unpacks with the computer's own tool into a folder with a space and brackets", async () => {
        const dest = path.join(tmp, "system tool (1)");
        const tool = await unpackZip(zip(), dest);
        expect(["tar.exe", "ditto", "unzip", "built-in unzip"]).toContain(tool);
        expect(fs.readFileSync(path.join(dest, "runner-x", "start-runner.sh"), "utf8")).toBe("echo hi\n");
        if (!WIN) expect(fs.statSync(path.join(dest, "runner-x", "node", "bin", "node")).mode & 0o111).not.toBe(0);
    });
});

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
async function waitFor(what: string, probe: () => boolean, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!probe()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe("stopping only what it started", () => {
    it("stops its children and what they started; a process it did not start keeps running", async () => {
        // Each child starts a grandchild of its own and writes the grandchild's id, so the test can see the whole tree end.
        const parentCode = (file: string) => `const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(file)}, String(g.pid)); setInterval(() => {}, 1000);`;
        const children = new Children();
        const files = [path.join(tmp, "g1.pid"), path.join(tmp, "g2.pid")];
        const a = children.start("first", process.execPath, ["-e", parentCode(files[0]!)], { cwd: tmp, env: process.env });
        const b = children.start("second", process.execPath, ["-e", parentCode(files[1]!)], { cwd: tmp, env: process.env });
        // Started by the test, not by the script: it must survive.
        const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
        ours.push(decoy);
        await waitFor("the grandchildren", () => files.every((f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").length > 0));
        const grandchildren = files.map((f) => Number(fs.readFileSync(f, "utf8")));
        expect([a.child.pid, b.child.pid, ...grandchildren].every((p) => alive(p!))).toBe(true);

        await children.stopAll();

        expect(Children.running(a)).toBe(false);
        expect(Children.running(b)).toBe(false);
        await waitFor("the grandchildren to end", () => grandchildren.every((p) => !alive(p)));
        expect(alive(decoy.pid!)).toBe(true);
        decoy.kill();
    }, 30_000);
});

describe("a whole run that ends in the plain skip", () => {
    const PORT = 6960;
    const PERSON_TOKEN = "aitp_SmokePersonToken0123456789abcdef";
    it("the complete download is not built: the run signs up its first person, downloads as them, says skipped, exits 0, and stops the sample app it started", async () => {
        const seen: string[] = [];
        let fake: http.Server | undefined;
        const children = new Children();
        const out = path.join(tmp, "report");
        const report = await runSmoke(
            { ...parseArgs(["--kit", "complete", "--no-node-on-path", "--port", String(PORT)]), out },
            {
                children,
                target: hostTarget("linux", "x64"),
                // A stand-in for the platform: the few routes the run reaches before the download.
                startPlatform: async ({ apiKey }: { apiKey: string }) => {
                    fake = http.createServer((req, res) => {
                        let body = "";
                        req.on("data", (d) => (body += d));
                        req.on("end", () => {
                            const who = req.headers["x-api-key"] === apiKey ? "key" : req.headers.authorization === `Bearer ${PERSON_TOKEN}` ? "person" : /aitp_session=s1/.test(String(req.headers.cookie)) && req.headers["x-csrf-token"] === "c1" ? "session" : "NOBODY";
                            seen.push(`${req.method} ${req.url} ${who} ${body}`);
                            const send = (code: number, obj: unknown, headers: Record<string, string | string[]> = {}) => res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(obj));
                            if (req.url === "/api/auth/setup") return send(201, { me: {} }, { "set-cookie": ["aitp_session=s1; Path=/; HttpOnly", "aitp_csrf=c1; Path=/"] });
                            if (req.url === "/api/me/tokens") return send(201, { token: PERSON_TOKEN });
                            if (req.url === "/api/projects") return send(201, { id: "p1" });
                            if (req.url === "/api/projects/p1/specs") return send(202, { tests: [{ id: "t1" }, { id: "t2" }] });
                            // A download without its own Node.js (no x-runner-kit-target): the complete build was not made here.
                            if (req.url === "/api/me/runner/download") return void res.writeHead(200, { "content-type": "application/zip", "x-runner-kit-kind": "files" }).end(Buffer.from("PK\u0005\u0006"));
                            send(404, { error: "not here" });
                        });
                    });
                    await new Promise<void>((r) => fake!.listen(PORT, "127.0.0.1", () => r()));
                    return { base: `http://127.0.0.1:${PORT}` };
                },
            },
        );
        await new Promise((r) => fake?.close(r));

        expect(report.verdict).toBe("skipped");
        expect(report.skipReason).toBe("The download for linux-x64 does not carry its own Node.js: the complete build for it was not made on this platform (npm run build:runner -- --complete --targets linux-x64).");
        expect(report.steps.map((s: { name: string; status: string }) => `${s.status} ${s.name}`)).toEqual([
            "ok Start the sample app",
            "ok Start the platform on a new data folder",
            "ok Sign up the first person (an owner), as the setup page does",
            "ok Create a project with a web test and an API test (no AI)",
            "skipped Download the runner (complete download)",
            "ok Clean up",
        ]);
        // The access key only signs up the first person; their session makes their own token, and everything after is that person.
        expect(seen.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual(["POST /api/auth/setup key", "POST /api/me/tokens session", "POST /api/projects person", "POST /api/projects/p1/specs person", "POST /api/me/runner/download person"]);
        expect(seen.find((s) => s.startsWith("POST /api/me/runner/download"))).toContain('{"os":"linux","arch":"x64"}');
        expect(JSON.parse(seen.find((s) => s.startsWith("POST /api/projects/p1/specs"))!.split(" person ")[1]!).specs.map((s: { kind: string }) => s.kind)).toEqual(["web", "api"]);
        // The sample app it started is stopped; nothing it started is left running.
        expect(children.list.map((c: { name: string }) => c.name)).toEqual(["sample app"]);
        expect(children.list.every((c: unknown) => !Children.running(c))).toBe(true);
        // The report and logs are written, without the access key.
        const json = fs.readFileSync(path.join(out, "report.json"), "utf8");
        expect(JSON.parse(json).verdict).toBe("skipped");
        expect(json).not.toMatch(/smoke-[0-9a-f]{36}/);
        expect(json).not.toContain(PERSON_TOKEN);
        expect(fs.readFileSync(path.join(out, "report.md"), "utf8")).toContain("Runner smoke check skipped: complete download with no Node.js on the PATH, Linux x64");
        expect(fs.existsSync(path.join(out, "sample-app.log"))).toBe(true);
    }, 60_000);
});

describe("--lifecycle (round 39: stop, start again, uninstall, nothing left)", () => {
    it("is accepted with the installer only, and the installer never adds a sign-in start during a check", () => {
        expect(parseArgs(["--kit", "installer", "--lifecycle"]).lifecycle).toBe(true);
        expect(() => parseArgs(["--kit", "files", "--lifecycle"])).toThrow(UsageError);
        expect(() => parseArgs(["--lifecycle"])).toThrow(/only works with --kit installer/);
        expect(startCommand("installer", hostTarget("win32", "x64"), "K", "I").args).toContain("--no-start-at-sign-in");
        expect(startCommand("installer", hostTarget("darwin", "arm64"), "K", "I").args).toContain("--no-autostart");
    });
});

describe("--lifecycle: no credential as plain text in the install folder (round 40)", () => {
    it("finds an aitg_ credential or aite_ code in any file (UTF-8 or UTF-16), and nothing in a clean folder, the private Node.js or node_modules", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plain-cred-"));
        try {
            const token = `aitg_${"A1b2C3d4".repeat(4)}`;
            const code = `aite_${"x9Y8z7W6".repeat(4)}`;
            fs.mkdirSync(path.join(dir, "app", "work", "outbox"), { recursive: true });
            fs.mkdirSync(path.join(dir, "app", "node_modules", "pkg"), { recursive: true });
            fs.mkdirSync(path.join(dir, "node"), { recursive: true });
            fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
            fs.writeFileSync(path.join(dir, "app", "runner.credential"), "dpapi:AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA\n"); // protected: fine
            fs.writeFileSync(path.join(dir, "logs", "runner.log"), "Runner online. Token aitg_*** hidden\n");
            fs.writeFileSync(path.join(dir, "app", "node_modules", "pkg", "x.js"), `const t = "${token}";`);
            fs.writeFileSync(path.join(dir, "node", "x.txt"), token);
            expect(plainCredentialsIn(dir)).toEqual([]);
            fs.writeFileSync(path.join(dir, "app", "work", "outbox", "task.json"), `{"t":"${token}"}`);
            fs.writeFileSync(path.join(dir, "logs", "setup.log"), Buffer.from(`code ${code}`, "utf16le"));
            expect(plainCredentialsIn(dir).sort()).toEqual([path.join("app", "work", "outbox", "task.json"), path.join("logs", "setup.log")].sort());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
