/**
 * The 3-vote defect review's answer parser (row 236). In 16 bench trials 363 of 364 reviews counted neither yes nor no: every review call
 * used its whole 20-token allowance (ai_usage: 3 calls, 60 output tokens), so the model wrote prose that was cut off before any
 * verdict, and a defect with no answers was logged as "confirmed". The raw answers were not saved, so the samples below are the
 * shapes such answers take: prose first, a cut-off answer, and the fixed last line the prompt now asks for.
 */
import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/engine/web/author.js";

describe("parseVerdict", () => {
    it("reads the fixed last line, after any reasoning", () => {
        expect(parseVerdict("Looking at the evidence, the server answered HTTP 500 on submit.\n\nVERDICT: YES")).toBe(true);
        expect(parseVerdict("The test clicked a heading, not the button, so the click did nothing.\nVERDICT: NO")).toBe(false);
        expect(parseVerdict("**Verdict: yes**")).toBe(true);
        expect(parseVerdict("verdict - no")).toBe(false);
    });

    it("the last verdict line wins over words in the reasoning", () => {
        expect(parseVerdict("No element was missing and yes, the total is wrong.\nVERDICT: NO")).toBe(false);
        expect(parseVerdict("Yes, at first sight it looks like a bug, but the step was not done.\nVERDICT: NO")).toBe(false);
        expect(parseVerdict("A first verdict: yes, the total looked wrong; but step 3 was never done.\nVERDICT: NO")).toBe(false);
    });

    it("keeps a bare yes or no", () => {
        expect(parseVerdict("yes")).toBe(true);
        expect(parseVerdict("No.")).toBe(false);
        expect(parseVerdict("**Yes**")).toBe(true);
    });

    it("an answer with no verdict is no answer, never a yes", () => {
        // Cut off at the token limit before saying anything, as the bench reviews were.
        expect(parseVerdict("Looking at this evidence carefully, the test writer reports that the discount applies only to")).toBeUndefined();
        expect(parseVerdict("# Analysis\n\nThe scenario expects the order to be")).toBeUndefined();
        expect(parseVerdict("I cannot tell from the steps whether yes or no applies.")).toBeUndefined();
        expect(parseVerdict("")).toBeUndefined();
    });
});
