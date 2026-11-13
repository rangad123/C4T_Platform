/**
 * AI phone tests, the parts that need no React and no network: the words, the choices a person is offered, and what is read from the
 * platform's answers. The long version is docs/features/ux-phone-ai.md.
 *
 * The platform decides everything that matters (where it can run, what the AI may tap). This file only turns its answers into plain words, and
 * never shows a state the answers do not support: a runner that does not say it can explore a phone is shown as one that cannot.
 */
import type { EventRow, Job, MobileApp, PlatformConfig } from "../../api.js";
import { plural } from "../../lib/format.js";
import { routes } from "../../lib/router.js";
import { runnerProblem, type RunnerMine } from "../runners/my-runner.js";

// ── what the AI is exploring ─────────────────────────────────────────────────

/** A job that explores an Android app. A job with the website too is still one: the phone part is what these screens add. */
export const isPhoneJob = (job: Pick<Job, "targets"> | undefined | null): boolean => job?.targets?.includes("mobile") === true;
/** A job that explores nothing but the phone app (the wording of the whole page follows it). */
export const isPhoneOnly = (job: Pick<Job, "targets"> | undefined | null): boolean => isPhoneJob(job) && job!.targets!.every((t) => t === "mobile");

/** The app, in words: its package, or the name of the file that was uploaded. */
export function appLabel(m: MobileApp | null | undefined): string {
    if (m?.appPackage) return m.appPackage;
    if (m?.apk) return m.apk.split(/[\\/]/).pop() || "the uploaded app";
    return "the app";
}

/** Does the project have an Android app at all? An iPhone app alone does not count: exploring is Android only. */
export const hasAndroidApp = (m: MobileApp | null | undefined): boolean => Boolean(m?.appPackage || m?.apk);
export const iPhoneOnly = (m: MobileApp | null | undefined): boolean => Boolean(m?.iosBundleId) && !hasAndroidApp(m);

/**
 * What the project's Mobile app allows. The platform explores an app by its package name (an .apk alone is installed first but does not name the app),
 * so a project with only a file is asked for the name rather than refused later.
 */
export type AppState = "none" | "needs-package" | "ios-only" | "ready";
export function appState(m: MobileApp | null | undefined): AppState {
    if (m?.appPackage) return "ready";
    if (m?.apk) return "needs-package";
    return iPhoneOnly(m) ? "ios-only" : "none";
}

/** The package an exploration picture belongs to: the platform sends the app as android-app://<package>. */
export const packageOfUrl = (url: string | undefined): string => (url ?? "").replace(/^android-app:\/\//, "").replace(/[/?#].*$/, "");
export const isPhoneUrl = (url: string | undefined | null): boolean => typeof url === "string" && url.startsWith("android-app://");

/**
 * A job as the screens see it. The job answer may not say what the job explored; a project whose application is an android-app:// address is a
 * phone project, so its jobs are phone jobs. An answer that does say (`targets`) is believed.
 */
export function phoneJobOf<T extends Pick<Job, "targets">>(job: T, applicationUrl: string | null | undefined): T {
    if (job.targets || !isPhoneUrl(applicationUrl)) return job;
    return { ...job, targets: ["mobile"] };
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** "" when `v` can be an Android package name, otherwise what to fix. */
export function packageError(v: string): string {
    const s = v.trim();
    if (!s) return "";
    return PACKAGE.test(s) && s.length <= 200 ? "" : "That doesn’t look like an app package. It has at least two parts joined by dots, for example com.example.shop.";
}

/** Where "Explore again" goes: a phone exploration starts from the panel in Settings, Mobile app; anything else from the exploration form. */
export const exploreAgainHref = (job: Pick<Job, "targets"> | null | undefined, projectId: string): string => (isPhoneOnly(job) ? `${routes.setup(projectId, "mobile")}&start=phone` : routes.newProject({ project: projectId }));

// ── words ────────────────────────────────────────────────────────────────────

export const PHONE_TITLE = "Explore the phone app (AI)";
export const NEED_APP = "Add a phone app first";
export const NEED_PACKAGE = "Phone exploration needs the app’s package name, for example com.example.shop. Add it under Settings, Mobile app.";
export const IPHONE_NOTE = "Phone exploration works on Android only. For iPhone apps, import tests.";
export const willDo = (app: string): string =>
    `The AI will open ${app} on a phone or emulator, tap through it like a careful user, and plan tests. Nothing is created until you approve the plan. It never taps buttons that look like paying, deleting or sending, and passwords are hidden.`;
export const WONT_DO = ["Pay for anything or subscribe", "Delete accounts or data", "Send messages or money, or make calls", "Use a fingerprint or face check", "Get past captchas", "Explore games"];
export const ACCOUNT_REMINDER = "If the app needs a login, add a test account under Advanced options.";
export const NO_WHERE_TITLE = "No phone or emulator is ready";
export const AI_MISSING = "Exploring a phone app uses your AI key.";
/** Runners mode (round 52): the exploration runs on the person's runner, on the phone or emulator attached to it. */
export const EXPLORES_ON_YOUR_RUNNER = "It opens the phone or emulator attached to your runner’s computer. The AI works from the platform.";

export const screensWords = (n: number): string => `${plural(n, "screen")} seen`;
export const actionsWords = (n: number): string => plural(n, "action");
export const countsLine = (c: { screens: number; actions: number | null }): string => (c.actions === null ? screensWords(c.screens) : `${screensWords(c.screens)}, ${actionsWords(c.actions)}`);

// ── where it runs ────────────────────────────────────────────────────────────

export interface WhereOption {
    label: string;
    can: boolean;
    /** One plain sentence: what is there, or why it cannot be used and what to do. */
    detail: string;
}

/**
 * Where an exploration runs: where the project runs its tests, or in runners mode (round 52) always the person's runner, the whole exploration
 * on it. On the person's runner the server's own sentence says whether it can (`can.phoneSession`; in runners mode `can.phoneExplore`, which
 * also says when the runner program is too old); a server that does not say decides at the click.
 */
export function phoneWhere(config: PlatformConfig | undefined, runOn: "platform" | "agent" | "runners", runner: RunnerMine | null | undefined): WhereOption {
    if (runOn === "platform") {
        const m = config?.mobile;
        return m?.available
            ? { label: "This server", can: true, detail: m.avds.length ? `An Android emulator is ready here (${m.avds[0]}).` : "An Android emulator is ready here." }
            : { label: "This server", can: false, detail: m?.reason ? `${m.reason.replace(/\.$/, "")}.` : "No Android emulator is set up on this server." };
    }
    const why = runnerProblem({ runner: runner ?? null }, { can: [runOn === "runners" ? "phoneExplore" : "phoneSession"] });
    return { label: runner ? `Your runner, ${runner.name}` : "Your runner", can: !why, detail: why ?? (runOn === "runners" ? EXPLORES_ON_YOUR_RUNNER : "It opens the phone or emulator on your runner’s computer.") };
}

// ── starting ─────────────────────────────────────────────────────────────────

/** The body of the request that starts an exploration of the phone app. It always stops at a plan. */
export function startBody(account: { username: string; password: string }): Record<string, unknown> {
    const body: Record<string, unknown> = { targets: ["mobile"], plan: true };
    if (account.username.trim() || account.password) body.credentials = { username: account.username.trim() || undefined, password: account.password || undefined };
    return body;
}

// ── while it runs ────────────────────────────────────────────────────────────

const SKIPPED = /^Skipped\b/;

/** "Skipped “Delete account” because it looks destructive", once each, in the order they happened. The platform names these events mobile_action_skipped. */
export function skippedOf(events: EventRow[] | undefined): string[] {
    const seen = new Set<string>();
    for (const e of events ?? []) if (e.kind === "mobile_action_skipped" || e.kind === "skipped" || SKIPPED.test(e.message)) seen.add(e.message.trim());
    return [...seen];
}

/**
 * Screens seen and actions taken, as far as the platform says. Screens: its own counter, else the screens its events announce (it says "Found screen"
 * when it first sees one). Actions: only a counter, or the closing event ("9 screens, 31 actions"); while it runs the platform does not count them, and
 * then this says nothing about actions rather than guessing.
 */
export function phoneCounts(job: Pick<Job, "counters">, events: EventRow[] | undefined): { screens: number; actions: number | null } {
    const c = job.counters ?? ({} as Job["counters"]);
    const found = (events ?? []).filter((e) => e.kind === "mobile_screen_found").length;
    const ended = (events ?? []).find((e) => e.kind === "mobile_exploration_done")?.message.match(/(\d+) actions?\b/);
    return { screens: c.screensSeen ?? Math.max(c.pagesDiscovered ?? 0, found), actions: c.actionsTaken ?? (ended ? Number(ended[1]) : null) };
}

export const SKIP_CAP = 12;

/** The phases of a phone exploration in the words of a phone app (the others keep their usual words). */
export function phonePhase(phase: string, state: string, screens: number): { title: string; detail?: string } | null {
    if (phase !== "discovery") return null;
    if (state === "done") return { title: "Phone app explored", detail: screens ? `Found ${plural(screens, "screen")}` : undefined };
    return { title: state === "running" ? "Exploring your phone app…" : "Explore your phone app", detail: state === "running" && screens ? `${plural(screens, "screen")} so far` : undefined };
}

export const phoneFinishedWords = (screens: number, stopped: boolean): string => `Exploration ${stopped ? "stopped" : "finished"}: ${screensWords(screens)}`;
