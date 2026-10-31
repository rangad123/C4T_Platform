/**
 * Which Playwright versions the generated code works with, and the check that keeps it that way.
 *
 * A downloaded test project pins the Playwright the platform runs (see ../../platform/portable-export.ts), but people bring their own:
 * an older one their company standardised on, a newer one they upgraded to. Generated code therefore only uses Playwright APIs that
 * exist in OLDEST_PLAYWRIGHT. This file lists every Playwright method the generators emit (and the options of those calls that came
 * later than the method itself), each with the version that introduced it. tests/portable-api-range.test.ts renders scripts for every
 * kind of step and check, reads them with the TypeScript parser and fails when a script calls something this list does not know, or
 * something newer than OLDEST_PLAYWRIGHT. The real proof on real machines is the `portable-exports` job of
 * .github/workflows/runner-matrix.yml, which runs an export with the oldest and the newest version.
 *
 * Hand-written code tests are not covered: their authors may use any API of the version they wrote them against (the pinned one).
 */
import { createRequire } from "node:module";
import type * as TS from "typescript";

/**
 * The oldest Playwright the generated code is checked against. Why 1.42: every generated test passes its tags in the test details
 * argument (`test(title, { tag: [...] }, body)`), which Playwright introduced in 1.42. 1.42.1 is that line's last patch release.
 */
export const OLDEST_PLAYWRIGHT = "1.42.1";

/** "1.27" -> [1, 27]: introductions are tracked by minor release. */
const minorOf = (v: string): [number, number] => {
    const m = /^(\d+)\.(\d+)/.exec(v);
    if (!m) throw new Error(`Not a version: ${v}`);
    return [Number(m[1]), Number(m[2])];
};

/** True when a feature introduced in `since` exists in `version`. */
export function availableIn(since: string, version: string): boolean {
    const [a, b] = minorOf(since);
    const [c, d] = minorOf(version);
    return a < c || (a === c && b <= d);
}

/**
 * Playwright methods the generated code calls, by method name, with the release that introduced them. A name that is also a plain
 * JavaScript method (fill, filter, find on arrays; get, delete on maps) is listed here with Playwright's version: the check is
 * conservative and treats every such call as Playwright's.
 */
export const PLAYWRIGHT_METHODS: Readonly<Record<string, string>> = {
    // @playwright/test
    test: "1.10", step: "1.10", info: "1.10", setTimeout: "1.10", beforeEach: "1.10", afterEach: "1.10", beforeAll: "1.10", afterAll: "1.10", skip: "1.10", fail: "1.10", slow: "1.10", describe: "1.10", attach: "1.10", defineConfig: "1.28",
    expect: "1.10", toBe: "1.10", toEqual: "1.10", toBeTruthy: "1.10", toBeFalsy: "1.10", toContain: "1.10", toMatch: "1.10", toBeGreaterThan: "1.10", toBeLessThan: "1.10", toBeLessThanOrEqual: "1.10", toBeGreaterThanOrEqual: "1.10",
    toBeVisible: "1.20", toBeHidden: "1.20", toBeEnabled: "1.20", toBeDisabled: "1.20", toContainText: "1.20", toHaveValue: "1.20", toHaveCount: "1.20", toHaveURL: "1.20", toHaveTitle: "1.20", toHaveScreenshot: "1.23",
    // Page, Frame, Keyboard
    goto: "1.0", waitForTimeout: "1.0", waitForLoadState: "1.0", waitForEvent: "1.0", waitForURL: "1.11", url: "1.0", title: "1.0", context: "1.0", on: "1.0", off: "1.0", once: "1.0", evaluate: "1.0", $$eval: "1.0", $eval: "1.0",
    screenshot: "1.0", viewportSize: "1.0", setViewportSize: "1.0", close: "1.0", isClosed: "1.0", content: "1.0", reload: "1.0", goBack: "1.0", bringToFront: "1.0", mainFrame: "1.0", frames: "1.0", opener: "1.0",
    locator: "1.14", frameLocator: "1.17", getByRole: "1.27", getByText: "1.27", getByLabel: "1.27", getByPlaceholder: "1.27", getByTestId: "1.27", getByAltText: "1.27", getByTitle: "1.27",
    // Locator
    click: "1.14", dblclick: "1.14", fill: "1.14", clear: "1.28", selectOption: "1.14", setChecked: "1.15", check: "1.14", uncheck: "1.14", hover: "1.14", dragTo: "1.18", press: "1.14", pressSequentially: "1.38", type: "1.14",
    nth: "1.14", first: "1.14", last: "1.14", or: "1.33", and: "1.34", filter: "1.22", all: "1.29", count: "1.14", waitFor: "1.16", evaluateAll: "1.14", getAttribute: "1.14", innerText: "1.14", innerHTML: "1.14", textContent: "1.14",
    inputValue: "1.13", isVisible: "1.14", isHidden: "1.14", isEnabled: "1.14", isDisabled: "1.14", isEditable: "1.14", isChecked: "1.14", setInputFiles: "1.14", focus: "1.14", blur: "1.28", scrollIntoViewIfNeeded: "1.14", boundingBox: "1.14",
    // BrowserContext, Browser, CDP, files
    newPage: "1.0", newContext: "1.0", browser: "1.0", pages: "1.0", storageState: "1.8", newCDPSession: "1.0", send: "1.0", detach: "1.0", setFiles: "1.0", addInitScript: "1.0", cookies: "1.0", addCookies: "1.0", route: "1.0", unroute: "1.0",
    // APIRequestContext, APIResponse, Request, Response, ConsoleMessage
    fetch: "1.16", get: "1.16", post: "1.16", put: "1.16", patch: "1.16", delete: "1.16", head: "1.16", dispose: "1.16", status: "1.0", statusText: "1.0", ok: "1.0", headers: "1.0", headersArray: "1.15", allHeaders: "1.15", headerValue: "1.15",
    text: "1.0", json: "1.0", body: "1.0", request: "1.0", response: "1.0", resourceType: "1.0", failure: "1.0", method: "1.0", postData: "1.0", frame: "1.0", isNavigationRequest: "1.0", redirectedFrom: "1.0", securityDetails: "1.13", serverAddr: "1.13", location: "1.0", args: "1.0", timing: "1.0", sizes: "1.15",
};

/** Options of Playwright calls that arrived after the call itself: call name -> option -> version. */
export const PLAYWRIGHT_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    test: { tag: "1.42", annotation: "1.42" },
    step: { box: "1.39", location: "1.48", timeout: "1.50" },
    fetch: { maxRedirects: "1.26", maxRetries: "1.46" },
    get: { maxRedirects: "1.26", maxRetries: "1.46" },
    post: { maxRedirects: "1.26", maxRetries: "1.46" },
    toHaveScreenshot: { maxDiffPixels: "1.23", animations: "1.23", caret: "1.23", fullPage: "1.23", mask: "1.23", scale: "1.23", maskColor: "1.35", stylePath: "1.41" },
    screenshot: { animations: "1.20", caret: "1.20", mask: "1.20", scale: "1.20", maskColor: "1.35", style: "1.41" },
    getByRole: { name: "1.27", exact: "1.28", includeHidden: "1.27", disabled: "1.27" },
    getByText: { exact: "1.27" },
    getByLabel: { exact: "1.27" },
    getByPlaceholder: { exact: "1.27" },
    filter: { hasText: "1.22", has: "1.22", hasNot: "1.33", hasNotText: "1.33", visible: "1.51" },
    waitFor: { state: "1.16" },
    pressSequentially: { delay: "1.38" },
    newContext: { storageState: "1.8", ignoreHTTPSErrors: "1.0", viewport: "1.0" },
    defineConfig: { snapshotPathTemplate: "1.28", fullyParallel: "1.20", testIgnore: "1.10", testMatch: "1.10", outputDir: "1.10" },
};

/**
 * Method names in generated code that are not Playwright's: JavaScript and Node.js built-ins and the generated helpers' own functions.
 * Kept as an explicit list so a new call has to be looked at once (and put here or in PLAYWRIGHT_METHODS with its version).
 */
export const NOT_PLAYWRIGHT: ReadonlySet<string> = new Set([
    // JavaScript built-ins
    "map", "forEach", "some", "every", "find", "findIndex", "includes", "indexOf", "lastIndexOf", "join", "push", "pop", "shift", "unshift", "slice", "splice", "concat", "reduce", "sort", "reverse", "flat", "flatMap", "keys", "values", "entries", "from", "isArray", "of",
    "split", "replace", "replaceAll", "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "padStart", "padEnd", "repeat", "charAt", "charCodeAt", "codePointAt", "localeCompare", "normalize", "match", "matchAll", "search", "substring", "toString", "toFixed", "toISOString", "valueOf", "at",
    "parse", "stringify", "assign", "create", "freeze", "fromEntries", "getOwnPropertyNames", "hasOwnProperty", "isFinite", "isInteger", "isSafeInteger", "isNaN", "parseInt", "parseFloat", "max", "min", "floor", "ceil", "round", "abs", "random", "pow", "sqrt", "trunc", "now",
    "then", "catch", "finally", "resolve", "reject", "race", "allSettled", "exec", "set", "has", "add", "call", "apply", "bind", "write", "writeBigUInt64BE", "readUInt32BE", "alloc", "for", "observe", "disconnect", "getEntries", "getEntriesByName", "getEntriesByType", "querySelector", "querySelectorAll", "closest", "matches", "getComputedStyle", "getBoundingClientRect", "setAttribute", "removeAttribute", "hasAttribute",
    "encodeURIComponent", "decodeURIComponent", "toJSON",
    // Node.js
    "createHmac", "update", "digest", "randomUUID", "randomBytes", "existsSync", "readFileSync", "writeFileSync", "mkdirSync", "rmSync", "renameSync", "statSync", "readdirSync", "unlinkSync", "mkdtempSync", "tmpdir", "isFile", "isDirectory", "basename", "dirname", "extname",
    "getBuiltinModule", "spawn", "spawnSync", "kill", "end", "destroy", "connect", "getPeerCertificate", "checkServerIdentity", "setEncoding", "appendFileSync", "log",
    // @axe-core/playwright's builder (pinned separately, with its own version)
    "withTags", "include", "exclude", "analyze",
    // the generated helpers' own functions
    "wait", "sleep", "native", "real", "act", "finish", "launch", "closeApp",
]);

export interface ApiUse {
    /** "page.getByRole" style: the method, or "method({ option })" for an option. */
    api: string;
    since: string;
    line: number;
}

export interface ApiScan {
    uses: ApiUse[];
    /** Method names that are in neither list (each needs a decision). */
    unknown: Array<{ name: string; line: number }>;
}

/** A table entry of the object itself (never one inherited from Object.prototype, such as "toString"). */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

let tsModule: typeof TS | undefined;
const loadTs = (): typeof TS => (tsModule ??= createRequire(import.meta.url)("typescript") as typeof TS);

/** Reads a script (or a helper's source text) with the TypeScript parser and lists the Playwright methods and late options it uses. */
export function scanPlaywrightApis(source: string): ApiScan {
    const ts = loadTs();
    const file = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const uses: ApiUse[] = [];
    const unknown: ApiScan["unknown"] = [];
    const lineOf = (n: TS.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
    const visit = (node: TS.Node): void => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
            const member = ts.isPropertyAccessExpression(callee);
            if (name) {
                const since = own(PLAYWRIGHT_METHODS, name);
                if (since !== undefined && (member || name === "test" || name === "expect" || name === "defineConfig")) uses.push({ api: name, since, line: lineOf(node) });
                else if (member && !NOT_PLAYWRIGHT.has(name)) unknown.push({ name, line: lineOf(node) });
                const options = own(PLAYWRIGHT_OPTIONS, name);
                if (options) {
                    for (const arg of node.arguments) {
                        if (!ts.isObjectLiteralExpression(arg)) continue;
                        for (const prop of arg.properties) {
                            const key = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : undefined;
                            const optionSince = key === undefined ? undefined : own(options, key);
                            if (optionSince !== undefined) uses.push({ api: `${name}({ ${key} })`, since: optionSince, line: lineOf(prop) });
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return { uses, unknown };
}

/** The uses that need a newer Playwright than `version` (by default the oldest supported one). */
export function newerThan(scan: ApiScan, version = OLDEST_PLAYWRIGHT): ApiUse[] {
    return scan.uses.filter((u) => !availableIn(u.since, version));
}
