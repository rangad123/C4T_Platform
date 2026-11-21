/**
 * Relation checks (Phase 4 C5, T11a): the grammar, the expression table from the bench shop's requirements 3.9, 4.1 and 4.5, failure
 * messages, and fast-check properties showing that nothing outside the grammar is accepted and that no input ever runs as code.
 * Expected values come from the requirements text (amounts in cents, 2.7), never from a run of the shop.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkRelation, parseRelation, RELATION_FAILURE_PREFIX, RELATION_HELPER_SOURCE } from "../src/engine/validation/relation.js";
import { StepSchema } from "../src/engine/spec/schema.js";

const held = (expr: string, body: unknown, vars: Record<string, unknown> = {}) => checkRelation(expr, { body, vars }).held;

// Carts written from the requirements: 3.8 line total = unit price × quantity, 3.9 subtotal = sum of line totals, 4.1 SAVE10 = 10% of
// the subtotal rounded to the cent, 4.4 shipping $5.00, 4.5 free from $50.00 after the discount, 3.10 total = subtotal − discount + shipping.
const line = (unitPrice: number, quantity: number) => ({ productId: `p${unitPrice}`, name: "Item", unitPrice, quantity, lineTotal: unitPrice * quantity });
const cart = (lines: ReturnType<typeof line>[], code: string | null, over: Record<string, number> = {}) => {
    const subtotal = lines.reduce((t, l) => t + l.lineTotal, 0);
    const discount = code ? Math.round(subtotal * 0.1) : 0;
    const shipping = lines.length === 0 || subtotal - discount >= 5000 ? 0 : 500;
    const c = { lines, subtotal, code, discount, shipping, total: subtotal - discount + shipping, ...over };
    return c;
};

const REQ_3_9 = "subtotal == sum(lines[*].lineTotal)";
const REQ_4_1 = "discount == round(subtotal * 0.10)";
const REQ_4_1_CODE = 'code == null or discount == round(subtotal * 0.10)';
const REQ_4_5 = "(subtotal - discount >= 5000) implies shipping == 0";

describe("the expression table (requirements 3.9, 4.1, 4.5)", () => {
    const twoLines = [line(2000, 2), line(1500, 3)]; // 4000 + 4500 = 8500
    const rows: Array<{ req: string; expr: string; case: string; body: unknown; held: boolean }> = [
        { req: "3.9", expr: REQ_3_9, case: "clean, two lines", body: cart(twoLines, null), held: true },
        { req: "3.9", expr: REQ_3_9, case: "empty cart", body: cart([], null), held: true },
        // BS-02: the subtotal counts the last line's quantity as 1 (4000 + 1500).
        { req: "3.9", expr: REQ_3_9, case: "BS-02 last quantity dropped", body: cart(twoLines, null, { subtotal: 5500 }), held: false },
        { req: "4.1", expr: REQ_4_1, case: "clean, SAVE10", body: cart(twoLines, "SAVE10"), held: true },
        { req: "4.1", expr: REQ_4_1, case: "rounds to the cent (1234 → 123)", body: cart([line(1234, 1)], "SAVE10"), held: true },
        // BS-01: the discount is taken off the first line only (10% of 4000).
        { req: "4.1", expr: REQ_4_1, case: "BS-01 first line only", body: cart(twoLines, "SAVE10", { discount: 400 }), held: false },
        { req: "4.1", expr: REQ_4_1_CODE, case: "no code applied", body: cart(twoLines, null), held: true },
        { req: "4.1", expr: REQ_4_1_CODE, case: "BS-01 with the code", body: cart(twoLines, "SAVE10", { discount: 400 }), held: false },
        { req: "4.5", expr: REQ_4_5, case: "exactly $50.00", body: cart([line(2500, 2)], null), held: true },
        { req: "4.5", expr: REQ_4_5, case: "$49.99 pays shipping", body: cart([line(4999, 1)], null), held: true },
        { req: "4.5", expr: REQ_4_5, case: "$55.00 less SAVE10 is $49.50", body: cart([line(5500, 1)], "SAVE10"), held: true },
        // BS-11: $5 is charged at exactly $50.00.
        { req: "4.5", expr: REQ_4_5, case: "BS-11 charged at exactly $50.00", body: cart([line(2500, 2)], null, { shipping: 500 }), held: false },
    ];
    for (const r of rows) {
        it(`${r.req} ${r.case}: ${r.held ? "holds" : "fails"}`, () => {
            expect(parseRelation(r.expr).ok).toBe(true);
            expect(held(r.expr, r.body)).toBe(r.held);
        });
    }
    it("the clean carts follow 3.10 too", () => {
        for (const r of rows.filter((x) => x.held)) expect(held("total == subtotal - discount + shipping", r.body)).toBe(true);
    });
});

describe("the grammar", () => {
    const body = { a: 5, b: 2, s: "Mug x2", items: [{ id: 7, tags: ["x", "y"], price: 150 }, { id: 9, tags: ["z"], price: 250 }], nested: { deep: { v: 1.5 } }, n: null, t: true };
    const cases: Array<[string, boolean, Record<string, unknown>?]> = [
        ["a == 5", true],
        ["a != 5", false],
        ["a + b == 7 and a - b == 3 and a * b == 10 and a / b == 2.5", true],
        ["-a == 0 - 5", true],
        ["a > b and b < a and a >= 5 and a <= 5", true],
        ['s == "Mug x2"', true],
        ['contains(s, "x2")', true],
        ['contains(items[*].tags[*], "z")', true],
        ["contains(items[*].id, 8)", false],
        ["items[1].id == 9", true],
        ["count(items) == 2 and count(items[*].tags[*]) == 3", true],
        ["sum(items[*].price) == 400", true],
        ["round(nested.deep.v) == 2 and round(2.345, 2) == 2.35", true],
        ["n == null and t == true and t != false", true],
        ["false or a == 5", true],
        ["a == 4 implies b == 99", true],
        ["a == 5 implies b == 99", false],
        ["$qty * 150 == items[0].price * 2", true, { qty: "2" }],
        ['$who == "ada"', true, { who: "ada" }],
        ["$cart.lines[0].lineTotal == 300", true, { cart: JSON.stringify({ lines: [{ lineTotal: 300 }] }) }],
        ["[0].id == 7", true],
    ];
    for (const [expr, want, vars] of cases) {
        it(`${expr} → ${want}`, () => {
            const top = expr.startsWith("[") ? body.items : body;
            const r = checkRelation(expr, { body: top, vars });
            expect(r.held, r.held ? "" : r.message).toBe(want);
        });
    }
    it("lists the paths and $values an expression reads", () => {
        expect(parseRelation("subtotal == sum(lines[*].lineTotal) and $qty > 0 and lines[0].id != $qty")).toEqual({ ok: true, refs: { paths: ["subtotal", "lines[*].lineTotal", "lines[0].id"], vars: ["qty"] } });
    });
});

describe("refusals", () => {
    const refused = [
        "",
        "   ",
        "process.exit(1)",
        'constructor.constructor("return process")()',
        'eval("1")',
        "a = 1",
        "a; b",
        "`x`",
        "a == 1 == 1",
        "a implies b implies c",
        "a[-1] == 1",
        "a[x] == 1",
        "round(1, 2, 3)",
        "count()",
        "$ == 1",
        "$1a == 1",
        '"unclosed',
        '"bad \\n escape" == 1',
        "a.b.c.d.e.f.g.h.i.j.k.l.m.n == 1",
        "x".repeat(301),
        `${"(".repeat(21)}1${")".repeat(21)} == 1`,
        Array.from({ length: 61 }, () => "1").join("+"),
        "a == 1 and",
        "and a == 1",
    ];
    for (const text of refused) {
        it(`refuses ${JSON.stringify(text.length > 40 ? text.slice(0, 40) + "…" : text)}`, () => {
            const r = parseRelation(text);
            expect(r.ok).toBe(false);
            const step = StepSchema.safeParse({ action: "assertResponse", check: "relation", expression: text });
            expect(step.success).toBe(false);
        });
    }
    it("reads own data only: __proto__ and constructor are never reached through the prototype", () => {
        expect(held("constructor == null", {})).toBe(false);
        expect(checkRelation("__proto__.x == 1", { body: {} })).toMatchObject({ held: false, message: expect.stringContaining("no value at __proto__.x") });
        expect(checkRelation("count(constructor) == 1", { body: [] })).toMatchObject({ held: false });
        // a key that came in as data is data
        expect(held("__proto__.x == 1", JSON.parse('{"__proto__":{"x":1}}'))).toBe(true);
    });
    it("a step with a relation inside the grammar passes the schema", () => {
        expect(StepSchema.safeParse({ action: "assertResponse", check: "relation", expression: REQ_4_5, source: "4.5" }).success).toBe(true);
        expect(StepSchema.safeParse({ action: "wait", until: "response", value: "/api/cart", extract: { subtotal: "subtotal" } }).success).toBe(true);
        expect(StepSchema.safeParse({ action: "assertResponse", check: "dbCheck", name: "orders-have-lines" }).success).toBe(true);
    });
});

describe("failure messages name the expression, its values and the source", () => {
    it("a relation that does not hold", () => {
        const r = checkRelation(REQ_4_1, { body: cart([line(2000, 2), line(1500, 3)], "SAVE10", { discount: 400 }) }, "requirement 4.1");
        expect(r.held).toBe(false);
        if (r.held) return;
        expect(r.message).toBe(`${RELATION_FAILURE_PREFIX} (requirement 4.1): discount == round(subtotal * 0.10). Values: discount = 400, subtotal = 8500, subtotal * 0.10 = 850, round(subtotal * 0.10) = 850.`);
    });
    it("a missing field, a wrong type and a non-boolean result", () => {
        expect(checkRelation("subtotal == sum(lines[*].lineTotal)", { body: { subtotal: 1, lines: [{ lineTotal: 1 }, {}] } }, "3.9")).toMatchObject({ message: expect.stringMatching(/^Relation check failed \(3\.9\): subtotal == sum\(lines\[\*\]\.lineTotal\)\. no value at lines\[\*\]\.lineTotal\.( Values: subtotal = 1\.)?$/) });
        expect(checkRelation("a + 1 == 2", { body: { a: "x" } })).toMatchObject({ message: 'Relation check failed: a + 1 == 2. a is not a number (it is "x"). Values: a = "x".' });
        expect(checkRelation("a + 1", { body: { a: 1 } })).toMatchObject({ message: "Relation check failed: a + 1. It must give true or false, but gave 2. Values: a = 1, a + 1 = 2." });
        expect(checkRelation("$gone == 1", { body: {} })).toMatchObject({ message: "Relation check failed: $gone == 1. the test has no value $gone." });
        expect(checkRelation("a / b == 1", { body: { a: 1, b: 0 } })).toMatchObject({ held: false, message: expect.stringContaining("b is 0") });
    });
    it("a refused expression says why", () => {
        expect(checkRelation("a = 1", { body: {} })).toMatchObject({ held: false, message: expect.stringContaining("not part of the grammar") });
    });
});

// ── properties ─────────────────────────────────────────────────────────────

/** Bits of the grammar and of JavaScript: random mixtures reach deep into the parser and try code that must never run. */
const FRAGMENTS = ["a", "b", "lines", "[*]", "[0]", "[", "]", ".", "x", "$v", "$", "1", "2.5", "-", "+", "*", "/", "==", "!=", "<", "<=", ">", ">=", "(", ")", ",", "and", "or", "implies", "true", "false", "null", "round", "sum", "count", "contains", '"t"', '"', "\\", "__proto__", "constructor", "prototype", "globalThis", "process", "eval", "Function", "=", ";", "=>", "`", "${", "}", "{", "new", "this", "require", "import", "globalThis.__relationPwned = 1"];
const soup = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 }).chain((parts) => fc.constantFrom(parts.join(" "), parts.join("")));
const anyText = fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: "binary", maxLength: 400 }), soup);

/** Expressions inside the grammar, built from its rules (each path reads a key that may or may not be in the body). */
const valid = fc.letrec<{ value: string; cond: string; expr: string }>((tie) => ({
    value: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.integer({ min: -1000, max: 1000 }).map(String),
        fc.constantFrom("a", "b", "items[*].p", "items[0].p", "$v", "nested.k", '"t"', "null", "true"),
        fc.tuple(tie("value"), fc.constantFrom("+", "-", "*", "/"), tie("value")).map(([l, op, r]) => `(${l} ${op} ${r})`),
        tie("value").map((x) => `round(${x})`),
        fc.constantFrom("sum(items[*].p)", "count(items)", 'contains(items[*].p, 2)', 'contains("abc", "b")'),
    ),
    cond: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.tuple(tie("value"), fc.constantFrom("==", "!=", "<", "<=", ">", ">="), tie("value")).map(([l, op, r]) => `${l} ${op} ${r}`),
        fc.tuple(tie("cond"), fc.constantFrom("and", "or"), tie("cond")).map(([l, op, r]) => `(${l}) ${op} (${r})`),
    ),
    expr: fc.oneof(tie("cond"), fc.tuple(tie("cond"), tie("cond")).map(([l, r]) => `(${l}) implies (${r})`)),
})).expr;

const sampleBody = { a: 3, b: 0, items: [{ p: 2 }, { p: 5 }], nested: { k: "t" } };

describe("properties (fast-check)", () => {
    it("random input never executes: no throw, only a verdict, and no side effect reaches the process", () => {
        const g = globalThis as Record<string, unknown>;
        const realEval = g.eval;
        let evalCalls = 0;
        g.eval = (...args: unknown[]) => {
            evalCalls++;
            return (realEval as (...a: unknown[]) => unknown)(...args);
        };
        try {
            fc.assert(
                fc.property(anyText, (text) => {
                    const p = parseRelation(text);
                    expect(typeof p.ok).toBe("boolean");
                    if (!p.ok) expect(typeof p.error).toBe("string");
                    const r = checkRelation(text, { body: sampleBody, vars: { v: "1" } });
                    expect(typeof r.held).toBe("boolean");
                    // everything it reports is plain data
                    expect(() => JSON.stringify(r)).not.toThrow();
                    expect(g.__relationPwned).toBeUndefined();
                }),
                { numRuns: 3000, seed: 1121 },
            );
        } finally {
            g.eval = realEval;
        }
        expect(evalCalls).toBe(0);
    });

    it("the checker's own text has no way to run code", () => {
        for (const word of ["eval", "Function", "constructor", "require", "import", "process", "globalThis", "this", "setTimeout", "__proto__", "prototype."]) {
            expect(RELATION_HELPER_SOURCE.replace("Object.prototype.hasOwnProperty.call", ""), word).not.toContain(word);
        }
    });

    it("anything the parser refuses, the step schema refuses; anything it accepts (within 300 characters), the schema accepts", () => {
        fc.assert(
            fc.property(fc.oneof(anyText, valid), (text) => {
                const ok = parseRelation(text).ok;
                expect(StepSchema.safeParse({ action: "assertResponse", check: "relation", expression: text }).success).toBe(ok && text.length >= 1);
            }),
            { numRuns: 1500, seed: 2111 },
        );
    });

    it("every expression longer than 300 characters is refused", () => {
        fc.assert(
            fc.property(fc.string({ minLength: 301, maxLength: 2000 }), (text) => {
                expect(parseRelation(text).ok).toBe(false);
            }),
            { numRuns: 300, seed: 3 },
        );
    });

    it("expressions built from the grammar parse, and judge to a verdict without throwing", () => {
        fc.assert(
            fc.property(valid, (text) => {
                // short enough to stay under the token (120) and nesting (20) caps
                fc.pre(text.length <= 120);
                expect(parseRelation(text)).toMatchObject({ ok: true });
                const r = checkRelation(text, { body: sampleBody, vars: { v: "4" } }, "src");
                expect(typeof r.held).toBe("boolean");
                if (!r.held) expect(r.message.startsWith(`${RELATION_FAILURE_PREFIX} (src): `)).toBe(true);
            }),
            { numRuns: 1500, seed: 4242 },
        );
    });
});
