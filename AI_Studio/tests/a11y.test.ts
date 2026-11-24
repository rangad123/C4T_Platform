/**
 * Accessibility audits (axe-core): page selection for a11y specs, rendered-script execution against
 * a fixture app with deliberate violations, impact thresholds, scoping, interpreter parity and the
 * finding classifier.
 *
 * Observed axe impacts on examples/a11y-app (axe-core 4.13): /bad → image-alt [critical],
 * label [critical], color-contrast [serious]; /contrast → color-contrast [serious] only; /levels → html-xml-lang-mismatch [moderate] only.
 * (No WCAG A/AA rule of minor impact gives a definite violation in axe-core 4.13: server-side-image-map only asks for a review.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { A11Y_ALL_RULES_PREFIX, A11Y_FAILURE_PREFIX, formatA11yAllRules, formatA11yViolations } from "../src/engine/a11y/audit.js";
import { A11Y_ALL_RULES_TAG, a11yFinding, generateA11ySpecs } from "../src/engine/a11y/specs.js";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type Locator, type TestSpec } from "../src/engine/spec/schema.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import { runScripts, type ScriptRun } from "../src/engine/validation/runner.js";
import { executeStep, runtimeData } from "../src/engine/web/interpreter.js";

const PORT = 5112;
const BASE = `http://127.0.0.1:${PORT}`;
let app: ChildProcess;
let browser: Browser;

beforeAll(async () => {
    app = spawn(process.execPath, [path.join(REPO_ROOT, "examples/a11y-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) break;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    app?.kill();
});

const page = (p: Partial<PageModel> & Pick<PageModel, "path" | "type">): PageModel => ({
    url: `https://shop.example${p.path}`, title: "", depth: 1, status: 200, headings: [], forms: [], components: [], links: [],
    aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], ...p,
});

const model = (pages: PageModel[], loggedIn = false): AppModel => ({
    url: "https://shop.example/", origin: "https://shop.example", siteType: "ecommerce", purpose: "shop", features: [], pages,
    navigation: [], apis: [], journeys: [], authentication: { required: loggedIn, mechanisms: [], loggedIn }, externalDependencies: [],
    documentedTestCases: [], stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});

const form = (purpose: PageModel["forms"][number]["purpose"]) => ({ fields: [], purpose });

const a11ySpec = (testId: string, url: string, extra: { expected?: string; locator?: Locator } = {}, tags: string[] = []): TestSpec =>
    TestSpecSchema.parse({
        testId,
        title: `a11y ${url}`,
        kind: "web",
        type: "accessibility",
        tags,
        steps: [{ action: "navigate", url }, { action: "assert", check: "a11y", ...extra }],
    });

describe("generateA11ySpecs", () => {
    const pages = [
        page({ path: "/about", type: "content", depth: 1 }),
        page({ path: "/products/2", type: "detail", depth: 2 }),
        page({ path: "/products/1", type: "detail", depth: 2 }),
        page({ path: "/products", type: "listing", depth: 1 }),
        page({ path: "/join", type: "other", forms: [form("signup")] }),
        page({ path: "/contact", type: "content", forms: [form("contact")] }),
        page({ path: "/login", type: "login" }),
        page({ path: "/oops", type: "error" }),
        page({ path: "/broken", type: "other", status: 500 }),
        page({ path: "/openapi.json", type: "other" }),
        page({ path: "/account", type: "account" }),
        page({ path: "/elsewhere", type: "content", url: "https://cdn.other.example/elsewhere" }),
        page({ path: "/", type: "content", depth: 0, title: "Shop" }),
    ];

    it("picks important pages in priority order, dedupes templates and skips error / non-page URLs", () => {
        const specs = generateA11ySpecs(model(pages), { maxPages: 20 });
        expect(specs.map((s) => s.steps[0])).toEqual(
            ["/", "/login", "/join", "/contact", "/products", "/products/1", "/account", "/about"].map((url) => expect.objectContaining({ action: "navigate", url })),
        );
        const home = specs[0]!;
        expect(home).toMatchObject({ kind: "web", type: "accessibility", category: "Accessibility", priority: "high", tags: ["a11y", "wcag"], source: { origin: "a11y-audit" } });
        expect(home.steps[1]).toMatchObject({ action: "assert", check: "a11y", expected: "serious" });
        expect(specs.find((s) => (s.steps[0] as { url: string }).url === "/about")!.priority).toBe("low");
        // Every draft is a valid canonical spec.
        specs.forEach((d, i) => TestSpecSchema.parse({ ...d, testId: `WEB-${String(i + 1).padStart(3, "0")}` }));
    });

    it("tags the audits to keep every rule only when asked (an Accessibility agent's run)", () => {
        const m = model([page({ path: "/", type: "home" })]);
        expect(generateA11ySpecs(m, { maxPages: 5, allRules: true })[0]!.tags).toContain(A11Y_ALL_RULES_TAG);
        expect(generateA11ySpecs(m, { maxPages: 5 })[0]!.tags).not.toContain(A11Y_ALL_RULES_TAG);
    });

    it("respects maxPages and skips account pages that were only reachable logged in", () => {
        expect(generateA11ySpecs(model(pages), { maxPages: 3 }).map((s) => (s.steps[0] as { url: string }).url)).toEqual(["/", "/login", "/join"]);
        const urls = generateA11ySpecs(model(pages, true), { maxPages: 20 }).map((s) => (s.steps[0] as { url: string }).url);
        expect(urls).not.toContain("/account");
    });
});

describe("rendering", () => {
    it("imports axe only for a11y specs and keeps interpolated text injection-safe", () => {
        const plain = TestSpecSchema.parse({ testId: "WEB-100", title: "plain", kind: "web", steps: [{ action: "navigate", url: "/" }] });
        expect(renderScript(plain, "playwright", { baseUrl: BASE }).content).not.toContain("axe-core");

        const evil = a11ySpec("WEB-101", "/", { locator: { by: "css", value: '"); process.exit(1); ("`${x}`' } });
        const { content } = renderScript(evil, "playwright", { baseUrl: BASE });
        expect(content).toContain('import { AxeBuilder } from "@axe-core/playwright"');
        expect(content).toContain('await a11yAudit(page, "serious", "\\"); process.exit(1); (\\"`${x}`");');
        // unknown thresholds fall back to "serious"; known ones pass through
        expect(renderScript(a11ySpec("WEB-102", "/", { expected: "Critical" }), "playwright", { baseUrl: BASE }).content).toContain('a11yAudit(page, "critical")');
        expect(renderScript(a11ySpec("WEB-103", "/", { expected: "high" }), "playwright", { baseUrl: BASE }).content).toContain('a11yAudit(page, "serious")');
        // non-css locators are resolved by Playwright
        expect(renderScript(a11ySpec("WEB-104", "/", { locator: { by: "label", value: "Email" } }), "playwright", { baseUrl: BASE }).content).toContain(
            'a11yAudit(page, "serious", page.getByLabel("Email"))',
        );
    });
});

describe("a11y audit execution", () => {
    const cases = {
        home: a11ySpec("WEB-001", "/"),
        clean: a11ySpec("WEB-002", "/clean"),
        bad: a11ySpec("WEB-003", "/bad"),
        contrastSerious: a11ySpec("WEB-004", "/contrast"),
        contrastCritical: a11ySpec("WEB-005", "/contrast", { expected: "critical" }),
        badCritical: a11ySpec("WEB-006", "/bad", { expected: "critical" }),
        scopedCss: a11ySpec("WEB-007", "/bad", { locator: { by: "css", value: "#signup" } }),
        scopedText: a11ySpec("WEB-008", "/bad", { locator: { by: "text", value: "Low contrast promotional text" } }),
        scopedNthClean: a11ySpec("WEB-009", "/clean", { locator: { by: "css", value: "form", nth: 0 } }),
        // An Accessibility agent's audits keep every rule at every impact (generateA11ySpecs allRules).
        levelsAll: a11ySpec("WEB-011", "/levels", {}, ["a11y", A11Y_ALL_RULES_TAG]),
        levelsPlain: a11ySpec("WEB-012", "/levels"),
        badAll: a11ySpec("WEB-013", "/bad", {}, ["a11y", A11Y_ALL_RULES_TAG]),
        missingPage: TestSpecSchema.parse({
            testId: "WEB-010", title: "page never loads", kind: "web", type: "accessibility",
            steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Text that is not there" }, { action: "assert", check: "a11y" }],
        }),
    } satisfies Record<string, TestSpec>;
    let runs: Record<keyof typeof cases, ScriptRun>;

    beforeAll(async () => {
        const all = Object.values(cases);
        const scripts = all.map((s) => {
            const r = renderScript(s, "playwright", { baseUrl: BASE });
            return { testId: s.testId, filename: r.filename, content: r.content };
        });
        const out = await runScripts(loadConfig({}).scratchDir, scripts, { baseUrl: BASE, headless: true }, { workers: 4 });
        const byId = new Map(out.map((r) => [r.testId, r]));
        runs = Object.fromEntries(Object.entries(cases).map(([k, s]) => [k, byId.get(s.testId)!])) as typeof runs;
    }, 180_000);

    it("passes on clean pages", () => {
        expect(runs.home.status, runs.home.error).toBe("passed");
        expect(runs.clean.status, runs.clean.error).toBe("passed");
        expect(runs.scopedNthClean.status, runs.scopedNthClean.error).toBe("passed");
    });

    it("fails on the page with violations with a compact, readable message", () => {
        const r = runs.bad;
        expect(r.status).toBe("failed");
        expect(r.failedStepIndex).toBe(1);
        const msg = r.steps[1]!.error!;
        expect(msg).toContain(`${A11Y_FAILURE_PREFIX} 3 WCAG rules violated at "serious" impact or above`);
        expect(msg).toMatch(/- image-alt \[critical\]: Images must have alternative text \(1 node: img\)/);
        expect(msg).toMatch(/- label \[critical\]: Form elements must have labels \(1 node: input\)/);
        expect(msg).toMatch(/- color-contrast \[serious\]: .+ \(1 node: p\)/);
        expect(msg.length).toBeLessThan(800);
    });

    it("applies the impact threshold", () => {
        // /contrast only has a "serious" violation.
        expect(runs.contrastSerious.status).toBe("failed");
        expect(runs.contrastCritical.status, runs.contrastCritical.error).toBe("passed");
        // "critical" on /bad keeps the two critical rules and drops color-contrast.
        const msg = runs.badCritical.steps[1]!.error!;
        expect(msg).toContain('2 WCAG rules violated at "critical" impact or above');
        expect(msg).not.toContain("color-contrast");
    });

    it("scopes the audit to a css selector or a Playwright locator", () => {
        const css = runs.scopedCss.steps[1]!.error!;
        expect(css).toContain("1 WCAG rule violated");
        expect(css).toContain("- label [critical]");
        const text = runs.scopedText.steps[1]!.error!;
        expect(text).toContain("1 WCAG rule violated");
        expect(text).toContain("- color-contrast [serious]");
    });

    it("keeps every rule at every impact for an Accessibility agent's audit; the threshold still decides pass or fail", () => {
        // Only a moderate issue: it passes, and its notes (a passing test's reason) list the rule.
        expect(runs.levelsAll.status, runs.levelsAll.error).toBe("passed");
        expect(runs.levelsAll.notes?.[0]).toBe(A11Y_ALL_RULES_PREFIX);
        expect(runs.levelsAll.notes!.slice(1)).toEqual([expect.stringMatching(/^- html-xml-lang-mismatch \[moderate\]: .+ \(1 node: html\)$/)]);
        // An ordinary audit of the same page notes nothing.
        expect(runs.levelsPlain.status).toBe("passed");
        expect(runs.levelsPlain.notes ?? []).toEqual([]);
        // Failed: the finding is the usual message, then the full list.
        expect(runs.badAll.status).toBe("failed");
        const reason = a11yFinding(cases.badAll, runs.badAll)!;
        expect(reason.startsWith(`${A11Y_FAILURE_PREFIX} 3 WCAG rules violated`)).toBe(true);
        expect(reason.slice(reason.indexOf(A11Y_ALL_RULES_PREFIX)).split("\n")).toHaveLength(4);
        expect(a11yFinding(cases.bad, runs.bad)).not.toContain(A11Y_ALL_RULES_PREFIX);
    });

    it("a11yFinding reports violations but not other failures", () => {
        const reason = a11yFinding(cases.bad, runs.bad);
        expect(reason).toMatch(new RegExp(`^${A11Y_FAILURE_PREFIX}`));
        expect(reason).toContain("image-alt [critical]");
        expect(reason!.split("\n")).toHaveLength(4);
        expect(a11yFinding(cases.clean, runs.clean)).toBeUndefined();
        expect(runs.missingPage.status).toBe("failed");
        expect(a11yFinding(cases.missingPage, runs.missingPage)).toBeUndefined();
        // a11y step failing for a non-audit reason (scope element missing) is not a finding
        const scopeMissing: ScriptRun = {
            ...runs.bad,
            error: "TimeoutError: locator.waitFor: Timeout 10000ms exceeded.",
            steps: [runs.bad.steps[0]!, { index: 1, title: "2. Verify a11y", status: "failed", error: "TimeoutError: locator.waitFor: Timeout 10000ms exceeded." }],
        };
        expect(a11yFinding(cases.bad, scopeMissing)).toBeUndefined();
        // failing step that is not the a11y assert, even with a matching message
        expect(a11yFinding(cases.bad, { ...runs.bad, failedStepIndex: 0 })).toBeUndefined();
    });

    it("the live interpreter applies the same audit and produces the same message", async () => {
        const context = await browser.newContext();
        const p = await context.newPage();
        const run = async (spec: TestSpec): Promise<string | undefined> => {
            const data = runtimeData(spec.testData);
            try {
                for (const step of spec.steps) await executeStep(p, step, data, BASE);
                return undefined;
            } catch (e) {
                return (e as Error).message;
            }
        };
        try {
            expect(await run(cases.clean)).toBeUndefined();
            expect(await run(cases.contrastCritical)).toBeUndefined();
            expect(await run(cases.scopedNthClean)).toBeUndefined();
            for (const key of ["bad", "badCritical", "contrastSerious", "scopedCss", "scopedText"] as const) {
                expect(await run(cases[key]), key).toBe(a11yFinding(cases[key], runs[key]));
            }
        } finally {
            await context.close();
        }
    }, 90_000);
});

describe("formatA11yAllRules", () => {
    it("lists every rule worst first, with no cap on rules and the usual cap on targets; nothing when the page is clean", () => {
        const v = (id: string, impact: string | null, n: number) => ({ id, impact, help: `Help for ${id}`, nodes: Array.from({ length: n }, (_, i) => ({ target: [`#el-${i}`] })) });
        const all = formatA11yAllRules([v("a", "minor", 1), v("b", "serious", 5), v("c", "critical", 1), v("d", "moderate", 1), v("e", "serious", 1), v("f", "serious", 1), v("g", "serious", 1), v("h", null, 1)])!;
        expect(all[0]).toBe(A11Y_ALL_RULES_PREFIX);
        expect(all.slice(1).map((l) => l.split(" ")[1])).toEqual(["c", "b", "e", "f", "g", "d", "a", "h"]);
        expect(all[2]).toBe("- b [serious]: Help for b (5 nodes: #el-0, #el-1, #el-2, ...)");
        expect(formatA11yAllRules([])).toBeUndefined();
    });

    it("is what the generated script attaches: the same lines", () => {
        expect(renderScript(a11ySpec("WEB-120", "/", {}, ["a11y", A11Y_ALL_RULES_TAG]), "playwright", { baseUrl: BASE }).content).toContain("const A11Y_ALL_RULES = true;");
        expect(renderScript(a11ySpec("WEB-121", "/"), "playwright", { baseUrl: BASE }).content).toContain("const A11Y_ALL_RULES = false;");
    });
});

describe("formatA11yViolations", () => {
    it("orders by impact, caps rules and targets, and ignores results below the threshold", () => {
        const v = (id: string, impact: string | null, n: number) => ({ id, impact, help: `Help for ${id}`, nodes: Array.from({ length: n }, (_, i) => ({ target: [`#el-${i}`] })) });
        const msg = formatA11yViolations(
            [v("a", "minor", 1), v("b", "serious", 5), v("c", "critical", 1), v("d", "moderate", 1), v("e", "serious", 1), v("f", "serious", 1), v("g", "serious", 1), v("h", null, 1)],
            "moderate",
        )!;
        const lines = msg.split("\n");
        expect(lines[0]).toBe(`${A11Y_FAILURE_PREFIX} 6 WCAG rules violated at "moderate" impact or above`);
        expect(lines[1]).toBe("- c [critical]: Help for c (1 node: #el-0)");
        expect(lines[2]).toBe("- b [serious]: Help for b (5 nodes: #el-0, #el-1, #el-2, ...)");
        expect(lines.at(-1)).toBe("- ...and 1 more rule(s)");
        expect(formatA11yViolations([v("a", "minor", 1)], "serious")).toBeUndefined();
    });
});
