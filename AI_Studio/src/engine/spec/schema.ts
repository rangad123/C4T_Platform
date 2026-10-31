/**
 * Canonical, framework-independent test specification.
 *
 * This is the single source of truth for a generated test. Executable scripts
 * (Playwright, API runner, Taqwright/Appium) are *rendered* from it by the
 * generators in ../generators and can always be re-rendered.
 */
import { z } from "zod";
import { DesktopTargetSchema } from "../desktop/target.js";

export const LOCATOR_STRATEGIES = [
    "role",
    "label",
    "text",
    "placeholder",
    "testId",
    "css",
] as const;

/**
 * A frame (iframe) an element is inside, found by its `name` attribute, its `title`, or a part of its address (`url`: the frame's
 * `src` contains the text). Web pages only. A locator's `frame` lists them outermost first; absent = the page itself.
 */
export const FRAME_BY = ["name", "title", "url"] as const;
export const FrameRefSchema = z.object({ by: z.enum(FRAME_BY), value: z.string().min(1).max(300).regex(/^[^\u0000-\u001f\u2028\u2029]+$/, "A frame is named on one line") });
export type FrameRef = z.infer<typeof FrameRefSchema>;
/** Frames inside frames inside frames: deeper nesting is not followed (recorder, explorer and the schema agree). */
export const MAX_FRAME_DEPTH = 3;
const FrameChainSchema = z.array(FrameRefSchema).min(1).max(MAX_FRAME_DEPTH);

/**
 * Phone tests only: other ways to find the same element, tried in order when the locator itself finds nothing (an app update renamed an
 * id, a label changed). Written by the phone exploration (mobile/explore/locators.ts), each one checked to name exactly that element on
 * the screen it was recorded on. `uiSelector` is an Android UiSelector expression and `xpath` a relative XPath anchored on a stable
 * ancestor; both are Android only and are never written with coordinates. Web generators ignore the list.
 */
export const LOCATOR_FALLBACK_BY = ["testId", "label", "text", "placeholder", "role", "uiSelector", "xpath"] as const;
export const LocatorFallbackSchema = z.object({
    by: z.enum(LOCATOR_FALLBACK_BY),
    value: z.string().min(1).max(500).regex(/^[^\u0000-\u001f\u2028\u2029]+$/, "A fallback is written on one line"),
    /** Only for by="role". */
    role: z.string().max(40).optional(),
    nth: z.number().int().min(0).max(1000).optional(),
});
export type LocatorFallback = z.infer<typeof LocatorFallbackSchema>;
/** Most fallbacks one locator keeps. */
export const MAX_LOCATOR_FALLBACKS = 3;
const FallbacksSchema = z.array(LocatorFallbackSchema).min(1).max(MAX_LOCATOR_FALLBACKS);

/** Semantic element locator. Mirrors the Playwright / Taqwright `getBy*` vocabulary. */
export const LocatorSchema = z.object({
    by: z.enum(LOCATOR_STRATEGIES),
    /** ARIA role, only for by="role". */
    role: z.string().optional(),
    /** Accessible name (by="role") or the text/label/placeholder/testId/css value. */
    value: z.string().optional(),
    exact: z.boolean().optional(),
    /** Disambiguates when several elements match (0-based). */
    nth: z.number().int().min(0).optional(),
    /** Web only: the frames the element is inside, outermost first. */
    frame: FrameChainSchema.optional(),
    /** Phone tests only: other ways to find the same element, tried in order (see LocatorFallbackSchema). */
    fallbacks: FallbacksSchema.optional(),
});
export type Locator = z.infer<typeof LocatorSchema>;

/**
 * A step may refer to a named element of the project's object repository instead of spelling out a locator:
 * `{ "ref": "Cart / Checkout button" }`. The reference lives only in the stored spec. It is resolved into the concrete locator
 * before a script is rendered (see ../locators/refs.ts), so no generated script contains it. A resolved locator keeps `ref`
 * next to `by` as a note of where it came from; the platform turns it back into `{ ref }` when the spec is stored again.
 */
export type LocatorRef = { ref: string };
/** True for a reference that has not been resolved yet (it has a name and no strategy). */
export const isLocatorRef = (l: unknown): l is LocatorRef => typeof l === "object" && l !== null && typeof (l as { ref?: unknown }).ref === "string" && (l as { by?: unknown }).by === undefined;

/**
 * What a step's `locator` accepts in a stored spec: a concrete locator or a reference. Typed as a concrete `Locator` on purpose
 * (everything that renders or runs a spec sees concrete locators); the code that reads stored specs checks `isLocatorRef`, and every
 * generator refuses an unresolved reference with a plain message instead of guessing.
 */
const StepLocatorSchema = z
    .object({
        by: z.enum(LOCATOR_STRATEGIES).optional(),
        ref: z.string().min(1).max(80).optional(),
        role: z.string().optional(),
        value: z.string().optional(),
        exact: z.boolean().optional(),
        nth: z.number().int().min(0).optional(),
        frame: FrameChainSchema.optional(),
        fallbacks: FallbacksSchema.optional(),
    })
    .superRefine((l, ctx) => {
        if (l.ref === undefined) {
            if (l.by === undefined) ctx.addIssue({ code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["by"], message: "Required" });
            return;
        }
        if (l.by !== undefined || l.role !== undefined || l.value !== undefined || l.exact !== undefined || l.nth !== undefined || l.frame !== undefined || l.fallbacks !== undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A locator is either a shared element ({ \"ref\": \"name\" }) or a concrete locator, not both" });
        }
    }) as unknown as z.ZodType<Locator, z.ZodTypeDef, unknown>;

const base = { description: z.string().default("") };
/** Web steps only: the step works in the popup window (or new tab) an earlier click opened (see `opensPopup`), not the page the test started on. */
const popupBase = { inPopup: z.boolean().optional() };
/** A file of the project's test files library, by its name (no folders: the platform places the file next to the script). */
export const TEST_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const ASSERT_CHECKS = [
    "visible",
    "hidden",
    "text",
    "value",
    "enabled",
    "disabled",
    "count",
    "url",
    "title",
    /**
     * Accessibility audit (axe-core) of the page, or of `locator` if given. `expected` is the minimum
     * impact that fails the check: "minor" | "moderate" | "serious" (default) | "critical".
     */
    "a11y",
    /**
     * Visual comparison against the test's approved baseline screenshot (full page, or `locator`).
     * `expected` = maximum number of differing pixels tolerated (default 100). The first validation
     * captures the baseline; later runs compare against it.
     */
    "screenshot",
    /**
     * Page health checks (deterministic, see ../health/checks.ts). Each reports what the page did while it
     * loaded; the collector is installed before the first `navigate`, so the check needs no `expected`.
     */
    "noConsoleErrors",
    "noFailedRequests",
    "noBrokenLinks",
    "noMixedContent",
    "pageBasics",
    /**
     * Page speed (deterministic, see ../performance/checks.ts): the median of 3 cold loads of the current page against
     * budgets. `expected` optionally overrides them: "lcp:2500 fcp:1800 ttfb:800 cls:0.1 weight:3000000 requests:100 slow-4g".
     */
    "pageSpeed",
    /**
     * Input handling (deterministic, see ../inputs/checks.ts): probes the safe forms of the current page with a fixed set of
     * harmless unusual inputs. `expected` is "safe" (default: GET/search forms only) or "all" (POST forms too; only when the
     * user enabled tests that change data), optionally followed by "nolimits" to skip the client-side limit checks (maxlength,
     * required, email/number types; nothing is submitted for those). Login, sign-up and payment-style forms are never probed.
     */
    "inputHandling",
    /**
     * Access control (deterministic, see ../identity/access.ts): opens a page by its address as "anonymous" or as a named test
     * account and fails only if the page's content is shown to someone it may be restricted from. `expected` is JSON:
     * {"as","path","marker","by","sev"}. GET only.
     */
    "accessDenied",
    /**
     * AI judgement (see ../vision/*): a vision-capable model looks at a screenshot of the page, or of `locator`, and says whether the
     * screen looks right. `expected` is what to look for ("the cart total is visible and not overlapped"); empty = a general check.
     * The script only saves the screenshot; the platform asks the model after the run. Never a pass without a model.
     */
    "looksRight",
] as const;

export const RESPONSE_CHECKS = [
    "status",
    "statusClass",
    "jsonPath",
    "jsonType",
    "header",
    "bodyContains",
    /** Status strictly below N (e.g. 500 = "no server error"). */
    "statusBelow",
    "bodyNotContains",
    /**
     * Passive security checks (deterministic, read-only; see ../security/checks.ts). They look at every
     * response received so far in the test, not just the last one. `expected` is a setting where noted.
     */
    /** `expected` = comma list of headers that must be sound: csp, frame, nosniff, referrer, hsts. */
    "securityHeaders",
    /** Session-looking cookies set by the site carry HttpOnly / Secure (https only) / SameSite. */
    "cookieFlags",
    /** No reflected Origin / wildcard-with-credentials; the request carries a made-up `Origin` header. */
    "corsPolicy",
    /** No probed path answered with the content signature of a sensitive file (a bare HTTP 200 is not enough). */
    "noExposedFiles",
    /** No version banners (Server / X-Powered-By) and no directory listings. */
    "noInfoDisclosure",
    /** https only: certificate trusted, matching the host, not expired, not expiring within `expected` days (default 14). */
    "tlsCertificate",
    /**
     * The response body matches the documented JSON schema carried in the step's `schema` (see ../contracts/check.ts).
     * A missing required field or a wrong type is a finding: clients written from the documentation would break.
     */
    "matchesSchema",
    /**
     * API latency (deterministic, see ../performance/latency.ts): repeats the PRECEDING request step one at a time (one warm-up,
     * then 10 measured; never concurrently; stops at HTTP 429 / 5xx) and compares p95 (default 1 s) with a budget.
     * `expected` optionally overrides: "p95:1000 p50:400 max:3000 runs:10".
     */
    "latency",
    /**
     * Basic load check (see ../performance/load.ts): repeats the PRECEDING GET request step as up to 10 users at once for about
     * 10 seconds (at most 300 requests in all, only GET, stops at once on HTTP 429 or a failure rate above 20%). Never retried.
     * `expected` optionally LOWERS the limits: "p95:1000 errors:1 users:10 seconds:10 requests:300" (always clamped to those caps).
     */
    "load",
    /**
     * Access control for API endpoints (see ../identity/access.ts): the response must be a refusal (HTTP 401, 403, 404 or a redirect).
     * A 2xx answer is a finding. `expected` is JSON: {"as","path","by","sev"}.
     */
    "statusDenied",
] as const;

type AnyLocatorSchema = z.ZodType<Locator, z.ZodTypeDef, unknown>;
/** The step list is built once for the concrete locator (what models are asked for) and once for the stored form that also allows `{ ref }`. */
function buildStepSchema(LocatorSchema: AnyLocatorSchema) {
    return z.discriminatedUnion("action", [
    z.object({ action: z.literal("navigate"), url: z.string(), ...popupBase, ...base }),
    z.object({
        action: z.literal("click"),
        locator: LocatorSchema,
        /** Web only: this click opens a popup window or a new tab; later steps with `inPopup` work in it. */
        opensPopup: z.boolean().optional(),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("fill"),
        locator: LocatorSchema,
        value: z.string(),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("select"),
        locator: LocatorSchema,
        value: z.string(),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("check"),
        locator: LocatorSchema,
        checked: z.boolean().default(true),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("press"),
        key: z.string(),
        locator: LocatorSchema.optional(),
        ...popupBase,
        ...base,
    }),
    z.object({ action: z.literal("hover"), locator: LocatorSchema, ...popupBase, ...base }),
    // ── web: files and drag and drop (see docs/features/frames-uploads-popups.md) ──
    z.object({
        action: z.literal("upload"),
        /** The file field (an <input type="file">, or the element whose click opens the file chooser). */
        locator: LocatorSchema,
        /** A file of the project's test files library, by name. */
        file: z.string().regex(TEST_FILE_NAME, "A test file name uses letters, numbers, dots, dashes and underscores (at most 100)"),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("drag"),
        /** What is dragged. */
        locator: LocatorSchema,
        /** Where it is dropped. */
        target: LocatorSchema,
        ...popupBase,
        ...base,
    }),
    // ── Windows desktop steps (see ../desktop/spec.ts): the application is the spec's `desktop` target ──
    z.object({ action: z.literal("launchApp"), ...base }),
    z.object({ action: z.literal("closeApp"), ...base }),
    z.object({
        action: z.literal("wait"),
        ms: z.number().int().min(0).max(10_000),
        ...base,
    }),
    z.object({
        action: z.literal("assert"),
        check: z.enum(ASSERT_CHECKS),
        locator: LocatorSchema.optional(),
        /** Expected text / value / url fragment / count. */
        expected: z.union([z.string(), z.number()]).optional(),
        ...popupBase,
        ...base,
    }),
    // ── API steps ──────────────────────────────────────────────────────────
    z.object({
        action: z.literal("request"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        /** Path relative to the API base URL, may contain {{vars}}. */
        path: z.string(),
        query: z.record(z.string()).optional(),
        headers: z.record(z.string()).optional(),
        body: z.unknown().optional(),
        /** "default" attaches the configured API credential, "none" sends the request unauthenticated. */
        auth: z.enum(["default", "none"]).default("default"),
        /**
         * Capture values from this request's JSON response into test data for later steps:
         * { varName: "dot.path" } (e.g. { "productId": "0.id" }); later steps use {{productId}}.
         * This is what makes multi-request workflow tests (list → detail, create → read → delete) possible.
         */
        extract: z.record(z.string()).optional(),
        ...base,
    }),
    z.object({
        action: z.literal("assertResponse"),
        check: z.enum(RESPONSE_CHECKS),
        /** Dot path into the JSON body (jsonPath/jsonType) or header name (header). */
        path: z.string().optional(),
        expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
        /** matchesSchema only: the documented response schema (a JSON-Schema subset), size-bounded by the generator. */
        schema: z.record(z.unknown()).optional(),
        ...base,
    }),
    // ── reusable steps (see ../blocks/*): expanded into the block's own steps before any script is rendered ──
    z.object({
        action: z.literal("useBlock"),
        /** The name of the project's reusable steps. */
        block: z.string().min(1).max(80),
        /** Values for the block's parameters; they replace {{name}} in the block's steps. */
        args: z.record(z.string().max(500)).optional(),
        ...base,
    }),
    // ── web: emailed codes and magic links (see ../auth/email-step.ts, docs/features/hard-sign-ins.md) ──
    z.object({
        action: z.literal("email"),
        /** The address the email is sent to (one of the test mailbox's addresses); may contain {{placeholders}} such as {{unique}}. */
        to: z.string().max(254),
        /** "code": type the code it contains into `locator`; "link": open the link it contains (on the application's own site only). */
        use: z.enum(["code", "link"]),
        /** use "code" only: the field the code is typed into. */
        locator: LocatorSchema.optional(),
        /** Optional: the code that follows this text, or the link whose address or words contain it. */
        after: z.string().max(200).optional(),
        ...base,
    }),
]);
}
export const StepSchema = buildStepSchema(LocatorSchema);
export const StoredStepSchema = buildStepSchema(StepLocatorSchema);
export type Step = z.infer<typeof StepSchema>;
export type StepAction = Step["action"];

export const TEST_KINDS = ["web", "api", "mobile", "desktop"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

export const TEST_TYPES = [
    "functional",
    "negative",
    "boundary",
    "security",
    "smoke",
    "validation",
    "navigation",
    "accessibility",
    "workflow",
    "visual",
    "health",
    "performance",
    "input",
    "vision",
] as const;

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TestSpecSchema = z.object({
    testId: z.string().regex(/^[A-Z]+-\d{3,}$/, "testId like WEB-001"),
    title: z.string().min(3),
    description: z.string().default(""),
    kind: z.enum(TEST_KINDS),
    /** Windows desktop tests only: the application to start (see ../desktop/target.ts; rules in ../desktop/spec.ts). */
    desktop: DesktopTargetSchema.optional(),
    /** Mobile tests only: "ios" sends the test to a simulator on a Mac (framework taqwright-ios). Absent or "android": the Android emulator, exactly as before. */
    platform: z.enum(["android", "ios"]).optional(),
    /** Suite / feature area, e.g. "Authentication". */
    category: z.string().default("General"),
    type: z.enum(TEST_TYPES).default("functional"),
    priority: z.enum(PRIORITIES).default("medium"),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(StoredStepSchema).min(1),
    expectedResults: z.array(z.string()).default([]),
    /** Named values referenced as {{name}} in steps. `{{unique}}` is always available at runtime. */
    testData: z.record(z.string()).default({}),
    tags: z.array(z.string()).default([]),
    /** Which scenario/flow this was derived from + how it was produced. */
    source: z
        .object({
            scenarioId: z.string().optional(),
            journey: z.string().optional(),
            origin: z.enum(["browser-agent", "openapi", "network", "documentation", "manual", "requirements", "imported", "a11y-audit", "visual-baseline", "health-check", "security-check", "performance-check", "input-check", "contract-check", "access-check", "vision-check", "plain-english", "recorded", "exploration"]),
            /** Requirement ids/text this test traces back to (requirements-driven generation). */
            requirements: z.array(z.string()).optional(),
        })
        .default({ origin: "manual" }),
});
export type TestSpec = z.infer<typeof TestSpecSchema>;

/** A planned scenario: what to test, before concrete steps exist. */
export const ScenarioSchema = z.object({
    scenarioId: z.string(),
    title: z.string(),
    description: z.string(),
    category: z.string(),
    type: z.enum(TEST_TYPES).default("functional"),
    priority: z.enum(PRIORITIES).default("medium"),
    journey: z.string().optional(),
    startPath: z.string().default("/"),
    preconditions: z.array(z.string()).default([]),
    expectedResults: z.array(z.string()).min(1),
    requiresAuth: z.boolean().default(false),
    /** Free-text description of data the test needs, e.g. "an email that is not registered". */
    requiredData: z.array(z.string()).default([]),
    /** Requirement ids (from an uploaded requirements document) this scenario covers. */
    requirements: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** Replace {{name}} placeholders. `{{unique}}` resolves to a per-call token. */
export function interpolate(template: string, data: Record<string, string>): string {
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key: string) => {
        if (key in data) return data[key]!;
        if (key === "unique") return String(Date.now());
        return m;
    });
}

export function placeholdersIn(value: string): string[] {
    return [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);
}

/** Wording of the deterministic health / security checks (they carry no locator and little `expected`). */
const HEALTH_STEP_WORDING: Partial<Record<(typeof ASSERT_CHECKS)[number], string>> = {
    noConsoleErrors: "The page reports no JavaScript errors",
    noFailedRequests: "No request to this site fails (no 4xx / 5xx / network errors)",
    noBrokenLinks: "No link to this site's own pages is broken",
    noMixedContent: "No insecure (http://) content is loaded on a secure page",
    pageBasics: "The page has a title, a language, a viewport setting and one main heading",
    pageSpeed: "The page loads within its speed budgets (median of 3 fresh loads)",
    inputHandling: "Forms handle unusual input without errors and without showing it as page markup",
};
const SECURITY_STEP_WORDING: Partial<Record<(typeof RESPONSE_CHECKS)[number], string>> = {
    securityHeaders: "Browser security headers are set",
    cookieFlags: "Session cookies are protected (HttpOnly, Secure, SameSite)",
    corsPolicy: "Cross-origin access (CORS) is not wide open",
    noExposedFiles: "None of these sensitive files can be read",
    noInfoDisclosure: "The server does not reveal software versions or list folders",
    tlsCertificate: "The HTTPS certificate is valid, matches the site and is not about to expire",
};

/** Human-readable one-line summary of a step (used in UI and Playwright step titles). */
export function describeStep(step: Step): string {
    if (step.description) return step.description;
    // Only steps that use a popup or a frame get the extra words, so every other step reads exactly as before.
    const inPopup = "inPopup" in step && step.inPopup === true;
    const plain = describePlainStep(step);
    return inPopup ? `${plain} (in the popup)` : plain;
}

const FRAME_WORDS: Record<FrameRef["by"], string> = { name: "frame", title: "frame titled", url: "frame at" };
/** `inside frame "checkout"` for an element in a frame (innermost first, the way it reads). */
export const frameWords = (frame?: FrameRef[]): string => (frame?.length ? ` ${[...frame].reverse().map((f) => `inside ${FRAME_WORDS[f.by]} "${f.value}"`).join(" ")}` : "");

function describePlainStep(step: Step): string {
    const loc = (l?: Locator) =>
        l ? (isLocatorRef(l) ? `shared element "${l.ref}"` : `${l.by === "role" ? `${l.role} "${l.value ?? ""}"` : `${l.by} "${l.value ?? ""}"`}${frameWords(l.frame)}`) : "";
    switch (step.action) {
        case "navigate":
            return `Open ${step.url}`;
        case "click":
            return `Click ${loc(step.locator)}${step.opensPopup ? " and wait for the popup" : ""}`;
        case "upload":
            return `Upload the test file "${step.file}" to ${loc(step.locator)}`;
        case "drag":
            return `Drag ${loc(step.locator)} to ${loc(step.target)}`;
        case "fill":
            return `Enter "${step.value}" into ${loc(step.locator)}`;
        case "select":
            return `Select "${step.value}" in ${loc(step.locator)}`;
        case "check":
            return `${step.checked ? "Check" : "Uncheck"} ${loc(step.locator)}`;
        case "press":
            return `Press ${step.key}`;
        case "hover":
            return `Hover ${loc(step.locator)}`;
        case "launchApp":
            return "Start the application";
        case "closeApp":
            return "Close the application";
        case "wait":
            return `Wait ${step.ms}ms`;
        case "assert":
            // These two use `expected` as a setting, not an expected value.
            if (step.check === "screenshot") {
                return `${step.locator ? `${loc(step.locator)}` : "Page"} matches its approved baseline screenshot (tolerance ${step.expected ?? 100} px)`;
            }
            if (step.check === "a11y") {
                return `No accessibility violations of "${step.expected ?? "serious"}" impact or above${step.locator ? ` in ${loc(step.locator)}` : ""}`;
            }
            if (step.check === "looksRight") {
                return `AI judgement: ${step.locator ? loc(step.locator) : "the page"} looks right${typeof step.expected === "string" && step.expected.trim() ? ` (${step.expected.trim()})` : ""}`;
            }
            if (HEALTH_STEP_WORDING[step.check]) return HEALTH_STEP_WORDING[step.check]!;
            return `Verify ${step.check}${step.locator ? ` of ${loc(step.locator)}` : ""}${
                step.expected !== undefined ? ` = ${step.expected}` : ""
            }`;
        case "request":
            return `${step.method} ${step.path}${step.extract ? ` (capture ${Object.keys(step.extract).join(", ")})` : ""}`;
        case "assertResponse":
            if (step.check === "load") return "Stays fast and error-free with several users at once (load check)";
            if (SECURITY_STEP_WORDING[step.check]) return SECURITY_STEP_WORDING[step.check]!;
            return `Verify response ${step.check}${step.path ? ` ${step.path}` : ""}${
                step.expected !== undefined ? ` = ${step.expected}` : ""
            }`;
        case "useBlock":
            return `Run the reusable steps “${step.block}”`;
        case "email":
            return step.use === "code"
                ? `Wait for an email to ${step.to} and type its code into ${loc(step.locator)}`
                : `Wait for an email to ${step.to} and open its link${step.after ? ` containing "${step.after}"` : ""}`;
    }
}
