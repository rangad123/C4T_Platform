/**
 * eng-fix3 (paid series PAID-SERIES-RESULT.md, targets V1–V4, V7 and shop detection): one regression test per fix, from the paid trials'
 * own saved steps and scenarios (c4t-scratch/eng-paid/trials). Fast tier: no browser, no model.
 */
import { describe, expect, it } from "vitest";
import { roleCredentials } from "../src/engine/identity/role-differences.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { maskedExpectation, withStatedCheckKinds } from "../src/engine/web/author.js";
import { findLeftoverUse } from "../src/engine/web/leftovers.js";
import { catalogueRoles } from "../src/eval/bench/controller.js";
import { loadCatalogueVersion } from "../src/eval/bench/catalogue.js";

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

describe("the leftover gate covers URL and heading checks with hard-coded ids (rbac-5 WEB-027, rbac-4 WEB-038)", () => {
    const signIn = [
        { action: "navigate", url: "/notes/new" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
        { action: "fill", locator: { by: "label", value: "Title" }, value: "qa1x0y short" },
        { action: "click", locator: { by: "role", role: "button", value: "Save note" } },
    ];
    const starting = new Set(["/n1", "/n2", "/n3", "/p1"]);
    it("flags /notes/n17 and n25, not a starting record's address", () => {
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "url", expected: "/notes/n17", source: "expected:1" }]), starting).map((u) => u.what)).toEqual([expect.stringMatching(/\/notes\/n17, a record number the test never made/)]);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "urlPattern", expected: "/notes/n25", source: "expected:1" }]), starting)).toHaveLength(1);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "url", expected: "/products/p1" }]), starting)).toEqual([]);
    });
    it("flags a heading with a record number the test never made, not its own typed title", () => {
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Note n17" } }]), starting)).toHaveLength(1);
        const typed = [...signIn.slice(0, 2), { action: "fill", locator: { by: "label", value: "Title" }, value: "Plan v42" }, signIn[3]];
        expect(findLeftoverUse(steps([...typed, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Plan v42" } }]), starting)).toEqual([]);
        expect(findLeftoverUse(steps([...signIn, { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Note n2" } }]), starting)).toEqual([]);
    });
});

describe("a role named only in a precondition binds the one account that holds it (rbac-5 WEB-029, WEB-035)", () => {
    it("the catalogue's only admin and only manager are named after their role, and the trial's scenarios bind them", () => {
        const roles = catalogueRoles(loadCatalogueVersion("2026-11-21.1").accounts!["bench-rbac"]!);
        const web035 = { title: "Admin sees People in the main navigation", description: "Sign in with the admin test account and read the main navigation. Click People and observe the page that opens.", preconditions: ["An admin test account exists"] };
        const web029 = { title: "Manager creates a note like any user", description: "Sign in with the manager test account and read the role on the Account page.", preconditions: ["A manager test account exists", "Signed in as a newly registered account with an empty cart and no orders"] };
        expect(roleCredentials(web035, roles, "ana@example.test")).toEqual({ name: "admin", credentials: { username: "ada@example.test", password: "Password1!" } });
        expect(roleCredentials(web029, roles, "ana@example.test")?.credentials.username).toBe("mia@example.test");
        // Two accounts hold "user": neither is named after it, and a "user test account" binds nobody.
        expect(roles.filter((r) => r.name === "user")).toEqual([]);
        expect(roleCredentials({ title: "x", preconditions: ["A user test account exists"] }, roles, "ana@example.test")).toBeUndefined();
    });
});
