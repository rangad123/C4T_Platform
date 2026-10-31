/**
 * AI phone tests, the screens' own logic (MX-C). Fast tier: no browser, no network. The words, the choices a person is offered, what is read from
 * the platform's answers, the plan sums for a phone app (and that a website plan still adds up exactly as before), and the provenance line.
 */
import { describe, expect, it } from "vitest";
import type { EventRow, Job, PlatformConfig } from "../web/src/api.js";
import type { Agent } from "../web/src/features/agents/agents.js";
import { countOf, createBody, createSentence, foundSentence, ideasOf, initialChoice, isOn, normalizePlan, phoneOnlyPlan, planLines, planTotal, type PlanAnswer, type PlanChoice, type ReadyPlan } from "../web/src/features/onboarding/onboarding.js";
import * as phone from "../web/src/features/phone/phone.js";
import { originOf, type OriginInput } from "../web/src/features/provenance/provenance.js";
import { jobLabel, KIND_LABEL } from "../web/src/lib/labels.js";

const ev = (id: number, message: string, kind = "info"): EventRow => ({ id, stage: "discovery", kind, level: "info", message, createdAt: "2026-10-17T10:00:00Z" });
const config = (mobile: PlatformConfig["mobile"]): PlatformConfig => ({ llm: { provider: "anthropic", model: "x", configured: true }, mobile, authRequired: false, frameworks: [] }) as PlatformConfig;
const agent = (over: Partial<Omit<Agent, "capabilities">> & { capabilities?: Partial<Record<keyof Agent["capabilities"], unknown>> } = {}): Agent => {
    const { capabilities, ...rest } = over;
    return {
        id: "a1",
        name: "Maya’s laptop",
        version: "1",
        tokenId: "t",
        os: "win32",
        arch: "x64",
        node: "24",
        online: true,
        lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
        firstSeenAt: "2026-01-01T00:00:00Z",
        activeTasks: 0,
        concurrency: 1,
        capabilities: ({ browsers: ["chromium"], deviceSession: true, android: { adb: true, devices: [{ serial: "emulator-5554", state: "device", emulator: true }], avds: ["Pixel_6"], state: "emulator", summary: "Android: 1 emulator ready" }, ...capabilities }) as Agent["capabilities"],
        ...rest,
    };
};

/** A job answer from a platform that does not say what the job explored. */
const NO_TARGETS = {} as Pick<Job, "targets">;

describe("which job is about a phone app", () => {
    it("reads only what the platform says", () => {
        expect(phone.isPhoneJob({ targets: ["mobile"] })).toBe(true);
        expect(phone.isPhoneJob({ targets: ["web", "mobile"] })).toBe(true);
        expect(phone.isPhoneJob({ targets: ["web"] })).toBe(false);
        expect(phone.isPhoneJob(NO_TARGETS)).toBe(false);
        expect(phone.isPhoneJob(null)).toBe(false);
        expect(phone.isPhoneOnly({ targets: ["mobile"] })).toBe(true);
        expect(phone.isPhoneOnly({ targets: ["web", "mobile"] })).toBe(false);
        expect(phone.isPhoneOnly(NO_TARGETS)).toBe(false);
    });
    it("names the app, and knows an iPhone app alone cannot be explored", () => {
        expect(phone.appLabel({ appPackage: "com.example.shop", apk: null, avd: null })).toBe("com.example.shop");
        expect(phone.appLabel({ appPackage: null, apk: "C:\\x\\uploads\\shop.apk", avd: null })).toBe("shop.apk");
        expect(phone.appLabel(null)).toBe("the app");
        expect(phone.hasAndroidApp({ appPackage: null, apk: "a.apk", avd: null })).toBe(true);
        expect(phone.hasAndroidApp({ appPackage: null, apk: null, avd: null, iosBundleId: "com.apple.x" })).toBe(false);
        expect(phone.iPhoneOnly({ appPackage: null, apk: null, avd: null, iosBundleId: "com.apple.x" })).toBe(true);
        expect(phone.iPhoneOnly({ appPackage: "a.b", apk: null, avd: null, iosBundleId: "com.apple.x" })).toBe(false);
        expect(phone.iPhoneOnly(null)).toBe(false);
    });
    it("tells apart a project with no app, an app file without a name, an iPhone app and an app that can be explored", () => {
        expect(phone.appState(null)).toBe("none");
        expect(phone.appState({ appPackage: null, apk: null, avd: null })).toBe("none");
        expect(phone.appState({ appPackage: null, apk: "shop.apk", avd: null })).toBe("needs-package");
        expect(phone.appState({ appPackage: null, apk: null, avd: null, iosBundleId: "com.apple.x" })).toBe("ios-only");
        expect(phone.appState({ appPackage: "com.example.shop", apk: null, avd: null })).toBe("ready");
        expect(phone.appState({ appPackage: "com.example.shop", apk: "shop.apk", avd: null, iosBundleId: "com.apple.x" })).toBe("ready");
    });
    it("a job that does not say what it explored is a phone job when the project's application is a phone app", () => {
        expect(phone.isPhoneUrl("android-app://com.example.shop")).toBe(true);
        expect(phone.isPhoneUrl("https://example.com")).toBe(false);
        expect(phone.isPhoneUrl(null)).toBe(false);
        expect(phone.packageOfUrl("android-app://com.example.shop")).toBe("com.example.shop");
        expect(phone.packageOfUrl(undefined)).toBe("");
        const bare = { jobId: "j" } as Pick<Job, "targets">;
        expect(phone.phoneJobOf(bare, "android-app://com.example.shop").targets).toEqual(["mobile"]);
        expect(phone.phoneJobOf(bare, "https://example.com")).toBe(bare);
        expect(phone.phoneJobOf(bare, undefined)).toBe(bare);
        // What the platform says is believed.
        const web = { targets: ["web"] } as Pick<Job, "targets">;
        expect(phone.phoneJobOf(web, "android-app://com.example.shop")).toBe(web);
    });
    it("Explore again goes to the phone panel for a phone job only", () => {
        expect(phone.exploreAgainHref({ targets: ["mobile"] }, "p1")).toBe("#/projects/p1/settings?section=mobile&start=phone");
        expect(phone.exploreAgainHref({ targets: ["web"] }, "p1")).toBe("#/new?project=p1");
        expect(phone.exploreAgainHref(NO_TARGETS, "p1")).toBe("#/new?project=p1");
        expect(phone.exploreAgainHref(null, "p1")).toBe("#/new?project=p1");
    });
});

describe("the package name", () => {
    it("accepts Android package names and explains the rest", () => {
        for (const ok of ["com.example.shop", "com.android.settings", "a.b", "org.my_app.v2", "", "  com.example.shop  "]) expect(phone.packageError(ok), ok).toBe("");
        for (const bad of ["shop", "com", "1.2.3", "com..shop", "com.example.", ".com.example", "com.exa mple", "com.example.shop; rm -rf", "com/example", `a.${"b".repeat(300)}`]) expect(phone.packageError(bad), bad).toContain("doesn’t look like an app package");
    });
});

describe("where it can run", () => {
    it("this server works only when the platform says an emulator is available, and says why not otherwise", () => {
        const on = phone.whereOptions(config({ available: true, avds: ["Pixel_6"], toolchain: "system" }), []);
        expect(on).toEqual([{ id: "platform", label: "This server", can: true, detail: "An Android emulator is ready here (Pixel_6)." }]);
        const off = phone.whereOptions(config({ available: false, reason: "No Android toolchain was found", avds: [], toolchain: "none" }), []);
        expect(off[0]).toMatchObject({ can: false, detail: "No Android toolchain was found." });
        expect(phone.whereOptions(undefined, [])[0]).toMatchObject({ can: false, detail: "No Android emulator is set up on this server." });
    });

    it("a runner is usable only when it is online, says it can explore phones, and has a phone or emulator", () => {
        const now = Date.now();
        const rows = phone.whereOptions(config({ available: false, avds: [], toolchain: "none" }), [
            agent({ id: "off", name: "Offline", online: false, lastSeenAt: new Date(now - 2 * 86_400_000).toISOString() }),
            agent({ id: "old", name: "Old", capabilities: { deviceSession: undefined } }),
            agent({ id: "none", name: "None", capabilities: { android: { adb: true, devices: [], avds: [], state: "none", summary: "Android: no devices connected" } } }),
            agent({ id: "notools", name: "No tools", capabilities: { android: { adb: false, devices: [], avds: [], state: "no-tools" } } }),
            agent({ id: "ok", name: "Fine" }),
        ], now);
        const by = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect(by["ok"]).toMatchObject({ can: true, detail: "Android: 1 emulator ready." });
        expect(by["off"]).toMatchObject({ can: false, detail: "Offline, last seen 2 days ago." });
        expect(by["old"]).toMatchObject({ can: false, detail: "This runner is out of date and cannot explore phone apps. Update it from Settings, Runners." });
        expect(by["none"]).toMatchObject({ can: false, detail: "Android: no devices connected." });
        expect(by["notools"]).toMatchObject({ can: false, detail: "No phone or emulator is connected to this runner." });
        // Online ones come before offline ones.
        expect(rows.map((r) => r.id).slice(0, 2)).toEqual(["platform", "old"]);
    });

    it("starts where the project already runs when that works, else at the first that works, else nowhere", () => {
        const opts = phone.whereOptions(config({ available: true, avds: [], toolchain: "system" }), [agent({ id: "ok" })]);
        expect(phone.defaultWhere(opts, { runOn: "platform", agentId: null })).toBe("platform");
        expect(phone.defaultWhere(opts, { runOn: "agent", agentId: "ok" })).toBe("ok");
        expect(phone.defaultWhere(opts, { runOn: "agent", agentId: "gone" })).toBe("platform");
        expect(phone.defaultWhere(opts, undefined)).toBe("platform");
        const none = phone.whereOptions(config({ available: false, avds: [], toolchain: "none" }), []);
        expect(phone.defaultWhere(none, { runOn: "platform", agentId: null })).toBe("");
        const onlyRunner = phone.whereOptions(config({ available: false, avds: [], toolchain: "none" }), [agent({ id: "ok" })]);
        expect(phone.defaultWhere(onlyRunner, { runOn: "platform", agentId: null })).toBe("ok");
    });
});

describe("what is sent to start", () => {
    it("always a plan, always the phone target; an account only when something was typed; nothing else", () => {
        expect(phone.startBody({ username: "", password: "" })).toEqual({ targets: ["mobile"], plan: true });
        expect(phone.startBody({ username: " me@example.com ", password: "" })).toEqual({ targets: ["mobile"], plan: true, credentials: { username: "me@example.com", password: undefined } });
        expect(phone.startBody({ username: "", password: "pw" })).toEqual({ targets: ["mobile"], plan: true, credentials: { username: undefined, password: "pw" } });
    });
});

describe("while it runs", () => {
    it("lists what was left alone, once each, in order, from the events the platform names for it or that say so", () => {
        const events = [ev(1, "Opened Home"), ev(2, "Skipped “Delete account” because it looks destructive", "mobile_action_skipped"), ev(3, "Found screen S2 “Sign in”", "mobile_screen_found"), ev(4, "Skipped “Delete account” because it looks destructive", "mobile_action_skipped"), ev(5, "Skipped “Pay now” because it looks like paying"), ev(6, "Went back", "skipped")];
        expect(phone.skippedOf(events)).toEqual(["Skipped “Delete account” because it looks destructive", "Skipped “Pay now” because it looks like paying", "Went back"]);
        expect(phone.skippedOf(undefined)).toEqual([]);
        expect(phone.skippedOf([])).toEqual([]);
    });

    it("counts screens from the platform's counter or from its \"Found screen\" events, and actions only when it says how many", () => {
        const found = [ev(1, "Opened com.example.shop on emulator-5554", "mobile_started"), ev(2, "Found screen S1 “Home”", "mobile_screen_found"), ev(3, "Found screen S2 “Sign in”", "mobile_screen_found"), ev(4, "Found screen S3 “Cart”", "mobile_screen_found")];
        const counters = (c: Partial<Job["counters"]>) => ({ counters: { pagesDiscovered: 0, apisDiscovered: 0, journeysIdentified: 0, scenariosPlanned: 0, testsGenerated: 0, testsValidated: 0, testsFailedValidation: 0, testsNeedingReview: 0, scenariosSkipped: 0, ...c } });
        // While it runs: screens from events, no number of actions (the platform does not count them live) and none is made up.
        expect(phone.phoneCounts(counters({}), found)).toEqual({ screens: 3, actions: null });
        expect(phone.phoneCounts(counters({ pagesDiscovered: 5 }), found)).toEqual({ screens: 5, actions: null });
        // The closing event says how many.
        const ended = [...found, ev(5, "Exploration ended: done. 3 screens, 31 actions.", "mobile_exploration_done")];
        expect(phone.phoneCounts(counters({}), ended)).toEqual({ screens: 3, actions: 31 });
        expect(phone.phoneCounts(counters({}), [ev(9, "Exploration ended: seen enough. 3 screens, 1 action.", "mobile_exploration_done")])).toEqual({ screens: 0, actions: 1 });
        // A platform that counts says so in its counters, and they win.
        expect(phone.phoneCounts(counters({ pagesDiscovered: 4, screensSeen: 7, actionsTaken: 20 }), found)).toEqual({ screens: 7, actions: 20 });
        expect(phone.phoneCounts(counters({}), undefined)).toEqual({ screens: 0, actions: null });
        expect(phone.countsLine({ screens: 1, actions: 1 })).toBe("1 screen seen, 1 action");
        expect(phone.countsLine({ screens: 9, actions: 31 })).toBe("9 screens seen, 31 actions");
        expect(phone.countsLine({ screens: 4, actions: null })).toBe("4 screens seen");
    });

    it("speaks of screens in the discovery step of a phone exploration, and leaves the other steps alone", () => {
        expect(phone.phonePhase("discovery", "running", 4)).toEqual({ title: "Exploring your phone app…", detail: "4 screens so far" });
        expect(phone.phonePhase("discovery", "running", 0)).toEqual({ title: "Exploring your phone app…", detail: undefined });
        expect(phone.phonePhase("discovery", "done", 9)).toEqual({ title: "Phone app explored", detail: "Found 9 screens" });
        expect(phone.phonePhase("planning", "running", 9)).toBeNull();
        expect(phone.phoneFinishedWords(9, false)).toBe("Exploration finished: 9 screens seen");
        expect(phone.phoneFinishedWords(4, true)).toBe("Exploration stopped: 4 screens seen");
    });

    it("the badge of a phone exploration says phone app, and any other keeps its words", () => {
        const base = { status: "DISCOVERING", error: null, mode: "generate" } as const;
        expect(jobLabel({ ...base, planOnly: true, targets: ["mobile"] }).label).toBe("Exploring your phone app");
        expect(jobLabel({ ...base, targets: ["mobile"] }).label).toBe("Exploring your phone app");
        expect(jobLabel({ ...base, planOnly: true, targets: ["web"] }).label).toBe("Exploring your application");
        expect(jobLabel({ ...base, planOnly: true }).label).toBe("Exploring your application");
        expect(jobLabel({ ...base, targets: ["web", "mobile"] }).label).toBe("Exploring your application");
        expect(KIND_LABEL.mobile).toBe("Phone");
    });
});

describe("the words keep the product's promises and vocabulary", () => {
    const all = [phone.PHONE_TITLE, phone.NEED_APP, phone.NEED_PACKAGE, phone.IPHONE_NOTE, phone.willDo("com.example.shop"), ...phone.WONT_DO, phone.ACCOUNT_REMINDER, phone.NO_WHERE_TITLE, phone.NO_WHERE_BODY, phone.AI_MISSING];
    it("says nothing is created before approval, that risky taps are never made and that passwords are hidden", () => {
        const text = phone.willDo("the app");
        expect(text).toMatch(/Nothing is created until you approve the plan/);
        expect(text).toMatch(/never taps buttons that look like paying, deleting or sending/);
        expect(text).toMatch(/passwords are hidden/);
        expect(phone.WONT_DO.join(" ")).toMatch(/Pay.*Delete.*Send.*make calls.*fingerprint.*captchas.*games/i);
    });
    it("uses no retired word, no exclamation mark and no emoji", () => {
        const RETIRED = /\bvalidat|\banaly[sz]|\bhand-?written\b|\brunbooks?\b|\bscenarios?\b|\bspecs?\b|\bagents?\b|\bmobile tests?\b|!|\p{Extended_Pictographic}/iu;
        for (const s of all) expect(RETIRED.test(s), s).toBe(false);
    });
});

// ── the plan ──────────────────────────────────────────────────────────────────

const idea = (id: string, family: string | undefined, over: Record<string, unknown> = {}) => ({ id, title: `Idea ${id}`, journey: null, priority: "medium" as const, type: "functional", ...(family ? { family } : {}), ...over });
const phonePlan = (over: Partial<ReadyPlan> = {}): ReadyPlan => ({
    ready: true,
    jobId: "j1",
    status: "COMPLETED",
    createdAt: "2026-10-17T10:00:00Z",
    url: "",
    targets: ["mobile"],
    found: { pages: 0, apiEndpoints: 0, forms: 2, journeys: 0, screens: 9 },
    about: null,
    pages: [],
    ideas: [idea("a", "sign-in"), idea("b", "sign-in"), idea("c", "navigation"), idea("d", "navigation"), idea("e", "navigation"), idea("f", "forms"), idea("g", "lists")],
    families: [
        { id: "sign-in", label: "Sign-in", about: "x", count: 2, on: true, option: "mobileSignIn", needs: "mobile" },
        { id: "navigation", label: "Navigation", about: "x", count: 3, on: true, option: "mobileNavigation", needs: "mobile" },
        { id: "forms", label: "Forms", about: "x", count: 1, on: true, option: "mobileForms", needs: "mobile" },
        { id: "lists", label: "Lists", about: "x", count: 1, on: true, option: "mobileLists", needs: "mobile" },
    ],
    total: 7,
    warnings: [],
    signInDetails: false,
    used: null,
    ...over,
});

describe("the plan of a phone app", () => {
    it("says what was found and what it will create, in phone words, with the exact counts per kind", () => {
        const plan = phonePlan();
        expect(phoneOnlyPlan(plan)).toBe(true);
        expect(foundSentence(plan.found, plan.targets)).toBe("We found 9 screens, with 2 forms.");
        const c = initialChoice(plan);
        expect(planLines(plan, c).map((l) => `${l.label} ${l.count}`)).toEqual(["Sign-in 2", "Navigation 3", "Forms 1", "Lists 1"]);
        expect(createSentence(planLines(plan, c), "phone test")).toBe("We will create about 7 phone tests: sign-in 2, navigation 3, forms 1 and lists 1.");
        expect(planTotal(plan, c)).toBe(7);
        expect(createSentence([], "phone test")).toBe("Nothing is selected to create yet.");
    });

    it("a kind is made of the ideas that name it, and leaving ideas out changes the sums", () => {
        const plan = phonePlan();
        const kind = (id: string) => plan.families.find((f) => f.id === id)!;
        expect(ideasOf(plan, kind("navigation")).map((i) => i.id)).toEqual(["c", "d", "e"]);
        const c: PlanChoice = { ...initialChoice(plan), left: ["d"] };
        expect(countOf(plan, kind("navigation"), c)).toBe(2);
        expect(planTotal(plan, c)).toBe(6);
        const all: PlanChoice = { ...initialChoice(plan), left: ["f"] };
        expect(isOn(plan, kind("forms"), all)).toBe(false);
        expect(planLines(plan, all).map((l) => l.id)).toEqual(["sign-in", "navigation", "lists"]);
    });

    it("confirms exactly what was shown: the phone target and the ideas left out, no switch of its own for a kind made of ideas", () => {
        const plan = phonePlan();
        expect(createBody(plan, initialChoice(plan))).toEqual({ targets: ["mobile"] });
        expect(createBody(plan, { ...initialChoice(plan), left: ["d", "g"] })).toEqual({ targets: ["mobile"], excludeIdeas: ["d", "g"] });
    });

    it("a kind with no ideas of its own keeps a switch, and counts as its number", () => {
        const plan = phonePlan({ ideas: [], families: [{ id: "smoke", label: "Smoke", about: "x", count: 2, on: true, option: "mobileSmoke", needs: "mobile" }] });
        const off: PlanChoice = { switches: { mobileSmoke: false }, left: [] };
        expect(planTotal(plan, initialChoice(plan))).toBe(2);
        expect(planTotal(plan, off)).toBe(0);
        expect(createBody(plan, off)).toEqual({ targets: ["mobile"], mobileSmoke: false });
    });

    it("a phone kind is not counted in a plan that did not explore the phone app", () => {
        const plan = phonePlan({ targets: ["web"], found: { pages: 3, apiEndpoints: 0, forms: 0, journeys: 0 }, ideas: [], families: phonePlan().families });
        expect(planLines(plan, initialChoice(plan))).toEqual([]);
        expect(phoneOnlyPlan(plan)).toBe(false);
    });
});

describe("the plan as the platform really sends it", () => {
    const answer = (): PlanAnswer => ({
        ready: true,
        jobId: "j9",
        status: "COMPLETED",
        createdAt: "2026-10-17T10:00:00Z",
        url: "android-app://com.example.shop",
        targets: ["mobile"],
        found: { pages: 0, apiEndpoints: 0, forms: 1, journeys: 0, screens: 3 },
        about: null,
        pages: [],
        ideas: [
            { id: "M-01", title: "Sign in with a test account", journey: "Signing in", priority: "critical", type: "functional" },
            { id: "M-02", title: "Open the cart", journey: "Moving between screens", priority: "medium", type: "functional" },
        ],
        phone: {
            appPackage: "com.example.shop",
            appName: "Shop",
            screens: [{ id: "S1", title: "Home" }, { id: "S2", title: "Sign in" }, { id: "S3", title: "Cart" }],
            ideas: [
                { id: "M-01", title: "Sign in with a test account", goal: "Reaches Home.", family: "signIn", priority: "critical", path: ["Home", "Sign in", "Home"] },
                { id: "M-02", title: "Open the cart", goal: "The cart opens.", family: "navigation", priority: "medium", path: ["Home", "Cart"] },
                { id: "M-03", title: "Go back", goal: "Back shows Home.", family: "back", priority: "low", path: ["Home", "Cart", "Home"] },
            ],
            couldNotWrite: [{ title: "Pay", reason: "No payment screen" }],
            skipped: [{ message: "Skipped “Pay now” because it looks like paying", why: "payment" }],
            signInNeeded: true,
            signedIn: false,
        },
        families: [
            { id: "phoneSignIn", label: "Signing in", about: "x", count: 1, on: true, option: "mobile", needs: "mobile" },
            { id: "phoneNavigation", label: "Moving between screens", about: "x", count: 1, on: true, option: "mobile", needs: "mobile" },
            { id: "phoneBack", label: "Going back", about: "x", count: 1, on: true, option: "mobile", needs: "mobile" },
        ],
        total: 3,
        warnings: [],
        signInDetails: false,
        used: null,
    });
    it("joins the phone part and the kinds of test, so that each kind is made of the ideas that name it", () => {
        const plan = normalizePlan(answer()) as ReadyPlan;
        expect(plan.ideas.map((i) => [i.id, i.family, i.goal])).toEqual([["M-01", "phoneSignIn", "Reaches Home."], ["M-02", "phoneNavigation", "The cart opens."], ["M-03", "phoneBack", "Back shows Home."]]);
        // An idea only the phone part lists is added, so it can be left out like the others.
        expect(plan.ideas.find((i) => i.id === "M-03")).toMatchObject({ title: "Go back", path: ["Home", "Cart", "Home"], priority: "low" });
        expect(plan.screens).toEqual([{ name: "Home" }, { name: "Sign in" }, { name: "Cart" }]);
        expect(plan.app).toBe("Shop");
        expect(plan.signInNeeded).toBe(true);
        expect(plan.couldNotWrite).toEqual([{ title: "Pay", reason: "No payment screen" }]);
        expect(plan.skipped).toEqual(["Skipped “Pay now” because it looks like paying"]);
        const c = initialChoice(plan);
        expect(planLines(plan, c).map((l) => `${l.label} ${l.count}`)).toEqual(["Signing in 1", "Moving between screens 1", "Going back 1"]);
        // Leaving an idea out is how a kind is changed: no switch is sent for the shared "mobile" option.
        expect(createBody(plan, { ...c, left: ["M-02"] })).toEqual({ targets: ["mobile"], excludeIdeas: ["M-02"] });
        expect(planTotal(plan, { ...c, left: ["M-02"] })).toBe(2);
    });
    it("a sign-in that was done is not asked for again, a plan without a phone part is left alone", () => {
        const a = answer();
        if (a.ready) a.phone = { ...a.phone!, signedIn: true };
        expect((normalizePlan(a) as ReadyPlan).signInNeeded).toBe(false);
        const web = { ready: true, targets: ["web"], ideas: [], families: [], found: { pages: 1, apiEndpoints: 0, forms: 0, journeys: 0 } } as unknown as PlanAnswer;
        expect(normalizePlan(web)).toBe(web);
        const waiting: PlanAnswer = { ready: false, jobId: "x", status: "PLANNING" };
        expect(normalizePlan(waiting)).toBe(waiting);
    });
});

describe("a plan for a website or an API adds up exactly as before", () => {
    const web: ReadyPlan = {
        ready: true,
        jobId: "w1",
        status: "COMPLETED",
        createdAt: "2026-10-17T10:00:00Z",
        url: "https://example.com",
        targets: ["web", "api"],
        found: { pages: 4, apiEndpoints: 4, forms: 1, journeys: 2 },
        about: null,
        pages: [],
        ideas: [idea("j1", undefined, { journey: "Browse" }), idea("j2", undefined, { journey: "Buy" })],
        families: [
            { id: "journeys", label: "Journeys through the app", about: "x", count: 2, on: true, option: "web", needs: "web" },
            { id: "api", label: "API checks", about: "x", count: 6, on: true, option: "api", needs: "api" },
            { id: "security", label: "Security", about: "x", count: 7, on: true, option: "securityChecks", needs: "both", split: { web: 3, api: 4 } },
        ],
        total: 15,
        warnings: [],
        signInDetails: false,
        used: null,
    };
    it("keeps the sentences, the sums and the confirmation body", () => {
        expect(foundSentence(web.found, web.targets)).toBe("We found 4 pages and 4 API endpoints, with 1 form.");
        const c = initialChoice(web);
        expect(createSentence(planLines(web, c))).toBe("We will create about 15 tests: journeys through the app 2, API checks 6 and security 7.");
        expect(createBody(web, c)).toEqual({ targets: ["web", "api"], securityChecks: true });
        const out: PlanChoice = { switches: { ...c.switches, api: false }, left: ["j2"] };
        expect(planTotal(web, out)).toBe(1 + 3);
        expect(createBody(web, out)).toEqual({ targets: ["web"], securityChecks: true, excludeIdeas: ["j2"] });
        expect(phoneOnlyPlan(web)).toBe(false);
    });
    it("a plan that is not ready is still only a status", () => {
        const waiting: PlanAnswer = { ready: false, jobId: "x", status: "PLANNING" };
        expect(waiting.ready).toBe(false);
    });
});

// ── where a test came from ────────────────────────────────────────────────────

describe("the origin line of a test the AI made on a phone", () => {
    const base = (over: Partial<OriginInput> = {}): OriginInput => ({
        testId: "MOB-001",
        type: "functional",
        priority: "high",
        validationStatus: "VALIDATED",
        attempts: 1,
        spec: { source: { origin: "exploration" } },
        generationMeta: { model: "scripted-model", screenPath: ["Home", "Sign in", "Home"] },
        scripts: [{ createdAt: "2026-10-14T09:00:00Z" }],
        ...over,
    });
    it("says it was made by exploring the Android app, when, and the screens it went through, in that order", () => {
        const o = originOf(base());
        expect(o.parts[0]).toBe("Created by exploring the Android app");
        expect(o.parts[1]).toMatch(/2026/);
        expect(o.parts[2]).toBe("path: Home → Sign in → Home");
        expect(o.parts[3]).toBe("model scripted-model");
        expect(o.parts).toHaveLength(4);
    });
    it("reads the path from the idea when that is where the platform keeps it, and says nothing it was not given", () => {
        expect(originOf(base({ generationMeta: { scenario: { screenPath: ["Home", "Cart"] } } })).parts).toContain("path: Home → Cart");
        const bare = originOf(base({ generationMeta: {}, scripts: [] }));
        expect(bare.parts).toEqual(["Created by exploring the Android app"]);
    });
    it("reads the path where the platform really keeps it: with the test's phone facts, or in the journey it was filed under", () => {
        expect(originOf(base({ generationMeta: { phone: { appPackage: "com.example.shop", ideaId: "M-02", family: "signIn", path: ["Shop", "Sign in", "Shop"] } } })).parts).toContain("path: Shop → Sign in → Shop");
        expect(originOf(base({ spec: { source: { origin: "exploration", journey: "Shop → Products → Product 1" } }, generationMeta: {} })).parts).toContain("path: Shop → Products → Product 1");
        // The line the web exploration builds from the same field is unchanged.
        expect(originOf(base({ spec: { source: { origin: "browser-agent", journey: "Buy" } }, generationMeta: {} })).parts).toContain("journey “Buy”");
    });
    it("a code test or a browser exploration keeps its own line", () => {
        expect(originOf(base({ spec: { source: { origin: "browser-agent", journey: "Buy" } }, generationMeta: { scenario: { startPath: "/shop" } } })).parts.slice(0, 3)).toEqual(["Created by exploration", "journey “Buy”", "starting at /shop"]);
        expect(originOf(base({ custom: { origin: "written", since: "2026-10-01T00:00:00Z" } })).parts[0]).toBe("Written as code");
    });
});
