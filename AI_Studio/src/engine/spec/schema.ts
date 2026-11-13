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
    /** Web only: an image (or area/input) by its alt text, and any element by its title attribute. */
    "altText",
    "title",
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

/** The plain part of a locator: one strategy, no filter and no container (what `filter` and `within` hold, so a locator nests one level only). */
const PlainLocatorSchema = z.object({
    by: z.enum(LOCATOR_STRATEGIES),
    role: z.string().optional(),
    value: z.string().optional(),
    exact: z.boolean().optional(),
    nth: z.number().int().min(0).optional(),
});
export type PlainLocator = z.infer<typeof PlainLocatorSchema>;
/**
 * Web only: keep the matches that contain (`hasText`) or do not contain (`hasNotText`) a text, or that hold (`has`) or do not hold
 * (`hasNot`) an element: the row of the product "Blue mug", not "row number 3". Playwright `locator.filter()`.
 */
export const LocatorFilterSchema = z
    .object({ hasText: z.string().min(1).max(300).optional(), hasNotText: z.string().min(1).max(300).optional(), has: PlainLocatorSchema.optional(), hasNot: PlainLocatorSchema.optional() })
    .refine((f) => f.hasText !== undefined || f.hasNotText !== undefined || f.has !== undefined || f.hasNot !== undefined, "A filter keeps matches by hasText, hasNotText, has or hasNot");

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
    /** Web only: keep only the matches that contain a text or an element (applied before `nth`). */
    filter: LocatorFilterSchema.optional(),
    /** Web only: the element is looked for inside this container (a list, a table row, a dialog), not on the whole page. */
    within: PlainLocatorSchema.optional(),
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
        filter: LocatorFilterSchema.optional(),
        within: PlainLocatorSchema.optional(),
        fallbacks: FallbacksSchema.optional(),
    })
    .superRefine((l, ctx) => {
        if (l.ref === undefined) {
            if (l.by === undefined) ctx.addIssue({ code: "invalid_type", expected: "string", input: undefined, path: ["by"], message: "Required" });
            return;
        }
        if (l.by !== undefined || l.role !== undefined || l.value !== undefined || l.exact !== undefined || l.nth !== undefined || l.frame !== undefined || l.filter !== undefined || l.within !== undefined || l.fallbacks !== undefined) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A locator is either a shared element ({ \"ref\": \"name\" }) or a concrete locator, not both" });
        }
    }) as unknown as z.ZodType<Locator, unknown>;

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
    // ── web element checks (see ../web/checks.ts); `expected` is the value where one is needed ──
    "checked",
    "unchecked",
    "focused",
    "editable",
    "inViewport",
    /** The attribute `name` has the value `expected` (absent `expected`: the attribute is present). */
    "attribute",
    /** The element's classes include `expected` (one class name). */
    "class",
    /** The computed CSS property `name` is `expected` (e.g. name "color", expected "rgb(200, 0, 0)"). */
    "css",
    "accessibleName",
    /** The field's accessible error message (aria-errormessage) contains `expected`: the message a validation test expects. */
    "accessibleErrorMessage",
    /** The element's whole text is `expected` (case and spacing as shown), not just a part of it. */
    "exactText",
    /** The element (or the page) does NOT contain the text `expected`. */
    "notText",
    /** The current address matches the pattern `expected`: `*` stands for any characters inside one part, `**` for anything. */
    "urlPattern",
    /**
     * The structure of `locator` (a list, a table, a summary) matches the ARIA snapshot template in `expected` (YAML, as
     * `locator.ariaSnapshot()` writes it). Numbers, dates and ids in it are written as /regex/ so a fresh run still matches (see ../web/checks.ts).
     */
    "ariaSnapshot",
    /** The text (or field value) of `locator` compared with the value an earlier `remember` step stored under `name`, by `compare`. */
    "remembered",
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

/** What a wait step can wait for (web). */
export const WAIT_UNTIL = ["url", "response", "hidden", "visible"] as const;
/** A remembered value's name: usable as {{name}} and never one of the built-in names (those contain a dot or are "unique"). */
export const REMEMBER_NAME = /^(?!unique$)[A-Za-z][A-Za-z0-9_]{0,39}$/;
export const REMEMBER_COMPARE = ["equals", "contains", "greater", "less"] as const;

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

/** What a `clock` step does to the page's time (Playwright's page.clock). */
export const CLOCK_OPS = ["install", "fastForward", "pauseAt", "resume"] as const;
/** At most a year and a bit ahead in one step. */
export const MAX_CLOCK_MINUTES = 60 * 24 * 400;
/**
 * What a `condition` step changes, and its `value`: offline / online (no value); colorScheme light|dark; reducedMotion reduce|no-preference;
 * forcedColors active|none (high contrast); media print|screen; viewport "390x844"; grantPermissions "geolocation,notifications";
 * denyPermissions (every granted permission is taken back, so the next request is refused); geolocation "52.52,13.40" (also grants it).
 */
export const CONDITION_SETS = ["offline", "online", "colorScheme", "reducedMotion", "forcedColors", "media", "viewport", "grantPermissions", "denyPermissions", "geolocation"] as const;

type AnyLocatorSchema = z.ZodType<Locator, unknown>;
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
    /** Web only: keep the text (or a field's value) of `locator` under `name`; later steps use it as {{name}} or compare with it (check "remembered"). */
    z.object({
        action: z.literal("remember"),
        locator: LocatorSchema,
        name: z.string().regex(REMEMBER_NAME, "A remembered value is named with letters, numbers and underscores (at most 40), starting with a letter"),
        from: z.enum(["text", "value"]).default("text"),
        ...popupBase,
        ...base,
    }),
    // ── web: files and drag and drop (see docs/features/frames-uploads-popups.md) ──
    z.object({
        action: z.literal("upload"),
        /** The file field (an <input type="file">, or the element whose click opens the file chooser). */
        locator: LocatorSchema,
        /** A file of the project's test files library, by name. */
        file: z.string().regex(TEST_FILE_NAME, "A test file name uses letters, numbers, dots, dashes and underscores (at most 100)"),
        /** The file is dropped onto the element (a drop zone) instead of chosen in a file field. */
        drop: z.boolean().optional(),
        ...popupBase,
        ...base,
    }),
    /**
     * The next alert, confirm or prompt is answered this way (accept or dismiss, with `promptText` typed into a prompt). Armed before
     * the step that opens it; that step then fails when no dialog appears or its message does not contain `message`.
     */
    z.object({
        action: z.literal("dialog"),
        response: z.enum(["accept", "dismiss"]),
        promptText: z.string().max(500).optional(),
        message: z.string().max(300).optional(),
        ...popupBase,
        ...base,
    }),
    /** Click `locator`, wait for the download it starts, and check the file is not empty and its name contains `filename`. */
    z.object({
        action: z.literal("download"),
        locator: LocatorSchema,
        filename: z.string().max(200).optional(),
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
        /** A fixed pause. Only for what nothing can be waited for; `until` is the better wait. */
        ms: z.number().int().min(0).max(10_000).default(0),
        /**
         * Web only: wait for something instead of a fixed time: the address to match `value` (url), a response whose address contains
         * `value` (response; it is listened for from the step before), or `locator` to be hidden or visible.
         */
        until: z.enum(WAIT_UNTIL).optional(),
        value: z.string().max(500).optional(),
        locator: LocatorSchema.optional(),
        ...popupBase,
        ...base,
    }),
    z.object({
        action: z.literal("assert"),
        check: z.enum(ASSERT_CHECKS),
        locator: LocatorSchema.optional(),
        /** Expected text / value / url fragment / count. */
        expected: z.union([z.string(), z.number()]).optional(),
        /** attribute / css: the attribute or CSS property name; remembered: the name of the remembered value. */
        name: z.string().min(1).max(100).optional(),
        /** remembered only: how the element's text compares with the remembered value (greater/less compare the first number in each). */
        compare: z.enum(REMEMBER_COMPARE).optional(),
        ...popupBase,
        ...base,
    }),
    // ── API steps ──────────────────────────────────────────────────────────
    z.object({
        action: z.literal("request"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        /** Path relative to the API base URL, may contain {{vars}}. */
        path: z.string(),
        query: z.record(z.string(), z.string()).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        /** "default" attaches the configured API credential, "none" sends the request unauthenticated. */
        auth: z.enum(["default", "none"]).default("default"),
        /**
         * Capture values from this request's JSON response into test data for later steps:
         * { varName: "dot.path" } (e.g. { "productId": "0.id" }); later steps use {{productId}}.
         * This is what makes multi-request workflow tests (list → detail, create → read → delete) possible.
         */
        extract: z.record(z.string(), z.string()).optional(),
        ...base,
    }),
    z.object({
        action: z.literal("assertResponse"),
        check: z.enum(RESPONSE_CHECKS),
        /** Dot path into the JSON body (jsonPath/jsonType) or header name (header). */
        path: z.string().optional(),
        expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
        /** matchesSchema only: the documented response schema (a JSON-Schema subset), size-bounded by the generator. */
        schema: z.record(z.string(), z.unknown()).optional(),
        ...base,
    }),
    // ── reusable steps (see ../blocks/*): expanded into the block's own steps before any script is rendered ──
    z.object({
        action: z.literal("useBlock"),
        /** The name of the project's reusable steps. */
        block: z.string().min(1).max(80),
        /** Values for the block's parameters; they replace {{name}} in the block's steps. */
        args: z.record(z.string(), z.string().max(500)).optional(),
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
    // ── web: time and conditions (see ../web/conditions.ts) ──
    z.object({
        action: z.literal("clock"),
        /** install: a fake clock from `time` (or now); fastForward: jump `minutes` ahead (timers due on the way fire once); pauseAt: stop time at `time`; resume: let it run again. */
        op: z.enum(CLOCK_OPS),
        /** A date or date and time, e.g. "2025-01-15" or "2025-01-15T09:30:00Z" (install, pauseAt). */
        time: z.string().max(40).optional(),
        /** fastForward only. */
        minutes: z.number().min(0).max(MAX_CLOCK_MINUTES).optional(),
        ...base,
    }),
    z.object({
        action: z.literal("condition"),
        /** What changes from this step on (see CONDITION_SETS); `value` says how. */
        set: z.enum(CONDITION_SETS),
        value: z.string().max(200).optional(),
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
    /**
     * Web tests only: the page's date and time stay at this moment for the whole test (Date.now and new Date(); timers keep running), so
     * dates and "x minutes ago" on the page read the same every day. Visual and AI-judgement checks get one by default. A date or date and time.
     */
    pinnedTime: z.string().max(40).optional(),
    /** Suite / feature area, e.g. "Authentication". */
    category: z.string().default("General"),
    type: z.enum(TEST_TYPES).default("functional"),
    priority: z.enum(PRIORITIES).default("medium"),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(StoredStepSchema).min(1),
    expectedResults: z.array(z.string()).default([]),
    /** Named values referenced as {{name}} in steps. `{{unique}}` is always available at runtime. */
    testData: z.record(z.string(), z.string()).default({}),
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
    /** The named test account this scenario signs in as (role scenarios, see ../identity/role-differences.ts). Absent: the project's own account. */
    role: z.string().optional(),
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

/** One line for a condition step (the schema's own words; the UI has its own in web/src/lib/labels.ts). */
export function describeCondition(set: (typeof CONDITION_SETS)[number], value?: string): string {
    switch (set) {
        case "offline":
            return "Go offline (the browser loses its network)";
        case "online":
            return "Go back online";
        case "colorScheme":
            return `Switch the page to ${value ?? "dark"} mode`;
        case "reducedMotion":
            return value === "no-preference" ? "Allow motion again" : "Ask for reduced motion";
        case "forcedColors":
            return value === "none" ? "Turn high contrast off" : "Turn high contrast (forced colours) on";
        case "media":
            return `Show the page as for ${value === "print" ? "printing" : "the screen"}`;
        case "viewport":
            return `Resize the window to ${value ?? "?"}`;
        case "grantPermissions":
            return `Allow ${value ?? "?"}`;
        case "denyPermissions":
            return "Refuse every permission (location, notifications...)";
        case "geolocation":
            return `Allow location and place the browser at ${value ?? "?"}`;
    }
}

const FRAME_WORDS: Record<FrameRef["by"], string> = { name: "frame", title: "frame titled", url: "frame at" };
/** `inside frame "checkout"` for an element in a frame (innermost first, the way it reads). */
export const frameWords = (frame?: FrameRef[]): string => (frame?.length ? ` ${[...frame].reverse().map((f) => `inside ${FRAME_WORDS[f.by]} "${f.value}"`).join(" ")}` : "");

const plainWords = (l: PlainLocator) => (l.by === "role" ? `${l.role} "${l.value ?? ""}"` : `${l.by} "${l.value ?? ""}"`);
const filterWords = (l: Locator): string => {
    const f = l.filter;
    if (!f) return "";
    const parts = [f.hasText !== undefined && `with "${f.hasText}"`, f.hasNotText !== undefined && `without "${f.hasNotText}"`, f.has && `holding ${plainWords(f.has)}`, f.hasNot && `not holding ${plainWords(f.hasNot)}`];
    return ` ${parts.filter(Boolean).join(" ")}`;
};

function describePlainStep(step: Step): string {
    const loc = (l?: Locator) =>
        l ? (isLocatorRef(l) ? `shared element "${l.ref}"` : `${plainWords(l)}${filterWords(l)}${l.within ? ` inside ${plainWords(l.within)}` : ""}${frameWords(l.frame)}`) : "";
    switch (step.action) {
        case "navigate":
            return `Open ${step.url}`;
        case "click":
            return `Click ${loc(step.locator)}${step.opensPopup ? " and wait for the popup" : ""}`;
        case "upload":
            return `${step.drop ? "Drop" : "Upload"} the test file "${step.file}" ${step.drop ? "onto" : "to"} ${loc(step.locator)}`;
        case "dialog":
            return `${step.response === "accept" ? "Accept" : "Dismiss"} the next dialog${step.message ? ` (it says "${step.message}")` : ""}${step.promptText !== undefined ? ` and answer "${step.promptText}"` : ""}`;
        case "download":
            return `Click ${loc(step.locator)} and check the download${step.filename ? ` named like "${step.filename}"` : ""}`;
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
            if (step.until === "url") return `Wait until the address matches "${step.value ?? ""}"`;
            if (step.until === "response") return `Wait for the response from "${step.value ?? ""}"`;
            if (step.until) return `Wait until ${loc(step.locator)} is ${step.until}`;
            return `Wait ${step.ms}ms`;
        case "remember":
            return `Remember the ${step.from === "value" ? "value" : "text"} of ${loc(step.locator)} as {{${step.name}}}`;
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
            if (step.check === "remembered") return `Verify ${loc(step.locator)} ${step.compare === "greater" ? "is greater than" : step.compare === "less" ? "is less than" : step.compare === "contains" ? "contains" : "equals"} the remembered {{${step.name ?? ""}}}`;
            if (step.check === "ariaSnapshot") return `Verify the structure of ${step.locator ? loc(step.locator) : "the page"} matches its snapshot`;
            if (step.check === "attribute" || step.check === "css") return `Verify ${step.check} ${step.name ?? ""} of ${loc(step.locator)}${step.expected !== undefined ? ` = ${step.expected}` : ""}`;
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
        case "clock":
            return step.op === "install"
                ? `Take over the page's clock${step.time ? ` from ${step.time}` : ""}`
                : step.op === "fastForward"
                  ? `Move the clock ${step.minutes ?? 0} minute(s) ahead`
                  : step.op === "pauseAt"
                    ? `Stop the clock at ${step.time ?? "?"}`
                    : "Let the clock run again";
        case "condition":
            return describeCondition(step.set, step.value);
    }
}
