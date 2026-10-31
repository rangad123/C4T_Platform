/**
 * R24 PLAN: better test ideas and stable locators from the screen graph. Pure tests (no adb, no emulator, no real phone, no AI model):
 *  - locators from realistic hierarchies (a LinkedIn-like app, tests/fixtures/fake-uia2.ts): ranking, obfuscated and numbered ids skipped,
 *    Compose test tags, fallbacks checked unique, never coordinates;
 *  - screen names (never "Search (4)"), ideas from the graph (main tabs, a list item and back, search, settings, longer journeys), ranking,
 *    dedupe and the idea caps of each depth;
 *  - the generated script: fallbacks with `.or()`, UiScrollable for list items, the device-farm reader, a typecheck against the installed
 *    Taqwright, and a run of its steps with the real Taqwright `Mobile` on the fake phone (fallbacks taking over after an app update).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseHierarchy } from "../src/engine/mobile/device/uiautomator.js";
import type { ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { buildCandidates, pickChecks, stepsOf } from "../src/engine/mobile/explore/candidates.js";
import { recordOf } from "../src/engine/mobile/explore/explorer.js";
import { ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { landmarksOf } from "../src/engine/mobile/explore/graph.js";
import { chooseLocator, fallbacksFor, isDynamicText, isListId, isObfuscatedId, isStableId, locatorFor, uiSelectorOf, xpathLiteral } from "../src/engine/mobile/explore/locators.js";
import { buildPlan, chooseIdeas, phoneIdeaCap } from "../src/engine/mobile/explore/planner.js";
import { nameScreens, newScreen, storeElements, titleOf } from "../src/engine/mobile/explore/screens.js";
import { buildSpec } from "../src/engine/mobile/explore/spec-builder.js";
import type { Edge, EdgeVia, MobileAppModel, MobileScreen, RecordedAction } from "../src/engine/mobile/explore/types.js";
import { FIRST_OF_HELPER, taqwrightGenerator } from "../src/engine/generators/taqwright.js";
import { readFarmScript, readLine } from "../src/engine/mobile/cloud/script-reader.js";
import { TestSpecSchema, type Locator, type TestSpec } from "../src/engine/spec/schema.js";
import type { EngineContext } from "../src/engine/context.js";
import { Mobile } from "../node_modules/@taqwright/taqwright/dist/mobile/index.js";
import { Platform } from "../node_modules/@taqwright/taqwright/dist/types/index.js";
import { dump, FakePhoneApp, FakeUia2Driver, InvalidSelector, PKG, xpathFind } from "./fixtures/fake-uia2.js";
import { scriptedPhoneModel } from "./fixtures/phone-model.js";

const ACTIVITY: Record<string, string> = { home: "MainActivity", jobs: "MainActivity", network: "MainActivity", notifications: "MainActivity", post: "ComposePostActivity", job: "JobDetailActivity", search: "SearchActivity", profile: "ProfileActivity", settings: "SettingsActivity", account: "SettingsActivity", notif_settings: "SettingsActivity", messages: "MessagingActivity", invitations: "InvitationsActivity" };

function snapOf(app: FakePhoneApp): ScreenSnapshot {
    const r = parseHierarchy(dump(app), { appPackage: PKG, activity: `${PKG}.${ACTIVITY[app.screen] ?? "MainActivity"}` });
    if (!r.ok) throw new Error(r.error);
    return { ...r.snapshot };
}

/** The element of a snapshot named `name` (text, label or id). */
const find = (snap: ScreenSnapshot, name: string) => {
    const el = snap.elements.find((e) => e.text === name || e.desc === name || e.id === name) ?? snap.elements.find((e) => e.text.startsWith(name) || e.desc.startsWith(name));
    if (!el) throw new Error(`no “${name}” on ${snap.activity}: ${snap.elements.map((e) => e.text || e.desc || e.id).join(", ")}`);
    return el;
};

/**
 * Walks the fake app the way an exploration does and records the screen graph: screens by structural fingerprint with their landmarks, edges
 * with the recorded actions (and their locators) of explore/explorer.ts `recordOf`.
 */
class Walker {
    screens: MobileScreen[] = [];
    edges: Edge[] = [];
    private byPrint = new Map<string, MobileScreen>();
    cur!: { snap: ScreenSnapshot; screen: MobileScreen };
    pending: RecordedAction[] = [];
    start = "";
    constructor(readonly app: FakePhoneApp) {
        this.restart();
        this.start = this.cur.screen.id;
    }
    private visit(): { snap: ScreenSnapshot; screen: MobileScreen } {
        const snap = snapOf(this.app);
        let screen = this.byPrint.get(snap.fingerprint);
        if (screen) screen.visits++;
        else {
            screen = newScreen(`S${this.screens.length + 1}`, snap, this.screens.length === 0, []);
            const marks = landmarksOf(snap);
            Object.assign(screen, { fingerprint: snap.fingerprint, ...(marks.toolbarTitle ? { toolbarTitle: marks.toolbarTitle } : {}), ...(marks.selectedTab ? { selectedTab: marks.selectedTab } : {}), ...(marks.tabs.length ? { tabs: marks.tabs } : {}) });
            this.byPrint.set(snap.fingerprint, screen);
            this.screens.push(screen);
        }
        return { snap, screen };
    }
    restart(): this {
        this.app.restart();
        this.cur = this.visit();
        this.pending = [];
        return this;
    }
    private nodeAt(b: readonly number[]) {
        const all: Array<{ node: ReturnType<FakePhoneApp["tree"]> }> = [];
        const walk = (x: ReturnType<FakePhoneApp["tree"]>) => {
            all.push({ node: x });
            (x.kids ?? []).forEach(walk);
        };
        walk(this.app.tree());
        return all.map((a) => a.node).find((x) => x.b.join() === b.join())!;
    }
    private move(rec: RecordedAction, via: EdgeVia) {
        const from = this.cur;
        this.cur = this.visit();
        if (this.cur.screen.id !== from.screen.id) {
            this.edges.push({ id: `T${this.edges.length + 1}`, from: from.screen.id, to: this.cur.screen.id, prelude: this.pending, action: rec, via });
            this.pending = [];
        } else this.pending.push(rec);
    }
    tap(name: string, via: EdgeVia = "button"): this {
        const named = find(this.cur.snap, name);
        // An explorer taps what takes taps: the element itself, or the smallest clickable one around it (a list row around its title).
        const [l, t, r, b] = named.bounds;
        const area = (x: ScreenSnapshot["elements"][number]) => (x.bounds[2] - x.bounds[0]) * (x.bounds[3] - x.bounds[1]);
        const el = named.clickable ? named : this.cur.snap.elements.filter((x) => x.clickable && x.bounds[0] <= l && x.bounds[1] <= t && x.bounds[2] >= r && x.bounds[3] >= b).sort((x, y) => area(x) - area(y))[0]!;
        const rec = recordOf({ kind: "tap", index: el.index }, el, this.cur.screen.id, this.cur.snap, [])!;
        this.app.tap(this.nodeAt(el.bounds));
        this.move(rec, via);
        return this;
    }
    type(name: string, text: string): this {
        const el = find(this.cur.snap, name);
        const rec = recordOf({ kind: "type", index: el.index, text }, el, this.cur.screen.id, this.cur.snap, [])!;
        this.app.typed.search = text;
        this.pending.push(rec);
        this.cur = { snap: snapOf(this.app), screen: this.cur.screen };
        return this;
    }
    scroll(): this {
        this.app.swipe(true);
        this.pending.push({ kind: "scroll", direction: "down" });
        this.cur = { snap: snapOf(this.app), screen: this.cur.screen };
        return this;
    }
    back(): this {
        this.app.back();
        this.move({ kind: "back" }, "back");
        return this;
    }
    model(): MobileAppModel {
        return { appPackage: PKG, start: this.start, screens: this.screens, edges: this.edges, submits: [], signInNeeded: false, signedIn: false, skipped: [], stats: { actions: 30, modelCalls: 2, durationMs: 1000, stoppedBecause: "The app looks fully explored", stop: "explored" } };
    }
}

/** A LinkedIn-like exploration: the feed, every main tab, a job opened and closed, a job far down the list, search, profile, settings, a Compose screen. */
function exploreLinkup(): MobileAppModel {
    const w = new Walker(new FakePhoneApp());
    w.tap("Jobs", "tab").scroll().scroll().tap("Product Designer", "list-item").back();
    w.tap("My Network", "tab").tap("Invitations").back();
    w.tap("Notifications", "tab");
    w.restart().tap("Post", "tab").tap("Close");
    w.restart().tap("Messaging", "menu");
    w.restart().tap("Search").type("Search", "Ada").tap("Ada Lovelace", "list-item").tap("Settings").tap("Account preferences").back().tap("Notifications");
    return w.model();
}

function context(llm = scriptedPhoneModel([])): EngineContext {
    return { config: {} as never, llm, emit: () => undefined };
}

// ── locators ────────────────────────────────────────────────────────────────

describe("locators from a real-looking hierarchy", () => {
    const app = new FakePhoneApp();
    const home = snapOf(app);
    it("reads where each element sits: its ancestors' ids, list content, the selected tab, a Compose test tag", () => {
        const jobs = find(home, "Jobs");
        expect(jobs.scopes).toEqual(expect.arrayContaining(["bottom_nav"]));
        expect(jobs.inScroll).toBeUndefined();
        expect(find(home, "Home").selected).toBe(true);
        expect(find(home, "Like").inScroll).toBe(true);
        app.screen = "post";
        const post = snapOf(app);
        expect(find(post, "Close").bareId).toBe(true);
        app.restart();
    });
    it("ranks a designed id first and keeps checked fallbacks: the label, a UiSelector and one anchored on the bottom navigation", async () => {
        const { loc } = locatorFor(find(home, "Jobs"), home.elements);
        expect(loc).toMatchObject({ by: "testId", value: "nav_jobs" });
        expect(loc!.fallbacks!.length).toBeGreaterThanOrEqual(2);
        expect(loc!.fallbacks!.length).toBeLessThanOrEqual(3);
        expect(loc!.fallbacks![0]).toEqual({ by: "label", value: "Jobs" });
        expect(loc!.fallbacks!.some((f) => (f.by === "uiSelector" && f.value.includes(".childSelector(")) || f.by === "xpath")).toBe(true);
        // Every fallback names exactly the Jobs entry on the recorded screen (checked against the same tree the phone has).
        const driver = new FakeUia2Driver(new FakePhoneApp());
        for (const f of loc!.fallbacks!) {
            const using = f.by === "uiSelector" ? "-android uiautomator" : f.by === "xpath" ? "xpath" : f.by === "label" ? "accessibility id" : "id";
            const hits = await driver.findElements(using, f.value);
            expect(hits).toHaveLength(1);
            expect(await driver.getElementAttribute(hits[0]![Object.keys(hits[0]!)[0]!]!, "content-desc")).toBe("Jobs");
        }
        // The XPath anchored on the bottom navigation names the same element too.
        const anchored = fallbacksFor(find(home, "Jobs"), home.elements, undefined).find((f) => f.by === "xpath");
        if (anchored) expect(await driver.findElements("xpath", anchored.value)).toHaveLength(1);
    });
    it("never writes coordinates or an absolute XPath", () => {
        const all = home.elements.flatMap((e) => {
            const { loc } = locatorFor(e, home.elements);
            return loc ? [loc, ...(loc.fallbacks ?? [])] : [];
        });
        expect(all.length).toBeGreaterThan(5);
        for (const l of all) {
            expect(JSON.stringify(l)).not.toMatch(/bounds|\[\d+,\d+\]/);
            if (l.by === "xpath") expect(l.value).toMatch(/^\(?\/\/\*/);
            if (l.by === "xpath") expect(l.value).not.toMatch(/^\/[a-z]/i);
        }
    });
    it("skips ids an optimizer made, ids numbered like list rows, and changing text", () => {
        for (const id of ["a1", "b2c", "a0b1", "ab"]) {
            expect(isObfuscatedId(id)).toBe(true);
            expect(isStableId(id)).toBe(false);
        }
        expect(isStableId("nav_jobs")).toBe(true);
        expect(isStableId("fab")).toBe(true);
        expect(isListId("product_2", [{ id: "product_1" }, { id: "product_2" }])).toBe(true);
        expect(isListId("step_2", [{ id: "step_2" }])).toBe(false);
        for (const t of ["5 min ago", "2h", "12 likes", "1,234 followers", "3 new", "Yesterday at 9", "$9.99"]) expect(isDynamicText(t)).toBe(true);
        for (const t of ["Jobs", "Easy Apply", "Product 1", "Settings"]) expect(isDynamicText(t)).toBe(false);
        app.screen = "network";
        const network = snapOf(app);
        app.restart();
        expect(locatorFor(find(network, "Invitations"), network.elements).loc).toMatchObject({ by: "text", value: "Invitations" });
        expect(JSON.stringify(locatorFor(find(network, "Invitations"), network.elements).loc)).not.toMatch(/"a1"/);
    });
    it("finds a Compose test tag through a UiSelector first (Appium's id lookup adds the app's package to it)", () => {
        app.screen = "post";
        const post = snapOf(app);
        app.restart();
        const { loc } = locatorFor(find(post, "Close"), post.elements);
        expect(loc).toMatchObject({ by: "testId", value: "post_close" });
        expect(loc!.fallbacks![0]).toEqual({ by: "uiSelector", value: 'new UiSelector().resourceId("post_close")' });
    });
    it("names a list row by the text inside it, and never by feed content that changes", () => {
        app.screen = "jobs";
        const jobs = snapOf(app);
        app.restart();
        const card = jobs.elements.find((e) => e.id === "job_card")!;
        expect(chooseLocator(card, jobs.elements)).toMatchObject({ loc: { by: "text", value: "Android Developer" } });
        const post = home.elements.find((e) => e.id === "post_text")!;
        expect(chooseLocator(post, home.elements).loc?.by).not.toBe("text");
        const time = home.elements.find((e) => e.id === "post_time")!;
        expect(chooseLocator(time, home.elements).loc?.value).not.toMatch(/\dh/);
    });
    it("writes UiSelector and XPath strings that survive quotes and backslashes", () => {
        expect(xpathLiteral(`He said "hi"`)).toBe(`'He said "hi"'`);
        expect(xpathLiteral(`it's "x"`)).toBe(`concat("it's ", '"', "x", '"')`);
        expect(uiSelectorOf({ by: "text", value: 'a "b" \\ c' })).toBe('new UiSelector().text("a \\"b\\" \\\\ c")');
        expect(uiSelectorOf({ by: "placeholder", value: "x" })).toBeUndefined();
        expect(uiSelectorOf({ by: "text", value: "{{credentials.username}}" })).toBeUndefined();
        expect(fallbacksFor({ cls: "TextView", text: "", desc: "", id: "", editable: false, password: false }, [], undefined)).toEqual([]);
    });
});

// ── names ───────────────────────────────────────────────────────────────────

describe("screen names", () => {
    const model = exploreLinkup();
    it("come from the toolbar heading or the selected tab, never a number in brackets", () => {
        nameScreens(model.screens, model.edges);
        const titles = model.screens.map((s) => s.title);
        expect(titles).toEqual(expect.arrayContaining(["Home", "Jobs", "Job details", "My Network", "Settings", "Account preferences"]));
        expect(titles.some((t) => /\(\d+\)/.test(t))).toBe(false);
        expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(titles.length);
        // Two screens called "Notifications": the tab and the settings page are told apart in words.
        const notif = titles.filter((t) => t.startsWith("Notifications"));
        expect(notif).toHaveLength(2);
        expect(notif.some((t) => t === "Notifications")).toBe(true);
        expect(notif.find((t) => t !== "Notifications")).toMatch(/^Notifications, \p{L}/u);
    });
    it("turns an older 'Search (4)' into words and changes nothing when run again", () => {
        const s = (id: string, title: string, o: Partial<MobileScreen> = {}): MobileScreen => ({ id, title, package: PKG, kind: "other", elements: [], visits: 1, hasForm: false, scrollable: false, ...o });
        const screens = [s("S1", "Search"), s("S2", "Search (2)", { activity: "com.x.SearchResultsActivity" }), s("S3", "Search (3)", { selectedTab: "Jobs" }), s("S4", "Search (4)", { elements: [{ cls: "Button", text: "Filters", desc: "", id: "", clickable: true, scrollable: false, editable: false, password: false, checkable: false }] })];
        nameScreens(screens);
        expect(screens.map((x) => x.title)).toEqual(["Search", "Search, Search Results", "Search, Jobs", "Search, Filters"]);
        nameScreens(screens);
        expect(screens.map((x) => x.title)).toEqual(["Search", "Search, Search Results", "Search, Jobs", "Search, Filters"]);
        const same = [s("A", "Feed"), s("B", "Feed"), s("C", "Feed")];
        nameScreens(same);
        expect(same.map((x) => x.title)).toEqual(["Feed", "Feed, second view", "Feed, third view"]);
    });
    it("a feed scrolled twice is one screen with one name", () => {
        const app = new FakePhoneApp();
        const a = snapOf(app);
        app.swipe(true);
        app.swipe(true);
        const b = snapOf(app);
        expect(b.fingerprint).toBe(a.fingerprint);
        expect(titleOf(b)).toBe(titleOf(a));
        expect(titleOf(a)).toBe("Home");
    });
});

// ── ideas ───────────────────────────────────────────────────────────────────

describe("test ideas from the graph", () => {
    const model = exploreLinkup();
    const { candidates, dropped } = buildCandidates(model, { maxPathEdges: 8 });
    const fam = (f: string) => candidates.filter((c) => c.family === f);
    it("has journeys of every kind the exploration made possible, each saying what it covers and why", () => {
        expect(candidates[0]!.family).toBe("start");
        expect(fam("tabs").map((c) => c.title)).toEqual(expect.arrayContaining(["Open the “Jobs” tab", "Open the “My Network” tab"]));
        expect(fam("lists").some((c) => /and go back/.test(c.title))).toBe(true);
        expect(fam("search").length).toBeGreaterThan(0);
        expect(fam("settings").map((c) => c.covers?.at(-1))).toEqual(expect.arrayContaining(["Account preferences"]));
        expect(fam("journeys").length).toBeGreaterThan(0);
        for (const c of candidates) {
            expect(c.why).toMatch(/^Covers /);
            expect(c.covers!.length).toBeGreaterThan(0);
            expect(c.checks.length).toBeGreaterThan(0);
        }
        expect(dropped.every((d) => d.reason.length > 5)).toBe(true);
    });
    it("ranks the main navigation and core flows first and never offers the same test twice", () => {
        const order = candidates.map((c) => c.family);
        const firstNav = order.indexOf("navigation");
        const lastTab = order.lastIndexOf("tabs");
        expect(lastTab).toBeLessThan(firstNav === -1 ? Infinity : firstNav);
        expect(order.indexOf("journeys")).toBeGreaterThan(lastTab);
        const sigs = candidates.map((c) => JSON.stringify([c.steps, c.checks]));
        expect(new Set(sigs).size).toBe(sigs.length);
        // A tab is offered once, as a tab, not again as "Open Jobs from Home".
        expect(candidates.filter((c) => c.target === fam("tabs").find((t) => /Jobs/.test(t.title))!.target && c.family === "navigation")).toHaveLength(0);
    });
    it("checks that each screen arrived by its heading or a stable element, never by feed content", () => {
        for (const c of candidates) {
            for (const s of c.checks.filter((x) => x.action === "assert")) {
                const v = (s as { locator: Locator }).locator.value ?? "";
                expect(isDynamicText(v) && (s as { locator: Locator }).locator.by !== "testId").toBe(false);
                expect(v).not.toMatch(/Post number|likes|Grace Hopper/);
            }
        }
        const jobs = model.screens.find((s) => s.title === "Jobs")!;
        const home = model.screens.find((s) => s.id === model.start)!;
        expect(pickChecks(jobs, home)[0]!.text).toBe("Jobs");
        expect(pickChecks(home).every((e) => !e.inScroll || e.loc?.by === "testId")).toBe(true);
    });
    it("reaches a job far down the list by scrolling until it shows, not by blind swipes, and waits by checking, not by sleeping", () => {
        const far = candidates.find((c) => JSON.stringify(c.steps).includes("Product Designer"))!;
        expect(far).toBeTruthy();
        expect(far.steps.some((s) => s.action === "press" && s.key === "device:scroll-to")).toBe(true);
        expect(far.steps.some((s) => s.action === "press" && /device:scroll:/.test(s.key))).toBe(false);
        expect(candidates.every((c) => c.steps.every((s) => s.action !== "wait"))).toBe(true);
        // Without `journey` the actions are repeated one for one (the phone checks reproduce a crash exactly).
        expect(stepsOf([{ kind: "scroll", direction: "down" }, { kind: "wait", ms: 500 }]).steps.map((s) => s.action)).toEqual(["press", "wait"]);
    });
    it("caps the plan by depth (Quick 15, Standard 40, Thorough 80), keeps the app start and the most important ideas", async () => {
        expect(phoneIdeaCap("quick")).toBe(15);
        expect(phoneIdeaCap(undefined)).toBe(40);
        expect(phoneIdeaCap("thorough", 25)).toBe(80);
        expect(phoneIdeaCap("thorough", 10)).toBe(10);
        const { chosen } = await chooseIdeas(context(scriptedPhoneModel([], { failPlan: true })), model, candidates, new ModelBudget(5), 4);
        expect(chosen).toHaveLength(4);
        expect(chosen.map((c) => c.candidate.family)).toContain("start");
        expect(chosen.filter((c) => c.candidate.family === "tabs").length).toBeGreaterThanOrEqual(2);
        const all = await chooseIdeas(context(), model, candidates, new ModelBudget(5), 80);
        const plan = buildPlan(model, all.chosen, dropped);
        expect(plan.ideas.length).toBeGreaterThan(8);
        expect(plan.ideas.every((i) => i.why && i.covers?.length)).toBe(true);
    });
    it("writes valid phone tests whose locators keep their fallbacks", () => {
        const tab = fam("tabs").find((c) => /Jobs/.test(c.title))!;
        const r = buildSpec({ candidate: tab, id: "M-01", title: tab.title, goal: tab.goal, priority: "high", appPackage: PKG });
        expect(r.ok).toBe(true);
        const click = r.ok ? r.spec.steps.find((s) => s.action === "click") : undefined;
        expect((click as { locator: Locator }).locator.fallbacks?.length).toBeGreaterThan(0);
    });
});

// ── the script ──────────────────────────────────────────────────────────────

const specOf = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "MOB-001", title: "Phone test", kind: "mobile", platform: "android", category: "Phone", steps });
const stepLines = (content: string): string[] => [...content.matchAll(/^ {4}await test\.step\("(?:[^"\\]|\\.)*", async \(\) => \{\n {8}(.*)\n {4}\}\);$/gm)].map((m) => m[1]!);

describe("the generated script", () => {
    it("reads exactly as before for a locator without fallbacks, and adds the number Taqwright needs", () => {
        const lines = stepLines(taqwrightGenerator.render(specOf([{ action: "click", locator: { by: "testId", value: "login_button" } }, { action: "click", locator: { by: "text", value: "Item", nth: 2 } }]), { baseUrl: `android-app://${PKG}` }).content);
        expect(lines).toEqual(['await mobile.getByTestId("login_button").click();', 'await mobile.getByText("Item").nth(2).click();']);
    });
    it("tries the fallbacks in order with the firstOf helper, and scrolls list items into view with UiScrollable", () => {
        const loc = { by: "testId", value: "nav_jobs", fallbacks: [{ by: "label", value: "Jobs" }, { by: "uiSelector", value: 'new UiSelector().resourceIdMatches("(.*:id/)?bottom_nav").childSelector(new UiSelector().description("Jobs"))' }] };
        const content = taqwrightGenerator.render(specOf([{ action: "click", locator: loc }, { action: "click", locator: { by: "text", value: "Like", nth: 1, fallbacks: [{ by: "xpath", value: '//*[@text="Like"]', nth: 1 }] } }, { action: "press", key: "device:scroll-to", locator: { by: "text", value: "Product Designer", fallbacks: [{ by: "label", value: "Product Designer" }] } }, { action: "assert", check: "visible", locator: loc }]), { baseUrl: `android-app://${PKG}` }).content;
        const lines = stepLines(content);
        expect(lines[0]).toBe('await (await firstOf(10000, mobile.getByTestId("nav_jobs"), mobile.getByLabel("Jobs"), mobile.getByUiSelector("new UiSelector().resourceIdMatches(\\"(.*:id/)?bottom_nav\\").childSelector(new UiSelector().description(\\"Jobs\\"))"))).click();');
        expect(lines[1]).toBe('await (await firstOf(10000, mobile.getByText("Like").nth(1), mobile.getByXpath("//*[@text=\\"Like\\"]").nth(1))).click();');
        expect(lines[2]).toBe('await (await firstOf(0, mobile.getByUiSelector("new UiSelector().text(\\"Product Designer\\")"), mobile.getByLabel("Product Designer"))).scrollIntoView();');
        expect(lines[3]).toMatch(/^await expect\(\(await firstOf\(10000, mobile\.getByTestId\("nav_jobs"\), /);
        // The helper is in the script once, only because a step has fallbacks.
        expect(content.split("async function firstOf(").length).toBe(2);
        expect(content).toContain(FIRST_OF_HELPER);
        expect(taqwrightGenerator.render(specOf([{ action: "click", locator: { by: "testId", value: "x" } }]), { baseUrl: `android-app://${PKG}` }).content).not.toContain("firstOf");
        // iOS has no UiSelector: the same spec renders without the Android fallbacks.
        const ios = taqwrightGenerator.render(TestSpecSchema.parse({ ...specOf([{ action: "click", locator: loc }]), platform: "ios" }), { baseUrl: "ios-app://x" }).content;
        expect(stepLines(ios)[0]).toBe('await mobile.getByTestId("nav_jobs").click();');
        expect(ios).not.toContain("firstOf");
    });
    it("is read step by step by the device-farm reader, fallbacks and numbers included", () => {
        expect(readLine('await (await firstOf(10000, mobile.getByTestId("nav_jobs"), mobile.getByLabel("Jobs"), mobile.getByXpath("//*[@text=\\"Jobs\\"]").nth(0))).click();')).toEqual({
            op: "click",
            loc: { by: "any", of: [{ by: "testId", value: [{ lit: "nav_jobs" }] }, { by: "label", value: [{ lit: "Jobs" }] }, { by: "nth", n: 0, of: { by: "xpath", value: [{ lit: '//*[@text="Jobs"]' }] } }] },
        });
        expect(readLine('await mobile.getByUiSelector("new UiSelector().text(\\"A\\")").scrollIntoView();')).toEqual({ op: "scrollIntoView", loc: { by: "uiSelector", value: [{ lit: 'new UiSelector().text("A")' }] } });
        const model = exploreLinkup();
        const { candidates } = buildCandidates(model, { maxPathEdges: 8 });
        for (const c of candidates.slice(0, 12)) {
            const r = buildSpec({ candidate: c, id: "M-01", title: c.title, goal: c.goal, priority: "high", appPackage: PKG });
            if (!r.ok) continue;
            const read = readFarmScript(taqwrightGenerator.render({ ...r.spec, testId: "MOB-001" }, { baseUrl: `android-app://${PKG}` }).content);
            expect(read.steps.length).toBe(r.spec.steps.length);
        }
    });
    it("typechecks against the installed Taqwright", () => {
        const model = exploreLinkup();
        const { candidates } = buildCandidates(model, { maxPathEdges: 8 });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plan-tsc-"));
        const files: string[] = [];
        candidates.slice(0, 10).forEach((c, i) => {
            const r = buildSpec({ candidate: c, id: `M-${i}`, title: c.title, goal: c.goal, priority: "high", appPackage: PKG });
            if (!r.ok) return;
            const file = path.join(dir, `t${i}.mobile.spec.ts`);
            fs.writeFileSync(file, taqwrightGenerator.render({ ...r.spec, testId: `MOB-00${i}` }, { baseUrl: `android-app://${PKG}` }).content);
            files.push(file);
        });
        expect(files.length).toBeGreaterThan(5);
        const root = process.cwd();
        const program = ts.createProgram(files, {
            noEmit: true,
            strict: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            skipLibCheck: true,
            types: ["node"],
            typeRoots: [path.join(root, "node_modules", "@types")],
            baseUrl: root,
            paths: { "@taqwright/taqwright": [path.join(root, "node_modules", "@taqwright", "taqwright", "dist", "index.d.ts")] },
        });
        const problems = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        fs.rmSync(dir, { recursive: true, force: true });
        expect(problems).toEqual([]);
    }, 120_000);
});

// ── running it on the fake phone ────────────────────────────────────────────

/** Runs a script's step lines with the real Taqwright Mobile on the fake phone (assertions through Taqwright's own waits). */
async function runSteps(content: string, app: FakePhoneApp): Promise<FakeUia2Driver> {
    const driver = new FakeUia2Driver(app);
    const mobile = Mobile.wrap(driver as never, Platform.ANDROID, PKG, 1500);
    const expect = (loc: { waitFor(o: { state: string; timeout?: number }): Promise<void> }) => ({ toBeVisible: () => loc.waitFor({ state: "visible", timeout: 1500 }), toBeHidden: () => loc.waitFor({ state: "hidden", timeout: 1500 }) });
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<void>;
    // The script's own firstOf helper, as written into it (types removed).
    const firstOf = content.includes(FIRST_OF_HELPER) ? (new Function(`${ts.transpile(FIRST_OF_HELPER, { target: ts.ScriptTarget.ES2022 })}\nreturn firstOf;`)() as unknown) : undefined;
    for (const line of stepLines(content)) await new AsyncFunction("mobile", "expect", "data", "unique", "firstOf", line)(mobile, expect, {}, "u1", firstOf);
    return driver;
}

describe("the script on the fake phone", () => {
    const model = exploreLinkup();
    const { candidates } = buildCandidates(model, { maxPathEdges: 8 });
    const scriptOf = (match: (title: string) => boolean) => {
        const c = candidates.find((x) => match(x.title))!;
        const r = buildSpec({ candidate: c, id: "M-01", title: c.title, goal: c.goal, priority: "high", appPackage: PKG });
        if (!r.ok) throw new Error(r.reason);
        return taqwrightGenerator.render({ ...r.spec, testId: "MOB-001" }, { baseUrl: `android-app://${PKG}` }).content;
    };
    it("opens the Jobs tab by its id on the app it was written from", async () => {
        const app = new FakePhoneApp();
        const driver = await runSteps(scriptOf((t) => t === "Open the “Jobs” tab"), app);
        expect(app.screen).toBe("jobs");
        expect(driver.lookups.find((l) => l.using === "id" && l.value === "nav_jobs")?.found).toBe(1);
    });
    it("after an app update renamed the id, a fallback finds the tab and the test still passes", async () => {
        const app = new FakePhoneApp({ v2: true });
        const driver = await runSteps(scriptOf((t) => t === "Open the “Jobs” tab"), app);
        expect(app.screen).toBe("jobs");
        expect(driver.lookups.filter((l) => l.using === "id" && l.value === "nav_jobs").every((l) => l.found === 0)).toBe(true);
    });
    it("a Compose test tag is found through its UiSelector", async () => {
        const app = new FakePhoneApp();
        app.screen = "post";
        app.stack = ["home"];
        const post = snapOf(app);
        const { loc } = locatorFor(find(post, "Close"), post.elements);
        const driver = await runSteps(taqwrightGenerator.render(specOf([{ action: "click", locator: loc }]), { baseUrl: `android-app://${PKG}` }).content, app);
        expect(app.taps).toContain("Close");
        expect(app.screen).toBe("home");
        // Appium's id lookup did not find the bare tag; the UiSelector did.
        expect(driver.lookups.filter((l) => l.using === "id").every((l) => l.found === 0)).toBe(true);
        expect(driver.lookups.some((l) => l.using === "-android uiautomator" && l.found === 1)).toBe(true);
    });
    it("scrolls the jobs list with UiScrollable until the job shows, opens it, checks its details and goes back", async () => {
        const app = new FakePhoneApp();
        const c = candidates.find((x) => x.family === "lists" && JSON.stringify(x.steps).includes("Product Designer"))!;
        expect(c.title).toBe("Open an item from “Jobs” and go back");
        const r = buildSpec({ candidate: c, id: "M-01", title: c.title, goal: c.goal, priority: "high", appPackage: PKG });
        if (!r.ok) throw new Error(r.reason);
        const driver = await runSteps(taqwrightGenerator.render({ ...r.spec, testId: "MOB-001" }, { baseUrl: `android-app://${PKG}` }).content, app);
        expect(app.state.job).toBe(6);
        expect(app.taps.some((t) => t.endsWith(":id/job_card"))).toBe(true);
        expect(app.screen).toBe("jobs");
        expect(driver.lookups.some((l) => l.using === "-android uiautomator" && l.value.startsWith("new UiScrollable(") && l.found === 1)).toBe(true);
    });
    it("a check fails when the screen did not arrive (it is a real check, not a pass by default)", async () => {
        // An app whose Jobs tab does nothing: the tap works, the arrival check fails.
        class Broken extends FakePhoneApp {
            override tap(node: Parameters<FakePhoneApp["tap"]>[0]): void {
                if (node.go !== "jobs") super.tap(node);
            }
        }
        const app = new Broken();
        await expect(runSteps(scriptOf((t) => t === "Open the “Jobs” tab"), app)).rejects.toThrow(/did not reach state "visible"/);
        expect(app.screen).toBe("home");
    });
    it("a selector the fake phone does not understand fails loudly (so a typo in what the generator writes cannot pass)", () => {
        expect(() => xpathFind([], "/hierarchy/node[1]")).toThrow(InvalidSelector);
    });
});
