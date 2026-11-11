import type { Tone } from "../../lib/labels.js";
import type { RunnerOs, RunnerState } from "./my-runner.js";

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
