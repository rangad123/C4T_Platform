/**
 * Recording sessions of the platform. A session is driven by one of two drivers behind the same interface:
 *  - the LOCAL driver (here): the platform launches its own Chromium through the shared recorder core (src/engine/recorder/session.ts), headed by
 *    default so a person can click in it;
 *  - the REMOTE driver (recorder-remote.ts): a runner agent opens the browser on the tester's machine and pushes the state here.
 * State is in memory on purpose: a session is interactive and short, and a platform restart ends it. A local browser is always closed (stop, discard,
 * timeout, crash, closed window, shutdown) and only ever the one this service started: its process id is kept and checked.
 */
import { randomUUID } from "node:crypto";
import type { Browser } from "playwright";
import type { RecAlternative, RecAssert, RecAssertCheck, RecLocator, RecStep } from "../engine/recorder/model.js";
import type { LiveAction, LiveSnapshot } from "../engine/recorder/act.js";
import { browserInstalled, DEFAULT_CAPS, DEFAULT_RECORDINGS_MAX, hasDisplay, NAVIGATION_CREDIT_MS, pidAlive, RecorderError, RecorderSession, type ActOutcome, type StepPatch } from "../engine/recorder/session.js";
import { HttpError } from "./http-error.js";
import { assertAllowedTarget } from "./net-guard.js";

// The browser helpers and caps live in the core; they are re-exported because callers (and tests) have always imported them from here.
export { browserInstalled, DEFAULT_CAPS, hasDisplay, NAVIGATION_CREDIT_MS, pidAlive };

export type RecordingRunner = { kind: "platform" } | { kind: "agent"; agentId: string; name: string };

export interface Recording {
    id: string;
    projectId: string;
    status: "starting" | "recording" | "stopped" | "failed" | "saved";
    startUrl: string;
    currentUrl?: string;
    headed: boolean;
    environment?: string;
    steps: RecStep[];
    inspect: { on: boolean; mode: "locator" | "assertion"; assertCheck?: RecAssertCheck };
    picked?: { locator: RecLocator; alternatives: RecAlternative[]; tag: string; text?: string; at: string };
    startedAt: string;
    stoppedAt?: string;
    error?: string;
    savedTestId?: string;
    canSave: boolean;
    /** Things the recorder saw and could not record (a popup, an upload, a frame...). Plain sentences. */
    notes: string[];
    /** Where the browser runs: on the platform's machine, or on a runner agent's. */
    runner?: RecordingRunner;
    /** Recording on an agent only: commands from the page that the agent has not confirmed yet (the next push shows their result). */
    pendingCommands?: number;
}

export interface RecorderOptions {
    /** Address guard for the start page and every page the browser moves to (default: the platform's `assertAllowedTarget`). */
    guard?: (url: string) => Promise<void>;
    caps?: Partial<{ idleMs: number; totalMs: number; maxSteps: number }>;
    /** Recordings with a browser on this machine at once, in all projects (RECORDINGS_MAX, default 2). */
    maxLocal?: number;
    /** Every raw message the page sent, before anything is done with it. Used by tests to prove what never leaves the page. */
    tap?: (message: unknown) => void;
    /** Overrides the browser launch (tests may pass their own). */
    launch?: (headless: boolean) => Promise<Browser>;
    /** Recording on a runner agent: tests shorten the waits here (the clock is the agent service's own). */
    remote?: { lostContactMs?: number; claimWaitMs?: number; settleMs?: number; liveWaitMs?: number };
}

/** What the service needs of a recording, whichever machine its browser runs on. */
export interface RecorderDriver {
    readonly id: string;
    readonly projectId: string;
    snapshot(): Recording;
    setInspect(o: { on: boolean; mode?: "locator" | "assertion"; check?: RecAssertCheck }): Promise<void>;
    patchStep(index: number, patch: StepPatch): Promise<void>;
    deleteStep(index: number): void;
    setRef(index: number, name: string): void;
    step(index: number): RecStep;
    stop(): Promise<void>;
    discard(): Promise<void>;
    markSaved(testId: string): void;
    /** Driving the page step by step (src/engine/recorder/act.ts). `secret` is the value of a stand-in the caller resolved; it is typed and never returned. */
    act(action: LiveAction, o: { secret?: string; origins?: string[]; image?: boolean }): Promise<ActOutcome>;
    liveSnapshot(o: { image?: boolean }): Promise<LiveSnapshot>;
    /** Resolves when a stop has taken effect (the browser is gone, or the agent confirmed). The local driver's stop already waits for that. */
    settled(maxMs: number): Promise<void>;
    /** Local browser process id (diagnostics and tests); a remote recording has none on this machine. */
    pid(): number | undefined;
    /** Platform shutdown: end whatever this driver started. */
    dispose(): Promise<void>;
}

const MIN = 60_000;
const KEEP_FINISHED_PER_PROJECT = 10;
const KEEP_FINISHED_MS = 6 * 60 * MIN;
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** The core's plain refusals become the platform's HTTP errors. */
function translate<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e) {
        if (e instanceof RecorderError) throw new HttpError(e.status, e.message);
        throw e;
    }
}
async function translateAsync<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        if (e instanceof RecorderError) throw new HttpError(e.status, e.message);
        throw e;
    }
}

/** The platform opens the browser itself (the recorder core runs in this process). */
class LocalDriver implements RecorderDriver {
    private saved?: { testId: string; at: string };

    constructor(
        readonly id: string,
        readonly projectId: string,
        private readonly environment: string | undefined,
        private readonly session: RecorderSession,
    ) {}

    snapshot(): Recording {
        const st = this.session.state();
        const canSave = !this.saved && this.session.canSave();
        const { status, ...rest } = st;
        return {
            id: this.id,
            projectId: this.projectId,
            ...rest,
            status: this.saved ? "saved" : status,
            ...(this.environment ? { environment: this.environment } : {}),
            ...(this.saved ? { savedTestId: this.saved.testId, stoppedAt: st.stoppedAt ?? this.saved.at } : {}),
            canSave,
            runner: { kind: "platform" },
        };
    }

    private editable(): void {
        if (this.saved) throw new HttpError(409, "This recording is already saved as a test. Edit the test instead.");
    }

    setInspect(o: { on: boolean; mode?: "locator" | "assertion"; check?: RecAssertCheck }): Promise<void> {
        return translateAsync(() => this.session.setInspect(o));
    }
    patchStep(index: number, patch: StepPatch): Promise<void> {
        this.editable();
        return translateAsync(() => this.session.patchStep(index, patch));
    }
    deleteStep(index: number): void {
        this.editable();
        translate(() => this.session.deleteStep(index));
    }
    setRef(index: number, name: string): void {
        this.editable();
        translate(() => this.session.setRef(index, name));
    }
    step(index: number): RecStep {
        return translate(() => this.session.step(index));
    }
    stop(): Promise<void> {
        return this.session.stop();
    }
    discard(): Promise<void> {
        return this.session.discard();
    }
    markSaved(testId: string): void {
        this.saved = { testId, at: new Date().toISOString() };
    }
    act(action: LiveAction, o: { secret?: string; origins?: string[]; image?: boolean }): Promise<ActOutcome> {
        this.editable();
        return translateAsync(() => this.session.act(action, o));
    }
    liveSnapshot(o: { image?: boolean }): Promise<LiveSnapshot> {
        return translateAsync(() => this.session.snapshot(o));
    }
    settled(): Promise<void> {
        return this.session.ended;
    }
    pid(): number | undefined {
        return this.session.pid;
    }
    async dispose(): Promise<void> {
        await this.session.discard().catch(() => undefined);
    }
}

export class RecorderService {
    private drivers = new Map<string, RecorderDriver>();
    private readonly guard: (url: string) => Promise<void>;
    private readonly caps: { idleMs: number; totalMs: number; maxSteps: number };

    constructor(private readonly opts: RecorderOptions = {}) {
        this.guard = opts.guard ?? assertAllowedTarget;
        this.caps = { ...DEFAULT_CAPS, ...opts.caps };
    }

    /** The address guard, for the route to check an address before a session exists. */
    guardUrl(url: string): Promise<void> {
        return this.guard(url);
    }

    // ── queries ───────────────────────────────────────────────────────────────
    activeFor(projectId: string): Recording | undefined {
        for (const d of this.drivers.values()) {
            if (d.projectId !== projectId) continue;
            const r = d.snapshot();
            if (r.status === "starting" || r.status === "recording") return r;
        }
        return undefined;
    }

    /** The recording, or a plain "failed" stand-in for an id that looks valid but is gone (the platform restarted). */
    get(id: string): Recording | undefined {
        const d = this.drivers.get(id);
        if (d) return d.snapshot();
        if (!isUuid(id)) return undefined;
        return {
            id, projectId: "", status: "failed", startUrl: "", headed: false, steps: [], inspect: { on: false, mode: "locator" }, startedAt: new Date(0).toISOString(), canSave: false, notes: [],
            error: "This recording is gone: the platform was restarted or the recording was removed. Start a new one.",
        };
    }

    /** The recording's session id of the browser process (for diagnostics and tests that check no browser is left behind). */
    pidOf(id: string): number | undefined {
        return this.drivers.get(id)?.pid();
    }

    private driver(id: string): RecorderDriver {
        const d = this.drivers.get(id);
        if (!d) throw new HttpError(404, "Recording not found. It may have been discarded or the platform was restarted.");
        return d;
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    private assertNoneActive(projectId: string): void {
        const active = this.activeFor(projectId);
        // Name the running session so a page that did not start it (another tab) can offer to watch it.
        if (active) throw new HttpError(409, "This project already has a recording in progress. Stop or discard it first.", { recordingId: active.id });
        this.sweep();
    }

    /** Recordings with a browser on this machine right now: a recording on a runner agent uses the agent's. */
    private localActive(): number {
        return [...this.drivers.values()].filter((d) => {
            const r = d.snapshot();
            return r.runner?.kind !== "agent" && (r.status === "starting" || r.status === "recording");
        }).length;
    }

    start(projectId: string, o: { url: string; headed: boolean; environment?: string }): Recording {
        this.assertNoneActive(projectId);
        const max = this.opts.maxLocal ?? DEFAULT_RECORDINGS_MAX;
        if (this.localActive() >= max) throw new HttpError(429, `This server is already running ${max === 1 ? "a recording" : `${max} recordings`}, its limit. Wait for one to end, or record on a runner agent.`);
        const session = new RecorderSession({
            startUrl: o.url,
            headed: o.headed,
            guard: this.guard,
            caps: this.caps,
            ...(this.opts.tap ? { tap: this.opts.tap } : {}),
            ...(this.opts.launch ? { launch: this.opts.launch } : {}),
        });
        const d = new LocalDriver(randomUUID(), projectId, o.environment, session);
        this.drivers.set(d.id, d);
        session.start();
        return d.snapshot();
    }

    /** A driver built elsewhere (the remote driver) joins the service: the same routes serve it. One recording per project holds for both. */
    register(projectId: string, make: () => RecorderDriver): Recording {
        this.assertNoneActive(projectId);
        const d = make();
        this.drivers.set(d.id, d);
        return d.snapshot();
    }

    async stop(id: string): Promise<Recording> {
        const d = this.driver(id);
        await d.stop();
        return d.snapshot();
    }

    /** After a stop: waits (bounded) until it has taken effect. A local stop already has; an agent confirms with its next push. */
    async settle(id: string, maxMs: number): Promise<Recording> {
        const d = this.driver(id);
        await d.settled(maxMs);
        return d.snapshot();
    }

    async discard(id: string): Promise<void> {
        const d = this.driver(id);
        await d.discard();
        this.drivers.delete(id);
    }

    /** Ends every recording this service has (platform shutdown): local browsers are closed, an agent is told to stop. */
    async closeAll(): Promise<void> {
        const all = [...this.drivers.values()];
        await Promise.all(all.map((d) => d.dispose().catch(() => undefined)));
        this.drivers.clear();
    }

    markSaved(id: string, testId: string): void {
        this.driver(id).markSaved(testId);
    }

    /** Sessions that ended long ago, and more than a few finished ones per project, are forgotten. */
    private sweep(): void {
        const now = Date.now();
        const finished = [...this.drivers.values()].map((d) => d.snapshot()).filter((r) => r.status === "stopped" || r.status === "failed" || r.status === "saved");
        for (const r of finished) if (now - Date.parse(r.stoppedAt ?? r.startedAt) > KEEP_FINISHED_MS) this.drivers.delete(r.id);
        const byProject = new Map<string, Recording[]>();
        for (const r of finished) if (this.drivers.has(r.id)) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
        for (const list of byProject.values()) {
            list.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
            for (const r of list.slice(KEEP_FINISHED_PER_PROJECT)) this.drivers.delete(r.id);
        }
    }

    // ── what the person (or the web page) does through the API ──────────────────
    async setInspect(id: string, o: { on: boolean; mode?: "locator" | "assertion"; check?: RecAssertCheck }): Promise<Recording> {
        const d = this.driver(id);
        await d.setInspect(o);
        return d.snapshot();
    }

    async patchStep(id: string, index: number, patch: { locator?: RecLocator; value?: string; assert?: RecAssert }): Promise<Recording> {
        const d = this.driver(id);
        await d.patchStep(index, patch);
        return d.snapshot();
    }

    deleteStep(id: string, index: number): Recording {
        const d = this.driver(id);
        d.deleteStep(index);
        return d.snapshot();
    }

    /** Marks a step as using a shared element of the object repository (the caller created or found the element). */
    setRef(id: string, index: number, name: string): Recording {
        const d = this.driver(id);
        d.setRef(index, name);
        return d.snapshot();
    }

    step(id: string, index: number): RecStep {
        return this.driver(id).step(index);
    }

    /** Driving the page step by step. */
    act(id: string, action: LiveAction, o: { secret?: string; origins?: string[]; image?: boolean } = {}): Promise<ActOutcome> {
        return this.driver(id).act(action, o);
    }

    liveSnapshot(id: string, o: { image?: boolean } = {}): Promise<LiveSnapshot> {
        return this.driver(id).liveSnapshot(o);
    }
}
