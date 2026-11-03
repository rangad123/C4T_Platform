/**
 * The visual test builder's rules (no database, no network): what a person may put into a test's steps in the step editor,
 * checked the same way for a save, a preview and a new test. The canonical spec (../spec/schema.ts) stays the one source of truth;
 * this file only adds the plain-language checks around it (caps, which actions fit which kind of test, secrets, shared elements).
 *
 * The platform part (address guard, storing, re-rendering, validation job) is src/platform/spec-edit-service.ts.
 */
import { ASSERT_CHECKS, LOCATOR_STRATEGIES, RESPONSE_CHECKS, TestSpecSchema, isLocatorRef, type Step, type TestSpec } from "../spec/schema.js";
import { fillStep, hasBlocks, tryExpandBlocks } from "../blocks/expand.js";
import type { BlockIndex } from "../blocks/model.js";
import { locatorOf, refProblems, type ObjectIndex } from "../locators/refs.js";
import { unknownPlaceholders } from "../testdata/dataset.js";
import { popupProblems } from "../web/pages.js";

/** What the editor refuses to store, in numbers. */
export const BUILDER_LIMITS = {
    steps: 100,
    string: 2000,
    title: 160,
    description: 500,
    testData: 30,
    testDataValue: 500,
    jsonText: 20_000,
} as const;

/** Actions each kind of test accepts in the editor. Desktop and mobile tests are not edited here. */
export const EDITABLE_KINDS = ["web", "api"] as const;
export type EditableKind = (typeof EDITABLE_KINDS)[number];
export const ACTIONS_BY_KIND: Record<EditableKind, readonly Step["action"][]> = {
    web: ["navigate", "click", "fill", "select", "check", "press", "hover", "upload", "drag", "email", "wait", "assert"],
    api: ["request", "assertResponse"],
};
export const isEditableKind = (k: string): k is EditableKind => (EDITABLE_KINDS as readonly string[]).includes(k);

/** The roles the locator picker offers (Playwright's `getByRole` names that people actually use). */
export const ARIA_ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "tab", "heading", "img", "listitem", "list", "row", "cell", "dialog", "alert", "navigation", "searchbox", "switch", "slider", "spinbutton", "table"] as const;

/** Everything the editor needs to know about the schema, derived from it so a new check shows up without a UI change. */
export function builderCatalog() {
    return {
        actions: ACTIONS_BY_KIND,
        assertChecks: [...ASSERT_CHECKS],
        responseChecks: [...RESPONSE_CHECKS],
        locatorStrategies: [...LOCATOR_STRATEGIES],
        httpMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        roles: [...ARIA_ROLES],
        limits: BUILDER_LIMITS,
    };
}
export type BuilderCatalog = ReturnType<typeof builderCatalog>;

export interface BuilderDiagnostic {
    /** Zero-based; absent when the problem is about the test as a whole. */
    stepIndex?: number;
    message: string;
    /** Errors stop a save; warnings are shown and the save goes ahead. */
    severity: "error" | "warning";
}
export const errorsOf = (d: BuilderDiagnostic[]): BuilderDiagnostic[] => d.filter((x) => x.severity === "error");

export interface EditContext {
    testId: string;
    kind: EditableKind;
    category: string;
    source: TestSpec["source"];
    /** The stored spec: steps that are the same as in it are not checked again for secrets (older tests keep working). */
    current?: TestSpec;
    objects?: ObjectIndex;
    /** The project's reusable steps (what a `useBlock` step is checked against). */
    blocks?: BlockIndex;
    /** Columns of the test data set the spec names, if any. */
    dataColumns?: string[];
}

// ── plain wording for schema problems ───────────────────────────────────────

const FIELD_WORDS: Record<string, string> = {
    url: "the address",
    locator: "the element",
    value: "the text",
    key: "the key",
    ms: "the time to wait",
    check: "the check",
    expected: "the expected value",
    method: "the request method",
    path: "the path",
    checked: "ticked or not",
    title: "the title",
    file: "the test file",
    target: "the place to drop it",
    frame: "the frame",
};

const stepNo = (i: number) => `Step ${i + 1}`;

function describeIssue(issue: { code: string; path: Array<string | number>; message: string; received?: unknown }): BuilderDiagnostic {
    const path = issue.path;
    if (path[0] === "steps" && typeof path[1] === "number") {
        const i = path[1];
        const field = path.slice(2).filter((p) => typeof p === "string").pop() as string | undefined;
        if (issue.code === "invalid_union_discriminator") return { stepIndex: i, severity: "error", message: `${stepNo(i)}: choose what this step does.` };
        if (path.length === 2 && issue.code === "invalid_type") return { stepIndex: i, severity: "error", message: `${stepNo(i)} is not a valid step.` };
        const what = field ? (FIELD_WORDS[field] ?? `“${field}”`) : "this step";
        if (issue.code === "invalid_type" && issue.received === "undefined") return { stepIndex: i, severity: "error", message: `${stepNo(i)}: ${what} is missing.` };
        if (issue.code === "invalid_type") return { stepIndex: i, severity: "error", message: `${stepNo(i)}: ${what} has the wrong kind of value.` };
        if (issue.code === "invalid_enum_value") return { stepIndex: i, severity: "error", message: `${stepNo(i)}: ${what} is not one the platform knows.` };
        if (issue.code === "too_big" || issue.code === "too_small") return { stepIndex: i, severity: "error", message: `${stepNo(i)}: ${what} is out of range.` };
        return { stepIndex: i, severity: "error", message: `${stepNo(i)}: ${what} ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}` };
    }
    if (path[0] === "steps") return { severity: "error", message: issue.code === "too_small" ? "A test needs at least one step." : "The steps are not a list." };
    if (path[0] === "title") return { severity: "error", message: `The title needs 3 to ${BUILDER_LIMITS.title} characters.` };
    if (path[0] === "testData") return { severity: "error", message: "The test values are not valid: each name needs a text value." };
    return { severity: "error", message: `${path.length ? `“${path.join(".")}”` : "The test"}: ${issue.message}` };
}

// ── secrets ─────────────────────────────────────────────────────────────────

/** A field whose name says it holds something secret. */
const SECRET_FIELD = /pass(word|code|phrase)?\b|passwd|\bsecret\b|one[- ]time|\botp\b|\btotp\b|\bcv[vc]\b|security code|card[- ]?number|\bpin\b/i;
/** Values that are only placeholders the platform fills in from saved sign-in details or the environment: never a literal secret. */
const SAFE_PLACEHOLDER = /\{\{\s*(credentials|secret|env)\.[\w.-]+\s*\}\}/g;
const PLACEHOLDER_ONLY = (v: string) => v.replace(SAFE_PLACEHOLDER, "").trim() === "";

const TOKEN_PATTERNS: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{16,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
    /\bTEST_(USERNAME|PASSWORD|TOTP_SECRET)\b/,
];
const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|cookie|x-auth-token)$/i;

const stringsIn = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
    else if (v && typeof v === "object") for (const x of Object.values(v)) stringsIn(x, out);
    return out;
};

const locatorWords = (l: unknown): string => {
    if (!l || typeof l !== "object") return "";
    const x = l as { role?: string; value?: string };
    return `${x.role ?? ""} ${x.value ?? ""}`;
};

/** Plain-language problems with secrets in one step (empty = fine). */
export function secretProblems(step: Step): string[] {
    const out: string[] = [];
    for (const s of stringsIn(step)) {
        if (TOKEN_PATTERNS.some((re) => re.test(s))) {
            out.push("This looks like a real key, token or password. Do not type secrets into a test: use a placeholder such as {{credentials.password}}, or {{env.NAME}} for an environment setting.");
            return out;
        }
    }
    if (step.action === "fill" && !isLocatorRef(step.locator) && SECRET_FIELD.test(locatorWords(step.locator)) && !PLACEHOLDER_ONLY(step.value)) {
        out.push("This field holds a secret. Use {{credentials.password}} (or another {{credentials...}} placeholder) so the real value is never stored in the test.");
    }
    if (step.action === "request" && step.headers) {
        for (const [name, value] of Object.entries(step.headers)) {
            if (SECRET_HEADERS.test(name) && !PLACEHOLDER_ONLY(value)) out.push(`The ${name} header must not hold a real secret. Leave sign-in to the “Use the saved sign-in” setting, or use a {{credentials...}} placeholder.`);
        }
    }
    return out;
}

/**
 * Plain-language problems with secrets in a block (empty = fine): a default value that looks like a real key, and the block's steps judged with
 * every parameter at its default (a parameter without one stands for a harmless placeholder), the way a test that uses the block would give them.
 */
export function blockSecretProblems(b: { params: ReadonlyArray<{ name: string; default?: string }>; steps: readonly Step[] }): string[] {
    const out: string[] = [];
    for (const p of b.params) if (p.default !== undefined && TOKEN_PATTERNS.some((re) => re.test(p.default!))) out.push(`The default value of “${p.name}” looks like a real key, token or password. Use a {{credentials...}} or {{env.NAME}} placeholder instead.`);
    const values = new Map(b.params.map((p) => [p.name, p.default ?? "{{env.EXAMPLE}}"]));
    b.steps.forEach((step, i) => {
        for (const p of secretProblems(fillStep(step, values))) out.push(`Step ${i + 1}: ${p}`);
    });
    return out;
}

/** A name in code that says its value is secret: password, adminPassword, ADMIN_PASSWORD, apiKey, authToken, clientSecret, … */
const SECRET_NAME = /(pass(word|code|phrase)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|totp)$/i;
/** `name: "literal"` or `name = "literal"` (quoted names too). Template literals with ${…} are lookups, not literals. */
const NAMED_LITERAL = /(?:^|[^\w$])["']?([A-Za-z_$][\w$]*)["']?\s*(?::|=(?![=>]))\s*(["'`])((?:(?!\2)[^\\\n]|\\.){1,500})\2/g;

/** Known key formats. Code may read the test account's TEST_* settings: that is how it signs in without holding the secret. */
const CODE_TOKEN_PATTERNS = TOKEN_PATTERNS.filter((re) => !re.source.includes("TEST_"));

/** Plain-language problems with secrets written into code (a helper): a known key format, or a literal given to a secret-named field. */
export function codeSecretProblems(source: string): string[] {
    const out: string[] = [];
    if (CODE_TOKEN_PATTERNS.some((re) => re.test(source))) out.push("This looks like a real key, token or password. Do not write secrets into code: read them from the saved sign-in details or an environment setting instead.");
    for (const m of source.matchAll(NAMED_LITERAL)) {
        const [, name, quote, value] = m;
        if (!SECRET_NAME.test(name!) || (quote === "`" && value!.includes("${")) || PLACEHOLDER_ONLY(value!)) continue;
        out.push(`“${name!.slice(0, 40)}” is given a literal value in the code. Do not write secrets into code: read them from the saved sign-in details or an environment setting instead.`);
        break;
    }
    return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** JSON with sorted keys, to compare two steps without caring about key order. */
export function stable(v: unknown): string {
    const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, walk(val)])) : x);
    return JSON.stringify(walk(v));
}

/** The spec after the platform's own defaults, so two specs can be compared. */
export function normalised(spec: unknown): string {
    const r = TestSpecSchema.safeParse(spec);
    return stable(r.success ? r.data : spec);
}

/** Checks a person's locator: a way of finding and the text it needs. */
function locatorProblem(l: unknown): string | undefined {
    if (!l || typeof l !== "object") return "choose the element";
    if (isLocatorRef(l)) return undefined;
    const x = l as { by?: string; role?: string; value?: string };
    if (x.by === "role") return x.role && x.role.trim() ? undefined : "choose the role of the element (button, link...)";
    return x.value && x.value.trim() ? undefined : "say how to find the element (its text, label, placeholder, test id or selector)";
}

const NEEDS_EXPECTED = new Set(["text", "value", "url", "title", "count"]);
const NEEDS_LOCATOR = new Set(["enabled", "disabled", "value"]);
const RESPONSE_NEEDS_EXPECTED = new Set(["status", "statusClass", "jsonType", "header", "bodyContains", "bodyNotContains", "statusBelow"]);
const RESPONSE_NEEDS_PATH = new Set(["jsonPath", "jsonType", "header"]);

/** Step-level rules the schema cannot express. */
function stepProblems(step: Step, kind: EditableKind): string[] {
    const out: string[] = [];
    // Reusable steps are judged when they are put in place (below); here only that a block is named.
    if (step.action === "useBlock") {
        if (!step.block.trim()) out.push("choose the reusable steps to run");
        return out;
    }
    if (!ACTIONS_BY_KIND[kind].includes(step.action)) {
        out.push(kind === "web" ? "This kind of step belongs in an API test." : "This kind of step belongs in a web test.");
        return out;
    }
    switch (step.action) {
        case "navigate":
            if (!step.url.trim()) out.push("enter the address to open");
            break;
        case "click":
        case "hover":
        case "fill":
        case "select":
        case "check": {
            const p = locatorProblem(step.locator);
            if (p) out.push(p);
            if (step.action === "select" && !step.value.trim()) out.push("say which option to choose");
            break;
        }
        case "upload": {
            const p = locatorProblem(step.locator);
            if (p) out.push(p);
            // The name must be one of the project's test files; the platform checks that when it saves (it knows the library).
            if (!step.file.trim()) out.push("choose the test file to upload");
            break;
        }
        case "email": {
            if (!step.to.trim()) out.push("enter the address the email is sent to");
            if (step.use === "code") {
                const p = step.locator ? locatorProblem(step.locator) : "choose the field to type the code into";
                if (p) out.push(p);
            }
            break;
        }
        case "drag": {
            const p = locatorProblem(step.locator);
            if (p) out.push(p);
            const t = locatorProblem(step.target);
            if (t) out.push(t === "choose the element" ? "choose where to drop it" : `where to drop it: ${t}`);
            break;
        }
        case "press":
            if (!step.key.trim()) out.push("enter the key to press (for example Enter)");
            if (step.locator) {
                const p = locatorProblem(step.locator);
                if (p) out.push(p);
            }
            break;
        case "assert": {
            if (step.locator) {
                const p = locatorProblem(step.locator);
                if (p) out.push(p);
            }
            if (NEEDS_LOCATOR.has(step.check) && !step.locator) out.push("choose the element to check");
            if (NEEDS_EXPECTED.has(step.check) && (step.expected === undefined || String(step.expected).trim() === "")) out.push("say what it should be");
            if (step.check === "count" && step.expected !== undefined && !/^\d+$/.test(String(step.expected).trim())) out.push("the number of elements must be a whole number");
            if ((step.check === "visible" || step.check === "hidden") && !step.locator && (step.expected === undefined || String(step.expected).trim() === "")) out.push("choose the element, or the text that should be on the page");
            break;
        }
        case "request":
            if (!step.path.trim()) out.push("enter the path to call (for example /api/products)");
            if (step.body !== undefined && JSON.stringify(step.body).length > BUILDER_LIMITS.jsonText) out.push("the request body is too large");
            break;
        case "assertResponse":
            if (RESPONSE_NEEDS_EXPECTED.has(step.check) && (step.expected === undefined || String(step.expected).trim() === "")) out.push("say what it should be");
            if (RESPONSE_NEEDS_PATH.has(step.check) && step.check !== "jsonType" && !(step.path ?? "").trim()) out.push(step.check === "header" ? "enter the header name" : "enter the path into the response (for example items.0.id)");
            if (step.schema !== undefined && JSON.stringify(step.schema).length > BUILDER_LIMITS.jsonText) out.push("the schema is too large");
            break;
        default:
            break;
    }
    return out;
}

/**
 * Validates what the editor sends. The ids that the person does not own (test id, kind, category, origin) always come from the stored
 * test, never from the request. Returns the spec only when there is no error.
 */
export function checkSpecInput(input: unknown, ctx: EditContext): { spec?: TestSpec; diagnostics: BuilderDiagnostic[] } {
    const diagnostics: BuilderDiagnostic[] = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) return { diagnostics: [{ severity: "error", message: "The test is missing." }] };
    const raw = input as Record<string, unknown>;
    const parsed = TestSpecSchema.safeParse({ ...raw, testId: ctx.testId, kind: ctx.kind, category: ctx.category, source: ctx.source, desktop: undefined });
    if (!parsed.success) {
        const seen = new Set<string>();
        for (const issue of parsed.error.issues) {
            const d = describeIssue(issue as never);
            const key = `${d.stepIndex ?? ""}|${d.message}`;
            if (!seen.has(key)) {
                seen.add(key);
                diagnostics.push(d);
            }
        }
        return { diagnostics };
    }
    const spec = parsed.data;

    // Caps.
    if (spec.title.length > BUILDER_LIMITS.title) diagnostics.push({ severity: "error", message: `The title can have at most ${BUILDER_LIMITS.title} characters.` });
    if (spec.description.length > BUILDER_LIMITS.description * 4) diagnostics.push({ severity: "error", message: "The description is too long." });
    if (spec.steps.length > BUILDER_LIMITS.steps) diagnostics.push({ severity: "error", message: `A test can have at most ${BUILDER_LIMITS.steps} steps.` });
    const dataKeys = Object.keys(spec.testData);
    if (dataKeys.length > BUILDER_LIMITS.testData) diagnostics.push({ severity: "error", message: `A test can have at most ${BUILDER_LIMITS.testData} test values.` });
    for (const [k, v] of Object.entries(spec.testData)) {
        if (k !== "dataSet" && !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(k)) diagnostics.push({ severity: "error", message: `The test value name “${k.slice(0, 40)}” can only use letters, numbers and underscores, and must start with a letter.` });
        if (v.length > BUILDER_LIMITS.testDataValue) diagnostics.push({ severity: "error", message: `The test value “${k.slice(0, 40)}” is too long (at most ${BUILDER_LIMITS.testDataValue} characters).` });
        if (TOKEN_PATTERNS.some((re) => re.test(v))) diagnostics.push({ severity: "error", message: `The test value “${k.slice(0, 40)}” looks like a real key or token. Use a {{credentials...}} or {{env.NAME}} placeholder instead.` });
    }

    const before = new Set((ctx.current?.steps ?? []).map((s) => stable(s)));
    spec.steps.forEach((step, i) => {
        for (const s of stringsIn(step)) {
            if (s.length > BUILDER_LIMITS.string && !(step.action === "request" || step.action === "assertResponse")) {
                diagnostics.push({ stepIndex: i, severity: "error", message: `${stepNo(i)}: a text is longer than ${BUILDER_LIMITS.string} characters.` });
                break;
            }
            if (s.length > BUILDER_LIMITS.jsonText) {
                diagnostics.push({ stepIndex: i, severity: "error", message: `${stepNo(i)}: a text is too long.` });
                break;
            }
        }
        for (const p of stepProblems(step, ctx.kind)) diagnostics.push({ stepIndex: i, severity: "error", message: p.startsWith("This kind") ? `${stepNo(i)}: ${p}` : `${stepNo(i)}: ${p}.` });
        // Secrets are checked in steps the person added or changed: a step that was already in the test is left as it was.
        if (!before.has(stable(step))) for (const p of secretProblems(step)) diagnostics.push({ stepIndex: i, severity: "error", message: `${stepNo(i)}: ${p}` });
    });

    // A step "in the popup" needs an earlier click that opens one.
    for (const p of popupProblems(spec.steps)) diagnostics.push({ stepIndex: p.stepIndex, severity: "error", message: `${stepNo(p.stepIndex)}: ${p.message}` });

    // Shared elements the steps refer to must exist and fit the kind of test.
    spec.steps.forEach((s, i) => {
        if (!isLocatorRef(locatorOf(s))) return;
        const own = refProblems({ ...spec, steps: [s] }, ctx.objects);
        if (own.length) diagnostics.push({ stepIndex: i, severity: "error", message: `${stepNo(i)}: ${own[0]}` });
    });

    // Reusable steps: they must exist, fit the kind of test and have their values. The steps they bring get the same checks as steps typed here,
    // reported on the step that uses them (a block was vetted when it was saved, but a value given here can still be a secret or break a step).
    if (hasBlocks(spec)) {
        const expanded = tryExpandBlocks(spec, ctx.blocks);
        if (!expanded.ok) {
            for (const p of expanded.problems.length ? expanded.problems : [{ message: expanded.error }]) diagnostics.push({ ...(p.stepIndex !== undefined ? { stepIndex: p.stepIndex } : {}), severity: "error", message: p.message });
        } else {
            const seen = new Set<string>();
            const report = (at: number, block: string, text: string) => {
                const key = `${at}|${text}`;
                if (seen.has(key)) return;
                seen.add(key);
                diagnostics.push({ stepIndex: at, severity: "error", message: `${stepNo(at)}: in the reusable steps “${block}”, ${text.charAt(0).toLowerCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}` });
            };
            for (const s of expanded.spec.steps) {
                const mark = (s as { __block?: { at: number; call: { block: string } } }).__block;
                if (!mark) continue;
                for (const p of stepProblems(s, ctx.kind)) report(mark.at, mark.call.block, p);
                for (const p of secretProblems(s)) report(mark.at, mark.call.block, p);
            }
        }
    }

    // Placeholders nothing provides are a warning: the step then types an empty value.
    for (const name of unknownPlaceholders(spec, ctx.dataColumns ?? [])) {
        const index = spec.steps.findIndex((s) => stringsIn(s).some((t) => new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`).test(t)));
        diagnostics.push({ ...(index >= 0 ? { stepIndex: index } : {}), severity: "warning", message: `${index >= 0 ? `${stepNo(index)}: ` : ""}{{${name}}} is not defined. Add it under Test values, or the step uses an empty value.` });
    }

    return errorsOf(diagnostics).length ? { diagnostics } : { spec, diagnostics };
}

/** The first spec of a test built from nothing: one step, valid, that says where to begin. */
export function blankSpec(o: { testId: string; title: string; kind: EditableKind; category: string; startPath: string }): TestSpec {
    return TestSpecSchema.parse({
        testId: o.testId,
        title: o.title,
        description: "",
        kind: o.kind,
        category: o.category,
        type: "functional",
        priority: "medium",
        steps: o.kind === "web" ? [{ action: "navigate", url: o.startPath }] : [{ action: "request", method: "GET", path: o.startPath }],
        tags: ["built-in-editor"],
        source: { origin: "manual" },
    });
}
