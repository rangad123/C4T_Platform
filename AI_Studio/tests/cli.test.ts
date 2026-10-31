/**
 * The `ai-test` command, run as a real child process (exit codes, stdout, files) against real fixture apps:
 *  - replay mode (in-process throwaway platform + real Playwright) against examples/sample-app and examples/a11y-app
 *  - remote mode against a platform server started in this test
 *  - the sticky pull-request comment against a local mock of the GitHub REST API
 * No LLM and no external network. Browser-heavy: run it inside the `browser` lock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const SAMPLE_PORT = 5270;
const A11Y_PORT = 5271;
const PLATFORM_PORT = 5272;
const KEYED_PORT = 5274;
const GITHUB_PORT = 5278;
const SAMPLE = `http://127.0.0.1:${SAMPLE_PORT}`;
const A11Y = `http://127.0.0.1:${A11Y_PORT}`;
const PLATFORM = `http://127.0.0.1:${PLATFORM_PORT}`;

const PASSWORD = "Password123!"; // the sample app's real demo password: it must never show up in any output
const USERNAME = "demo@example.com";
const GH_TOKEN = "ghs_cliTestTokenAbcdef0123456789";

let work: string;
const children: ChildProcess[] = [];
const closers: Array<() => Promise<void> | void> = [];

async function waitFor(url: string) {
    for (let i = 0; i < 60; i++) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${url} did not start`);
}
function startApp(script: string, port: number) {
    children.push(spawn(process.execPath, [path.join(REPO_ROOT, script), String(port)], { stdio: "ignore" }));
    return waitFor(`http://127.0.0.1:${port}/`);
}

interface Cli {
    code: number | null;
    stdout: string;
    stderr: string;
}
/** Run `ai-test` exactly as a pipeline would: a separate process, arguments, environment, exit code. */
function ai(args: string[], env: Record<string, string> = {}): Promise<Cli> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "bin/ai-test.mjs"), ...args], {
            cwd: REPO_ROOT,
            env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", LLM_API_KEY: "", ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`ai-test timed out\n${stdout}\n${stderr}`));
        }, 240_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

const write = (name: string, data: unknown) => {
    const file = path.join(work, name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
};
const read = (name: string) => fs.readFileSync(path.join(work, name), "utf8");
const allText = (dir: string): string =>
    fs
        .readdirSync(dir, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? allText(path.join(dir, e.name)) : /\.(png|webm|zip)$/.test(e.name) ? "" : fs.readFileSync(path.join(dir, e.name), "utf8")))
        .join("\n");

// ── the tests that replay ────────────────────────────────────────────────────
const homeSpec = { testId: "WEB-001", title: "Products page lists the catalogue", kind: "web", category: "Catalogue", priority: "high", steps: [{ action: "navigate", url: "/products" }, { action: "assert", check: "text", expected: "Trail Backpack" }] };
const apiSpec = { testId: "API-001", title: "Products API returns a list", kind: "api", category: "API", steps: [{ action: "request", method: "GET", path: "/api/products" }, { action: "assertResponse", check: "status", expected: 200 }, { action: "assertResponse", check: "jsonType", expected: "array" }] };
const brokenSpec = { testId: "WEB-002", title: "Click a button that does not exist", kind: "web", category: "Catalogue", priority: "medium", steps: [{ action: "navigate", url: "/products" }, { action: "click", locator: { by: "role", role: "button", value: "Nonexistent" } }] };
// An API key in a query string, sent to an endpoint that is documented as protected and answers anyway: the finding's
// message quotes the request path, so the key would leak into every report unless the command redacts it.
const leakSpec = {
    testId: "API-003",
    title: "Products need credentials",
    kind: "api",
    category: "API",
    priority: "high",
    tags: ["auth"],
    steps: [
        { action: "request", method: "GET", path: "/api/products?key={{credentials.password}}", auth: "none" },
        { action: "assertResponse", check: "status", expected: 401 },
    ],
};
const a11ySpec = (testId: string, title: string, url: string, priority = "medium") => ({ testId, title, kind: "web", category: "Accessibility", type: "accessibility", priority, steps: [{ action: "navigate", url }, { action: "assert", check: "a11y" }] });

// ── mock GitHub (pull-request comments) ──────────────────────────────────────
let ghComments: Array<{ id: number; body: string }> = [];
let ghRequests: string[] = [];
let ghMode: "ok" | "forbidden" = "ok";
let ghServer: http.Server;

beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitest-cli-"));
    await startApp("examples/sample-app/server.mjs", SAMPLE_PORT);
    await startApp("examples/a11y-app/server.mjs", A11Y_PORT);

    ghServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            ghRequests.push(`${req.method} ${req.url}`);
            const reply = (code: number, obj: unknown) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(obj));
            };
            if (ghMode === "forbidden") return reply(403, { message: "Resource not accessible by integration" });
            if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return reply(401, { message: "Bad credentials" });
            const list = /^\/repos\/acme\/shop\/issues\/7\/comments(\?|$)/.exec(req.url!);
            const one = /^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/.exec(req.url!);
            if (list && req.method === "GET") return reply(200, ghComments);
            if (list && req.method === "POST") {
                const c = { id: 500 + ghComments.length, body: JSON.parse(raw).body };
                ghComments.push(c);
                return reply(201, { ...c, html_url: `https://github.example/acme/shop/pull/7#issuecomment-${c.id}` });
            }
            if (one && req.method === "PATCH") {
                const c = ghComments.find((x) => x.id === Number(one[1]));
                if (!c) return reply(404, { message: "Not Found" });
                c.body = JSON.parse(raw).body;
                return reply(200, { ...c, html_url: `https://github.example/acme/shop/pull/7#issuecomment-${c.id}` });
            }
            reply(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => ghServer.listen(GITHUB_PORT, "127.0.0.1", r));
}, 60_000);

afterAll(async () => {
    for (const c of closers.reverse()) await c();
    ghServer?.close();
    for (const c of children) c.kill();
    fs.rmSync(work, { recursive: true, force: true });
});

describe("usage and infrastructure errors exit with code 2", () => {
    it("explains bad flags and prints no stack trace", async () => {
        const r = await ai(["run", "--specs", "x.json", "--url", SAMPLE, "--fail-on", "urgent"]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("--fail-on must be one of");
        expect(r.stderr).not.toMatch(/\bat .*\.ts:\d+/);
        expect((await ai(["frobnicate"])).code).toBe(2);
        expect((await ai(["run"])).code).toBe(2);
    });

    it("prints help for every command and exits 0", async () => {
        for (const args of [[], ["--help"], ["run", "--help"], ["export", "--help"], ["help", "run"]]) {
            const r = await ai(args);
            expect(r.code, args.join(" ")).toBe(0);
            expect(r.stdout).toContain("ai-test");
        }
        expect((await ai(["run", "--help"])).stdout).toMatch(/Exit codes|--fail-on/);
        expect((await ai([])).stdout).toMatch(/0 .*gate passed[\s\S]*1 .*gate failed[\s\S]*2 .*usage or infrastructure/);
    });

    it("names an environment variable that is not set, without guessing", async () => {
        const r = await ai(["run", "--specs", write("ok.json", [homeSpec]), "--url", SAMPLE, "--username-env", "NOPE_USER", "--password-env", "NOPE_PASS"]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("NOPE_USER");
    });

    it("reports a missing or invalid specs file", async () => {
        const missing = await ai(["run", "--specs", path.join(work, "nope.json"), "--url", SAMPLE]);
        expect(missing.code).toBe(2);
        expect(missing.stderr).toMatch(/Cannot read the specs file/);
        fs.writeFileSync(path.join(work, "bad.json"), "{ not json");
        expect((await ai(["run", "--specs", path.join(work, "bad.json"), "--url", SAMPLE])).stderr).toMatch(/not valid JSON/);
        fs.writeFileSync(path.join(work, "empty.json"), "[]");
        expect((await ai(["run", "--specs", path.join(work, "empty.json"), "--url", SAMPLE])).code).toBe(2);
    });

    it("tells you which test in the file is invalid", async () => {
        const r = await ai(["run", "--specs", write("invalid.json", [homeSpec, { title: "x", kind: "web", steps: [] }]), "--url", SAMPLE]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("rejected the tests");
        expect(r.stderr).toMatch(/test 2 in the file/);
    }, 60_000);

    it("reports an unreachable platform server", async () => {
        const r = await ai(["run", "--server", "http://127.0.0.1:5299", "--project", "x"]);
        expect(r.code).toBe(2);
        expect(r.stderr).toMatch(/Could not reach the platform/);
    });
});

describe("replay mode (no AI): gate, outputs, secrets", () => {
    it("passes a clean run: exit 0, every output written, summary appended, nothing leaked", async () => {
        const summary = path.join(work, "step-summary.md");
        fs.writeFileSync(summary, "# Earlier step\n");
        ghComments = [{ id: 1, body: "Thanks for the PR!" }];
        const r = await ai(
            ["run", "--specs", write("clean.json", [homeSpec, apiSpec]), "--url", SAMPLE, "--username-env", "APP_USER", "--password-env", "APP_PASS", "--junit", path.join(work, "clean.xml"), "--json", path.join(work, "clean.report.json"), "--sarif", path.join(work, "clean.sarif"), "--html", path.join(work, "clean.html"), "--markdown", path.join(work, "clean.md"), "--github-comment", "--pr", "7", "--github-repo", "acme/shop", "--github-api-url", `http://127.0.0.1:${GITHUB_PORT}`],
            { APP_USER: USERNAME, APP_PASS: PASSWORD, GITHUB_TOKEN: GH_TOKEN, GITHUB_STEP_SUMMARY: summary },
        );
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain("PASSED");
        expect(r.stdout).toContain("2 tests run · 2 passed");

        // JUnit
        const xml = read("clean.xml");
        expect(xml).toContain('tests="2" failures="0" skipped="0"');
        expect(xml).toContain("WEB-001: Products page lists the catalogue");
        // JSON (documented schema)
        const json = JSON.parse(read("clean.report.json"));
        expect(json).toMatchObject({ schemaVersion: 1, tool: { name: "ai-test" }, mode: "replay", target: SAMPLE, summary: { total: 2, passed: 2, findings: 0, failedValidation: 0, notRun: 0 }, gate: { passed: true, exitCode: 0, failOn: "high" } });
        expect(json.tests.map((t: any) => [t.testId, t.outcome]).sort()).toEqual([["API-001", "passed"], ["WEB-001", "passed"]]);
        expect(json.tests[0].durationMs).toBeGreaterThan(0);
        // SARIF: valid, empty result list
        const sarif = JSON.parse(read("clean.sarif"));
        expect(sarif).toMatchObject({ version: "2.1.0", runs: [{ tool: { driver: { name: "AI Testing Platform" } }, results: [] }] });
        // HTML / Markdown
        expect(read("clean.html")).toContain("Passed: no blocking problems.");
        expect(read("clean.md")).toContain("## AI Testing Platform: passed");
        // $GITHUB_STEP_SUMMARY is appended to, not replaced
        const appended = fs.readFileSync(summary, "utf8");
        expect(appended.startsWith("# Earlier step\n")).toBe(true);
        expect(appended).toContain("## AI Testing Platform: passed");
        // the sticky comment was created next to the existing one
        expect(ghComments).toHaveLength(2);
        expect(ghComments[1]!.body).toContain("<!-- ai-testing-platform:ci-report -->");
        expect(ghComments[1]!.body).toContain("passed");
        expect(r.stderr).toContain("Pull request comment created");

        // secrets: not in anything the command printed or wrote
        for (const text of [r.stdout, r.stderr, allText(work), ghComments.map((c) => c.body).join("\n")]) {
            expect(text).not.toContain(PASSWORD);
            expect(text).not.toContain(GH_TOKEN);
        }
    }, 240_000);

    it("fails the gate when a test cannot be validated (exit 1), redacts secrets that leak into failure messages, saves evidence and updates the same comment", async () => {
        const evidence = path.join(work, "evidence");
        const before = ghComments.length;
        const r = await ai(
            ["run", "--specs", write("broken.json", [homeSpec, brokenSpec, leakSpec]), "--url", SAMPLE, "--username-env", "APP_USER", "--password-env", "APP_PASS", "--junit", path.join(work, "broken.xml"), "--json", path.join(work, "broken.report.json"), "--html", path.join(work, "broken.html"), "--markdown", path.join(work, "broken.md"), "--evidence-dir", evidence, "--github-comment", "--pr", "7", "--github-repo", "acme/shop", "--github-api-url", `http://127.0.0.1:${GITHUB_PORT}`],
            { APP_USER: USERNAME, APP_PASS: PASSWORD, GITHUB_TOKEN: GH_TOKEN },
        );
        expect(r.code, r.stdout + r.stderr).toBe(1);
        expect(r.stdout).toContain("GATE FAILED");
        expect(r.stdout).toContain("Tests that could not be validated");
        expect(r.stdout).toContain("WEB-002 Click a button that does not exist");
        expect(r.stdout).toMatch(/\[CRITICAL\] API-003 Products need credentials/);
        expect(r.stdout).toMatch(/Gate failed: 1 finding at high or higher severity \(worst: critical\)/);
        expect(r.stdout).toMatch(/Gate failed: 1 test could not be validated/);

        const json = JSON.parse(read("broken.report.json"));
        expect(json.gate).toMatchObject({ passed: false, exitCode: 1 });
        const by = Object.fromEntries(json.tests.map((t: any) => [t.testId, t]));
        expect(by["WEB-001"].outcome).toBe("passed");
        expect(by["WEB-002"]).toMatchObject({ outcome: "failed", validation: "FAILED_VALIDATION", failedStep: { number: 2 } });
        expect(by["WEB-002"].reason).toMatch(/Nonexistent|Timeout/);

        // the leak: the finding quotes the request path (with the key in it), and the report must hide the key
        expect(by["API-003"]).toMatchObject({ outcome: "finding", severity: "critical", category: "security" });
        expect(by["API-003"].reason).toContain("/api/products?key=***");
        for (const text of [r.stdout, r.stderr, allText(work), ghComments.map((c) => c.body).join("\n")]) {
            expect(text).not.toContain(PASSWORD);
            expect(text).not.toContain(GH_TOKEN);
        }

        // evidence: screenshots of failing tests saved, referenced from the JSON and embedded in the HTML
        const shots = fs.readdirSync(evidence).filter((f) => f.endsWith(".png"));
        expect(shots.some((f) => f.startsWith("WEB-002-screenshot"))).toBe(true);
        expect(by["WEB-002"].evidence.some((e: any) => e.kind === "screenshot" && shots.includes(e.file))).toBe(true);
        expect(fs.readFileSync(path.join(evidence, shots[0]!)).subarray(1, 4).toString()).toBe("PNG");
        expect(read("broken.html")).toContain("data:image/png;base64,");
        expect(read("broken.xml")).toMatch(/failures="2"/); // the finding and the broken test

        // the same sticky comment now says the gate failed; no new comment was added
        expect(ghComments).toHaveLength(before);
        expect(ghComments[1]!.body).toContain("gate failed");
        expect(ghComments[1]!.body).toContain("WEB-002");
        expect(r.stderr).toContain("Pull request comment updated");
        expect(ghRequests.filter((x) => x.startsWith("POST")).length).toBe(1);
    }, 240_000);

    it("does not fail on broken tests when told not to (exit 0), and skips the comment outside pull requests", async () => {
        // a push event, not a pull request: there is nothing to comment on
        const push = write("push-event.json", { ref: "refs/heads/main" });
        const r = await ai(["run", "--specs", write("broken-only.json", [brokenSpec]), "--url", SAMPLE, "--no-fail-on-failed-validation", "--github-comment"], { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: "acme/shop", GITHUB_EVENT_PATH: push, GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}` });
        // nothing passed, but the gate was told to ignore broken tests, and there are no findings
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain("1 could not be validated");
        expect(r.stderr).toContain("No pull request to comment on");
    }, 240_000);

    it("finds accessibility problems and gates on their severity (exit 1 at high, 0 at critical)", async () => {
        const specs = write("a11y.json", [a11ySpec("WEB-101", "Contact page is accessible", "/clean"), a11ySpec("WEB-102", "Newsletter page is accessible", "/bad", "high"), a11ySpec("WEB-103", "Notes page has readable text", "/contrast")]);
        const high = await ai(["run", "--specs", specs, "--url", A11Y, "--sarif", path.join(work, "a11y.sarif"), "--json", path.join(work, "a11y.json.out"), "--junit", path.join(work, "a11y.xml")]);
        expect(high.code, high.stdout + high.stderr).toBe(1);
        expect(high.stdout).toMatch(/\[HIGH\] WEB-102 Newsletter page is accessible/);
        expect(high.stdout).toMatch(/\[MEDIUM\] WEB-103/);
        expect(high.stdout).toMatch(/Gate failed: 1 finding at high or higher severity \(worst: high\)/);

        const json = JSON.parse(read("a11y.json.out"));
        const by = Object.fromEntries(json.tests.map((t: any) => [t.testId, t]));
        expect(by["WEB-101"].outcome).toBe("passed");
        expect(by["WEB-102"]).toMatchObject({ outcome: "finding", severity: "high", category: "accessibility" });
        expect(by["WEB-102"].severityBasis).toMatch(/critical accessibility violation/);
        expect(by["WEB-103"]).toMatchObject({ outcome: "finding", severity: "medium" });
        expect(json.summary).toMatchObject({ findings: 2, passed: 1, bySeverity: { critical: 0, high: 1, medium: 1, low: 0 } });

        // SARIF 2.1.0: one result per finding with severity -> level, each pointing at its test in the specs file
        const sarif = JSON.parse(read("a11y.sarif"));
        const results = sarif.runs[0].results;
        expect(results).toHaveLength(2);
        const byId = Object.fromEntries(results.map((x: any) => [x.properties.testId, x]));
        expect(byId["WEB-102"].level).toBe("error");
        expect(byId["WEB-103"].level).toBe("warning");
        expect(byId["WEB-102"].ruleId).toBe("ai-testing/accessibility");
        expect(byId["WEB-102"].locations[0].physicalLocation.artifactLocation.uri).toBe(path.relative(process.cwd(), specs).split(path.sep).join("/"));
        const line = byId["WEB-102"].locations[0].physicalLocation.region.startLine;
        expect(fs.readFileSync(specs, "utf8").split("\n")[line - 1]).toContain("WEB-102");
        expect(sarif.runs[0].tool.driver.rules.every((x: any) => x.id && x.shortDescription?.text && x.defaultConfiguration?.level)).toBe(true);
        expect(read("a11y.xml")).toContain('type="application-finding"');

        // findings below the threshold do not fail the pipeline, but are still reported
        // (and a token that may not comment is a warning, never a failure)
        ghMode = "forbidden";
        try {
            const critical = await ai(["run", "--specs", specs, "--url", A11Y, "--fail-on", "critical", "--github-comment", "--pr", "7", "--github-repo", "acme/shop", "--github-api-url", `http://127.0.0.1:${GITHUB_PORT}`], { GITHUB_TOKEN: GH_TOKEN });
            expect(critical.code, critical.stdout + critical.stderr).toBe(0);
            expect(critical.stdout).toContain("PASSED");
            expect(critical.stdout).toMatch(/\[HIGH\] WEB-102/);
            expect(critical.stderr).toMatch(/warning: Could not post the pull request comment/);
            expect(critical.stderr).toContain("pull-requests: write");
        } finally {
            ghMode = "ok";
        }
    }, 300_000);
});

describe("remote mode (driving a running platform)", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let keyed: Awaited<ReturnType<typeof buildServer>>;
    let keyedPlatform: Platform;

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        const dir = fs.mkdtempSync(path.join(work, "platform-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, MAX_REPAIR_ATTEMPTS: "1" }));
        server = await buildServer(platform);
        await server.listen({ port: PLATFORM_PORT, host: "127.0.0.1" });
        worker = new Worker(platform, 200);
        worker.start();

        const keyedDir = fs.mkdtempSync(path.join(work, "keyed-"));
        keyedPlatform = bootstrap(loadConfig({ DATA_DIR: keyedDir, API_KEY: "right-key-12345" }));
        keyed = await buildServer(keyedPlatform);
        await keyed.listen({ port: KEYED_PORT, host: "127.0.0.1" });
        closers.push(async () => {
            await worker.stop();
            await server.close();
            await keyed.close();
            platform.db.close();
            keyedPlatform.db.close();
        });
    }, 60_000);

    it("imports specs into a project and runs them", async () => {
        const first = await ai(["run", "--server", PLATFORM, "--project", "ci-demo", "--specs", write("remote.json", [homeSpec, apiSpec]), "--url", SAMPLE, "--json", path.join(work, "remote.report.json")]);
        expect(first.code, first.stdout + first.stderr).toBe(0);
        const report = JSON.parse(read("remote.report.json"));
        expect(report.mode).toBe("remote-replay");
        expect(report.project.name).toBe("ci-demo");
        expect(report.summary).toMatchObject({ total: 2, passed: 2 });
        // links point at the platform UI so a reviewer can click through
        expect(report.tests[0].link).toMatch(new RegExp(`^${PLATFORM}/#/tests/`));
        const projects = (await (await fetch(`${PLATFORM}/api/projects`)).json()) as Array<{ id: string; name: string }>;
        expect(projects.filter((p) => p.name === "ci-demo")).toHaveLength(1);
    }, 300_000);

    it("reuses the project on the next run: only tests it does not have yet are added, and a broken one gates (exit 1)", async () => {
        const before = (await (await fetch(`${PLATFORM}/api/projects`)).json()) as Array<{ id: string; name: string }>;
        const id = before.find((p) => p.name === "ci-demo")!.id;
        const r = await ai(["run", "--server", PLATFORM, "--project", "ci-demo", "--specs", write("remote2.json", [homeSpec, apiSpec, brokenSpec]), "--url", SAMPLE]);
        expect(r.code, r.stdout + r.stderr).toBe(1);
        expect(r.stdout).toContain("WEB-002");
        const tests = (await (await fetch(`${PLATFORM}/api/projects/${id}/tests`)).json()) as Array<{ testId: string }>;
        expect(tests.map((t) => t.testId).sort()).toEqual(["API-001", "WEB-001", "WEB-002"]); // no duplicates of the first two
        expect((await (await fetch(`${PLATFORM}/api/projects`)).json()) as unknown[]).toHaveLength(before.length); // no new project
    }, 300_000);

    it("re-runs an existing project's tests without any specs file", async () => {
        const r = await ai(["run", "--server", PLATFORM, "--project", "ci-demo", "--url", SAMPLE, "--json", path.join(work, "rerun.json")]);
        expect(r.code, r.stdout + r.stderr).toBe(1);
        expect(JSON.parse(read("rerun.json"))).toMatchObject({ mode: "remote-rerun", summary: { total: 3, passed: 2, failedValidation: 1 } });
    }, 300_000);

    it("exports a project's tests to a file that replays", async () => {
        const out = path.join(work, "exported.json");
        const r = await ai(["export", "--server", PLATFORM, "--project", "ci-demo", "--out", out]);
        expect(r.code, r.stdout + r.stderr).toBe(0);
        expect(r.stdout).toContain("Exported 3 tests");
        const file = JSON.parse(fs.readFileSync(out, "utf8"));
        expect(file.specs.map((s: any) => s.testId).sort()).toEqual(["API-001", "WEB-001", "WEB-002"]);
        const none = await ai(["export", "--server", PLATFORM, "--project", "no-such-project", "--out", out]);
        expect(none.code).toBe(2);
        expect(none.stderr).toMatch(/No project called/);
    }, 60_000);

    it("rejects a wrong API key with a clear message, and accepts the right one (from an environment variable)", async () => {
        const wrong = await ai(["export", "--server", `http://127.0.0.1:${KEYED_PORT}`, "--project", "x"], { AI_TEST_API_KEY: "wrong-key" });
        expect(wrong.code).toBe(2);
        expect(wrong.stderr).toMatch(/refused the API key/);
        expect(wrong.stderr).not.toContain("wrong-key");
        const right = await ai(["export", "--server", `http://127.0.0.1:${KEYED_PORT}`, "--project", "x", "--api-key-env", "MY_KEY"], { MY_KEY: "right-key-12345" });
        expect(right.code).toBe(2);
        expect(right.stderr).toMatch(/No project called/); // got past authentication
        expect(right.stderr).not.toContain("right-key-12345");
        const none = await ai(["export", "--server", `http://127.0.0.1:${KEYED_PORT}`, "--project", "x"]);
        expect(none.stderr).toMatch(/refused the API key/);
    }, 60_000);
});

describe("generate mode (--analyze)", () => {
    it("generates and validates tests in-process; without an AI key only the AI-free part runs (API tests from the OpenAPI document, deterministic page checks)", async () => {
        // Gate switched off: this test is about the mode working end to end, not about what the sample app's pages contain.
        const r = await ai(["run", "--analyze", "--url", SAMPLE, "--max-pages", "3", "--fail-on", "none", "--no-fail-on-failed-validation", "--json", path.join(work, "analyze.json"), "--token-env", "APP_TOKEN"], { APP_TOKEN: "demo-token-123" });
        expect(r.code, r.stdout + r.stderr).toBe(0);
        const json = JSON.parse(read("analyze.json"));
        expect(json.mode).toBe("analyze");
        expect(json.summary.total).toBeGreaterThan(3);
        expect(json.tests.filter((t: any) => t.kind === "api" && t.outcome === "passed").length).toBeGreaterThan(3);
        expect(r.stdout + r.stderr + read("analyze.json")).not.toContain("demo-token-123");
    }, 400_000);
});
