import type { Agent } from "../agents/agents.js";
import type { Tone } from "../../lib/labels.js";

/** One machine, as GET /api/runners answers it (src/platform/runner-health.ts). */
export type RunnerStatus = "online" | "busy" | "offline" | "not-connected" | "retired";

/** A team runner serves the projects it is given; a personal runner is one person's own computer and takes only the runs that person starts. */
export type RunnerKind = "personal" | "team";

export interface Runner {
    id: string;
    name: string;
    /** Absent from a server before personal runners: then every runner is a team runner. */
    kind?: RunnerKind;
    /** A personal runner of the person looking. */
    mine?: boolean;
    ownerId?: string | null;
    machineName: string | null;
    hint: string;
    organizationId: string | null;
    ownerName: string;
    status: RunnerStatus;
    canManage: boolean;
    /**
     * What it may run (src/platform/runner-health.ts): code scripts and private addresses, and whether each is a switch someone can change here
     * (a shared Crowd4Test runner has no code scripts switch; a team runner no private addresses switch). Absent from an older server: not shown.
     */
    settings?: { codeScripts: boolean; codeScriptsSwitch: boolean; privateAddresses: boolean; privateAddressesSwitch: boolean; realPhone?: boolean; realPhoneSwitch?: boolean };
    /** The computer as its runner last described it (newer runners report more). */
    machine?: { os: string; osVersion?: string | null; arch: string; memoryMb?: number | null; cpus?: number | null; playwrightVersion?: string | null; agentVersion?: string | null; bound?: boolean } | null;
    createdAt: string;
    retiredAt: string | null;
    lastSeenAt: string | null;
    version: string | null;
    agent: Agent | null;
    devices: Array<{ family: "android" | "ios"; key: string; name: string; state: string; emulator: boolean; heldBy: { projectName: string | null; sinceAt: string | null } | null }>;
    /** `jobId` links the work to its run, when the person may open that project. */
    currentTasks: Array<{ kind: string; projectId: string | null; projectName: string | null; jobId?: string | null; startedAt: string | null; done: number | null; total: number | null }>;
    queue: { waiting: number; oldestWaitMs: number; averageWaitMs: number | null };
    recentFailures: { count: number; items: Array<{ at: string | null; kind: string; projectName: string | null; error: string | null }> };
    projects: Array<{ id: string; name: string; grantedBy: string | null; grantedAt: string }>;
    otherProjects: number;
}

export interface RunnersAnswer {
    runners: Runner[];
    /** May add a team runner (an older server says only this). */
    canRegister: boolean;
    canRegisterShared: boolean;
    owners: Array<{ id: string; name: string | null }>;
    /** May add their own computer: anyone who may run tests in some project. */
    canAddPersonal?: boolean;
    /** May add a runner for a team (manage runners, in an organisation they manage). */
    canAddTeam?: boolean;
    /** Their own computers: how many, the most allowed, and why they may not add one (at the cap, or no permission to run tests). */
    personal?: { count: number; max: number; reason?: string };
}

/** What the person may add, from the server's answer (an older server has only `canRegister`). */
export const mayAdd = (a: Pick<RunnersAnswer, "canRegister" | "canAddPersonal" | "canAddTeam">) => ({ personal: a.canAddPersonal === true, team: a.canAddTeam ?? a.canRegister });

/** Where "Add this computer" opens: the Runners page with the panel already open (other pages link here). */
export const ADD_COMPUTER_HREF = "#/runners?add=computer";

/** Personal runners one person may have at once (the server refuses more with a sentence). */
export const PERSONAL_CAP = 5;

export const kindOf = (r: Pick<Runner, "kind">): RunnerKind => r.kind ?? "team";

/** "Yours", "Ana's computer" or "Team runner": the short word on a row and at the top of a runner's page. */
export function whose(r: Pick<Runner, "kind" | "mine" | "ownerName">): { label: string; tip: string } {
    if (kindOf(r) === "team") return { label: "Team", tip: "A team runner: it runs the tests of the projects it is given, for everyone in them." };
    if (r.mine) return { label: "Yours", tip: "Your own computer: it runs only the tests you start, in projects that allow people's own computers." };
    return { label: "Personal", tip: `${r.ownerName}'s own computer: it runs only the tests they start.` };
}

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

export interface RunnerSummary {
    total: number;
    online: number;
    busy: number;
    offline: number;
    browsers: string[];
    phones: number;
    simulators: number;
    waiting: number;
    oldestWaitMs: number;
    averageWaitMs: number | null;
    recentFailures: number;
}

export interface RunnerAccess {
    runners: Runner[];
    available: Array<{ id: string; name: string; ownerName: string }>;
    canManage: boolean;
}

export const STATUS_WORDS: Record<RunnerStatus, { label: string; tone: Tone; tip: string }> = {
    online: { label: "Online", tone: "success", tip: "Connected and ready for work." },
    busy: { label: "Busy", tone: "info", tip: "Connected and running tests now." },
    offline: { label: "Offline", tone: "neutral", tip: "Not connected. Nothing heard from it for 45 seconds. A run that needs it fails after a short wait unless another runner may take it." },
    "not-connected": { label: "Not connected yet", tone: "warning", tip: "Added, but it has not connected yet." },
    retired: { label: "Retired", tone: "neutral", tip: "It can no longer connect. It stays here for the record." },
};
