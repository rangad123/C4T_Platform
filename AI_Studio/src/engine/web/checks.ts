/**
 * Stronger web checks: the pieces the generator (../generators/playwright.ts), the live interpreter (./interpreter.ts) and the authoring agent
 * (./author.ts) share, so they agree on what an ARIA snapshot template allows, how a remembered value is compared, and where a web test may
 * send a request.
 */
import { interpolate, type Step, type TestSpec } from "../spec/schema.js";

type Assert = Extract<Step, { action: "assert" }>;

/** Checks rendered as one plain `expect(...)` call: the ones a test's final outcome checks may run as soft assertions. */
export const SOFT_CHECKS = new Set<Assert["check"]>([
    "visible", "hidden", "text", "value", "enabled", "disabled", "count", "url", "title",
    "checked", "unchecked", "focused", "editable", "inViewport", "attribute", "class", "css", "accessibleName", "accessibleErrorMessage", "exactText", "notText", "urlPattern", "ariaSnapshot",
]);
/** Element checks that need an element to look at (a locator). */
export const NEEDS_LOCATOR = new Set<Assert["check"]>(["checked", "unchecked", "focused", "editable", "inViewport", "attribute", "class", "css", "accessibleName", "accessibleErrorMessage", "exactText", "remembered"]);
/** Checks that mean nothing without `expected`. */
export const NEEDS_EXPECTED = new Set<Assert["check"]>(["class", "css", "accessibleName", "accessibleErrorMessage", "exactText", "notText", "urlPattern", "ariaSnapshot"]);

/** The checks only a web page can answer (other generators refuse them in plain words). */
export const WEB_ONLY_CHECKS = new Set<Assert["check"]>([...NEEDS_LOCATOR, "notText", "urlPattern", "ariaSnapshot", "remembered"]);

/** `**` any characters, `*` any characters except "/" (Playwright's glob words), anchored: the regex a url pattern becomes. */
export function urlPatternRegex(pattern: string): RegExp {
    const src = pattern
        .split("**")
        .map((part) => part.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
        .join(".*");
    // A pattern without a scheme is about the path: it may follow any origin.
    return new RegExp(`${/^[a-z][a-z0-9+.-]*:/i.test(pattern) ? "^" : "^[a-z][a-z0-9+.-]*://[^/]+"}${src}$`, "i");
}

/** One class name among the element's classes (what toHaveClass is given; the same as toContainClass for one name). */
export const classPattern = (name: string): RegExp => new RegExp(`(^|\\s)${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);

/**
 * Checks whose Playwright call is newer than the floor generated code keeps to (portable/playwright-apis.ts OLDEST_PLAYWRIGHT). A test that
 * uses one says so in its first lines, and a download's README repeats it (NEEDS_PLAYWRIGHT_LINE).
 */
export const NEWER_PLAYWRIGHT_CHECKS: Readonly<Partial<Record<Assert["check"], string>>> = { accessibleName: "1.44", ariaSnapshot: "1.49", accessibleErrorMessage: "1.50" };
const minor = (v: string) => Number(v.split(".")[1]);
/** The newest Playwright a test's checks need beyond the floor, with the checks that need it; undefined when none does. */
export function newerPlaywrightNeeded(spec: Pick<TestSpec, "steps">): { version: string; checks: string[] } | undefined {
    const used = [...new Set(spec.steps.flatMap((s) => (s.action === "assert" && NEWER_PLAYWRIGHT_CHECKS[s.check] ? [s.check] : [])))];
    if (!used.length) return undefined;
    const version = used.map((c) => NEWER_PLAYWRIGHT_CHECKS[c]!).sort((a, b) => minor(b) - minor(a))[0]!;
    return { version, checks: used };
}
/** The script line that says so (read back by the download's README: NEEDS_PLAYWRIGHT_LINE). */
export const needsPlaywrightLine = (n: { version: string; checks: string[] }) => `// Needs Playwright ${n.version} or newer: it uses the check${n.checks.length > 1 ? "s" : ""} ${n.checks.map((c) => `"${c}"`).join(", ")}.`;
export const NEEDS_PLAYWRIGHT_LINE = /^\/\/ Needs Playwright (\d+\.\d+) or newer: (.*)$/m;

// ── ARIA snapshots ─────────────────────────────────────────────────────────

/** Longest template kept: a snapshot of a whole page is not a check of one result, pick the region (list, table, summary). */
export const ARIA_TEMPLATE_MAX = 4_000;
/** What a word with a digit in it (a count, a price, a date, a time, an order number, a run tag) becomes in a template. */
const VOLATILE = String.raw`[\w.,:/-]+`;
const WORD_WITH_DIGIT = /[\w.,:-]*\d[\w.,:-]*/g;

/** The text as a regex (in Playwright's /…/ form) when it holds something that changes between runs; undefined when it does not. */
function volatileRegex(text: string): string | undefined {
    if (!/\d/.test(text)) return undefined;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(WORD_WITH_DIGIT)) {
        out += escapeRe(text.slice(last, m.index)) + VOLATILE;
        last = m.index! + m[0].length;
    }
    out += escapeRe(text.slice(last));
    // In YAML ": " and " #" end a plain value; \s matches the same space and keeps the line one value.
    return `/${out.replace(/: /g, ":\\s").replace(/ #/g, "\\s#")}/`;
}
/** Also escapes "/", which would end Playwright's /regex/ (inside [...] it does not, so VOLATILE keeps its own). */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A YAML double-quoted string's text (Playwright writes names that way), or undefined when it is not one. */
function unquote(s: string): string | undefined {
    if (!/^".*"$/.test(s)) return undefined;
    try {
        return JSON.parse(s) as string;
    } catch {
        return undefined;
    }
}

/**
 * An ARIA snapshot (`locator.ariaSnapshot()`) as a template that still matches the next run: every name or text holding a number, a date
 * or an id is written as a /regex/ where those words may be anything. Structure (roles, order, the fixed words) is kept exactly.
 */
export function ariaTemplate(snapshot: string): string {
    return snapshot
        .split("\n")
        .map((line) => {
            // `- role "name" [attrs]` or `- role "name" [attrs]:` (the name of an element).
            const named = /^(\s*- [\w-]+ )("(?:[^"\\]|\\.)*")(.*)$/.exec(line);
            if (named) {
                const text = unquote(named[2]!);
                const re = text === undefined ? undefined : volatileRegex(text);
                return re ? `${named[1]}${re}${named[3]}` : line;
            }
            // `- text: words`, `- listitem: words`, `- /url: /path/123` (the text or a property of an element).
            const valued = /^(\s*- [\w/-]+(?: \[[^\]]*\])*: )(.+)$/.exec(line);
            if (valued) {
                const raw = valued[2]!;
                const text = unquote(raw) ?? raw;
                const re = volatileRegex(text);
                return re ? `${valued[1]}${re}` : line;
            }
            return line;
        })
        .join("\n");
}

// ── remembered values ──────────────────────────────────────────────────────

/** The first number in a text ("$1,234.50" → 1234.5), or NaN. The same rule in the script (REMEMBER_HELPER_SOURCE) and here. */
export function numberIn(text: string): number {
    const m = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
    return m ? Number(m[0].replace(/,/g, "")) : NaN;
}

/** Pasted into scripts that remember a value: the value by name (a plain error when no step stored it) and `numberIn`. */
export const REMEMBER_HELPER_SOURCE = `/** A value an earlier step remembered; a test never compares with a value nothing stored. */
function recalled(name: string): string {
    const v = data[name];
    if (v === undefined) throw new Error(\`Nothing was remembered as {{\${name}}}: a step before this one must remember it\`);
    return v;
}
/** The first number in a text ("$1,234.50" is 1234.5). */
function numberIn(text: string): number {
    const m = /-?\\d[\\d,]*(?:\\.\\d+)?/.exec(text);
    if (!m) throw new Error(\`No number in "\${text.slice(0, 80)}"\`);
    return Number(m[0].replace(/,/g, ""));
}
`;

// ── requests inside a web test ─────────────────────────────────────────────

/** The answer checks a web test's request can be judged by (the security, load and contract families stay in API tests). */
export const WEB_RESPONSE_CHECKS = new Set<Extract<Step, { action: "assertResponse" }>["check"]>(["status", "statusClass", "statusBelow", "jsonPath", "jsonType", "header", "bodyContains", "bodyNotContains"]);

/** Starts every message of the rule; the script says the same. */
export const WEB_REQUEST_RULE = "A web test sends requests only to the application's own site or its API address";

const originOf = (raw: string, base: string): string | undefined => {
    try {
        const o = new URL(raw, base).origin;
        return o === "null" ? undefined : o;
    } catch {
        return undefined;
    }
};

/** The origins a web test's request may go to: the application, and the configured API address. */
export function webRequestOrigins(ctx: { baseUrl: string; apiBaseUrl?: string }): string[] {
    return [...new Set([ctx.baseUrl, ctx.apiBaseUrl].map((u) => (u ? originOf(u, "http://invalid.invalid") : undefined)).filter((o): o is string => !!o))];
}

/** Plain-word problems with the requests of a web test (empty = fine): a foreign address, an address that starts with a placeholder, a check web tests do not run. */
export function webRequestProblems(spec: Pick<TestSpec, "kind" | "steps" | "testData">, ctx: { baseUrl: string; apiBaseUrl?: string }): string[] {
    if (spec.kind !== "web") return [];
    const allowed = webRequestOrigins(ctx);
    const out: string[] = [];
    let requested = false;
    for (const [i, step] of spec.steps.entries()) {
        if (step.action === "assertResponse") {
            if (!WEB_RESPONSE_CHECKS.has(step.check)) out.push(`Step ${i + 1}: the response check "${step.check}" runs in API tests only. A web test can check: ${[...WEB_RESPONSE_CHECKS].join(", ")}.`);
            else if (!requested) out.push(`Step ${i + 1}: a response check needs a request step before it.`);
            continue;
        }
        if (step.action !== "request") continue;
        requested = true;
        const raw = interpolate(step.path, spec.testData).trim();
        const target = /^\{\{/.test(raw) ? undefined : originOf(raw, ctx.baseUrl);
        if (!target) out.push(`Step ${i + 1}: ${WEB_REQUEST_RULE}, so its address must not start with a {{placeholder}}.`);
        else if (!allowed.includes(target)) out.push(`Step ${i + 1}: ${WEB_REQUEST_RULE} (this step goes to ${target}).`);
    }
    return out;
}

/**
 * Pasted into web scripts with request steps. The request goes through `page.request`, so it carries the browser's own cookies for that
 * site (the signed-in session) and nothing else; its real address is checked again right before it is sent.
 */
export const webRequestHelperSource = (apiBaseLiteral: string): string => `type WebCall = { status: number; headers: Record<string, string>; text: string; json: unknown };
let last: WebCall = { status: 0, headers: {}, text: "", json: undefined };
const WEB_REQUEST_ORIGINS = [BASE_URL, process.env.API_BASE_URL ?? ${apiBaseLiteral}].map((u) => new URL(u).origin);

async function webRequest(page: import("@playwright/test").Page, method: string, path: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown }): Promise<WebCall> {
    const target = await allowedAddress(path, BASE_URL);
    const origin = new URL(target).origin;
    if (!WEB_REQUEST_ORIGINS.includes(origin)) throw new Error(${JSON.stringify(WEB_REQUEST_RULE)} + " (this request went to " + origin + "). Nothing was sent.");
    const res = await page.request.fetch(target, { method, headers: opts.headers, params: opts.query, data: opts.body === undefined ? undefined : (opts.body as object), failOnStatusCode: false, maxRedirects: 0 });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status(), headers: res.headers(), text, json };
}

function at(json: unknown, path: string): unknown {
    return path.split(".").filter(Boolean).reduce<unknown>((acc, key) => (acc === null || acc === undefined ? undefined : (acc as Record<string, unknown>)[key]), json);
}

function typeOf(v: unknown): string {
    return Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
}

/** Keep a response value for later {{name}} placeholders; fail loudly if it is absent. */
function capture(res: WebCall, name: string, path: string): string {
    const v = at(res.json, path);
    if (v === undefined || v === null || v === "") throw new Error(\`Could not capture "\${name}": no value at "\${path}" in the HTTP \${res.status} response: \${res.text.slice(0, 300)}\`);
    return typeof v === "object" ? JSON.stringify(v) : String(v);
}
`;

/** For generators that only render web tests' own steps elsewhere (phone, desktop): why this step cannot be rendered there, or undefined. */
export function webOnlyProblem(step: Step): string | undefined {
    if (step.action === "remember") return 'The step "remember" works on web pages only';
    if (step.action === "wait" && step.until) return `Waiting until ${step.until === "url" ? "an address" : step.until === "response" ? "a response" : `an element is ${step.until}`} works on web pages only`;
    if (step.action === "assert" && WEB_ONLY_CHECKS.has(step.check)) return `The check "${step.check}" works on web pages only`;
    const l = "locator" in step ? step.locator : undefined;
    if (l && (l.by === "altText" || l.by === "title")) return `Finding an element by ${l.by} works on web pages only`;
    if (l && (l.filter || l.within)) return "Narrowing a locator with a filter or a container works on web pages only";
    return undefined;
}
