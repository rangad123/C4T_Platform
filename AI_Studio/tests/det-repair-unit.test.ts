/**
 * "No AI where it is not needed" without a browser, a phone or a model (fast tier):
 *   - the plain repair rules for web and phone tests, kind by kind (shared element, role and name, same text, moved), and what they refuse;
 *   - phone repair end to end on an in-memory phone: a rule's pick is tried once and suggested, and the model is NOT asked; with the switch
 *     off, or when the rules find nothing, the model is asked as before;
 *   - shared elements' other locators: checked, stored next to the locator without a migration, returned only when there are some;
 *   - exploration reuse: which pages count as unchanged, the one-line prompt, the earlier understanding kept;
 *   - the switches (Settings beats the environment beats the default), their API and the job's AI usage answer;
 *   - the savings comparison's options, numbers and verdict rules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import type { Candidate } from "../src/engine/healing/candidates.js";
import { matchesRule, optionsFor, ruleMatches } from "../src/engine/healing/deterministic.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { envSwitch, setWithoutAiSource, withoutAiSetting } from "../src/engine/llm/without-ai.js";
import { checkElement, indexOf } from "../src/engine/locators/index.js";
import { distillKnowledge, understandingFingerprint } from "../src/engine/memory/distill.js";
import { planReuse, reuseMessage } from "../src/engine/memory/reuse.js";
import type { DeviceSession, ScreenElement, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { phoneDeterministicPicks, phoneMatchesRule } from "../src/engine/mobile/repair/deterministic.js";
import { proposePhoneRepair, REPAIR_SYSTEM } from "../src/engine/mobile/repair/phone-repair.js";
import type { Locator, TestSpec } from "../src/engine/spec/schema.js";
import { analyzeApplication, REUSE_NOTE } from "../src/engine/understanding/analyzer.js";
import type { AppModel, PageModel } from "../src/engine/understanding/app-model.js";
import type { ScriptRun } from "../src/engine/validation/runner.js";
import { compareMarkdown, compareRuns, DEFAULT_MARGINS, parseMargins, parseToggles } from "../src/eval/compare.js";
import { parseArgs } from "../src/eval/cli.js";
import type { EntryResult, EvalRun } from "../src/eval/run.js";
import { EvalRunSchema } from "../src/eval/run.js";
import { bootstrap } from "../src/platform/bootstrap.js";
import { LocatorStore } from "../src/platform/locator-store.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { buildServer } from "../src/platform/server.js";

const tmpDirs: string[] = [];
afterAll(() => {
    setWithoutAiSource(undefined);
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// ── web rules ─────────────────────────────────────────────────────────────────
let key = 0;
const cand = (over: Partial<Candidate>): Candidate => ({ key: key++, tag: "button", role: "button", name: "", text: "", ownsText: true, testId: null, label: null, placeholder: null, id: null, classes: [], nameAttr: null, type: null, container: "main", disabled: false, ...over });
const role = (r: string, value: string, exact = true): Locator => ({ by: "role", role: r, value, exact });

describe("web: the plain repair rules", () => {
    it("role-name: the same role with a name that reads or means the same, never one that means the opposite", () => {
        expect(matchesRule("role-name", role("button", "Sign In"), cand({ name: "Sign in", text: "Sign in" }))).toBe(true);
        expect(matchesRule("role-name", role("button", "Add to cart"), cand({ name: "Add to basket" }))).toBe(true);
        expect(matchesRule("role-name", role("button", "Sign in"), cand({ name: "Log in" }))).toBe(true);
        expect(matchesRule("role-name", role("button", "Add to cart"), cand({ name: "Remove from cart" }))).toBe(false);
        expect(matchesRule("role-name", role("button", "Add to cart"), cand({ name: "Add to wishlist" }))).toBe(false);
        // Similar is not the same: "Save draft" vs "Save" is left to the model.
        expect(matchesRule("role-name", role("button", "Save draft"), cand({ name: "Save" }))).toBe(false);
        // Another role is not this rule.
        expect(matchesRule("role-name", role("button", "Sign in"), cand({ role: "link", tag: "a", name: "Sign in" }))).toBe(false);
        // A text locator: a control whose accessible name reads the same (an icon button with a label).
        expect(matchesRule("role-name", { by: "text", value: "Search" }, cand({ name: "Search", text: "", ownsText: false }))).toBe(true);
        expect(matchesRule("role-name", { by: "label", value: "E-mail" }, cand({ role: "textbox", tag: "input", name: "e-mail", text: "" }))).toBe(true);
    });

    it("same-text: an element showing the same text, a field whose hint reads like its old label (and the reverse)", () => {
        expect(matchesRule("same-text", role("button", "Checkout"), cand({ role: "link", tag: "a", name: "Checkout", text: "Checkout" }))).toBe(true);
        expect(matchesRule("same-text", { by: "text", value: "Order now!" }, cand({ text: "order now" }))).toBe(true);
        expect(matchesRule("same-text", { by: "text", value: "Order now" }, cand({ text: "Order now", ownsText: false }))).toBe(false);
        expect(matchesRule("same-text", { by: "label", value: "Your e-mail" }, cand({ role: "textbox", tag: "input", placeholder: "Your e-mail", text: "" }))).toBe(true);
        expect(matchesRule("same-text", { by: "placeholder", value: "Search" }, cand({ role: "searchbox", tag: "input", label: "Search", text: "" }))).toBe(true);
        expect(matchesRule("same-text", { by: "testId", value: "Checkout" }, cand({ text: "Checkout" }))).toBe(false);
    });

    it("moved: the old test id or every part of the CSS selector's last element carried by the element itself", () => {
        expect(matchesRule("moved", { by: "testId", value: "buy-now" }, cand({ id: "buy-now" }))).toBe(true);
        expect(matchesRule("moved", { by: "testId", value: "buy_now" }, cand({ nameAttr: "buyNow" }))).toBe(true);
        expect(matchesRule("moved", { by: "css", value: "div.cart > button.buy-now" }, cand({ classes: ["primary", "buy-now"] }))).toBe(true);
        expect(matchesRule("moved", { by: "css", value: "#basket button#checkout.big" }, cand({ id: "checkout", classes: ["big"] }))).toBe(true);
        expect(matchesRule("moved", { by: "css", value: "button#checkout.big" }, cand({ id: "checkout", classes: [] }))).toBe(false);
        expect(matchesRule("moved", { by: "css", value: "a.buy-now" }, cand({ classes: ["buy-now"] }))).toBe(false); // another tag
        expect(matchesRule("moved", role("button", "Buy"), cand({ id: "Buy" }))).toBe(false);
    });

    it("a rule counts only with exactly one match the step can use; locators come in the rule's own order", () => {
        const two = [cand({ name: "Sign in" }), cand({ name: "Sign in", tag: "button" })];
        expect(ruleMatches(role("button", "Sign In"), "click", two, true)).toEqual([]);
        const disabled = [cand({ name: "Sign in", disabled: true }), cand({ role: "link", tag: "a", name: "Help", text: "Help" })];
        expect(ruleMatches(role("button", "Sign In"), "click", disabled, true)).toEqual([]);
        const field = cand({ role: "button", name: "Email", text: "Email" });
        expect(ruleMatches({ by: "label", value: "Email" }, "fill", [field], true)).toEqual([]); // a fill step cannot mean a button
        const link = cand({ role: "link", tag: "a", name: "Checkout", text: "Checkout", testId: "co" });
        const [m] = ruleMatches(role("button", "Checkout"), "click", [link], true);
        expect(m!.kind).toBe("same-text");
        expect(optionsFor("same-text", role("button", "Checkout"), link)).toEqual([{ by: "text", value: "Checkout", exact: true }, { by: "role", role: "link", value: "Checkout", exact: true }, { by: "testId", value: "co" }]);
        expect(optionsFor("moved", { by: "css", value: ".x" }, cand({ id: "buy-now", name: "Buy" }))[0]).toEqual({ by: "css", value: "#buy-now" });
    });
});

// ── phone rules ───────────────────────────────────────────────────────────────
const el = (index: number, over: Partial<ScreenElement>): ScreenElement => ({ index, cls: "Button", text: "", desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, index * 100, 200, index * 100 + 80], ...over });

describe("phone: the plain repair rules", () => {
    it("each rule, with exactly one match", () => {
        expect(phoneMatchesRule("role-name", role("button", "Sign In"), el(1, { text: "Sign in" }))).toBe(true);
        expect(phoneMatchesRule("role-name", { by: "text", value: "Cart" }, el(1, { desc: "cart" }))).toBe(true);
        expect(phoneMatchesRule("same-text", { by: "label", value: "Basket" }, el(1, { text: "basket" }))).toBe(true);
        expect(phoneMatchesRule("same-text", { by: "text", value: "Log in" }, el(1, { text: "Log in", password: true }))).toBe(false);
        expect(phoneMatchesRule("moved", { by: "testId", value: "login_button" }, el(1, { id: "loginButton" }))).toBe(true);
        expect(phoneMatchesRule("moved", { by: "testId", value: "signin_old" }, el(1, { id: "signin_button" }))).toBe(false);
        const screen = [el(0, { text: "Sign in" }), el(1, { text: "Sign in" })];
        expect(phoneDeterministicPicks(role("button", "Sign In"), screen, screen)).toEqual([]);
        const one = [el(0, { text: "Cart", id: "cart" }), el(1, { text: "Sign in", id: "go" })];
        expect(phoneDeterministicPicks(role("button", "Sign In"), one, one).map((p) => [p.kind, p.element.index])).toEqual([["role-name", 1]]);
        // A shared element's other locator comes first, and is used as it is.
        const picks = phoneDeterministicPicks({ by: "testId", value: "gone" }, one, one, [{ by: "testId", value: "cart" }]);
        expect(picks).toEqual([{ kind: "shared-element", element: one[0], locator: { by: "testId", value: "cart" } }]);
    });
});

// ── phone repair on an in-memory phone ────────────────────────────────────────
const PKG = "com.example.shop";
const screenOf = (elements: ScreenElement[]): ScreenSnapshot => ({ package: PKG, width: 1080, height: 1920, elements, fingerprint: elements.map((e) => e.text).join("|"), keyboard: false, outsideApp: false });
function fakePhone(elements: ScreenElement[]): { open: NonNullable<EngineContext["openDevice"]>; closed: () => number } {
    let closed = 0;
    const snap = screenOf(elements);
    const session: DeviceSession = { kind: "local", deviceName: "memory", snapshot: async () => snap, act: async () => ({ ok: true, snapshot: snap }), close: async () => void closed++ };
    return { open: async () => session, closed: () => closed };
}
const phoneSpec = (locator: Locator): TestSpec => ({ testId: "MOB-001", title: "Open the cart", kind: "mobile", type: "functional", category: "Phone", priority: "high", tags: [], preconditions: [], testData: {}, steps: [{ action: "click", locator }], expectedResults: [], source: { origin: "exploration" } }) as unknown as TestSpec;
const missing = (): ScriptRun => ({ testId: "MOB-001", status: "failed", durationMs: 10, failedStepIndex: 0, steps: [{ index: 0, title: "tap", status: "failed", error: 'locator.click: element(s) not found' }], artifacts: [], responses: [] }) as unknown as ScriptRun;
const passed = (): ScriptRun => ({ testId: "MOB-001", status: "passed", durationMs: 10, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }) as unknown as ScriptRun;

function countingModel(pickIndex: number | null) {
    const calls: string[] = [];
    const llm: LlmClient = {
        modelName: "scripted",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async ({ system }: { system: string }) => {
            calls.push(system);
            if (system !== REPAIR_SYSTEM) throw new Error("unexpected");
            return { index: pickIndex, reason: "The same control" };
        }) as LlmClient["object"],
    };
    return { llm, calls };
}

describe("phone repair: without AI first", () => {
    const screen = [el(0, { text: "Products", id: "products" }), el(1, { text: "Cart", id: "basket_link" })];

    it("a rule's pick is tried once and suggested; the model is not asked", async () => {
        const phone = fakePhone(screen);
        const m = countingModel(null);
        const events: Array<{ kind: string; message: string; data?: unknown }> = [];
        const reruns: TestSpec[] = [];
        const r = await proposePhoneRepair({
            ctx: { llm: m.llm, emit: (e) => events.push(e), openDevice: phone.open, config: {} as Config },
            spec: phoneSpec({ by: "text", value: "cart!" }),
            run: missing(),
            target: { appPackage: PKG } as never,
            rerun: async (s) => (reruns.push(s), passed()),
        });
        expect(m.calls).toEqual([]);
        expect(reruns).toHaveLength(1);
        expect(r.status).toBe("proposed");
        if (r.status !== "proposed") return;
        expect(r.proposal.newLocator).toEqual({ by: "testId", value: "basket_link" });
        expect(r.proposal.reason).toBe("Found without AI: the text “cart!” is not on the phone's screen at this step, and “Cart” is (found by the same text). The test passed when it was run once with it.");
        expect(events.find((e) => e.kind === "repaired_without_ai")?.data).toEqual({ testId: "MOB-001", kind: "same-text", stepIndex: 0 });
        expect(phone.closed()).toBe(1);
    });

    it("with the switch off, or when no rule picks anything, the model is asked as before", async () => {
        for (const [config, locator] of [[{ LLM_DETERMINISTIC_REPAIR: "false" }, { by: "text", value: "cart!" }], [{}, { by: "testId", value: "nothing_alike" }]] as Array<[Partial<Config>, Locator]>) {
            const m = countingModel(1);
            const r = await proposePhoneRepair({ ctx: { llm: m.llm, emit: () => undefined, openDevice: fakePhone(screen).open, config: config as Config }, spec: phoneSpec(locator), run: missing(), target: { appPackage: PKG } as never, rerun: async () => passed() });
            expect(m.calls).toHaveLength(1);
            expect(r.status).toBe("proposed");
            if (r.status === "proposed") expect(r.proposal.reason).toMatch(/^The AI looked at the phone's screen/);
        }
    });

    it("a pick with which the test still fails is not suggested; the model is asked next", async () => {
        const m = countingModel(null);
        const events: string[] = [];
        let n = 0;
        const r = await proposePhoneRepair({ ctx: { llm: m.llm, emit: (e) => events.push(e.kind), openDevice: fakePhone(screen).open }, spec: phoneSpec({ by: "text", value: "cart!" }), run: missing(), target: { appPackage: PKG } as never, rerun: async () => (n++, missing()) });
        expect(n).toBe(1);
        expect(events).toContain("repair_without_ai_tried");
        expect(m.calls).toHaveLength(1);
        expect(r).toMatchObject({ status: "none" });
    });
});

// ── shared elements' other locators ───────────────────────────────────────────
describe("shared elements: other ways to find the same element", () => {
    it("are checked like the locator, without duplicates or the locator itself, and left out when there are none", () => {
        const base = { name: "Save button", kind: "web", locator: { by: "testId", value: "save" } };
        expect(checkElement(base)).toEqual({ ok: true, element: { name: "Save button", kind: "web", locator: { by: "testId", value: "save" } } });
        const c = checkElement({ ...base, alternatives: [{ by: "role", role: "button", value: "Save" }, { by: "testId", value: "save" }, { role: "button", by: "role", value: "Save" }] });
        expect(c).toEqual({ ok: true, element: { ...base, alternatives: [{ by: "role", role: "button", value: "Save" }] } });
        expect(checkElement({ ...base, alternatives: [{ by: "role" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/^Another way to find the element: A role locator needs the role/) });
        expect(checkElement({ ...base, alternatives: Array.from({ length: 5 }, (_, i) => ({ by: "text", value: `t${i}` })) })).toMatchObject({ ok: false });
        expect(checkElement({ ...base, alternatives: [{ ref: "Other" }] })).toMatchObject({ ok: false });
        expect(indexOf([{ name: "A", kind: "web", locator: { by: "css", value: "#a" } }]).get("A")).toEqual({ kind: "web", locator: { by: "css", value: "#a" } });
    });

    it("are stored next to the locator (no migration); a stored element without them reads exactly as before", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-det-unit-"));
        tmpDirs.push(dir);
        const platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
        try {
            const server = await buildServer(platform);
            const projectId = (await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Shared" } })).json().id as string;
            const plain = await server.inject({ method: "POST", url: `/api/projects/${projectId}/objects`, payload: { name: "Plain", kind: "web", locator: { by: "testId", value: "p" } } });
            expect(plain.statusCode).toBe(201);
            expect(plain.json()).not.toHaveProperty("alternatives");
            const store = new LocatorStore(platform.db);
            expect(platform.db.get<{ locator_json: string }>("SELECT locator_json FROM locator_elements WHERE name = 'Plain'")!.locator_json).toBe('{"by":"testId","value":"p"}');
            const made = await server.inject({ method: "POST", url: `/api/projects/${projectId}/objects`, payload: { name: "Save", kind: "web", locator: { by: "testId", value: "save" }, alternatives: [{ by: "role", role: "button", value: "Save changes", exact: true }] } });
            expect(made.statusCode, made.body).toBe(201);
            expect(made.json().alternatives).toEqual([{ by: "role", role: "button", value: "Save changes", exact: true }]);
            expect(made.json().locator).toEqual({ by: "testId", value: "save" });
            expect(store.index(projectId)!.get("Save")).toEqual({ kind: "web", locator: { by: "testId", value: "save" }, alternatives: [{ by: "role", role: "button", value: "Save changes", exact: true }] });
            // A new locator keeps them; [] removes them.
            const moved = await server.inject({ method: "PUT", url: `/api/projects/${projectId}/objects/${made.json().id}`, payload: { locator: { by: "testId", value: "save-2" } } });
            expect(moved.json().alternatives).toHaveLength(1);
            const cleared = await server.inject({ method: "PUT", url: `/api/projects/${projectId}/objects/${made.json().id}`, payload: { alternatives: [] } });
            expect(cleared.statusCode, cleared.body).toBe(200);
            expect(cleared.json()).not.toHaveProperty("alternatives");
            await server.close();
        } finally {
            platform.db.close();
        }
    });
});

// ── exploration reuse ─────────────────────────────────────────────────────────
const page = (p: string, over: Partial<PageModel> = {}): PageModel => ({
    url: `http://shop.test${p}`, path: p, title: `Title of ${p}`, type: "content", depth: 1, status: 200, headings: [`Heading of ${p}`], forms: [], components: [{ role: "link", name: `Go to ${p}`, locatorHint: "" }], links: [], aria: `ARIA-SNAPSHOT-OF ${p}`, text: "", apiCalls: [], revealed: [], consoleErrors: [], ...over,
});
const appModel = (pages: PageModel[]): AppModel => ({
    url: "http://shop.test/", origin: "http://shop.test", siteType: "ecommerce", purpose: "Sells things", features: [], navigation: [], apis: [], pages, journeys: [], externalDependencies: [], documentedTestCases: [],
    authentication: { required: false, mechanisms: [], loggedIn: false }, stats: { pagesVisited: pages.length, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
});

describe("exploration reuse", () => {
    const before = appModel([page("/", { purpose: "The shop's front page", type: "home" }), page("/products", { purpose: "Lists the products", type: "listing" }), page("/about")]);
    const known = distillKnowledge(before, { now: new Date("2026-10-01T10:00:00Z") });

    it("remembers what the AI understood and a stricter fingerprint, as hashes and one scrubbed sentence", () => {
        expect(known.pages.find((p) => p.path === "/")).toMatchObject({ purpose: "The shop's front page", ufp: expect.stringMatching(/^[0-9a-f]{16}$/) });
        expect(known.pages.find((p) => p.path === "/about")).not.toHaveProperty("purpose");
        // A renamed button, a new API call or a new title changes it; a counter does not.
        const p = page("/x", { components: [{ role: "button", name: "Add to cart (3)", locatorHint: "" }] });
        expect(understandingFingerprint(p)).toBe(understandingFingerprint({ ...p, components: [{ role: "button", name: "Add to cart (4)", locatorHint: "" }] }));
        expect(understandingFingerprint(p)).not.toBe(understandingFingerprint({ ...p, components: [{ role: "button", name: "Add to basket", locatorHint: "" }] }));
        expect(understandingFingerprint(p)).not.toBe(understandingFingerprint({ ...p, apiCalls: ["GET /api/cart"] }));
        expect(JSON.stringify(known)).not.toContain("ARIA-SNAPSHOT");
    });

    it("counts a page as unchanged only with the same address and both fingerprints; older records without the second are sent again", () => {
        const now = appModel([page("/"), page("/products", { components: [{ role: "button", name: "Filter", locatorHint: "" }] }), page("/about"), page("/new")]);
        const plan = planReuse(known, now);
        expect([...plan.pages.keys()]).toEqual(["/", "/about"]);
        expect(plan.pages.get("/")).toEqual({ type: "home", purpose: "The shop's front page" });
        expect(plan.pages.get("/about")).toEqual({ type: "content" });
        expect(reuseMessage(plan, 4)).toBe("2 of 4 pages have not changed since the exploration of 2026-10-01: what the AI understood about them then is used, and they are not sent to the AI again (/, /about).");
        const old = { ...known, pages: known.pages.map(({ ufp: _u, ...p }) => p) };
        expect(planReuse(old, now).pages.size).toBe(0);
    });

    it("the understanding prompt gets one line per unchanged page (no snapshot), and keeps the earlier understanding when the AI leaves it out", async () => {
        const prompts: string[] = [];
        const llm = {
            modelName: "scripted",
            usage: { inputTokens: 0, outputTokens: 0 },
            text: async () => "",
            object: async ({ prompt }: { prompt: string }) => {
                prompts.push(prompt);
                return { siteType: "ecommerce", purpose: "Sells", features: [], pagePurposes: [{ path: "/new", type: "content", purpose: "New page" }], journeys: [], authenticationMechanisms: [] };
            },
        } as unknown as LlmClient;
        const ctx = { config: {}, llm, emit: () => undefined } as unknown as EngineContext;
        // A real snapshot is long (the snapshot is not part of either fingerprint).
        const now = appModel([page("/", { aria: `ARIA-SNAPSHOT-OF /\n${"- link \"Product\"\n".repeat(60)}` }), page("/new")]);
        const { siteType: _s, purpose: _p, features: _f, journeys: _j, ...base } = now;
        const plan = planReuse(known, now);
        const model = await analyzeApplication(ctx, base, { reuse: plan });
        expect(prompts[0]).toContain(REUSE_NOTE);
        expect(prompts[0]).toContain('### /  [home] title="Title of /" status=200  (unchanged since the exploration of 2026-10-01; understood then as: The shop\'s front page)');
        expect(prompts[0]).not.toContain("ARIA-SNAPSHOT-OF /\n");
        expect(prompts[0]).toContain("ARIA-SNAPSHOT-OF /new");
        expect(model.pages.map((p) => [p.path, p.type, p.purpose])).toEqual([["/", "home", "The shop's front page"], ["/new", "content", "New page"]]);
        // Without reuse, the same pages are sent in full.
        await analyzeApplication(ctx, base);
        expect(prompts[1]).not.toContain("unchanged since");
        expect(prompts[1]).toContain("ARIA-SNAPSHOT-OF /");
        expect(prompts[1].length).toBeGreaterThan(prompts[0]!.length);
    });
});

// ── the switches, their API and the job's usage answer ────────────────────────
describe("the switches", () => {
    it("Settings beats the environment, which beats the default (on)", () => {
        expect(envSwitch(undefined)).toBe(true);
        expect(envSwitch(" off ")).toBe(false);
        expect(envSwitch("0")).toBe(false);
        expect(withoutAiSetting({}, "deterministicRepair")).toEqual({ enabled: true, source: "default" });
        expect(withoutAiSetting({ LLM_EXPLORATION_REUSE: "false" }, "explorationReuse")).toEqual({ enabled: false, source: "environment" });
        setWithoutAiSource((s) => (s === "explorationReuse" ? true : undefined));
        expect(withoutAiSetting({ LLM_EXPLORATION_REUSE: "false" }, "explorationReuse")).toEqual({ enabled: true, source: "app" });
        expect(withoutAiSetting({ LLM_DETERMINISTIC_REPAIR: "no" }, "deterministicRepair")).toEqual({ enabled: false, source: "environment" });
        setWithoutAiSource(undefined);
    });

    it("GET/PUT /api/llm/without-ai, and a job's usage says what it did without AI", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-det-unit-"));
        tmpDirs.push(dir);
        const platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789", LLM_DETERMINISTIC_REPAIR: "off" }));
        try {
            const server = await buildServer(platform);
            const get = async () => (await server.inject({ method: "GET", url: "/api/llm/without-ai" })).json();
            expect(await get()).toEqual({
                deterministicRepair: { enabled: false, source: "environment", environment: false, variable: "LLM_DETERMINISTIC_REPAIR" },
                explorationReuse: { enabled: true, source: "default", environment: null, variable: "LLM_EXPLORATION_REUSE" },
            });
            const put = await server.inject({ method: "PUT", url: "/api/llm/without-ai", payload: { deterministicRepair: true, explorationReuse: false } });
            expect(put.statusCode).toBe(200);
            expect(put.json().deterministicRepair).toMatchObject({ enabled: true, source: "app", environment: false });
            expect(put.json().explorationReuse).toMatchObject({ enabled: false, source: "app" });
            expect((await server.inject({ method: "PUT", url: "/api/llm/without-ai", payload: { deterministicRepair: "yes" } })).statusCode).toBe(400);
            expect((await server.inject({ method: "PUT", url: "/api/llm/without-ai", payload: { other: true } })).statusCode).toBe(400);
            await server.inject({ method: "PUT", url: "/api/llm/without-ai", payload: { deterministicRepair: null, explorationReuse: null } });
            expect((await get()).deterministicRepair.source).toBe("environment");

            const projectId = (await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Usage" } })).json().id as string;
            const appId = platform.repo.createApplication(projectId, "http://x.test", {});
            const job = await platform.repo.createJob(projectId, appId, { ...DEFAULT_JOB_OPTIONS });
            const usage = async () => (await server.inject({ method: "GET", url: `/api/jobs/${job.id}/usage` })).json();
            expect((await usage()).withoutAi).toBeNull();
            platform.repo.addEvent(job.id, { stage: "validation", kind: "repaired_without_ai", message: "m", data: { testId: "WEB-001", kind: "same-text", stepIndex: 1 } });
            platform.repo.addEvent(job.id, { stage: "validation", kind: "repaired_without_ai", message: "m", data: { testId: "WEB-002", kind: "role-name", stepIndex: 0 } });
            platform.repo.addEvent(job.id, { stage: "analysis", kind: "understanding_reused", message: "m", data: { pages: 4, of: 6 } });
            expect((await usage()).withoutAi).toEqual({ repairs: 2, repairsByKind: { "same-text": 1, "role-name": 1 }, pagesReused: 4, summary: "2 repairs without AI, 4 unchanged pages not sent to the AI again" });
            await server.close();
        } finally {
            platform.db.close();
        }
    });
});

// ── the savings comparison ────────────────────────────────────────────────────
function entry(id: string, m: { created: number; stablePassing: number; flaky?: number; testWrong?: number; input: number; output: number; calls: number }, usage?: Partial<NonNullable<EntryResult["usage"]>>): EntryResult {
    return {
        id, kind: "web", status: "done",
        metrics: { planned: m.created, created: m.created, passedFirstRun: m.stablePassing, stable: m.created - (m.flaky ?? 0), stablePassing: m.stablePassing, stableFailing: m.created - m.stablePassing - (m.flaky ?? 0), flaky: m.flaky ?? 0, notRun: 0, failingProduct: 0, failingTestWrong: m.testWrong ?? 0, failingUnclear: 0, duplicates: 0, coverageUnit: "pages", found: 3, covered: 2, durationMs: 1000, aiCalls: m.calls, inputTokens: m.input, outputTokens: m.output, cost: null, safetyRefusals: null },
        rates: { firstPass: 1, stable: 1, flaky: 0, duplicates: 0, coverage: 0.6, testWrong: 0 },
        usage: { cacheReadTokens: 0, cacheWriteTokens: 0, escalations: 0, byModel: [{ model: "main", calls: m.calls, inputTokens: m.input, outputTokens: m.output, cacheReadTokens: 0 }], repairsFixed: 0, repairsWithoutAi: 0, pagesReused: 0, ...usage },
    };
}
function run(entries: EntryResult[], planOnly = false): EvalRun {
    const sum = (f: (e: EntryResult) => number) => entries.reduce((a, e) => a + f(e), 0);
    const mm = (k: keyof NonNullable<EntryResult["metrics"]>) => sum((e) => Number(e.metrics?.[k] ?? 0));
    return {
        format: 1, corpus: "default", startedAt: "2026-10-22T10:00:00.000Z", finishedAt: "2026-10-22T11:00:00.000Z", repeat: 3, planOnly, platform: { mode: "in-process", model: "main" }, entries,
        overall: { planned: mm("planned"), created: mm("created"), passedFirstRun: mm("passedFirstRun"), stable: mm("stable"), stablePassing: mm("stablePassing"), stableFailing: mm("stableFailing"), flaky: mm("flaky"), notRun: 0, failingProduct: 0, failingTestWrong: mm("failingTestWrong"), failingUnclear: 0, duplicates: 0, found: mm("found"), covered: mm("covered"), durationMs: mm("durationMs"), aiCalls: mm("aiCalls"), inputTokens: mm("inputTokens"), outputTokens: mm("outputTokens"), cost: null, safetyRefusals: null, entries: entries.length, entriesDone: entries.filter((e) => e.status === "done").length, rates: { firstPass: 1, stable: 1, flaky: 0, duplicates: 0, coverage: null, testWrong: 0 } },
    };
}

describe("the savings comparison", () => {
    const toggles = parseToggles(undefined, {}).toggles;

    it("toggles every known saving by default; a model setting needs a value; switches cannot be given one", () => {
        expect(toggles.map((t) => [t.name, t.baseline, t.candidate])).toEqual([
            ["LLM_PROMPT_CACHE", "false", "true"],
            ["LLM_COMPACT_SNAPSHOTS", "false", "true"],
            ["LLM_DETERMINISTIC_REPAIR", "false", "true"],
            ["LLM_EXPLORATION_REUSE", "false", "true"],
        ]);
        expect(parseToggles(undefined, {}).notes[0]).toMatch(/^LLM_MODEL_FAST is not set/);
        expect(parseToggles("LLM_MODEL_FAST", { LLM_MODEL_FAST: "fast-1" }).toggles).toEqual([{ name: "LLM_MODEL_FAST", baseline: "", candidate: "fast-1", label: "fast model for routine steps" }]);
        expect(parseToggles("LLM_MODEL_FAST=openai:mini,NEW_SAVING", {}).toggles.map((t) => [t.name, t.candidate])).toEqual([["LLM_MODEL_FAST", "openai:mini"], ["NEW_SAVING", "true"]]);
        expect(() => parseToggles("LLM_PROMPT_CACHE=off", {})).toThrow(/compared off against on/);
        expect(() => parseToggles("bad name", {})).toThrow(/not a setting name/);
        expect(() => parseToggles("LLM_MODEL_FAST", {})).toThrow(/Nothing to compare/);
        expect(parseMargins("pass=1.5,false=1")).toEqual({ passPoints: 1.5, falseFailures: 1 });
        expect(parseMargins("3")).toEqual({ passPoints: 3, falseFailures: 0 });
        expect(() => parseMargins("false=0.5")).toThrow(/whole number/);
        expect(() => parseMargins("speed=2")).toThrow();
        expect(DEFAULT_MARGINS).toEqual({ passPoints: 2, falseFailures: 0 });
        expect(parseArgs(["--compare", "--warm", "--toggle", "LLM_PROMPT_CACHE", "--max-quality-drop", "pass=1"])).toMatchObject({ compare: true, warm: true, toggle: "LLM_PROMPT_CACHE", margins: { passPoints: 1, falseFailures: 0 } });
        expect(() => parseArgs(["--warm"])).toThrow(/only go with --compare/);
        expect(() => parseArgs(["--compare", "--fail-under", "stable=0.8"])).toThrow(/does not go with --compare/);
    });

    it("passes when quality holds, and reports the tokens, repairs and pages saved", () => {
        const b = run([entry("shop", { created: 10, stablePassing: 9, flaky: 1, input: 100_000, output: 10_000, calls: 40 }, { repairsFixed: 2 })]);
        const c = run([entry("shop", { created: 10, stablePassing: 9, flaky: 1, input: 60_000, output: 8_000, calls: 30 }, { repairsFixed: 2, repairsWithoutAi: 2, pagesReused: 5, cacheReadTokens: 20_000 })]);
        const r = compareRuns(b, c, { toggles, margins: DEFAULT_MARGINS, warm: true, startedAt: "2026-10-22T10:00:00.000Z" });
        expect(r.verdict).toBe("pass");
        expect(r.reasons).toEqual([]);
        expect(r.baseline).toMatchObject({ created: 10, passRate: 0.9, falseFailures: 1, repairsFixed: 2, repairsWithoutAi: 0 });
        expect(r.candidate).toMatchObject({ repairsWithoutAi: 2, pagesReused: 5, tokens: { input: 60_000, cacheRead: 20_000, cacheWrite: 0, output: 8_000, total: 68_000 } });
        expect(r.difference).toMatchObject({ totalTokens: -42_000, totalTokensPct: -38.2, aiCalls: -10, passRatePoints: 0, falseFailures: 0 });
        const md = compareMarkdown(r);
        expect(md).toContain("**Pass: quality held with the savings on.**");
        expect(md).toContain("| All tokens | 110,000 | 68,000 | -42,000 (-38.2%) |");
        expect(md).toContain("| Unchanged pages not sent to the AI | 0 | 5 | +5 |");
        expect(md).toContain("## Tokens by model");
        expect(EvalRunSchema.safeParse(c).success).toBe(true);
    });

    it("fails on a pass-rate drop beyond the margin, on more false failures, or on fewer finished entries; each reason said", () => {
        const b = run([entry("a", { created: 10, stablePassing: 10, input: 1000, output: 100, calls: 4 }), entry("b", { created: 10, stablePassing: 10, input: 1000, output: 100, calls: 4 })]);
        const drop = run([entry("a", { created: 10, stablePassing: 9, testWrong: 1, input: 500, output: 50, calls: 2 }), entry("b", { created: 10, stablePassing: 10, input: 500, output: 50, calls: 2 })]);
        const r = compareRuns(b, drop, { toggles, margins: DEFAULT_MARGINS, warm: false, startedAt: b.startedAt });
        expect(r.verdict).toBe("fail");
        expect(r.reasons).toEqual(["Pass rate fell by 5 points (100% to 95%); at most 2 is allowed.", "False failures rose from 0 to 1; at most 0 more are allowed."]);
        expect(compareRuns(b, drop, { toggles, margins: { passPoints: 5, falseFailures: 1 }, warm: false, startedAt: b.startedAt }).verdict).toBe("pass");
        const lost = run([entry("a", { created: 10, stablePassing: 10, input: 1, output: 1, calls: 1 }), { id: "b", kind: "web", status: "failed", reason: "x" }]);
        expect(compareRuns(b, lost, { toggles, margins: DEFAULT_MARGINS, warm: false, startedAt: b.startedAt }).reasons).toContain("Entries finished: 1 with the savings on against 2 with them off.");
        expect(compareRuns(b, lost, { toggles, margins: DEFAULT_MARGINS, warm: false, startedAt: b.startedAt }).entries[1]).toMatchObject({ id: "b", candidate: { status: "failed", created: 0 } });
    });

    it("is not judged with plan only, or when the baseline created nothing", () => {
        const p = run([entry("a", { created: 0, stablePassing: 0, input: 10, output: 1, calls: 1 })], true);
        expect(compareRuns(p, p, { toggles, margins: DEFAULT_MARGINS, warm: false, startedAt: p.startedAt })).toMatchObject({ verdict: "not-judged", reasons: [expect.stringMatching(/^Plan only/)] });
        const none = run([entry("a", { created: 0, stablePassing: 0, input: 10, output: 1, calls: 1 })]);
        expect(compareRuns(none, none, { toggles, margins: DEFAULT_MARGINS, warm: false, startedAt: p.startedAt }).verdict).toBe("not-judged");
    });
});
