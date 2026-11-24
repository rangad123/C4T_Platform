/**
 * eng-fix3 (paid series PAID-SERIES-RESULT.md, targets V1–V4, V7 and shop detection): one regression test per fix, from the paid trials'
 * own saved steps and scenarios (c4t-scratch/eng-paid/trials). Fast tier: no browser, no model.
 */
import { describe, expect, it } from "vitest";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { maskedExpectation, withStatedCheckKinds } from "../src/engine/web/author.js";

const steps = (xs: unknown[]) => xs as Step[];

describe("a masked evidence value is never an expected value (shop-3 WEB-042, shop-5 WEB-033/046)", () => {
    it("refuses a check that expects [hidden], and lets the typed value through", () => {
        const web042 = { action: "assert", check: "notText", locator: { by: "text", value: "Deliver to" }, expected: "[hidden]", source: "expected:2" } as Step;
        expect(maskedExpectation(web042)).toMatch(/never expect it/);
        expect(maskedExpectation({ action: "assert", check: "visible", locator: { by: "text", value: "[hidden] qatflc" } } as Step)).toMatch(/never expect it/);
        expect(maskedExpectation({ ...web042, expected: "715 Harbor Lane" } as Step)).toBeUndefined();
        expect(maskedExpectation({ action: "fill", locator: { by: "label", value: "Password" }, value: "[hidden]" } as Step)).toBeUndefined();
    });
});

describe("an assertion kind the requirement does not state becomes the plain check (rbac-3 WEB-041, rbac-5 WEB-023)", () => {
    it("an accessible error message is the message shown; an accessibility requirement keeps it", () => {
        const web023 = { action: "assert", check: "accessibleErrorMessage", locator: { by: "label", value: "Email" }, expected: "Enter a valid email address.", source: "expected:2" } as Step;
        expect(withStatedCheckKinds(web023, "Registration refuses an invalid email address")).toMatchObject({ action: "assert", check: "visible", locator: { by: "text", value: "Enter a valid email address." }, source: "expected:2" });
        expect(withStatedCheckKinds(web023, "The error is announced to screen readers through aria-errormessage")).toEqual(web023);
        const named = { action: "assert", check: "accessibleName", locator: { by: "role", role: "button", value: "Save" }, expected: "Save note" } as Step;
        expect(withStatedCheckKinds(named, "Save a note")).toMatchObject({ check: "text" });
    });
});
