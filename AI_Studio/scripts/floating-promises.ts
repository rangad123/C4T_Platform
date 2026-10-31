/**
 * Finds a promise that nothing waits for, or that is used as if it were its value. While the stores go async (stages M2-M3 of
 * docs/product-restructure/POSTGRES_S3_MIGRATION.md) a missed `await` often still compiles: `if (store.allowed(id))` tests a promise,
 * which is always true, so a permission check silently passes. The compiler does not catch every such place; this does.
 *
 *   npx tsx scripts/floating-promises.ts            print every finding, exit 1 if there are any new ones
 *
 * Found:
 *   - statement   a call whose promise is dropped (`store.save(x);`). Write `await`, or `void` when it is meant to run on its own.
 *   - condition   a promise tested by if, while, ?:, !, && or ||.
 *   - compare     a promise compared with === or !==.
 *   - spread      a promise spread or indexed as if it were its value.
 *   - argument    a promise passed where the callee expects a plain value.
 *
 * tests/floating-promises-unit.test.ts runs it over src/ and compares it with the known list below, which only ever shrinks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Finding {
    file: string;
    line: number;
    kind: "statement" | "condition" | "compare" | "spread" | "argument";
    text: string;
}

const isPromiseType = (type: ts.Type) => ["Promise", "PromiseLike"].includes(type.getSymbol()?.getName() ?? "");

/**
 * Every possible value is a promise. `Promise<T> | null` is left out on purpose: a field holding "the operation in progress, if any"
 * is meant to be tested for being there (`if (this.pending)`). A promise that can only be a promise can never be false.
 */
function alwaysPromise(type: ts.Type): boolean {
    return type.isUnion() ? type.types.every(isPromiseType) : isPromiseType(type);
}

/** A call that returns a promise, at any nullability: `store.find(id)`, `a?.check()`. */
function callReturningPromise(checker: ts.TypeChecker, e: ts.Expression): boolean {
    const inner = ts.isParenthesizedExpression(e) ? e.expression : e;
    if (!ts.isCallExpression(inner)) return false;
    const type = checker.getTypeAtLocation(inner);
    return type.isUnion() ? type.types.some(isPromiseType) : isPromiseType(type);
}

/** The chain's end handles it: `x.then(...)`, `x.catch(...)`, `x.finally(...)`. */
function chained(e: ts.CallExpression): boolean {
    return ts.isPropertyAccessExpression(e.expression) && ["then", "catch", "finally"].includes(e.expression.name.text);
}

/** Ignore what is already handled: `await x`, `void x`, `x.then(...)`, `x.catch(...)`, `x.finally(...)`. */
function handled(node: ts.Expression): boolean {
    if (ts.isAwaitExpression(node) || ts.isVoidExpression(node)) return true;
    if (ts.isParenthesizedExpression(node)) return handled(node.expression);
    return false;
}

/** The compiled files of the project's tsconfig, limited to `only` (paths relative to the project root) when given. */
export function findFloatingPromises(rootDir = ROOT, only?: (rel: string) => boolean): Finding[] {
    const configPath = path.join(rootDir, "tsconfig.json");
    const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, rootDir);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
    const checker = program.getTypeChecker();
    const out: Finding[] = [];

    for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
        const rel = path.relative(rootDir, sf.fileName).split(path.sep).join("/");
        if (!rel.startsWith("src/") || (only && !only(rel))) continue;
        const add = (node: ts.Node, kind: Finding["kind"]) => {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            out.push({ file: rel, line: line + 1, kind, text: node.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
        };
        const promise = (e: ts.Expression) => !handled(e) && (callReturningPromise(checker, e) || alwaysPromise(checker.getTypeAtLocation(e)));
        const visit = (node: ts.Node): void => {
            if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && !chained(node.expression) && promise(node.expression)) add(node, "statement");
            if ((ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && promise(node.expression)) add(node.expression, "condition");
            if (ts.isConditionalExpression(node) && promise(node.condition)) add(node.condition, "condition");
            if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken && promise(node.operand)) add(node.operand, "condition");
            if (ts.isBinaryExpression(node)) {
                const op = node.operatorToken.kind;
                if ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) && promise(node.left)) add(node.left, "condition");
                if ((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) && (promise(node.left) || promise(node.right))) add(node, "compare");
            }
            if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && promise(node.expression)) add(node, "spread");
            if (ts.isCallExpression(node)) {
                const signature = checker.getResolvedSignature(node);
                node.arguments.forEach((arg, i) => {
                    if (!promise(arg) || !signature) return;
                    const param = signature.parameters[Math.min(i, signature.parameters.length - 1)];
                    if (!param) return;
                    const expected = checker.getTypeOfSymbolAtLocation(param, node);
                    // Passing a promise on purpose (Promise.all, a helper that takes one) is fine; to `unknown` or `any` it is not.
                    const flags = expected.getFlags();
                    if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
                        const callee = node.expression.getText(sf);
                        if (!/^(Promise\.|void\b|resolve$|reject$)/.test(callee)) add(arg, "argument");
                    }
                });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export const keyOf = (f: Finding) => `${f.file}|${f.kind}|${f.text}`;

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    const found = findFloatingPromises();
    for (const f of found) console.log(`${f.file}:${f.line}  ${f.kind.padEnd(9)} ${f.text}`);
    console.log(`${found.length} finding(s)`);
    process.exit(found.length > 0 ? 1 : 0);
}
