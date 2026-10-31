/**
 * Deterministic accessibility specs (no LLM): one "accessibility" spec per important discovered
 * page = open the page + `assert check:"a11y"` (axe-core, WCAG 2.0/2.1 A + AA, fails at "serious"
 * impact or above). Also classifies a failed a11y run as an application finding.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel, PageModel, PageType } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { A11Y_FAILURE_PREFIX, type A11yImpact } from "./audit.js";

export interface A11yGenOptions {
    maxPages: number;
    /** Minimum failing impact; defaults to "serious". */
    threshold?: A11yImpact;
}

/** Lower = audited first. Types not listed here are skipped. */
const RANK: Partial<Record<PageType, number>> = {
    home: 0,
    login: 1,
    register: 2,
    checkout: 3,
    cart: 4,
    form: 5,
    search: 6,
    listing: 7,
    detail: 8,
    account: 9,
    dashboard: 10,
    content: 11,
    other: 12,
};

const PRIORITY: Partial<Record<PageType, TestSpec["priority"]>> = {
    home: "high",
    login: "high",
    register: "high",
    checkout: "high",
    cart: "medium",
    form: "medium",
    search: "medium",
    listing: "medium",
    detail: "medium",
    account: "medium",
    dashboard: "medium",
    content: "low",
    other: "low",
};

/** How many pages of one type are worth auditing (templated pages share their markup). */
const PER_TYPE: Partial<Record<PageType, number>> = { form: 3, listing: 2, content: 2 };

const LABEL: Partial<Record<PageType, string>> = {
    home: "Home",
    login: "Login",
    register: "Registration",
    checkout: "Checkout",
    cart: "Cart",
    form: "Form",
    search: "Search",
    listing: "Listing",
    detail: "Detail",
    account: "Account",
    dashboard: "Dashboard",
    content: "Content",
    other: "",
};

const NON_HTML = /\.(json|xml|txt|pdf|csv|zip|png|jpe?g|gif|svg|webp|ico|css|js|map|ya?ml)$/i;

/** Effective type: the crawler/analyzer's type, upgraded by what the page's forms are for. */
function effectiveType(p: PageModel): PageType {
    const purposes = new Set(p.forms.map((f) => f.purpose));
    if (p.path === "/" || p.path === "") return "home";
    if (p.type === "other" || p.type === "content") {
        if (purposes.has("login")) return "login";
        if (purposes.has("signup")) return "register";
        if (purposes.has("checkout")) return "checkout";
        if ([...purposes].some((x) => x === "contact" || x === "other")) return "form";
    }
    return p.type;
}

/** Path template: ids, uuids, hashes and long numbers collapse so /product/1 and /product/2 dedupe. */
function pattern(path: string): string {
    const [pathname] = path.split(/[?#]/);
    return (
        (pathname ?? "/")
            .split("/")
            .map((seg) =>
                /^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /\d{3,}/.test(seg) ? "{id}" : seg,
            )
            .join("/")
            .replace(/\/+$/, "") || "/"
    );
}

function sameOrigin(p: PageModel, origin: string): boolean {
    try {
        return new URL(p.url).origin === origin;
    } catch {
        return true;
    }
}

export interface KeyPage {
    page: PageModel;
    type: PageType;
    /** Short page-kind label ("Home", "Login"...) when known. */
    label?: string;
    priority: TestSpec["priority"];
}

/**
 * The important, distinct, anonymously reachable pages of an application, most important first.
 * Shared by the deterministic per-page generators (accessibility audits, visual baselines).
 */
export function selectKeyPages(model: AppModel, maxPages: number): KeyPage[] {
    return pickPages(model, maxPages).map(({ page, type }) => ({ page, type, label: LABEL[type], priority: PRIORITY[type] ?? "low" }));
}

export function generateA11ySpecs(model: AppModel, opts: A11yGenOptions): DraftSpec[] {
    const threshold = opts.threshold ?? "serious";
    return pickPages(model, opts.maxPages).map(({ page, type }) => a11ySpec(page, type, threshold));
}

function pickPages(model: AppModel, maxPages: number): Array<{ page: PageModel; type: PageType }> {
    // Pages the crawl reached while logged in would redirect a fresh (anonymous) browser to the login
    // page, so their audit would silently test the wrong page; skip them rather than mislabel results.
    const gated = new Set<PageType>(model.authentication.loggedIn ? ["account", "dashboard"] : []);

    const candidates = model.pages
        .filter((p) => p.type !== "error" && (p.status === 0 || (p.status >= 200 && p.status < 400)))
        .filter((p) => sameOrigin(p, model.origin) && !NON_HTML.test(p.path.split(/[?#]/)[0] ?? ""))
        .map((p) => ({ page: p, type: effectiveType(p) }))
        .filter((c) => RANK[c.type] !== undefined && !gated.has(c.type))
        .sort((a, b) => RANK[a.type]! - RANK[b.type]! || a.page.depth - b.page.depth || a.page.path.localeCompare(b.page.path));

    const seenPattern = new Set<string>();
    const perType = new Map<PageType, number>();
    const picked: Array<{ page: PageModel; type: PageType }> = [];
    for (const c of candidates) {
        if (picked.length >= maxPages) break;
        const key = pattern(c.page.path);
        const used = perType.get(c.type) ?? 0;
        if (seenPattern.has(key) || used >= (PER_TYPE[c.type] ?? 1)) continue;
        seenPattern.add(key);
        perType.set(c.type, used + 1);
        picked.push(c);
    }
    return picked;
}

function a11ySpec(page: PageModel, type: PageType, threshold: string): DraftSpec {
    const name = page.title?.trim() || LABEL[type] || page.path;
    const label = LABEL[type] ? `${LABEL[type]} page` : "Page";
    const steps: Step[] = [
        { action: "navigate", url: page.path || "/", description: `Open ${page.path || "/"}` },
        {
            action: "assert",
            check: "a11y",
            expected: threshold,
            description: `No WCAG 2.1 A/AA violations of "${threshold}" impact or above`,
        },
    ];
    return {
        title: `${label} has no ${threshold}+ accessibility violations (${page.path || "/"})`,
        description: `Automated axe-core audit of "${name}" against WCAG 2.0/2.1 levels A and AA.`,
        kind: "web",
        category: "Accessibility",
        type: "accessibility",
        priority: PRIORITY[type] ?? "low",
        preconditions: [],
        steps,
        expectedResults: [`No WCAG 2.0/2.1 A or AA violations with "${threshold}" impact or above`],
        testData: {},
        tags: ["a11y", "wcag"],
        source: { origin: "a11y-audit" },
    };
}

/**
 * When `run` failed *because of accessibility violations* (the failing step is an a11y assert and
 * its error is the audit's own message) return a concise reason; otherwise undefined — e.g. the page
 * did not load, or a scoping locator was not found, which are ordinary validation failures.
 */
export function a11yFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const step = run.failedStepIndex >= 0 ? spec.steps[run.failedStepIndex] : undefined;
    const isA11yStep = (s: Step | undefined) => s?.action === "assert" && s.check === "a11y";
    // failedStepIndex is -1 only when Playwright reported no numbered steps; then rely on the message alone.
    if (step ? !isA11yStep(step) : !spec.steps.some(isA11yStep)) return undefined;
    const text = run.steps.find((s) => s.index === run.failedStepIndex)?.error ?? run.error ?? "";
    const at = text.indexOf(A11Y_FAILURE_PREFIX);
    if (at < 0) return undefined;
    // Keep the rule lines, drop Playwright's trailing call log / stack if any.
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim()
        .slice(0, 1000);
}
