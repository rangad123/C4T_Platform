/**
 * Page health checks: spec generation, script rendering (collector installed before navigation, soft
 * steps), real execution under Playwright against fixture apps (examples/checks-app), finding
 * classification, severity, live-interpreter parity and the mixed-content / noise rules that need an
 * https page or a fake origin.
 *
 * Fixture ports: weak 5217, hardened 5218, single-page app 5219, weak over https 5220; 5221 is never
 * started (a page that does not load).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { HEALTH_CHECKS, HEALTH_FAILURE_PREFIX, HEALTH_HELPER_SOURCE, loadHealthRuntime } from "../src/engine/health/checks.js";
import { generateHealthSpecs, healthFinding, parseHealthReason } from "../src/engine/health/specs.js";
import { TestSpecSchema, describeStep, type TestSpec } from "../src/engine/spec/schema.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { runScripts, type ScriptRun } from "../src/engine/validation/runner.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";
import { modelFor, startChecksApp } from "./fixtures/checks-app.js";

const PORTS = { weak: 5217, hardened: 5218, spa: 5219, weakTls: 5220, dead: 5221 };
const base = (port: number, scheme = "http") => `${scheme}://127.0.0.1:${port}`;
const children: ChildProcess[] = [];
let browser: Browser;

beforeAll(async () => {
    children.push(await startChecksApp(PORTS.weak, "weak"), await startChecksApp(PORTS.hardened, "hardened"), await startChecksApp(PORTS.spa, "spa"), await startChecksApp(PORTS.weakTls, "weak", "localhost"));
    browser = await launchChromium(true);
}, 60_000);
afterAll(async () => {
    await browser?.close();
    for (const c of children) c.kill();
});

const specsFor = (origin: string, pages: Array<{ path: string; type: "home" | "content" }>): TestSpec[] =>
    generateHealthSpecs(modelFor(origin, pages), { maxPages: 6 }).map((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }));
const forPath = (specs: TestSpec[], p: string) => specs.find((s) => (s.steps[0] as { url: string }).url === p)!;

async function runHealth(entries: Array<{ spec: TestSpec; baseUrl: string }>): Promise<Map<string, ScriptRun>> {
    const scripts = entries.map(({ spec, baseUrl }) => {
        const r = renderScript(spec, "playwright", { baseUrl });
        return { testId: spec.testId, filename: r.filename, content: r.content };
    });
    // every script reads BASE_URL from the environment first, so give each its own origin through the file default
    const out: ScriptRun[] = [];
    for (const group of [...new Set(entries.map((e) => e.baseUrl))]) {
        const these = scripts.filter((_, i) => entries[i]!.baseUrl === group);
        out.push(...(await runScripts(loadConfig({}).scratchDir, these, { baseUrl: group, headless: true }, { workers: 3 })));
    }
    return new Map(out.map((r) => [r.testId, r]));
}

describe("generateHealthSpecs", () => {
    const model = modelFor("https://shop.example", [
        { path: "/", type: "home" },
        { path: "/login", type: "login" },
        { path: "/products/1", type: "detail" },
        { path: "/products/2", type: "detail" },
        { path: "/oops", type: "error" },
        { path: "/account", type: "account" },
        { path: "/a", type: "content" },
        { path: "/b", type: "content" },
        { path: "/c", type: "content" },
    ]);

    it("makes one health spec per key page, capped, with the five checks as separate steps", () => {
        const drafts = generateHealthSpecs(model, { maxPages: 4 });
        expect(drafts.map((d) => (d.steps[0] as { url: string }).url)).toEqual(["/", "/login", "/products/1", "/account"]);
        const home = drafts[0]!;
        expect(home).toMatchObject({ kind: "web", type: "health", category: "Health checks", priority: "high", tags: ["health"], source: { origin: "health-check" } });
        expect(home.steps.map((s) => s.action === "assert" && s.check)).toEqual([false, ...HEALTH_CHECKS]);
        expect(home.title).toBe("Home page is healthy: no script errors, failed requests or broken links (/)");
        drafts.forEach((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }));
        expect(generateHealthSpecs(model, { maxPages: 6 }).length).toBeLessThanOrEqual(6);
    });

    it("skips pages that were only reachable logged in", () => {
        const loggedIn = { ...model, authentication: { required: true, mechanisms: [], loggedIn: true } };
        expect(generateHealthSpecs(loggedIn, { maxPages: 20 }).map((d) => (d.steps[0] as { url: string }).url)).not.toContain("/account");
    });

    it("describes each check in plain words", () => {
        const draft = generateHealthSpecs(model, { maxPages: 1 })[0]!;
        const sentences = draft.steps.map((s) => describeStep(s));
        expect(sentences).toEqual([
            "Open /",
            "No JavaScript errors are reported",
            "No request to this site fails",
            "No link to this site's own pages is broken",
            "No insecure (http://) content is loaded on a secure page",
            "Title, language, viewport setting and one main heading are present",
        ]);
        // without a curated description the wording still reads well
        expect(describeStep({ action: "assert", check: "noBrokenLinks", description: "" })).toBe("No link to this site's own pages is broken");
    });
});

describe("rendered scripts", () => {
    const spec = specsFor(base(PORTS.weak), [{ path: "/", type: "home" }])[0]!;
    const { content } = renderScript(spec, "playwright", { baseUrl: base(PORTS.weak) });

    it("install the collector before the first navigation and carry the helper verbatim", () => {
        expect(content).toContain(HEALTH_HELPER_SOURCE);
        expect(content.indexOf("const health = installHealthCollector(page,")).toBeGreaterThan(content.indexOf("async ({ page }) => {"));
        expect(content.indexOf("const health = installHealthCollector(page,")).toBeLessThan(content.indexOf("page.goto("));
        expect(renderScript(spec, "playwright", { baseUrl: base(PORTS.weak) }).content).toBe(content); // re-renders identically
        expect(HEALTH_HELPER_SOURCE).not.toMatch(/`|\$\{/); // lives in a template literal and in new Function()
    });

    it("make the five health steps soft (one run lists every kind of problem) and fail the test at the end", () => {
        expect(content.match(/\.catch\(\(e\) => healthFailures\.push\(e\)\)/g)).toHaveLength(5);
        expect(content).toContain("if (healthFailures.length) throw healthFailures[0];");
        // the navigation step is NOT soft: a page that does not load stops the test
        expect(content).toMatch(/await test\.step\("1\. Open \/", async \(\) => \{\n\s+await page\.goto\([^\n]+\n\s+\}\);/);
    });

    it("hold no secrets, and other web scripts do not carry the helper", () => {
        expect(content).not.toMatch(/TEST_PASSWORD|TEST_USERNAME|API_TOKEN/);
        const plain = TestSpecSchema.parse({ testId: "WEB-100", title: "plain", kind: "web", steps: [{ action: "navigate", url: "/" }] });
        const r = renderScript(plain, "playwright", { baseUrl: base(PORTS.weak) }).content;
        expect(r).not.toContain("installHealthCollector");
        expect(r).not.toContain("healthFailures");
    });
});

describe("real execution", () => {
    const weakSpecs = specsFor(base(PORTS.weak), [{ path: "/", type: "home" }, { path: "/about", type: "content" }, { path: "/basics", type: "content" }]);
    const hardenedSpecs = specsFor(base(PORTS.hardened), [{ path: "/", type: "home" }]);
    const missing = TestSpecSchema.parse({ ...generateHealthSpecs(modelFor(base(PORTS.hardened), [{ path: "/nonexistent", type: "content" }]), { maxPages: 1 })[0]!, testId: "WEB-050" });
    const spa = TestSpecSchema.parse({ ...generateHealthSpecs(modelFor(base(PORTS.spa), [{ path: "/", type: "home" }]), { maxPages: 1 })[0]!, testId: "WEB-060" });
    const dead = TestSpecSchema.parse({ ...generateHealthSpecs(modelFor(base(PORTS.dead), [{ path: "/", type: "home" }]), { maxPages: 1 })[0]!, testId: "WEB-070" });
    const hardenedHome = { ...hardenedSpecs[0]!, testId: "WEB-040" };
    let runs: Map<string, ScriptRun>;

    beforeAll(async () => {
        runs = await runHealth([
            ...weakSpecs.map((spec) => ({ spec, baseUrl: base(PORTS.weak) })),
            { spec: hardenedHome, baseUrl: base(PORTS.hardened) },
            { spec: missing, baseUrl: base(PORTS.hardened) },
            { spec: spa, baseUrl: base(PORTS.spa) },
            { spec: dead, baseUrl: base(PORTS.dead) },
        ]);
    }, 240_000);

    const stepStates = (r: ScriptRun) => r.steps.map((s) => s.status);

    it("reports every kind of problem on the weak home page, each on its own step", () => {
        const spec = forPath(weakSpecs, "/");
        const r = runs.get(spec.testId)!;
        expect(r.status).toBe("failed");
        // navigate ok, console errors / failed requests / broken links fail, mixed content (http page) and basics pass
        expect(stepStates(r)).toEqual(["passed", "failed", "failed", "failed", "passed", "passed"]);
        expect(r.failedStepIndex).toBe(1);
        const [, errors, requests, links] = r.steps;
        expect(errors!.error).toContain(`${HEALTH_FAILURE_PREFIX} 2 JavaScript errors were reported on this page`);
        expect(errors!.error).toContain("- [medium] Uncaught error: Boom on the home page");
        expect(errors!.error).toContain("- [medium] console.error: Home console error");
        expect(requests!.error).toContain("2 requests to this site failed");
        expect(requests!.error).toContain("- [high] GET /api/boom returned HTTP 500");
        expect(requests!.error).toContain("- [medium] GET /api/missing returned HTTP 404");
        expect(requests!.error).not.toContain("favicon"); // known noise
        expect(links!.error).toContain("2 links on this page are broken (checked 5)");
        expect(links!.error).toContain("- [medium] /missing-page returned HTTP 404");
        expect(links!.error).toContain("- [medium] /broken-500 returned HTTP 500");
        for (const s of [errors!, requests!, links!]) expect(s.error!.length).toBeLessThan(800);
    });

    it("skips mailto / tel / javascript / anchor links and never requests state-changing looking paths", async () => {
        const log = (await (await fetch(`${base(PORTS.weak)}/__log`)).json()) as string[];
        expect(log).not.toContain("/logout");
        expect(log).not.toContain("/delete-account");
        // a broken link is confirmed with at most one extra GET after the HEAD
        expect(log.filter((p) => p === "/missing-page").length).toBeLessThanOrEqual(2);
        expect(log.filter((p) => p === "/missing-page").length).toBeGreaterThanOrEqual(1);
    });

    it("turns the failed steps into one finding with the worst severity and how to fix it", () => {
        const spec = forPath(weakSpecs, "/");
        const reason = healthFinding(spec, runs.get(spec.testId)!)!;
        expect(reason.startsWith(HEALTH_FAILURE_PREFIX + " 2 JavaScript errors were reported on this page\n")).toBe(true);
        expect(reason.match(/Page health check failed:/g)).toHaveLength(1); // later checks only repeat their headline
        expect(reason).toContain("\n2 requests to this site failed\n");
        expect(reason).toContain("\n2 links on this page are broken (checked 5)\n");
        expect(reason).toMatch(/\nHow to fix: Open the page with the browser's developer console.*Fix or remove the listed links/);
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "high", basis: "request to the site failed" });
        expect(parseHealthReason(reason).map((p) => [p.check, p.severity])).toEqual([["noConsoleErrors", "medium"], ["noFailedRequests", "high"], ["noBrokenLinks", "medium"]]);
    });

    it("flags missing page basics on their own (low)", () => {
        const spec = forPath(weakSpecs, "/basics");
        const r = runs.get(spec.testId)!;
        expect(stepStates(r)).toEqual(["passed", "passed", "passed", "passed", "passed", "failed"]);
        const reason = healthFinding(spec, r)!;
        expect(reason).toContain("4 basic details missing or wrong on this page");
        expect(reason).toContain("- [low] The page has no title");
        expect(reason).toContain("- [low] The page does not declare its language");
        expect(reason).toContain("- [low] There is no viewport setting");
        expect(reason).toContain("- [low] The page has 2 main headings (<h1>); it should have one");
        expect(assessSeverity(spec, "NEEDS_REVIEW", reason)).toEqual({ severity: "low", basis: "missing page basics" });
    });

    it("passes a clean page, a hardened page (cross-origin links are not chased) and a single-page app", () => {
        for (const [label, id] of [["weak /about", forPath(weakSpecs, "/about").testId], ["hardened", hardenedHome.testId], ["spa", spa.testId]] as const) {
            expect(runs.get(id)!.status, `${label}: ${JSON.stringify(runs.get(id)!.steps.map((s) => s.error))}`).toBe("passed");
        }
    });

    it("counts a document that answers 404 as a failed request (medium)", () => {
        const r = runs.get(missing.testId)!;
        expect(r.status).toBe("failed");
        const reason = healthFinding(missing, r)!;
        expect(reason).toContain("- [medium] GET /nonexistent returned HTTP 404");
        expect(assessSeverity(missing, "NEEDS_REVIEW", reason)?.severity).toBe("medium");
    });

    it("does not call a page that did not load a finding", () => {
        const r = runs.get(dead.testId)!;
        expect(r.status).toBe("failed");
        expect(r.failedStepIndex).toBe(0);
        expect(stepStates(r)[0]).toBe("failed");
        expect(healthFinding(dead, r)).toBeUndefined();
    });

    it("healthFinding ignores other failures and messages from other steps", () => {
        const spec = forPath(weakSpecs, "/");
        const r = runs.get(spec.testId)!;
        const reason = (i: number, error: string): ScriptRun => ({ ...r, failedStepIndex: i, error, steps: [{ index: i, title: `${i + 1}. x`, status: "failed", error }] });
        expect(healthFinding(spec, reason(1, "TimeoutError: page.waitForLoadState: Timeout 30000ms exceeded."))).toBeUndefined();
        expect(healthFinding(spec, reason(0, `${HEALTH_FAILURE_PREFIX} 1 request to this site failed\n- [high] GET /x returned HTTP 500`))).toBeUndefined(); // step 0 is the navigation
        expect(healthFinding(spec, { ...r, status: "passed" })).toBeUndefined();
        // no numbered steps reported: fall back to the run's message
        expect(healthFinding(spec, { ...r, steps: [], failedStepIndex: -1, error: `${HEALTH_FAILURE_PREFIX} 1 link on this page is broken (checked 3)\n- [medium] /x returned HTTP 404\n\nCall log` })).toBe(
            `${HEALTH_FAILURE_PREFIX} 1 link on this page is broken (checked 3)\n- [medium] /x returned HTTP 404\nHow to fix: Fix or remove the listed links so visitors do not land on a missing page.`,
        );
    });
});

describe("severity of health findings", () => {
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "health", kind: "web", type: "health", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "pageBasics" }] });
    const sev = (text: string) => assessSeverity(spec, "NEEDS_REVIEW", `${HEALTH_FAILURE_PREFIX} ${text}`);

    it("maps failed requests, links, script errors, mixed content and basics as specified", () => {
        expect(sev("1 request to this site failed\n- [high] GET /x returned HTTP 500")).toEqual({ severity: "high", basis: "request to the site failed" });
        expect(sev("1 request to this site failed\n- [medium] GET /x returned HTTP 404")?.severity).toBe("medium");
        expect(sev("1 link on this page is broken (checked 4)\n- [medium] /x returned HTTP 404")).toEqual({ severity: "medium", basis: "broken link" });
        expect(sev("1 JavaScript error was reported on this page\n- [medium] console.error: x")).toEqual({ severity: "medium", basis: "JavaScript error on the page" });
        expect(sev("1 insecure (http://) resource is loaded on this secure page\n- [medium] http://x/y.png")).toEqual({ severity: "medium", basis: "insecure content on a secure page" });
        expect(sev("1 basic detail missing or wrong on this page\n- [low] The page has no title")).toEqual({ severity: "low", basis: "missing page basics" });
    });

    it("takes the worst problem across several checks, and ignores unrelated reasons", () => {
        expect(sev("1 basic detail missing or wrong on this page\n- [low] a\n1 JavaScript error was reported on this page\n- [medium] b")?.severity).toBe("medium");
        expect(assessSeverity(spec, "NEEDS_REVIEW", "something else entirely")?.basis).toMatch(/defect on a medium-priority journey/);
        expect(assessSeverity(spec, "VALIDATED", null)).toBeUndefined();
    });
});

describe("mixed content, noise and live-interpreter parity", () => {
    it("finds http:// resources on an https page (requests and DOM) and nothing on an http page", async () => {
        const rt = loadHealthRuntime();
        const secure = await browser.newContext({ ignoreHTTPSErrors: true }); // the fixture's certificate is self-signed
        const insecure = await browser.newContext();
        try {
            const page = await secure.newPage();
            const health = rt.installHealthCollector(page, base(PORTS.weakTls, "https"));
            await page.goto(`${base(PORTS.weakTls, "https")}/mixed`);
            const err = await rt.healthAssert(page, health, "noMixedContent").then(() => undefined, (e: Error) => e.message);
            expect(err).toContain(`${HEALTH_FAILURE_PREFIX} 2 insecure (http://) resources are loaded on this secure page`);
            expect(err).toContain("- [medium] http://127.0.0.1:1/insecure.png");
            expect(err).toContain("- [medium] http://127.0.0.1:1/insecure.js");
            // the blocked resources are on another origin, so they are not "failed requests to this site"
            await rt.healthAssert(page, health, "noFailedRequests");

            const plain = await insecure.newPage();
            const plainHealth = rt.installHealthCollector(plain, base(PORTS.weak));
            await plain.goto(`${base(PORTS.weak)}/mixed`);
            await rt.healthAssert(plain, plainHealth, "noMixedContent"); // an http page has nothing to be "mixed" with
        } finally {
            await secure.close();
            await insecure.close();
        }
    }, 60_000);

    it("ignores favicon / extension / analytics noise and the browser's own 'Failed to load resource' lines", async () => {
        const rt = loadHealthRuntime();
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            await page.route("**/*", (route) => {
                const u = new URL(route.request().url());
                if (u.pathname === "/") {
                    return route.fulfill({
                        contentType: "text/html",
                        body: `<!doctype html><html lang="en"><head><title>Noise</title><meta name="viewport" content="width=device-width"></head><body><h1>Noise</h1><script>
console.error("Failed to load resource: the server responded with a status of 404");
console.error("chrome-extension://abc/content.js failed");
fetch("/apple-touch-icon.png").catch(() => {}); fetch("/analytics/collect-hotjar").catch(() => {}); fetch("/real-missing");
setTimeout(() => { throw new Error("ResizeObserver loop limit exceeded"); }, 0);
setTimeout(() => console.error("a real console problem"), 0);
</script></body></html>`,
                    });
                }
                return route.fulfill({ status: 404, contentType: "text/plain", body: "nope" });
            });
            const health = rt.installHealthCollector(page, "http://noise.test");
            await page.goto("http://noise.test/");
            const errors = await rt.healthAssert(page, health, "noConsoleErrors").then(() => undefined, (e: Error) => e.message);
            expect(errors).toContain("1 JavaScript error was reported on this page");
            expect(errors).toContain("console.error: a real console problem");
            const requests = await rt.healthAssert(page, health, "noFailedRequests").then(() => undefined, (e: Error) => e.message);
            expect(requests).toContain("1 request to this site failed");
            expect(requests).toContain("GET /real-missing returned HTTP 404");
            expect(requests).not.toMatch(/apple-touch-icon|hotjar/);
        } finally {
            await context.close();
        }
    }, 60_000);

    it("the live interpreter applies the same checks and produces the same messages as the script", async () => {
        const spec = forPath(specsFor(base(PORTS.weak), [{ path: "/", type: "home" }]), "/");
        const scriptRun = (await runHealth([{ spec, baseUrl: base(PORTS.weak) }])).get(spec.testId)!;
        const context = await browser.newContext();
        const page = await context.newPage();
        const attempt = async (index: number): Promise<string | undefined> => {
            try {
                await executeStep(page, spec.steps[index]!, runtimeData(spec.testData), base(PORTS.weak));
                return undefined;
            } catch (e) {
                return (e as Error).message;
            }
        };
        try {
            expect(await attempt(0)).toBeUndefined(); // navigate
            for (const index of [2, 3]) expect(await attempt(index), `step ${index + 1}`).toBe(scriptRun.steps[index]!.error!.replace(/^Error: /, ""));
            expect(await attempt(4)).toBeUndefined(); // mixed content: not https
            expect(await attempt(5)).toBeUndefined(); // basics are fine on the home page
        } finally {
            await context.close();
        }
    }, 90_000);
});

describe("scripts outside the platform", () => {
    it("a downloaded health script is a normal Playwright test: BASE_URL redirects it to another site", async () => {
        const spec = forPath(specsFor(base(PORTS.weak), [{ path: "/", type: "home" }]), "/");
        const { filename, content } = renderScript(spec, "playwright", { baseUrl: base(PORTS.weak) });
        const dir = fs.mkdtempSync(path.join(loadConfig({}).scratchDir, "standalone-"));
        fs.writeFileSync(path.join(dir, filename), content);
        fs.writeFileSync(path.join(dir, "playwright.config.ts"), 'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: ".", reporter: "line" });\n');
        const cli = path.join(REPO_ROOT, "node_modules/@playwright/test/cli.js");
        const exec = (baseUrl: string) =>
            new Promise<{ code: number | null; out: string }>((resolve) => {
                const child = spawn(process.execPath, [cli, "test", "--config", "playwright.config.ts"], { cwd: dir, env: { ...process.env, BASE_URL: baseUrl, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
                let out = "";
                child.stdout.on("data", (d) => (out += d));
                child.stderr.on("data", (d) => (out += d));
                child.on("close", (code) => resolve({ code, out }));
            });
        try {
            const weak = await exec(base(PORTS.weak));
            expect(weak.code).toBe(1);
            expect(weak.out).toContain(`${HEALTH_FAILURE_PREFIX} 2 JavaScript errors were reported`);
            // same script, pointed at the hardened site: the home page of that site is healthy
            const hardened = await exec(base(PORTS.hardened));
            expect(hardened.code, hardened.out).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
