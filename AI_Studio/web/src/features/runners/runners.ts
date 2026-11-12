import type { RanOn, WebBrowserUsed } from "../../api.js";
import type { Tone } from "../../lib/labels.js";
import type { RunnerOs, RunnerState } from "./my-runner.js";

export type { RanOn };

/** How to bring an offline runner back, for the system it last ran on (the background start at sign-in is the installer's; docs/features/runner-installer.md). */
export function offlineSteps(os: RunnerOs | null | undefined): string[] {
    if (os === "windows") {
        return [
            "Sign in to that computer. A runner set up with the installer starts by itself when you sign in, and shows an icon in the notification area next to the clock. A locked screen is fine.",
            "If the icon is there, open it and choose Start. If it is not, open AI Testing Runner from the Start menu, or run AITestingRunnerSetup.exe again and choose Install and start.",
            "If you started it with start-runner.cmd, double-click it again and leave the window open.",
        ];
    }
    if (os === "mac") {
        return [
            "Sign in to that Mac. A runner set up with the app starts by itself when you sign in. A locked screen is fine.",
            "If it still does not connect, open AI Testing Runner from Applications.",
            "If you started it with start-runner.sh, run it again in Terminal and leave the window open.",
        ];
    }
    if (os === "linux") return ["Start it again on that computer with sh start-runner.sh in its folder, and leave the window open."];
    return ["Start the runner again on its computer, and check that the computer is on and online."];
}

/** The badge of the person's runner, and of a row in Everyone's runners. */
export const STATUS_WORDS: Record<RunnerState | "not-connected" | "retired", { label: string; tone: Tone; tip: string }> = {
    online: { label: "Online", tone: "success", tip: "Connected and ready for work." },
    busy: { label: "Busy", tone: "info", tip: "Connected and running tests now." },
    offline: { label: "Offline", tone: "neutral", tip: "Not connected. Nothing heard from it for 45 seconds. Runs can’t start until it is back online. Schedules wait for it." },
    "not-connected": { label: "Not connected yet", tone: "warning", tip: "Set up, but it has not connected yet." },
    retired: { label: "Removed", tone: "neutral", tip: "It can no longer connect." },
};

// ── shapes shared with the run screens ──────────────────────────────────────

/** A runner's updates, as Settings shows them (docs/features/runner-updates.md). Present for a runner started from a download. */
export interface RunnerUpdateView {
    /** The runner can replace its own files (a download from the version with updates on). */
    can: boolean;
    auto: boolean;
    /** The platform's runner version. */
    latest?: string;
    outOfDate: boolean;
    requested: boolean;
    /** "needs-manual": an update exists but its signature could not be checked on that computer, so it must be downloaded by hand. */
    state?: "idle" | "preparing" | "ready" | "updated" | "failed" | "rolled-back" | "needs-manual";
    /** false when this platform offers no signed update (the reason in `unpublished`). */
    published?: boolean;
    unpublished?: string;
    from?: string;
    to?: string;
    error?: string;
    at?: string;
    retryAt?: string;
}

/** The runner's "Check this computer" (docs/features/runner-check.md): never a token, a password or a path. */
export interface RunnerCheck {
    at: string;
    items: Array<{ id: string; status: "ok" | "missing" | "optional"; title: string; fix?: string }>;
}

/** GET /api/projects/:id/runner: where the project runs in local mode. */
export interface RunnerChoice {
    runOn: "platform" | "agent";
    agentId: string | null;
    /** One plain sentence, for example "Runs on Maya's laptop (online)." */
    status: string;
    canRunWeb: boolean;
    canRunMobile: boolean;
    /** One sentence about phone tests that agrees with Settings (present from a server that has it). */
    phones?: { canRun: boolean; text: string };
    /** Present from a server that supports iOS tests. */
    canRunIos?: boolean;
    unavailableReason: string | null;
}

const WEB_BROWSER_LABEL: Record<WebBrowserUsed["name"], string> = { chromium: "Chromium", chrome: "Google Chrome", msedge: "Microsoft Edge" };

/** "Microsoft Edge 155, installed on Maya's laptop" (the runner's window says the same about "this computer"). */
export function browserSentence(b: WebBrowserUsed, where: string): string {
    const major = /^(\d{1,4})\./.exec(b.version ?? "")?.[1];
    const name = `${WEB_BROWSER_LABEL[b.name]}${major ? ` ${major}` : ""}`;
    if (b.source === "installed") return `${name}, installed on ${where}`;
    if (b.source === "downloaded") return `${name}, downloaded by the runner`;
    return `${name}, the browser that comes with the test tools`;
}

/** Sentence for the "where did it run" line. */
export function ranOnSentence(r: RanOn): string {
    return r.kind === "platform" ? "Ran on this server" : `Ran on ${r.name}`;
}
