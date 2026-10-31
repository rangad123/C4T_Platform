// A downloaded test project, run the way a tester runs it: on this computer, with its own Node.js and npm, and the Playwright the
// download pins (or another version), nothing taken from the platform.
//   node scripts/portable-check.mjs [--port 6956] [--out <dir>] [--playwright <version>] [--install-deps] [--link-node-modules] [--keep]
//   node scripts/portable-check.mjs --export-only --dir <folder> [--port 6956]     (step 1 on its own: make the download)
//   node scripts/portable-check.mjs --from <folder> [--port 6958] [--playwright <version>] ...   (step 2 on its own: run it)
//
// 1. Export: starts the sample app (examples/sample-app) and the platform (src/main.ts) on a new temporary data folder with a new access
//    key, creates a project with web tests, API tests and a code test with a shared helper (imported through the API, no AI), downloads
//    the project (GET /api/projects/:id/download) and unpacks it with the computer's own unzip tool into a folder with a space and
//    brackets in its name. Stops the platform.
// 2. Run: in that folder, exactly the README's three steps: `npm ci`, `npx playwright install chromium` (`--with-deps` with
//    --install-deps, for Linux), `npx playwright test`, with BASE_URL and API_BASE_URL pointing at a sample app it starts itself.
//    --playwright <version> first installs that version instead of the pinned one (`npm install --no-save @playwright/test@<version>`):
//    the oldest supported version in CI. --link-node-modules (no internet) links this checkout's node_modules instead of `npm ci` and
//    runs Playwright's command line directly; it cannot be combined with --playwright.
// 3. Checks: every test passed, the Playwright that ran is the one asked for, the download carries package.json with exact versions,
//    package-lock.json, .nvmrc, playwright.config.ts and README.md.
// Stops only what it started (by the handles it holds) and deletes its temporary folder. Writes report.md and report.json (and the logs)
// to --out. Exit code: 0 passed, 1 failed, 2 wrong arguments. See docs/features/portable-code-tests.md; CI: the portable-exports job of
// .github/workflows/runner-matrix.yml.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Children, fmtMs, platformEnv, redact, REPO, unpackZip } from "./smoke-runner.mjs";

const WIN = process.platform === "win32";
export const DEFAULT_PORT = 6956;
/** Each command may take this long (npm ci and the browser download on a slow line included). */
const COMMAND_MS = 15 * 60_000;

export const HELP = `Portable export check: export the sample project's tests from the platform and run them the way the README says.

  node scripts/portable-check.mjs [options]

  --port <n>             the platform's port; the sample app uses the next one (default ${DEFAULT_PORT})
  --out <dir>            where the report and logs go (default .scratch/portable-check/<time>)
  --playwright <version> run with this @playwright/test instead of the pinned one (npm install --no-save)
  --install-deps         install the browser's system libraries too (npx playwright install --with-deps; Linux)
  --link-node-modules    use this checkout's node_modules instead of npm ci (no internet; not with --playwright)
  --export-only          only make the download and unpack it into --dir
  --dir <folder>         where --export-only unpacks the download
  --from <folder>        only run a download unpacked earlier (by --export-only)
  --keep                 keep the temporary folder
  --help                 this text`;

export class UsageError extends Error {}

export function parseArgs(argv) {
    const o = { port: DEFAULT_PORT, out: undefined, playwright: undefined, installDeps: false, linkNodeModules: false, exportOnly: false, dir: undefined, from: undefined, keep: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value.`);
            return v;
        };
        if (a === "--port") {
            o.port = Number(value());
            if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65534) throw new UsageError("--port takes a number from 1024 to 65534.");
            if (o.port === 4000 || o.port + 1 === 4000) throw new UsageError("Port 4000 belongs to the shared platform: choose another.");
        } else if (a === "--out") o.out = path.resolve(value());
        else if (a === "--playwright") {
            o.playwright = value();
            if (!/^\d+\.\d+\.\d+$/.test(o.playwright)) throw new UsageError("--playwright takes an exact version, for example 1.42.1.");
        } else if (a === "--install-deps") o.installDeps = true;
        else if (a === "--link-node-modules") o.linkNodeModules = true;
        else if (a === "--export-only") o.exportOnly = true;
        else if (a === "--dir") o.dir = path.resolve(value());
        else if (a === "--from") o.from = path.resolve(value());
        else if (a === "--keep") o.keep = true;
        else if (a === "--help" || a === "-h") o.help = true;
        else throw new UsageError(`Unknown option ${a}. Try --help.`);
    }
    if (o.linkNodeModules && o.playwright) throw new UsageError("--link-node-modules uses this checkout's Playwright; it cannot be combined with --playwright.");
    if (o.exportOnly && !o.dir) throw new UsageError("--export-only needs --dir <folder>.");
    if (o.exportOnly && o.from) throw new UsageError("Use --export-only or --from, not both.");
    if (o.from && !fs.existsSync(path.join(o.from, "package.json"))) throw new UsageError(`${o.from} holds no downloaded project (no package.json).`);
    return o;
}

/** The sample project's tests (no AI): web steps and checks, an accessibility and a page health check, two API tests. */
export function portableSpecs(appUrl) {
    return [
        {
            title: "Search finds the backpack",
            kind: "web",
            category: "Shop",
            tags: ["smoke"],
            steps: [
                { action: "navigate", url: `${appUrl}/products` },
                { action: "fill", locator: { by: "label", value: "Search products" }, value: "Back" },
                { action: "click", locator: { by: "role", role: "button", value: "Search" } },
                { action: "assert", check: "text", locator: { by: "css", value: "#count" }, expected: "1 products" },
                { action: "assert", check: "url", expected: "q=Back" },
                { action: "assert", check: "title", expected: "Products" },
                { action: "assert", check: "visible", locator: { by: "role", role: "link", value: "Trail Backpack" } },
            ],
        },
        {
            title: "Adding to the cart says so",
            kind: "web",
            category: "Shop",
            steps: [
                { action: "navigate", url: `${appUrl}/products/1` },
                { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
                { action: "assert", check: "text", locator: { by: "role", role: "status" }, expected: "Added to cart" },
                { action: "assert", check: "text", locator: { by: "css", value: "#cart-count" }, expected: "1" },
            ],
        },
        {
            title: "The home page has no critical accessibility problems and no script errors",
            kind: "web",
            category: "Quality",
            steps: [
                { action: "navigate", url: `${appUrl}/` },
                { action: "assert", check: "a11y", expected: "critical" },
                { action: "assert", check: "noConsoleErrors" },
            ],
        },
        {
            title: "The product list answers",
            kind: "api",
            category: "API",
            steps: [
                { action: "request", method: "GET", path: "/api/products" },
                { action: "assertResponse", check: "status", expected: 200 },
                { action: "assertResponse", check: "jsonPath", path: "0.name", expected: "Trail Backpack" },
                { action: "assertResponse", check: "jsonType", path: "0.price", expected: "number" },
            ],
        },
        {
            title: "A wrong password is refused",
            kind: "api",
            category: "API",
            steps: [
                { action: "request", method: "POST", path: "/api/login", auth: "none", body: { email: "demo@example.com", password: "not-the-password" } },
                { action: "assertResponse", check: "status", expected: 401 },
            ],
        },
    ];
}

/** A code test written by hand, with a shared helper it imports (./helpers/shop), as a person writes them in the editor. */
export const CODE_HELPER = `import type { Page } from "@playwright/test";

/** Opens the product list of the shop at base. */
export async function openProducts(page: Page, base: string): Promise<void> {
    await page.goto(new URL("/products", base).toString());
}
`;
export const codeTest = (appUrl) => `import { test, expect } from "@playwright/test";
import { openProducts } from "./helpers/shop";

const BASE_URL = process.env.BASE_URL ?? ${JSON.stringify(appUrl)};

test("The product list shows four products", async ({ page }) => {
    await openProducts(page, BASE_URL);
    await expect(page.locator("#count")).toHaveText("4 products");
    await expect(page.locator(".card")).toHaveCount(4);
});
`;
/** Tests the download holds: five from steps and one code test. */
export const EXPECTED_TESTS = 6;

// ── small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (text, lines = 30) => String(text).replace(/\r/g, "").trimEnd().split("\n").slice(-lines).join("\n");

async function until(what, probe, ms, every = 500) {
    const end = Date.now() + ms;
    for (;;) {
        if (await probe()) return;
        if (Date.now() > end) throw new Error(`Timed out after ${fmtMs(ms)} waiting for ${what}.`);
        await sleep(every);
    }
}

function client(base, apiKey) {
    return async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: { "x-api-key": apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(120_000),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        let json;
        try {
            json = JSON.parse(buf.toString("utf8"));
        } catch {
            json = undefined;
        }
        return { status: res.status, buf, json, message: json?.error ?? json?.message ?? (res.ok ? "" : buf.toString("utf8").slice(0, 300)) };
    };
}

/** Quotes one argument for the Windows command shell (npm and npx are .cmd files there and need it). */
const winQuote = (a) => (/^[A-Za-z0-9_./:@=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

/**
 * Runs a command to its end and returns its exit code and output. npm and npx go through the shell on Windows (they are .cmd files).
 * On a timeout only the process this started is ended, with what it started (taskkill /T by its id on Windows, its process group elsewhere).
 */
export function runCommand(command, args, { cwd, env, timeoutMs = COMMAND_MS, log } = {}) {
    return new Promise((resolve) => {
        const viaShell = WIN && (command === "npm" || command === "npx");
        const child = viaShell
            ? spawn([command, ...args].map(winQuote).join(" "), { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
            : spawn(command, args, { cwd, env, windowsHide: true, detached: !WIN, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        const add = (d) => {
            output += String(d);
            if (output.length > 4 * 1024 * 1024) output = output.slice(-4 * 1024 * 1024);
            log?.(String(d));
        };
        child.stdout.on("data", add);
        child.stderr.on("data", add);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (WIN && child.pid) spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
            else if (child.pid) {
                try {
                    process.kill(viaShell ? child.pid : -child.pid, "SIGKILL");
                } catch {
                    /* already gone */
                }
            }
        }, timeoutMs);
        child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ code: null, output: `${output}\n${e.message}`, timedOut });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, output, timedOut });
        });
    });
}

/** The environment for the exported tests: the computer's own, without the platform's settings and secrets. */
export function testEnv(base, appUrl) {
    const env = Object.fromEntries(Object.entries(base).filter(([k, v]) => v !== undefined && !/^(API_KEY|DATA_DIR|PUBLIC_URL|SECRET_KEY|AITP_.*|TEST_.*|API_TOKEN|API_AUTH_HEADER|NODE_OPTIONS|NODE_PATH)$/i.test(k)));
    return { ...env, BASE_URL: appUrl, API_BASE_URL: appUrl, FORCE_COLOR: "0", CI: env.CI ?? "1" };
}

/** What the download must carry for a tester (checked before anything runs). */
export function checkDownload(dir) {
    const problems = [];
    const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : undefined);
    const pkgText = read("package.json");
    let pkg;
    try {
        pkg = pkgText ? JSON.parse(pkgText) : undefined;
    } catch {
        problems.push("package.json is not valid JSON.");
    }
    if (!pkg) problems.push("package.json is missing.");
    else {
        const deps = pkg.devDependencies ?? {};
        if (!deps["@playwright/test"]) problems.push("package.json does not name @playwright/test.");
        for (const [n, v] of Object.entries(deps)) if (!/^\d+\.\d+\.\d+$/.test(String(v))) problems.push(`package.json does not pin an exact version of ${n} (${v}).`);
        if (!/^>=\d+/.test(pkg.engines?.node ?? "")) problems.push("package.json does not say which Node.js it needs (engines).");
    }
    const lock = read("package-lock.json");
    if (!lock) problems.push("package-lock.json is missing.");
    else if (pkg) {
        const l = JSON.parse(lock);
        for (const [n, v] of Object.entries(pkg.devDependencies ?? {})) if (l.packages?.[`node_modules/${n}`]?.version !== v) problems.push(`package-lock.json does not hold ${n} ${v}.`);
    }
    if (!/^\d+\s*$/.test(read(".nvmrc") ?? "")) problems.push(".nvmrc is missing or does not name a Node.js version.");
    if (!read("playwright.config.ts")) problems.push("playwright.config.ts is missing.");
    const readme = read("README.md") ?? "";
    for (const step of ["npm ci", "npx playwright install", "npx playwright test"]) if (!readme.includes(step)) problems.push(`README.md does not say \`${step}\`.`);
    return { pkg, problems };
}

/** Reads Playwright's JSON report: how many tests passed, failed and were skipped, and the first failures. */
export function readResults(file) {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    const failures = [];
    const walk = (suite) => {
        for (const s of suite.suites ?? []) walk(s);
        for (const spec of suite.specs ?? []) if (!spec.ok) failures.push(`${spec.title}: ${(spec.tests?.[0]?.results?.at(-1)?.error?.message ?? "failed").split("\n")[0].slice(0, 300)}`);
    };
    for (const s of r.suites ?? []) walk(s);
    return { passed: r.stats?.expected ?? 0, failed: (r.stats?.unexpected ?? 0) + (r.stats?.flaky ?? 0), skipped: r.stats?.skipped ?? 0, failures };
}

export function renderReport(r) {
    const lines = [`Portable export check ${r.verdict === "passed" ? "passed" : "FAILED"}: ${r.mode}, Node.js ${r.node}, ${r.platform}${r.playwright ? `, Playwright ${r.playwright}` : ""}, ${fmtMs(r.durationMs ?? 0)}.`];
    if (r.error) lines.push(`Problem: ${r.error}`);
    for (const s of r.steps) lines.push(`  ${s.status === "ok" ? "ok  " : "FAIL"}  ${s.name} (${fmtMs(s.ms)})${s.detail ? `: ${s.detail}` : ""}`);
    if (r.results) lines.push(`Tests: ${r.results.passed} passed, ${r.results.failed} failed, ${r.results.skipped} skipped.`);
    for (const f of r.results?.failures ?? []) lines.push(`  FAIL  ${f}`);
    for (const n of r.notes) lines.push(`Note: ${n}`);
    if (r.outDir) lines.push(`Report and logs: ${r.outDir}`);
    return lines.join("\n");
}

async function startApp(children, port) {
    const entry = children.start("sample-app", process.execPath, [path.join(REPO, "examples", "sample-app", "server.mjs"), String(port)], { cwd: REPO, env: { ...process.env, PORT: String(port) } });
    const url = `http://127.0.0.1:${port}`;
    await until("the sample app to answer", async () => {
        if (!Children.running(entry)) throw new Error(`The sample app stopped (code ${entry.code}). Is port ${port} in use?\n${tail(entry.output)}`);
        return fetch(`${url}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 30_000, 300);
    return { url, entry };
}

async function startPlatform(children, port, env) {
    const entry = children.start("platform", process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join("src", "main.ts")], { cwd: REPO, env });
    const base = `http://127.0.0.1:${port}`;
    await until("the platform to answer", async () => {
        if (!Children.running(entry)) throw new Error(`The platform stopped while starting (code ${entry.code}). Is port ${port} in use?\n${tail(entry.output)}`);
        return fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 180_000, 500);
    return { base, entry };
}

// ── the run ─────────────────────────────────────────────────────────────────

/** Runs the check and returns the report (it never throws for a failed check). */
export async function runCheck(opts, deps = {}) {
    const children = deps.children ?? new Children();
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outDir = opts.out ?? path.join(REPO, ".scratch", "portable-check", stamp);
    const apiKey = `portable-${randomBytes(18).toString("hex")}`;
    const secrets = [apiKey];
    const mode = opts.exportOnly ? "export only" : opts.from ? "run a download" : "export and run";
    const report = { tool: "portable-check", format: 1, verdict: "failed", mode, node: process.version, platform: `${process.platform}-${process.arch}`, playwright: undefined, steps: [], notes: [], outDir };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-"));
    const logs = { npm: "", playwright: "" };
    /** Programs of the export step, already stopped (kept for their logs). */
    const stopped = [];
    let link;

    const step = async (name, fn) => {
        const t0 = Date.now();
        try {
            const detail = await fn();
            report.steps.push({ name, status: "ok", ms: Date.now() - t0, ...(detail ? { detail: redact(String(detail), secrets) } : {}) });
            return detail;
        } catch (e) {
            report.steps.push({ name, status: "failed", ms: Date.now() - t0, detail: redact(e.message, secrets) });
            throw e;
        }
    };

    try {
        let dir = opts.from;
        if (!dir) {
            let app;
            await step("Start the sample app", async () => {
                app = await startApp(children, opts.port + 1);
                return app.url;
            });
            let platform;
            await step("Start the platform on a new data folder", async () => {
                platform = await startPlatform(children, opts.port, platformEnv(process.env, { dataDir: path.join(tmp, "data"), apiKey, port: opts.port }));
                return platform.base;
            });
            const api = client(platform.base, apiKey);
            let projectId;
            await step("Create the sample project: five tests from steps and a code test with a helper (no AI)", async () => {
                const p = await api("POST", "/api/projects", { name: "Portable sample" });
                if (p.status >= 300 || !p.json?.id) throw new Error(`Could not create the project (${p.status}): ${p.message}`);
                projectId = p.json.id;
                const imp = await api("POST", `/api/projects/${projectId}/specs`, { baseUrl: app.url, validate: false, specs: portableSpecs(app.url) });
                if (imp.status !== 202 && imp.status !== 200) throw new Error(`Could not import the tests (${imp.status}): ${imp.message}`);
                const h = await api("PUT", `/api/projects/${projectId}/helpers/shop`, { content: CODE_HELPER });
                if (h.status >= 300) throw new Error(`Could not save the helper (${h.status}): ${h.message}`);
                const c = await api("POST", `/api/projects/${projectId}/custom-tests`, { title: "The product list shows four products", kind: "web", category: "Shop", content: codeTest(app.url) });
                if (c.status !== 201) throw new Error(`Could not save the code test (${c.status}): ${c.message}`);
                return `project ${projectId}`;
            });
            dir = opts.exportOnly ? opts.dir : path.join(tmp, "portable export (1)");
            await step("Download the project and unpack it like a person", async () => {
                const z = await api("GET", `/api/projects/${projectId}/download?includeUnvalidated=true`);
                if (z.status !== 200) throw new Error(`The download was refused (${z.status}): ${z.message}`);
                const file = path.join(tmp, "tests.zip");
                fs.writeFileSync(file, z.buf);
                if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty.`);
                const tool = await unpackZip(file, dir);
                return `${(z.buf.length / 1024).toFixed(0)} KB, unpacked with ${tool} into ${path.basename(dir)}`;
            });
            await step("Stop the platform and the sample app", async () => {
                await children.stopAll();
                stopped.push(...children.list.splice(0));
                return "";
            });
        }
        let pkg;
        await step("Check the download carries what a tester needs", async () => {
            const c = checkDownload(dir);
            pkg = c.pkg;
            if (c.problems.length) throw new Error(c.problems.join(" "));
            return `${Object.entries(pkg.devDependencies).map(([n, v]) => `${n} ${v}`).join(", ")}; Node.js ${pkg.engines.node}`;
        });
        if (!opts.exportOnly) {
            const env = { ...process.env };
            if (opts.linkNodeModules) {
                await step("Link this checkout's node_modules (no internet)", async () => {
                    link = path.join(dir, "node_modules");
                    fs.symlinkSync(path.join(REPO, "node_modules"), link, WIN ? "junction" : "dir");
                    return "instead of npm ci";
                });
            } else {
                await step("npm ci", async () => {
                    const r = await runCommand("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, env, log: (d) => (logs.npm += d) });
                    if (r.code !== 0) throw new Error(`npm ci failed (${r.timedOut ? "timed out" : `exit ${r.code}`}):\n${tail(r.output)}`);
                    return "installed from package-lock.json";
                });
                if (opts.playwright) {
                    await step(`Use Playwright ${opts.playwright} instead of the pinned ${pkg.devDependencies["@playwright/test"]}`, async () => {
                        const r = await runCommand("npm", ["install", "--no-save", "--no-audit", "--no-fund", `@playwright/test@${opts.playwright}`], { cwd: dir, env, log: (d) => (logs.npm += d) });
                        if (r.code !== 0) throw new Error(`npm install @playwright/test@${opts.playwright} failed (exit ${r.code}):\n${tail(r.output)}`);
                        return "npm install --no-save";
                    });
                }
                await step(`npx playwright install${opts.installDeps ? " --with-deps" : ""} chromium`, async () => {
                    const r = await runCommand("npx", ["playwright", "install", ...(opts.installDeps ? ["--with-deps"] : []), "chromium"], { cwd: dir, env, log: (d) => (logs.playwright += d) });
                    if (r.code !== 0) throw new Error(`The browser download failed (exit ${r.code}):\n${tail(r.output)}`);
                    return "";
                });
            }
            await step("Check which Playwright will run", async () => {
                const v = JSON.parse(fs.readFileSync(path.join(dir, "node_modules", "@playwright", "test", "package.json"), "utf8")).version;
                report.playwright = v;
                const wanted = opts.playwright ?? (opts.linkNodeModules ? v : pkg.devDependencies["@playwright/test"]);
                if (v !== wanted) throw new Error(`Playwright ${v} is installed, not ${wanted}.`);
                return v;
            });
            let app;
            await step("Start the sample app for the tests", async () => {
                app = await startApp(children, opts.port + 1);
                return app.url;
            });
            await step(opts.linkNodeModules ? "playwright test (its command line, started directly)" : "npx playwright test", async () => {
                const json = path.join(dir, "results", "portable-check.json");
                const testEnvVars = { ...testEnv(process.env, app.url), PLAYWRIGHT_JSON_OUTPUT_NAME: json };
                // Without the internet (linked node_modules) Playwright's own command line is started directly, so npx can never reach for the registry.
                const r = opts.linkNodeModules
                    ? await runCommand(process.execPath, [path.join(dir, "node_modules", "@playwright", "test", "cli.js"), "test", "--reporter=list,json"], { cwd: dir, env: testEnvVars, log: (d) => (logs.playwright += d) })
                    : await runCommand("npx", ["playwright", "test", "--reporter=list,json"], { cwd: dir, env: testEnvVars, log: (d) => (logs.playwright += d) });
                if (!fs.existsSync(json)) throw new Error(`Playwright wrote no results (exit ${r.code}):\n${tail(r.output)}`);
                report.results = readResults(json);
                const { passed, failed, skipped } = report.results;
                if (failed || skipped || passed !== EXPECTED_TESTS) throw new Error(`${passed} of ${EXPECTED_TESTS} tests passed${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}.`);
                return `${passed} tests passed`;
            });
        }
        report.verdict = "passed";
    } catch (e) {
        report.error ??= redact(e.message, secrets);
    } finally {
        const t0 = Date.now();
        let cleanup = "stopped what this run started";
        try {
            await children.stopAll();
            // Only the link, never what it points to: rmdir of a junction, unlink of a symlink.
            if (link) {
                if (WIN) fs.rmdirSync(link);
                else fs.unlinkSync(link);
                if (fs.existsSync(link)) throw new Error(`The link ${link} could not be removed, so the temporary folder was kept.`);
                if (!fs.existsSync(path.join(REPO, "node_modules", "playwright", "package.json"))) throw new Error("This checkout's node_modules is damaged after the clean-up.");
            }
            if (opts.keep) report.notes.push(`Temporary folder kept: ${tmp}`);
            else {
                try {
                    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
                } catch {
                    report.notes.push(`The temporary folder ${tmp} could not be deleted completely; the system cleans it up later.`);
                }
            }
        } catch (e) {
            cleanup = e.message;
            report.verdict = "failed";
            report.error ??= e.message;
        }
        report.steps.push({ name: "Clean up", status: cleanup.startsWith("stopped") ? "ok" : "failed", ms: Date.now() - t0, detail: cleanup });
        report.durationMs = Date.now() - started;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
            fs.writeFileSync(path.join(outDir, "report.md"), `# Portable export check\n\n\`\`\`\n${renderReport(report)}\n\`\`\`\n`);
            for (const c of [...stopped, ...children.list]) fs.writeFileSync(path.join(outDir, `${c.name}.log`), redact(c.output, secrets));
            if (logs.npm) fs.writeFileSync(path.join(outDir, "npm.log"), redact(logs.npm, secrets));
            if (logs.playwright) fs.writeFileSync(path.join(outDir, "playwright.log"), redact(logs.playwright, secrets));
        } catch (e) {
            report.notes.push(`The report could not be written to ${outDir}: ${e.message}`);
        }
    }
    return report;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        if (!(e instanceof UsageError)) throw e;
        console.error(e.message);
        process.exit(2);
    }
    if (opts.help) {
        console.log(HELP);
        return;
    }
    const children = new Children();
    const interrupt = async () => {
        await children.stopAll();
        process.exit(1);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const report = await runCheck(opts, { children });
    console.log(renderReport(report));
    process.exit(report.verdict === "passed" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => {
        console.error(`The check itself could not run: ${e?.stack ?? e}`);
        process.exit(1);
    });
}
