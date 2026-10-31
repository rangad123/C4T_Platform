// Run the platform's own pages (the browser UI tests) in every browser engine, and in the branded browsers this computer has:
// Chromium, Firefox and WebKit (Safari's engine) as Playwright builds them, plus Google Chrome and Microsoft Edge when they are installed
// (Playwright's `channel`). A branded browser that is not installed is skipped with a plain line; it is found by its file at the usual
// install places, never by looking at running programs.
//   npx playwright install chromium firefox webkit   (once)
//   npm run build:web                                 (once: the UI tests need web/dist)
//   npm run test:ui:browsers [-- --only chromium,chrome] [--report <dir>]
// Every vitest run goes through scripts/with-lock.mjs "browser", so people on one machine take turns. Exit code 0 when every browser
// that ran passed, 1 otherwise, 2 for wrong arguments. CI: .github/workflows/runner-matrix.yml (job ui-browsers).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const UI_FILES = ["tests/ui-smoke.test.ts", "tests/ui-flows.test.ts"];

/** What can run: the three engines always, then the two branded browsers. */
export const BROWSERS = [
    { id: "chromium", name: "Chromium", browser: "chromium" },
    { id: "firefox", name: "Firefox", browser: "firefox" },
    { id: "webkit", name: "WebKit", browser: "webkit" },
    { id: "chrome", name: "Google Chrome", browser: "chromium", channel: "chrome" },
    { id: "msedge", name: "Microsoft Edge", browser: "chromium", channel: "msedge" },
];

/** The places Chrome and Edge (stable) install themselves, per system. The same places Playwright's channel lookup uses. */
export function brandedPaths(channel, platform = process.platform, env = process.env) {
    if (platform === "win32") {
        const roots = [env.LOCALAPPDATA, env.PROGRAMFILES ?? env.ProgramFiles, env["PROGRAMFILES(X86)"] ?? env["ProgramFiles(x86)"]].filter(Boolean);
        const rel = channel === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["Microsoft", "Edge", "Application", "msedge.exe"];
        return roots.map((r) => path.win32.join(r, ...rel));
    }
    if (platform === "darwin") return [channel === "chrome" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
    return channel === "chrome" ? ["/opt/google/chrome/chrome"] : ["/opt/microsoft/msedge/msedge"];
}

export const installedAt = (channel, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) => brandedPaths(channel, platform, env).find((p) => exists(p));

function parse(argv) {
    const o = { only: undefined, report: undefined };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--only") o.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        else if (argv[i] === "--report") o.report = argv[++i] ? path.resolve(argv[i]) : undefined;
        else throw new Error(`Unknown option ${argv[i]}. Use --only chromium,firefox,webkit,chrome,msedge and --report <dir>.`);
    }
    const unknown = (o.only ?? []).filter((id) => !BROWSERS.some((b) => b.id === id));
    if (unknown.length) throw new Error(`Unknown browser ${unknown.join(", ")}. Choose from ${BROWSERS.map((b) => b.id).join(", ")}.`);
    return o;
}

function runVitest(b, logFile) {
    const env = { ...process.env, UI_BROWSER: b.browser };
    if (b.channel) env.UI_CHANNEL = b.channel;
    else delete env.UI_CHANNEL;
    const args = [path.join(ROOT, "scripts", "with-lock.mjs"), "browser", "--", process.execPath, path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...UI_FILES];
    return new Promise((resolve) => {
        const log = logFile ? fs.createWriteStream(logFile) : undefined;
        const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
        const out = (c, s) => {
            s.write(c);
            log?.write(c);
        };
        child.stdout.on("data", (c) => out(c, process.stdout));
        child.stderr.on("data", (c) => out(c, process.stderr));
        child.on("error", (e) => out(Buffer.from(`could not start vitest: ${e.message}\n`), process.stderr));
        child.on("close", (code) => (log ? log.end(() => resolve(code ?? 1)) : resolve(code ?? 1)));
    });
}

async function main() {
    let o;
    try {
        o = parse(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    if (!fs.existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
        console.error("web/dist is missing: run `npm run build:web` first.");
        process.exit(1);
    }
    if (o.report) fs.mkdirSync(o.report, { recursive: true });
    const results = [];
    for (const b of BROWSERS.filter((x) => !o.only || o.only.includes(x.id))) {
        if (b.channel) {
            const at = installedAt(b.channel);
            if (!at) {
                console.log(`\n=== ${b.name}: skipped, it is not installed on this computer ===`);
                results.push({ id: b.id, name: b.name, result: "skipped", why: "not installed" });
                continue;
            }
            console.log(`\n=== UI tests in ${b.name} (${at}) ===`);
        } else console.log(`\n=== UI tests in ${b.name} ===`);
        const started = Date.now();
        const code = await runVitest(b, o.report ? path.join(o.report, `${b.id}.log`) : undefined);
        results.push({ id: b.id, name: b.name, result: code === 0 ? "passed" : "failed", seconds: Math.round((Date.now() - started) / 1000) });
    }
    const lines = results.map((r) => `${r.result === "passed" ? "ok  " : r.result === "skipped" ? "skip" : "FAIL"}  ${r.name}${r.why ? `: ${r.why}` : ""}${r.seconds !== undefined ? ` (${r.seconds} s)` : ""}`);
    console.log(`\nPlatform pages in each browser:\n${lines.join("\n")}`);
    if (o.report) {
        fs.writeFileSync(path.join(o.report, "summary.json"), `${JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2)}\n`);
        fs.writeFileSync(path.join(o.report, "summary.md"), `# Platform pages in each browser (${process.platform} ${process.arch})\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
    }
    process.exit(results.some((r) => r.result === "failed") || !results.some((r) => r.result === "passed") ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
