/**
 * The mechanical half of stages M2-M3 (docs/product-restructure/POSTGRES_S3_MIGRATION.md): turns synchronous `Db` calls into awaited
 * `Sql` calls, then adds `await` and `async` outwards through every caller, in src/, tests/ and scripts/, until nothing changes.
 *
 *   npx tsx scripts/async-codemod.ts [--out report.json] [--passes 40]
 *
 * It only writes what is certainly right. What needs a person is listed in the report instead: a callback of filter/some/every/find
 * /flatMap/forEach/sort/reduce, a constructor or getter, a type predicate, `expect(() => ...)`. `.map` callbacks become
 * `await Promise.all(list.map(async ...))`. A store's constructor and the schema helpers stay synchronous: they run while the database
 * opens, before anything else.
 *
 * The compiler then finds what is left (an interface that still says "sync", a callback type), and scripts/floating-promises.ts finds
 * a promise used as its value.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP_SYNC_FILES = new Set(["src/platform/db.ts", "src/platform/sql.ts", "src/platform/sql-dialect.ts"]);
/** Run while a database opens: schema helpers. */
const KEEP_SYNC_FUNCTIONS = /^(ensure|add\w*Columns$|repair|migrate|open|applyMigrations|createSchema)/;
const SYNC_ARRAY_METHODS = new Set(["filter", "some", "every", "find", "findIndex", "findLast", "flatMap", "forEach", "sort", "reduce", "reduceRight", "toSorted"]);
const TEST_BLOCKS = new Set(["it", "test", "beforeAll", "afterAll", "beforeEach", "afterEach"]);

interface Edit {
    pos: number;
    end: number;
    text: string;
}
export interface Manual {
    file: string;
    line: number;
    kind: string;
    text: string;
}
type FnLike = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.ConstructorDeclaration | ts.AccessorDeclaration;

const isFn = (n: ts.Node): n is FnLike => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isAccessor(n);
const enclosingFn = (n: ts.Node): FnLike | undefined => {
    for (let p = n.parent; p; p = p.parent) if (isFn(p)) return p;
    return undefined;
};
const isAsync = (f: FnLike) => Boolean(ts.getCombinedModifierFlags(f) & ts.ModifierFlags.Async);

/** A stable name for a function that can be called by name: `file#Class.method`, `file#fn`, `file#object.prop`. */
function keyOf(decl: ts.Node, sf: ts.SourceFile): string | undefined {
    const parts: string[] = [];
    let n: ts.Node | undefined = decl;
    while (n && !ts.isSourceFile(n)) {
        if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n) || ts.isModuleDeclaration(n)) && n.name) parts.unshift(n.name.getText(sf));
        else if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n === decl && !(ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent))) return undefined;
        n = n.parent;
    }
    return parts.length ? `${path.relative(ROOT, sf.fileName)}#${parts.join(".")}` : undefined;
}

function build() {
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
    return { program, checker: program.getTypeChecker() };
}

function onePass(converted: Set<string>, seed: boolean, manual: Map<string, Manual>): number {
    const { program, checker } = build();
    let changes = 0;
    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
        const rel = path.relative(ROOT, sf.fileName).split(path.sep).join("/");
        const edits: Edit[] = [];
        const madeAsync = new Set<FnLike>();
        const awaited = new Set<ts.Node>();
        const note = (node: ts.Node, kind: string) => {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            const m: Manual = { file: rel, line: line + 1, kind, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 110) };
            manual.set(`${rel}|${kind}|${m.text}`, m);
        };
        const insert = (pos: number, text: string) => edits.push({ pos, end: pos, text });

        /** Wraps `node` in `await`, with parentheses where the next token would otherwise bind to the promise. */
        const addAwait = (node: ts.Expression) => {
            if (awaited.has(node)) return;
            awaited.add(node);
            const p = node.parent;
            const tight = ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) || (ts.isCallExpression(p) && p.expression === node) || ts.isNonNullExpression(p);
            insert(node.getStart(sf), tight ? "(await " : "await ");
            if (tight) insert(node.getEnd(), ")");
        };

        /** Returns false when the function cannot simply become async; the place is listed for a person. */
        const makeAsync = (fn: FnLike | undefined, at: ts.Node): boolean => {
            if (!fn) {
                if (!rel.startsWith("tests/") && !rel.startsWith("scripts/")) note(at, "top-level");
                return rel.startsWith("tests/") || rel.startsWith("scripts/"); // top-level await is fine in an ES module test or script
            }
            if (isAsync(fn) || madeAsync.has(fn)) return true;
            if (ts.isConstructorDeclaration(fn) || ts.isAccessor(fn)) {
                note(at, ts.isConstructorDeclaration(fn) ? "constructor" : "getter");
                return false;
            }
            const call = ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn as ts.Expression) ? fn.parent : undefined;
            if (call) {
                const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText(sf);
                if (name === "expect") {
                    note(at, "expect-callback");
                    return false;
                }
                if (ts.isPropertyAccessExpression(call.expression) && SYNC_ARRAY_METHODS.has(name)) {
                    note(at, `callback-of-${name}`);
                    return false;
                }
                if (name === "tx" && !isAsync(fn)) {
                    /* a Db.tx body the seed pass rewrites */
                }
                if (ts.isPropertyAccessExpression(call.expression) && name === "map") {
                    // `await Promise.all(list.map(async (x) => ...))`, unless it is already inside a Promise.all.
                    const outer = call.parent;
                    const inAll = ts.isCallExpression(outer) && outer.expression.getText(sf) === "Promise.all";
                    if (!inAll) {
                        insert(call.getStart(sf), "await Promise.all(");
                        insert(call.getEnd(), ")");
                        if (!makeAsync(enclosingFn(call), call)) return false;
                    }
                } else if (["setTimeout", "setInterval", "setImmediate", "on", "once", "addHook", "addEventListener", "then", "catch", "finally", "use", "process.on", "beforeExit"].includes(name)) {
                    note(at, `review-callback-of-${name}`);
                }
            }
            if (fn.type && ts.isTypePredicateNode(fn.type)) {
                note(at, "type-predicate");
                return false;
            }
            madeAsync.add(fn);
            if (ts.isMethodDeclaration(fn)) insert(fn.name.getStart(sf), "async ");
            else if (ts.isArrowFunction(fn)) insert(fn.getStart(sf), "async ");
            else {
                const kw = fn.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword);
                insert(kw ? kw.getStart(sf) : fn.getStart(sf), "async ");
            }
            if (fn.type && !/^Promise</.test(fn.type.getText(sf))) {
                edits.push({ pos: fn.type.getStart(sf), end: fn.type.getEnd(), text: `Promise<${fn.type.getText(sf)}>` });
            }
            const key = keyOf(fn, sf);
            if (key) converted.add(key);
            return true;
        };

        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                if (seed && !KEEP_SYNC_FILES.has(rel) && rel.startsWith("src/") && ts.isPropertyAccessExpression(node.expression) && ["get", "all", "run", "tx"].includes(node.expression.name.text)) {
                    const receiver = node.expression.expression;
                    if (checker.getTypeAtLocation(receiver).getSymbol()?.getName() === "Db") {
                        const fn = enclosingFn(node);
                        const fnName = fn && (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) ? fn.name?.getText(sf) : undefined;
                        let keep = !fn || ts.isConstructorDeclaration(fn) || (fnName ? KEEP_SYNC_FUNCTIONS.test(fnName) : false);
                        for (let f = fn; f && !keep; f = enclosingFn(f)) keep = ts.isConstructorDeclaration(f) || KEEP_SYNC_FUNCTIONS.test((ts.isFunctionDeclaration(f) || ts.isMethodDeclaration(f) ? f.name?.getText(sf) : "") ?? "");
                        if (!keep && makeAsync(fn, node)) {
                            insert(receiver.getEnd(), ".sql");
                            addAwait(node);
                            changes++;
                            if (node.expression.name.text === "tx") {
                                const body = node.arguments[0];
                                if (body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
                                    if (!isAsync(body)) {
                                        madeAsync.add(body);
                                        insert(body.getStart(sf), "async ");
                                    }
                                } else note(node, "tx-without-inline-body");
                            }
                        }
                    }
                }
                const decl = checker.getResolvedSignature(node)?.declaration;
                if (decl && !ts.isJSDocSignature(decl)) {
                    const key = keyOf(decl, decl.getSourceFile());
                    const parent = node.parent;
                    const alreadyHandled = ts.isAwaitExpression(parent) || ts.isVoidExpression(parent);
                    const chained = ts.isPropertyAccessExpression(parent) && parent.expression === node && ["then", "catch", "finally"].includes(parent.name.text);
                    const inAll = ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression.getText(sf) === "Promise.all";
                    if (key && converted.has(key) && !alreadyHandled && !chained && !inAll) {
                        const fn = enclosingFn(node);
                        if (makeAsync(fn, node)) {
                            addAwait(node);
                            changes++;
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);

        if (edits.length) {
            let text = fs.readFileSync(sf.fileName, "utf8");
            // From the end, so earlier positions stay right. At one position: the closing ")" first, then openers.
            edits
                .map((e, i) => ({ ...e, i }))
                .sort((a, b) => b.pos - a.pos || b.i - a.i)
                .forEach((e) => {
                    text = text.slice(0, e.pos) + e.text + text.slice(e.end);
                });
            fs.writeFileSync(sf.fileName, text);
        }
    }
    return changes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    const arg = (name: string) => {
        const i = process.argv.indexOf(name);
        return i >= 0 ? process.argv[i + 1] : undefined;
    };
    const out = arg("--out") ?? "async-codemod-report.json";
    const maxPasses = Number(arg("--passes") ?? 40);
    const converted = new Set<string>();
    const manual = new Map<string, Manual>();
    let total = 0;
    for (let pass = 1; pass <= maxPasses; pass++) {
        const started = Date.now();
        const n = onePass(converted, pass === 1, manual);
        total += n;
        console.log(`pass ${pass}: ${n} calls, ${converted.size} functions async so far (${Math.round((Date.now() - started) / 1000)} s)`);
        if (n === 0) break;
    }
    const list = [...manual.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    fs.writeFileSync(out, JSON.stringify({ total, functions: [...converted].sort(), manual: list }, null, 1));
    const byKind = new Map<string, number>();
    for (const m of list) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    console.log(`done: ${total} calls changed, ${converted.size} functions, ${list.length} places for a person`, Object.fromEntries(byKind));
}
