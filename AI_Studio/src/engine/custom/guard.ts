/**
 * The static guard for hand-written scripts and shared helper modules.
 *
 * It parses the code with TypeScript's own parser and walks the syntax tree (never regular expressions over the text), so
 * comments, string contents and spacing cannot hide anything from it and nothing is "matched by accident".
 *
 * What this is NOT: a security boundary. A determined author can write code the guard cannot understand (for example a
 * property name that only exists at run time). The real boundary is WHERE hand-written scripts may run: a runner agent
 * whose owner started it with --allow-custom-scripts, or the platform host with ALLOW_CUSTOM_SCRIPTS=true (see
 * platform/custom-policy.ts). The guard catches accidents and the obvious ways of reaching the machine; docs/features/
 * custom-scripts.md lists what it cannot see.
 *
 * Pure: no files, no network. Used by the platform when a script is saved or about to run, by the editor while a person
 * types, and again by the runner agent before it runs anything (defence in depth).
 */
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { LOAD_HELPER_SOURCE } from "../performance/load.js";
import { RUN_ADDRESS_MODULE } from "../spec/run-address.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
    severity: Severity;
    line: number;
    column: number;
    message: string;
    rule?: string;
}

/** Limits a script and a helper may not exceed (bytes of UTF-8). */
export const MAX_SCRIPT_BYTES = 200_000;
export const MAX_HELPER_BYTES = 100_000;
export const MAX_LINES = 20_000;

/** Helper names: file `<name>.ts`, imported as `./helpers/<name>`. */
export const HELPER_NAME = /^[a-z][a-z0-9-]{0,40}$/;
/** Names Windows treats as devices whatever the extension is; a file called like this would not be a file. */
const RESERVED_NAMES = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

export const isHelperName = (name: string): boolean => HELPER_NAME.test(name) && !RESERVED_NAMES.has(name);

/** The modules a hand-written script may import besides its own helpers. */
export const ALLOWED_MODULES: readonly string[] = ["@playwright/test", "@axe-core/playwright"];

/**
 * Environment names a script may read: the ones generated scripts read (see the generators), plus TEST_* and API_*. A runner only ever
 * hands a script these and a short list of system names, never the platform's own secrets, so this is about accidents, not about secrets.
 */
export const ENV_ALLOWED = (name: string): boolean =>
    name === "BASE_URL" || name === "API_BASE_URL" || /^TEST_[A-Z0-9_]+$/.test(name) || /^API_[A-Z0-9_]+$/.test(name) || name === "AITP_EVIDENCE" || name === "AITP_CLEANUP" || name === "AITP_CREATED_DIR" || name === "BLOCK_PRIVATE_TARGETS";

/** The one statement the platform's own evidence helper uses to look at the run's variables (so a taken-over generated script passes as it is). */
const BLESSED_ENV_DECLARATION = 'env = typeof process !== "undefined" && process.env ? process.env : {}';
/** A named test account's variables are read as `process.env[prefix + "_USERNAME"]` by generated scripts (see identity/access.ts). */
const ROLE_VAR_SUFFIX = /^_(?:USERNAME|PASSWORD|TOTP_SECRET|API_TOKEN)$/;

/** The rules in words, for the editor and the settings page (GET /api/config customScripts.guard). */
export const GUARD_RULES: string[] = [
    "Scripts may import only @playwright/test, @axe-core/playwright and your shared helpers (./helpers/name).",
    "require(), dynamic import(), eval, new Function and import.meta are not allowed.",
    "Node's system modules (child_process, fs, net, http, os, vm, worker_threads and the like) cannot be imported; node:dns/promises is the one exception, for the address check generated scripts carry.",
    "Only BASE_URL, API_BASE_URL and TEST_* / API_* values may be read from process.env; process.exit and the rest of process are off limits.",
    "globalThis, global, module, Reflect, constructor, __proto__, getPrototypeOf and getOwnPropertyDescriptor are not allowed, also when the name is kept in a constant or used in a destructuring pattern.",
    "Files may only be written or read inside the test's own folder: absolute paths and .. in a file path are refused (also when the path is kept in a constant).",
    "Browser start options args and env, the _electron and android parts of Playwright, and page.goto of a file: address are not allowed.",
    `A script may be at most ${MAX_SCRIPT_BYTES / 1000} KB, a helper at most ${MAX_HELPER_BYTES / 1000} KB, and its structure must stay readable (nesting and size are limited).`,
    "This check catches accidents; it is not a security boundary. It cannot see text that is built at run time, code a library runs, or what a script sends over the network (fetch and request.newContext are not covered by the platform's address guard). Hand-written scripts only run where their owner allowed it, and ALLOW_CUSTOM_SCRIPTS must not be enabled for authors you do not trust.",
];

/** Structure limits: a tree this big or this deep is refused before it is walked (the walk is recursive and the parser is not free). */
export const MAX_AST_NODES = 250_000;
export const MAX_AST_DEPTH = 500;
/** At most this many findings are listed; the rest are summed up in one line. */
const MAX_DIAGNOSTICS = 300;

export interface GuardOptions {
    /** "test": imports helpers as ./helpers/<name>. "helper": imports other helpers as ./<name>. */
    kind?: "test" | "helper";
    /** Byte limit; defaults to the kind's limit. */
    maxBytes?: number;
}

export interface GuardResult {
    diagnostics: Diagnostic[];
    /** True when no diagnostic is an error. */
    ok: boolean;
    /** Helper names the code imports (read from the syntax tree, also when other diagnostics exist). */
    helperImports: string[];
}

// ── loading TypeScript ───────────────────────────────────────────────────────

let tsModule: typeof TS | null | undefined;
function loadTs(): typeof TS | null {
    if (tsModule !== undefined) return tsModule;
    try {
        tsModule = createRequire(import.meta.url)("typescript") as typeof TS;
    } catch {
        tsModule = null;
    }
    return tsModule;
}

/** True when the code checker is installed. Without it hand-written scripts are refused, never let through unchecked. */
export const guardAvailable = (): boolean => loadTs() !== null;

/**
 * Whole top-level statements of code the PLATFORM wrote and pastes into generated scripts, which need more than a person's script does
 * (the load check reads and writes its own result file). A statement that matches exactly is not looked at; change one character of it and it
 * is checked like everything else. This is what lets a generated load check be taken over without being rewritten first.
 */
let trustedStatements: Set<string> | undefined;
function trusted(ts: typeof TS): Set<string> {
    if (!trustedStatements) {
        const src = ts.createSourceFile("platform.ts", LOAD_HELPER_SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
        trustedStatements = new Set(src.statements.map((st) => st.getText(src).replace(/\s+/g, " ")));
    }
    return trustedStatements;
}

// ── the walk ─────────────────────────────────────────────────────────────────

/** Names that may not appear as identifiers (outside property-name positions and type positions). */
const FORBIDDEN_IDENTIFIERS: Record<string, string> = {
    require: "require() is not allowed. Import what you need at the top of the file.",
    module: "module is not allowed.",
    eval: "eval is not allowed.",
    Function: "Function (and new Function) is not allowed: it runs text as code.",
    AsyncFunction: "AsyncFunction is not allowed.",
    GeneratorFunction: "GeneratorFunction is not allowed.",
    globalThis: "globalThis is not allowed.",
    global: "global is not allowed.",
    Reflect: "Reflect is not allowed: it reads and changes objects by names the check cannot see.",
};
/** Property names that lead to the Function constructor or to prototype changes. */
const FORBIDDEN_PROPERTIES = new Set([
    "constructor",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "mainModule",
    "binding",
    "dlopen",
    "_load",
    // Walking up to the Function constructor without writing `.constructor`.
    "getPrototypeOf",
    "setPrototypeOf",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
]);
/** Playwright options that start other programs or reuse another profile. */
const FORBIDDEN_OPTION_KEYS = new Set(["executablePath", "userDataDir"]);
/** Parts of Playwright that start desktop applications or drive Android devices. */
const FORBIDDEN_NAMESPACE_MEMBERS = new Set(["_electron", "electron", "android"]);
/** Browser start options (args, env) are commands and variables for another program. Refused wherever they are given to a launch or to test.use. */
const LAUNCH_ONLY_KEYS = new Set(["args", "env"]);
const LAUNCH_CALLS = new Set(["launch", "use", "newContext", "connect"]);
/** Method names that save a file to a path (the first argument). */
const PATH_METHODS = new Set(["saveAs", "setInputFiles"]);
/** Option keys whose string value is a file path, when the object is passed to one of these calls (a cookie's path "/" is not a file). */
const PATH_KEYS = new Set(["path", "outputPath", "storageState", "dir"]);
const PATH_CALLS = new Set(["screenshot", "pdf", "attach", "storageState", "stop", "routeFromHAR", "saveAs", "setInputFiles", "newContext", "newPage", "use", "launch"]);
/** Constant values tracked per expression (a product of choices is cut off here). */
const MAX_CANDIDATES = 16;

type NameValues = Map<string, string[]>;

/**
 * The possible texts of a constant string expression ("a" + "b", `a${"b"}`, 'x', c ? "a" : "b", ["a","b"].join("/"), "a".concat("b")),
 * or undefined when any part is not constant. With `names`, an identifier stands for the constant texts it is given anywhere in the file
 * (a `const`, or any later `x = "..."`): all of them count, because the check cannot tell which one is in force where it is used.
 */
function constValues(ts: typeof TS, node: TS.Node | undefined, names?: NameValues, depth = 0): string[] | undefined {
    if (!node || depth > 20) return undefined;
    const cross = (a: string[] | undefined, b: string[] | undefined, join: (x: string, y: string) => string): string[] | undefined => {
        if (!a || !b) return undefined;
        const out: string[] = [];
        for (const x of a) for (const y of b) if (out.length < MAX_CANDIDATES) out.push(join(x, y));
        return out;
    };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return constValues(ts, node.expression, names, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isNumericLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) return names?.get(node.text);
    if (ts.isTemplateExpression(node)) {
        let acc: string[] | undefined = [node.head.text];
        for (const span of node.templateSpans) acc = cross(cross(acc, constValues(ts, span.expression, names, depth + 1), (x, y) => x + y), [span.literal.text], (x, y) => x + y);
        return acc;
    }
    if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.PlusToken) return cross(constValues(ts, node.left, names, depth + 1), constValues(ts, node.right, names, depth + 1), (x, y) => x + y);
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            const a = constValues(ts, node.left, names, depth + 1);
            const b = constValues(ts, node.right, names, depth + 1);
            return a && b ? [...a, ...b].slice(0, MAX_CANDIDATES) : undefined;
        }
        return undefined;
    }
    if (ts.isConditionalExpression(node)) {
        const a = constValues(ts, node.whenTrue, names, depth + 1);
        const b = constValues(ts, node.whenFalse, names, depth + 1);
        return a && b ? [...a, ...b].slice(0, MAX_CANDIDATES) : undefined;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const target = node.expression.expression;
        if (method === "concat") {
            let acc = constValues(ts, target, names, depth + 1);
            for (const a of node.arguments) acc = cross(acc, constValues(ts, a, names, depth + 1), (x, y) => x + y);
            return acc;
        }
        if (method === "join" && ts.isArrayLiteralExpression(target)) {
            const sep = node.arguments.length === 0 ? [","] : constValues(ts, node.arguments[0], names, depth + 1);
            let acc: string[] | undefined = [""];
            target.elements.forEach((el, i) => {
                acc = cross(cross(acc, i === 0 ? [""] : sep, (x, y) => x + y), constValues(ts, el, names, depth + 1), (x, y) => x + y);
            });
            return acc;
        }
        if ((method === "toLowerCase" || method === "toUpperCase" || method === "trim") && node.arguments.length === 0) {
            return constValues(ts, target, names, depth + 1)?.map((s) => (method === "toLowerCase" ? s.toLowerCase() : method === "toUpperCase" ? s.toUpperCase() : s.trim()));
        }
    }
    // Anything else (text read from data, built by a function of the script's own, or by a library) is not folded: the documentation says so.
    return undefined;
}

/** The single constant text, for the places that need exactly one (the process.env rules do not follow names, so a computed name stays refused). */
function constString(ts: typeof TS, node: TS.Node | undefined): string | undefined {
    const v = constValues(ts, node);
    return v && v.length === 1 ? v[0] : undefined;
}

const isAbsoluteOrUp = (p: string): boolean => /^(?:[a-zA-Z]:|[\\/]|~)/.test(p) || p.split(/[\\/]+/).includes("..");

/** Measure the tree without recursion: how many nodes, how deep. */
function measure(ts: typeof TS, root: TS.Node): { nodes: number; depth: number } {
    let nodes = 0;
    let depth = 0;
    const stack: Array<[TS.Node, number]> = [[root, 1]];
    while (stack.length) {
        const [n, d] = stack.pop()!;
        nodes++;
        if (d > depth) depth = d;
        if (nodes > MAX_AST_NODES || d > MAX_AST_DEPTH) return { nodes, depth };
        ts.forEachChild(n, (c) => void stack.push([c, d + 1]));
    }
    return { nodes, depth };
}

/**
 * Check a script. NEVER throws and never takes long: a tree that is too big or too deep, or any failure inside the check, becomes an error
 * diagnostic (the platform's event loop is shared by every request and job, so one hostile file must not be able to stop it).
 */
export function checkScript(content: string, opts: GuardOptions = {}): GuardResult {
    try {
        return checkScriptUnsafe(content, opts);
    } catch (e) {
        const why = e instanceof RangeError ? "its structure is nested too deeply to check" : "it could not be checked";
        return { diagnostics: [{ severity: "error", line: 1, column: 1, rule: "unreadable", message: `This code is refused because ${why}. Split it into smaller parts.` }], ok: false, helperImports: [] };
    }
}

function checkScriptUnsafe(content: string, opts: GuardOptions): GuardResult {
    const kind = opts.kind ?? "test";
    const diagnostics: Diagnostic[] = [];
    const helperImports = new Set<string>();
    let dropped = 0;
    const result = (): GuardResult => {
        if (dropped > 0) diagnostics.push({ severity: "warning", line: 1, column: 1, rule: "many-findings", message: `${dropped} more finding${dropped === 1 ? "" : "s"} are not listed.` });
        return { diagnostics: sort(diagnostics), ok: !diagnostics.some((d) => d.severity === "error"), helperImports: [...helperImports] };
    };
    const push = (line: number, column: number, severity: Severity, rule: string, message: string) => {
        if (diagnostics.length >= MAX_DIAGNOSTICS) {
            // An error is never lost: the listing is cut, the verdict is not.
            if (severity === "error" && !diagnostics.some((d) => d.severity === "error")) diagnostics.push({ severity, line, column, message, rule });
            else dropped++;
            return;
        }
        diagnostics.push({ severity, line, column, message, rule });
    };

    const ts = loadTs();
    if (!ts) {
        push(1, 1, "error", "guard-unavailable", "The code checker (TypeScript) is not installed on this server, so hand-written scripts cannot be checked and are refused.");
        return result();
    }

    const maxBytes = opts.maxBytes ?? (kind === "helper" ? MAX_HELPER_BYTES : MAX_SCRIPT_BYTES);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxBytes) {
        push(1, 1, "error", "size", `This ${kind === "helper" ? "helper" : "script"} is ${Math.ceil(bytes / 1000)} KB; the limit is ${Math.floor(maxBytes / 1000)} KB.`);
        return result();
    }

    // Control characters make code read differently from how it runs; they are refused wherever they are.
    // eslint-disable-next-line no-control-regex
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.exec(content);
    const where = (index: number) => {
        const before = content.slice(0, index).split("\n");
        return { line: before.length, column: (before[before.length - 1]?.length ?? 0) + 1 };
    };
    if (bad) {
        const at = where(bad.index);
        push(at.line, at.column, "error", "control-character", "The code contains a hidden control character (U+" + bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0") + "). Remove it.");
    }
    const lineCount = content.split("\n").length;
    if (lineCount > MAX_LINES) {
        push(1, 1, "error", "lines", `This file has ${lineCount} lines; the limit is ${MAX_LINES}.`);
        return result();
    }

    // Syntax: the parser's own diagnostics (the same errors Playwright's loader would stop on). transpileModule is NOT used: it also emits code,
    // and its cost grows with the square of a long expression (a 120 KB `1+1+1+...` took 49 s). A syntax error is reported with its place.
    const source = ts.createSourceFile("script.ts", content, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const syntax = ((source as unknown as { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    // Too big or too deep to walk safely: refused before anything else looks at it.
    const size = measure(ts, source);
    if (size.nodes > MAX_AST_NODES || size.depth > MAX_AST_DEPTH) {
        push(1, 1, "error", "complexity", size.depth > MAX_AST_DEPTH ? `This code is nested more than ${MAX_AST_DEPTH} levels deep (for example one very long expression). Split it into smaller statements.` : `This code has more than ${MAX_AST_NODES.toLocaleString("en")} parts. Split it into smaller files.`);
        return result();
    }
    const at = (node: TS.Node | number): { line: number; column: number } => {
        const pos = typeof node === "number" ? node : node.getStart(source);
        const lc = source.getLineAndCharacterOfPosition(pos);
        return { line: lc.line + 1, column: lc.character + 1 };
    };
    // Text-direction overrides make comments and code read in another order than they run. Inside a string or pattern they are data (the platform's
    // own input checks send one), so only the ones outside literals are refused.
    const literalRanges: Array<[number, number]> = [];
    const collect = (n: TS.Node): void => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)) literalRanges.push([n.getStart(source), n.getEnd()]);
        ts.forEachChild(n, collect);
    };
    collect(source);
    for (const m of content.matchAll(/[\u202A-\u202E\u2066-\u2069]/g)) {
        const idx = m.index!;
        if (literalRanges.some(([from, to]) => idx >= from && idx < to)) continue;
        const at = where(idx);
        push(at.line, at.column, "error", "control-character", "The code contains a hidden text-direction character (U+" + m[0].charCodeAt(0).toString(16).toUpperCase() + ") outside a string. Remove it.");
        break;
    }
    for (const d of syntax) {
        const lc = d.start !== undefined ? source.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
        push(lc.line + 1, lc.character + 1, "error", "syntax", ts.flattenDiagnosticMessageText(d.messageText, " "));
    }

    const err = (node: TS.Node, rule: string, message: string) => {
        const p = at(node);
        push(p.line, p.column, "error", rule, message);
    };
    const warn = (node: TS.Node, rule: string, message: string) => {
        const p = at(node);
        push(p.line, p.column, "warning", rule, message);
    };

    // Constant texts per name, and the names that stand for Playwright's whole module (`import * as pw`). Three rounds settle names built from names.
    const names: NameValues = new Map();
    const namespaces = new Set<string>();
    const addValues = (name: string, values: string[] | undefined): void => {
        if (!values) return;
        const have = names.get(name) ?? [];
        for (const v of values) if (have.length < MAX_CANDIDATES && !have.includes(v)) have.push(v);
        names.set(name, have);
    };
    const gather = (n: TS.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
            addValues(n.name.text, constValues(ts, n.initializer, names));
            if (ts.isIdentifier(n.initializer) && namespaces.has(n.initializer.text)) namespaces.add(n.name.text);
        } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
            addValues(n.left.text, constValues(ts, n.right, names));
        } else if (ts.isImportDeclaration(n) && n.importClause) {
            const nb = n.importClause.namedBindings;
            if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
            if (n.importClause.name) namespaces.add(n.importClause.name.text);
        }
        ts.forEachChild(n, gather);
    };
    for (let round = 0; round < 3; round++) gather(source);
    /** Is this expression one of those names, with or without parentheses and type assertions around it? */
    const isNamespace = (e: TS.Expression): boolean => {
        let n: TS.Expression = e;
        while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
        return ts.isIdentifier(n) && namespaces.has(n.text);
    };
    /** Every text a name or expression can have, from constants of this file (an empty list when nothing is known). */
    const valuesOf = (node: TS.Node | undefined): string[] => constValues(ts, node, names) ?? [];
    const textOf = (v: string): string => (v.length > 50 ? `${v.slice(0, 47)}...` : v);
    /** The name of the call an object literal is (part of) the argument of, looking through nested objects only (never arrays, so a cookie's path is not a file). */
    const callOfObject = (obj: TS.Node): string | undefined => {
        let n: TS.Node = obj;
        for (let i = 0; i < 8 && n.parent; i++) {
            const p: TS.Node = n.parent;
            if (ts.isCallExpression(p) && p.arguments.includes(n as TS.Expression)) return ts.isPropertyAccessExpression(p.expression) ? p.expression.name.text : ts.isIdentifier(p.expression) ? p.expression.text : undefined;
            if (ts.isPropertyAssignment(p) || ts.isObjectLiteralExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) n = p;
            else return undefined;
        }
        return undefined;
    };
    /** Is this a path-like value that leaves the test's own folder? Reports it and says yes. */
    const checkPathValue = (value: TS.Node): void => {
        if (ts.isArrayLiteralExpression(value)) return void value.elements.forEach(checkPathValue);
        for (const v of valuesOf(value)) {
            if (isAbsoluteOrUp(v)) return err(value, "path-escape", `The path “${textOf(v)}” points outside the test's own folder. Use a plain relative file name.`);
        }
    };

    /** The module specifier rules (static import, export from, import equals, import type, import()). */
    const checkSpecifier = (node: TS.Node, spec: string | undefined, how: string) => {
        if (spec === undefined) return err(node, "import", `${how} needs a plain text module name so it can be checked.`);
        // The address check of every generated script looks a name up with it, so a taken-over script runs as it is (engine/spec/run-address.ts).
        if (ALLOWED_MODULES.includes(spec) || spec === RUN_ADDRESS_MODULE) return;
        const helper = kind === "test" ? /^\.\/helpers\/([^/]+)$/.exec(spec) : /^\.\/([^/]+)$/.exec(spec);
        if (helper) {
            const name = helper[1]!;
            if (isHelperName(name)) {
                helperImports.add(name);
                return;
            }
            return err(node, "import-helper", `“${spec}” is not a valid helper name. Helper names use lower-case letters, digits and hyphens, for example ./helpers/login-steps.`);
        }
        err(node, "import", `Importing “${spec.length > 60 ? `${spec.slice(0, 57)}...` : spec}” is not allowed. Scripts may import ${ALLOWED_MODULES.join(", ")} and ${kind === "test" ? "./helpers/<name>" : "./<name>"}.`);
    };

    const inTypePosition = (node: TS.Node): boolean => {
        for (let n: TS.Node | undefined = node.parent; n; n = n.parent) {
            if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return true;
        }
        return false;
    };

    /** Identifiers that merely NAME a property or label something are not references to the global of that name. */
    const isNamePosition = (id: TS.Identifier): boolean => {
        const p = id.parent;
        if (!p) return false;
        if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
        if (ts.isQualifiedName(p) && p.right === id) return true;
        if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return true;
        if (ts.isImportSpecifier(p) && p.propertyName === id) return true;
        if (ts.isExportSpecifier(p) && p.propertyName === id) return true;
        if (ts.isBindingElement(p) && p.propertyName === id) return true;
        if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
        return false;
    };

    const checkEnvAccess = (node: TS.Node, envExpr: TS.Node) => {
        // `envExpr` is the `process.env` expression; look at how it is used.
        const parent = envExpr.parent;
        if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === envExpr) {
            if (!ENV_ALLOWED(parent.name.text)) err(parent, "env", `Reading process.env.${parent.name.text} is not allowed. Only BASE_URL, API_BASE_URL and TEST_* / API_* values can be read.`);
            return;
        }
        if (parent && ts.isElementAccessExpression(parent) && parent.expression === envExpr) {
            const key = constString(ts, parent.argumentExpression);
            const arg = parent.argumentExpression;
            const roleVar = ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken && ROLE_VAR_SUFFIX.test(constString(ts, arg.right) ?? "");
            if (key === undefined && roleVar) return;
            if (key === undefined) err(parent, "env", "process.env must be read by a fixed name (for example process.env.BASE_URL), not a computed one.");
            else if (!ENV_ALLOWED(key)) err(parent, "env", `Reading process.env[“${key}”] is not allowed. Only BASE_URL, API_BASE_URL and TEST_* / API_* values can be read.`);
            return;
        }
        // const { BASE_URL } = process.env
        if (parent && ts.isVariableDeclaration(parent) && parent.initializer === envExpr && ts.isObjectBindingPattern(parent.name)) {
            for (const el of parent.name.elements) {
                const key = el.dotDotDotToken ? undefined : el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : undefined) : ts.isIdentifier(el.name) ? el.name.text : undefined;
                if (key === undefined || !ENV_ALLOWED(key)) err(el, "env", `Reading ${key ? `process.env.${key}` : "all of process.env"} is not allowed. Only BASE_URL, API_BASE_URL and TEST_* / API_* values can be read.`);
            }
            return;
        }
        err(node, "env", "process.env can only be read one allowed name at a time (for example process.env.BASE_URL).");
    };

    const loopHasAwaitOrExit = (body: TS.Node): boolean => {
        let found = false;
        const visit = (n: TS.Node) => {
            if (found) return;
            if (ts.isAwaitExpression(n) || ts.isBreakStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
                found = true;
                return;
            }
            if (ts.isFunctionLike(n) && n !== body) return;
            ts.forEachChild(n, visit);
        };
        visit(body);
        return found;
    };
    const isTrue = (e: TS.Expression | undefined): boolean => e === undefined || e.kind === ts.SyntaxKind.TrueKeyword || (ts.isNumericLiteral(e) && Number(e.text) !== 0) || (ts.isParenthesizedExpression(e) && isTrue(e.expression));

    const visit = (node: TS.Node): void => {
        if (node.parent && ts.isSourceFile(node.parent) && trusted(ts).has(node.getText(source).replace(/\s+/g, " "))) return;
        // The platform's own evidence helper looks at the run's variables in exactly this form; it is not code a person wrote.
        if (ts.isVariableDeclaration(node) && node.initializer && node.getText(source).replace(/\s+/g, " ") === BLESSED_ENV_DECLARATION) return;
        // ── imports and exports ──
        if (ts.isImportDeclaration(node)) {
            checkSpecifier(node, ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined, "An import");
            // Named imports of things that launch other programs.
            const nb = node.importClause?.namedBindings;
            if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (["_electron", "electron", "android"].includes((el.propertyName ?? el.name).text)) err(el, "import", "Launching desktop applications or controlling Android devices is not allowed.");
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            checkSpecifier(node, ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined, "An export from another module");
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            err(node, "require", "import x = require(...) is not allowed. Use a normal import statement.");
        } else if (ts.isImportTypeNode(node)) {
            const lit = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : undefined;
            checkSpecifier(node, lit, "A type import");
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            err(node, "dynamic-import", "import(...) is not allowed. Put imports at the top of the file.");
        } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
            err(node, "import-meta", "import.meta is not allowed.");
        } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
            err(node, "declare-module", "Declaring a module is not allowed.");
        }

        // ── identifiers ──
        if (ts.isIdentifier(node) && !inTypePosition(node)) {
            const name = node.text;
            if (name === "process" && !isNamePosition(node)) {
                const p = node.parent;
                if (p && ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text === "env") checkEnvAccess(p, p);
                else err(node, "process", "Only process.env.BASE_URL, API_BASE_URL and TEST_* / API_* may be used from process; process.exit and the rest are not allowed.");
            } else if (FORBIDDEN_IDENTIFIERS[name] && !isNamePosition(node)) {
                // Shorthand `{ require }` is a reference; a declaration's own name is flagged too: the name itself is reserved.
                err(node, name === "require" ? "require" : name === "eval" ? "eval" : name === "Function" ? "function-constructor" : name === "Reflect" ? "reflection" : "global", FORBIDDEN_IDENTIFIERS[name]!);
            } else if (name === "__dirname" || name === "__filename") {
                if (!isNamePosition(node)) warn(node, "path-building", `${name} is the folder the platform runs scripts in; building paths from it will not work on a runner agent.`);
            }
        }
        // ── names that lead to the Function constructor, to prototypes, to Playwright's desktop / Android parts ──
        if (ts.isPropertyAccessExpression(node)) {
            const member = node.name.text;
            if (FORBIDDEN_PROPERTIES.has(member)) err(node.name, "forbidden-property", `.${member} is not allowed.`);
            else if (member === "_electron" || (FORBIDDEN_NAMESPACE_MEMBERS.has(member) && isNamespace(node.expression))) err(node.name, "import", "Launching desktop applications or controlling Android devices is not allowed.");
        }
        if (ts.isElementAccessExpression(node)) {
            // A constant, or a name that holds constants anywhere in this file (`const k = "constructor"; x[k][k]`): every possible text counts.
            for (const key of valuesOf(node.argumentExpression)) {
                if (FORBIDDEN_PROPERTIES.has(key)) err(node, "forbidden-property", `Reaching “${key}” by name is not allowed.`);
                else if (["require", "eval", "Function", "globalThis", "global", "module", "Reflect"].includes(key)) err(node, "forbidden-property", `Reaching “${key}” by name is not allowed.`);
                else if (key === "_electron" || (FORBIDDEN_NAMESPACE_MEMBERS.has(key) && isNamespace(node.expression))) err(node, "import", "Launching desktop applications or controlling Android devices is not allowed.");
            }
        }
        // Destructuring reads properties by name too: `const { constructor: F } = fn`, `{ ["constructor"]: F }`, `{ [k]: F }`, `const { android } = pw`.
        if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
            const pn = node.propertyName;
            const fromNamespace = ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer !== undefined && ts.isIdentifier(node.parent.parent.initializer) && namespaces.has(node.parent.parent.initializer.text);
            let keys: string[] | undefined;
            if (!pn) keys = ts.isIdentifier(node.name) ? [node.name.text] : [];
            else if (ts.isIdentifier(pn) || ts.isStringLiteral(pn) || ts.isNumericLiteral(pn) || ts.isNoSubstitutionTemplateLiteral(pn)) keys = [pn.text];
            else if (ts.isComputedPropertyName(pn)) {
                keys = constValues(ts, pn.expression, names);
                if (!keys) err(node, "forbidden-property", "A destructuring key computed at run time is not allowed: the check cannot see which property it reads. Use a fixed name.");
            }
            for (const key of keys ?? []) {
                if (FORBIDDEN_PROPERTIES.has(key)) err(node, "forbidden-property", `Reading “${key}” by destructuring is not allowed.`);
                else if (key === "_electron" || (fromNamespace && FORBIDDEN_NAMESPACE_MEMBERS.has(key))) err(node, "import", "Launching desktop applications or controlling Android devices is not allowed.");
            }
        }
        // Names inside object literals: browser start options and file paths.
        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
            const name = ts.isPropertyAssignment(node) ? (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined) : node.name.text;
            if (name && FORBIDDEN_OPTION_KEYS.has(name)) err(node, "launch-option", `The option “${name}” is not allowed: it starts other programs or reuses another browser profile.`);
            if (name && ts.isObjectLiteralExpression(node.parent)) {
                const call = callOfObject(node.parent);
                const inLaunchOptions = (() => {
                    // `test.use({ launchOptions: { args } })`, `newContext({ launchOptions: ... })`: the object is the value of a property called launchOptions.
                    const holder = node.parent.parent;
                    return ts.isPropertyAssignment(holder) && (ts.isIdentifier(holder.name) ? holder.name.text : ts.isStringLiteral(holder.name) ? holder.name.text : "") === "launchOptions";
                })();
                if (LAUNCH_ONLY_KEYS.has(name) && ((call !== undefined && LAUNCH_CALLS.has(call)) || inLaunchOptions)) err(node, "launch-option", `The option “${name}” is not allowed here: it gives commands or variables to the program that starts the browser.`);
                if (PATH_KEYS.has(name) && call && PATH_CALLS.has(call)) {
                    const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
                    if (!ts.isObjectLiteralExpression(value)) checkPathValue(value);
                }
            }
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
            // new Function(...) is a NewExpression, Function(...) a call; both are caught by the identifier rule. `.launch` of other programs:
            if (ts.isPropertyAccessExpression(callee) && ["launchServer", "launchPersistentContext", "connectOverCDP"].includes(callee.name.text)) err(callee.name, "launch", `${callee.name.text} is not allowed. Tests get their browser from the platform.`);
            // chromium.connect(url) drives a browser that runs somewhere else
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === "connect" && /^(?:chromium|firefox|webkit)$/.test(ts.isIdentifier(callee.expression) ? callee.expression.text : ts.isPropertyAccessExpression(callee.expression) ? callee.expression.name.text : "")) err(callee.name, "launch", "connect is not allowed. Tests get their browser from the platform.");
            if (method && PATH_METHODS.has(method)) {
                // saveAs(path); locator.setInputFiles(files); page.setInputFiles(selector, files): every argument is looked at.
                for (const arg of node.arguments) if (!ts.isObjectLiteralExpression(arg)) checkPathValue(arg);
            }
            if (method === "goto" && node.arguments[0]) {
                for (const v of valuesOf(node.arguments[0])) {
                    if (/^\s*(?:file|view-source|chrome|chrome-extension|filesystem)\s*:/i.test(v)) err(node.arguments[0], "goto-scheme", `Opening a “${textOf(v.trim().split(":")[0] ?? "")}:” address is not allowed. It reads files of the machine the test runs on. Use an http or https address.`);
                }
            }
        }


        // ── loops that can hang the run ──
        if ((ts.isWhileStatement(node) && isTrue(node.expression)) || (ts.isDoStatement(node) && isTrue(node.expression)) || (ts.isForStatement(node) && isTrue(node.condition))) {
            if (!loopHasAwaitOrExit(node.statement)) warn(node, "infinite-loop", "This loop has no await, break or return, so it may never end and hang the run.");
        }

        ts.forEachChild(node, visit);
    };
    visit(source);

    return result();
}

function sort(list: Diagnostic[]): Diagnostic[] {
    const seen = new Set<string>();
    return list
        .filter((d) => {
            const k = `${d.line}:${d.column}:${d.rule}:${d.message}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        })
        .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The errors only, as one plain sentence per line (for refusals that cannot show a list). */
export function describeErrors(list: readonly Diagnostic[], limit = 3): string {
    const errors = list.filter((d) => d.severity === "error");
    const shown = errors.slice(0, limit).map((d) => `line ${d.line}: ${d.message}`);
    return `${shown.join(" ")}${errors.length > limit ? ` (and ${errors.length - limit} more)` : ""}`;
}
