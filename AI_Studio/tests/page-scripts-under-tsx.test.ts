/**
 * The engine's page-side scripts work when the engine is loaded through tsx, as the platform (`npm start`) and the runner's task process
 * load it. tsx keeps function names: a helper declared inside a function that runs in the page becomes a `__name(...)` call, and the page
 * has no `__name`, so the script throws there. The test runner does not keep names, so a test calling the same code in-process passes.
 *
 * 1. The probe (tests/fixtures/page-scripts-probe.ts) runs in a tsx child process:
 *    - the picture cover (frames/shoot.ts) covers a password field and a picture is taken (Watch live, finding screenshots);
 *    - the discovery crawl reads the elements inside a page's frames (web/frame-elements.ts: a payment form, an embedded widget);
 *    - the element identity the exploration keys actions by (web/author.ts targetIdentity) resolves, so a repeat is found by the element.
 * 2. Every function the engine sends to a page (evaluate, evaluateAll, evaluateHandle, addInitScript, $eval, $$eval, waitForFunction),
 *    compiled the way tsx compiles it, has no `__name(...)` inside, so a new helper in page-side code is caught without a browser.
 *
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/page-scripts-under-tsx.test.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transformSync } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TSX = path.resolve("node_modules/.bin/tsx");
const PAGE_METHODS = new Set(["evaluate", "evaluateAll", "evaluateHandle", "addInitScript", "$eval", "$$eval", "waitForFunction"]);

/** Each page-side function in `file` that would call `__name` in the page once compiled with keepNames, as "file method: helper, ...". */
function namedHelpersInPageCode(file: string): string[] {
    const src = fs.readFileSync(file, "utf8");
    if (!/evaluate|addInitScript|\$\$?eval|waitForFunction/.test(src)) return [];
    const code = transformSync(src, { loader: file.endsWith(".tsx") ? "tsx" : "ts", keepNames: true, format: "esm", target: "es2022" }).code;
    const sf = ts.createSourceFile("out.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declared = new Map<string, ts.Node>();
    const collect = (n: ts.Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name) declared.set(n.name.text, n);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declared.set(n.name.text, n.initializer);
        ts.forEachChild(n, collect);
    };
    collect(sf);
    const unwrap = (n: ts.Node): ts.Node => (ts.isCallExpression(n) && n.expression.getText(sf) === "__name" ? n.arguments[0]! : n);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PAGE_METHODS.has(n.expression.name.text)) {
            for (const arg of n.arguments) {
                const a = unwrap(arg);
                const body = ts.isArrowFunction(a) || ts.isFunctionExpression(a) ? a : ts.isIdentifier(a) ? declared.get(a.text) : undefined;
                const text = body ? unwrap(body).getText(sf) : "";
                if (text.includes("__name(")) {
                    const helpers = [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*__name\(|__name\((\w+),\s*"/g)].map((m) => m[1] ?? m[2]).join(", ");
                    found.push(`${file} ${n.expression.name.text}: ${helpers || "?"}`);
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [path.join(dir, e.name)] : []));

describe("page-side scripts loaded through tsx", () => {
    it("cover secret fields, take the picture, read the elements inside frames and resolve an element's identity", () => {
        const out = execFileSync(TSX, ["tests/fixtures/page-scripts-probe.ts"], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
        const line = out.split("\n").find((l) => l.startsWith("PROBE "));
        expect(line, out).toBeDefined();
        const probe = JSON.parse(line!.slice("PROBE ".length)) as { cover: string; covered: number; picture: boolean; frameElements: string[]; identity: string | null };
        expect(probe.cover).toBe("ok");
        expect(probe.covered).toBe(1);
        expect(probe.picture).toBe(true);
        expect(probe.frameElements).toEqual(["button Pay now in name=payment", "link Terms in name=payment"]);
        expect(probe.identity).toMatch(/^button "Order" @[0-9a-f]{12}$/);
    }, 150_000);

    it("no function sent to a page declares a named helper once compiled the way tsx compiles it", () => {
        const found = sourceFiles("src").flatMap(namedHelpersInPageCode);
        expect(found).toEqual([]);
    });

    it("the check finds a named helper inside page-side code", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "page-scripts-"));
        try {
            const file = path.join(dir, "sample.ts");
            fs.writeFileSync(file, `export const f = (page: any) => page.evaluate(() => { const helper = (x: number) => x + 1; return helper(1); });\n`);
            expect(namedHelpersInPageCode(file)).toEqual([`${file} evaluate: helper`]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
