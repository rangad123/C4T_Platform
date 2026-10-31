/**
 * `ai-test` building blocks that need no browser: argument validation, the gate, every output format,
 * and the sticky pull-request comment against a local mock of the GitHub REST API.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli/args.js";
import { UsageError } from "../src/cli/errors.js";
import { postStickyComment, prFromEvent } from "../src/cli/github-comment.js";
import { categorize, evaluateGate, REPORT_SCHEMA_VERSION, summarize, type CiReport, type CiTest } from "../src/cli/model.js";
import { COMMENT_MARKER, renderHtml, renderJson, renderJunit, renderMarkdown, renderSarif } from "../src/cli/render.js";

const test = (over: Partial<CiTest>): CiTest => ({ id: "x", testId: "WEB-001", title: "A test", suite: "General", kind: "web", type: "functional", priority: "high", outcome: "passed", validation: "VALIDATED", durationMs: 100, attempts: 1, evidence: [], ...over });
const finding = (testId: string, severity: CiTest["severity"], reason: string, category: CiTest["category"] = "functional-defect") =>
    test({ testId, title: `Finding ${testId}`, outcome: "finding", validation: "NEEDS_REVIEW", severity, severityBasis: "basis", reason, category });

describe("argument validation", () => {
    const usage = (argv: string[]) => {
        try {
            parseCli(argv);
        } catch (e) {
            expect(e).toBeInstanceOf(UsageError);
            return (e as Error).message;
        }
        throw new Error("expected a usage error");
    };

    it("accepts the documented modes", () => {
        const r = parseCli(["run", "--specs", "a.json", "--url", "http://x.test", "--fail-on", "medium", "--junit", "j.xml"]);
        expect(r).toMatchObject({ command: "run", args: { specs: "a.json", "fail-on": "medium", "fail-on-failed-validation": true, junit: "j.xml", timeout: 1800, "github-token-env": "GITHUB_TOKEN" } });
        expect(parseCli(["run", "--analyze", "--url", "http://x.test"])).toMatchObject({ args: { analyze: true, "fail-on": "high" } });
        expect(parseCli(["run", "--server", "http://p.test", "--project", "demo", "--url", "http://x.test", "--specs", "a.json"])).toMatchObject({ args: { server: "http://p.test" } });
        expect(parseCli(["run", "--server", "http://p.test", "--project", "demo"])).toMatchObject({ args: { project: "demo" } }); // re-run an existing project
        expect(parseCli(["run", "--specs", "a.json", "--url", "http://x.test", "--no-fail-on-failed-validation"])).toMatchObject({ args: { "fail-on-failed-validation": false } });
        expect(parseCli(["export", "--server", "http://p.test", "--project", "demo"])).toMatchObject({ command: "export", args: { out: "ai-tests.json" } });
    });

    it("explains mistakes in plain words", () => {
        expect(usage(["run"])).toMatch(/Say what to run/);
        expect(usage(["run", "--specs", "a.json"])).toMatch(/--url/);
        expect(usage(["run", "--specs", "a.json", "--analyze", "--url", "http://x.test"])).toMatch(/not both/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--fail-on", "urgent"])).toMatch(/--fail-on must be one of: critical, high, medium, low, any, none/);
        expect(usage(["run", "--specs", "a.json", "--url", "nope"])).toMatch(/full address/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--bogus"])).toMatch(/bogus/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--timeout", "5"])).toMatch(/at least 30/);
        expect(usage(["run", "--server", "http://p.test"])).toMatch(/--project/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--project", "p"])).toMatch(/only applies together with --server/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--username-env", "U"])).toMatch(/--password-env/);
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--pr", "3"])).toMatch(/--github-comment/);
        expect(usage(["export", "--server", "http://p.test"])).toMatch(/--project is required/);
        expect(usage(["publish"])).toMatch(/Unknown command/);
    });

    it("refuses a secret passed where the NAME of an environment variable is expected", () => {
        expect(usage(["run", "--specs", "a.json", "--url", "http://x.test", "--username-env", "u", "--password-env", "p@ss w0rd!"])).toMatch(/NAME of an environment variable/);
    });

    it("shows help for every command", () => {
        expect(parseCli([])).toEqual({ command: "help", topic: undefined });
        expect(parseCli(["run", "--help"])).toEqual({ command: "help", topic: "run" });
        expect(parseCli(["export", "-h"])).toEqual({ command: "help", topic: "export" });
        expect(parseCli(["help", "run"])).toEqual({ command: "help", topic: "run" });
    });
});

describe("finding categories", () => {
    it.each([
        ["Possible security issue: GET /api/me is documented as requiring authentication", "security"],
        ["Security check failed: 4 browser security headers missing or weak", "security-check"],
        ["Page health check failed: 1 JavaScript error was reported on this page", "page-health"],
        ["Server error: GET /api/x returned 500", "server-error"],
        ["Accessibility audit failed: - [critical] image-alt", "accessibility"],
        ["Visual change: 1200 pixels differ", "visual-change"],
        ["Something else went wrong", "functional-defect"],
        [undefined, "functional-defect"],
    ] as const)("%s -> %s", (reason, category) => {
        expect(categorize(reason)).toBe(category);
    });
});

describe("the gate", () => {
    const tests = [test({ testId: "WEB-001" }), finding("WEB-002", "medium", "m"), finding("WEB-003", "low", "l"), test({ testId: "WEB-004", outcome: "failed", validation: "FAILED_VALIDATION", reason: "boom" }), test({ testId: "WEB-005", outcome: "not_run", validation: "PENDING" })];

    it.each([
        ["critical", true, 1, /1 test could not be validated/],
        ["high", true, 1, /1 test could not be validated/],
        ["medium", true, 1, /1 finding at medium or higher severity \(worst: medium\)/],
        ["low", true, 1, /2 findings at low or higher/],
        ["any", true, 1, /2 findings at any severity/],
        ["none", true, 1, /could not be validated/],
        ["high", false, 0, undefined],
        ["critical", false, 0, undefined],
        ["medium", false, 1, /1 finding/],
        ["none", false, 0, undefined],
    ] as const)("fail-on %s, failed validations counted=%s -> exit %i", (failOn, strict, exit, reason) => {
        const g = evaluateGate(tests, failOn, strict);
        expect(g.exitCode).toBe(exit);
        expect(g.passed).toBe(exit === 0);
        if (reason) expect(g.reasons.join(" ")).toMatch(reason);
        else expect(g.reasons).toEqual([]);
    });

    it("never fails on tests that did not run", () => {
        expect(evaluateGate([test({ outcome: "not_run", validation: "PENDING" })], "any", true).exitCode).toBe(0);
    });

    it("counts findings by severity", () => {
        expect(summarize(tests)).toMatchObject({ total: 5, passed: 1, findings: 2, failedValidation: 1, notRun: 1, bySeverity: { critical: 0, high: 0, medium: 1, low: 1 } });
    });
});

const report = (tests: CiTest[], over: Partial<CiReport> = {}): CiReport => ({
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "ai-test", version: "0.1.0" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    mode: "replay",
    target: "http://app.test",
    project: { name: "Demo <project>" },
    durationMs: 4200,
    summary: summarize(tests),
    gate: evaluateGate(tests, "high", true),
    tests,
    ...over,
});

describe("outputs", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const tests = [
        test({ testId: "WEB-001", title: "Home loads" }),
        finding("WEB-002", "high", "Accessibility audit failed:\n- [critical] image-alt: <img> needs alt", "accessibility"),
        finding("WEB-003", "medium", "Server error: GET /api/x returned 500", "server-error"),
        test({ testId: "WEB-004", title: "Broken <script>alert(1)</script>", outcome: "failed", validation: "FAILED_VALIDATION", reason: "Timeout <b>waiting</b> | pipe", evidence: [{ kind: "screenshot", data: png }] }),
        test({ testId: "WEB-005", outcome: "not_run", validation: "PENDING" }),
    ];
    const r = report(tests);

    it("SARIF 2.1.0 has the required structure, one result per finding, and stable fingerprints", () => {
        const specsText = `[\n  {\n    "testId": "WEB-001"\n  },\n  {\n    "testId": "WEB-002"\n  },\n  {\n    "testId": "WEB-003"\n  }\n]`;
        const sarif = JSON.parse(renderSarif(r, { specsFile: "tests/ai-tests.json", specsText, fingerprint: (s) => `fp:${s.length}` }));
        expect(sarif.version).toBe("2.1.0");
        expect(sarif.$schema).toContain("sarif-2.1.0");
        expect(sarif.runs).toHaveLength(1);
        const run = sarif.runs[0];
        expect(run.tool.driver.name).toBe("AI Testing Platform");
        const ruleIds = run.tool.driver.rules.map((x: any) => x.id);
        expect(ruleIds).toEqual(["ai-testing/server-error", "ai-testing/accessibility"]);
        expect(run.results).toHaveLength(2); // only findings: not passes, not broken tests
        for (const res of run.results) {
            expect(ruleIds[res.ruleIndex]).toBe(res.ruleId);
            expect(["error", "warning", "note"]).toContain(res.level);
            expect(res.message.text.length).toBeGreaterThan(5);
            expect(res.locations[0].physicalLocation.artifactLocation.uri).toBe("tests/ai-tests.json");
            expect(res.locations[0].physicalLocation.region.startLine).toBeGreaterThanOrEqual(1);
            expect(res.partialFingerprints["aiTesting/v1"]).toMatch(/^fp:/);
        }
        const [a11y, server] = [run.results.find((x: any) => x.message.text.startsWith("WEB-002")), run.results.find((x: any) => x.message.text.startsWith("WEB-003"))];
        expect(a11y.level).toBe("error"); // high
        expect(server.level).toBe("warning"); // medium
        expect(a11y.locations[0].physicalLocation.region.startLine).toBe(6); // points at the test inside the specs file
        expect(run.invocations[0].executionSuccessful).toBe(true);
    });

    it("JSON report is versioned and never carries image bytes", () => {
        const json = JSON.parse(renderJson(r));
        expect(json.schemaVersion).toBe(1);
        expect(json).toMatchObject({ mode: "replay", target: "http://app.test", gate: { passed: false, exitCode: 1, failOn: "high" }, summary: { total: 5, findings: 2, failedValidation: 1, notRun: 1 } });
        expect(json.tests).toHaveLength(5);
        expect(json.tests[3].evidence).toEqual([{ kind: "screenshot" }]);
        expect(renderJson(r)).not.toContain(png.toString("base64"));
    });

    it("JUnit marks findings and broken tests as failures and unrun tests as skipped", () => {
        const xml = renderJunit(r);
        expect(xml).toContain('tests="5" failures="3" skipped="1"');
        expect(xml).toContain('type="application-finding"');
        expect(xml).toContain('type="test-failure"');
        expect(xml).toContain('<skipped message="not executed"/>');
        expect(xml).toContain("&lt;b&gt;waiting&lt;/b&gt;");
    });

    it("HTML is one self-contained page that escapes content and embeds screenshots", () => {
        const html = renderHtml(r);
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).not.toContain("<script");
        expect(html).not.toMatch(/(src|href)="https?:/); // nothing fetched from anywhere
        expect(html).toContain("Broken &lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).toContain("Demo &lt;project&gt;");
        expect(html).toContain(`data:image/png;base64,${png.toString("base64")}`);
        expect(html).toContain("Gate failed");
        expect(html).toContain("Findings (2)");
    });

    it("Markdown summarises the gate and escapes table separators; the comment form carries the marker", () => {
        const md = renderMarkdown(r);
        expect(md).toContain("## AI Testing Platform: gate failed");
        expect(md).toContain("| Run | Passed | Findings | Could not validate | Not run |");
        expect(md).toContain("| High | WEB-002 Finding WEB-002 |");
        expect(md).toContain("waiting</b> \\| pipe");
        expect(md.indexOf("High |")).toBeLessThan(md.indexOf("Medium |")); // worst first
        expect(md).not.toContain(COMMENT_MARKER);
        expect(renderMarkdown(r, { comment: true }).startsWith(COMMENT_MARKER)).toBe(true);
        expect(renderMarkdown(report([test({})]))).toContain("passed");
    });
});

// ── mock GitHub REST API (comments) ──────────────────────────────────────────

const TOKEN = "ghs_commentTokenForTests0123456789";
interface Comment {
    id: number;
    body: string;
    html_url: string;
}
let comments: Comment[] = [];
let nextId = 100;
let mode: "ok" | "forbidden" | "down" = "ok";
const seenAuth: string[] = [];
let server: http.Server;
const API = "http://127.0.0.1:5273";

beforeAll(async () => {
    server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
            const reply = (code: number, obj: unknown) => {
                res.writeHead(code, { "content-type": "application/json" });
                res.end(JSON.stringify(obj));
            };
            seenAuth.push(String(req.headers.authorization));
            if (mode === "forbidden") return reply(403, { message: "Resource not accessible by integration" });
            if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { message: "Bad credentials" });
            const url = new URL(req.url!, API);
            const list = /^\/repos\/acme\/shop\/issues\/(\d+)\/comments$/.exec(url.pathname);
            const one = /^\/repos\/acme\/shop\/issues\/comments\/(\d+)$/.exec(url.pathname);
            if (list && req.method === "GET") {
                const page = Number(url.searchParams.get("page") ?? 1);
                const per = Number(url.searchParams.get("per_page") ?? 30);
                return reply(200, comments.slice((page - 1) * per, page * per));
            }
            if (list && req.method === "POST") {
                const c = { id: nextId++, body: JSON.parse(raw).body, html_url: `https://github.example/acme/shop/pull/${list[1]}#issuecomment-${nextId - 1}` };
                comments.push(c);
                return reply(201, c);
            }
            if (one && req.method === "PATCH") {
                const c = comments.find((x) => x.id === Number(one[1]));
                if (!c) return reply(404, { message: "Not Found" });
                c.body = JSON.parse(raw).body;
                return reply(200, c);
            }
            reply(404, { message: "Not Found" });
        });
    });
    await new Promise<void>((r) => server.listen(5273, "127.0.0.1", r));
});
afterAll(() => server?.close());

describe("sticky pull-request comment", () => {
    const target = { apiUrl: API, owner: "acme", repo: "shop", pr: 7, token: TOKEN };
    const md = (n: number) => renderMarkdown(report([finding("WEB-002", "high", `run ${n}`)]), { comment: true });

    it("creates one comment, then updates that same comment on every rerun", async () => {
        comments = [{ id: 1, body: "Thanks for the PR!", html_url: "https://github.example/c/1" }];
        const first = await postStickyComment(target, md(1));
        expect(first).toMatchObject({ posted: "created" });
        expect(comments).toHaveLength(2);
        const second = await postStickyComment(target, md(2));
        const third = await postStickyComment(target, md(3));
        expect(second).toMatchObject({ posted: "updated" });
        expect(third).toMatchObject({ posted: "updated" });
        expect(comments).toHaveLength(2); // no duplicates, someone else's comment untouched
        expect(comments[0]!.body).toBe("Thanks for the PR!");
        expect(comments[1]!.body).toContain("run 3");
        expect(comments[1]!.body.startsWith(COMMENT_MARKER)).toBe(true);
    });

    it("finds its comment even after more than 100 other comments", async () => {
        comments = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, body: `chat ${i}`, html_url: "u" }));
        nextId = 1000;
        await postStickyComment(target, md(1));
        comments.push(...Array.from({ length: 120 }, (_, i) => ({ id: 2000 + i, body: `later ${i}`, html_url: "u" })));
        const again = await postStickyComment(target, md(2));
        expect(again).toMatchObject({ posted: "updated" });
        expect(comments.filter((c) => c.body.includes(COMMENT_MARKER))).toHaveLength(1);
    });

    it("keeps an over-long comment within GitHub's limit", async () => {
        comments = [];
        await postStickyComment(target, `${COMMENT_MARKER}\n${"x".repeat(100_000)}`);
        expect(comments[0]!.body.length).toBeLessThan(65_536);
        expect(comments[0]!.body.endsWith("(truncated)")).toBe(true);
    });

    it("warns instead of throwing when the token lacks permission, and says what to change", async () => {
        mode = "forbidden";
        const out = await postStickyComment(target, md(1));
        mode = "ok";
        expect(out.posted).toBe(false);
        expect((out as { warning: string }).warning).toMatch(/pull-requests: write/);
        const bad = await postStickyComment({ ...target, token: "ghs_wrong" }, md(1));
        expect(bad.posted).toBe(false);
        expect(JSON.stringify(bad)).not.toContain("ghs_wrong");
    });

    it("warns when GitHub cannot be reached", async () => {
        const out = await postStickyComment({ ...target, apiUrl: "http://127.0.0.1:5299" }, md(1));
        expect(out).toMatchObject({ posted: false });
        expect((out as { warning: string }).warning).toMatch(/couldn’t reach GitHub/);
    });

    it("reads the pull request number from a GitHub Actions event file", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitest-ev-"));
        const file = path.join(dir, "event.json");
        fs.writeFileSync(file, JSON.stringify({ action: "synchronize", number: 42, pull_request: { number: 42 } }));
        expect(prFromEvent(file)).toBe(42);
        fs.writeFileSync(file, JSON.stringify({ ref: "refs/heads/main" })); // a push, not a pull request
        expect(prFromEvent(file)).toBeUndefined();
        expect(prFromEvent(path.join(dir, "missing.json"))).toBeUndefined();
        expect(prFromEvent(undefined)).toBeUndefined();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
