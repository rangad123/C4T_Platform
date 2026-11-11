import type { Tone } from "../../lib/labels.js";
import type { RunnerState } from "./my-runner.js";

/** What the runner says about the computer it runs on (newer runners report more; anything missing is left out). */
export interface MachineFacts {
    system: string | null;
    arch: string | null;
    memory: string | null;
    cpus: number | null;
    agentVersion: string | null;
    playwright: string | null;
    node: string | null;
}

type Loose = object | undefined | null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** "16 GB", from a byte count. */
export function memoryWords(bytes: number | null): string | null {
    if (!bytes) return null;
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${Math.round(gb)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

const OS_WORDS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/**
 * The computer's facts: from the runner's `machine` summary when the server sends one, else from the agent's own report (its capabilities
 * carry `osVersion`, `memoryMb`, `cpus` and `playwrightVersion` from newer runners). Anything not reported is left out, never guessed.
 */
export function machineFacts(agent: Loose, machine?: Loose): MachineFacts {
    const a = (agent ?? {}) as Record<string, unknown>;
    const m = (machine ?? {}) as Record<string, unknown>;
    const c = (a.capabilities ?? {}) as Record<string, unknown>;
    const os = str(m.os) ?? str(a.os);
    const version = str(m.osVersion) ?? str(a.osVersion) ?? str(c.osVersion);
    const mb = num(m.memoryMb) ?? num(c.memoryMb);
    return {
        system: os ? `${OS_WORDS[os] ?? os}${version ? ` ${version}` : ""}` : null,
        arch: str(m.arch) ?? str(a.arch),
        memory: memoryWords(mb ? mb * 1024 ** 2 : null),
        cpus: num(m.cpus) ?? num(c.cpus),
        agentVersion: str(m.agentVersion) ?? str(a.version),
        playwright: str(m.playwrightVersion) ?? str(c.playwrightVersion),
        node: str(a.node)?.replace(/^v/, "") ?? null,
    };
}

/** How to bring an offline runner back, for the system it last ran on (the background start at sign-in is the installer's; docs/features/runner-installer.md). */
export function offlineSteps(os: "win32" | "darwin" | "linux" | null | undefined): string[] {
    if (os === "win32") {
        return [
            "Sign in to that computer. A runner set up with the installer starts by itself when you sign in, and shows an icon in the notification area next to the clock. A locked screen is fine.",
            "If the icon is there, open it and choose Start. If it is not, open AI Testing Runner from the Start menu, or run AITestingRunnerSetup.exe again and choose Install and start.",
            "If you started it with start-runner.cmd, double-click it again and leave the window open.",
        ];
    }
    if (os === "darwin") {
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
    offline: { label: "Offline", tone: "neutral", tip: "Not connected. Nothing heard from it for 45 seconds. Runs you start wait a short while for it, then fail." },
    "not-connected": { label: "Not connected yet", tone: "warning", tip: "Set up, but it has not connected yet." },
    retired: { label: "Removed", tone: "neutral", tip: "It can no longer connect." },
};
