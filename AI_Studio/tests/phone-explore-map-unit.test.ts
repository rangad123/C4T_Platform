/**
 * R24 (EXPLORE): screen identity, the screen graph and the map explorer, without a phone, adb or a platform. Fingerprints are proved on
 * recorded-style hierarchies (tests/fixtures/phone-hierarchies.ts: a LinkedIn-like feed scrolled and refreshed, a profile, search, a bottom
 * sheet, a Compose app); the explorer runs on the in-memory phone (tests/fixtures/memory-device.ts) with a scripted AI double that counts
 * every call by what it was asked. Browser-free and fast.
 */
import { describe, expect, it } from "vitest";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import type { ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { activitiesFromPackageDump } from "../src/engine/mobile/device/session.js";
import { fingerprintOf, parseHierarchy, structureTokens, textFingerprintOf } from "../src/engine/mobile/device/uiautomator.js";
import { buildCandidates } from "../src/engine/mobile/explore/candidates.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { depths, displayLabel, elementKeys, findByKey, landmarksOf, listDetails, mainTabs, pathFromStart, ScreenGraph, screenLabel, shortestPath } from "../src/engine/mobile/explore/graph.js";
import { distinctTitles, FIELDS_SYSTEM, NAME_SYSTEM, RISK_SYSTEM } from "../src/engine/mobile/explore/map-explorer.js";
import { coverageSentence } from "../src/engine/mobile/explore/pipeline.js";
import { EXPLORE_SYSTEM } from "../src/engine/mobile/explore/prompts.js";
import { judgeAction } from "../src/engine/mobile/explore/safety.js";
import { depthLimits, PASSWORD_PLACEHOLDER, type Edge, type ExploreLimits, type MobileAppModel, type MobileScreen } from "../src/engine/mobile/explore/types.js";
import { DEPTHS } from "../src/engine/mobile/phone-settings.js";
import { MemoryDevice, shopApp, SHOP, type AppDef, type El } from "./fixtures/memory-device.js";
import { COMPOSE_APP, COMPOSE_JOB, COMPOSE_JOBS, FEED, FEED_REFRESHED, FEED_SCROLLED_ONCE, FEED_SCROLLED_TWICE, LINKEDIN, POST_SHEET, PROFILE, SEARCH_EMPTY, SEARCH_RESULTS, SETTINGS } from "./fixtures/phone-hierarchies.js";

// ── helpers ─────────────────────────────────────────────────────────────────

const read = (xml: string, pkg = LINKEDIN, activity = `${LINKEDIN}.MainActivity`) => {
    const r = parseHierarchy(xml, { appPackage: pkg, activity });
    if (!r.ok) throw new Error(r.error);
    return r.snapshot as ScreenSnapshot;
};

/** An AI double: answers each kind of question the map explorer asks, counts them, never a real model. */
function aiDouble(o: { turn?: (prompt: string) => unknown; names?: (prompt: string) => unknown; fields?: (prompt: string) => unknown; risk?: boolean } = {}) {
    const calls = { turn: 0, names: 0, fields: 0, risk: 0, other: 0 };
    const prompts: string[] = [];
    const llm: LlmClient = {
        modelName: "scripted",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        text: async () => "",
        object: (async ({ system, prompt }: { system: string; prompt: string }) => {
            prompts.push(prompt);
            if (system === NAME_SYSTEM) {
                calls.names++;
                return o.names ? o.names(prompt) : { names: [] };
            }
            if (system === FIELDS_SYSTEM) {
                calls.fields++;
                return o.fields ? o.fields(prompt) : { fields: [] };
            }
            if (system === RISK_SYSTEM) {
                calls.risk++;
                return { changesData: o.risk ?? true };
            }
            if (system === EXPLORE_SYSTEM) {
                calls.turn++;
                return o.turn ? o.turn(prompt) : { action: { kind: "finish" } };
            }
            calls.other++;
            return {};
        }) as LlmClient["object"],
    };
    return { llm, calls, prompts };
}

function context(llm: LlmClient, signal?: AbortSignal): { ctx: EngineContext; events: EngineEvent[] } {
    const events: EngineEvent[] = [];
    return { events, ctx: { config: {} as never, llm, emit: (e) => events.push(e), ...(signal ? { signal } : {}) } };
}

async function mapExplore(app: AppDef, o: { limits?: Partial<ExploreLimits>; depth?: "quick" | "standard" | "thorough"; credentials?: boolean; allowData?: boolean; ai?: ReturnType<typeof aiDouble>; device?: MemoryDevice; budget?: number } = {}) {
    const device = o.device ?? new MemoryDevice(app, o.credentials ? { credentials: { username: "tester", password: "Fake-Pass-1234" } } : {});
    const ai = o.ai ?? aiDouble();
    const { ctx, events } = context(ai.llm);
    const model = await explore(
        { ctx, session: device, appPackage: app.pkg, credentialsGiven: o.credentials === true, allowDataChanges: o.allowData === true, secrets: o.credentials ? ["tester", "Fake-Pass-1234"] : [], strategy: "map", ...(o.depth ? { depth: o.depth } : {}), ...(o.limits ? { limits: o.limits } : {}) },
        new ModelBudget(o.budget ?? 60),
    );
    if (process.env.MAP_DEBUG) console.log(JSON.stringify({ titles: model.screens.map((s) => s.title), tapped: device.tapped, acts: device.acts.map((a) => a.kind), stats: model.stats, skipped: model.skipped.map((s) => s.message), notes: events.filter((e) => e.kind === "mobile_note").map((e) => e.message), edges: model.edges.map((e) => `${e.id} ${e.from}->${e.to} ${e.action.kind === "tap" ? e.action.label : e.action.kind}${e.unreliable ? " UNRELIABLE" : ""} ${JSON.stringify(e.replays ?? {})}`), ai: ai.calls }, null, 1));
    return { model, device, events, ai };
}

const byTitle = (m: MobileAppModel, t: string) => m.screens.find((s) => s.title === t);

// ── screen identity on recorded hierarchies ─────────────────────────────────

describe("screen identity (structural fingerprint)", () => {
    it("a feed scrolled twice or refreshed is the same screen; the fingerprint with text tells them apart", () => {
        const views = [FEED, FEED_SCROLLED_ONCE, FEED_SCROLLED_TWICE, FEED_REFRESHED].map((x) => read(x));
        expect(new Set(views.map((v) => v.fingerprint)).size).toBe(1);
        expect(new Set(views.map((v) => v.textFingerprint)).size).toBe(4);
        // The badge went from 3 to 5 new notifications: a count, not another screen.
        expect(views[3]!.elements.some((e) => e.desc.includes("5 new"))).toBe(true);
    });
    it("a profile, search results, search before typing, a bottom sheet and settings are each their own screen", () => {
        const prints = [FEED, PROFILE(), SEARCH_RESULTS(), SEARCH_EMPTY, POST_SHEET(), SETTINGS(false)].map((x) => read(x).fingerprint);
        expect(new Set(prints).size).toBe(prints.length);
    });
    it("another person's profile, another search and another post's sheet are the same screens", () => {
        expect(read(PROFILE("Alice Smith")).fingerprint).toBe(read(PROFILE("Bob Jones")).fingerprint);
        expect(read(SEARCH_RESULTS("product manager", ["Ivy Chen", "Jon Park", "Kim Lee"])).fingerprint).toBe(read(SEARCH_RESULTS("designer", ["Lena Ott"])).fingerprint);
        // The known limit: a button outside any list that names a person ("Unfollow Alice Smith") makes the sheet of each person its own
        // screen. The explorer opens a list's rows only a few times, so this stays small (docs/features/phone-ai-tests.md).
        expect(read(POST_SHEET("Alice Smith")).fingerprint).toBe(read(POST_SHEET("Alice Smith")).fingerprint);
        expect(read(POST_SHEET("Alice Smith")).fingerprint).not.toBe(read(POST_SHEET("Acme Cloud")).fingerprint);
    });
    it("turning a switch on keeps the screen; the selected tab changes it", () => {
        expect(read(SETTINGS(false)).fingerprint).toBe(read(SETTINGS(true)).fingerprint);
        const jobsTab = FEED.replace(/selected="true"/, 'selected="false"').replace(/(resource-id="com\.linkedin\.android:id\/nav_jobs"[^>]*?)selected="false"/, '$1selected="true"');
        expect(read(jobsTab).fingerprint).not.toBe(read(FEED).fingerprint);
    });
    it("Compose: test tags name the screens; a list with other jobs is the same screen, the details another", () => {
        const a = read(COMPOSE_JOBS(), COMPOSE_APP, `${COMPOSE_APP}.MainActivity`);
        const b = read(COMPOSE_JOBS(["Nurse", "Chef"]), COMPOSE_APP, `${COMPOSE_APP}.MainActivity`);
        const c = read(COMPOSE_JOB(), COMPOSE_APP, `${COMPOSE_APP}.MainActivity`);
        expect(a.fingerprint).toBe(b.fingerprint);
        expect(c.fingerprint).not.toBe(a.fingerprint);
        expect(read(COMPOSE_JOB("Nurse"), COMPOSE_APP, `${COMPOSE_APP}.MainActivity`).fingerprint).toBe(c.fingerprint);
    });
    it("the tokens are only shape and static labels: no person, post or count reaches them", () => {
        const tokens = structureTokens(read(FEED).elements).join("\n");
        for (const word of ["Alice", "Bob", "reactions", "Proud", "Hiring", "3 new"]) expect(tokens).not.toContain(word);
        expect(tokens).toContain("S:RecyclerView|feed_recycler_view");
        expect(tokens).toContain("B:BottomNavigationItemView|nav_home:home:selected");
        expect(tokens).toContain("notifications, # new notifications");
    });
    it("works the same on a flat list without the hierarchy (a runner's snapshot): containment comes from the bounds", () => {
        const s = read(FEED);
        const flat = s.elements.map(({ inScroll: _i, scopes: _s, ...e }: any) => e);
        const s2 = read(FEED_SCROLLED_TWICE);
        const flat2 = s2.elements.map(({ inScroll: _i, scopes: _s, ...e }: any) => e);
        expect(fingerprintOf(s.package, s.activity, flat, s.height)).toBe(fingerprintOf(s2.package, s2.activity, flat2, s2.height));
        expect(textFingerprintOf(s.package, s.activity, flat)).not.toBe(textFingerprintOf(s2.package, s2.activity, flat2));
    });
});

// ── the graph's view of a screen ────────────────────────────────────────────

describe("landmarks and element keys", () => {
    it("finds the bottom navigation, the selected tab and the toolbar", () => {
        const feed = landmarksOf(read(FEED));
        expect(feed.tabs).toEqual(["Home", "My Network", "Post", "Notifications", "Jobs"]);
        expect(feed.selectedTab).toBe("Home");
        const profile = landmarksOf(read(PROFILE()));
        expect(profile.menuIndexes.size).toBeGreaterThanOrEqual(2);
        expect(landmarksOf(read(SETTINGS(false))).toolbarTitle).toBe("Settings");
        expect(displayLabel("Notifications, 3 new notifications")).toBe("Notifications");
        expect(displayLabel("Inbox (12)")).toBe("Inbox");
    });
    it("names the rows of a list as one template, and finds them again after scrolling", () => {
        const a = read(FEED);
        const keys = elementKeys(a);
        const card = keys.filter((k) => k.startsWith("item:"));
        expect(new Set(card)).toEqual(new Set(["item:LinearLayout|feed_item_update_card", "item:TextView|feed_item_commentary", "item:Button|feed_item_like", "item:Button|feed_item_comment", "item:Button|feed_item_reshare", "item:Button|feed_item_send"]));
        // After a scroll the same key finds the first visible row of the template.
        const b = read(FEED_SCROLLED_ONCE);
        expect(findByKey(b, "item:LinearLayout|feed_item_update_card")?.id).toBe("feed_item_update_card");
        // Chrome keys carry the static label, and are the same on every visit.
        expect(keys).toContain("el:ImageButton|home_messaging|messaging, # new");
        expect(elementKeys(read(FEED_REFRESHED))).toContain("el:ImageButton|home_messaging|messaging, # new");
    });
    it("the activities the phone lists for the app are read from the activity resolver table only", () => {
        const dumpsys = [
            "Activity Resolver Table:",
            "  Non-Data Actions:",
            "      android.intent.action.MAIN:",
            "        5a1b2c3 com.example.shop/.MainActivity filter 9d8e7f6",
            "      android.intent.action.VIEW:",
            "        7c0 com.example.shop/com.example.shop.ProductActivity filter 1e0",
            "        7c1 com.other.app/.Spy filter 1e1",
            "",
            "Receiver Resolver Table:",
            "  Non-Data Actions:",
            "        4f1 com.example.shop/.BootReceiver filter 2a",
            "Packages:",
            "  Package [com.example.shop] (a1b2c3):",
        ].join("\r\n");
        expect(activitiesFromPackageDump(dumpsys, SHOP)).toEqual(["MainActivity", "ProductActivity"]);
        expect(activitiesFromPackageDump("Packages:\n  Package [x]", SHOP)).toEqual([]);
    });
});

describe("depth settings", () => {
    it("Quick, Standard and Thorough have the numbers the person is told, and plateaus well inside them", () => {
        for (const d of ["quick", "standard", "thorough"] as const) {
            const L = depthLimits(d);
            expect([L.maxScreens, L.maxActions, L.maxMs / 60_000, L.maxIdeas]).toEqual([DEPTHS[d].screens, DEPTHS[d].actions, DEPTHS[d].minutes, DEPTHS[d].ideas]);
            expect(L.plateauActions).toBeLessThan(L.maxActions);
            expect(L.aiStallActions).toBeLessThan(L.plateauActions);
            expect(L.reserveModelCalls).toBeLessThan(L.maxModelCalls);
        }
        expect([depthLimits("quick").maxScreens, depthLimits("standard").maxScreens, depthLimits("thorough").maxScreens]).toEqual([40, 150, 300]);
        expect([depthLimits("quick").maxActions, depthLimits("standard").maxActions, depthLimits("thorough").maxActions]).toEqual([150, 600, 1200]);
    });
});

// ── apps for the explorer ───────────────────────────────────────────────────

const TAB_Y = 580;
const tabs = (selected: string): El[] =>
    ["Home", "Search", "Library", "Inbox", "Profile"].map((t, i) => ({ cls: "BottomNavigationItemView", id: `nav_${t.toLowerCase()}`, desc: t, tap: (d) => d.goto(t.toLowerCase()), selected: t.toLowerCase() === selected, bounds: [i * 72, TAB_Y, i * 72 + 72, 640] as [number, number, number, number] }));
const title = (t: string): El => ({ text: t, id: "toolbar_title", bounds: [16, 8, 300, 48] });

/** A tabbed app of exactly 60 screens, with things it must never tap (log out, delete, buy, send). */
const CATS = ["Apples", "Bikes", "Cameras", "Drinks", "Engines", "Flowers", "Games", "Hats", "Inks", "Jackets"];
const SETTING_PAGES = ["Account", "Privacy", "Security", "Language", "Display", "Sound", "Storage", "Battery", "Network", "Backup", "Accessibility", "Updates", "Location", "Keyboard", "Calendar"];
const ABOUT = ["About us", "About the team", "About the history", "About the future"];

function bigApp(): { app: AppDef; count: number } {
    const screens: AppDef["screens"] = {};
    const tab = (name: string, els: El[]) => (screens[name] = { activity: "MainActivity", els: () => [title(name[0]!.toUpperCase() + name.slice(1)), ...els, ...tabs(name)] });
    tab("home", [
        { text: "Notifications", id: "notifications_button", tap: "notifications" },
        { cls: "RecyclerView", id: "feed", scrollable: true, bounds: [0, 100, 360, 560] },
        ...[0, 1, 2].map((i) => ({ cls: "LinearLayout", id: "story_row", text: `Story by person ${i}`, tap: "post", bounds: [0, 110 + i * 120, 360, 220 + i * 120] as [number, number, number, number] })),
    ]);
    screens.notifications = { activity: "MainActivity", els: () => [title("Notifications"), { text: "Nothing new", id: "empty" }] };
    screens.post = { activity: "PostActivity", els: () => [title("Story"), { text: "Like", id: "like_button", tap: () => undefined }] };
    tab("search", [{ field: "q", text: "Search", id: "search_box" }]);
    screens.results = { activity: "MainActivity", els: () => [title("Results"), { text: "Result one", id: "result_title" }] };
    tab("library", [...CATS.map((c, i) => ({ text: c, id: `category_${i + 1}`, tap: `cat${i + 1}` })), { text: "Buy premium", id: "buy_button", tap: "pay" }]);
    for (let i = 1; i <= 10; i++) {
        screens[`cat${i}`] = { activity: "CategoryActivity", els: () => [title(CATS[i - 1]!), { text: "Part one", id: "part_1", tap: `cat${i}a` }, { text: "Part two", id: "part_2", tap: `cat${i}b` }] };
        screens[`cat${i}a`] = { activity: "PartActivity", els: () => [title(`${CATS[i - 1]}, part one`), { text: "A page of text", id: "body" }] };
        screens[`cat${i}b`] = { activity: "PartActivity", els: () => [title(`${CATS[i - 1]}, part two`), { text: "Another page", id: "body" }] };
    }
    screens.pay = { activity: "PayActivity", els: () => [title("Pay"), { text: "Pay now", id: "pay_now", tap: (d) => (d.state.paid = true) }] };
    tab("inbox", [{ text: "Conversation with Kim", id: "thread_row", tap: "thread" }]);
    screens.thread = { activity: "ThreadActivity", els: () => [title("Conversation"), { text: "Hello there", id: "message" }, { text: "Send", id: "send_button", tap: (d) => (d.state.sent = true) }] };
    tab("profile", [{ text: "Settings", id: "settings_button", tap: "settings" }, { text: "Log out", id: "logout_button", tap: (d) => (d.state.loggedOut = true) }, { text: "Delete account", id: "delete_button", tap: (d) => (d.state.deleted = true) }]);
    screens.settings = { activity: "SettingsActivity", els: () => [title("Settings"), ...SETTING_PAGES.map((t, i) => ({ text: t, id: `setting_${i + 1}`, tap: `set${i + 1}` })), { text: "About", id: "about_button", tap: "about1" }] };
    for (let i = 1; i <= 15; i++) screens[`set${i}`] = { activity: "SettingsActivity", els: () => [title(`${SETTING_PAGES[i - 1]} settings`), { text: "Nothing to change here", id: "body" }] };
    for (let i = 1; i <= 4; i++) screens[`about${i}`] = { activity: "AboutActivity", els: () => [title(ABOUT[i - 1]!), ...(i < 4 ? [{ text: "More about it", id: "more_about", tap: `about${i + 1}` }] : [])] };
    // The search field shows its results on the same screen once something is typed.
    const search = screens.search!;
    screens.search = { activity: "MainActivity", els: (d) => [...search.els(d), ...(d.fields.q ? [{ text: "Open first result", id: "first_result", tap: "results" } as El] : [])] };
    // Screens reachable without paying: everything but "pay"; "search" with results is the same screen shape plus a button (its own screen).
    const count = Object.keys(screens).length - 1 /* pay */ + 1; /* search with a typed word */
    return { app: { pkg: "com.example.big", start: "home", screens }, count };
}

describe("the map explorer on an in-memory phone", () => {
    it("explores a 60-screen app until it is fully explored, at the phone's speed: the AI only names the screens", async () => {
        const { app, count } = bigApp();
        expect(count).toBe(60);
        const ai = aiDouble({ names: (p) => ({ names: [...p.matchAll(/^(S\d+): title "([^"]+)"/gm)].map((m) => ({ id: m[1]!, name: `${m[2]} page` })) }) });
        const { model, device, events } = await mapExplore(app, { ai });
        expect(model.stats.stop).toBe("explored");
        expect(model.stats.stoppedBecause).toMatch(/fully explored/);
        expect(model.screens.length).toBe(60);
        expect(model.coverage).toMatchObject({ depth: "standard", screens: 60, stop: "explored", actionsLeft: 0 });
        expect(model.coverage!.activitiesSeen).toEqual(expect.arrayContaining(["MainActivity", "CategoryActivity", "PartActivity", "SettingsActivity", "AboutActivity", "ThreadActivity", "PostActivity"]));
        // No AI turn for plain navigation; one call names the screens.
        expect(ai.calls.turn).toBe(0);
        expect(ai.calls.names).toBe(1);
        expect(model.stats.modelCalls).toBe(1);
        expect(model.screens.filter((s) => s.aiName?.endsWith(" page")).length).toBeGreaterThanOrEqual(58);
        // Never: log out, delete, buy, send.
        expect(device.state).not.toHaveProperty("loggedOut");
        expect(device.state).not.toHaveProperty("deleted");
        expect(device.state).not.toHaveProperty("paid");
        expect(device.state).not.toHaveProperty("sent");
        const why = model.skipped.map((s) => s.message).join("\n");
        expect(why).toMatch(/“Log out” because signing out/);
        expect(why).toMatch(/“Delete account” because it looks destructive/);
        expect(why).toMatch(/“Buy premium” because it looks like a payment/);
        expect(why).toMatch(/“Send” because it looks like sending/);
        // A feed is opened through one of its rows, not row by row.
        expect(device.tapped.filter((t) => t.startsWith("Story by")).length).toBeLessThanOrEqual(depthLimits("standard").maxListItems);
        // The graph: main tabs, depth, names; the live counts were reported.
        expect(mainTabs(model).map((t) => t.label)).toEqual(expect.arrayContaining(["Search", "Library", "Inbox", "Profile"]));
        const d = depths(model);
        expect(d.get(byTitle(model, "About the future page")!.id)).toBe(6);
        expect(byTitle(model, "About the future page")!.depth).toBe(6);
        expect(events.filter((e) => e.kind === "mobile_progress").length).toBeGreaterThan(10);
        const done = events.find((e) => e.kind === "mobile_exploration_done")!;
        expect(done.message).toMatch(/60 screens, \d+ activities, \d+ actions, 1 AI calls/);
    }, 30_000);
    it("tries main navigation first, then the toolbar and buttons, then a scroll, list rows last", async () => {
        const app: AppDef = {
            pkg: "com.example.order",
            start: "home",
            screens: {
                home: {
                    activity: "MainActivity",
                    els: () => [
                        { cls: "ImageButton", desc: "More options", id: "overflow", tap: "menu", bounds: [300, 4, 356, 44] },
                        title("Home"),
                        { cls: "RecyclerView", id: "list", scrollable: true, bounds: [0, 100, 360, 500] },
                        { cls: "LinearLayout", id: "row", text: "Row one", tap: "row", bounds: [0, 110, 360, 200] },
                        { cls: "LinearLayout", id: "row", text: "Row two", tap: "row", bounds: [0, 210, 360, 300] },
                        { text: "Help", id: "help_button", tap: "help", bounds: [0, 520, 360, 560] },
                        ...tabs("home").slice(0, 3),
                    ],
                },
                menu: { activity: "MenuActivity", els: () => [title("Menu")] },
                row: { activity: "RowActivity", els: () => [title("Row")] },
                help: { activity: "HelpActivity", els: () => [title("Help")] },
                search: { activity: "MainActivity", els: () => [title("Search"), ...tabs("search").slice(0, 3)] },
                library: { activity: "MainActivity", els: () => [title("Library"), ...tabs("library").slice(0, 3)] },
            },
        };
        const { device } = await mapExplore(app);
        let t = 0;
        const order = device.acts.flatMap((a) => (a.kind === "tap" ? [device.tapped[t++]!] : a.kind === "scroll" ? ["scroll"] : []));
        const first = (label: string) => {
            const i = order.findIndex((x) => x.startsWith(label));
            expect(i, label).toBeGreaterThanOrEqual(0);
            return i;
        };
        expect(first("Search")).toBeLessThan(first("More options"));
        expect(first("More options")).toBeLessThan(first("Help"));
        expect(first("Help")).toBeLessThan(first("scroll"));
        expect(first("scroll")).toBeLessThan(first("Row"));
    });
    it("stops on a plateau when nothing new appears, and says so in plain words", async () => {
        const app: AppDef = { pkg: "com.example.flat", start: "home", screens: { home: { activity: "MainActivity", els: () => [title("Home"), ...Array.from({ length: 80 }, (_, i) => ({ text: `Option ${i + 1}`, id: `option_${i + 1}`, tap: () => undefined }))] } } };
        const { model, ai } = await mapExplore(app, { limits: { plateauActions: 30, aiStallActions: 500 } });
        expect(model.stats.stop).toBe("plateau");
        expect(model.stats.stoppedBecause).toBe("No new screens after 30 actions: the app looks fully explored");
        expect(model.stats.actions).toBe(30);
        expect(ai.calls.turn).toBe(0);
    });
    it("when stuck, asks the AI once which untried action looks most promising, and does it", async () => {
        const app: AppDef = {
            pkg: "com.example.stuck",
            start: "home",
            screens: {
                home: { activity: "MainActivity", els: () => [title("Home"), ...Array.from({ length: 40 }, (_, i) => ({ text: `Option ${i + 1}`, id: `option_${i + 1}`, tap: () => undefined })), { text: "Secret garden", id: "garden", tap: "garden" }] },
                garden: { activity: "GardenActivity", els: () => [title("Garden")] },
            },
        };
        const ai = aiDouble({ turn: (p) => ({ action: { kind: "tap", index: Number(/\[(\d+)\][^"\n]*"Secret garden"/.exec(p)![1]) } }) });
        const { model, device, events } = await mapExplore(app, { ai, limits: { aiStallActions: 10, plateauActions: 200 } });
        // Asked once per stretch without a new screen (here: before the garden, and once more after it), never per action.
        expect(ai.calls.turn).toBeGreaterThanOrEqual(1);
        expect(ai.calls.turn).toBeLessThanOrEqual(Math.ceil(model.stats.actions / 10));
        expect(device.tapped.indexOf("Secret garden")).toBe(10);
        expect(model.screens.map((s) => s.title)).toContain("Garden");
        expect(events.some((e) => /the AI chose “Secret garden”/.test(e.message))).toBe(true);
        expect(ai.prompts.find((p) => p.includes("No new screen appeared"))).toMatch(/already tried/);
    });
    it("an AI usage limit reached mid-run ends the exploration cleanly, in the limit's own words, with what it found", async () => {
        const app: AppDef = {
            pkg: "com.example.capped",
            start: "home",
            screens: {
                home: { activity: "MainActivity", els: () => [title("Home"), { text: "Garden", id: "garden", tap: "garden" }, ...Array.from({ length: 40 }, (_, i) => ({ text: `Option ${i + 1}`, id: `option_${i + 1}`, tap: () => undefined }))] },
                garden: { activity: "GardenActivity", els: () => [title("Garden")] },
            },
        };
        const limit = Object.assign(new Error("The AI token limit for this job was reached"), { name: "BudgetExceeded" });
        const ai = aiDouble({
            turn: () => {
                throw limit;
            },
        });
        const { model, events } = await mapExplore(app, { ai, limits: { aiStallActions: 10, plateauActions: 200 } });
        expect(ai.calls.turn).toBe(1);
        expect(model.stats.stop).toBe("ai-limit");
        expect(model.stats.stoppedBecause).toBe("The AI token limit for this job was reached");
        expect(model.stats.aiLimit).toBe("The AI token limit for this job was reached");
        // What it had found is kept, and no AI call follows the limit (no naming at the end).
        expect(model.screens.map((s) => s.title)).toEqual(["Home", "Garden"]);
        expect(ai.calls.names).toBe(0);
        expect(events.at(-1)!.kind).toBe("mobile_exploration_done");
        // The naming call refused at the end: the exploration still ends as explored, and says the limit was reached.
        const naming = aiDouble({
            names: () => {
                throw limit;
            },
        });
        const small = await mapExplore({ pkg: "com.example.small", start: "home", screens: { home: { activity: "MainActivity", els: () => [title("Home"), { text: "About", id: "about", tap: "about" }] }, about: { activity: "AboutActivity", els: () => [title("About")] } } }, { ai: naming });
        expect(naming.calls.names).toBe(1);
        expect(small.model.stats.stop).toBe("explored");
        expect(small.model.stats.aiLimit).toBe("The AI token limit for this job was reached");
        expect(small.model.screens.map((s) => s.title)).toEqual(["Home", "About"]);
    });
    it("honours the depth's screen limit and tells the person how to go further", async () => {
        const { app } = bigApp();
        const { model } = await mapExplore(app, { depth: "quick", limits: { maxScreens: 8 } });
        expect(model.screens.length).toBe(8);
        expect(model.stats.stop).toBe("screens");
        expect(model.stats.stoppedBecause).toMatch(/^Reached the limit of 8 screens of a Quick exploration \(choose a more thorough exploration under How thorough/);
        const actions = await mapExplore(app, { depth: "thorough", limits: { maxActions: 12 } });
        expect(actions.model.stats.stop).toBe("actions");
        expect(actions.model.stats.stoppedBecause).toBe("Reached the limit of 12 actions of a Thorough exploration");
    });
    it("recovers: starts the app again and replays the shortest known path, and marks an edge that leads elsewhere as unreliable", async () => {
        let areaTaps = 0;
        const app: AppDef = {
            pkg: "com.example.paths",
            start: "home",
            screens: {
                home: { activity: "MainActivity", els: () => [title("Home"), { text: "Area", id: "area_button", tap: (d) => d.goto(++areaTaps <= 2 ? "area" : "maintenance") }, { text: "Other", id: "other_button", tap: "other" }] },
                // "Deep" forgets how it got here: going back does nothing, only a fresh start leaves it.
                area: {
                    activity: "AreaActivity",
                    els: () => [
                        title("Area"),
                        { text: "Deep", id: "deep_button", tap: (d) => { d.goto("deep"); d.stack = []; } },
                        { text: "Second", id: "second_button", tap: (d) => { d.goto("second"); d.stack = []; } },
                        { text: "Third", id: "third_button", tap: (d) => { d.goto("third"); d.stack = []; } },
                        { text: "Fourth", id: "fourth_button", tap: "fourth" },
                    ],
                },
                fourth: { activity: "FourthActivity", els: () => [title("Fourth")] },
                deep: { activity: "DeepActivity", els: () => [title("Deep")] },
                other: { activity: "OtherActivity", els: () => [title("Other")] },
                second: { activity: "SecondActivity", els: () => [title("Second")] },
                third: { activity: "ThirdActivity", els: () => [title("Third")] },
                maintenance: { activity: "MaintenanceActivity", els: () => [title("Down for maintenance")] },
            },
        };
        const { model, device, events } = await mapExplore(app);
        expect(device.acts.some((a) => a.kind === "restart")).toBe(true);
        const area = model.edges.find((e) => e.action.kind === "tap" && e.action.label === "Area")!;
        expect(area.replays?.ok).toBeGreaterThanOrEqual(1);
        // From the third time on, "Area" leads to maintenance: the replay did not arrive, twice, so the edge is not trusted.
        expect(area.replays?.failed).toBeGreaterThanOrEqual(2);
        expect(area.unreliable).toBe(true);
        expect(model.coverage?.unreliableEdges).toBeGreaterThanOrEqual(1);
        expect(shortestPath(model, model.start, area.to)).toBeUndefined();
        expect(shortestPath(model, model.start, area.to, { includeUnreliable: true })).toHaveLength(1);
        expect(model.stats.stop).toBe("explored");
        expect(events.some((e) => /could not be reached again|were left/.test(e.message))).toBe(true);
    });
    it("a feed that changes with every scroll stays one screen, and its rows are opened at most a few times", async () => {
        const app: AppDef = {
            pkg: "com.example.feed",
            start: "feed",
            screens: {
                feed: {
                    activity: "MainActivity",
                    els: (d) => {
                        const n = (d.state.scrolled as number | undefined) ?? 0;
                        return [
                            title("Feed"),
                            { cls: "RecyclerView", id: "feed_list", scrollable: true, bounds: [0, 60, 360, 600] },
                            ...[0, 1, 2].map((k) => ({ cls: "LinearLayout", id: "feed_card", text: `${["Ann", "Ben", "Cid", "Dee", "Eve"][(n + k) % 5]} posted ${n * 3 + k} minutes ago`, tap: "detail", bounds: [0, 70 + k * 170, 360, 230 + k * 170] as [number, number, number, number] })),
                            ...(n % 2 ? [{ cls: "Button", id: "ad_cta", text: "Learn more", tap: "ad", bounds: [0, 560, 180, 590] as [number, number, number, number] }] : []),
                        ];
                    },
                },
                detail: { activity: "DetailActivity", els: () => [title("Post details")] },
                ad: { pkg: "com.android.chrome", activity: "Main", els: () => [{ text: "An advert", id: "page" }] },
            },
        };
        const { model, device } = await mapExplore(app);
        expect(model.screens.filter((s) => s.title === "Feed")).toHaveLength(1);
        expect(model.screens.map((s) => s.title).sort()).toEqual(["Feed", "Post details"]);
        expect(device.tapped.filter((t) => /posted/.test(t)).length).toBeGreaterThanOrEqual(1);
        expect(device.tapped.filter((t) => /posted/.test(t)).length).toBeLessThanOrEqual(3);
        expect(listDetails(model).map((x) => [x.list.title, x.detail.title])).toEqual([["Feed", "Post details"]]);
        expect(model.screens.find((s) => s.title === "Feed")!.textFingerprints!.length).toBeGreaterThan(1);
    });
    it("answers dialogs as a watchdog: a permission question, an app that is not responding, another app in front", async () => {
        const app = shopApp();
        app.screens.anr = { pkg: "android", activity: "AppNotRespondingDialog", els: () => [{ text: "Shop isn't responding", id: "alertTitle" }, { text: "Close app", id: "aerr_close", tap: (d) => d.goto("home", false) }, { text: "Wait", id: "aerr_wait", tap: (d) => d.goto("products", false) }] };
        app.screens.products!.els = () => [title("Products"), { text: "Heavy report", id: "heavy", tap: (d) => d.goto("anr", false) }];
        const { model, device, events } = await mapExplore(app);
        expect(device.tapped[0]).toBe("Don't allow");
        expect(device.tapped).toContain("Wait");
        expect(events.some((e) => /not responding: waited once/.test(e.message))).toBe(true);
        // The terms link opened the browser: the explorer went back, the browser is no screen of the app.
        expect(device.tapped).toContain("Terms and conditions");
        expect(model.screens.every((s) => s.package === SHOP)).toBe(true);
        expect(model.permissions?.[0]).toMatchObject({ allowed: false });
    });
    it("signs in with the test account through the sign-in helper: placeholders only, and never signs out", async () => {
        const { model, device, events } = await mapExplore(shopApp({ permission: false }), { credentials: true });
        expect(device.realTyped.filter((t) => t.field !== "search")).toEqual([{ field: "username", text: "tester" }, { field: "password", text: "Fake-Pass-1234" }]);
        expect(model.signedIn).toBe(true);
        expect(model.signInNeeded).toBe(false);
        expect(device.tapped).not.toContain("Log out");
        expect(device.state.loggedIn).toBe(true);
        const trace = JSON.stringify({ model, events });
        expect(trace).not.toContain("Fake-Pass-1234");
        const signIn = model.edges.find((e) => e.via === "sign-in" && e.prelude.some((p) => p.kind === "type" && p.text === PASSWORD_PLACEHOLDER))!;
        expect(signIn.action).toMatchObject({ kind: "tap", label: "Log in" });
        expect(byTitleIncludes(model, "Shop").length).toBe(2); // signed out and signed in are different screens
    });
    it("without sign-in details leaves the sign-in screen alone and says sign-in is needed", async () => {
        const { model, device, events } = await mapExplore(shopApp({ permission: false }));
        expect(device.realTyped.filter((t) => t.field !== "search")).toEqual([]);
        expect(model.signInNeeded).toBe(true);
        expect(events.some((e) => e.kind === "mobile_sign_in_needed")).toBe(true);
    });
    it("sends a form empty and filled in with harmless data, and records what it answered", async () => {
        const app: AppDef = {
            pkg: SHOP,
            start: "form",
            screens: {
                form: {
                    activity: "ContactActivity",
                    els: (d) => [
                        title("Contact us"),
                        { field: "name", text: "Your name", id: "name_field" },
                        { field: "nick", text: "Handle", id: "handle_field" },
                        { text: "Next", id: "next_button", tap: (x) => { if (x.fields.name) x.goto("thanks"); else x.state.error = "Name is required"; } },
                        ...(d.state.error && !d.fields.name ? [{ text: String(d.state.error), id: "error_text" }] : []),
                    ],
                },
                thanks: { activity: "ThanksActivity", els: () => [{ text: "Thank you for writing", id: "thanks_title" }] },
            },
        };
        const ai = aiDouble({ fields: () => ({ fields: [{ n: 0, kind: "username" }] }) });
        const { model, device } = await mapExplore(app, { ai });
        expect(model.submits.map((s) => [s.filled, s.shown.map((x) => x.text)])).toEqual([[false, ["Name is required"]]]);
        expect(device.realTyped).toEqual([{ field: "name", text: "Test User" }, { field: "nick", text: "testuser" }]);
        // The AI said what the unknown field is for (never what to type); "Next" needs no risk question.
        expect(ai.calls.fields).toBe(1);
        expect(ai.calls.risk).toBe(0);
        const filled = model.edges.find((e) => e.via === "form")!;
        expect(filled.prelude.map((p) => p.kind)).toEqual(["type", "type"]);
        const { candidates } = buildCandidates(model);
        expect(candidates.map((c) => c.family)).toEqual(expect.arrayContaining(["start", "forms"]));
    });
    it("asks whether sending a form changes data when that is not allowed, and does not send it when the AI says it would", async () => {
        const app: AppDef = {
            pkg: SHOP,
            start: "note",
            screens: {
                note: { activity: "NoteActivity", els: () => [title("New note"), { field: "body", text: "Write something", id: "note_body" }, { text: "Done", id: "done_button", tap: (d) => { d.state.kept = true; d.goto("list"); } }] },
                list: { activity: "ListActivity", els: () => [title("Notes")] },
            },
        };
        const careful = await mapExplore(app, { ai: aiDouble({ risk: true }) });
        expect(careful.ai.calls.risk).toBe(1);
        expect(careful.model.skipped.some((s) => s.why === "data-change" && /Skipped sending the form on “New note”/.test(s.message))).toBe(true);
        // Sent empty once (to see what the app says), never filled.
        expect(careful.device.realTyped).toEqual([]);
        const allowed = await mapExplore(app, { allowData: true, ai: aiDouble({ risk: true }) });
        expect(allowed.ai.calls.risk).toBe(0);
        expect(allowed.device.realTyped.length).toBe(1);
    });
    it("stops at once when the job is cancelled", async () => {
        const { app } = bigApp();
        const controller = new AbortController();
        const device = new MemoryDevice(app);
        const act = device.act.bind(device);
        let n = 0;
        device.act = async (a, o) => {
            if (++n === 5) controller.abort();
            return act(a, o);
        };
        const { ctx } = context(aiDouble().llm, controller.signal);
        await expect(explore({ ctx, session: device, appPackage: app.pkg, credentialsGiven: false, allowDataChanges: false, strategy: "map" }, new ModelBudget(20))).rejects.toThrow(/cancelled/i);
    });
    it("stops before the session's own action limit (a runner's session has 500)", async () => {
        const { app } = bigApp();
        const device = new MemoryDevice(app);
        Object.defineProperty(device, "actionLimit", { value: 40 });
        const { model } = await mapExplore(app, { device });
        expect(model.stats.actions).toBeLessThanOrEqual(40);
        expect(model.stats.stoppedBecause).toMatch(/^Reached the limit of 30 actions/);
        expect(model.stats.stop).toBe("actions");
    });
    it("the planner's candidates and tests come out of a map exploration as before", async () => {
        const { app } = bigApp();
        const { model } = await mapExplore(app);
        const { candidates } = buildCandidates(model, { maxPathEdges: 8 });
        expect(candidates.length).toBeGreaterThan(30);
        expect(candidates.every((c) => c.steps.every((s) => s.action !== "click" || "locator" in s))).toBe(true);
        expect(pathFromStart(model, byTitle(model, "Cameras, part two")!.id)!.map((e) => e.action.kind === "tap" && e.action.label)).toEqual(["Library", "Cameras", "Part two"]);
    });
});

const byTitleIncludes = (m: MobileAppModel, t: string) => m.screens.filter((s) => s.title.includes(t));

// ── the graph on its own ────────────────────────────────────────────────────

describe("the screen graph", () => {
    const screen = (id: string, extra: Partial<MobileScreen> = {}): MobileScreen => ({ id, title: id, package: SHOP, kind: "other", elements: [], visits: 1, hasForm: false, scrollable: false, ...extra });
    const tap = (label: string) => ({ kind: "tap" as const, screen: "S1", label, loc: { by: "text" as const, value: label } });
    const edge = (id: string, from: string, to: string, extra: Partial<Edge> = {}): Edge => ({ id, from, to, prelude: [], action: tap(`${from}->${to}`), ...extra });

    it("finds the nearest screen with something left, through edges that replay", () => {
        const g = new ScreenGraph({ maxEdges: 50, maxListItems: 2 });
        for (const id of ["S1", "S2", "S3", "S4"]) g.add(screen(id), `p${id}`);
        g.addEdge({ from: "S1", to: "S2", prelude: [], action: tap("a") }, [{ kind: "tap", key: "el:Button|a|a" }]);
        g.addEdge({ from: "S2", to: "S3", prelude: [], action: tap("b") }, [{ kind: "tap", key: "el:Button|b|b" }]);
        g.addEdge({ from: "S1", to: "S4", prelude: [], action: tap("c") }, [{ kind: "tap", key: "el:Button|c|c" }]);
        g.offer("S3", [{ key: "x", kind: "tap", label: "x", via: "button", priority: 2 }]);
        g.offer("S4", [{ key: "y", kind: "tap", label: "y", via: "list-item", priority: 5 }, { key: "z", kind: "tap", label: "z", via: "tab", priority: 0 }]);
        expect(g.nearestFrontier("S1", 5)?.target).toBe("S4");
        expect(g.next("S4")?.key).toBe("z");
        g.tried("S4", "z");
        g.tried("S4", "y");
        expect(g.nearestFrontier("S1", 5)).toMatchObject({ target: "S3", path: [{ from: "S1" }, { from: "S2" }] });
        // An edge that did not replay twice is not walked any more.
        const e = g.edges[0]!;
        g.replayed(e, false);
        g.replayed(e, false);
        expect(e.unreliable).toBe(true);
        expect(g.nearestFrontier("S1", 5)).toBeUndefined();
        expect(g.frontierScreens()).toEqual(["S3"]);
        expect(g.abandon("S3")).toBe(1);
        expect(g.frontierScreens()).toEqual([]);
    });
    it("list rows stop at the per-screen cap; aliases name the same screen", () => {
        const g = new ScreenGraph({ maxEdges: 50, maxListItems: 1 });
        const s = screen("S1");
        g.add(s, "one");
        g.alias("two", s);
        expect(g.byFingerprint("two")).toBe(s);
        g.offer("S1", [{ key: "item:a", kind: "tap", label: "a", via: "list-item", priority: 5 }, { key: "item:b", kind: "tap", label: "b", via: "list-item", priority: 5 }]);
        g.tried("S1", "item:a");
        expect(g.next("S1")).toBeUndefined();
        expect(g.left("S1")).toBe(0);
    });
    it("paths for tests skip back edges, incomplete and unreliable ones", () => {
        const model = { start: "S1", edges: [edge("T1", "S1", "S2"), edge("T2", "S2", "S1", { via: "back", action: { kind: "back" } }), edge("T3", "S2", "S3", { incomplete: true }), edge("T4", "S1", "S3", { unreliable: true }), edge("T5", "S2", "S3")] };
        expect(pathFromStart(model, "S3")!.map((e) => e.id)).toEqual(["T1", "T5"]);
        expect(shortestPath(model, "S2", "S1")).toBeUndefined();
        expect(shortestPath(model, "S2", "S1", { includeBack: true })!.map((e) => e.id)).toEqual(["T2"]);
        expect(depths(model).get("S3")).toBe(2);
    });
    it("names screens by the AI, the toolbar or the tab, and never with a number in brackets", () => {
        const list = [screen("S1", { title: "Search" }), screen("S2", { title: "Search", selectedTab: "Jobs" }), screen("S3", { title: "Inbox", toolbarTitle: "Messages" }), screen("S4", { title: "x", aiName: "Job details" })];
        distinctTitles(list);
        const names = list.map((s) => s.title);
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(4);
        expect(names[0]).toBe("Search");
        expect(names[1]).toMatch(/^Search\b/);
        expect(names.slice(2)).toEqual(["Messages", "Job details"]);
        expect(list.every((s) => !/\(\d+\)/.test(s.title))).toBe(true);
        expect(screenLabel({ title: "t", toolbarTitle: "Heading" })).toBe("Heading");
    });
    it("the coverage sentence says what was explored and why it stopped", () => {
        expect(coverageSentence({ depth: "standard", screens: 142, activitiesSeen: Array.from({ length: 31 }, (_, i) => `A${i}`), activitiesListed: 40, actions: 600, aiCalls: 12, actionsTried: 500, actionsLeft: 0, stop: "plateau", stoppedBecause: "No new screens after 80 actions: the app looks fully explored", unreliableEdges: 0 })).toBe(
            "Explored 142 screens in 31 activities (the phone lists 40 for the app), with 600 actions and 12 AI calls. It stopped because: no new screens after 80 actions: the app looks fully explored.",
        );
    });
    it("never taps sign out, whoever chose it (the safety filter)", () => {
        const snap = { package: SHOP, width: 360, height: 640, fingerprint: "f", keyboard: false, outsideApp: false, elements: [{ index: 0, cls: "Button", text: "Sign out", desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, 0, 1, 1] as [number, number, number, number] }] };
        expect(judgeAction({ kind: "tap", index: 0 }, snap, { allowDataChanges: true })).toMatchObject({ ok: false, why: "sign-in", message: "Skipped “Sign out” because signing out would end the session the exploration uses" });
        expect(judgeAction({ kind: "tap", index: 0 }, { ...snap, elements: [{ ...snap.elements[0]!, text: "", id: "logout_button" }] }, { allowDataChanges: true }).ok).toBe(false);
        expect(judgeAction({ kind: "tap", index: 0 }, { ...snap, elements: [{ ...snap.elements[0]!, text: "Log in" }] }, { allowDataChanges: true }).ok).toBe(true);
    });
});
