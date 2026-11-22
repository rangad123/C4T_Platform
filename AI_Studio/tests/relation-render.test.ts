/**
 * Rendering the Phase 4 steps (T11b) without a browser: a relation becomes one call to the pasted checker in web and API scripts, a
 * response wait with extract keeps its answer, a database check is refused with one sentence until the database layer exists, and
 * scripts that use none of these carry none of the new helpers.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { RELATION_HELPER_SOURCE } from "../src/engine/validation/relation.js";
import { KEPT_CALL_HELPER_SOURCE, webRequestProblems } from "../src/engine/web/checks.js";

const ctx = { baseUrl: "http://127.0.0.1:5999" };
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** The script is valid TypeScript syntax (what the test runner's transform needs before anything runs). */
const syntaxErrors = (source: string) => (ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
const spec = (kind: "web" | "api", steps: unknown[]) => TestSpecSchema.parse({ testId: kind === "web" ? "WEB-001" : "API-001", title: "Relations", kind, steps });
const relation = (expression: string, source?: string) => ({ action: "assertResponse", check: "relation", expression, ...(source ? { source } : {}) });

describe("web scripts", () => {
    const web = spec("web", [
        { action: "navigate", url: "/products/p1" },
        { action: "click", locator: { by: "role", role: "button", value: "Add to cart" } },
        { action: "wait", until: "response", value: "/api/cart/items", extract: { first: "subtotal" } },
        relation("subtotal == sum(lines[*].lineTotal)", "3.9"),
        relation("$first > 0"),
    ]);
    const out = renderScript(web, "playwright", ctx).content;

    it("the wait reads its answer the moment it arrives and keeps it; the relation is one call with the source", () => {
        expect(out).toContain('responseWaits[2] = keepAnswer(page, "/api/cart/items");');
        expect(out).toContain('last = seen as WebCall;\n        data["first"] = capture(last, "first", "subtotal");');
        expect(out).toContain('relationAssert("subtotal == sum(lines[*].lineTotal)", last?.json, data, "3.9");');
        expect(out).toContain('relationAssert("$first > 0", last?.json, data, undefined);');
        expect(count(out, RELATION_HELPER_SOURCE)).toBe(1);
        expect(count(out, KEPT_CALL_HELPER_SOURCE)).toBe(1);
        expect(count(out, "let last: WebCall")).toBe(1);
        expect(syntaxErrors(out)).toEqual([]);
    });

    it("a relation that reads the answer needs a request or a kept response before it; one over $values alone does not", () => {
        expect(webRequestProblems(spec("web", [{ action: "navigate", url: "/" }, relation("a == 1")]), ctx)).toEqual(["Step 2: a response check needs a request step, or a wait for a response that captures values, before it."]);
        expect(webRequestProblems(spec("web", [{ action: "navigate", url: "/" }, { action: "wait", until: "response", value: "/api" }, relation("a == 1")]), ctx)).toHaveLength(1);
        expect(webRequestProblems(spec("web", [{ action: "navigate", url: "/" }, relation("$a == 1")]), ctx)).toEqual([]);
        expect(() => renderScript(spec("web", [{ action: "navigate", url: "/" }, relation("$a == 1")]), "playwright", ctx)).not.toThrow();
    });

    it("scripts with plain response waits and requests carry none of the new helpers", () => {
        const plain = renderScript(
            spec("web", [
                { action: "navigate", url: "/" },
                { action: "wait", until: "response", value: "/api/cart" },
                { action: "request", method: "GET", path: "/api/cart" },
                { action: "assertResponse", check: "status", expected: 200 },
            ]),
            "playwright",
            ctx,
        ).content;
        for (const word of ["relationAssert", "keepAnswer", "RELATION_PREFIX"]) expect(plain).not.toContain(word);
        expect(plain).toContain('page.waitForResponse((r) => r.url().includes("/api/cart")).catch((e: Error) => e);');
    });
});

describe("API scripts", () => {
    it("a relation is one call against the latest answer and the test's values", () => {
        const out = renderScript(spec("api", [{ action: "request", method: "GET", path: "/api/cart" }, relation("discount == round(subtotal * 0.10)", "4.1")]), "playwright-api", ctx).content;
        expect(out).toContain('relationAssert("discount == round(subtotal * 0.10)", last?.json, data, "4.1");');
        expect(count(out, RELATION_HELPER_SOURCE)).toBe(1);
        expect(syntaxErrors(out)).toEqual([]);
        const plain = renderScript(spec("api", [{ action: "request", method: "GET", path: "/api/cart" }, { action: "assertResponse", check: "status", expected: 200 }]), "playwright-api", ctx).content;
        expect(plain).not.toContain("relationAssert");
    });
});

describe("database checks in scripts (Phase 4 T23)", () => {
    const db = (name: string) => ({ action: "assertResponse", check: "dbCheck", name });
    it("both renderers run a check named in its words through the run's check service, and refuse any other name", () => {
        for (const [kind, first, framework] of [["api", { action: "request", method: "GET", path: "/api/orders" }, "playwright-api"], ["web", { action: "navigate", url: "/" }, "playwright"]] as const) {
            expect(renderScript(spec(kind, [first, db("orphans cart_items(cartId) -> carts(id)")]), framework, ctx).content).toContain('await dbAssert("orphans cart_items(cartId) -> carts(id)"');
            expect(() => renderScript(spec(kind, [first, db("orders-have-lines")]), framework, ctx)).toThrow(/Database check refused: the check is not one of/);
        }
    });
});
