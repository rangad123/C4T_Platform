/**
 * Looking at the files of a repository without running any of them: which ones are test files, what a test file is called, how many
 * tests it holds and which modules it imports. The TypeScript parser reads the text; nothing is evaluated.
 */
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_TEST_FILES = 200;
export const MAX_CHECKOUT_BYTES = 50 * 1024 * 1024;
export const MAX_CHECKOUT_FILES = 5000;
export const MAX_TITLE_LENGTH = 160;
export const MAX_PATH_LENGTH = 300;

const BUILTINS = new Set(builtinModules);
const TEST_FILE = /\.(spec|test)\.(ts|js)$/;

/** A path as listed by git (forward slashes, relative). False when it cannot be a path inside the repository. */
export function isSafeRepoPath(p: string): boolean {
    if (!p || p.length > MAX_PATH_LENGTH) return false;
    if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p)) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(p)) return false;
    return !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

/** Whether `file` lies under `subpath` ("" = everywhere). */
export function isUnder(file: string, subpath: string): boolean {
    return !subpath || file === subpath || file.startsWith(`${subpath}/`);
}

export type SkipReason = { path: string; reason: string };

/** Decide from the path alone whether a file is a candidate test file; a reason when it is skipped for a reason worth telling. */
export function classifyPath(file: string): "candidate" | "ignore" | "hidden-folder" | "dependency-folder" {
    const parts = file.split("/");
    if (parts.slice(0, -1).some((p) => p === "node_modules")) return "dependency-folder";
    if (parts.slice(0, -1).some((p) => p.startsWith("."))) return "hidden-folder";
    return TEST_FILE.test(parts[parts.length - 1]!) ? "candidate" : "ignore";
}

/** UTF-8 text with no NUL bytes, or null (a binary or differently encoded file). */
export function decodeUtf8(buf: Buffer): string | null {
    if (buf.includes(0)) return null;
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch {
        return null;
    }
}

export interface FileScan {
    title: string;
    tests: number;
    /** Every module specifier the file mentions (import, export from, require, import()). */
    imports: string[];
    /** Local helper names used as `./helpers/<name>`. */
    helpers: string[];
}

const TEST_MODIFIERS = new Set(["only", "skip", "fixme", "fail", "slow"]);

const titleText = (node: ts.Expression | undefined): string | null => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null);

/** Is `callee` `test`, `test.only`, `it` ... (a single test) or `test.describe` ...? */
function calleeKind(callee: ts.Expression): "test" | "describe" | null {
    if (ts.isIdentifier(callee)) return callee.text === "test" || callee.text === "it" ? "test" : null;
    if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const base = callee.expression;
        if (ts.isIdentifier(base) && (base.text === "test" || base.text === "it")) {
            if (name === "describe") return "describe";
            return TEST_MODIFIERS.has(name) ? "test" : null;
        }
        // test.describe.only / test.describe.serial / test.describe.configure(...)
        if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === "test" && base.name.text === "describe") {
            return name === "configure" ? null : "describe";
        }
    }
    return null;
}

/** Read a test file's structure: the title, number of tests and imports. Never throws; unparseable text yields zero tests. */
export function scanTestFile(content: string, fileName: string): FileScan {
    const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, false, fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const imports: string[] = [];
    let tests = 0;
    let firstTest: string | null = null;
    let firstDescribe: string | null = null;
    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) imports.push(node.moduleReference.expression.text);
        else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
                const arg = node.arguments[0];
                if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) imports.push(arg.text);
            } else {
                const kind = calleeKind(callee);
                // `test(title, fn)` has a string title first; `test.skip()` or `test.fail(cond)` inside a test body do not.
                const title = titleText(node.arguments[0]);
                if (kind === "test" && title !== null && node.arguments.length >= 2) {
                    tests += 1;
                    firstTest ??= title;
                } else if (kind === "describe" && title !== null) firstDescribe ??= title;
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    const helpers = [...new Set(imports.map((i) => /^\.\/helpers\/([^/]+?)(?:\.ts|\.js)?$/.exec(i)?.[1]).filter((n): n is string => !!n))];
    const base = path.posix.basename(fileName).replace(/\.(spec|test)\.(ts|js)$/, "");
    const raw = firstDescribe ?? firstTest ?? base.replace(/[-_.]+/g, " ").trim() ?? base;
    return { title: cleanTitle(raw || base), tests, imports, helpers };
}

/** Repository text is untrusted: one line, no control characters, capped. (The UI escapes it as well.) */
export function cleanTitle(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const t = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return (t.length > MAX_TITLE_LENGTH ? `${t.slice(0, MAX_TITLE_LENGTH - 1)}…` : t) || "Imported test";
}

/**
 * Local and package imports that are not allowed in an imported file, in plain words. `@playwright/test`,
 * `@axe-core/playwright` and `./helpers/<name>` are the only imports a custom test may have; the static guard says the same,
 * this adds the friendlier explanation for the common cases (a relative import into the repository).
 */
export function importProblems(scan: FileScan, existingHelpers: ReadonlySet<string>): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    const add = (m: string) => {
        if (!seen.has(m)) (seen.add(m), problems.push(m));
    };
    for (const spec of scan.imports) {
        if (spec === "@playwright/test" || spec === "@axe-core/playwright" || spec.startsWith("node:") || BUILTINS.has(spec) || !spec) continue; // Node built-ins are the guard's to explain
        const helper = /^\.\/helpers\/([^/]+?)(?:\.ts|\.js)?$/.exec(spec);
        if (helper) {
            if (!existingHelpers.has(helper[1]!)) add(`These files use a helper named ${helper[1]} that doesn't exist yet. Add it under Helpers first.`);
            continue;
        }
        if (spec.startsWith(".")) add(`Imports "${shorten(spec)}" from elsewhere in the repository. Imported tests must be a single file; only ./helpers/<name> modules are allowed.`);
        else if (spec.startsWith("@") || /^[a-z]/i.test(spec)) add(`Imports the package "${shorten(spec)}". Only @playwright/test and @axe-core/playwright can be used.`);
        else add(`Imports "${shorten(spec)}", which is not allowed.`);
    }
    return problems;
}

const shorten = (s: string) => (s.length > 60 ? `${s.slice(0, 59)}…` : s).replace(/[\u0000-\u001f]/g, "");
