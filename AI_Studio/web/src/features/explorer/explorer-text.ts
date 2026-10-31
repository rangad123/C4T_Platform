import type { Job } from "../../api.js";

/** The Explorer view, the parts that need no React and no network: the shapes, the words and the picture this tab keeps. The long version is docs/features/ux-explorer-view.md. */

/** What the platform answers for GET /projects/:id/jobs/:jobId/frame. */
export interface FrameAnswer {
    available: boolean;
    unchanged?: boolean;
    why?: "waiting" | "nothing" | "elsewhere" | "finished" | "stopping" | "unavailable";
    reason?: string;
    imageBase64?: string;
    url?: string;
    title?: string;
    note?: string;
    phase?: string;
    pagesSeen?: number;
    at?: string;
    ageMs?: number;
    /** A picture of a phone or emulator screen (portrait): `url` is then the screen’s own name or activity, `title` the screen’s title, and `app` the app’s name. Absent for a browser. */
    kind?: "phone";
    app?: string;
    screensSeen?: number;
}

/** A picture the person has seen: the thing kept on screen. */
export interface Shown {
    src: string;
    url: string;
    title: string;
    note: string;
    phase: string;
    pagesSeen: number;
    at: string;
    kind?: "phone";
    app?: string;
    /** When it was taken, on this computer's clock (the server says how old it was when it arrived). */
    takenAt: number;
}

/** Ask no more often than this while the panel is open and the job is running. */
export const EXPLORER_POLL_MS = 1500;
/** A reading of the activity line goes to a screen reader at most this often. */
export const ANNOUNCE_GAP_MS = 5000;
const WATCH_KEY = "aitp.explorer.watch";

/** The switch is remembered in this browser only; a browser that refuses storage just starts off every time. */
export function readWatch(): boolean {
    try {
        return window.localStorage.getItem(WATCH_KEY) === "1";
    } catch {
        return false;
    }
}
export function writeWatch(on: boolean): void {
    try {
        window.localStorage.setItem(WATCH_KEY, on ? "1" : "0");
    } catch {
        /* not remembered */
    }
}

/** Which jobs the person can watch: an exploration that explores (not creation from a plan) and a test built from a sentence. */
export const canOfferWatch = (job: { mode?: Job["mode"]; fromPlan?: string }): boolean => job.mode === "plain" || ((job.mode ?? "generate") === "generate" && !job.fromPlan);

export const phaseWords = (phase: string | undefined, phone = false): string => phone && phase === "exploring" ? "Exploring the app" : (phase === "signing-in" ? "Signing in" : phase === "building" ? "Building your test" : phase === "exploring" ? "Exploring pages" : "");
export const pagesWords = (n: number): string => `${n} ${n === 1 ? "page" : "pages"} seen`;
export const updatedWords = (ms: number): string => (ms < 3000 ? "Updated just now" : ms < 60_000 ? `Updated ${Math.round(ms / 1000)} seconds ago` : `Updated ${Math.round(ms / 60_000)} minutes ago`);
export const finishedWords = (mode: Job["mode"], pages: number, stopped = false): string => (mode === "plain" ? (stopped ? "Building stopped" : "Building finished") : `Exploration ${stopped ? "stopped" : "finished"}: ${pagesWords(pages)}`);

export const WAITING = "Waiting for the first picture…";
export const NOTHING = "Nothing to show right now.";
export const ELSEWHERE = "This part runs on another computer and cannot be shown.";
export const EXPLAIN_FINISHED = "This is the last picture of the browser the AI used on the platform’s computer. Passwords were hidden. It is kept on this page only and is gone when you leave.";
export const EXPLAIN_PHONE = "This is a picture of the phone screen the AI is using, on a runner or on the platform’s computer. It refreshes about once a second while this panel is open. Passwords are hidden.";
export const EXPLAIN_PHONE_FINISHED = "This is the last picture of the phone screen the AI used. Passwords were hidden. It is kept on this page only and is gone when you leave.";
export const EXPLAIN = "This is a picture of the browser the AI is using on the platform’s computer. It refreshes about once a second while this panel is open. Passwords are hidden.";

// ── the last picture of a job, kept in this tab only ───────────────────────────
// The platform forgets a picture when its job ends, so the finished panel shows the one this tab already had. Never stored anywhere else.

const kept = new Map<string, { shown: Shown; pages: number }>();
const KEEP_JOBS = 3;
export const keptFor = (jobId: string) => kept.get(jobId);
export function keep(jobId: string, shown: Shown, pages: number): void {
    kept.delete(jobId);
    kept.set(jobId, { shown, pages });
    while (kept.size > KEEP_JOBS) kept.delete(kept.keys().next().value as string);
}
export const forget = (jobId: string): void => void kept.delete(jobId);

