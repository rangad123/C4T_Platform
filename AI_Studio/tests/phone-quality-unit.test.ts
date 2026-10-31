/**
 * Phone quality checks, the parts that need no phone and no platform: reading crashes and freezes from logcat text, secrets scrubbed, the start-up
 * measurement, the accessibility rules, the findings contract (prefixes, severity, markers), the closed adb list, the check tests a plan makes, the plan
 * families, and the explorer hooks on an in-memory phone with a scripted model. Browser-free and fast (the fast tier).
 * The real thing (the fake adb, the platform, the runner) is in tests/phone-quality.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import { allowedCommand } from "../src/engine/mobile/device/adb.js";
import type { DeviceAction, DeviceSession, ScreenElement } from "../src/engine/mobile/device/types.js";
import { explore, ModelBudget } from "../src/engine/mobile/explore/explorer.js";
import { DEFAULT_LIMITS, type MobileAppModel } from "../src/engine/mobile/explore/types.js";
import { checkScreenA11y, NOT_CHECKED } from "../src/engine/mobile/quality/a11y.js";
import { qualityWarnings } from "../src/engine/mobile/quality/create.js";
import { ON_RUNNER, QualityCollector, qualityTests } from "../src/engine/mobile/quality/explore.js";
import { a11yReason, crashReason, phoneCheckMarker, phoneChecksOf, phoneQualityFinding, phoneQualitySeverity, PHONE_ANR_PREFIX, PHONE_CRASH_PREFIX, qualityCounts, slowStartReason, TAG_A11Y, TAG_STARTUP, budgetTag } from "../src/engine/mobile/quality/findings.js";
import { crashesIn, markOf, scrubLine } from "../src/engine/mobile/quality/logcat.js";
import { clampBudget, DEFAULT_STARTUP_BUDGET_MS, isComponent, launcherFromResolve, parseStartOutput } from "../src/engine/mobile/quality/startup.js";
import type { AppCrash, PhoneQualityPlan } from "../src/engine/mobile/quality/types.js";
import { taqwrightGenerator } from "../src/engine/generators/taqwright.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { planFamilies, planTotal } from "../src/engine/planning/preview.js";
import { assessSeverity } from "../src/engine/validation/severity.js";
import { categorize } from "../src/cli/model.js";
import { MemoryDevice, shopApp, SHOP } from "./fixtures/memory-device.js";
import { scriptedPhoneModel } from "./fixtures/phone-model.js";

const PKG = "com.example.shop";
const L = (t: string, pid: number, level: string, tag: string, msg: string) => `${t}  ${pid}  ${pid} ${level} ${tag}: ${msg}`;

const LOG = [
    "--------- beginning of crash",
    L("1697040000.100", 4321, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
    L("1697040000.100", 4321, "E", "AndroidRuntime", "Process: com.other.app, PID: 4321"),
    L("1697040000.100", 4321, "E", "AndroidRuntime", "java.lang.RuntimeException: not ours"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "FATAL EXCEPTION: main"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "Process: com.example.shop, PID: 5000"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "java.lang.IllegalStateException: Cart is null for tester@example.test password=Hunter22"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "\tat com.example.shop.CartActivity.onCreate(CartActivity.java:42)"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "\tat android.app.Activity.performCreate(Activity.java:8000)"),
    L("1697040001.200", 5000, "E", "AndroidRuntime", "Caused by: java.lang.NullPointerException: token Bearer abcdefghijklmnop1234"),
    "--------- beginning of system",
    L("1697040002.300", 1500, "E", "ActivityManager", "ANR in com.example.shop:sync (com.example.shop/.SyncService)"),
    L("1697040002.300", 1500, "E", "ActivityManager", "PID: 5001"),
    L("1697040002.300", 1500, "E", "ActivityManager", "Reason: executing service com.example.shop/.SyncService"),
    L("1697040003.400", 6000, "F", "libc", "Fatal signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0 in tid 6000 (RenderThread), pid 6000 (com.example.shop)"),
    L("1697040003.450", 6100, "F", "DEBUG", "    #00 pc 0000000000012345  /data/app/lib/libshop.so (draw+12)"),
    L("1697040004.000", 1500, "E", "ActivityManager", "ANR in com.example.shopper (com.example.shopper/.Main)"),
].join("\n");

describe("crashes and freezes from the phone's log", () => {
    it("keeps only the app under test (its processes too), with exception, stack and kind", () => {
        const found = crashesIn(LOG, PKG, { secrets: ["Hunter22"] });
        expect(found.map((c) => c.kind)).toEqual(["crash", "anr", "native"]);
        const [crash, anr, native] = found as [AppCrash, AppCrash, AppCrash];
        expect(crash.package).toBe(PKG);
        expect(crash.exception).toMatch(/^java\.lang\.IllegalStateException: Cart is null/);
        expect(crash.stack[0]).toBe("at com.example.shop.CartActivity.onCreate(CartActivity.java:42)");
        expect(crash.stack.some((l) => l.startsWith("Caused by:"))).toBe(true);
        expect(anr.package).toBe(`${PKG}:sync`);
        expect(anr.exception).toBe("executing service com.example.shop/.SyncService");
        expect(native.exception).toMatch(/^Fatal signal 11 \(SIGSEGV\)/);
        expect(native.stack[0]).toMatch(/^#00 pc/);
        // "com.example.shopper" is another app, not a process of com.example.shop
        expect(found.some((c) => c.package === "com.example.shopper")).toBe(false);
    });

    it("scrubs secrets, e-mail addresses, tokens and control characters from what it keeps", () => {
        const all = JSON.stringify(crashesIn(LOG, PKG, { secrets: ["Hunter22"] }));
        expect(all).not.toContain("Hunter22");
        expect(all).not.toContain("tester@example.test");
        expect(all).not.toContain("abcdefghijklmnop1234");
        expect(scrubLine("api_key=sk_live_123 \u001b[31mred‮")).toBe("api_key=[hidden] [31mred");
        expect(scrubLine("x".repeat(500)).length).toBe(200);
    });

    it("reads only what came after the mark, also from the same millisecond", () => {
        expect(markOf(LOG)).toBe("1697040004.000");
        expect(crashesIn(LOG, PKG, { after: 1697040001.2 }).map((c) => c.kind)).toEqual(["anr", "native"]);
        const seen = new Set<string>();
        expect(crashesIn(LOG, PKG, { after: 1697040001.2, seenAtMark: seen }).length).toBe(3);
        expect(crashesIn("garbage\nnot a log", PKG)).toEqual([]);
        expect(markOf("")).toBeUndefined();
    });
});

describe("start-up time", () => {
    it("parses am start -W and the launcher activity; refuses anything that is not a plain component", () => {
        expect(parseStartOutput("Starting: Intent { }\nStatus: ok\nLaunchState: COLD\nActivity: a.b/.C\nTotalTime: 1234\nWaitTime: 1300\nComplete\n")).toEqual({ totalMs: 1234, waitMs: 1300, launchState: "COLD" });
        expect(parseStartOutput("Error: Activity not started, unable to resolve Intent")).toBeUndefined();
        expect(parseStartOutput("Status: ok\nComplete")).toBeUndefined();
        expect(launcherFromResolve("priority=0 preferredOrder=0\ncom.example.shop/.MainActivity\n", PKG)).toBe("com.example.shop/.MainActivity");
        expect(launcherFromResolve("No activity found", PKG)).toBeUndefined();
        expect(launcherFromResolve("com.evil.app/.Main", PKG)).toBeUndefined();
        expect(isComponent("com.example.shop/com.example.shop.ui.MainActivity")).toBe(true);
        for (const bad of ["com.x/.Y;reboot", "com.x/.Y -a", "-n", "com.x/.Y $(id)", "com.x"]) expect(isComponent(bad), bad).toBe(false);
        expect(clampBudget(undefined)).toBe(DEFAULT_STARTUP_BUDGET_MS);
        expect(clampBudget(10)).toBe(500);
        expect(clampBudget(10_000_000)).toBe(60_000);
    });

    it("the closed adb list allows exactly the new read-only forms and nothing around them", () => {
        const ok = [
            ["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t", "1"],
            ["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t", "1697040001.200"],
            ["shell", "date", "+%s"],
            ["shell", "getprop", "ro.sf.lcd_density"],
            ["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", "com.example.shop"],
            ["shell", "am", "start", "-S", "-W", "-n", "com.example.shop/.MainActivity"],
        ];
        const bad = [
            ["logcat"], ["logcat", "-c"], ["logcat", "-d", "-b", "all", "-b", "system", "-v", "epoch", "-t", "1"], ["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t", "1;reboot"],
            ["logcat", "-d", "-b", "crash", "-b", "system", "-v", "epoch", "-t", "1", "-f", "/sdcard/x"], ["shell", "date", "-s", "2020"], ["shell", "cmd", "package", "uninstall", "com.x.y"],
            ["shell", "am", "start", "-n", "com.x/.Y"], ["shell", "am", "start", "-S", "-W", "-n", "com.x/.Y;reboot"], ["shell", "am", "start", "-S", "-W", "-a", "android.intent.action.VIEW"],
            ["shell", "cmd", "package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", "bad pkg"],
        ];
        for (const a of ok) expect(allowedCommand(a), a.join(" ")).toBe(true);
        for (const a of bad) expect(allowedCommand(a), a.join(" ")).toBe(false);
    });
});

const el = (index: number, o: Partial<ScreenElement> = {}): ScreenElement => ({ index, cls: "Button", text: "", desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, 100, 160, 200], ...o });

describe("accessibility of a phone screen", () => {
    const screen = {
        width: 360,
        height: 640,
        elements: [
            el(0, { cls: "TextView", clickable: false, text: "Settings", bounds: [16, 20, 344, 60] }),
            el(1, { cls: "ImageButton", id: "gear", bounds: [16, 80, 64, 128] }),
            el(2, { text: "x", bounds: [300, 80, 324, 104] }),
            el(3, { cls: "LinearLayout", bounds: [16, 140, 344, 200] }),
            el(4, { text: "Open", bounds: [16, 220, 344, 268] }),
            el(5, { text: "Open", bounds: [16, 280, 344, 328] }),
            // a row whose label is the text inside it, with a small icon inside the row: neither is a problem
            el(6, { cls: "LinearLayout", bounds: [16, 340, 344, 400] }),
            el(7, { cls: "TextView", clickable: false, text: "Notifications", bounds: [32, 350, 200, 390] }),
            el(8, { cls: "ImageView", desc: "More", bounds: [300, 356, 328, 384] }),
            el(9, { cls: "EditText", editable: true, password: true, bounds: [16, 420, 344, 468] }),
            // cut by the bottom of the screen: its real size is unknown
            el(10, { text: "Footer", bounds: [16, 620, 344, 640] }),
        ],
    };

    it("finds unlabelled things, image buttons without a description, small targets and duplicate labels", () => {
        const r = checkScreenA11y(screen, { screen: "S1", title: "Settings", densityDpi: 160 });
        expect(r.issues.map((i) => i.rule).sort()).toEqual(["duplicate-label", "image-no-description", "no-label", "small-target"]);
        const msg = r.issues.map((i) => i.message).join("\n");
        expect(msg).toContain("The image button with id “gear” has no content description");
        expect(msg).toContain("The button “x” is 24 × 24 dp; touch targets should be at least 48 × 48 dp");
        expect(msg).toContain("An unlabelled item at the top has no label a screen reader can say");
        expect(msg).toContain("2 buttons are all called “Open”");
        expect(r.densityAssumed).toBeUndefined();
        expect(r.checked).toBe(11);
    });

    it("sizes follow the density: at 2× the 24 px button is 12 dp; without a density they are estimated and the finding says so", () => {
        const big = checkScreenA11y(screen, { screen: "S1", title: "Settings", densityDpi: 320 });
        expect(big.issues.find((i) => i.rule === "small-target" && i.message.includes("“x”"))!.message).toContain("12 × 12 dp");
        const est = checkScreenA11y(screen, { screen: "S1", title: "Settings" });
        expect(est.densityAssumed).toBe(true);
        expect(a11yReason(est)).toContain("Sizes in dp are estimated");
        expect(NOT_CHECKED).toMatch(/Text size and colour contrast are not checked/);
    });

    it("a clean screen has no issues", () => {
        expect(checkScreenA11y({ width: 360, height: 640, elements: [el(0, { text: "Sign in", bounds: [16, 100, 344, 148] })] }, { screen: "S1", title: "Home", densityDpi: 160 }).issues).toEqual([]);
    });
});

describe("findings contract", () => {
    const crash: AppCrash = { kind: "crash", package: PKG, exception: "java.lang.IllegalStateException: boom", stack: ["at a.b.C.d(C.java:1)"], at: 1 };
    const mobile = { kind: "mobile" as const };

    it("a failed phone run with a quality prefix is a finding; anything else is not", () => {
        const text = crashReason(crash, { steps: ["Opened Shop", "Tapped “Cart”"] });
        expect(text.startsWith(`${PHONE_CRASH_PREFIX}java.lang.IllegalStateException: boom`)).toBe(true);
        expect(text).toContain("Steps that led to it:\n1. Opened Shop\n2. Tapped “Cart”");
        expect(phoneQualityFinding(mobile, { status: "failed", error: text })).toBe(text);
        expect(phoneQualityFinding({ kind: "web" }, { status: "failed", error: text })).toBeUndefined();
        expect(phoneQualityFinding(mobile, { status: "passed", error: text })).toBeUndefined();
        expect(phoneQualityFinding(mobile, { status: "failed", error: "Element not found" })).toBeUndefined();
        expect(crashReason({ ...crash, kind: "anr" }).startsWith(PHONE_ANR_PREFIX)).toBe(true);
    });

    it("severity: crash and freeze high, slow start medium, accessibility as its worst problem; the CLI files them", () => {
        const spec = TestSpecSchema.parse({ testId: "MOB-001", title: "Check", kind: "mobile", platform: "android", category: "c", type: "functional", priority: "low", steps: [{ action: "wait", ms: 1 }], source: { scenarioId: "Q-01", origin: "exploration" } });
        expect(assessSeverity(spec, "NEEDS_REVIEW", crashReason(crash))).toMatchObject({ severity: "high" });
        const slow = slowStartReason({ totalMs: 7400 }, 5000);
        expect(slow).toMatch(/^Slow start-up: the app took 7\.4 s to show its first screen from a cold start; the budget is 5 s\./);
        expect(assessSeverity(spec, "NEEDS_REVIEW", slow)).toMatchObject({ severity: "medium" });
        const a11y = a11yReason({ screen: "S1", title: "Home", checked: 3, issues: [{ rule: "small-target", severity: "low", message: "x" }] });
        expect(phoneQualitySeverity(a11y)).toMatchObject({ severity: "low" });
        expect(phoneQualitySeverity(a11y.replace("[low]", "[medium]"))).toMatchObject({ severity: "medium" });
        expect(categorize(crashReason(crash))).toBe("app-crash");
        expect(categorize(slow)).toBe("performance");
        expect(categorize(a11y)).toBe("accessibility");
    });

    it("only check tests carry a marker line: every other phone script renders exactly as before", () => {
        const base = TestSpecSchema.parse({ testId: "MOB-001", title: "Open the cart", kind: "mobile", platform: "android", category: "c", steps: [{ action: "wait", ms: 1 }], tags: ["phone"], source: { scenarioId: "M-01", origin: "exploration" } });
        const plain = taqwrightGenerator.render(base, { baseUrl: "android-app://x" }).content;
        expect(plain).not.toContain("phone-check");
        expect(phoneCheckMarker(base)).toBe("");
        const startup = taqwrightGenerator.render({ ...base, tags: ["phone", TAG_STARTUP, budgetTag(3000)] }, { baseUrl: "android-app://x" }).content;
        expect(startup.replace("\n// phone-check: start-up budget=3000", "")).toBe(plain);
        expect(phoneChecksOf(startup)).toEqual({ accessibility: false, startup: { budgetMs: 3000 } });
        const a11y = taqwrightGenerator.render({ ...base, tags: ["phone", TAG_A11Y] }, { baseUrl: "android-app://x" }).content;
        expect(phoneChecksOf(a11y)).toEqual({ accessibility: true });
        expect(phoneChecksOf(plain)).toEqual({ accessibility: false });
    });
});

// ── the explorer hooks on an in-memory phone ────────────────────────────────

function context(llm: ReturnType<typeof scriptedPhoneModel>): { ctx: EngineContext; events: EngineEvent[] } {
    const events: EngineEvent[] = [];
    return { events, ctx: { config: {} as never, llm, emit: (e) => events.push(e) } };
}

/** The in-memory shop with a phone log: tapping "Cart" crashes the app once (the next look shows the launcher until it is restarted). */
function crashingShop(o: { startMs?: number; noHealth?: boolean } = {}) {
    const device = new MemoryDevice(shopApp({ permission: false }));
    let pending: AppCrash[] = [];
    const acts: DeviceAction[] = [];
    let lastSnap = undefined as Awaited<ReturnType<DeviceSession["snapshot"]>> | undefined;
    const session: DeviceSession = {
        kind: "local",
        deviceName: "memory",
        snapshot: async (x) => (lastSnap = await device.snapshot(x)),
        act: async (a, x) => {
            acts.push(a);
            const tapped = a.kind === "tap" ? lastSnap?.elements.find((e) => e.index === a.index) : undefined;
            const r = await device.act(a, x);
            if (r.snapshot) lastSnap = r.snapshot;
            if (tapped && /^Cart/.test(tapped.desc || tapped.text) && !acts.some((p) => p.kind === "restart")) pending = [{ kind: "crash", package: SHOP, exception: "java.lang.IllegalStateException: Cart is null", stack: ["at com.example.shop.CartActivity.onCreate(CartActivity.java:42)"], at: 2 }];
            return r;
        },
        close: async () => device.close(),
        ...(o.noHealth
            ? {}
            : {
                  health: {
                      crashes: async () => {
                          const c = pending;
                          pending = [];
                          return c;
                      },
                      coldStart: async () => ({ measure: { totalMs: o.startMs ?? 800, launchState: "COLD" } }),
                      densityDpi: async () => 160,
                  },
              }),
    };
    return { session, acts };
}

async function exploreWith(o: { startMs?: number; noHealth?: boolean; budgetMs?: number }) {
    const { session, acts } = crashingShop(o);
    const llm = scriptedPhoneModel([{ tap: "Products" }, { back: true }, { tap: "Cart" }, { tap: "Products" }, { finish: true }]);
    const { ctx, events } = context(llm);
    const q = new QualityCollector({ ctx, session, ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}) });
    const model = await explore({ ctx, session, appPackage: SHOP, credentialsGiven: false, allowDataChanges: false, quality: q.hooks() }, new ModelBudget(DEFAULT_LIMITS.maxModelCalls));
    return { model, q, events, acts, plan: q.plan(model, { appPackage: SHOP }) };
}

describe("the explorer with quality hooks", () => {
    it("records a crash with the screen before it and the steps, restarts the app and goes on", async () => {
        const { model, plan, events, acts } = await exploreWith({});
        expect(plan.crashes).toHaveLength(1);
        const c = plan.crashes[0]!;
        expect(c.crash.exception).toBe("java.lang.IllegalStateException: Cart is null");
        expect(c.screen.title).toBe("Shop");
        expect(c.steps[c.steps.length - 1]).toMatch(/^Tapped “Cart/);
        expect(acts.some((a) => a.kind === "restart")).toBe(true);
        // it went on after the restart: Products was opened again
        expect(model.stats.actions).toBeGreaterThanOrEqual(4);
        expect(events.some((e) => e.kind === "mobile_app_crashed" && /The app crashed: java\.lang\.IllegalStateException/.test(e.message) && e.level === "warn")).toBe(true);
        expect(events.some((e) => e.kind === "mobile_startup_time" && /800 ms/.test(e.message))).toBe(true);
        // every new screen was checked for accessibility
        expect(plan.accessibility.map((s) => s.screen)).toEqual(model.screens.map((s) => s.id));
        // the crash becomes a check test that repeats the tap, then waits
        const t = plan.tests!.find((x) => x.kind === "crash")!;
        expect(t.title).toBe("The app does not crash on “Shop”");
        expect(t.reason.startsWith("The app crashed: java.lang.IllegalStateException: Cart is null")).toBe(true);
        expect(t.reason).toContain("Seen while the AI explored the app");
        const steps = (t.draft as { steps: Array<{ action: string }> }).steps;
        expect(steps.map((s) => s.action)).toEqual(["click", "wait"]);
        expect((t.draft as { tags: string[] }).tags).toContain("phone-crash");
        expect(qualityWarnings(plan)[0]).toMatch(/The app crashed once while the AI explored it/);
    });

    it("a slow cold start becomes a start-up check with the numbers; a fast one is only reported", async () => {
        const slow = await exploreWith({ startMs: 7400, budgetMs: 3000 });
        expect(slow.plan.startup).toMatchObject({ budgetMs: 3000, overBudget: true, measure: { totalMs: 7400 } });
        const t = slow.plan.tests!.find((x) => x.kind === "startup")!;
        expect(t.title).toBe("The app opens within 3 s");
        expect((t.draft as { tags: string[] }).tags).toEqual(expect.arrayContaining([TAG_STARTUP, "startup-budget:3000"]));
        expect(t.reason).toMatch(/^Slow start-up: the app took 7\.4 s/);
        const fast = await exploreWith({});
        expect(fast.plan.tests!.some((x) => x.kind === "startup")).toBe(false);
    });

    it("a phone on a runner (no health): nothing is made up, and the plan says what was not checked", async () => {
        const { plan } = await exploreWith({ noHealth: true });
        expect(plan.crashes).toEqual([]);
        expect(plan.startup).toBeUndefined();
        expect(plan.notes).toContain(ON_RUNNER);
        expect(plan.accessibility.length).toBeGreaterThan(0);
    });
});

describe("check tests and plan families", () => {
    const model: MobileAppModel = {
        appPackage: PKG,
        start: "S1",
        screens: [
            { id: "S1", title: "Shop", package: PKG, kind: "start", elements: [], visits: 1, hasForm: false, scrollable: false },
            { id: "S2", title: "Hidden", package: PKG, kind: "other", elements: [], visits: 1, hasForm: false, scrollable: false },
        ],
        edges: [],
        submits: [],
        signInNeeded: false,
        signedIn: false,
        skipped: [],
        stats: { actions: 1, modelCalls: 1, durationMs: 1, stoppedBecause: "done" },
    };
    const issue = { rule: "no-label" as const, severity: "medium" as const, message: "x" };
    const q: PhoneQualityPlan = {
        crashes: [{ crash: { kind: "anr", package: PKG, exception: "Input dispatching timed out", stack: [], at: 1 }, screen: { id: "S2", title: "Hidden", texts: [] }, steps: ["Tapped “Hidden”"], repro: { screen: "S2", prelude: [] } }],
        accessibility: [
            { screen: "S1", title: "Shop", checked: 3, issues: [issue] },
            { screen: "S2", title: "Hidden", checked: 3, issues: [issue] },
        ],
        notes: [],
    };

    it("a finding whose screen cannot be reached again is listed with its reason, never dropped silently", () => {
        const { tests, couldNotWrite } = qualityTests(model, q, { appPackage: PKG });
        expect(tests.map((t) => [t.id, t.kind, t.title])).toEqual([["Q-01", "accessibility", "Accessibility of “Shop”"]]);
        expect(couldNotWrite.map((c) => c.title)).toEqual(["The app does not stop responding on “Hidden”", "Accessibility of “Hidden”"]);
        expect(couldNotWrite[0]!.reason).toMatch(/could not be reached again/);
    });

    it("families have exact counts; phone accessibility is listed only when Accessibility is switched on", () => {
        const plan = { ...qualityTests(model, q, { appPackage: PKG }), ...q };
        const stored = { version: 1, createdAt: "", model: { mobile: model } as never, scenarios: [], analysed: true, specBaseTrusted: false, accessReach: [], apiAccess: [], warnings: [], mobile: { appPackage: PKG, appName: "Shop", ideas: [], dropped: [], quality: plan } } as never;
        const off = planFamilies(stored, { targets: ["mobile"] } as never);
        expect(off.map((f) => f.id)).toEqual([]);
        const on = planFamilies(stored, { targets: ["mobile"], accessibility: true } as never);
        expect(on.map((f) => [f.id, f.count, f.on])).toEqual([["phoneAccessibility", 1, true]]);
        expect(planTotal(on, ["mobile"])).toBe(1);
        expect(qualityCounts(plan, { accessibility: false })).toEqual({ crash: 0, startup: 0, accessibility: 0 });
    });
});
