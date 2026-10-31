/** The step-level difference behind the builder's version history: pure, no browser, no server. */
import { describe, expect, it } from "vitest";
import { changedFields, diffSteps, summarise, type Snapshot } from "../web/src/features/builder/stepdiff.js";

const nav = { action: "navigate", url: "/products" };
const fill = (value: string) => ({ action: "fill", locator: { by: "label", value: "Search" }, value });
const click = { action: "click", locator: { by: "role", role: "button", value: "Search" } };
const text = { action: "assert", check: "text", expected: "products" };
const snap = (steps: Snapshot["steps"], extra: Partial<Snapshot> = {}): Snapshot => ({ title: "Search", steps, ...extra });
const kinds = (d: ReturnType<typeof diffSteps>) => d.rows.map((r) => r.kind);

describe("diffSteps", () => {
    it("says identical versions are the same, whatever the key order", () => {
        const a = snap([nav, { action: "click", locator: { by: "role", role: "button", value: "Go" } }]);
        const b = snap([nav, { locator: { value: "Go", role: "button", by: "role" }, action: "click" }]);
        const d = diffSteps(a, b);
        expect(d.same).toBe(true);
        expect(kinds(d)).toEqual(["same", "same"]);
        expect(summarise(d)).toBe("No differences");
    });

    it("finds an edited step as one changed step and names the field", () => {
        const d = diffSteps(snap([nav, fill("boot"), click]), snap([nav, fill("tent"), click]));
        expect(kinds(d)).toEqual(["same", "changed", "same"]);
        const c = d.rows[1] as Extract<(typeof d.rows)[number], { kind: "changed" }>;
        expect(c.before).toBe(2);
        expect(c.after).toBe(2);
        expect(c.fields).toEqual(["Text to type"]);
        expect(summarise(d)).toBe("1 step changed");
    });

    it("finds added and removed steps with their numbers", () => {
        const d = diffSteps(snap([nav, fill("a"), click]), snap([nav, click, text]));
        expect(kinds(d)).toEqual(["same", "removed", "same", "added"]);
        expect(d.rows[1]).toMatchObject({ kind: "removed", before: 2 });
        expect(d.rows[3]).toMatchObject({ kind: "added", after: 3 });
        expect(summarise(d)).toBe("1 step added, 1 step removed");
    });

    it("shows a step that only changed place as moved, not as removed and added", () => {
        const d = diffSteps(snap([nav, fill("a"), click, text]), snap([nav, click, text, fill("a")]));
        expect(d.stats).toEqual({ added: 0, removed: 0, changed: 0, moved: 1 });
        const m = d.rows.find((r) => r.kind === "moved");
        expect(m).toMatchObject({ before: 2, after: 4 });
    });

    it("does not pair steps of different kinds as one change", () => {
        const d = diffSteps(snap([nav, click]), snap([nav, text]));
        expect(d.stats).toEqual({ added: 1, removed: 1, changed: 0, moved: 0 });
    });

    it("pairs several edited steps in order", () => {
        const d = diffSteps(snap([fill("a"), fill("b")]), snap([fill("x"), fill("y")]));
        expect(kinds(d)).toEqual(["changed", "changed"]);
        expect(d.rows.map((r) => (r.kind === "changed" ? r.after : 0))).toEqual([1, 2]);
    });

    it("reports a new name and test values as details", () => {
        const d = diffSteps(snap([nav], { testData: { a: "1", b: "2" } }), snap([nav], { title: "Search again", testData: { b: "3", c: "4" } }));
        expect(d.same).toBe(false);
        expect(d.stats).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
        expect(d.details).toEqual([
            { what: "Test name", kind: "changed", from: "Search", to: "Search again" },
            { what: "Test value a", kind: "removed", from: "1" },
            { what: "Test value b", kind: "changed", from: "2", to: "3" },
            { what: "Test value c", kind: "added", to: "4" },
        ]);
        expect(summarise(d)).toBe("4 details changed");
    });

    it("handles empty lists on either side", () => {
        expect(diffSteps(snap([]), snap([nav, click])).stats.added).toBe(2);
        expect(diffSteps(snap([nav, click]), snap([])).stats.removed).toBe(2);
        expect(diffSteps(snap([]), snap([])).same).toBe(true);
    });

    it("copes with the largest test the editor allows", () => {
        const many = Array.from({ length: 100 }, (_, i) => fill(`v${i}`));
        const other = many.map((s, i) => (i === 50 ? fill("changed") : s));
        const d = diffSteps(snap(many), snap(other));
        expect(d.stats).toEqual({ added: 0, removed: 0, changed: 1, moved: 0 });
    });
});

describe("changedFields", () => {
    it("uses the labels the editor shows, and a note is called a note", () => {
        expect(changedFields(fill("a"), { ...fill("a"), description: "Type it" })).toEqual(["Note"]);
        expect(changedFields(click, { ...click, locator: { by: "text", value: "Go" } })).toEqual(["Element to click"]);
        expect(changedFields(text, { ...text, expected: "other" })).toEqual(["Text it should contain"]);
    });
});
