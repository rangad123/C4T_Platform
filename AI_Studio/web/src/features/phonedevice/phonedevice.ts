/**
 * Phones, round 24 (DEVICE): the parts of the screens that need no React and no network. The words of "Where phone tests run", "How thorough" and
 * "Already signed in on this phone", the ready check as the platform sends it, the counters of a running exploration, the coverage line of a plan,
 * and the question an exploration waits on. The platform decides everything; this file turns its answers into plain words.
 * The long version is docs/features/phone-ready-and-sign-in.md.
 */
import type { EventRow } from "../../api.js";
import { plural } from "../../lib/format.js";

// ── what the platform sends ─────────────────────────────────────────────────

export type RunsOn = { kind: "auto" } | { kind: "explored" } | { kind: "phone"; serial: string; model?: string } | { kind: "emulator" } | { kind: "farm" };
export type Depth = "quick" | "standard" | "thorough";

export interface PhoneSettingsAnswer {
    hasApp: boolean;
    appPackage: string | null;
    runsOn: RunsOn | null;
    effective: RunsOn;
    sentence: string;
    exploredOn: { serial: string; model?: string; emulator: boolean; at?: string } | null;
    depth: Depth;
    depths: Array<{ id: Depth; label: string; screens: number; actions: number; minutes: number; ideas: number; line: string }>;
    keepSignedIn: boolean;
    cleanStart: boolean;
    farm: { connections: Array<{ id: string; label: string }>; chosen: { id: string; label: string } | null };
}

export type CheckStatus = "ok" | "attention" | "problem" | "info";
export type ReadyState = "ready" | "attention" | "not-ready";
export type ReadyAction = "animations-off" | "animations-restore" | "stay-awake-on" | "stay-awake-restore";

export interface ReadyCheck {
    id: string;
    status: CheckStatus;
    title: string;
    detail?: string;
    steps?: string[];
    action?: ReadyAction;
}

export interface Phone {
    serial: string;
    emulator: boolean;
    model?: string;
    manufacturer?: string;
    maker: string;
    androidVersion?: string;
    sdk?: number;
    state: ReadyState;
    summary: string;
    checks: ReadyCheck[];
    tips: Array<{ title: string; why: string; steps: string[] }>;
}

export interface PhonesAnswer {
    available: boolean;
    reason?: string;
    phones: Phone[];
    more?: number;
}

// ── words ───────────────────────────────────────────────────────────────────

export const READY_WORD: Record<ReadyState, string> = { ready: "Ready", attention: "Check", "not-ready": "Not ready" };
export const READY_TONE: Record<ReadyState, "success" | "warning" | "danger"> = { ready: "success", attention: "warning", "not-ready": "danger" };
export const CHECK_TONE: Record<CheckStatus, "success" | "warning" | "danger" | "info"> = { ok: "success", attention: "warning", problem: "danger", info: "info" };

/** The button for an action the ready check offers (every one can be undone). */
export const ACTION_WORDS: Record<ReadyAction, { label: string; tip: string }> = {
    "animations-off": { label: "Turn animations off for tests", tip: "Sets the phone’s three animation scales to off, and remembers what they were. Restore animations puts them back." },
    "animations-restore": { label: "Restore animations", tip: "Puts the phone’s animation scales back to what they were before they were turned off for tests." },
    "stay-awake-on": { label: "Keep the screen on while charging", tip: "Turns on Stay awake while the phone charges, and remembers the old setting so it can be put back." },
    "stay-awake-restore": { label: "Put the screen setting back", tip: "Puts Stay awake back to what it was before." },
};

/** "CPH2467 (R58N20ABCDE)". */
export const phoneName = (p: { serial: string; model?: string | undefined }): string => (p.model ? `${p.model} (${p.serial})` : p.serial);

/** "Android 15, OnePlus" or "Emulator, Android 14". */
export function phoneLine(p: Phone): string {
    const parts = [p.emulator ? "Emulator" : p.manufacturer ? p.manufacturer.charAt(0).toUpperCase() + p.manufacturer.slice(1) : "Phone"];
    if (p.androidVersion) parts.push(`Android ${p.androidVersion}`);
    return parts.join(", ");
}

/** What a choice of "Where phone tests run" is called, and its line. */
export interface WhereChoice {
    kind: RunsOn["kind"];
    label: string;
    detail: string;
    /** Why it cannot be chosen now, when it cannot. */
    off?: string;
    runsOn: RunsOn;
}

/** `runnersOnly`: tests run on each person's runner, so no phone of the platform's computer is offered (Use my connected phone decides). */
export function whereChoices(s: PhoneSettingsAnswer, phones: Phone[], runnersOnly = false): WhereChoice[] {
    const ex = s.exploredOn;
    const out: WhereChoice[] = [
        { kind: "auto", label: "Choose for me", detail: runnersOnly ? "On your runner: a connected phone that has the app when Use my connected phone is on, else an emulator." : "A connected phone that has the app, else an emulator.", runsOn: { kind: "auto" } },
        {
            kind: "explored",
            label: "The phone the AI explored on",
            detail: ex ? `${phoneName(ex)}${ex.emulator ? ", an emulator" : ""}. Tests run where the app was explored.` : "Not known yet: the AI has not explored this app.",
            ...(ex ? {} : { off: "Explore the app first." }),
            runsOn: { kind: "explored" },
        },
    ];
    // Each real phone connected to the platform's computer, plus the one already chosen even when it is unplugged.
    const named = new Map<string, { serial: string; model?: string }>();
    for (const p of phones) if (!p.emulator) named.set(p.serial, { serial: p.serial, ...(p.model ? { model: p.model } : {}) });
    if (s.runsOn?.kind === "phone" && !named.has(s.runsOn.serial)) named.set(s.runsOn.serial, s.runsOn);
    for (const p of named.values()) {
        const connected = phones.some((x) => x.serial === p.serial);
        out.push({ kind: "phone", label: phoneName(p), detail: connected ? "This phone, whichever phone the AI explored on." : runnersOnly ? "This phone, when it is connected to your runner." : "This phone. It is not connected to the platform’s computer right now.", runsOn: { kind: "phone", serial: p.serial, ...(p.model ? { model: p.model } : {}) } });
    }
    out.push({ kind: "emulator", label: "An emulator", detail: "Even when a phone is connected.", runsOn: { kind: "emulator" } });
    out.push({
        kind: "farm",
        label: "A device farm",
        detail: s.farm.chosen ? `“${s.farm.chosen.label}”.` : s.farm.connections.length === 1 ? `“${s.farm.connections[0]!.label}”.` : s.farm.connections.length > 1 ? "Choose which connection under Device farm." : "Set one up under Device farm first.",
        ...(s.farm.connections.length === 1 || s.farm.chosen ? {} : { off: s.farm.connections.length > 1 ? "Choose the connection under Device farm." : "No device farm is set up." }),
        runsOn: { kind: "farm" },
    });
    return out;
}

/** The key of a choice, for radio buttons ("phone:R58N20ABCDE"). */
export const choiceKey = (r: RunsOn): string => (r.kind === "phone" ? `phone:${r.serial}` : r.kind);

/** The choice the radio buttons show: the farm when the farm decides, else what is stored, else what applies by default. */
export function currentChoiceKey(s: PhoneSettingsAnswer): string {
    if (s.farm.chosen) return "farm";
    // Nothing stored: what applies (the phone the AI explored on, once it explored on a real phone).
    return choiceKey(s.runsOn ?? s.effective);
}

export const KEEP_SIGNED_IN = {
    label: "Already signed in on this phone",
    hint: "Keeps the app’s data, so an app you signed into by hand on the phone is explored and tested signed in. Nothing clears the app’s data before a test.",
    conflict: "Turn off “Start every test from a fresh install of the app’s data” under How each test starts first: it clears the app’s data, which signs the app out.",
};

// ── while it explores ───────────────────────────────────────────────────────

export interface Coverage {
    screens: number;
    activities: number;
    activitiesListed?: number;
    actions: number;
    aiCalls: number;
    stoppedBecause?: string;
    done: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The newest numbers the platform said: `mobile_exploration_done` (the end, with why it stopped) or the latest `mobile_progress`.
 * Undefined when it said neither (an older platform, or nothing yet).
 */
export function coverageOf(events: Array<EventRow & { data?: unknown }> | undefined): Coverage | undefined {
    const list = events ?? [];
    const done = [...list].reverse().find((e) => e.kind === "mobile_exploration_done" && e.data && typeof e.data === "object");
    const prog = [...list].reverse().find((e) => e.kind === "mobile_progress" && e.data && typeof e.data === "object");
    const e = done ?? prog;
    if (!e) return undefined;
    const d = e.data as Record<string, unknown>;
    const activities = Array.isArray(d.activitiesSeen) ? d.activitiesSeen.length : (num(d.activities) ?? 0);
    const screens = num(d.screens);
    if (screens === undefined) return undefined;
    return {
        screens,
        activities,
        ...(num(d.activitiesListed) !== undefined ? { activitiesListed: num(d.activitiesListed)! } : {}),
        actions: num(d.actions) ?? 0,
        aiCalls: num(d.aiCalls) ?? 0,
        ...(done && typeof d.stoppedBecause === "string" ? { stoppedBecause: d.stoppedBecause } : {}),
        done: Boolean(done),
    };
}

/** "142 screens seen, 31 activities, 588 actions, 12 AI calls" (it starts like the older line, "4 screens seen"). */
export const coverageCounts = (c: Coverage): string =>
    [`${plural(c.screens, "screen")} seen`, `${plural(c.activities, "activity", "activities")}${c.activitiesListed ? ` of ${c.activitiesListed}` : ""}`, plural(c.actions, "action"), plural(c.aiCalls, "AI call")].join(", ");

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The plan's line: "Explored 142 screens across 31 activities; stopped because no new screens appeared after 80 actions." */
export function coverageSentence(c: { screens: number; activities: number; activitiesListed?: number | undefined; stoppedBecause?: string | undefined }): string {
    const acts = `${plural(c.activities, "activity", "activities")}${c.activitiesListed ? ` (the phone lists ${c.activitiesListed} for the app)` : ""}`;
    const why = c.stoppedBecause ? `; stopped because ${lower(c.stoppedBecause.replace(/\.$/, ""))}` : "";
    return `Explored ${plural(c.screens, "screen")} across ${acts}${why}.`;
}

// ── a person is needed ──────────────────────────────────────────────────────

export interface OpenQuestion {
    requestId: string;
    kind: "code" | "captcha" | "signed-out";
    message: string;
    deadline: string;
    screen?: string;
}

/** The question the exploration is waiting on, read from the job's events (the same rule as the platform's): the newest one not answered yet. */
export function openQuestionOf(events: Array<EventRow & { data?: unknown }> | undefined, now = Date.now()): OpenQuestion | undefined {
    const list = events ?? [];
    const answered = new Set(list.filter((e) => e.kind === "mobile_sign_in_answer").map((e) => String((e.data as { requestId?: unknown } | null)?.requestId ?? "")));
    const waiting = [...list].reverse().find((e) => e.kind === "mobile_sign_in_waiting");
    if (!waiting) return undefined;
    const d = (waiting.data ?? {}) as Record<string, unknown>;
    const requestId = String(d.requestId ?? "");
    const deadline = String(d.deadline ?? "");
    if (!requestId || answered.has(requestId) || !deadline || Date.parse(deadline) < now) return undefined;
    const kind = d.kind === "captcha" || d.kind === "signed-out" ? d.kind : "code";
    return { requestId, kind, message: waiting.message, deadline, ...(typeof d.screen === "string" ? { screen: d.screen } : {}) };
}

export const QUESTION_TITLE: Record<OpenQuestion["kind"], string> = {
    code: "The app asks for a one-time code",
    captcha: "The app asks you to prove you are a person",
    "signed-out": "The app asks to sign in",
};

/** "4 min 05 s left", or "less than a minute left". */
export function timeLeft(deadline: string, now = Date.now()): string {
    const s = Math.max(0, Math.round((Date.parse(deadline) - now) / 1000));
    if (s < 60) return "less than a minute left";
    const m = Math.floor(s / 60);
    return `${m} min ${String(s % 60).padStart(2, "0")} s left`;
}
