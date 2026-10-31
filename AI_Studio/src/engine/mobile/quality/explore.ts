/**
 * The phone quality checks during an AI exploration, and the check tests a plan makes of what they found.
 *
 * The explorer (explore/explorer.ts) only calls three hooks; everything else is here:
 *  - at the start: the app's cold start is measured (budget per project, default 5 s), the screen density is read, and a crash on start is noted;
 *  - every screen seen for the first time: its accessibility is checked from the description the explorer already has (no extra phone call);
 *  - after every action: the phone's crash log is read; a crash or freeze is recorded with the screen before it and the steps that led to it,
 *    and the explorer restarts the app and goes on.
 *
 * The plan turns findings into check tests that repeat what happened (crash), open the screen (accessibility) or start the app (start-up), each
 * stored as Needs a look with the facts, and checked again on the phone whenever it runs (see run-checks.ts). Nothing here is invented: a finding
 * exists only when the phone reported it.
 */
import type { EngineContext } from "../../context.js";
import { secretProblems } from "../../builder/index.js";
import { renderWithAdapter } from "../../frameworks/index.js";
import { TestSpecSchema, type Step } from "../../spec/schema.js";
import type { DeviceSession, ScreenSnapshot } from "../device/types.js";
import { shortestPaths, stepsOf } from "../explore/candidates.js";
import { cleanAppText } from "../explore/text.js";
import { appNameOf, DRAFT_ID, MAX_TEST_STEPS } from "../explore/spec-builder.js";
import { DEFAULT_LIMITS, type MobileAppModel, type RecordedAction } from "../explore/types.js";
import { checkScreenA11y, NOT_CHECKED } from "./a11y.js";
import { a11yReason, budgetTag, crashHeadline, exploreCrashReason, slowStartReason, TAG_A11Y, TAG_CRASH, TAG_STARTUP } from "./findings.js";
import { clampBudget, formatMs } from "./startup.js";
import type { ExploreCrash, PhoneQualityPlan, QualityTest, QualityTestKind, ScreenA11y } from "./types.js";

/** Most distinct crashes kept from one exploration (an app that crashes on every screen says enough after five). */
export const MAX_EXPLORE_CRASHES = 5;
export const ON_RUNNER = "Crashes, freezes and the start-up time are checked during exploration only when the phone is connected to the computer that runs the platform. This phone is on a runner, so they were not checked while exploring; tests that run there are still checked.";

/** What the explorer calls. All optional: an exploration without them is exactly as before. */
export interface ExploreQualityHooks {
    /** Once, before the explorer's first look at the app. */
    atStart?(): Promise<void>;
    /** A screen the exploration has not seen before (its first snapshot). */
    onNewScreen?(snap: ScreenSnapshot, screen: { id: string; title: string }): void;
    /** After every action the AI chose. "restart": the app crashed or froze, the explorer starts it again from its first screen. */
    afterAction?(info: { before: ScreenSnapshot; screen: { id: string; title: string }; path: readonly string[]; prelude: readonly RecordedAction[]; action?: RecordedAction }): Promise<"restart" | undefined>;
}

export class QualityCollector {
    readonly crashes: ExploreCrash[] = [];
    readonly accessibility: ScreenA11y[] = [];
    startup: PhoneQualityPlan["startup"];
    readonly notes: string[] = [];
    private density: number | undefined;
    /** Where the steps since the last (re)start begin in the explorer's path. */
    private since = 0;

    constructor(private readonly o: { ctx: EngineContext; session: DeviceSession; budgetMs?: number }) {}

    private emit(kind: string, message: string, level: "info" | "warn" = "info") {
        this.o.ctx.emit({ stage: "discovery", kind, level, message });
    }

    private note(s: string) {
        if (!this.notes.includes(s)) this.notes.push(s);
    }

    private record(c: ExploreCrash): boolean {
        const dup = this.crashes.find((x) => x.crash.kind === c.crash.kind && x.crash.exception === c.crash.exception && x.screen.id === c.screen.id);
        if (dup) {
            dup.times = (dup.times ?? 1) + 1;
            return false;
        }
        if (this.crashes.length >= MAX_EXPLORE_CRASHES) return false;
        this.crashes.push(c);
        return true;
    }

    hooks(): ExploreQualityHooks {
        const health = this.o.session.health;
        return {
            atStart: async () => {
                const budgetMs = clampBudget(this.o.budgetMs);
                if (!health) {
                    this.note(ON_RUNNER);
                    return;
                }
                this.density = await health.densityDpi();
                const cold = await health.coldStart();
                if (cold.measure) {
                    const over = cold.measure.totalMs > budgetMs;
                    this.startup = { measure: cold.measure, budgetMs, overBudget: over };
                    this.emit("mobile_startup_time", `The app took ${formatMs(cold.measure.totalMs)} to open from a cold start (budget ${formatMs(budgetMs)})${over ? ": slower than the budget" : ""}`, over ? "warn" : "info");
                } else {
                    this.startup = { budgetMs, overBudget: false, ...(cold.problem ? { note: cold.problem } : {}) };
                    if (cold.problem) this.note(`${cold.problem}.`.replace(/\.\.$/, "."));
                }
                for (const crash of await health.crashes()) {
                    if (this.record({ crash, screen: { id: "", title: "App start", texts: [] }, steps: ["Started the app"] }))
                        this.emit("mobile_app_crashed", `${crashHeadline(crash)} (as the app started)`, "warn");
                }
                if (health.unavailable) this.note(health.unavailable);
            },
            onNewScreen: (snap, screen) => {
                if (this.accessibility.length >= DEFAULT_LIMITS.maxScreens + 5) return;
                this.accessibility.push(checkScreenA11y(snap, { screen: screen.id, title: screen.title, ...(this.density ? { densityDpi: this.density } : {}) }));
            },
            afterAction: async (info) => {
                if (!health) return undefined;
                const found = await health.crashes();
                if (!found.length) {
                    if (health.unavailable) this.note(health.unavailable);
                    return undefined;
                }
                const steps = info.path.slice(this.since);
                const texts = info.before.elements
                    .map((e) => cleanAppText(e.text || e.desc, 40))
                    .filter((t) => t.length >= 2)
                    .slice(0, 6);
                for (const crash of found) {
                    const isNew = this.record({ crash, screen: { id: info.screen.id, title: info.screen.title, texts }, steps: [...steps], repro: { screen: info.screen.id, prelude: [...info.prelude], ...(info.action ? { action: info.action } : {}) } });
                    if (isNew) this.emit("mobile_app_crashed", `${crashHeadline(crash)} (after: ${steps[steps.length - 1] ?? "an action"}). The app was started again and the exploration goes on.`, "warn");
                }
                this.since = info.path.length + 1;
                return "restart";
            },
        };
    }

    plan(found: MobileAppModel, o: { appPackage: string }): PhoneQualityPlan {
        const plan: PhoneQualityPlan = { crashes: this.crashes, ...(this.startup ? { startup: this.startup } : {}), accessibility: this.accessibility, notes: [...this.notes, NOT_CHECKED] };
        return { ...plan, ...qualityTests(found, plan, o) };
    }
}

// ── the check tests of a plan ───────────────────────────────────────────────

const WAIT_AFTER = 2000;

/** Builds the check tests of the findings. Ones that cannot be written are listed with the plain reason, never dropped silently. */
export function qualityTests(found: MobileAppModel, q: PhoneQualityPlan, o: { appPackage: string }): { tests: QualityTest[]; couldNotWrite: Array<{ title: string; reason: string }> } {
    const tests: QualityTest[] = [];
    const couldNotWrite: Array<{ title: string; reason: string }> = [];
    const paths = shortestPaths(found, DEFAULT_LIMITS.maxPathEdges);
    const app = appNameOf(o.appPackage);
    const seenWhile = "Seen while the AI explored the app. Run this test to check it again on the phone.";

    /** Steps that reach a screen from a fresh start, then do `extra`. */
    const reach = (screen: string, extra: RecordedAction[]): { steps: Step[] } | { problem: string } => {
        const edges = screen === "" || screen === found.start ? [] : paths.get(screen);
        if (!edges) return { problem: "Its screen could not be reached again from the first screen in a few steps" };
        const { steps, problem } = stepsOf([...edges.flatMap((e) => [...e.prelude, e.action]), ...extra]);
        if (problem) return { problem };
        return { steps };
    };
    const add = (kind: QualityTestKind, title: string, reason: string, steps: Step[], extra: { type: string; priority: string; tags: string[]; goal: string; journey: string }) => {
        const all: Step[] = [...steps, { action: "wait", ms: WAIT_AFTER, description: "" } as Step];
        if (all.length > MAX_TEST_STEPS) return void couldNotWrite.push({ title, reason: `It needs ${all.length} steps, and a test has at most ${MAX_TEST_STEPS}` });
        const id = `Q-${String(tests.length + 1).padStart(2, "0")}`;
        let draft: Record<string, unknown>;
        try {
            const spec = TestSpecSchema.parse({
                testId: DRAFT_ID,
                title,
                description: extra.goal,
                kind: "mobile",
                platform: "android",
                category: `Phone · ${app}`,
                type: extra.type,
                priority: extra.priority,
                preconditions: [],
                steps: all,
                expectedResults: [extra.goal],
                testData: {},
                tags: ["phone", "ai-explored", ...extra.tags],
                source: { scenarioId: id, journey: extra.journey, origin: "exploration" },
            });
            const bad = spec.steps.flatMap((s) => secretProblems(s))[0];
            if (bad) throw new Error(bad);
            renderWithAdapter(spec, "taqwright", { baseUrl: `android-app://${o.appPackage}` });
            draft = { ...spec } as Record<string, unknown>;
            delete draft.testId;
        } catch (e) {
            couldNotWrite.push({ title, reason: `It cannot be written as a phone test: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` });
            return;
        }
        tests.push({ id, kind, title, reason, draft });
    };

    for (const c of q.crashes) {
        const verb = c.crash.kind === "anr" ? "stop responding" : "crash";
        const title = c.screen.id ? `The app does not ${verb} on “${c.screen.title}”` : `The app does not ${verb} when it starts`;
        const r = c.repro ? reach(c.repro.screen, [...c.repro.prelude, ...(c.repro.action ? [c.repro.action] : [])]) : { steps: [] as Step[] };
        if ("problem" in r) {
            couldNotWrite.push({ title, reason: r.problem });
            continue;
        }
        add("crash", title, exploreCrashReason(c), r.steps, { type: "functional", priority: "high", tags: [TAG_CRASH], goal: `Repeats what the AI did before the app ${c.crash.kind === "anr" ? "stopped responding" : "crashed"}; the app keeps running.`, journey: c.steps.join(" → ").slice(0, 300) });
    }

    if (q.startup?.overBudget && q.startup.measure) {
        const b = q.startup.budgetMs;
        add("startup", `The app opens within ${formatMs(b)}`, slowStartReason(q.startup.measure, b, seenWhile), [], { type: "performance", priority: "medium", tags: [TAG_STARTUP, budgetTag(b)], goal: `A cold start of the app shows its first screen within ${formatMs(b)}.`, journey: "App start" });
    }

    for (const s of q.accessibility) {
        if (!s.issues.length) continue;
        const title = `Accessibility of “${s.title}”`;
        const r = reach(s.screen, []);
        if ("problem" in r) {
            couldNotWrite.push({ title, reason: r.problem });
            continue;
        }
        add("accessibility", title, a11yReason(s, seenWhile), r.steps, { type: "accessibility", priority: "medium", tags: [TAG_A11Y], goal: `“${s.title}” has labels a screen reader can say and touch targets of at least 48 dp.`, journey: s.title });
    }
    return { tests, couldNotWrite };
}

export { qualityCounts } from "./findings.js";
