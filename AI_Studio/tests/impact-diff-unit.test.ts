/**
 * Changed lines and changed functions of a pull request's files (src/engine/impact/diff.ts). Pure: patches and sources are strings here.
 * Expected values come from reading the patches and sources by hand.
 */
import { describe, expect, it } from "vitest";
import { analyzeFile, headerFunction, parsePatch, scanJs, symbolsOf } from "../src/engine/impact/diff.js";

describe("reading a patch", () => {
    it("numbers added lines on the new side and removed lines on the old side, over several hunks", () => {
        const patch = ["@@ -10,4 +10,5 @@ function priced(cart) {", " a", "-b", "+B", "+B2", " c", "@@ -40,2 +41,1 @@", "-x", " y", "\\ No newline at end of file"].join("\n");
        const p = parsePatch(patch);
        expect(p.hunks).toEqual([
            { oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, header: "function priced(cart) {" },
            { oldStart: 40, oldLines: 2, newStart: 41, newLines: 1, header: "" },
        ]);
        expect(p.added).toEqual([11, 12]);
        expect(p.removed).toEqual([11, 40]);
        // b was removed before new line 11 (where B now is); x before new line 41 (y)
        expect(p.removedAt).toEqual([11, 41]);
    });

    it("reads hunks without a line count, and a whole new file", () => {
        expect(parsePatch("@@ -1 +1 @@\n-a\n+b")).toMatchObject({ added: [1], removed: [1] });
        expect(parsePatch("@@ -0,0 +1,2 @@\n+one\n+two")).toMatchObject({ added: [1, 2], removed: [], removedAt: [] });
        expect(parsePatch("--- a/x.ts\n+++ b/x.ts\n@@ -3,1 +3,1 @@\n-a\n+b").added).toEqual([3]);
    });

    it("finds the function name in a hunk header, or none", () => {
        expect(headerFunction("function priced(cart) {")).toBe("priced");
        expect(headerFunction("async function api(req, res, url, user) {")).toBe("api");
        expect(headerFunction("const canRead = (u, n) =>")).toBe("canRead");
        expect(headerFunction("    async createIssue(draft: IssueDraft): Promise<CreatedIssue> {")).toBe("createIssue");
        expect(headerFunction("def place_order(cart):")).toBe("place_order");
        expect(headerFunction("class Cart:")).toBe("Cart");
        expect(headerFunction("")).toBeUndefined();
        expect(headerFunction("    if (x) {")).toBeUndefined();
    });
});

describe("the JS scan", () => {
    it("blanks strings, templates, comments and regular expressions, so their brackets do not count", () => {
        const src = 'const a = "{(" + `x ${b ? "}" : `}`} y`; // }\nconst re = /[}{]\\//g; /* { */ f(a / 2, 3);';
        const { code, pair } = scanJs(src);
        expect(code.length).toBe(src.length);
        expect(code).not.toMatch(/\{\(/);
        expect(code).toContain("f(a / 2, 3)"); // a division stays code
        const open = code.lastIndexOf("f(") + 1;
        expect(code[pair[open]!]).toBe(")");
        expect(code.split("\n")).toHaveLength(2);
    });
});

const JS = `import x from "./x.js";
export function priced(cart) {
    const lines = cart.lines.map((l) => {
        return l.price * l.quantity;
    });
    return lines;
}
const canRead = (u, n) => n.ownerId === u.id || u.role === "admin";
const NAV = (user) =>
    \`<header>\${user ? "in" : "out"}</header>\`;
export class CartService {
    private total(items: Array<{ price: number }>): number {
        return items.reduce((s, i) => s + i.price, 0);
    }
    async checkout(): Promise<{ ok: boolean }> {
        return { ok: true };
    }
}
const handler = async function named(req) {
    return 1;
};
`;

describe("functions in a source file", () => {
    it("finds functions, arrows, classes and methods with their lines", () => {
        const s = symbolsOf("cart.ts", JS).map(({ name, kind, start, end, exported }) => ({ name, kind, start, end, ...(exported ? { exported } : {}) }));
        expect(s).toEqual(
            expect.arrayContaining([
                { name: "priced", kind: "function", start: 2, end: 7, exported: true },
                { name: "canRead", kind: "function", start: 8, end: 8 },
                { name: "NAV", kind: "function", start: 9, end: 10 },
                { name: "CartService", kind: "class", start: 11, end: 18, exported: true },
                { name: "total", kind: "method", start: 12, end: 14 },
                { name: "checkout", kind: "method", start: 15, end: 17 },
                { name: "handler", kind: "function", start: 19, end: 21 },
            ]),
        );
        // calls and control flow are not functions
        expect(s.map((x) => x.name)).not.toContain("map");
        expect(s.map((x) => x.name)).not.toContain("reduce");
    });

    it("reads Python by indentation", () => {
        const py = "class Cart:\n    def total(self):\n        return 1\n\n    # note\n    def add(self, x):\n        pass\n\ndef place_order(cart):\n    return cart\n";
        expect(symbolsOf("cart.py", py).map(({ name, kind, start, end }) => ({ name, kind, start, end }))).toEqual([
            { name: "Cart", kind: "class", start: 1, end: 7 },
            { name: "total", kind: "method", start: 2, end: 3 },
            { name: "add", kind: "method", start: 6, end: 7 },
            { name: "place_order", kind: "function", start: 9, end: 10 },
        ]);
    });

    it("knows nothing of other languages", () => {
        expect(symbolsOf("main.go", "func main() {}\n")).toEqual([]);
    });
});

describe("a changed file", () => {
    it("names the innermost function around each changed line when the source is at hand", () => {
        const patch = "@@ -3,3 +3,3 @@ export function priced(cart) {\n     const lines = cart.lines.map((l) => {\n-        return l.price;\n+        return l.price * l.quantity;\n     });\n@@ -13,1 +13,1 @@\n-        return 0;\n+        return items.reduce((s, i) => s + i.price, 0);";
        const f = analyzeFile({ path: "cart.ts", patch }, JS);
        expect(f.touched).toEqual([4, 13]);
        expect(f.functions).toEqual([
            { name: "priced", evidence: "enclosing", lines: [4], start: 2, end: 7 },
            { name: "total", evidence: "enclosing", lines: [13], start: 12, end: 14 },
        ]);
    });

    it("places a pure removal in the function it was removed from", () => {
        const f = analyzeFile({ path: "cart.ts", patch: "@@ -16,2 +16,1 @@\n-        log();\n         return { ok: true };" }, JS);
        expect(f.added).toEqual([]);
        expect(f.functions.map((x) => x.name)).toEqual(["checkout"]);
    });

    it("a change outside every function names none", () => {
        expect(analyzeFile({ path: "cart.ts", patch: "@@ -1,1 +1,1 @@\n-import y from './y.js';\n+import x from \"./x.js\";" }, JS).functions).toEqual([]);
    });

    it("without the source, falls back to the hunk header and says so", () => {
        const f = analyzeFile({ path: "cart.ts", patch: "@@ -3,1 +3,1 @@ export function priced(cart) {\n-a\n+b\n@@ -40,1 +40,1 @@\n-c\n+d" });
        expect(f.functions).toEqual([{ name: "priced", evidence: "hunk-header", lines: [3] }]);
        // other languages too
        expect(analyzeFile({ path: "main.go", patch: "@@ -9,1 +9,1 @@ func main() {\n-a\n+b" }, "package main\n").functions).toEqual([]);
    });

    it("a file without a patch (binary, too large) says the lines are not known", () => {
        const f = analyzeFile({ path: "logo.png", status: "added" });
        expect(f.touched).toEqual([]);
        expect(f.note).toMatch(/not known/);
    });
});
