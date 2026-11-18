/**
 * The leftover check (queue row 181, second commit): a saved test that acts on or checks an item its own earlier steps never added or
 * opened is found, deterministically and without AI. The C1c trial's saved WEB-028 (empties the cart before adding anything) and
 * WEB-030 (clears a leftover Trail Mug, removes a Headphones line it never added) are found; tests that add an item and then remove
 * it, and tests on the starting data every fresh session sees (the catalogue, seeded orders), are not.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../src/engine/spec/schema.js";
import { findLeftoverUse, leftoverReason } from "../src/engine/web/leftovers.js";

const saved = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "c1c-leftover-specs.json"), "utf8")) as Record<string, { steps: Step[] }>;
const stepsOf = (key: string) => saved[key]!.steps;

const signIn: Step[] = [
    { action: "navigate", url: "/cart", description: "Open /cart" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}", description: "Enter the email" },
    { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "Enter the password" },
    { action: "click", locator: { by: "role", role: "button", value: "Sign in" }, description: "Sign in" },
];
const removeMug: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Trail Mug" } }, description: "Remove the Trail Mug line" };
const addMug: Step[] = [
    { action: "click", locator: { by: "role", role: "link", value: "Products" }, description: "Go to products" },
    { action: "click", locator: { by: "role", role: "link", value: "Trail Mug" }, description: "Open the product" },
    { action: "click", locator: { by: "role", role: "button", value: "Add to cart" }, description: "Add it to the cart" },
    { action: "navigate", url: "/cart", description: "Open /cart" },
];
const mugGone: Step = { action: "assert", check: "hidden", locator: { by: "role", role: "row", value: "Trail Mug" }, source: "expected:1", description: "The line is gone" };

describe("the leftover check", () => {
    it("finds the C1c WEB-028: it empties the cart before the test added anything", () => {
        const found = findLeftoverUse(stepsOf("WEB-028"));
        expect(found).toEqual([{ step: 7, what: 'presses "Remove" before the test added anything' }]);
    });

    it("finds the C1c WEB-030: a leftover cleared unnamed, then lines removed by name that the test never added", () => {
        const found = findLeftoverUse(stepsOf("WEB-030"));
        expect(found.map((f) => f.step)).toEqual([5, 14, 15]);
        expect(found[1]!.what).toBe('removes "Headphones"');
        expect(found[2]!.what).toBe('removes "Trail Mug"');
        expect(leftoverReason(found)).toMatch(/^The test depends on what the account held before it ran: step 5 .*step 14 removes "Headphones"; step 15 removes "Trail Mug"\./);
    });

    it("finds a check of a discount code the test never applied (C1c WEB-032), and of cart lines it never added (WEB-037)", () => {
        expect(findLeftoverUse(stepsOf("WEB-032"))).toEqual([{ step: 13, what: "checks the code SAVE10, which the test never applied" }]);
        expect(findLeftoverUse(stepsOf("WEB-037")).map((f) => f.what)).toEqual(['checks "Water Bottle", a line the account held', 'checks "Trail Mug", a line the account held']);
    });

    it("finds a named removal with nothing before it, and a click on a row the test never added", () => {
        expect(findLeftoverUse([...signIn, removeMug, mugGone])).toEqual([{ step: 5, what: 'removes "Trail Mug"' }]);
        const clickRow: Step = { action: "click", locator: { by: "role", role: "row", value: "Desk Lamp" }, description: "Locate the Desk Lamp row" };
        expect(findLeftoverUse([...signIn, ...addMug, clickRow])).toEqual([{ step: 9, what: 'clicks the row "Desk Lamp"' }]);
    });

    it("does not flag a test that adds an item and then removes it, by name or unnamed", () => {
        expect(findLeftoverUse([...signIn, ...addMug, removeMug, mugGone])).toEqual([]);
        const unnamed: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove" }, description: "Remove the line" };
        expect(findLeftoverUse([...signIn, ...addMug, unnamed])).toEqual([]);
        // Added by its address, named in the step that adds it.
        const byUrl: Step[] = [{ action: "navigate", url: "/products/p5", description: "Open /products/p5" }, { action: "click", locator: { by: "role", role: "button", value: "Add to cart" }, description: "Add Water Bottle to cart" }];
        const removeBottle: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Water Bottle" } }, description: "Remove it" };
        expect(findLeftoverUse([...signIn, ...byUrl, removeBottle])).toEqual([]);
        // A discount code the test applied itself.
        const applied: Step[] = [
            { action: "fill", locator: { by: "label", value: "Discount code" }, value: "SAVE10", description: "Enter the code" },
            { action: "click", locator: { by: "role", role: "button", value: "Apply" }, description: "Apply it" },
            { action: "assert", check: "visible", locator: { by: "text", value: "Discount (SAVE10)" }, source: "expected:1", description: "The discount shows" },
        ];
        expect(findLeftoverUse([...signIn, ...addMug, ...applied])).toEqual([]);
    });

    it("a removal step does not make what it removes the test's own: describing the leftover it clears is not adding it", () => {
        const clearUnnamedAfterAdd: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", nth: 0 }, description: "Clear the leftover Headphones" };
        const removeHeadphones: Step = { action: "click", locator: { by: "role", role: "button", value: "Remove", within: { by: "role", role: "row", value: "Headphones" } }, description: "Remove the Headphones line" };
        expect(findLeftoverUse([...signIn, ...addMug, clearUnnamedAfterAdd, removeHeadphones]).map((f) => f.step)).toEqual([10]);
    });

    it("leaves the starting data alone: a catalogue card read before it is opened, a product page, seeded orders", () => {
        expect(findLeftoverUse(stepsOf("WEB-020"))).toEqual([]);
        expect(findLeftoverUse(stepsOf("WEB-021"))).toEqual([]);
        expect(findLeftoverUse(stepsOf("WEB-036"))).toEqual([]);
        const catalogueRow: Step[] = [
            { action: "navigate", url: "/", description: "Open the catalogue" },
            { action: "assert", check: "text", locator: { by: "role", role: "row", value: "Headphones $59.99" }, expected: "$59.99", source: "expected:1", description: "The catalogue lists Headphones" },
            { action: "click", locator: { by: "role", role: "button", value: "Add to cart", within: { by: "role", role: "listitem", value: "Headphones" } }, description: "Add from the catalogue card" },
        ];
        expect(findLeftoverUse(catalogueRow)).toEqual([]);
    });
});
