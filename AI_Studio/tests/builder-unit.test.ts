/**
 * The visual builder without a browser or a server: the field table against the real schema, the list helpers and dirty tracking
 * of the editor, and the platform's rules for what an edited test may contain (secrets, caps, kinds, shared elements, placeholders).
 */
import { describe, expect, it } from "vitest";
import { blankSpec, checkSpecInput, errorsOf, normalised, secretProblems, type EditContext } from "../src/engine/builder/index.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { ASSERT_CHECKS, RESPONSE_CHECKS, StoredStepSchema, TestSpecSchema, type Step as SpecStep } from "../src/engine/spec/schema.js";
import {
    ASSERT_INFO,
    EDITABLE_ACTIONS,
    FIELDS,
    PALETTE,
    RESPONSE_INFO,
    allFieldNames,
    duplicateAt,
    fieldsFor,
    insertAt,
    isDirty,
    moveTo,
    removeAt,
    replaceAt,
    setCheck,
    setField,
    specFrom,
    stepsOf,
    toItems,
    looksSecret,
} from "../web/src/features/builder/builder.js";

const options = (StoredStepSchema as unknown as { options: Array<{ shape: Record<string, { value?: string }> }> }).options;
const ACTIONS = options.map((o) => o.shape.action!.value!);

describe("the field table follows the schema", () => {
    it("has an entry for every action the schema has, and every one but the desktop pair can be edited", () => {
        // 14, plus upload and drag (frames-uploads-popups) and email (hard sign-ins)
        expect(ACTIONS.length).toBe(22);
        for (const a of ACTIONS) expect(FIELDS[a], a).toBeDefined();
        expect(EDITABLE_ACTIONS.sort()).toEqual(ACTIONS.filter((a) => a !== "launchApp" && a !== "closeApp").sort());
    });

    it("offers a form field for every key an action carries (except the action name and the note)", () => {
        for (const o of options) {
            const action = o.shape.action!.value!;
            const keys = Object.keys(o.shape).filter((k) => k !== "action" && k !== "description");
            const have = allFieldNames(action);
            for (const k of keys) expect(have, `${action}.${k}`).toContain(k);
        }
    });

    it("knows every check the schema has, so a new check cannot be forgotten", () => {
        for (const c of ASSERT_CHECKS) expect(ASSERT_INFO[c], c).toBeDefined();
        for (const c of RESPONSE_CHECKS) expect(RESPONSE_INFO[c], c).toBeDefined();
        // and nothing the schema does not have
        expect(Object.keys(ASSERT_INFO).sort()).toEqual([...ASSERT_CHECKS].sort());
        expect(Object.keys(RESPONSE_INFO).sort()).toEqual([...RESPONSE_CHECKS].sort());
    });

    it("every palette item makes a step the schema accepts (once its blanks are filled in)", () => {
        for (const kind of ["web", "api"] as const) {
            for (const g of PALETTE[kind]) {
                for (const p of [...g.items, ...(g.more ?? [])]) {
                    const s = p.make();
                    const r = StoredStepSchema.safeParse(s);
                    expect(r.success, `${kind}/${p.id}`).toBe(true);
                }
            }
        }
    });

    it("changing one field leaves every other key of the step as it was", () => {
        const step = { action: "fill", locator: { by: "label", value: "Email", exact: true, nth: 1 }, value: "a", description: "Type it", extraFromElsewhere: { keep: true } };
        const next = setField(step, "value", "b");
        expect(next).toEqual({ ...step, value: "b" });
        expect(setField(step, "description", "")).not.toHaveProperty("description");
        expect(setField(step, "value", "b").locator).toBe(step.locator);
    });

    it("switching an assert check drops the fields the new check does not use", () => {
        const step = { action: "assert", check: "text", locator: { by: "text", value: "Hi" }, expected: "Hi" };
        const next = setCheck(step, "noConsoleErrors");
        expect(next).toEqual({ action: "assert", check: "noConsoleErrors" });
        expect(fieldsFor(setCheck(step, "visible")).map((f) => f.name)).toEqual(["check", "locator", "expected", "inPopup"]); // a check of what a page shows can be done in a popup too
    });

    it("recognises a secret field by what it is called", () => {
        expect(looksSecret({ by: "label", value: "Password" })).toBe(true);
        expect(looksSecret({ by: "role", role: "textbox", value: "Card number" })).toBe(true);
        expect(looksSecret({ by: "label", value: "Email" })).toBe(false);
        expect(looksSecret({ ref: "Login / Password" })).toBe(false);
    });
});

describe("list helpers and dirty tracking", () => {
    const steps = [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "text", value: "A" } }, { action: "wait", ms: 1 }];

    it("inserts, moves, duplicates, replaces and deletes without touching the other steps", () => {
        const items = toItems(steps);
        const inserted = insertAt(items, 1, { action: "press", key: "Enter" });
        expect(stepsOf(inserted).map((s) => s.action)).toEqual(["navigate", "press", "click", "wait"]);
        expect(inserted[0]!.key).toBe(items[0]!.key);
        expect(stepsOf(moveTo(items, 0, 2)).map((s) => s.action)).toEqual(["click", "wait", "navigate"]);
        expect(moveTo(items, 0, 99)[2]!.step.action).toBe("navigate");
        expect(moveTo(items, 1, 1)).toBe(items);
        const dup = duplicateAt(items, 1);
        expect(dup).toHaveLength(4);
        expect(dup[2]!.step).toEqual(dup[1]!.step);
        expect(dup[2]!.step).not.toBe(dup[1]!.step);
        expect(stepsOf(removeAt(items, 1)).map((s) => s.action)).toEqual(["navigate", "wait"]);
        expect(replaceAt(items, 2, { action: "wait", ms: 9 })[2]!.key).toBe(items[2]!.key);
    });

    it("tells changed from unchanged, ignoring key order", () => {
        const base = { title: "T", testData: { a: "1" }, steps };
        expect(isDirty(base, { title: "T", testData: { a: "1" }, steps: JSON.parse(JSON.stringify(steps)) })).toBe(false);
        expect(isDirty(base, { title: "T", testData: { a: "1" }, steps: [{ url: "/", action: "navigate" }, steps[1]!, steps[2]!] })).toBe(false);
        expect(isDirty(base, { ...base, title: "T2" })).toBe(true);
        expect(isDirty(base, { ...base, steps: [...steps].reverse() })).toBe(true);
        expect(isDirty(base, { ...base, testData: {} })).toBe(true);
    });

    it("sends the loaded spec with only the parts the editor owns replaced", () => {
        const loaded = { title: "Old", description: "kept", testData: { dataSet: "users" }, steps, priority: "high" };
        const out = specFrom(loaded, { title: "  New  ", testData: { dataSet: "users" }, steps: [steps[0]!] });
        expect(out).toEqual({ ...loaded, title: "New", steps: [steps[0]] });
    });
});

describe("what an edited test may contain", () => {
    const ctx = (over: Partial<EditContext> = {}): EditContext => ({ testId: "WEB-001", kind: "web", category: "General", source: { origin: "manual" }, ...over });
    const web = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ title: "Checkout works", kind: "web", steps, ...extra });
    const nav = { action: "navigate", url: "/" };

    it("accepts a sound test and takes ids, kind and origin from the stored test, not from the request", () => {
        const r = checkSpecInput(web([nav, { action: "click", locator: { by: "role", role: "button", value: "Buy" } }], { testId: "HACK-999", kind: "api", source: { origin: "openapi" } }), ctx());
        expect(errorsOf(r.diagnostics)).toEqual([]);
        expect(r.spec!.testId).toBe("WEB-001");
        expect(r.spec!.kind).toBe("web");
        expect(r.spec!.source.origin).toBe("manual");
    });

    it("names the step and says what is missing, in plain words", () => {
        const shape = checkSpecInput(web([nav, { action: "fill", locator: { by: "label", value: "Email" } }]), ctx());
        expect(errorsOf(shape.diagnostics).map((d) => `${d.stepIndex}:${d.message}`)).toEqual(["1:Step 2: the text is missing."]);
        const blanks = checkSpecInput(web([nav, { action: "click", locator: { by: "role", role: "", value: "" } }, { action: "assert", check: "text", expected: "" }]), ctx());
        const msgs = errorsOf(blanks.diagnostics).map((d) => `${d.stepIndex}:${d.message}`);
        expect(msgs.some((m) => m.startsWith("1:Step 2: choose the role"))).toBe(true);
        expect(msgs.some((m) => m.startsWith("2:Step 3: say what it should be"))).toBe(true);
        expect(blanks.spec).toBeUndefined();
    });

    it("says a locator with no strategy is missing one, not that it has the wrong kind of value", () => {
        const r = checkSpecInput(web([nav, { action: "click", locator: {} }]), ctx());
        const msgs = errorsOf(r.diagnostics).map((d) => d.message);
        expect(msgs.some((m) => m.startsWith("Step 2:") && m.endsWith("is missing."))).toBe(true);
        expect(msgs.some((m) => m.includes("wrong kind of value"))).toBe(false);
    });

    it("keeps API steps out of web tests and the other way round", () => {
        const a = checkSpecInput(web([nav, { action: "request", method: "GET", path: "/x" }]), ctx());
        expect(errorsOf(a.diagnostics)[0]!.message).toMatch(/Step 2: This kind of step belongs in an API test/);
        const b = checkSpecInput({ title: "Products list", kind: "api", steps: [{ action: "navigate", url: "/" }] }, ctx({ kind: "api" }));
        expect(errorsOf(b.diagnostics)[0]!.message).toMatch(/belongs in a web test/);
    });

    it("refuses a literal password, but only in steps that were added or changed", () => {
        const pw = { action: "fill", locator: { by: "label", value: "Password" }, value: "hunter2" };
        const fresh = checkSpecInput(web([nav, pw]), ctx());
        expect(errorsOf(fresh.diagnostics)[0]!.message).toMatch(/Step 2: This field holds a secret.*\{\{credentials\.password\}\}/);
        const ok = checkSpecInput(web([nav, { ...pw, value: "{{credentials.password}}" }]), ctx());
        expect(errorsOf(ok.diagnostics)).toEqual([]);
        // a test that already had that step keeps working when someone edits another step
        const current = TestSpecSchema.parse({ testId: "WEB-001", title: "Old test", kind: "web", steps: [nav, pw] });
        const kept = checkSpecInput(web([nav, pw, { action: "wait", ms: 10 }]), ctx({ current }));
        expect(errorsOf(kept.diagnostics)).toEqual([]);
    });

    it("refuses real-looking keys and tokens anywhere in a new step or a test value", () => {
        const key = "sk-" + "a".repeat(30);
        expect(secretProblems({ action: "fill", locator: { by: "label", value: "Notes" }, value: key, description: "" } as SpecStep)).toHaveLength(1);
        const r = checkSpecInput(web([nav, { action: "fill", locator: { by: "label", value: "Notes" }, value: key }]), ctx());
        expect(errorsOf(r.diagnostics)).toHaveLength(1);
        const v = checkSpecInput(web([nav], { testData: { token: key } }), ctx());
        expect(errorsOf(v.diagnostics)[0]!.message).toMatch(/test value “token” looks like a real key/);
        const h = checkSpecInput({ title: "Orders list", kind: "api", steps: [{ action: "request", method: "GET", path: "/o", headers: { Authorization: "Bearer abc" } }] }, ctx({ kind: "api" }));
        expect(errorsOf(h.diagnostics)[0]!.message).toMatch(/Authorization header/);
        expect(errorsOf(checkSpecInput({ title: "Orders list", kind: "api", steps: [{ action: "request", method: "GET", path: "/o", headers: { Authorization: "{{credentials.apiToken}}" } }] }, ctx({ kind: "api" })).diagnostics)).toEqual([]);
    });

    it("enforces the caps", () => {
        const many = Array.from({ length: 101 }, () => ({ action: "wait", ms: 1 }));
        expect(errorsOf(checkSpecInput(web(many), ctx()).diagnostics)[0]!.message).toMatch(/at most 100 steps/);
        const long = checkSpecInput(web([{ action: "navigate", url: "/" + "a".repeat(2100) }]), ctx());
        expect(errorsOf(long.diagnostics)[0]!.message).toMatch(/longer than 2000/);
        const tooMuchData = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, "v"]));
        expect(errorsOf(checkSpecInput(web([nav], { testData: tooMuchData }), ctx()).diagnostics)[0]!.message).toMatch(/at most 30 test values/);
        expect(errorsOf(checkSpecInput(web([]), ctx()).diagnostics)[0]!.message).toMatch(/at least one step/);
    });

    it("checks shared elements against the project's, and warns about a placeholder nothing provides", () => {
        const step = { action: "click", locator: { ref: "Cart / Buy" } };
        const missing = checkSpecInput(web([nav, step]), ctx());
        expect(errorsOf(missing.diagnostics)[0]!.message).toMatch(/Step 2: .*'Cart \/ Buy'.*not in the object repository/);
        const objects = new Map([["Cart / Buy", { kind: "web" as const, locator: { by: "role" as const, role: "button", value: "Buy" } }]]);
        const ok = checkSpecInput(web([nav, step, { action: "fill", locator: { by: "label", value: "Name" }, value: "{{who}}" }]), ctx({ objects }));
        expect(errorsOf(ok.diagnostics)).toEqual([]);
        expect(ok.diagnostics.find((d) => d.severity === "warning")).toMatchObject({ stepIndex: 2 });
        expect(ok.spec!.steps[1]).toMatchObject({ locator: { ref: "Cart / Buy" } });
        const defined = checkSpecInput(web([nav, { action: "fill", locator: { by: "label", value: "Name" }, value: "{{who}}" }], { testData: { who: "Ada" } }), ctx());
        expect(defined.diagnostics).toEqual([]);
    });

    it("a spec built from nothing is valid and renders", () => {
        for (const kind of ["web", "api"] as const) {
            const spec = blankSpec({ testId: kind === "web" ? "WEB-001" : "API-001", title: "From nothing", kind, category: "Built", startPath: "/" });
            const script = renderWithAdapter(spec, kind === "web" ? "playwright" : "playwright-api", { baseUrl: "http://127.0.0.1:1" });
            expect(script.content).toContain("From nothing");
        }
    });

    it("two specs compare equal after the platform's own defaults", () => {
        const a = TestSpecSchema.parse({ testId: "WEB-001", title: "Same thing", kind: "web", steps: [{ action: "navigate", url: "/" }] });
        expect(normalised({ ...a, steps: [{ url: "/", action: "navigate", description: "" }] })).toBe(normalised(a));
    });
});
