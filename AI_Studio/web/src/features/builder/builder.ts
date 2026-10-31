/**
 * The step editor's model: types, the field table that drives every form, the add-a-step palette and the small pure helpers
 * (insert, move, delete, duplicate, dirty tracking). No React in here, so a plain test can run it.
 *
 * The canonical spec (src/engine/spec/schema.ts) stays the source of truth. A step travels as plain JSON and the editor only touches
 * the fields it shows, so anything it does not know about stays exactly as it was.
 */
import { CodeError, capi } from "../code/code.js";

// ── types ───────────────────────────────────────────────────────────────────

export type Step = { action: string; description?: string; [k: string]: any };
/** A step plus a key that stays the same while it moves around (React identity; never sent to the platform). */
export interface Item {
    key: string;
    step: Step;
}
export interface Diag {
    stepIndex?: number;
    message: string;
    severity: "error" | "warning";
}
export type Kind = "web" | "api";

export interface Catalog {
    actions: Record<Kind, string[]>;
    assertChecks: string[];
    responseChecks: string[];
    locatorStrategies: string[];
    httpMethods: string[];
    roles: string[];
    limits: { steps: number; string: number; title: number; description: number; testData: number; testDataValue: number; jsonText: number };
}

export interface SpecAnswer {
    testId: string;
    projectId: string;
    key: string;
    kind: string;
    title: string;
    validationStatus: string;
    spec: { title: string; description?: string; testData?: Record<string, string>; steps: Step[]; [k: string]: unknown };
    editable: boolean;
    reason?: string;
    busy?: boolean;
    custom?: boolean;
    kinds: Catalog;
    placeholders: { values: string[]; credentials: string[]; env: string[]; dataSet?: string };
    versions: number;
}

export interface SaveAnswer {
    testId: string;
    scriptVersion?: number;
    changed: boolean;
    diagnostics: Diag[];
    jobId: string | null;
    note?: string;
}
export interface PreviewAnswer {
    ok: boolean;
    script: string | null;
    filename: string | null;
    diagnostics: Diag[];
}

// ── plain names ─────────────────────────────────────────────────────────────

export const ACTION_LABEL: Record<string, string> = {
    navigate: "Open a page",
    click: "Click",
    fill: "Type text",
    select: "Choose an option",
    check: "Tick or untick",
    press: "Press a key",
    hover: "Hover",
    upload: "Upload a test file",
    drag: "Drag and drop",
    email: "Use an emailed code or link",
    wait: "Wait",
    assert: "Check the page",
    request: "Send a request",
    assertResponse: "Check the response",
    launchApp: "Start the application",
    closeApp: "Close the application",
    useBlock: "Run reusable steps",
};

export interface CheckInfo {
    label: string;
    /** Does the check need an element (required), may it have one (optional) or does it look at the whole page (none)? */
    locator: "required" | "optional" | "none";
    expected: "required" | "optional" | "none";
    expectedLabel?: string;
    expectedHelp?: string;
    /** Shown under "More checks". */
    more?: boolean;
}

/** Web checks (assert), in the words of the add-a-step palette. */
export const ASSERT_INFO: Record<string, CheckInfo> = {
    visible: { label: "Something is visible", locator: "optional", expected: "optional", expectedLabel: "Or text that should be on the page", expectedHelp: "Choose an element, or type the text to look for." },
    hidden: { label: "Something is not visible", locator: "optional", expected: "optional", expectedLabel: "Or text that should not be on the page" },
    text: { label: "Text is shown", locator: "optional", expected: "required", expectedLabel: "Text it should contain" },
    value: { label: "A field has a value", locator: "required", expected: "required", expectedLabel: "Value it should have" },
    enabled: { label: "An element is enabled", locator: "required", expected: "none" },
    disabled: { label: "An element is disabled", locator: "required", expected: "none" },
    count: { label: "Number of matching elements", locator: "required", expected: "required", expectedLabel: "How many", expectedHelp: "A whole number." },
    url: { label: "The address contains", locator: "none", expected: "required", expectedLabel: "Text the address should contain" },
    title: { label: "The page title contains", locator: "none", expected: "required", expectedLabel: "Text the title should contain" },
    a11y: { label: "No accessibility problems", locator: "optional", expected: "optional", expectedLabel: "Lowest impact that fails", expectedHelp: "minor, moderate, serious (the default) or critical.", more: true },
    screenshot: { label: "Looks like its approved screenshot", locator: "optional", expected: "optional", expectedLabel: "Pixels allowed to differ", expectedHelp: "A number. The first run saves the approved screenshot.", more: true },
    noConsoleErrors: { label: "The page reports no script errors", locator: "none", expected: "none", more: true },
    noFailedRequests: { label: "No request to the site fails", locator: "none", expected: "none", more: true },
    noBrokenLinks: { label: "The page has no broken links", locator: "none", expected: "none", more: true },
    noMixedContent: { label: "No insecure content on a secure page", locator: "none", expected: "none", more: true },
    pageBasics: { label: "The page has a title, language and heading", locator: "none", expected: "none", more: true },
    pageSpeed: { label: "The page loads fast enough", locator: "none", expected: "optional", expectedLabel: "Your own limits (optional)", expectedHelp: "For example: lcp:2500 fcp:1800 ttfb:800", more: true },
    inputHandling: { label: "Forms handle unusual input", locator: "none", expected: "optional", expectedLabel: "Which forms (optional)", expectedHelp: "safe (the default) or all.", more: true },
    accessDenied: { label: "A restricted page stays closed", locator: "none", expected: "required", expectedLabel: "Settings (JSON)", expectedHelp: 'For example: {"as":"anonymous","path":"/admin"}', more: true },
    looksRight: { label: "An AI reviewer says it looks right", locator: "optional", expected: "optional", expectedLabel: "What to look for (optional)", more: true },
};

/** API checks (assertResponse). */
export interface RespInfo {
    label: string;
    path: "required" | "optional" | "none";
    pathLabel?: string;
    expected: "required" | "optional" | "none";
    expectedLabel?: string;
    expectedHelp?: string;
    schema?: boolean;
    more?: boolean;
}
export const RESPONSE_INFO: Record<string, RespInfo> = {
    status: { label: "The status is", path: "none", expected: "required", expectedLabel: "Status code", expectedHelp: "For example 200." },
    statusClass: { label: "The status is in a group", path: "none", expected: "required", expectedLabel: "Group", expectedHelp: "2xx, 3xx, 4xx or 5xx." },
    statusBelow: { label: "The status is below", path: "none", expected: "required", expectedLabel: "Status code", expectedHelp: "500 means no server error." },
    jsonPath: { label: "A value in the answer", path: "required", pathLabel: "Where in the answer", expected: "required", expectedLabel: "Value it should have", expectedHelp: "For example 0.id for the id of the first item." },
    jsonType: { label: "The answer has this shape", path: "optional", pathLabel: "Where in the answer (optional)", expected: "required", expectedLabel: "Kind of value", expectedHelp: "array, object, string, number or boolean." },
    header: { label: "A header has a value", path: "required", pathLabel: "Header name", expected: "required", expectedLabel: "Value it should have" },
    bodyContains: { label: "The answer contains text", path: "none", expected: "required", expectedLabel: "Text" },
    bodyNotContains: { label: "The answer does not contain text", path: "none", expected: "required", expectedLabel: "Text" },
    statusDenied: { label: "Access is refused", path: "none", expected: "required", expectedLabel: "Settings (JSON)", expectedHelp: 'For example: {"as":"anonymous","path":"/admin"}', more: true },
    matchesSchema: { label: "The answer matches its documented shape", path: "none", expected: "none", schema: true, more: true },
    securityHeaders: { label: "Browser security headers are set", path: "none", expected: "optional", expectedLabel: "Headers to check (optional)", expectedHelp: "csp, frame, nosniff, referrer, hsts", more: true },
    cookieFlags: { label: "Session cookies are protected", path: "none", expected: "none", more: true },
    corsPolicy: { label: "Cross-origin access is not wide open", path: "none", expected: "none", more: true },
    noExposedFiles: { label: "No sensitive file can be read", path: "none", expected: "none", more: true },
    noInfoDisclosure: { label: "The server does not reveal its software", path: "none", expected: "none", more: true },
    tlsCertificate: { label: "The HTTPS certificate is sound", path: "none", expected: "optional", expectedLabel: "Days before it must not expire", more: true },
    latency: { label: "The answer is fast enough", path: "none", expected: "optional", expectedLabel: "Your own limits (optional)", expectedHelp: "For example: p95:1000 p50:400", more: true },
    load: { label: "Stays fast with several users", path: "none", expected: "optional", expectedLabel: "Your own limits (optional)", expectedHelp: "For example: p95:1000 users:10 seconds:10", more: true },
};

// ── the field table ─────────────────────────────────────────────────────────

export type FieldKind = "emailUse" | "locator" | "optLocator" | "text" | "area" | "key" | "ms" | "tick" | "method" | "auth" | "map" | "json" | "assertCheck" | "responseCheck" | "flag" | "testFile";

/** Web steps can work in the popup window an earlier click opened: a tick box at the end of their form. */
const IN_POPUP: FieldDef = { name: "inPopup", kind: "flag", label: "Do this in the popup window", help: "The window or tab an earlier click opened (that click has “Opens a popup” ticked)." };
export interface FieldDef {
    name: string;
    kind: FieldKind;
    label: string;
    help?: string;
    placeholder?: string;
    required?: boolean;
    /** A text that may use {{placeholders}}. */
    placeholders?: boolean;
}

/** The fields each action shows, in order. `assert` and `assertResponse` add or drop fields by their check (see `fieldsFor`). */
export const FIELDS: Record<string, FieldDef[]> = {
    navigate: [{ name: "url", kind: "text", label: "Address", help: "A path such as /login, or a full address.", placeholder: "/login", required: true, placeholders: true }, IN_POPUP],
    click: [
        { name: "locator", kind: "locator", label: "Element to click", required: true },
        { name: "opensPopup", kind: "flag", label: "Opens a popup", help: "Tick when this click opens a new window or tab. Later steps can then be done in the popup window." },
        IN_POPUP,
    ],
    hover: [{ name: "locator", kind: "locator", label: "Element to hover over", required: true }, IN_POPUP],
    fill: [
        { name: "locator", kind: "locator", label: "Field to type into", required: true },
        { name: "value", kind: "text", label: "Text to type", required: true, placeholders: true },
        IN_POPUP,
    ],
    select: [
        { name: "locator", kind: "locator", label: "Drop-down to use", required: true },
        { name: "value", kind: "text", label: "Option to choose", required: true, placeholders: true },
        IN_POPUP,
    ],
    check: [
        { name: "locator", kind: "locator", label: "Checkbox", required: true },
        { name: "checked", kind: "tick", label: "What to do" },
        IN_POPUP,
    ],
    press: [
        { name: "key", kind: "key", label: "Key", help: "For example Enter, Tab or Escape.", required: true },
        { name: "locator", kind: "optLocator", label: "Press it on an element (optional)" },
        IN_POPUP,
    ],
    upload: [
        { name: "locator", kind: "locator", label: "File field", help: "The file input, or the button that opens the file chooser.", required: true },
        { name: "file", kind: "testFile", label: "Test file", help: "One of the project's test files (Settings, Test files).", required: true },
        IN_POPUP,
    ],
    drag: [
        { name: "locator", kind: "locator", label: "Element to drag", required: true },
        { name: "target", kind: "locator", label: "Where to drop it", required: true },
        IN_POPUP,
    ],
    email: [
        { name: "use", kind: "emailUse", label: "What to take from the email", required: true },
        { name: "to", kind: "text", label: "Email address", help: "An address of the project's test mailbox (Test accounts, Test mailbox). {{unique}} gives each run its own address.", placeholder: "qa+{{unique}}@example.test", required: true, placeholders: true },
        { name: "locator", kind: "optLocator", label: "Field to type the code into (for a code)" },
        { name: "after", kind: "text", label: "Only after this text (optional)", help: "For a code: the code that follows this text. For a link: the link whose address or words contain it." },
    ],
    wait: [{ name: "ms", kind: "ms", label: "Wait for (milliseconds)", help: "Between 0 and 10000. A check that waits for something is usually better than a fixed wait.", required: true }],
    assert: [{ name: "check", kind: "assertCheck", label: "What to check", required: true }],
    request: [
        { name: "method", kind: "method", label: "Method", required: true },
        { name: "path", kind: "text", label: "Path", help: "Relative to the API address. Can use {{values}}.", placeholder: "/api/products", required: true, placeholders: true },
        { name: "query", kind: "map", label: "Query values (optional)" },
        { name: "headers", kind: "map", label: "Headers (optional)", help: "Sign-in is added for you; do not type keys or tokens here." },
        { name: "body", kind: "json", label: "Body (JSON, optional)" },
        { name: "auth", kind: "auth", label: "Sign-in" },
        { name: "extract", kind: "map", label: "Remember from the answer (optional)", help: "Name on the left, where in the answer on the right. Later steps use {{name}}." },
    ],
    assertResponse: [{ name: "check", kind: "responseCheck", label: "What to check", required: true }],
    launchApp: [],
    closeApp: [],
    // Drawn by its own form (blocks/UseBlockForm.tsx): a choice among the project's reusable steps and a value for each of their parameters.
    useBlock: [
        { name: "block", kind: "text", label: "Reusable steps", required: true },
        { name: "args", kind: "map", label: "Values for the parameters" },
    ],
};

/** The same list as MAIN_PAGE_ONLY_CHECKS in src/engine/web/pages.ts. */
const POPUP_BLOCKED_CHECKS = new Set(["noConsoleErrors", "noFailedRequests", "noBrokenLinks", "noMixedContent", "pageBasics", "pageSpeed", "inputHandling", "accessDenied", "looksRight", "screenshot", "a11y"]);

/** Actions this editor can edit; the others are shown and can be moved or removed, not changed. */
export const EDITABLE_ACTIONS = Object.entries(FIELDS)
    .filter(([a]) => a !== "launchApp" && a !== "closeApp")
    .map(([a]) => a);

/** The fields to show for one step: the action's own, plus the ones its check asks for. */
export function fieldsFor(step: Step): FieldDef[] {
    const base = FIELDS[step.action] ?? [];
    if (step.action === "assert") {
        const info = ASSERT_INFO[String(step.check)];
        const out = [...base];
        if (info && info.locator !== "none") out.push({ name: "locator", kind: info.locator === "required" ? "locator" : "optLocator", label: info.locator === "required" ? "Element" : "Element (optional)", required: info.locator === "required" });
        if (info && info.expected !== "none") out.push({ name: "expected", kind: "text", label: info.expectedLabel ?? "Expected", help: info.expectedHelp, required: info.expected === "required", placeholders: true });
        // Checks of what a page shows also work in a popup; the ones that watch the whole page load only on the page the test started on.
        if (!POPUP_BLOCKED_CHECKS.has(String(step.check))) out.push(IN_POPUP);
        return out;
    }
    if (step.action === "assertResponse") {
        const info = RESPONSE_INFO[String(step.check)];
        const out = [...base];
        if (info && info.path !== "none") out.push({ name: "path", kind: "text", label: info.pathLabel ?? "Path", required: info.path === "required" });
        if (info && info.expected !== "none") out.push({ name: "expected", kind: "text", label: info.expectedLabel ?? "Expected", help: info.expectedHelp, required: info.expected === "required", placeholders: true });
        if (info?.schema) out.push({ name: "schema", kind: "json", label: "Documented shape (JSON schema)", required: true });
        return out;
    }
    return base;
}

/** Every key a step of this action can carry, according to the table (used by the unit test against the schema). */
export function allFieldNames(action: string): string[] {
    const names = new Set((FIELDS[action] ?? []).map((f) => f.name));
    if (action === "assert") for (const c of Object.keys(ASSERT_INFO)) fieldsFor({ action, check: c }).forEach((f) => names.add(f.name));
    if (action === "assertResponse") for (const c of Object.keys(RESPONSE_INFO)) fieldsFor({ action, check: c }).forEach((f) => names.add(f.name));
    return [...names];
}

/** Set one field; an empty optional value removes the key. Everything else in the step stays as it was. */
export function setField(step: Step, name: string, value: unknown): Step {
    const next: Step = { ...step };
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[name];
    else next[name] = value;
    return next;
}

/** Change the check of an assert step: keeps what still applies and drops what the new check does not use. */
export function setCheck(step: Step, check: string): Step {
    const next: Step = { ...step, check };
    const allowed = new Set(fieldsFor(next).map((f) => f.name));
    for (const k of ["locator", "expected", "path", "schema", "inPopup"]) if (!allowed.has(k)) delete next[k];
    return next;
}

// ── the palette ─────────────────────────────────────────────────────────────

export interface PaletteItem {
    id: string;
    label: string;
    make: () => Step;
}
export interface PaletteGroup {
    id: string;
    title: string;
    items: PaletteItem[];
    more?: PaletteItem[];
}

const loc = (by: string, extra: Record<string, unknown> = {}) => ({ by, ...extra });
const assertItem = (check: string): PaletteItem => ({ id: `assert:${check}`, label: ASSERT_INFO[check]!.label, make: () => ({ action: "assert", check, ...(ASSERT_INFO[check]!.locator === "required" || ["visible", "hidden", "text"].includes(check) ? { locator: loc("text", { value: "" }) } : {}), ...(ASSERT_INFO[check]!.expected === "required" ? { expected: "" } : {}) }) });
const responseItem = (check: string): PaletteItem => ({ id: `assertResponse:${check}`, label: RESPONSE_INFO[check]!.label, make: () => ({ action: "assertResponse", check, ...(RESPONSE_INFO[check]!.expected === "required" ? { expected: check === "status" ? 200 : "" } : {}), ...(RESPONSE_INFO[check]!.path === "required" ? { path: "" } : {}), ...(RESPONSE_INFO[check]!.schema ? { schema: { type: "object" } } : {}) }) });

export const PALETTE: Record<Kind, PaletteGroup[]> = {
    web: [
        { id: "go", title: "Go to", items: [{ id: "navigate", label: "Open a page", make: () => ({ action: "navigate", url: "/" }) }] },
        {
            id: "interact",
            title: "Interact",
            items: [
                { id: "click", label: "Click", make: () => ({ action: "click", locator: loc("role", { role: "button", value: "" }) }) },
                { id: "fill", label: "Type text", make: () => ({ action: "fill", locator: loc("label", { value: "" }), value: "" }) },
                { id: "select", label: "Choose an option", make: () => ({ action: "select", locator: loc("label", { value: "" }), value: "" }) },
                { id: "check", label: "Tick or untick", make: () => ({ action: "check", locator: loc("label", { value: "" }), checked: true }) },
                { id: "press", label: "Press a key", make: () => ({ action: "press", key: "Enter" }) },
                { id: "hover", label: "Hover", make: () => ({ action: "hover", locator: loc("text", { value: "" }) }) },
                { id: "upload", label: "Upload a test file", make: () => ({ action: "upload", locator: loc("label", { value: "" }), file: "file.txt" }) },
                { id: "drag", label: "Drag and drop", make: () => ({ action: "drag", locator: loc("text", { value: "" }), target: loc("text", { value: "" }) }) },
                { id: "email-code", label: "Type an emailed code", make: () => ({ action: "email", use: "code", to: "", locator: loc("label", { value: "" }) }) },
                { id: "email-link", label: "Open an emailed link", make: () => ({ action: "email", use: "link", to: "" }) },
            ],
        },
        {
            id: "check",
            title: "Check",
            items: ["visible", "hidden", "text", "value", "enabled", "disabled", "count", "url", "title"].map(assertItem),
            more: Object.entries(ASSERT_INFO).filter(([, i]) => i.more).map(([c]) => assertItem(c)),
        },
        { id: "wait", title: "Wait", items: [{ id: "wait", label: "Wait a moment", make: () => ({ action: "wait", ms: 500 }) }] },
    ],
    api: [
        { id: "request", title: "Request", items: [{ id: "request", label: "Send a request", make: () => ({ action: "request", method: "GET", path: "/", auth: "default" }) }] },
        {
            id: "check",
            title: "Check the response",
            items: ["status", "statusClass", "statusBelow", "jsonPath", "jsonType", "header", "bodyContains", "bodyNotContains"].map(responseItem),
            more: Object.entries(RESPONSE_INFO).filter(([, i]) => i.more).map(([c]) => responseItem(c)),
        },
    ],
};

// ── list helpers ────────────────────────────────────────────────────────────

let counter = 0;
export const newKey = (): string => `s${++counter}`;
export const toItems = (steps: Step[]): Item[] => steps.map((step) => ({ key: newKey(), step }));
export const stepsOf = (items: Item[]): Step[] => items.map((i) => i.step);

export function insertAt(items: Item[], index: number, step: Step): Item[] {
    const at = Math.max(0, Math.min(items.length, index));
    return [...items.slice(0, at), { key: newKey(), step }, ...items.slice(at)];
}
export function removeAt(items: Item[], index: number): Item[] {
    return items.filter((_, i) => i !== index);
}
export function moveTo(items: Item[], from: number, to: number): Item[] {
    if (from === to || from < 0 || from >= items.length) return items;
    const target = Math.max(0, Math.min(items.length - 1, to));
    const next = items.slice();
    const [it] = next.splice(from, 1);
    next.splice(target, 0, it!);
    return next;
}
export function duplicateAt(items: Item[], index: number): Item[] {
    const it = items[index];
    return it ? insertAt(items, index + 1, JSON.parse(JSON.stringify(it.step)) as Step) : items;
}
export function replaceAt(items: Item[], index: number, step: Step): Item[] {
    return items.map((it, i) => (i === index ? { key: it.key, step } : it));
}

/** What gets saved, in one value: used to tell whether anything changed. */
export interface Draft {
    title: string;
    testData: Record<string, string>;
    steps: Step[];
}
const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
export const isDirty = (base: Draft, now: Draft): boolean => canon(base) !== canon(now);

/** The spec to send: the loaded spec with the parts the editor owns replaced. */
export function specFrom(loaded: SpecAnswer["spec"], d: Draft): SpecAnswer["spec"] {
    return { ...loaded, title: d.title.trim(), testData: d.testData, steps: d.steps };
}

// ── wording ─────────────────────────────────────────────────────────────────

/** A field whose name says it holds a secret (kept in step with the platform's rule in src/engine/builder/index.ts). */
const SECRET_FIELD = /pass(word|code|phrase)?\b|passwd|\bsecret\b|one[- ]time|\botp\b|\btotp\b|\bcv[vc]\b|security code|card[- ]?number|\bpin\b/i;
export function looksSecret(l: Step["locator"]): boolean {
    if (!l || typeof l !== "object" || typeof l.ref === "string") return false;
    return SECRET_FIELD.test(`${l.role ?? ""} ${l.value ?? ""}`);
}
export const isSafePlaceholder = (v: string): boolean => v.replace(/\{\{\s*(credentials|secret|env)\.[\w.-]+\s*\}\}/g, "").trim() === "";

export const STRATEGY_LABEL: Record<string, string> = {
    role: "Role and name",
    label: "Label of a field",
    text: "Text on the page",
    placeholder: "Placeholder of a field",
    testId: "Test id",
    css: "CSS selector",
};
export const VALUE_LABEL: Record<string, string> = {
    role: "Name (what it says)",
    label: "Label text",
    text: "Text",
    placeholder: "Placeholder text",
    testId: "Test id",
    css: "CSS selector",
};

export function problemsFor(diags: Diag[], index: number): Diag[] {
    return diags.filter((d) => d.stepIndex === index);
}

// ── talking to the platform ─────────────────────────────────────────────────

export class BuilderError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly diagnostics: Diag[] = [],
    ) {
        super(message);
    }
}

export async function bapi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    try {
        return await capi<T>(path, init);
    } catch (e) {
        if (e instanceof CodeError) {
            const diags = Array.isArray(e.body.diagnostics) ? (e.body.diagnostics as Diag[]) : [];
            throw new BuilderError(e.message, e.status, diags);
        }
        throw e;
    }
}
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
