/**
 * Recorder engine without a browser: locator ranking, dynamic-value rejection, step normalisation, redaction, descriptions,
 * spec building, the injected script's shape, origin wiring. (The browser journeys are in recorder.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { describeRecStep } from "../src/engine/recorder/describe.js";
import { DYNAMIC_PATTERNS, looksDynamic, REC_LIMITS, SECRET_PLACEHOLDERS, type RecStep } from "../src/engine/recorder/model.js";
import { capStep, hasSavableSteps, pushStep, reindex, type NewStep } from "../src/engine/recorder/normalise.js";
import { recorderScript } from "../src/engine/recorder/page-script.js";
import { rankCandidates, validCandidate, type RawCandidate } from "../src/engine/recorder/rank.js";
import { buildRecordedSpec, foreignOrigins } from "../src/engine/recorder/spec.js";
import { unhealableTest } from "../src/engine/healing/failure.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const c = (strategy: RawCandidate["strategy"], value: string, matches: number, extra: Partial<RawCandidate> = {}): RawCandidate => ({ strategy, value, matches, hit: true, ...extra });
const role = (name: string, matches: number, r = "button") => c("role", r, matches, { name, exact: true });

describe("locator ranking", () => {
    it("prefers a unique test id, then role + name, then label, placeholder, text, css", () => {
        const all = [c("css", "#x", 1), c("text", "Save", 1), c("placeholder", "Email", 1), c("label", "Email", 1), role("Save", 1), c("testId", "save", 1)];
        expect(rankCandidates(all)!.chosen).toMatchObject({ strategy: "testId", value: "save" });
        expect(rankCandidates(all.slice(0, 5))!.chosen).toMatchObject({ strategy: "role", value: "button", name: "Save" });
        expect(rankCandidates(all.slice(0, 4))!.chosen.strategy).toBe("label");
        expect(rankCandidates(all.slice(0, 3))!.chosen.strategy).toBe("placeholder");
        expect(rankCandidates(all.slice(0, 2))!.chosen.strategy).toBe("text");
        expect(rankCandidates(all.slice(0, 1))!.chosen.strategy).toBe("css");
    });

    it("skips a candidate that finds several elements and uses the next unique one (a position, when nothing else is unique)", () => {
        const r = rankCandidates([role("Delete", 3), c("text", "Delete", 3), c("css", "ul > li:nth-of-type(2) > button", 1)])!;
        expect(r.chosen).toEqual({ strategy: "css", value: "ul > li:nth-of-type(2) > button" });
        expect(r.matches).toBe(1);
        expect(r.positional).toBe(true);
        // the ambiguous ones stay visible as alternatives, with their counts
        expect(r.alternatives.map((a) => a.matches)).toEqual([3, 3]);
    });

    it("keeps at most 4 alternatives, unique ones first, and never repeats the chosen one", () => {
        const r = rankCandidates([c("testId", "a", 1), role("A", 1), c("label", "A", 1), c("placeholder", "A", 2), c("text", "A", 1), c("css", "#a", 1), c("css", "div > a", 1)])!;
        expect(r.alternatives).toHaveLength(4);
        expect(r.alternatives.every((a) => a.locator.value !== "a" || a.locator.strategy !== "testId")).toBe(true);
        expect(r.alternatives.map((a) => a.matches)).toEqual([1, 1, 1, 1]);
    });

    it("drops candidates that do not find the recorded element (hit false) and ones with long or generated text", () => {
        const long = "x".repeat(REC_LIMITS.maxLocatorText + 1);
        const r = rankCandidates([c("testId", "gone", 1, { hit: false }), c("label", long, 1), c("text", "Order 123456", 1), role("Pay now", 1)])!;
        expect(r.chosen).toMatchObject({ strategy: "role", name: "Pay now" });
        expect(r.alternatives).toEqual([]);
        expect(validCandidate(c("label", long, 1))).toBe(false);
        expect(validCandidate(c("role", "button", 1))).toBe(false); // a role without a name says nothing
    });

    it("uses a generated-looking locator only when nothing else identifies the element, and says so", () => {
        const r = rankCandidates([c("css", "#btn-9f8e7d6c5b", 1), c("text", "Item 4821", 1)])!;
        expect(r.generated).toBe(true);
        expect(r.chosen.strategy).toBe("text");
        expect(rankCandidates([role("Pay", 1)])!.generated).toBe(false);
    });

    it("falls back to the least ambiguous candidate when none is unique, and to nothing when nothing is usable", () => {
        const r = rankCandidates([role("Buy", 4), c("text", "Buy", 2)])!;
        expect(r.chosen.strategy).toBe("text");
        expect(r.matches).toBe(2);
        expect(rankCandidates([])).toBeUndefined();
        expect(rankCandidates([c("testId", "x", 0)])).toBeUndefined();
    });

    it("does not treat a position in a css path as a generated value", () => {
        const r = rankCandidates([c("css", "ul > li:nth-of-type(12) > button", 1)])!;
        expect(r.generated).toBe(false);
        expect(r.positional).toBe(true);
    });
});

describe("dynamic-looking values", () => {
    it.each([
        ["Order 123456", true],
        ["3 items", true],
        ["Cart (2)", true],
        ["Updated 12:45", true],
        ["2026-10-11", true],
        ["550e8400-e29b-41d4-a716-446655440000", true],
        ["deadbeef12", true],
        ["css-1x9y8z", true],
        ["btn-a8f3k2x1", true],
        ["Add to cart", false],
        ["Sign in", false],
        ["col-md-6", false],
        ["checkout-button", false],
        ["Step 2 of 3", false],
    ])("%s -> %s", (text, dynamic) => {
        expect(looksDynamic(text)).toBe(dynamic);
    });
    it("shares its patterns with the injected script", () => {
        const src = recorderScript({ binding: "b", ctl: "c", token: "t" });
        for (const [pattern] of DYNAMIC_PATTERNS) expect(src).toContain(JSON.stringify(pattern).slice(1, -1));
    });
});

describe("step normalisation", () => {
    const step = (kind: NewStep["kind"], extra: Partial<NewStep> = {}): NewStep => ({ kind, describe: kind, at: "2026-01-01T00:00:00Z", ...extra });
    const loc = (v: string) => ({ strategy: "label" as const, value: v });

    it("merges fills of the same field into one fill with the final value", () => {
        let steps: RecStep[] = [];
        steps = pushStep(steps, step("fill", { locator: loc("Email"), value: "a" })).steps;
        const r = pushStep(steps, step("fill", { locator: loc("Email"), value: "ab@x.test" }));
        expect(r.outcome).toBe("merged");
        expect(r.steps).toHaveLength(1);
        expect(r.steps[0]!.value).toBe("ab@x.test");
        // another field is a new step; the same field after another step too
        let s2 = pushStep(r.steps, step("fill", { locator: loc("Name"), value: "n" })).steps;
        s2 = pushStep(s2, step("click", { locator: loc("Go") })).steps;
        expect(pushStep(s2, step("fill", { locator: loc("Name"), value: "m" })).outcome).toBe("added");
    });

    it("drops an identical goto right after a goto and keeps indexes 0..n-1", () => {
        let steps = pushStep([], step("goto", { url: "http://x/" })).steps;
        expect(pushStep(steps, step("goto", { url: "http://x/" })).outcome).toBe("dropped");
        steps = pushStep(steps, step("click", { locator: loc("A") })).steps;
        steps = pushStep(steps, step("click", { locator: loc("B") })).steps;
        expect(steps.map((s) => s.index)).toEqual([0, 1, 2]);
        expect(reindex(steps.filter((s) => s.index !== 1)).map((s) => s.index)).toEqual([0, 1]);
    });

    it("caps the step count, and long values and urls", () => {
        let steps: RecStep[] = [];
        for (let i = 0; i < 3; i++) steps = pushStep(steps, step("click", { locator: loc(`B${i}`) }), 3).steps;
        expect(pushStep(steps, step("click", { locator: loc("B9") }), 3).outcome).toBe("full");
        const capped = capStep(step("fill", { locator: loc("A"), value: "v".repeat(5000) }));
        expect(capped.value!.length).toBeLessThanOrEqual(REC_LIMITS.maxValue);
        expect(capStep(step("assert", { assert: { check: "text", expected: "t".repeat(900) } })).assert!.expected!.toString().length).toBeLessThanOrEqual(REC_LIMITS.maxAssertText);
        expect(REC_LIMITS.maxSteps).toBe(300);
    });

    it("a recording of only a goto cannot be saved", () => {
        expect(hasSavableSteps(pushStep([], step("goto", { url: "http://x/" })).steps)).toBe(false);
        expect(hasSavableSteps(pushStep([], step("click", { locator: loc("A") })).steps)).toBe(true);
    });
});

describe("secrets in descriptions and specs", () => {
    const secretFill = (kind: keyof typeof SECRET_PLACEHOLDERS) => ({ kind: "fill" as const, locator: { strategy: "label" as const, value: "Password" }, value: SECRET_PLACEHOLDERS[kind], secret: true });
    it.each([
        ["password", "Type the password into the field labelled \"Password\""],
        ["otp", "Type the one-time code into the field labelled \"Password\""],
        ["card_number", "Type the card number into the field labelled \"Password\""],
        ["card_cvc", "Type the card security code into the field labelled \"Password\""],
    ] as const)("%s is worded without a value", (kind, words) => {
        const text = describeRecStep(secretFill(kind));
        expect(text).toBe(words);
        expect(text).not.toContain("{{");
    });
    it("the stand-ins are the platform's placeholders", () => {
        expect(SECRET_PLACEHOLDERS.password).toBe("{{credentials.password}}");
        expect(SECRET_PLACEHOLDERS.otp).toBe("{{credentials.totp}}");
    });
    it("the spec builder refuses a secret step that carries anything but its stand-in", () => {
        const bad: RecStep = { index: 1, kind: "fill", locator: { strategy: "label", value: "Password" }, value: "hunter2", secret: true, describe: "x", at: "t" };
        const steps: RecStep[] = [{ index: 0, kind: "goto", url: "http://127.0.0.1:1/", describe: "g", at: "t" }, bad];
        expect(buildRecordedSpec({ title: "T title", startUrl: "http://127.0.0.1:1/", steps }).problems.join(" ")).toMatch(/marked secret/);
    });
});

describe("plain-words descriptions", () => {
    it("reads like a person would say it", () => {
        const r = { strategy: "role" as const, value: "button", name: "Add to cart", exact: true };
        expect(describeRecStep({ kind: "click", locator: r })).toBe('Click the button "Add to cart"');
        expect(describeRecStep({ kind: "fill", locator: { strategy: "label", value: "Email" }, value: "a@b.test" })).toBe('Type "a@b.test" into the field labelled "Email"');
        expect(describeRecStep({ kind: "fill", locator: { strategy: "label", value: "Email" }, value: "" })).toBe('Clear the field labelled "Email"');
        expect(describeRecStep({ kind: "select", locator: { strategy: "label", value: "Colour" }, value: "blue" })).toBe('Choose "blue" in the field labelled "Colour"');
        expect(describeRecStep({ kind: "check", locator: { strategy: "label", value: "Gift wrap" } })).toBe('Tick the field labelled "Gift wrap"');
        expect(describeRecStep({ kind: "press", value: "Enter" })).toBe("Press Enter");
        expect(describeRecStep({ kind: "goto", url: "http://x/shop" })).toBe("Open http://x/shop");
        expect(describeRecStep({ kind: "assert", locator: { strategy: "testId", value: "welcome" }, assert: { check: "text", expected: "Welcome back" } })).toBe('Check that the element with test id "welcome" shows "Welcome back"');
        expect(describeRecStep({ kind: "click", locator: { strategy: "css", value: "ul > li:nth-of-type(2) > button" } }, { positional: true })).toContain("found by its place on the page");
    });
});

describe("spec building", () => {
    const start = "http://127.0.0.1:5990/login";
    const steps: RecStep[] = [
        { index: 0, kind: "goto", url: start, describe: "Open", at: "t" },
        { index: 1, kind: "fill", locator: { strategy: "label", value: "Email" }, value: "a@b.test", describe: "Type", at: "t" },
        { index: 2, kind: "fill", locator: { strategy: "label", value: "Password" }, value: "{{credentials.password}}", secret: true, describe: "Type the password", at: "t" },
        { index: 3, kind: "click", locator: { strategy: "role", value: "button", name: "Sign in", exact: true }, describe: "Click", at: "t" },
        { index: 4, kind: "select", locator: { strategy: "label", value: "Colour" }, value: "blue", describe: "Choose", at: "t" },
        { index: 5, kind: "uncheck", locator: { strategy: "label", value: "Gift wrap" }, describe: "Untick", at: "t" },
        { index: 6, kind: "press", locator: { strategy: "label", value: "Coupon" }, value: "Enter", describe: "Press", at: "t" },
        { index: 7, kind: "assert", locator: { strategy: "testId", value: "welcome" }, assert: { check: "text", expected: "Welcome back" }, describe: "Check", at: "t" },
        { index: 8, kind: "click", locator: { strategy: "css", value: "#x" }, ref: "Shop / Buy button", describe: "Click shared", at: "t" },
    ];
    it("produces a golden web spec the platform's own schema accepts, origin recorded", () => {
        const { spec, problems } = buildRecordedSpec({ title: "Sign in and shop", startUrl: start, steps, recordedAt: "2026-10-11T10:00:00Z" });
        expect(problems).toEqual([]);
        expect(spec).toMatchObject({ title: "Sign in and shop", kind: "web", category: "Recorded", type: "functional", tags: ["recorded"], source: { origin: "recorded" } });
        expect(spec.steps).toEqual([
            { action: "navigate", url: "/login", description: "Open" },
            { action: "fill", locator: { by: "label", value: "Email" }, value: "a@b.test", description: "Type" },
            { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}", description: "Type the password" },
            { action: "click", locator: { by: "role", role: "button", value: "Sign in", exact: true }, description: "Click" },
            { action: "select", locator: { by: "label", value: "Colour" }, value: "blue", description: "Choose" },
            { action: "check", locator: { by: "label", value: "Gift wrap" }, checked: false, description: "Untick" },
            { action: "press", key: "Enter", locator: { by: "label", value: "Coupon" }, description: "Press" },
            { action: "assert", check: "text", locator: { by: "testId", value: "welcome" }, expected: "Welcome back", description: "Check" },
            { action: "click", locator: { ref: "Shop / Buy button" }, description: "Click shared" },
        ]);
        const parsed = TestSpecSchema.safeParse({ ...spec, testId: "WEB-001" });
        expect(parsed.success).toBe(true);
        expect(JSON.stringify(spec)).not.toMatch(/hunter|typed-secret/i);
    });
    it("adds the opening step when the first one was deleted, and finds steps on other sites", () => {
        const { spec } = buildRecordedSpec({ title: "No goto", startUrl: start, steps: steps.slice(3, 4) });
        expect((spec.steps as Array<{ action: string }>)[0]!.action).toBe("navigate");
        expect(foreignOrigins([{ index: 0, kind: "goto", url: "https://other.example/x", describe: "", at: "" }], start)).toEqual(["https://other.example"]);
        expect(foreignOrigins(steps, start)).toEqual([]);
    });
    it("refuses an empty recording", () => {
        expect(buildRecordedSpec({ title: "Nothing", startUrl: start, steps: steps.slice(0, 1) }).problems[0]).toMatch(/nothing to save/);
    });
});

describe("wiring", () => {
    it("recorded is a spec origin and its tests may be healed", () => {
        const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Recorded one", kind: "web", steps: [{ action: "navigate", url: "/" }], source: { origin: "recorded" } });
        expect(unhealableTest(spec)).toBeUndefined();
    });
});

describe("the injected script", () => {
    const src = recorderScript({ binding: "__rBinding", ctl: "__cCtl", token: "tok123" });
    it("is valid JavaScript with this session's names and the shared patterns filled in", () => {
        expect(() => new Function(src)).not.toThrow();
        expect(src).not.toContain("__CFG__");
        expect(src).not.toContain("__DYN__");
        expect(src).toContain('"binding":"__rBinding"');
        expect(src).toContain("tok123");
    });
    it("contains none of the literals the platform forbids in scripts", () => {
        for (const bad of ["sk-", "api_key", "TEST_PASSWORD", "password:"]) expect(src).not.toContain(bad);
    });
    it("never reads a secret field's value, and keeps its binding private", () => {
        // the fill path reads a value only in the branch that has no secret kind
        expect(src).toMatch(/if \(p\.kind\) ev\.secretKind = p\.kind;\s+else ev\.value =/);
        expect(src).toContain("delete window[CFG.binding]");
        expect(src).toContain("window.top !== window");
    });
});

describe("recordings on a shared server", () => {
    it("runs at most RECORDINGS_MAX recordings with a browser on this server, in all projects", async () => {
        const { RecorderService } = await import("../src/platform/recorder-service.js");
        // A browser that never finishes starting: the recordings stay "starting", which is what holds a place.
        const service = new RecorderService({ maxLocal: 2, launch: () => new Promise(() => undefined), guard: async () => undefined });
        service.start("p1", { url: "https://app.example/", headed: false });
        service.start("p2", { url: "https://app.example/", headed: false });
        expect(() => service.start("p3", { url: "https://app.example/", headed: false })).toThrow(/already running 2 recordings, its limit/);
        try {
            service.start("p3", { url: "https://app.example/", headed: false });
        } catch (e) {
            expect((e as { status?: number }).status).toBe(429);
        }
    });

    it("defaults to 2 (RECORDINGS_MAX)", async () => {
        const { loadConfig } = await import("../src/config.js");
        expect(loadConfig({}).RECORDINGS_MAX).toBe(2);
        expect(loadConfig({ RECORDINGS_MAX: "5" }).RECORDINGS_MAX).toBe(5);
    });
});
