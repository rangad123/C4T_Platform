import type { Agent } from "../agents/agents";
import type { Tone } from "../../lib/labels";

/** One machine, as GET /api/runners answers it (src/platform/runner-health.ts). */
export type RunnerStatus = "online" | "busy" | "offline" | "not-connected" | "retired";

export interface Runner {
    id: string;
    name: string;
    machineName: string | null;
    hint: string;
    organizationId: string | null;
    ownerName: string;
    status: RunnerStatus;
    canManage: boolean;
    createdAt: string;
    retiredAt: string | null;
    lastSeenAt: string | null;
    version: string | null;
    agent: Agent | null;
    devices: Array<{ family: "android" | "ios"; key: string; name: string; state: string; emulator: boolean; heldBy: { projectName: string | null; sinceAt: string | null } | null }>;
    currentTasks: Array<{ kind: string; projectId: string | null; projectName: string | null; startedAt: string | null; done: number | null; total: number | null }>;
    queue: { waiting: number; oldestWaitMs: number; averageWaitMs: number | null };
    recentFailures: { count: number; items: Array<{ at: string | null; kind: string; projectName: string | null; error: string | null }> };
    projects: Array<{ id: string; name: string; grantedBy: string | null; grantedAt: string }>;
    otherProjects: number;
}

export interface RunnersAnswer {
    runners: Runner[];
    canRegister: boolean;
    canRegisterShared: boolean;
    owners: Array<{ id: string; name: string | null }>;
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
    offline: { label: "Offline", tone: "neutral", tip: "Not connected. Tests wait for another runner, or fail after 30 minutes." },
    "not-connected": { label: "Not connected yet", tone: "warning", tip: "Registered, but nobody has started it with its token." },
    retired: { label: "Retired", tone: "neutral", tip: "Its token no longer works. It stays here for the record." },
};
