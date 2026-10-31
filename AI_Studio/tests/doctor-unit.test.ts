/**
 * `npm run doctor` without touching this computer: the checks run against fake machines (everything fine, everything missing,
 * partial), the report wording, the exit rule, and the promise that no setting's value ever reaches the output.
 * The few real probes (port, data folder, invalid settings) run against a temp folder and ports 6195/6196.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCodeFor, formatReport, realProbes, requiredNodeMajor, runChecks, summary, type Check, type Probes } from "../src/cli/doctor.js";

const SENTINEL = "SENTINEL-doctor-0b7f3a-never-print";

function fine(over: Partial<Probes> = {}): Probes {
    return {
        platform: "linux",
        nodeVersion: "24.1.0",
        enginesNode: ">=24",
        env: { ANTHROPIC_API_KEY: SENTINEL, SECRET_KEY: SENTINEL, API_KEY: SENTINEL, SMTP_PASSWORD: SENTINEL, LLM_API_KEY: SENTINEL, ANDROID_HOME: "/nowhere" },
        packageVersion: (n) => (n === "playwright" ? "1.50.0" : "5.8.0"),
        browserInstalled: () => true,
        onPath: (p) => `/usr/bin/${p}`,
        fileExists: () => true,
        envFileExists: () => true,
        dataDir: () => "/data",
        dataDirWritable: () => ({ ok: true, exists: true }),
        portFree: async () => ({ free: true }),
        invalidSettings: () => [],
        android: () => ({ available: false, avds: [], reason: "No Android toolchain found. Run `npx taqwright install --with-avd` on the machine that runs the platform." }),
        webDist: () => "/app/web/dist",
        ...over,
    };
}

const by = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

describe("requiredNodeMajor", () => {
    it("reads the engines range", () => {
        expect(requiredNodeMajor(">=24")).toBe(24);
        expect(requiredNodeMajor(">= v22.1")).toBe(22);
        expect(requiredNodeMajor("^20")).toBeUndefined();
        expect(requiredNodeMajor(undefined)).toBeUndefined();
    });
});

describe("a machine where everything is fine", () => {
    it("has nothing missing and exits 0", async () => {
        const checks = await runChecks(fine());
        expect(checks.filter((c) => c.status === "missing")).toEqual([]);
        expect(exitCodeFor(checks)).toBe(0);
        // Android and desktop are optional and reported honestly for this fake Linux box
        expect(by(checks, "xcode").status).toBe("optional");
        expect(by(checks, "windows-ui").status).toBe("optional");
        expect(by(checks, "ai-key").status).toBe("ok");
        expect(by(checks, "custom-scripts").title).toContain("do not run");
        expect(by(checks, "desktop-apps").title).toContain("may not start any application");
    });
});

describe("a machine where everything is missing", () => {
    it("lists every required thing with a fix, the optional ones as optional, and exits 1", async () => {
        const checks = await runChecks(
            fine({
                nodeVersion: "20.11.0",
                env: { HOST: "0.0.0.0", PORT: "4000" },
                packageVersion: () => undefined,
                browserInstalled: () => false,
                onPath: () => undefined,
                fileExists: () => false,
                envFileExists: () => false,
                dataDirWritable: () => ({ ok: false, reason: "Writing a test file failed (EACCES)." }),
                portFree: async () => ({ free: false, code: "EADDRINUSE" }),
                invalidSettings: () => ["LLM_PROVIDER"],
            }),
        );
        const missing = checks.filter((c) => c.status === "missing").map((c) => c.id);
        expect(missing).toEqual(["node", "dependencies", "chromium", "typescript", "settings", "api-key", "data-dir", "port"]);
        const optional = checks.filter((c) => c.status === "optional").map((c) => c.id);
        expect(optional).toEqual(expect.arrayContaining(["firefox", "webkit", "git", "env-file", "ai-key", "web-build", "android", "xcode", "windows-ui"]));
        for (const c of checks.filter((x) => x.status !== "ok")) expect(c.fix, c.id).toBeTruthy();
        expect(by(checks, "chromium").fix).toBe("Run `npx playwright install chromium` after npm install.");
        expect(by(checks, "node").fix).toContain("Node.js 24");
        expect(by(checks, "port").title).toContain("in use");
        expect(exitCodeFor(checks)).toBe(1);
        expect(summary(checks)).toBe("8 required things are missing. Fix them and run this check again.");
    });
});

describe("partial machines", () => {
    it("only Chromium missing: one required item, the exact install command", async () => {
        const checks = await runChecks(fine({ browserInstalled: (n) => n !== "chromium" }));
        expect(checks.filter((c) => c.status === "missing").map((c) => c.id)).toEqual(["chromium"]);
        expect(by(checks, "chromium").fix).toBe("Run `npx playwright install chromium`.");
        expect(summary(checks)).toBe("1 required thing is missing. Fix it and run this check again.");
    });

    it("Firefox, WebKit, git and the AI key missing is still ready to run", async () => {
        const checks = await runChecks(fine({ browserInstalled: (n) => n === "chromium", onPath: (p) => (p === "git" ? undefined : `/bin/${p}`), env: {} }));
        expect(exitCodeFor(checks)).toBe(0);
        expect(["firefox", "webkit", "git", "ai-key"].map((id) => by(checks, id).status)).toEqual(["optional", "optional", "optional", "optional"]);
        expect(summary(checks)).toMatch(/^Ready to run\. \d+ optional things are not set up; they only matter if you need those kinds of tests\.$/);
    });

    it("the AI key is looked for under the name of the chosen provider", async () => {
        expect(by(await runChecks(fine({ env: { LLM_PROVIDER: "openai", ANTHROPIC_API_KEY: SENTINEL } })), "ai-key").status).toBe("optional");
        expect(by(await runChecks(fine({ env: { LLM_PROVIDER: "openai", OPENAI_API_KEY: SENTINEL } })), "ai-key").status).toBe("ok");
        expect(by(await runChecks(fine({ env: { LLM_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: SENTINEL } })), "ai-key").status).toBe("ok");
        expect(by(await runChecks(fine({ env: { LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://x" } })), "ai-key").status).toBe("ok");
        expect(by(await runChecks(fine({ env: { ANTHROPIC_API_KEY: "   " } })), "ai-key").status).toBe("optional");
    });

    it("a network address without API_KEY is required, a local address needs none", async () => {
        expect((await runChecks(fine({ env: { HOST: "0.0.0.0" } }))).find((c) => c.id === "api-key")?.status).toBe("missing");
        expect((await runChecks(fine({ env: { HOST: "0.0.0.0", API_KEY: SENTINEL } }))).find((c) => c.id === "api-key")?.status).toBe("ok");
        expect((await runChecks(fine({ env: { HOST: "127.0.0.1" } }))).find((c) => c.id === "api-key")).toBeUndefined();
    });

    it("a data folder that does not exist yet is fine when it can be created", async () => {
        const c = by(await runChecks(fine({ dataDirWritable: () => ({ ok: true, exists: false }) })), "data-dir");
        expect(c.status).toBe("ok");
        expect(c.title).toContain("does not exist yet");
    });

    it("the configured port is the one probed, and an unusable PORT falls back to 4000", async () => {
        const seen: Array<[number, string]> = [];
        const probe = async (port: number, host: string) => (seen.push([port, host]), { free: true as const });
        await runChecks(fine({ env: { PORT: "5123", HOST: "127.0.0.1" }, portFree: probe }));
        await runChecks(fine({ env: { PORT: "banana" }, portFree: probe }));
        expect(seen).toEqual([
            [5123, "127.0.0.1"],
            [4000, "127.0.0.1"],
        ]);
    });

    it("says what the safety switches are in words", async () => {
        const on = await runChecks(fine({ env: { ALLOW_CUSTOM_SCRIPTS: "true", API_KEY: "k", DESKTOP_ALLOWED_APPS: "C:\\a.exe; calc.exe;" } }));
        expect(by(on, "custom-scripts").title).toContain("may run on this computer");
        const noKey = await runChecks(fine({ env: { ALLOW_CUSTOM_SCRIPTS: "true" } }));
        expect(by(noKey, "custom-scripts").title).toContain("API_KEY is not set");
        expect(by(noKey, "custom-scripts").status).toBe("optional");
        expect(by(on, "desktop-apps").title).toBe("Desktop tests may start 2 applications on this computer");
    });

    it("Windows and macOS get the checks that apply to them", async () => {
        const win = await runChecks(fine({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, fileExists: (f) => f.endsWith("powershell.exe") }));
        expect(by(win, "windows-ui").status).toBe("ok");
        const noPs = await runChecks(fine({ platform: "win32", fileExists: () => false }));
        expect(by(noPs, "windows-ui").status).toBe("optional");
        const mac = await runChecks(fine({ platform: "darwin", fileExists: (f) => f === "/Applications/Xcode.app" }));
        expect(by(mac, "xcode").status).toBe("ok");
    });
});

describe("the report", () => {
    it("is plain: a status word, what it is for, how to fix; no emoji; and never a setting's value", async () => {
        for (const probes of [fine(), fine({ browserInstalled: () => false, invalidSettings: () => ["PORT"], env: { PORT: SENTINEL, HOST: "0.0.0.0", ANTHROPIC_API_KEY: SENTINEL, SECRET_KEY: SENTINEL, SMTP_PASSWORD: SENTINEL, LLM_API_KEY: SENTINEL } })]) {
            const text = formatReport(await runChecks(probes));
            expect(text).not.toContain(SENTINEL);
            expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
            expect(text).not.toContain("!");
            for (const line of text.split("\n").filter((l) => /^(ok|missing|optional)\s/.test(l))) expect(line).toMatch(/^(ok|missing|optional) +\S/);
        }
        const text = formatReport(await runChecks(fine({ browserInstalled: () => false })));
        expect(text).toMatch(/^missing {2} Chromium is not installed\n {10}For: .+\n {10}To fix: Run `npx playwright install chromium`\.$/m);
        expect(text.endsWith("Fix it and run this check again.\n")).toBe(true);
    });
});

describe("the real probes", () => {
    const made: string[] = [];
    const servers: net.Server[] = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
        for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it("writes and removes one temp file in the data folder, and leaves nothing behind", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-doctor-"));
        made.push(dir);
        fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
        const p = realProbes({ DATA_DIR: dir });
        expect(p.dataDir()).toBe(path.resolve(dir));
        expect(p.dataDirWritable(dir)).toEqual({ ok: true, exists: true });
        expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
        expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("mine");
    });

    it("does not create a data folder that is not there yet", () => {
        const dir = path.join(os.tmpdir(), `aitp-doctor-absent-${Date.now()}`);
        const p = realProbes({ DATA_DIR: dir });
        expect(p.dataDirWritable(dir)).toEqual({ ok: true, exists: false });
        expect(fs.existsSync(dir)).toBe(false);
    });

    it("reports a data path that is a file as not writable", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-doctor-"));
        made.push(dir);
        const file = path.join(dir, "not-a-folder");
        fs.writeFileSync(file, "x");
        const r = realProbes({}).dataDirWritable(file);
        expect(r.ok).toBe(false);
    });

    it("tells a free port from one that is in use, and lets go of it", async () => {
        const p = realProbes({});
        expect(await p.portFree(6196, "127.0.0.1")).toEqual({ free: true });
        const held = net.createServer();
        servers.push(held);
        await new Promise<void>((r) => held.listen(6195, "127.0.0.1", () => r()));
        expect(await p.portFree(6195, "127.0.0.1")).toEqual({ free: false, code: "EADDRINUSE" });
        expect(await p.portFree(6196, "127.0.0.1")).toEqual({ free: true }); // the first probe did not keep it
    });

    it("names the settings the platform cannot use, never their values", () => {
        const names = realProbes({}).invalidSettings({ PORT: SENTINEL, LLM_PROVIDER: SENTINEL, CONCURRENCY: "3" });
        expect(names.sort()).toEqual(["LLM_PROVIDER", "PORT"]);
        expect(names.join(" ")).not.toContain(SENTINEL);
        expect(realProbes({}).invalidSettings({})).toEqual([]);
    });

    it("finds a program on PATH without starting it", () => {
        const node = realProbes(process.env).onPath("node");
        expect(node && fs.existsSync(node)).toBe(true);
        expect(realProbes({ PATH: os.tmpdir() }).onPath("surely-not-a-program-xyz")).toBeUndefined();
    });
});
