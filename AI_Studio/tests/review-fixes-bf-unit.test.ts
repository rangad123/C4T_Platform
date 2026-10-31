/**
 * Browser-free tests for the fixes that came out of the round-13 review (.scratch/review/BE-report.md), pure parts. The platform side is in
 * tests/review-fixes-bf.test.ts. Each test here failed before its fix.
 */
import { describe, expect, it } from "vitest";
import {
    BlockError,
    blockGraphProblems,
    checkBlockInput,
    expandBlocks,
    expandedStepCounts,
    indexBlocks,
    tryExpandBlocks,
    MAX_EXPANDED_CHARS,
    type BlockDef,
} from "../src/engine/blocks/index.js";
import { StepSchema, TestSpecSchema } from "../src/engine/spec/schema.js";
import { executeStep } from "../src/engine/web/interpreter.js";

const mk = (steps: unknown[]) => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", category: "c", steps, source: { origin: "manual" } });
const def = (input: unknown): BlockDef => {
    const c = checkBlockInput(input);
    if (!c.ok) throw new Error("block rejected: " + c.error);
    return c.block;
};
const fill = (value: string) => ({ action: "fill", locator: { by: "label", value: "x" }, value });
const use = (block: string, args?: Record<string, string>) => ({ action: "useBlock", block, ...(args ? { args } : {}) });

/** The review's bomb: every limit holds on its own, the three together multiply a 20 character value by about 250 000. */
const bomb = () => {
    const C = def({ name: "C", kind: "web", params: [{ name: "y", default: "a" }], steps: [fill("{{y}}".repeat(2500))] });
    const B = def({ name: "B", kind: "web", params: [{ name: "x", default: "a" }], steps: [use("C", { y: "{{x}}".repeat(100) })] });
    const A = def({ name: "A", kind: "web", params: [{ name: "p", default: "a" }], steps: [use("B", { x: "{{p}}".repeat(100) })] });
    return { A, B, C, index: indexBlocks([A, B, C]) };
};

describe("H1: reusable steps can't grow past a budget", () => {
    it("expansion of the review's bomb stops fast with a plain error, not a RangeError or a 1 GB string", () => {
        const { index } = bomb();
        const t = Date.now();
        const heapBefore = process.memoryUsage().heapUsed;
        let error: unknown;
        try {
            expandBlocks(mk([use("A", { p: "z".repeat(20) })]), index);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(BlockError);
        expect((error as BlockError).reason).toBe("size");
        expect((error as BlockError).message).toMatch(/more than 400 KB of step text/);
        expect(Date.now() - t).toBeLessThan(1000);
        // The old code held about a gigabyte at this point; the budget keeps it to a few megabytes.
        expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150_000_000);
    });

    it("tryExpandBlocks reports it as a result (never throws), also for 500 character values", () => {
        const { index } = bomb();
        const r = tryExpandBlocks(mk([use("A", { p: "z".repeat(500) })]), index);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/KB of step text/);
    });

    it("the graph check refuses the bomb at save time (the default values are tiny, so a render of the defaults would pass)", () => {
        const { index } = bomb();
        const problems = blockGraphProblems(index);
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.join(" ")).toMatch(/grow too large when they are given long values/);
        expect(problems[0]).toMatch(/“[ABC]”/);
    });

    it("a chain that is individually fine but multiplies a value is refused when it is saved, naming the first block that grows", () => {
        const C = def({ name: "C", kind: "web", params: [{ name: "y", default: "a" }], steps: [fill("{{y}}".repeat(40))] });
        const B = def({ name: "B", kind: "web", params: [{ name: "x", default: "a" }], steps: [use("C", { y: "{{x}}".repeat(100) })] });
        expect(blockGraphProblems(indexBlocks([C]))).toEqual([]);
        const problems = blockGraphProblems(indexBlocks([C, B]));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/“B”/);
    });

    it("the step count is worked out from the graph before anything is built, and saturates", () => {
        const L = def({ name: "L", kind: "web", params: [], steps: Array.from({ length: 40 }, () => ({ action: "wait", ms: 1 })) });
        const M = def({ name: "M", kind: "web", params: [], steps: Array.from({ length: 40 }, () => use("L")) });
        const N = def({ name: "N", kind: "web", params: [], steps: Array.from({ length: 40 }, () => use("M")) });
        const index = indexBlocks([L, M, N]);
        const counts = expandedStepCounts(index);
        expect(counts.get("L")).toBe(40);
        expect(counts.get("M")).toBe(101); // 1600 steps, saturated one above the cap
        expect(counts.get("N")).toBe(101);
        const problems = blockGraphProblems(index);
        expect(problems.some((p) => /“M”.*more than 100 steps/.test(p))).toBe(true);
        expect(problems.some((p) => /“N”.*more than 100 steps/.test(p))).toBe(true);
        expect(problems.some((p) => /“L”/.test(p))).toBe(false);
    });

    it("a circle is still reported as a circle (size is judged only when the shape is right)", () => {
        const A = def({ name: "A", kind: "web", params: [], steps: [use("B")] });
        const B = def({ name: "B", kind: "web", params: [], steps: [use("A")] });
        const problems = blockGraphProblems(indexBlocks([A, B]));
        expect(problems.length).toBeGreaterThan(0);
        expect(problems.every((p) => /circle/.test(p))).toBe(true);
    });

    it("ordinary blocks are untouched: values passed on and joined, long but sensible text, the old step cap", () => {
        const Inner = def({ name: "Inner", kind: "web", params: [{ name: "url" }, { name: "who", default: "Ada" }], steps: [{ action: "navigate", url: "{{url}}" }, fill("hello {{who}}")] });
        const Outer = def({ name: "Outer", kind: "web", params: [{ name: "base" }, { name: "path" }], steps: [use("Inner", { url: "{{base}}/{{path}}" })] });
        const index = indexBlocks([Inner, Outer]);
        expect(blockGraphProblems(index)).toEqual([]);
        const out = expandBlocks(mk([use("Outer", { base: "https://app.example", path: "login" })]), index);
        expect(out.steps).toHaveLength(2);
        expect((out.steps[0] as { url: string }).url).toBe("https://app.example/login");
        // 101 leaf steps are still refused by the old cap, with the same words
        const many = def({ name: "Many", kind: "web", params: [], steps: Array.from({ length: 40 }, () => ({ action: "wait", ms: 1 })) });
        const r = tryExpandBlocks(mk([use("Many"), use("Many"), use("Many")]), indexBlocks([many]));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/more than 100 steps/);
        expect(MAX_EXPANDED_CHARS).toBe(400_000);
    });

    it("a hostile stored set that skipped the save checks still fails one test quickly, 100 times in a row", () => {
        const { index } = bomb();
        const spec = mk([use("A", { p: "z".repeat(500) })]);
        const t = Date.now();
        for (let i = 0; i < 100; i++) expect(tryExpandBlocks(spec, index).ok).toBe(false);
        expect(Date.now() - t).toBeLessThan(5000);
    });
});

describe("L5: a parameter named like a built-in member gets its own value or default, never function text", () => {
    it("constructor, toString and __proto__ with empty or unrelated arguments", () => {
        const P = def({
            name: "P",
            kind: "web",
            params: [{ name: "constructor", default: "c0" }, { name: "toString", default: "dflt" }, { name: "__proto__", default: "pp" }],
            steps: [fill("[{{constructor}}][{{toString}}][{{__proto__}}]")],
        });
        const index = indexBlocks([P]);
        for (const args of [{}, undefined]) {
            const r = tryExpandBlocks(mk([use("P", args)]), index);
            expect(r.ok).toBe(true);
            if (r.ok) expect((r.spec.steps[0] as { value: string }).value).toBe("[c0][dflt][pp]");
        }
        const given = tryExpandBlocks(mk([use("P", { toString: "mine" })]), index);
        expect(given.ok && (given.spec.steps[0] as { value: string }).value).toBe("[c0][mine][pp]");
    });

    it("without a default it asks for a value instead of using a function", () => {
        const P = def({ name: "P", kind: "web", params: [{ name: "constructor" }], steps: [fill("{{constructor}}")] });
        const r = tryExpandBlocks(mk([use("P", {})]), indexBlocks([P]));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/need a value for “constructor”/);
    });
});

describe("L9: the web interpreter refuses a reusable-steps step instead of ignoring it", () => {
    it("throws a plain error, so a test with an unexpanded step can never pass by doing nothing", async () => {
        const step = StepSchema.parse({ action: "useBlock", block: "Sign in" });
        const page = {} as never; // never touched: the step is refused before any page work
        await expect(executeStep(page, step, {}, "http://127.0.0.1:1")).rejects.toThrow(/reusable steps “Sign in” were not put in place/);
    });
});
