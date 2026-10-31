/**
 * The runner downloads a browser only when it has to, with Playwright's own installer, from a LOCAL fake download host (never the real one):
 * Chromium at start when nothing usable is installed, Firefox and WebKit only when a run on other browsers needs them, one download at a
 * time per browser, a time limit, plain reasons when it fails, and an installer environment that carries the proxy settings but none of the
 * runner's own (the token). The downloaded "browsers" are tiny fake archives: nothing here starts a browser.
 *
 * Starts processes (Playwright's installer, a stand-in installer): run under the lock:
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/runner-browsers-download.test.ts
 * Port: fake download host 6930.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSetup } from "../src/agent/browser-setup.js";
import { memoryLogger } from "../src/agent/log.js";
import { bundledChromium } from "../src/engine/browsers/choice.js";

const PORT = 6930;
const HOST = `http://127.0.0.1:${PORT}`;
const TOKEN = "aitg_DownloadTestToken0123456789abcdefghij";
const bundled = bundledChromium()!;
// Every archive holds every program name Playwright looks for after unpacking, on each system (the bytes are not a browser).
const ARCHIVE = Buffer.from(
    zipSync(Object.fromEntries(["chrome-win64/chrome.exe", "chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "ffmpeg-win64.exe", "ffmpeg-linux", "firefox/firefox.exe", "firefox/firefox", "Playwright.exe", "pw_run.sh", "PrintDeps.exe"].map((f) => [f, strToU8("not a browser")]))),
);

let tmp: string;
let server: http.Server;
const requests: string[] = [];
/** How the host answers a path: "ok" (the archive), a status code, or "hang" (never answers). */
let answer: (url: string) => "ok" | number | "hang" = () => "ok";
const hanging: http.ServerResponse[] = [];
let hangClosed = 0;

beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-browsers-dl-"));
    server = http.createServer((req, res) => {
        requests.push(req.url ?? "");
        const a = answer(req.url ?? "");
        if (a === "hang") {
            hanging.push(res);
            req.socket.on("close", () => hangClosed++);
            return;
        }
        if (a !== "ok") return void (res.writeHead(a), res.end("not here"));
        res.writeHead(200, { "content-type": "application/zip", "content-length": ARCHIVE.length });
        res.end(ARCHIVE);
    });
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

afterAll(async () => {
    for (const r of hanging) r.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let n = 0;
/** A runner on a computer with no Chrome, no Edge and no Playwright browsers: every folder the lookup sees is empty and temporary. */
function blankComputer(extra: NodeJS.ProcessEnv = {}) {
    const root = path.join(tmp, `pc-${++n}`);
    fs.mkdirSync(root, { recursive: true });
    const over: NodeJS.ProcessEnv = {
        LOCALAPPDATA: path.join(root, "local"),
        ProgramFiles: path.join(root, "pf"),
        "ProgramFiles(x86)": path.join(root, "pf86"),
        HOMEDRIVE: path.join(root, "drive"),
        HOME: path.join(root, "home"),
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "ms-playwright"),
        PLAYWRIGHT_DOWNLOAD_HOST: HOST,
        AITP_AGENT_TOKEN: TOKEN,
        ...extra,
    };
    // A copied Windows environment may spell these names in another case (PROGRAMFILES(X86)): drop every spelling of them first.
    const replaced = new Set(Object.keys(over).map((k) => k.toUpperCase()));
    const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !replaced.has(k.toUpperCase()))), ...over };
    return { root, env, browsers: env.PLAYWRIGHT_BROWSERS_PATH!, workDir: path.join(root, "work") };
}

describe("downloading what is missing", () => {
    it("auto on a computer with nothing usable: Playwright's Chromium is downloaded once, with plain lines, and then used", async () => {
        requests.length = 0;
        answer = () => "ok";
        const pc = blankComputer();
        const { log, lines } = memoryLogger();
        let changed = 0;
        const s = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir, onChange: () => changed++ });
        await s.prepare();
        expect(s.report()).toMatchObject({ chromium: "pending", note: "The runner is downloading Chromium for web tests." });
        const w = await s.forWeb();
        expect(w).toEqual({ ok: true, browser: { name: "chromium", version: bundled.version, source: "downloaded", launch: {} } });
        expect(changed).toBe(1);
        expect(requests.some((u) => u.includes(`/builds/cft/${bundled.version}/`) && u.includes("chrome-"))).toBe(true);
        expect(fs.existsSync(path.join(pc.browsers, `chromium-${bundled.revision}`, "INSTALLATION_COMPLETE"))).toBe(true);
        const text = lines.join("\n");
        expect(text).toContain(`No usable Google Chrome, Microsoft Edge or Playwright Chromium was found. Downloading Chromium ${bundled.major} for web tests (about 150 MB, only once).`);
        expect(text).toContain("Downloaded Chromium.");
        expect(text).toContain(`Ready for web tests in Chromium ${bundled.major}, downloaded by the runner.`);
        // The next start finds it and still says where it came from; nothing is downloaded again.
        const before = requests.length;
        const again = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir });
        expect(await again.forWeb()).toMatchObject({ ok: true, browser: { source: "downloaded" } });
        expect(requests.length).toBe(before);
    }, 120_000);

    it("a download the host refuses becomes one plain reason; web tests are then refused with what to do", async () => {
        answer = (u) => (u.includes("/cft/") ? 404 : "ok");
        const pc = blankComputer();
        const { log, lines } = memoryLogger();
        const s = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir });
        const w = await s.forWeb();
        expect(w.ok).toBe(false);
        const error = (w as { error: string }).error;
        expect(error).toMatch(/^Chromium could not be downloaded \(Download failed: server returned code 404/);
        expect(error).toContain("Web tests cannot run on this computer until a browser is available: check its internet connection or proxy, or install Google Chrome or Microsoft Edge, then start the runner again.");
        expect(lines.join("\n")).toMatch(/ERROR Chromium could not be downloaded: Download failed: server returned code 404/);
        expect(s.report()).toMatchObject({ chromium: "pending" });
        expect(s.report().note).toMatch(/^Chromium could not be downloaded/);
    }, 120_000);

    it("a download that takes too long is stopped at its limit (only the installer this runner started), with a plain reason", async () => {
        answer = () => "hang";
        hangClosed = 0;
        const pc = blankComputer();
        const { log } = memoryLogger();
        const s = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir, downloadTimeoutMs: 4000 });
        const started = Date.now();
        const w = await s.forWeb();
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(w).toMatchObject({ ok: false });
        expect((w as { error: string }).error).toContain("Chromium could not be downloaded (it took longer than 4 seconds and was stopped)");
        // The installer was stopped: its connection to the host went away.
        const end = Date.now() + 10_000;
        while (hangClosed === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
        expect(hangClosed).toBeGreaterThan(0);
    }, 120_000);

    it("Firefox is downloaded only when a run asks for it, once for runs that ask at the same time; a WebKit download that fails is a plain runner problem", async () => {
        requests.length = 0;
        answer = (u) => (u.includes("/webkit/") ? 500 : "ok");
        const pc = blankComputer();
        // Playwright's Chromium is here already, so nothing is downloaded at start.
        for (const f of ["chromium", "chromium_headless_shell"]) {
            fs.mkdirSync(path.join(pc.browsers, `${f}-${bundled.revision}`), { recursive: true });
            fs.writeFileSync(path.join(pc.browsers, `${f}-${bundled.revision}`, "INSTALLATION_COMPLETE"), "");
        }
        const { log, lines } = memoryLogger();
        const s = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir });
        await s.prepare();
        expect(requests).toEqual([]);
        const [a, b] = await Promise.all([s.engine("firefox"), s.engine("firefox")]);
        expect(a).toEqual({ ok: true });
        expect(b).toEqual({ ok: true });
        expect(requests.filter((u) => u.includes("/firefox/"))).toHaveLength(1);
        expect(lines.join("\n")).toContain("A run needs Firefox, which is not on this computer yet. Downloading it (only once).");
        // Now it is here: no new download.
        expect(await s.engine("firefox")).toEqual({ ok: true });
        expect(requests.filter((u) => u.includes("/firefox/"))).toHaveLength(1);
        const wk = await s.engine("webkit");
        expect(wk.ok).toBe(false);
        expect((wk as { error: string }).error).toMatch(/^This run needs WebKit, and the runner could not download it \(Download failed: server returned code 500.*\)\. Check this computer's internet connection or proxy, then run it again\. Runs in Chromium are not affected\.$/);
    }, 180_000);
});

describe("the installer's environment", () => {
    it("carries the proxy settings (also ones exported after the runner started) and none of the runner's own settings", async () => {
        const pc = blankComputer({ HTTPS_PROXY: "http://proxy.example.test:3128", NO_PROXY: "127.0.0.1" });
        const seen = path.join(pc.root, "seen.json");
        // A stand-in for Playwright's installer: it writes down what it was given and "installs" the expected folders.
        const cli = path.join(pc.root, "fake-cli.mjs");
        fs.writeFileSync(
            cli,
            `import fs from "node:fs"; import path from "node:path";
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
for (const f of ["chromium", "chromium_headless_shell"]) { const d = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, f + "-${bundled.revision}"); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "INSTALLATION_COMPLETE"), ""); }
console.log("|■■■■■■■■■■          |  30% of 150.2 MiB"); console.log("|■■■■■■■■■■■■■■■■    |  60% of 150.2 MiB");
`,
        );
        const saved = process.env.NODE_EXTRA_CA_CERTS;
        process.env.NODE_EXTRA_CA_CERTS = path.join(pc.root, "company-ca.pem"); // as if the network setup exported it into the runner's process later
        try {
            const { log, lines } = memoryLogger();
            const s = new BrowserSetup({ env: pc.env, log, workDir: pc.workDir, cli, policy: "bundled" });
            expect(await s.forWeb()).toMatchObject({ ok: true, browser: { source: "downloaded" } });
            const got = JSON.parse(fs.readFileSync(seen, "utf8")) as { argv: string[]; env: Record<string, string> };
            expect(got.argv).toEqual(["install", "chromium"]);
            expect(got.env.HTTPS_PROXY).toBe("http://proxy.example.test:3128");
            expect(got.env.NO_PROXY).toBe("127.0.0.1");
            expect(got.env.NODE_EXTRA_CA_CERTS).toBe(path.join(pc.root, "company-ca.pem"));
            expect(Object.keys(got.env).filter((k) => k.toUpperCase().startsWith("AITP_"))).toEqual([]);
            expect(JSON.stringify(got)).not.toContain(TOKEN);
            // Progress: one line at each quarter it passed, not one per chunk.
            expect(lines.filter((l) => l.includes("Chromium download:")).map((l) => l.replace(/^.*INFO\s+/, ""))).toEqual(["Chromium download: 25% of 150.2 MiB.", "Chromium download: 50% of 150.2 MiB."]);
            expect(lines.join("\n")).toContain("Playwright's Chromium " + bundled.major + " is not on this computer yet. Downloading it for web tests (about 150 MB, only once).");
        } finally {
            if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
            else process.env.NODE_EXTRA_CA_CERTS = saved;
        }
    }, 60_000);
});
