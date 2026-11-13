import { isLocatorRef, type Locator, type PlainLocator, type TestSpec } from "../spec/schema.js";
import { DATA_SET_KEY, dataSetNameOf, resolveRows, type DataSet } from "../testdata/dataset.js";
import { frameSelector } from "../web/pages.js";

/** JS string literal (JSON is a strict subset of JS string syntax, so this is injection-safe). */
export function lit(value: string): string {
    // JSON leaves U+2028/U+2029 raw (legal in JS strings since ES2019); escape them anyway so no
    // generated file ever contains a raw line separator.
    return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Render a value that may contain {{placeholders}} as a JS expression.
 *  - {{credentials.username|password}} → process.env.TEST_USERNAME / TEST_PASSWORD (secrets never embedded)
 *  - {{credentials.totp}} → a fresh one-time code computed from process.env.TEST_TOTP_SECRET (see identity/totp.ts)
 *  - {{name}} → data[name]  (declared in the script's `data` object)
 */
export function expr(value: string, inDataInitializer = false): string {
    if (!PLACEHOLDER.test(value)) {
        PLACEHOLDER.lastIndex = 0;
        return lit(value);
    }
    PLACEHOLDER.lastIndex = 0;
    const parts: string[] = [];
    let last = 0;
    for (const m of value.matchAll(PLACEHOLDER)) {
        if (m.index! > last) parts.push(escapeTemplate(value.slice(last, m.index)));
        parts.push("${" + varExpr(m[1]!, inDataInitializer) + "}");
        last = m.index! + m[0].length;
    }
    if (last < value.length) parts.push(escapeTemplate(value.slice(last)));
    return "`" + parts.join("") + "`";
}

function varExpr(name: string, inDataInitializer: boolean): string {
    if (name === "unique") return "unique";
    if (name === "credentials.username") return '(process.env.TEST_USERNAME ?? "")';
    if (name === "credentials.password") return '(process.env.TEST_PASSWORD ?? "")';
    // A one-time code is computed when the step runs (never embedded): totpCode() is the helper the generator adds to the script.
    if (name === "credentials.totp") return 'totpCode(process.env.TEST_TOTP_SECRET ?? "")';
    // Named accounts: {{credentials.admin.username|password|totp}} -> TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD / TEST_ADMIN_TOTP_SECRET.
    const role = /^credentials\.([a-z][a-z0-9_-]*)\.(username|password|totp|apiToken)$/.exec(name);
    if (role) {
        const prefix = `TEST_${role[1]!.toUpperCase().replace(/-/g, "_")}`;
        if (role[2] === "apiToken") return `(process.env.${prefix}_API_TOKEN ?? "")`;
        return role[2] === "totp" ? `totpCode(process.env.${prefix}_TOTP_SECRET ?? "")` : `(process.env.${prefix}_${role[2]!.toUpperCase()} ?? "")`;
    }
    // Environment variables of the environment the test runs in: {{env.BASE_ACCOUNT}} -> TEST_ENV_BASE_ACCOUNT (see environments/env.ts).
    const envVar = /^env\.([A-Za-z][A-Za-z0-9_]*)$/.exec(name);
    if (envVar) return `(process.env.TEST_ENV_${envVar[1]!.toUpperCase()} ?? "")`;
    // `data` cannot reference itself while it is being initialised; leave other names empty there.
    return inDataInitializer ? '""' : `data[${lit(name)}] ?? ""`;
}

function escapeTemplate(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** `data` object literal: spec.testData with {{unique}} always available. */
export function dataDeclaration(spec: TestSpec): string {
    const entries = Object.entries(spec.testData)
        .map(([k, v]) => `    ${lit(k)}: ${expr(v, true)},`)
        .join("\n");
    return `const unique = String(Date.now());\nconst data: Record<string, string> = {\n    unique,\n${entries}\n};`;
}

/** The rows a data-driven spec is rendered for (`testData.dataSet`), or undefined for an ordinary spec. */
export function dataRowsFor(spec: TestSpec, ctx: { dataSets?: Record<string, DataSet> }): ReturnType<typeof resolveRows> | undefined {
    const name = dataSetNameOf(spec.testData);
    return name ? resolveRows(name, ctx.dataSets) : undefined;
}

/**
 * `data` for a data-driven script: the spec's own testData (without the data set's name) plus one object per row. `data` is a
 * `let`, reset at the start of every row's test (a worker runs the tests of a file one after another, so rows never see each other's values).
 */
export function dataSetDeclaration(spec: TestSpec, set: NonNullable<ReturnType<typeof dataRowsFor>>): string {
    const entries = Object.entries(spec.testData)
        .filter(([k]) => k !== DATA_SET_KEY)
        .map(([k, v]) => `    ${lit(k)}: ${expr(v, true)},`)
        .join("\n");
    const note = set.truncated ? ` Only the first ${set.rows.length} of ${set.total} rows are rendered.` : "";
    const rows = set.rows.map((r) => `    { ${set.columns.map((c) => `${lit(c)}: ${lit(r[c] ?? "")}`).join(", ")} },`).join("\n");
    return [
        `const unique = String(Date.now());`,
        `const baseData: Record<string, string> = {\n${entries}\n};`,
        `// Test data set ${commentSafe(JSON.stringify(dataSetNameOf(spec.testData) ?? ""))}: one test per row.${commentSafe(note)} Plain values only; secrets never belong here.`,
        `const ROWS: Array<Record<string, string>> = [\n${rows}\n];`,
        `let data: Record<string, string> = { unique, ...baseData };`,
    ].join("\n");
}

/** Title of one row's test; the row number is the only thing that varies, so it is built at run time from a safe literal. */
export const rowTitle = (spec: TestSpec): string => `${lit(`${spec.testId}: ${spec.title}`)} + \` [row \${rowIndex + 1}/\${ROWS.length}]\``;

/** First statement of a row's test: this row's values become `data`. */
export const ROW_SETUP = "data = { ...baseData, ...row, unique };";

/**
 * Make text safe inside a `//` comment. \r, U+2028 and U+2029 also terminate a JS line comment, so
 * stripping only \n would let page/LLM/OpenAPI-derived text inject code into scripts we execute.
 */
export function commentSafe(text: string): string {
    return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}

export function regexFromText(expected: string | number): string {
    const s = String(expected);
    // Placeholders resolve at runtime, so escape the resolved value there (as the interpreter does).
    if (/\{\{\s*[\w.-]+\s*\}\}/.test(s)) return `new RegExp((${expr(s)}).replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"), "i")`;
    const escaped = String(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `new RegExp(${lit(escaped)}, "i")`;
}

/**
 * A step's locator, which must be a concrete one. A shared-element reference is resolved before a spec reaches a generator (see
 * ../locators/refs.ts); one that gets here anyway is refused with a plain message instead of being rendered as something else.
 */
export function concreteLocator(l: Locator): Locator {
    if (isLocatorRef(l)) throw new Error(`This test refers to '${l.ref}', which is not in the object repository.`);
    return l;
}

/** Locator → Playwright-style call chain on `root` (`page` or `mobile`). */
export function locatorCall(root: string, l: Locator): string {
    concreteLocator(l);
    // An element inside frames is found through each frame in turn (web only: a phone screen has no frames).
    if (l.frame?.length) {
        if (root !== "page") throw new Error("Frames exist only on web pages; this step names a frame.");
        root = l.frame.reduce((r, f) => `${r}.frameLocator(${lit(frameSelector(f))})`, root);
    }
    if ((l.within || l.filter) && !root.startsWith("page")) throw new Error("Filters and containers in a locator exist only on web pages; this step uses one.");
    // The frame (or the page) the element is in: a filter's inner locators are found from it, as Playwright requires.
    const scope = root;
    if (l.within) root = plainCall(root, l.within, true);
    const out = plainCall(root, l);
    const f = l.filter;
    const filter = f
        ? `.filter({ ${[
              f.hasText !== undefined && `hasText: ${expr(f.hasText)}`,
              f.hasNotText !== undefined && `hasNotText: ${expr(f.hasNotText)}`,
              f.has && `has: ${plainCall(scope, f.has, true)}`,
              f.hasNot && `hasNot: ${plainCall(scope, f.hasNot, true)}`,
          ]
              .filter(Boolean)
              .join(", ")} })`
        : "";
    return l.nth !== undefined ? `${out}${filter}.nth(${l.nth})` : `${out}${filter}`;
}

/** One strategy's call on `root`, with its own `nth` (a container or a filter's inner locator, or the element itself without its filter). */
function plainCall(root: string, l: PlainLocator, withNth = false): string {
    const exact = l.exact ? ", exact: true" : "";
    let out: string;
    switch (l.by) {
        case "role":
            out = l.value
                ? `${root}.getByRole(${lit(l.role ?? "button")}, { name: ${expr(l.value)}${exact} })`
                : `${root}.getByRole(${lit(l.role ?? "button")})`;
            break;
        case "label":
            out = `${root}.getByLabel(${expr(l.value ?? "")}${l.exact ? ", { exact: true }" : ""})`;
            break;
        case "text":
            out = `${root}.getByText(${expr(l.value ?? "")}${l.exact ? ", { exact: true }" : ""})`;
            break;
        case "placeholder":
            out = `${root}.getByPlaceholder(${expr(l.value ?? "")}${l.exact ? ", { exact: true }" : ""})`;
            break;
        case "testId":
            out = `${root}.getByTestId(${expr(l.value ?? "")})`;
            break;
        case "css":
            out = `${root}.locator(${expr(l.value ?? "")})`;
            break;
        case "altText":
            if (!root.startsWith("page")) throw new Error("Finding an element by its alt text works on web pages only.");
            out = `${root}.getByAltText(${expr(l.value ?? "")}${l.exact ? ", { exact: true }" : ""})`;
            break;
        case "title":
            if (!root.startsWith("page")) throw new Error("Finding an element by its title works on web pages only.");
            out = `${root}.getByTitle(${expr(l.value ?? "")}${l.exact ? ", { exact: true }" : ""})`;
            break;
    }
    return withNth && l.nth !== undefined ? `${out}.nth(${l.nth})` : out;
}

export function fileHeader(spec: TestSpec, note: string): string {
    return [
        `// ${spec.testId} — ${commentSafe(spec.title)}`,
        `// Generated by AI Testing Platform from the canonical test specification (${note}).`,
        `// Re-render from the spec instead of editing this file by hand.`,
    ].join("\n");
}

export function scriptFilename(spec: TestSpec, ext = ".spec.ts"): string {
    return `${spec.testId}${ext}`;
}
