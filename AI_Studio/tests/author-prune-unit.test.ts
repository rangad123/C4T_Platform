/**
 * Row 205: which step a clean replay may drop as a leftover (web/author.ts pruneByReplay). A failing `navigate` that later steps act on
 * is never dropped: C1e's WEB-050 lost `navigate /cart`, and its "Check out" click then failed on the product page in validation. When
 * such a step fails on the replay, the original steps are kept. A leftover navigate followed by another navigate, and any other failing
 * action, may still be dropped. No browser.
 */
import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { replayMayDrop } from "../src/engine/web/author.js";

const role = (r: string, value: string) => ({ by: "role", role: r, value });
// WEB-050's recorded shape (C1e, wf-fb24 as stated), with the navigate the replay lost.
const web050 = TestSpecSchema.parse({
    testId: "WEB-050",
    title: "As stated: workflow wf-fb24",
    kind: "web",
    steps: [
        { action: "navigate", url: "/" },
        { action: "click", locator: role("link", "Sign in") },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" },
        { action: "click", locator: role("button", "Sign in") },
        { action: "click", locator: role("link", "Trail Mug") },
        { action: "click", locator: role("button", "Add to cart") },
        { action: "navigate", url: "/cart" },
        { action: "click", locator: role("link", "Check out") },
        { action: "fill", locator: { by: "label", value: "Delivery address" }, value: "82 Willow Street {{unique}}" },
        { action: "click", locator: role("button", "Continue") },
        { action: "assert", check: "url", expected: "/checkout/review" },
    ],
}).steps;

describe("replayMayDrop", () => {
    it("never drops the navigate the next steps act on (WEB-050's navigate /cart)", () => {
        expect(web050[7]).toMatchObject({ action: "navigate", url: "/cart" });
        expect(replayMayDrop(web050, 7)).toBe(false);
        expect(replayMayDrop(web050, 0)).toBe(false);
    });

    it("a navigate followed by another navigate, or the last step, is a leftover; so is a failing action", () => {
        const twice = [web050[0]!, { action: "navigate", url: "/cart" }, ...web050.slice(7)] as typeof web050;
        expect(replayMayDrop(twice, 0)).toBe(true);
        expect(replayMayDrop([...web050.slice(0, 11), { action: "navigate", url: "/orders" }] as typeof web050, 11)).toBe(true);
        expect(replayMayDrop(web050, 6)).toBe(true);
        expect(replayMayDrop(web050, 1)).toBe(true);
    });
});

describe("failsAsCaptured (the prune guard of a captured defect test)", () => {
    // Paid trial rbac-2 WEB-054: the captured check, as authoring kept it. The prune dropped the Title fill and Save note, and the
    // message was still missing, so the guard accepted it; the saved test then "showed" the defect on every app.
    const web054 = "expect(locator).toBeVisible() failed Locator: getByText('Give the note a title.') Expected: visible Timeout: 6000ms Error: element(s) not found";
    it("never accepts a prune when the captured failure is an element that is not there", async () => {
        const { failsAsCaptured } = await import("../src/engine/explore/independence.js");
        const replayed = "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Give the note a title.')\nExpected: visible\nTimeout: 5000ms\nError: element(s) not found";
        expect(failsAsCaptured(web054, replayed)).toBe(false);
    });
    it("still accepts one whose captured check saw the same value", async () => {
        const { failsAsCaptured } = await import("../src/engine/explore/independence.js");
        const captured = 'expect(locator).toHaveText(expected) failed Expected: "$25.00" Received: "$30.00"';
        expect(failsAsCaptured(captured, 'Error: expect(locator).toHaveText(expected) failed\nExpected: "$25.00"\nReceived: "$30.00"')).toBe(true);
        expect(failsAsCaptured(captured, 'Error: expect(locator).toHaveText(expected) failed\nExpected: "$25.00"\nReceived: "$0.00"')).toBe(false);
    });
});
