/** Types, wording and data hooks for the test recorder (the API shapes are fixed in .scratch/briefs/RECORDER-API-SHAPES.md). */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";
import type { Agent } from "../agents/agents";

export interface RecLocator {
    strategy: "testId" | "role" | "label" | "placeholder" | "text" | "css";
    value: string;
    name?: string;
    exact?: boolean;
}
export interface RecAlternative {
    locator: RecLocator;
    matches: number;
}
export type AssertCheck = "visible" | "hidden" | "text" | "value" | "enabled" | "disabled" | "count";
export interface RecAssert {
    check: AssertCheck;
    expected?: string | number;
}
export type StepKind = "goto" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "assert";
export interface RecStep {
    index: number;
    kind: StepKind;
    url?: string;
    locator?: RecLocator;
    alternatives?: RecAlternative[];
    matches?: number;
    value?: string;
    secret?: boolean;
    assert?: RecAssert;
    /** Name of the shared element this step uses, once it was made shared (the locator stays for display). */
    ref?: string;
    describe: string;
    at: string;
}
export interface Picked {
    locator: RecLocator;
    alternatives: RecAlternative[];
    tag: string;
    text?: string;
    at: string;
}
export interface Recording {
    id: string;
    projectId: string;
    status: "starting" | "recording" | "stopped" | "failed" | "saved";
    startUrl: string;
    currentUrl?: string;
    headed: boolean;
    environment?: string;
    steps: RecStep[];
    inspect: { on: boolean; mode: "locator" | "assertion"; assertCheck?: unknown };
    picked?: Picked;
    startedAt: string;
    stoppedAt?: string;
    /** A plain sentence about why the session ended, or what went wrong. */
    error?: string;
    savedTestId?: string;
    canSave: boolean;
    /** Plain notes from the recorder, such as a locator it had to choose carefully. */
    notes?: string[];
    /** Where the browser runs. Absent on a platform that predates recording on an agent: treated as this server. */
    runner?: { kind: "platform" } | { kind: "agent"; agentId: string; name: string };
    /** Commands (inspect on or off) the agent has not applied yet. */
    pendingCommands?: number;
}

/** A runner agent as the recorder needs it: the Runners tab's agent plus the two recording capabilities. */
export type RecorderAgent = Omit<Agent, "capabilities"> & { capabilities: Agent["capabilities"] & { record?: boolean; recordHeaded?: boolean } };

/** Why an agent cannot be picked to record right now, in words, or undefined when it can. */
export function agentRecordProblem(a: RecorderAgent, headed: boolean): string | undefined {
    if (!a.online) return "Offline";
    if (a.capabilities.record !== true) return "Can’t record";
    if (headed && a.capabilities.recordHeaded === false) return "No display, so it can’t show the window";
    return undefined;
}

/** The agent a recording runs on, or undefined when it runs on this server. */
export const agentOf = (r: Recording | undefined) => (r?.runner?.kind === "agent" ? r.runner : undefined);

/** The id of the session already running, when the 409 answer names it. */
export function activeSessionId(e: ApiError): string | undefined {
    const b = e.body;
    const rec = b.recording as { id?: unknown } | undefined;
    const details = b.details as { recordingId?: unknown } | undefined;
    for (const v of [b.recordingId, details?.recordingId, b.id, b.activeRecordingId, b.sessionId, rec?.id]) if (typeof v === "string" && v) return v;
    return undefined;
}

const SESSION_KEY = (projectId: string) => `recorder-session:${projectId}`;
/** Remembered per browser tab so "Resume watching" still works when the 409 answer does not name the session. */
export const rememberSession = (projectId: string, id: string | null) => {
    try {
        if (id) sessionStorage.setItem(SESSION_KEY(projectId), id);
        else sessionStorage.removeItem(SESSION_KEY(projectId));
    } catch {
        /* storage may be unavailable */
    }
};
export const rememberedSession = (projectId: string): string | undefined => {
    try {
        return sessionStorage.getItem(SESSION_KEY(projectId)) ?? undefined;
    } catch {
        return undefined;
    }
};

// ── wording ────────────────────────────────────────────────────────────────

const ROLE_WORD: Record<string, string> = { button: "Button", link: "Link", textbox: "Text box", checkbox: "Checkbox", radio: "Radio button", combobox: "Drop-down", heading: "Heading", tab: "Tab", menuitem: "Menu item", searchbox: "Search box", dialog: "Dialog", img: "Image", listitem: "List item", option: "Option" };

/** A locator in the words a person would use, for example: Button named “Add to cart”. */
export function locatorWords(l: RecLocator): string {
    switch (l.strategy) {
        case "role": {
            const role = ROLE_WORD[l.value] ?? `${l.value.charAt(0).toUpperCase()}${l.value.slice(1)}`;
            return l.name ? `${role} named “${l.name}”` : role;
        }
        case "testId":
            return `Test id “${l.value}”`;
        case "label":
            return `Field labelled “${l.value}”`;
        case "placeholder":
            return `Field with placeholder “${l.value}”`;
        case "text":
            return `Text “${l.value}”`;
        case "css":
            return `CSS selector ${l.value}`;
    }
}

export const matchWords = (n: number | undefined): string => (n === undefined ? "" : n === 1 ? "unique" : n === 0 ? "no match on this page now" : `${n} matches`);

/** "Button named “Add to cart”, unique" */
export const candidateWords = (l: RecLocator, matches: number | undefined): string => {
    const m = matchWords(matches);
    return m ? `${locatorWords(l)}, ${m}` : locatorWords(l);
};

/** Candidates for a picked element: the best one first, then the others, without repeats. */
export function pickedCandidates(p: Picked): RecAlternative[] {
    const seen = new Set<string>();
    const out: RecAlternative[] = [];
    const first = p.alternatives.find((a) => sameLocator(a.locator, p.locator));
    for (const c of [{ locator: p.locator, matches: first?.matches ?? p.alternatives[0]?.matches ?? 1 }, ...p.alternatives]) {
        const k = JSON.stringify([c.locator.strategy, c.locator.value, c.locator.name ?? null]);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(c);
        }
    }
    return out;
}

export const sameLocator = (a: RecLocator, b: RecLocator): boolean => a.strategy === b.strategy && a.value === b.value && (a.name ?? null) === (b.name ?? null);

export const CHECKS: Array<{ id: Exclude<AssertCheck, "count">; label: string }> = [
    { id: "visible", label: "Is visible" },
    { id: "hidden", label: "Is hidden" },
    { id: "text", label: "Has this text" },
    { id: "value", label: "Has this value" },
    { id: "enabled", label: "Is enabled" },
    { id: "disabled", label: "Is disabled" },
];

export const STATUS_WORD: Record<Recording["status"], string> = {
    starting: "Starting the browser",
    recording: "Recording",
    stopped: "Stopped",
    failed: "Failed",
    saved: "Saved",
};

/** 83 seconds becomes 1:23. */
export function clock(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// ── data ───────────────────────────────────────────────────────────────────

const POLL_MS = 1000;

export interface Session {
    rec: Recording | undefined;
    error: ApiError | undefined;
    loading: boolean;
    /** Put in an answer a change returned (it is newer than any poll that was already on its way). */
    apply: (r: Recording) => void;
    reload: () => Promise<void>;
}

/**
 * Follow a recording session: fetch it once, then every second while it is starting or recording. Polling pauses while
 * the tab is hidden and refreshes at once when it is shown again.
 */
export function useSession(rid: string | null): Session {
    const [state, setState] = useState<{ rec?: Recording; error?: ApiError; loading: boolean }>({ loading: rid !== null });
    const seq = useRef(0);
    const runRef = useRef<() => Promise<void>>();
    const statusRef = useRef<Recording["status"]>();

    useEffect(() => {
        if (!rid) {
            setState({ loading: false });
            return;
        }
        setState({ loading: true });
        statusRef.current = undefined;
        let cancelled = false;
        let timer: number | undefined;
        const run = async () => {
            clearTimeout(timer);
            const mine = seq.current;
            try {
                const next = await api<Recording>(`/recordings/${rid}`);
                if (cancelled) return;
                if (seq.current === mine) {
                    statusRef.current = next.status;
                    setState({ rec: next, loading: false });
                }
            } catch (e) {
                if (cancelled) return;
                const err = e instanceof ApiError ? e : new ApiError(0, describeApiError(e));
                setState((s) => (s.rec ? s : { error: err, loading: false }));
                // A missing session never comes back; anything else may be a hiccup, keep trying.
                if (err.status === 404) return;
            }
            const live = statusRef.current;
            if (live && live !== "starting" && live !== "recording") return;
            timer = window.setTimeout(() => void tick(), POLL_MS);
        };
        const tick = async () => {
            if (document.hidden) {
                timer = window.setTimeout(() => void tick(), POLL_MS);
                return;
            }
            await run();
        };
        const visible = () => {
            if (!document.hidden) void run();
        };
        runRef.current = run;
        document.addEventListener("visibilitychange", visible);
        void run();
        return () => {
            cancelled = true;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", visible);
            runRef.current = undefined;
        };
    }, [rid]);

    const apply = useCallback((r: Recording) => {
        seq.current += 1;
        statusRef.current = r.status;
        setState({ rec: r, loading: false });
    }, []);
    const reload = useCallback(async () => {
        await runRef.current?.();
    }, []);
    return { rec: state.rec, error: state.error, loading: state.loading, apply, reload };
}
