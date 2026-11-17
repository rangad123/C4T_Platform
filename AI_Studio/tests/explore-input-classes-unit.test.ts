/**
 * Input classes from a field's constraints (fast tier, pure): empty, invalid format by type, boundary -1 / at / +1 for each numeric or
 * length limit, long, and unicode. Every class carries the expected result its constraint states (refused, or accepted at a boundary) and
 * the source ref; a class nothing states (empty on an optional field, long and unicode without a limit) is marked inferred.
 * Expected values here come from the HTML constraint rules, not from a run of the code.
 */
import { describe, expect, it } from "vitest";
import { INPUT_VALUE_MAX, inputClassesFor, type InputClass } from "../src/engine/explore/input-classes.js";
import type { ObjectiveField } from "../src/engine/explore/objectives.js";

const REF = "P-signup/signup/username";
const summary = (cs: InputClass[]) => cs.map((c) => [c.class, c.variant ?? null, c.limit ?? null, c.value.length, c.expected, c.basis]);
const find = (cs: InputClass[], cls: InputClass["class"], variant?: string, limit?: string) =>
    cs.find((c) => c.class === cls && (variant === undefined || c.variant === variant) && (limit === undefined || c.limit === limit));

describe("input classes from constraints", () => {
    it("a required text field with maxlength 20 yields exactly empty, the three maxlength boundaries, long and unicode", () => {
        const cs = inputClassesFor({ name: "username", type: "text", required: true, maxLength: 20 }, REF);
        expect(summary(cs)).toEqual([
            ["empty", null, null, 0, "refused", "stated"],
            ["boundary", "below", "maxLength", 19, "accepted", "stated"],
            ["boundary", "at", "maxLength", 20, "accepted", "stated"],
            ["boundary", "above", "maxLength", 21, "refused", "stated"],
            ["long", null, "maxLength", 21, "refused", "stated"],
            ["unicode", "combining", null, 8, "accepted", "inferred"],
            ["unicode", "rtl", null, 8, "accepted", "inferred"],
            ["unicode", "emoji", null, 8, "accepted", "inferred"],
        ]);
        for (const c of cs) expect(c.source.ref).toBe(REF);
        expect(find(cs, "empty")!.source.constraint).toMatch(/required/);
        expect(find(cs, "empty")!.expectedText).toMatch(/refuses the value and says why/);
        expect(find(cs, "boundary", "above")!.expectedText).toMatch(/20/);
        expect(find(cs, "boundary", "at")!.expectedText).toMatch(/accepts/);
    });

    it("a field with no constraint yields only empty, long (1,000 characters) and unicode, all inferred", () => {
        const cs = inputClassesFor({ name: "note" }, REF);
        expect(summary(cs)).toEqual([
            ["empty", null, null, 0, "accepted", "inferred"],
            ["long", null, null, 1000, "accepted", "inferred"],
            ["unicode", "combining", null, 8, "accepted", "inferred"],
            ["unicode", "rtl", null, 8, "accepted", "inferred"],
            ["unicode", "emoji", null, 8, "accepted", "inferred"],
        ]);
        for (const c of cs) expect(c.source.constraint).toBeUndefined();
    });

    it("unicode values carry a combining mark, a right-to-left letter and an emoji, and stay inside a short limit", () => {
        const cs = inputClassesFor({ name: "nick", maxLength: 5 }, REF);
        expect(find(cs, "unicode", "combining")!.value).toMatch(/\p{M}/u);
        expect(find(cs, "unicode", "rtl")!.value).toMatch(/\p{Script=Hebrew}|\p{Script=Arabic}/u);
        expect(find(cs, "unicode", "emoji")!.value).toMatch(/\p{Extended_Pictographic}/u);
        for (const c of cs.filter((x) => x.class === "unicode")) {
            expect(c.value.length).toBeLessThanOrEqual(5);
            expect(c.expected).toBe("accepted");
        }
    });

    it("minlength gives -1 refused, at and +1 accepted", () => {
        const cs = inputClassesFor({ name: "pin", minLength: 4 }, REF);
        const b = cs.filter((c) => c.class === "boundary").map((c) => [c.variant, c.limit, c.value.length, c.expected]);
        expect(b).toEqual([
            ["below", "minLength", 3, "refused"],
            ["at", "minLength", 4, "accepted"],
            ["above", "minLength", 5, "accepted"],
        ]);
        // Nothing caps the length, so "long" is the unlimited 1,000 characters (inferred), above the stated minimum.
        expect(find(cs, "long")).toMatchObject({ expected: "accepted", basis: "inferred" });
        expect(find(cs, "long")!.value.length).toBe(1000);
    });

    it("a number field with min and max: invalid format and both boundaries, no long or unicode", () => {
        const cs = inputClassesFor({ name: "qty", type: "number", min: "1", max: "10" }, REF);
        expect(cs.map((c) => [c.class, c.variant ?? null, c.limit ?? null, c.value, c.expected, c.basis])).toEqual([
            ["empty", null, null, "", "accepted", "inferred"],
            ["invalid_format", "number", null, "abc", "refused", "stated"],
            ["boundary", "below", "min", "0", "refused", "stated"],
            ["boundary", "at", "min", "1", "accepted", "stated"],
            ["boundary", "above", "min", "2", "accepted", "stated"],
            ["boundary", "below", "max", "9", "accepted", "stated"],
            ["boundary", "at", "max", "10", "accepted", "stated"],
            ["boundary", "above", "max", "11", "refused", "stated"],
        ]);
    });

    it("fractional numeric limits keep their decimals", () => {
        const cs = inputClassesFor({ name: "rate", type: "number", min: "0.5" }, REF);
        expect(cs.filter((c) => c.class === "boundary").map((c) => c.value)).toEqual(["-0.5", "0.5", "1.5"]);
    });

    it("a date field: an impossible date is refused and min/max move by one calendar day", () => {
        const cs = inputClassesFor({ name: "from", type: "date", required: true, min: "2024-03-01", max: "2024-12-31" }, REF);
        expect(find(cs, "invalid_format")).toMatchObject({ variant: "date", expected: "refused", basis: "stated" });
        expect(cs.filter((c) => c.class === "boundary").map((c) => [c.limit, c.value, c.expected])).toEqual([
            ["min", "2024-02-29", "refused"],
            ["min", "2024-03-01", "accepted"],
            ["min", "2024-03-02", "accepted"],
            ["max", "2024-12-30", "accepted"],
            ["max", "2024-12-31", "accepted"],
            ["max", "2025-01-01", "refused"],
        ]);
    });

    it("email and url fields refuse a value of the wrong format, and their length boundaries keep a valid format", () => {
        const email = inputClassesFor({ name: "email", type: "email", required: true, maxLength: 30 }, REF);
        expect(find(email, "invalid_format")).toMatchObject({ variant: "email", expected: "refused", basis: "stated" });
        expect(find(email, "invalid_format")!.source.constraint).toMatch(/email/);
        const at = find(email, "boundary", "at", "maxLength")!;
        expect(at.value).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
        expect(at.value.length).toBe(30);
        expect(at.expected).toBe("accepted");
        const url = inputClassesFor({ name: "site", type: "url" }, REF);
        expect(find(url, "invalid_format")).toMatchObject({ variant: "url", expected: "refused", basis: "stated" });
    });

    it("a pattern decides the expected result: values that break it are refused citing the pattern", () => {
        const cs = inputClassesFor({ name: "code", pattern: "[0-9]+", maxLength: 6 }, REF);
        const at = find(cs, "boundary", "at", "maxLength")!;
        expect(at.value).toMatch(/^[0-9]{6}$/);
        expect(at.expected).toBe("accepted");
        expect(find(cs, "invalid_format", "pattern")).toMatchObject({ expected: "refused", basis: "stated" });
        expect(find(cs, "invalid_format", "pattern")!.value).not.toMatch(/^[0-9]+$/);
        for (const u of cs.filter((c) => c.class === "unicode")) {
            expect(u).toMatchObject({ expected: "refused", basis: "stated" });
            expect(u.source.constraint).toMatch(/pattern/);
        }
    });

    it("a list of options refuses a value outside it", () => {
        const cs = inputClassesFor({ name: "size", type: "select", required: true, options: ["S", "M", "L"] }, REF);
        expect(summary(cs)).toEqual([
            ["empty", null, null, 0, "refused", "stated"],
            ["invalid_format", "option", null, expect.any(Number), "refused", "stated"],
        ]);
        expect(["S", "M", "L"]).not.toContain(find(cs, "invalid_format")!.value);
    });

    it("buttons and hidden fields have no input classes; an invalid pattern is ignored, not thrown", () => {
        expect(inputClassesFor({ name: "go", type: "submit" }, REF)).toEqual([]);
        expect(inputClassesFor({ name: "csrf", type: "hidden", required: true }, REF)).toEqual([]);
        expect(() => inputClassesFor({ name: "x", pattern: "([" }, REF)).not.toThrow();
        expect(find(inputClassesFor({ name: "x", pattern: "([" }, REF), "invalid_format")).toBeUndefined();
    });

    it("a pattern that could backtrack without end is never run", () => {
        for (const pattern of ["(a+)+b", "(a|aa)*b", "(\\w+\\s?)*x"]) {
            const t = Date.now();
            const cs = inputClassesFor({ name: "x", pattern, minLength: 40 }, REF);
            expect(Date.now() - t).toBeLessThan(500);
            expect(find(cs, "invalid_format", "pattern")).toBeUndefined();
            for (const c of cs) expect(c.source.constraint ?? "").not.toMatch(/pattern/);
        }
    });

    it("page-declared limits cannot make values larger than the cap", () => {
        const cs = inputClassesFor({ name: "bio", maxLength: 5_000_000, minLength: 4_000_000 }, REF);
        for (const c of cs) expect(c.value.length).toBeLessThanOrEqual(INPUT_VALUE_MAX);
        expect(find(cs, "boundary", "at", "maxLength")).toBeUndefined();
    });

    it("is deterministic and every class has a unique key under its ref", () => {
        const f: ObjectiveField = { name: "username", type: "email", required: true, minLength: 8, maxLength: 20, pattern: ".+@x\\.io" };
        const a = inputClassesFor(f, REF);
        expect(inputClassesFor(f, REF)).toEqual(a);
        const keys = a.map((c) => c.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) expect(k.startsWith(`${REF}#`)).toBe(true);
    });
});
