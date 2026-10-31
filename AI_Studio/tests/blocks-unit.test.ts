/**
 * Reusable steps (blocks) without a browser or a server: the model's rules, parameter filling, expansion with its limits, the notes that fold
 * expanded steps back, the usage scan, the graph rules, what generators and the step editor's checks do with a spec that uses a block, and the
 * sign-in rule applied after expansion.
 */
import { describe, expect, it } from "vitest";
import {
    BLOCK_MARK,
    BlockError,
    MAX_BLOCK_BYTES,
    MAX_BLOCK_DEPTH,
    MAX_BLOCK_PARAMS,
    MAX_BLOCK_STEPS,
    MAX_EXPANDED_STEPS,
    blockClosure,
    blockGraphProblems,
    blockNames,
    checkBlockInput,
    collapseBlocks,
    expandBlocks,
    hasBlockMarks,
    indexBlocks,
    renameBlockRefs,
    scanBlockUsage,
    sourceIndexes,
    tryExpandBlocks,
    type BlockDef,
} from "../src/engine/blocks/index.js";
import { BUILDER_LIMITS, checkSpecInput, errorsOf } from "../src/engine/builder/index.js";
import { renderScript } from "../src/engine/generators/index.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { unhealableTest } from "../src/engine/healing/failure.js";
import { allowedCredentialOrigins, CREDENTIAL_ORIGIN_RULE, credentialOriginProblems } from "../src/engine/spec/credential-origin.js";
import { describeStep, StoredStepSchema, TestSpecSchema, type Step, type TestSpec } from "../src/engine/spec/schema.js";

const APP = "http://app.test:3000";
const web = (steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", steps, ...extra });
const api = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "API-001", title: "An API test", kind: "api", steps });
const use = (block: string, args?: Record<string, string>) => ({ action: "useBlock", block, ...(args ? { args } : {}) });
const field = (label: string, value: string) => ({ action: "fill", locator: { by: "label", value: label }, value });
const click = (name: string) => ({ action: "click", locator: { by: "role", role: "button", value: name } });

/** A block definition the way the platform holds it (steps already parsed). */
const def = (name: string, steps: unknown[], params: BlockDef["params"] = [], kind: BlockDef["kind"] = "web"): BlockDef => ({ name, kind, params, steps: steps.map((s) => StoredStepSchema.parse(s)) });
const signIn = def("Sign in", [{ action: "navigate", url: "/login" }, field("Email", "{{email}}"), field("Password", "{{password}}"), click("Sign in")], [{ name: "email", default: "me@example.test" }, { name: "password", default: "{{credentials.password}}" }]);
const index = (...defs: BlockDef[]) => indexBlocks(defs);
const actionsOf = (spec: TestSpec) => spec.steps.map((s) => s.action);

describe("the step and its wording", () => {
    it("is a step the schema accepts, with optional values, and a plain sentence", () => {
        const s = StoredStepSchema.parse(use("Sign in", { email: "a@b.test" }));
        expect(s).toMatchObject({ action: "useBlock", block: "Sign in", args: { email: "a@b.test" }, description: "" });
        expect(describeStep(s)).toBe("Run the reusable steps “Sign in”");
        expect(describeStep({ ...s, description: "Log the shopper in" })).toBe("Log the shopper in");
        expect(StoredStepSchema.safeParse({ action: "useBlock" }).success).toBe(false);
        expect(StoredStepSchema.safeParse(use("x".repeat(81))).success).toBe(false);
        expect(StoredStepSchema.safeParse(use("a", { k: "v".repeat(501) })).success).toBe(false);
    });
});

describe("checking a block", () => {
    const ok = { name: "  Sign   in ", kind: "web", params: [{ name: "email", default: "a@b.test" }], steps: [{ action: "navigate", url: "/login" }] };

    it("tidies the name and keeps what is valid", () => {
        const r = checkBlockInput(ok);
        expect(r.ok && r.block).toMatchObject({ name: "Sign in", kind: "web", params: [{ name: "email", default: "a@b.test" }] });
    });

    const bad: Array<[string, unknown, RegExp]> = [
        ["no name", { ...ok, name: "" }, /name/i],
        ["a name with markup", { ...ok, name: "bad <name>" }, /Names start with a letter/],
        ["a name that is too long", { ...ok, name: "n".repeat(81) }, /at most 80/],
        ["an unknown kind", { ...ok, kind: "tablet" }, /kind|Invalid/i],
        ["no steps", { ...ok, steps: [] }, /at least one step/i],
        [`more than ${MAX_BLOCK_STEPS} steps`, { ...ok, steps: Array.from({ length: MAX_BLOCK_STEPS + 1 }, () => ({ action: "wait", ms: 10 })) }, new RegExp(`at most ${MAX_BLOCK_STEPS} steps`)],
        ["a step the schema does not know", { ...ok, steps: [{ action: "teleport" }] }, /Step 1/],
        ["a step with a missing field", { ...ok, steps: [{ action: "click" }] }, /Step 1/],
        [`more than ${MAX_BLOCK_PARAMS} parameters`, { ...ok, params: Array.from({ length: MAX_BLOCK_PARAMS + 1 }, (_, i) => ({ name: `p${i}` })) }, /at most 10 parameters/],
        ["a parameter name with a dot", { ...ok, params: [{ name: "a.b" }] }, /letters, numbers and underscores/],
        ["a parameter name starting with a digit", { ...ok, params: [{ name: "1a" }] }, /must start with a letter/],
        ["a reserved parameter name", { ...ok, params: [{ name: "unique" }] }, /kept for the platform/],
        ["a parameter twice (any case)", { ...ok, params: [{ name: "a" }, { name: "A" }] }, /appears twice/],
        ["a default that is too long", { ...ok, params: [{ name: "a", default: "x".repeat(501) }] }, /too_big|at most|String/i],
        ["steps that are too large", { ...ok, steps: Array.from({ length: 30 }, () => ({ action: "navigate", url: "/" + "x".repeat(900) })) }, new RegExp(`${MAX_BLOCK_BYTES / 1000} KB`)],
    ];
    for (const [what, input, message] of bad) {
        it(`refuses ${what}, in plain words`, () => {
            const r = checkBlockInput(input);
            expect(r.ok).toBe(false);
            expect(!r.ok && r.error).toMatch(message);
        });
    }
});

describe("filling in parameters", () => {
    const t = (...defs: BlockDef[]) => index(...defs);

    it("uses the value given, else the default, and leaves other placeholders alone", () => {
        const b = def("Login", [field("Email", "{{email}}"), field("Note", "{{unique}} {{credentials.password}} {{ email }}")], [{ name: "email", default: "d@x.test" }]);
        const given = expandBlocks(web([use("Login", { email: "g@x.test" })]), t(b));
        expect(given.steps.map((s) => (s as { value: string }).value)).toEqual(["g@x.test", "{{unique}} {{credentials.password}} g@x.test"]);
        const dflt = expandBlocks(web([use("Login")]), t(b));
        expect((dflt.steps[0] as { value: string }).value).toBe("d@x.test");
        // an empty value is the same as none (a blank form field)
        expect((expandBlocks(web([use("Login", { email: "" })]), t(b)).steps[0] as { value: string }).value).toBe("d@x.test");
    });

    it("names the parameter that has no value", () => {
        const b = def("Login", [field("Email", "{{email}}")], [{ name: "email" }]);
        expect(() => expandBlocks(web([use("Login")]), t(b))).toThrow(/Step 1: The reusable steps “Login” need a value for “email”/);
    });

    it("refuses a value for a parameter the block does not have, and says which it has", () => {
        const b = def("Login", [field("Email", "{{email}}")], [{ name: "email", default: "a" }]);
        const r = tryExpandBlocks(web([use("Login", { mail: "x" })]), t(b));
        expect(!r.ok && r.error).toMatch(/no parameter “mail”.*They have: email/);
        const none = tryExpandBlocks(web([use("Plain", { a: "1" })]), t(def("Plain", [click("Go")])));
        expect(!none.ok && none.error).toMatch(/have no parameters/);
    });

    it("never looks again at a value it put in, and never evaluates it", () => {
        const b = def("Two", [field("A", "{{a}}"), field("B", "{{b}}")], [{ name: "a", default: "x" }, { name: "b", default: "y" }]);
        const out = expandBlocks(web([use("Two", { a: "{{b}}", b: "${process.exit(1)}`\"'\\" })]), t(b));
        // `{{b}}` given for a stays as text; the value with quotes and a template marker is data
        expect(out.steps.map((s) => (s as { value: string }).value)).toEqual(["{{b}}", "${process.exit(1)}`\"'\\"]);
        // and the generators escape it like any other text, so the script holds it as a plain string
        const script = renderScript(web([use("Two", { a: "ok", b: "${process.exit(1)}`\"'\\" })]), "playwright", { baseUrl: APP, blocks: t(b) }).content;
        expect(script).toContain(JSON.stringify("${process.exit(1)}`\"'\\"));
    });

    it("fills every text field of a step (request paths, headers, bodies) but not the words that say what a step does", () => {
        const b = def("Call", [{ action: "request", method: "POST", path: "/items/{{id}}", headers: { "x-name": "{{id}}" }, query: { q: "{{id}}" }, body: { a: ["{{id}}", { b: "{{id}}" }] }, auth: "default" }, { action: "assertResponse", check: "bodyContains", expected: "{{id}}" }], [{ name: "id", default: "7" }], "api");
        const out = expandBlocks(api([use("Call", { id: "42" })]), t(b));
        expect(JSON.parse(JSON.stringify(out.steps[0]))).toMatchObject({ action: "request", method: "POST", path: "/items/42", headers: { "x-name": "42" }, query: { q: "42" }, body: { a: ["42", { b: "42" }] }, auth: "default" });
        expect(out.steps[1]).toMatchObject({ action: "assertResponse", check: "bodyContains", expected: "42" });
    });

    it("keeps how an element is found and a shared element's name as they are", () => {
        const b = def("Pick", [{ action: "click", locator: { by: "text", value: "{{what}}" } }, { action: "click", locator: { ref: "Cart / Button" } }], [{ name: "what", default: "Buy" }]);
        const out = expandBlocks(web([use("Pick", { what: "by" })]), t(b));
        expect(out.steps[0]).toMatchObject({ locator: { by: "text", value: "by" } });
        expect(out.steps[1]).toMatchObject({ locator: { ref: "Cart / Button" } });
    });
});

describe("putting the steps in place", () => {
    it("returns the very same spec when no step uses a block (nothing changes for tests without blocks)", () => {
        const s = web([{ action: "navigate", url: "/" }]);
        expect(expandBlocks(s, undefined)).toBe(s);
        expect(expandBlocks(s, index(signIn))).toBe(s);
    });

    it("replaces the step with the block's steps, in order, and keeps the others", () => {
        const s = web([{ action: "navigate", url: "/" }, use("Sign in"), { action: "assert", check: "visible", locator: { by: "text", value: "Welcome" } }]);
        const out = expandBlocks(s, index(signIn));
        expect(actionsOf(out)).toEqual(["navigate", "navigate", "fill", "fill", "click", "assert"]);
        expect((out.steps[2] as { value: string }).value).toBe("me@example.test");
        expect(out.steps.some((x) => x.action === "useBlock")).toBe(false);
        // the spec it came from is not touched
        expect(actionsOf(s)).toEqual(["navigate", "useBlock", "assert"]);
        expect(blockNames(s)).toEqual(["Sign in"]);
    });

    it("names a block that is not in the project", () => {
        expect(() => expandBlocks(web([use("Nope")]), index(signIn))).toThrow(/“Nope”, which are not in this project/);
        expect(() => expandBlocks(web([use("Nope")]), undefined)).toThrow(/not in this project/);
    });

    it("lists every problem with the number of the step that has it", () => {
        try {
            expandBlocks(web([use("Nope"), { action: "navigate", url: "/" }, use("Sign in", { zzz: "1" })]), index(signIn));
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(BlockError);
            const p = (e as BlockError).problems;
            expect(p.map((x) => x.stepIndex)).toEqual([0, 2]);
            expect(p[0]!.message).toMatch(/^Step 1:/);
            expect(p[1]!.message).toMatch(/^Step 3:.*no parameter “zzz”/);
        }
    });

    it("refuses a block of another kind than the test, and lets an 'any' block into both", () => {
        const apiBlock = def("Ping", [{ action: "request", method: "GET", path: "/ping", auth: "none" }], [], "api");
        expect(() => expandBlocks(web([use("Ping")]), index(apiBlock))).toThrow(/are for API tests; this is a web test/);
        expect(() => expandBlocks(api([use("Sign in")]), index(signIn))).toThrow(/are for web tests; this is an API test/);
        const any = def("Wait a bit", [{ action: "wait", ms: 100 }], [], "any");
        expect(expandBlocks(web([use("Wait a bit")]), index(any)).steps).toHaveLength(1);
        expect(expandBlocks(api([use("Wait a bit")]), index(any)).steps).toHaveLength(1);
    });

    it("lets blocks use blocks, and passes a parameter on through the call", () => {
        const outer = def("Shop login", [use("Sign in", { email: "{{who}}" }), click("Shop")], [{ name: "who", default: "shopper@example.test" }]);
        const out = expandBlocks(web([use("Shop login", { who: "boss@example.test" })]), index(signIn, outer));
        expect((out.steps[1] as { value: string }).value).toBe("boss@example.test");
        expect(actionsOf(out)).toEqual(["navigate", "fill", "fill", "click", "click"]);
    });

    it(`allows ${MAX_BLOCK_DEPTH} levels and refuses the next one, naming the chain`, () => {
        const c = def("C", [click("c")]);
        const b = def("B", [use("C")]);
        const a = def("A", [use("B")]);
        expect(expandBlocks(web([use("A")]), index(a, b, c)).steps).toHaveLength(1);
        const d = def("D", [use("A")]);
        const r = tryExpandBlocks(web([use("D")]), index(a, b, c, d));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/at most 3 levels deep.*“D”, which uses “A”, which uses “B”, which uses “C”/);
    });

    it("refuses a circle and names it", () => {
        const a = def("A", [use("B")]);
        const b = def("B", [use("A")]);
        const r = tryExpandBlocks(web([use("A")]), index(a, b));
        expect(!r.ok && r.error).toMatch(/in a circle: “A”, which uses “B”, which uses “A”/);
        const self = def("Self", [use("Self")]);
        expect(tryExpandBlocks(web([use("Self")]), index(self)).ok).toBe(false);
    });

    it(`refuses a test that would pass ${MAX_EXPANDED_STEPS} steps once the blocks are in place, without running away on nested blocks`, () => {
        const wide = def("Wide", Array.from({ length: MAX_BLOCK_STEPS }, () => click("x")));
        expect(expandBlocks(web([use("Wide"), use("Wide")]), index(wide)).steps).toHaveLength(80);
        const r = tryExpandBlocks(web([use("Wide"), use("Wide"), use("Wide")]), index(wide));
        expect(!r.ok && r.error).toMatch(/more than 100 steps/);
        // 40 x 40 x 40 nested uses would be 64 000 steps: it stops at the cap
        const l3 = def("L3", Array.from({ length: MAX_BLOCK_STEPS }, () => click("y")));
        const l2 = def("L2", Array.from({ length: MAX_BLOCK_STEPS }, () => use("L3")));
        const l1 = def("L1", Array.from({ length: MAX_BLOCK_STEPS }, () => use("L2")));
        const started = Date.now();
        expect(tryExpandBlocks(web([use("L1")]), index(l1, l2, l3)).ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it("maps each step that runs back to the step the person sees", () => {
        const s = web([{ action: "navigate", url: "/" }, use("Sign in"), click("Done")]);
        const out = expandBlocks(s, index(signIn));
        expect(sourceIndexes(s, out)).toEqual([0, 1, 1, 1, 1, 2]);
        expect(sourceIndexes(s, s)).toEqual([0, 1, 2]);
    });

    it("renames a use everywhere in a list of steps and returns the same object when nothing uses the old name", () => {
        const s = web([use("A"), click("x"), use("A", { k: "v" })]);
        expect(renameBlockRefs(s, "A", "Z").steps.map((x) => (x as { block?: string }).block)).toEqual(["Z", undefined, "Z"]);
        expect(renameBlockRefs(s, "Q", "Z")).toBe(s);
    });
});

describe("folding expanded steps back", () => {
    const stored = web([{ action: "navigate", url: "/" }, use("Sign in", { email: "a@b.test" }), click("Done")]);

    it("turns unchanged expanded steps back into the one step they came from", () => {
        const out = expandBlocks(stored, index(signIn));
        expect(hasBlockMarks(out)).toBe(true);
        // an engine copies steps while it works (a spread, a JSON round trip): the notes travel with them
        const copied = { ...out, steps: JSON.parse(JSON.stringify(out.steps)) as Step[] };
        const back = collapseBlocks(copied);
        expect(back.steps).toEqual(stored.steps);
        expect(JSON.stringify(back)).not.toContain(BLOCK_MARK);
    });

    it("leaves a spec without notes alone (the same object)", () => {
        expect(collapseBlocks(stored)).toBe(stored);
    });

    it("keeps plain steps, without notes, when a step of the group was changed on the way (a repair)", () => {
        const out = expandBlocks(stored, index(signIn));
        const steps = out.steps.map((s, i) => (i === 3 ? ({ ...s, value: "something else" } as Step) : s));
        const back = collapseBlocks({ ...out, steps });
        expect(actionsOf(back)).toEqual(["navigate", "navigate", "fill", "fill", "click", "click"]);
        expect((back.steps[3] as { value: string }).value).toBe("something else");
        expect(JSON.stringify(back)).not.toContain(BLOCK_MARK);
    });

    it("keeps plain steps when part of the group is gone", () => {
        const out = expandBlocks(stored, index(signIn));
        const back = collapseBlocks({ ...out, steps: out.steps.filter((_, i) => i !== 2) });
        expect(back.steps).toHaveLength(5);
        expect(back.steps.some((s) => s.action === "useBlock")).toBe(false);
    });

    it("folds two uses of the same block separately, and still folds when shared elements were resolved in the steps", () => {
        const withRef = def("Click it", [{ action: "click", locator: { ref: "Shop / Buy" } }]);
        const two = web([use("Click it"), use("Click it")]);
        const out = expandBlocks(two, index(withRef));
        // what the object repository does to a step: the concrete locator, with the name next to it
        const resolved = { ...out, steps: out.steps.map((s) => ({ ...s, locator: { by: "role", role: "button", value: "Buy", ref: "Shop / Buy" } }) as unknown as Step) };
        expect(collapseBlocks(resolved).steps).toEqual(two.steps);
    });
});

describe("who uses a block", () => {
    const a = def("A", [click("a")]);
    const b = def("B", [use("A"), click("b")]);
    const c = def("C", [use("B")]);
    const tests = [
        { id: "t1", testKey: "WEB-001", title: "One", spec: web([use("A"), use("A")]) },
        { id: "t2", testKey: "WEB-002", title: "Two", spec: web([use("C")]) },
        { id: "t3", testKey: "WEB-003", title: "Three", spec: web([click("z")]) },
    ];

    it("counts direct and indirect users, and the blocks that use a block directly", () => {
        const u = scanBlockUsage(tests, [a, b, c]);
        expect(u.get("A")!.tests.map((t) => [t.testKey, t.steps])).toEqual([["WEB-001", 2], ["WEB-002", 1]]);
        expect(u.get("A")!.blocks).toEqual(["B"]);
        expect(u.get("B")!.tests.map((t) => t.testKey)).toEqual(["WEB-002"]);
        expect(u.get("B")!.blocks).toEqual(["C"]);
        expect(u.get("C")!.blocks).toEqual([]);
        expect(u.has("Z")).toBe(false);
    });

    it("walks the graph without looping on a circle", () => {
        const x = def("X", [use("Y")]);
        const y = def("Y", [use("X")]);
        expect([...blockClosure(["X"], index(x, y))].sort()).toEqual(["X", "Y"]);
    });
});

describe("how blocks may use each other", () => {
    it("is fine for a chain of three, names a circle, and refuses a chain of four", () => {
        const chain = (n: number) => indexBlocks(Array.from({ length: n }, (_, i) => def(`B${i}`, [i + 1 < n ? use(`B${i + 1}`) : click("end")])));
        expect(blockGraphProblems(chain(3))).toEqual([]);
        expect(blockGraphProblems(chain(4))[0]).toMatch(/“B0” reach 4 levels.*at most 3/);
        const loop = index(def("P", [use("Q")]), def("Q", [use("P")]));
        expect(blockGraphProblems(loop)[0]).toMatch(/in a circle: “P”, which uses “Q”, which uses “P”/);
    });
});

describe("what generators see", () => {
    const ctx = { baseUrl: APP };

    it("renders a spec that uses a block exactly like the same steps written out, and the script never mentions the block", () => {
        const withBlock = web([{ action: "navigate", url: "/" }, use("Sign in")]);
        // the same steps with the defaults written out by hand
        const filled = web([{ action: "navigate", url: "/" }, { action: "navigate", url: "/login" }, field("Email", "me@example.test"), field("Password", "{{credentials.password}}"), click("Sign in")]);
        const script = renderScript(withBlock, "playwright", { ...ctx, blocks: index(signIn) });
        expect(script.content).toBe(renderScript(filled, "playwright", ctx).content);
        expect(script.content).not.toMatch(/useBlock|reusable/i);
    });

    it("never hands a block step to a generator: asked directly it refuses, and through the renderer without the blocks it names the problem", () => {
        const s = web([use("Sign in")]);
        expect(() => playwrightGenerator.render(s, ctx)).toThrow(/were not expanded before the script was rendered/);
        expect(() => renderScript(s, "playwright", ctx)).toThrow(/“Sign in”, which are not in this project/);
    });

    it("renders a test without blocks byte for byte as before, whether or not the project has blocks", () => {
        const plain = web([{ action: "navigate", url: "/" }, click("Go")]);
        expect(renderScript(plain, "playwright", { ...ctx, blocks: index(signIn) }).content).toBe(renderScript(plain, "playwright", ctx).content);
    });

    it("renders an API test that uses an API block", () => {
        const call = def("Health", [{ action: "request", method: "GET", path: "/health", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }], [], "api");
        const script = renderScript(api([use("Health")]), "playwright-api", { baseUrl: APP, blocks: index(call) }).content;
        expect(script).toContain("/health");
        expect(script).not.toContain("useBlock");
    });
});

describe("the sign-in rule after expansion", () => {
    const away = def("Elsewhere", [{ action: "navigate", url: "https://other.example/login" }, field("Password", "{{credentials.password}}")]);

    it("catches a block that leaves the application's own site and then types the stored password", () => {
        const spec = web([use("Elsewhere")]);
        // on the stored spec nothing looks wrong: the rule has to be asked of the steps that will run
        expect(credentialOriginProblems(spec, allowedCredentialOrigins("web", APP))).toEqual([]);
        const expanded = expandBlocks(spec, index(away));
        const problems = credentialOriginProblems(expanded, allowedCredentialOrigins("web", APP));
        expect(problems.map((p) => p.stepIndex)).toEqual([1]);
        expect(problems[0]!.message).toContain(CREDENTIAL_ORIGIN_RULE);
        expect(() => renderScript(spec, "playwright", { baseUrl: APP, blocks: index(away) })).toThrow(new RegExp(CREDENTIAL_ORIGIN_RULE));
    });

    it("sees the rule broken by a value given to a parameter", () => {
        const fillIt = def("Type", [field("Password", "{{value}}")], [{ name: "value", default: "x" }]);
        const spec = web([{ action: "navigate", url: "https://other.example/" }, use("Type", { value: "{{credentials.password}}" })]);
        const expanded = expandBlocks(spec, index(fillIt));
        expect(credentialOriginProblems(expanded, allowedCredentialOrigins("web", APP)).map((p) => p.stepIndex)).toEqual([1]);
    });
});

describe("the step editor's checks", () => {
    const base = { testId: "WEB-001", kind: "web" as const, category: "General", source: { origin: "manual" as const } };
    const input = (steps: unknown[]) => ({ title: "A test", steps });
    const check = (steps: unknown[], blocks = index(signIn)) => checkSpecInput(input(steps), { ...base, blocks });
    const messages = (r: ReturnType<typeof check>) => errorsOf(r.diagnostics).map((d) => d.message);

    it("accepts a use of a block and keeps the stored step as it is", () => {
        const r = check([use("Sign in"), click("Done")]);
        expect(messages(r)).toEqual([]);
        expect(r.spec!.steps[0]).toMatchObject({ action: "useBlock", block: "Sign in" });
    });

    it("says which step names a block that does not exist, and that a value is missing", () => {
        expect(messages(check([click("a"), use("Nope")]))).toEqual([expect.stringMatching(/^Step 2: .*“Nope”.*not in this project/)]);
        const needs = def("Needs", [field("Email", "{{email}}")], [{ name: "email" }]);
        const r = check([use("Needs")], index(needs));
        expect(messages(r)).toEqual([expect.stringMatching(/^Step 1: .*need a value for “email”/)]);
        expect(errorsOf(r.diagnostics)[0]!.stepIndex).toBe(0);
    });

    it("refuses a typed secret given to a parameter, on the step that gives it", () => {
        const r = check([use("Sign in", { password: "hunter2-for-real" })]);
        expect(messages(r)).toEqual([expect.stringMatching(/^Step 1: in the reusable steps “Sign in”, this field holds a secret/)]);
        expect(messages(check([use("Sign in", { password: "{{credentials.password}}" })]))).toEqual([]);
        expect(messages(check([use("Sign in", { email: "sk-abcdefghijklmnopqrstuvwxyz" })]))).not.toEqual([]);
    });

    it("applies the kind rule to the steps a block brings", () => {
        const wrong = def("Odd", [{ action: "request", method: "GET", path: "/x", auth: "none" }], [], "any");
        expect(messages(check([use("Odd")], index(wrong)))).toEqual([expect.stringMatching(/belongs in an API test/)]);
    });

    it(`counts the steps a test would have with the blocks in place against the ${BUILDER_LIMITS.steps} step cap`, () => {
        const wide = def("Wide", Array.from({ length: MAX_BLOCK_STEPS }, () => click("x")));
        expect(messages(check([use("Wide"), use("Wide"), use("Wide")], index(wide)))[0]).toMatch(/more than 100 steps/);
    });
});

describe("other code that reads steps", () => {
    it("does not offer to repair a test that uses reusable steps, stored or expanded", () => {
        const base = { source: { origin: "manual" as const } };
        const stored = web([use("Sign in")], base);
        expect(unhealableTest(stored)).toMatch(/reusable steps/);
        expect(unhealableTest(expandBlocks(stored, index(signIn)))).toMatch(/reusable steps/);
        expect(unhealableTest(web([click("a")], base))).toBeUndefined();
    });
});
