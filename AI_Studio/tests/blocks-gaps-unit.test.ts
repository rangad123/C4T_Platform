/**
 * Browser-free checks of the pure parts of tests/blocks-gaps.test.ts: which shared elements a test reaches through reusable steps, and
 * which sets hold which element. (The platform side is in blocks-gaps.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { blocksHoldingElements, elementUsageThroughBlocks, indexBlocks, type BlockDef } from "../src/engine/blocks/index.js";
import { TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";

const web = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", steps });
const use = (block: string) => ({ action: "useBlock", block });
const click = (ref: string) => ({ action: "click", locator: { ref } });
const def = (name: string, steps: unknown[]): BlockDef => ({ name, kind: "web", params: [], steps: steps as Step[] });

describe("which sets hold which element", () => {
    it("lists, per element, the sets whose own steps refer to it, sorted by name", () => {
        const held = blocksHoldingElements([def("B", [click("Pay")]), def("A", [click("Pay"), click("Total")]), def("C", [use("A")])]);
        expect([...held.entries()]).toEqual([["Pay", ["A", "B"]], ["Total", ["A"]]]);
    });
    it("is empty when no set refers to an element", () => {
        expect(blocksHoldingElements([def("A", [{ action: "wait", ms: 10 }])]).size).toBe(0);
    });
});

describe("elements a test reaches through reusable steps", () => {
    const blocks = [def("Pay", [click("Pay button"), click("Pay button")]), def("Outer", [use("Pay")]), def("Plain", [{ action: "wait", ms: 10 }])];

    it("counts the steps that reach the element and names the set that holds it, also through another set", () => {
        const direct = web([use("Pay")]);
        const nested = web([use("Outer")]);
        const none = web([use("Plain")]);
        const r = elementUsageThroughBlocks([{ id: "t1", spec: direct }, { id: "t2", spec: nested }, { id: "t3", spec: none }], blocks);
        const pay = r.get("Pay button")!;
        expect(pay.get("t1")).toEqual({ steps: 2, blocks: ["Pay"] });
        // the outer set does not hold the element itself; the set it uses does
        expect(pay.get("t2")).toEqual({ steps: 2, blocks: ["Pay"] });
        expect(pay.has("t3")).toBe(false);
    });

    it("does not count the steps a test spells out itself", () => {
        const both = web([click("Pay button"), use("Pay")]);
        const r = elementUsageThroughBlocks([{ id: "t", spec: both }], blocks);
        expect(r.get("Pay button")!.get("t")).toEqual({ steps: 2, blocks: ["Pay"] });
        const own = web([click("Pay button")]);
        expect(elementUsageThroughBlocks([{ id: "t", spec: own }], blocks).size).toBe(0);
    });

    it("skips tests whose sets cannot be put in place (they are refused elsewhere) and does nothing without sets", () => {
        const missing = web([use("Gone")]);
        expect(elementUsageThroughBlocks([{ id: "t", spec: missing }], blocks).size).toBe(0);
        expect(elementUsageThroughBlocks([{ id: "t", spec: web([use("Pay")]) }], []).size).toBe(0);
        expect(indexBlocks(blocks).size).toBe(3);
    });
});
