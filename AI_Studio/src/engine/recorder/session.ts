/**
 * The recorder core: one recording session in one Chromium that THIS process launched. It installs the recorder script in every page, turns what the
 * page reports into steps, ranks locators with match counts, handles inspect/assertion mode, applies the caps, and always closes the browser it
 * started (stop, discard, timeout, crash, closed window, shutdown), checking by process id that it is really gone.
 *
 * It has no dependency on the platform: it reports its state through `onChange` and is driven through plain methods. Two drivers use it:
 * the platform's local driver (src/platform/recorder-service.ts, the platform opens the window on its own machine) and the runner agent's record
 * task (src/agent/record-child.ts, the agent opens the window on the tester's machine and pushes this state to the platform).
 *
 * State is in memory on purpose: a session is interactive and short.
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { Browser, BrowserContext, Frame, Locator as PwLocator, Page } from "playwright";
import { cleanLine, decideFill, HIDDEN, imageFits, LIVE_LIMITS, secretKindOfField, shapeSnapshot, stepsGained, credentialSlotOf, type CredentialSlot, type LiveAction, type LiveSnapshot, type RawSnapshot } from "./act.js";
import { describeRecStep } from "./describe.js";
import { hasSavableSteps, pushStep, reindex, type NewStep } from "./normalise.js";
import {
    clip, isSecretKind, REC_ASSERT_CHECKS, REC_LIMITS, REC_STRATEGIES, SECRET_PLACEHOLDERS, locatorKey,
    type RecAlternative, type RecAssert, type RecAssertCheck, type RecLocator, type RecStep, type RecStepKind, type SecretKind,
} from "./model.js";
import { recorderScript } from "./page-script.js";
import { describeFrame, testFileNameFrom } from "../web/pages.js";
import { MAX_FRAME_DEPTH } from "../spec/schema.js";
import { isPositionalCss, locatorLooksGenerated, parseCands, rankCandidates, shortText, type RawCandidate, type Ranked } from "./rank.js";

/**
 * Playwright's Chromium, loaded when it is first needed rather than when this file is: the runner program bundles this file and must start
 * without its test tools installed, so "node runner.mjs --check" can still say what is missing (docs/features/runner-check.md).
 */
const chromium = (): typeof import("playwright").chromium => (createRequire(import.meta.url)("playwright") as typeof import("playwright")).chromium;

/** What one driven action did: the step it became (if it did), and the page afterwards. */
export interface ActOutcome {
    recorded: boolean;
    step?: RecStep;
    note?: string;
    snapshot: LiveSnapshot;
}

/** The first line of a browser error, without its call log. */
function actionFailure(e: unknown): string {
    const line = (e instanceof Error ? e.message : String(e)).split("\n").find((l) => l.trim() && !/^\s*(-|=|Call log)/.test(l)) ?? "the page did not allow it";
    return cleanLine(line.replace(/^[\w.]+:\s*/, ""), 200);
}

/** An error with an HTTP-like status and a plain message. A driver turns it into whatever its transport needs. */
export class RecorderError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export type SessionStatus = "starting" | "recording" | "stopped" | "failed";

export interface RecPicked {
    locator: RecLocator;
    alternatives: RecAlternative[];
    tag: string;
    text?: string;
    at: string;
}

/** Everything a person (or a page of the platform) sees of a session. */
export interface RecState {
    status: SessionStatus;
    startUrl: string;
    currentUrl?: string;
    headed: boolean;
    steps: RecStep[];
    inspect: { on: boolean; mode: "locator" | "assertion"; assertCheck?: RecAssertCheck };
    picked?: RecPicked;
    startedAt: string;
    stoppedAt?: string;
    error?: string;
    /** Things the recorder saw and could not record (a popup, an upload, a frame...). Plain sentences. */
    notes: string[];
}

export interface SessionOptions {
    startUrl: string;
    headed: boolean;
    /**
     * Address guard for the start page and every page the browser moves to. Absent: no check at all (the caller already decided; the agent's own
     * network is the point). Redirects are followed one hop at a time through the guard when it is present.
     */
    guard?: (url: string) => Promise<void>;
    /**
     * With a guard: fetch every page navigation hop by hop through it (default). false: the guard checks the first address and where the page ends up, and the
     * browser fetches pages itself (the agent: the person's own network, with its proxies and single sign-on, must work as it does in their browser).
     */
    interceptRequests?: boolean;
    caps?: Partial<{ idleMs: number; totalMs: number; maxSteps: number }>;
    /** Every raw message the page sent, before anything is done with it. Used by tests to prove what never leaves the page. */
    tap?: (message: unknown) => void;
    /** Overrides the browser launch (tests may pass their own). */
    launch?: (headless: boolean) => Promise<Browser>;
    /** Called after every change of the state (a step, a note, the status, the inspect state...). Cheap: the driver decides how often to act on it. */
    onChange?: () => void;
}

interface Session {
    rec: Omit<RecState, "notes">;
    notes: string[];
    token: string;
    binding: string;
    ctl: string;
    browser?: Browser;
    context?: BrowserContext;
    page?: Page;
    /** The popup window (or new tab) the recorded page opened last; what happens in it is recorded as steps "in the popup". */
    popup?: Page;
    pid?: number;
    queue: Promise<void>;
    idleTimer?: NodeJS.Timeout;
    totalTimer?: NodeJS.Timeout;
    ending?: Promise<void>;
    /** Settles when the start page's first load is over (loaded, replaced or failed): a snapshot taken earlier would read the blank page. */
    firstLoad?: Promise<void>;
    cancelled: boolean;
    docCount: number;
    lastDocUrl?: string;
    /** Page time of the last thing the person did (a click, typing, a key); a page that starts soon after was caused by it. */
    lastActionTs: number;
    maxSteps: number;
    guardCache: Map<string, Promise<string | undefined>>;
    /** An action driven step by step is running (see `act`). */
    acting?: boolean;
    /**
     * Stand-ins typed by a tool and what was really typed. Kept for the whole session so that a step the page reports LATE (after the action has answered)
     * is still stored as its stand-in: a saved test never holds a typed value, however slowly the page reports it.
     */
    standIns?: Array<{ typed: string; slot: CredentialSlot }>;
    /** Locators of the fields a stand-in was typed into: their value is shown as hidden for the rest of the session (a field with a maxlength holds only a prefix, which no exact scrub finds). */
    typedKeys?: Set<string>;
}

const MIN = 60_000;
export const DEFAULT_CAPS = { idleMs: 20 * MIN, totalMs: 60 * MIN, maxSteps: REC_LIMITS.maxSteps };
/** Recordings whose browser runs on this server, across all projects (RECORDINGS_MAX). A shared server cannot hold more windows than this. */
export const DEFAULT_RECORDINGS_MAX = 2;
/** A page that starts within this time of something the person did (a click, a key) is taken as its result, not as a typed address. */
export const NAVIGATION_CREDIT_MS = 2_500;

/** Chromium process ids this feature started and that are still believed alive: a last-resort cleanup when the process exits. */
const livePids = new Set<number>();
let exitHookInstalled = false;
function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => {
        for (const pid of livePids) {
            try {
                process.kill(pid);
            } catch {
                /* already gone */
            }
        }
    });
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** A person can only watch a headed window on a machine with a screen. Windows and macOS always have one; Linux needs a display server. */
export function hasDisplay(): boolean {
    return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function browserInstalled(): boolean {
    try {
        return fs.existsSync(chromium().executablePath());
    } catch {
        return false;
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() => clearTimeout(timer));
}
const minutes = (ms: number) => (ms >= MIN ? `${Math.round(ms / MIN)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`);
const sameDoc = (a: string | undefined, b: string | undefined) => (a ?? "").split("#")[0] === (b ?? "").split("#")[0];

/** Where a page message came from: the frame (the main frame of the page or of the popup, or a frame inside one) and whether it is the popup. */
interface Origin {
    frame: Frame;
    inPopup: boolean;
}

/** Playwright's own locator for a candidate (the same semantics the generated script will use). */
function pwLocator(root: Page | Frame, c: { strategy: RecLocator["strategy"]; value: string; name?: string; exact?: boolean }): PwLocator {
    switch (c.strategy) {
        case "testId":
            return root.getByTestId(c.value);
        case "role":
            return root.getByRole(c.value as Parameters<Page["getByRole"]>[0], { ...(c.name ? { name: c.name } : {}), ...(c.exact ? { exact: true } : {}) });
        case "label":
            return root.getByLabel(c.value, { exact: c.exact });
        case "placeholder":
            return root.getByPlaceholder(c.value, { exact: c.exact });
        case "text":
            return root.getByText(c.value, { exact: c.exact });
        case "css":
            return root.locator(c.value);
    }
}

export interface StepPatch {
    locator?: RecLocator;
    value?: string;
    assert?: RecAssert;
}

/**
 * The rules of editing a step that need no page: the same answers whether the session runs here or on a runner agent (the platform checks a command before it
 * sends it, the agent checks again before it applies it). Throws a RecorderError; returns the step with the value and assertion changes applied (the locator
 * change needs the page, see `patchStep`).
 */
export function checkPatch(cur: RecStep, patch: StepPatch): RecStep {
    const step: RecStep = { ...cur };
    if (patch.locator && !cur.locator) throw new RecorderError(400, "This step has no element to give another locator.");
    if (patch.value !== undefined) {
        if (step.secret) throw new RecorderError(400, "This step types a secret: its value is a stand-in and can't be edited here. Delete the step to remove it.");
        if (step.kind !== "fill" && step.kind !== "select" && step.kind !== "press") throw new RecorderError(400, "Only a typed value, a choice or a key press has a value to edit.");
        if (step.kind === "press" && !["Enter", "Escape", "Tab"].includes(patch.value)) throw new RecorderError(400, "A key press can be Enter, Escape or Tab.");
        step.value = clip(patch.value, REC_LIMITS.maxValue);
    }
    if (patch.assert) {
        if (step.kind !== "assert") throw new RecorderError(400, "Only an assertion step has something to check.");
        if (!REC_ASSERT_CHECKS.includes(patch.assert.check)) throw new RecorderError(400, "Unknown check.");
        if ((patch.assert.check === "text" || patch.assert.check === "value") && (patch.assert.expected === undefined || String(patch.assert.expected) === "")) throw new RecorderError(400, "Say what the text or value should be.");
        if (patch.assert.check === "count" && !Number.isInteger(Number(patch.assert.expected))) throw new RecorderError(400, "A count is a whole number.");
        step.assert = {
            check: patch.assert.check,
            ...(patch.assert.expected !== undefined ? { expected: patch.assert.check === "count" ? Number(patch.assert.expected) : clip(String(patch.assert.expected), REC_LIMITS.maxAssertText) } : {}),
        };
    }
    return step;
}

/** The words of a step (a step that was edited gets its description rebuilt). */
export function describeStep(step: Pick<RecStep, "kind" | "url" | "locator" | "value" | "secret" | "assert"> & Partial<Pick<RecStep, "target" | "frame" | "inPopup" | "opensPopup">>, ranked?: Pick<Ranked, "positional" | "generated">, secretKind?: SecretKind): string {
    const l = step.locator;
    return describeRecStep(step, {
        positional: ranked ? ranked.positional : l ? isPositionalCss(l) : false,
        generated: ranked ? ranked.generated : l ? locatorLooksGenerated({ strategy: l.strategy, value: l.value, name: l.name }) : false,
        ...(secretKind ? { secretKind } : {}),
    });
}

export class RecorderSession {
    private readonly s: Session;
    private readonly caps: { idleMs: number; totalMs: number; maxSteps: number };
    private started = false;
    /** Increases on every change of the state: a driver that polls can tell whether anything happened. */
    rev = 0;

    constructor(private readonly opts: SessionOptions) {
        this.caps = { ...DEFAULT_CAPS, ...opts.caps };
        installExitHook();
        this.s = {
            rec: { status: "starting", startUrl: opts.startUrl, headed: opts.headed, steps: [], inspect: { on: false, mode: "locator" }, startedAt: new Date().toISOString() },
            notes: [], token: randomBytes(16).toString("hex"), binding: `__r${randomBytes(8).toString("hex")}`, ctl: `__c${randomBytes(8).toString("hex")}`,
            queue: Promise.resolve(), cancelled: false, docCount: 0, lastActionTs: 0, maxSteps: this.caps.maxSteps, guardCache: new Map(),
        };
    }

    private changed(): void {
        this.rev++;
        try {
            this.opts.onChange?.();
        } catch {
            /* a driver's callback must never break the session */
        }
    }

    // ── queries ───────────────────────────────────────────────────────────────
    get status(): SessionStatus {
        return this.s.rec.status;
    }

    /** The process id of the browser this session started (diagnostics, and tests that check nothing is left behind). */
    get pid(): number | undefined {
        return this.s.pid;
    }

    /** Resolves once the session has ended and its browser is gone (immediately if it has not been asked to end). */
    get ended(): Promise<void> {
        return this.s.ending ?? Promise.resolve();
    }

    state(): RecState {
        const r = this.s.rec;
        return { ...r, steps: r.steps.map((x) => ({ ...x })), inspect: { ...r.inspect }, notes: [...this.s.notes] };
    }

    /** Stopped or recording with at least one step that is not only a goto. */
    canSave(): boolean {
        return (this.s.rec.status === "stopped" || this.s.rec.status === "recording") && hasSavableSteps(this.s.rec.steps);
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────
    /** Starts the session in the background (the browser opens, the first page loads); progress is visible through `state()`. */
    start(): void {
        if (this.started) return;
        this.started = true;
        void this.boot();
    }

    private async boot(): Promise<void> {
        const s = this.s;
        try {
            // The first address is guarded before any browser exists.
            if (this.opts.guard) await this.opts.guard(s.rec.startUrl);
            if (s.cancelled) return;
            const browser = await (this.opts.launch ?? ((headless) => chromium().launch({ headless })))(!s.rec.headed);
            s.browser = browser;
            browser.on("disconnected", () => void this.finish("stopped", "The browser was closed."));
            try {
                const cdp = await browser.newBrowserCDPSession();
                const info = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: Array<{ type: string; id: number }> };
                s.pid = info.processInfo.find((p) => p.type === "browser")?.id;
                if (s.pid) livePids.add(s.pid);
                await cdp.detach().catch(() => undefined);
            } catch {
                /* the pid is a safety net only */
            }
            if (s.cancelled) return void (await this.closeBrowser());
            // A fresh context: no cookies, no storage, no extensions, no permissions granted.
            const context = await browser.newContext({ viewport: s.rec.headed ? null : { width: 1280, height: 800 }, acceptDownloads: false, serviceWorkers: "block", permissions: [] });
            s.context = context;
            await context.exposeBinding(s.binding, (source, payload) => this.onPageMessage(source as { page: Page; frame: Frame }, payload));
            await context.addInitScript(recorderScript({ binding: s.binding, ctl: s.ctl, token: s.token }));
            if (this.opts.guard && this.opts.interceptRequests !== false) await context.route("**/*", (route) => this.onRoute(route));
            context.on("page", (p) => void this.onNewPage(p));
            const page = await context.newPage();
            s.page = page;
            page.on("framenavigated", (f) => {
                if (f !== page.mainFrame()) return;
                s.rec.currentUrl = f.url();
                this.changed();
                // Backstop for the request check: wherever the page ended up (a redirect, a script) must be an allowed address too.
                void this.blockedReason(f.url()).then((reason) => {
                    if (!reason || s.rec.status !== "recording") return;
                    s.rec.error = this.blockedMessage(f.url(), reason);
                    void this.finish("stopped");
                });
            });
            page.on("close", () => void this.finish("stopped", "The recording window was closed."));
            page.on("crash", () => void this.finish("failed", "The browser crashed. The steps recorded so far are kept.", true));
            this.armTimers();
            this.addStep({ kind: "goto", url: s.rec.startUrl, describe: describeRecStep({ kind: "goto", url: s.rec.startUrl }), at: new Date().toISOString() });
            s.rec.status = "recording";
            this.changed();
            // A later main-frame navigation (the person clicked or typed an address, or the page moved itself by script) takes over from the start page:
            // the start page's aborted load is then not a failure of the recording; the later navigation is judged by itself (the guard above).
            let navigations = 0;
            page.on("request", (r) => {
                if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.redirectedFrom()) navigations++;
            });
            const first = page.goto(s.rec.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(async (e) => {
                // The browser reports the start page as aborted just before the request that replaced it: give that request a moment to show.
                if (s.rec.status === "recording" && /ERR_ABORTED|interrupted by another navigation/i.test(String(e))) {
                    for (let i = 0; i < 20 && navigations <= 1 && !s.ending; i++) await sleep(50);
                }
                if (s.rec.status === "recording" && navigations <= 1 && !s.ending) throw e;
            });
            s.firstLoad = first.then(
                () => undefined,
                () => undefined,
            );
            await first;
            s.rec.currentUrl = page.url();
            this.changed();
        } catch (e) {
            if (s.cancelled || s.rec.status === "stopped") return;
            const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
            // An error that carries a status is a plain refusal of the driver's own (the platform's address guard): its sentence is shown as it is.
            const plain = e instanceof Error && typeof (e as { status?: unknown }).status === "number" ? e.message : /Executable doesn't exist|browserType\.launch/i.test(why) ? "No browser is installed on this machine. Run: npx playwright install chromium" : `Could not open ${s.rec.startUrl}: ${clip(why, 160)}`;
            await this.finish("failed", plain);
        }
    }

    /** Ends the session: browser closed, status set. Steps are kept. Safe to call twice. */
    private finish(status: "stopped" | "failed", message?: string, isError = false): Promise<void> {
        const s = this.s;
        if (s.ending) return s.ending;
        s.ending = (async () => {
            if (status === "failed" || isError) s.rec.error = message;
            else if (message && message !== "The browser was closed." && message !== "The recording window was closed.") this.note(message);
            // The status changes only once the browser is gone: "stopped" means nothing of it is left running.
            await this.closeBrowser();
            s.rec.status = status;
            s.rec.stoppedAt = new Date().toISOString();
            s.rec.inspect = { ...s.rec.inspect, on: false };
            this.changed();
        })();
        return s.ending;
    }

    private async closeBrowser(): Promise<void> {
        const s = this.s;
        clearTimeout(s.idleTimer);
        clearTimeout(s.totalTimer);
        const b = s.browser;
        s.browser = undefined;
        if (b) await withTimeout(b.close(), 8_000).catch(() => undefined);
        if (s.pid) {
            // Only the process this session started, by its own id.
            for (let i = 0; i < 20 && pidAlive(s.pid); i++) {
                if (i === 5) {
                    try {
                        process.kill(s.pid);
                    } catch {
                        /* gone */
                    }
                }
                await sleep(100);
            }
            if (!pidAlive(s.pid)) livePids.delete(s.pid);
        }
        s.page = undefined;
        s.context = undefined;
    }

    async stop(): Promise<void> {
        const s = this.s;
        if (s.rec.status === "starting") s.cancelled = true;
        if (s.rec.status === "starting" || s.rec.status === "recording") {
            await s.queue.catch(() => undefined);
            await this.finish("stopped");
        } else await s.ending;
    }

    /** Ends the session without keeping anything of interest to the caller (the steps stay readable until the caller drops it). */
    async discard(): Promise<void> {
        this.s.cancelled = true;
        await this.finish("stopped").catch(() => undefined);
        await this.s.ending;
    }

    // ── timers ────────────────────────────────────────────────────────────────
    private armTimers(): void {
        const s = this.s;
        s.totalTimer = setTimeout(() => void this.finish("stopped", `Recording stopped after ${minutes(this.caps.totalMs)}, the longest a recording may run. Your steps are kept.`), this.caps.totalMs);
        s.totalTimer.unref?.();
        this.touch();
    }

    private touch(): void {
        const s = this.s;
        if (s.rec.status !== "recording" && s.rec.status !== "starting") return;
        clearTimeout(s.idleTimer);
        s.idleTimer = setTimeout(() => void this.finish("stopped", `Recording stopped after ${minutes(this.caps.idleMs)} without activity. Your steps are kept.`), this.caps.idleMs);
        s.idleTimer.unref?.();
    }

    private note(text: string): void {
        const s = this.s;
        if (s.notes.includes(text) || s.notes.length >= REC_LIMITS.maxNotes) return;
        s.notes.push(text);
        this.changed();
    }

    // ── address guard on every page the browser opens ──────────────────────────
    private blockedReason(url: string): Promise<string | undefined> {
        const guard = this.opts.guard;
        if (!guard) return Promise.resolve(undefined);
        let host: string;
        try {
            const u = new URL(url);
            if (!/^https?:$/.test(u.protocol)) return Promise.resolve(undefined);
            host = u.host;
        } catch {
            return Promise.resolve(undefined);
        }
        let p = this.s.guardCache.get(host);
        if (!p) {
            p = guard(url).then(
                () => undefined,
                (e) => (e instanceof Error ? e.message : String(e)),
            );
            this.s.guardCache.set(host, p);
        }
        return p;
    }

    private blockedMessage(url: string, reason: string): string {
        let host = url;
        try {
            host = new URL(url).host;
        } catch {
            /* keep the raw text */
        }
        return `The page moved to ${host}, an address this platform does not allow testing (${reason}). Recording stopped; the steps up to there are kept.`;
    }

    /**
     * Pages (navigation requests) are fetched one hop at a time, so that every redirect target is checked by the address guard BEFORE the browser connects
     * to it: the 3xx answer is handed to the browser, which follows it and comes back here with the next hop. Everything else (scripts, images, API calls
     * of the page) goes straight through.
     */
    private async onRoute(route: import("playwright").Route): Promise<void> {
        const s = this.s;
        const req = route.request();
        try {
            if (!req.isNavigationRequest()) return void (await route.continue());
            const stop = async (url: string, reason: string) => {
                await route.abort("blockedbyclient").catch(() => undefined);
                if (req.frame() === s.page?.mainFrame()) {
                    s.rec.error = this.blockedMessage(url, reason);
                    void this.finish("stopped");
                }
            };
            const reason = await this.blockedReason(req.url());
            if (reason) return void (await stop(req.url(), reason));
            let response;
            try {
                response = await route.fetch({ maxRedirects: 0 });
            } catch {
                return void (await route.continue().catch(() => undefined));
            }
            const location = response.headers()["location"];
            if (location && response.status() >= 300 && response.status() < 400) {
                let next: string | undefined;
                try {
                    next = new URL(location, req.url()).toString();
                } catch {
                    next = undefined;
                }
                const why = next ? await this.blockedReason(next) : undefined;
                if (next && why) return void (await stop(next, why));
            }
            await route.fulfill({ response });
        } catch {
            /* the page moved on or closed */
        }
    }

    // ── what the page tells us ─────────────────────────────────────────────────
    private onPageMessage(source: { page: Page; frame: Frame }, payload: unknown): void {
        const s = this.s;
        this.opts.tap?.(payload);
        if (s.rec.status !== "recording" || !source.page || (source.page !== s.page && source.page !== s.popup)) return;
        if (!payload || typeof payload !== "object" || (payload as { tok?: unknown }).tok !== s.token) return;
        // A frame's own page visits and the popup's are not steps: only the recorded page's are.
        const origin: Origin = { frame: source.frame, inPopup: source.page === s.popup };
        if ((origin.inPopup || source.frame !== source.page.mainFrame()) && (payload as { t?: unknown }).t === "doc") return;
        s.queue = s.queue
            .then(() => this.process(payload as Record<string, unknown>, origin))
            .catch(() => undefined)
            .then(() => this.changed());
    }

    private async process(ev: Record<string, unknown>, origin?: Origin): Promise<void> {
        const s = this.s;
        if (s.rec.status !== "recording") return;
        this.touch();
        const t = ev.t;
        if (typeof ev.ts === "number" && t !== "doc" && t !== "note" && t !== "pick") s.lastActionTs = Math.max(s.lastActionTs, Math.min(ev.ts, Date.now() + 1_000));
        const url = typeof ev.url === "string" ? ev.url : undefined;
        // A frame's address or the popup's is not where the recorded page is.
        if (url && (!origin || (!origin.inPopup && origin.frame === s.page?.mainFrame()))) s.rec.currentUrl = url;
        switch (t) {
            case "doc": {
                const first = s.docCount++ === 0;
                const docTs = typeof ev.ts === "number" ? ev.ts : Date.now();
                const caused = docTs - s.lastActionTs < NAVIGATION_CREDIT_MS;
                if (first || caused || sameDoc(url, s.lastDocUrl)) s.lastDocUrl = url;
                else if (url) {
                    s.lastDocUrl = url;
                    this.addStep({ kind: "goto", url, describe: describeRecStep({ kind: "goto", url }), at: new Date().toISOString() });
                }
                await this.syncInspect();
                return;
            }
            case "act":
                return;
            case "note":
                if (ev.code === "upload") this.note("A file was chosen in the page. File uploads are not recorded: add a step by hand or upload in the test's data.");
                else if (ev.code === "drag") this.note("Drag and drop is not recorded. Use a click or a typed value, or write that step by hand.");
                return;
            case "click":
            case "fill":
            case "select":
            case "check":
            case "press":
                await this.recordAction(ev, origin);
                return;
            case "upload":
                await this.recordUpload(ev, origin);
                return;
            case "drag":
                await this.recordDrag(ev, origin);
                return;
            case "pick":
                await this.recordPick(ev, origin);
                return;
        }
    }

    /** Asks Playwright how many elements each candidate finds, and whether the recorded element is one of them. Falls back to the page's own counts. */
    private async refine(cands: RawCandidate[], at?: Frame): Promise<RawCandidate[]> {
        const s = this.s;
        const frame = at && at !== s.page?.mainFrame() && !at.isDetached() ? at : s.page && !s.page.isClosed() ? s.page.mainFrame() : undefined;
        if (!frame || !cands.length) return cands;
        try {
            const marked = frame.locator("[data-aitp-pick]");
            const out = await withTimeout(
                Promise.all(
                    cands.map(async (c) => {
                        const loc = pwLocator(frame, c);
                        const [n, hit] = await Promise.all([loc.count(), loc.and(marked).count()]);
                        return { c, n, hit: hit > 0 };
                    }),
                ),
                1_500,
            );
            // No candidate reaches the marked element: the marker is gone (the page moved on), so the page's own answer stands.
            if (!out.some((o) => o.hit)) return cands;
            return out.map((o) => ({ ...o.c, matches: o.n, hit: o.hit }));
        } catch {
            return cands;
        }
    }

    private async countOf(l: RecLocator, at?: Frame): Promise<number | undefined> {
        const s = this.s;
        const frame = at && at !== s.page?.mainFrame() && !at.isDetached() ? at : s.page && !s.page.isClosed() ? s.page.mainFrame() : undefined;
        if (!frame) return undefined;
        try {
            return await withTimeout(pwLocator(frame, { strategy: l.strategy, value: l.value, name: l.name, exact: l.exact }).count(), 1_500);
        } catch {
            return undefined;
        }
    }

    private addStep(step: NewStep): void {
        const s = this.s;
        const r = pushStep(s.rec.steps, step, s.maxSteps);
        if (r.outcome === "full") this.note(`The recording reached the ${s.maxSteps}-step limit, so later steps are not recorded. Stop and save it, then record the rest as a second test.`);
        else {
            s.rec.steps = r.steps;
            this.changed();
        }
    }

    private async recordAction(ev: Record<string, unknown>, origin?: Origin): Promise<void> {
        const t = ev.t as string;
        const kind: RecStepKind = t === "check" ? (ev.checked === true ? "check" : "uncheck") : (t as RecStepKind);
        const where = await this.whereOf(origin);
        if (!where) return;
        const cands = parseCands(ev.cands);
        const ranked = cands.length ? rankCandidates(await this.refine(cands, origin?.frame)) : undefined;
        if (!ranked && kind !== "press") {
            this.note("A click or entry could not be tied to a stable way of finding its element, so it was not recorded.");
            return;
        }
        const at = new Date().toISOString();
        const base: NewStep = { kind, ...(ranked ? { locator: ranked.chosen, matches: ranked.matches, ...(ranked.alternatives.length ? { alternatives: ranked.alternatives } : {}) } : {}), ...where, describe: "", at };
        const secretKind = isSecretKind(ev.secretKind) ? ev.secretKind : undefined;
        if (kind === "fill") {
            // A secret's value is not even looked at: only its stand-in is stored.
            if (secretKind) {
                base.value = SECRET_PLACEHOLDERS[secretKind];
                base.secret = true;
            } else {
                base.value = typeof ev.value === "string" ? ev.value : "";
                // A value a tool typed from a stand-in (possibly cut short by the field's maxlength) is stored as the stand-in, whenever its report arrives.
                const stand = this.standInFor(base.value);
                if (stand) base.value = `{{credentials.${stand}}}`;
            }
        } else if (kind === "select") base.value = typeof ev.value === "string" ? ev.value : "";
        else if (kind === "press") {
            if (ev.key !== "Enter" && ev.key !== "Escape" && ev.key !== "Tab") return;
            base.value = ev.key;
        }
        base.describe = describeStep(base, ranked, secretKind);
        this.addStep(base);
    }

    private standInFor(value: string): CredentialSlot | undefined {
        if (!value) return undefined;
        const hit = this.s.standIns?.find((x) => x.typed === value || (value.length >= 3 && x.typed.startsWith(value)));
        return hit?.slot;
    }

    private async recordPick(ev: Record<string, unknown>, origin?: Origin): Promise<void> {
        const s = this.s;
        const where = await this.whereOf(origin);
        if (!where) return;
        const cands = parseCands(ev.cands);
        const ranked = rankCandidates(await this.refine(cands, origin?.frame));
        if (!ranked) {
            this.note("That element could not be given a stable locator.");
            return;
        }
        const tag = typeof ev.tag === "string" ? ev.tag.slice(0, 20) : "element";
        const text = typeof ev.text === "string" && ev.text.trim() ? shortText(ev.text, REC_LIMITS.maxAssertText) : undefined;
        const at = new Date().toISOString();
        s.rec.picked = { locator: ranked.chosen, alternatives: ranked.alternatives, tag, ...(text ? { text } : {}), at };
        this.changed();
        if (s.rec.inspect.mode !== "assertion") return;
        const check = s.rec.inspect.assertCheck ?? "visible";
        const secret = isSecretKind(ev.secretKind);
        let assert: RecAssert | undefined;
        let locator = ranked.chosen;
        let matches = ranked.matches;
        let alternatives = ranked.alternatives;
        let positional = ranked.positional;
        switch (check) {
            case "visible":
            case "hidden":
            case "enabled":
            case "disabled":
                assert = { check };
                break;
            case "text": {
                if (tag === "input" || tag === "textarea" || tag === "select") this.note("That is a field: use the \"value\" check for what it holds.");
                else if (!text) this.note("That element has no text to compare.");
                else assert = { check, expected: text };
                break;
            }
            case "value": {
                if (secret) this.note("The value of a password or other secret field is never recorded, so it can't be asserted.");
                else if (typeof ev.value !== "string") this.note("That element has no value. Use the \"text\" check for what it shows.");
                else assert = { check, expected: clip(ev.value.replace(/\s+/g, " ").trim(), REC_LIMITS.maxAssertText) };
                break;
            }
            case "count": {
                const g = ev.group as { css?: unknown; count?: unknown } | undefined;
                if (g && typeof g.css === "string" && g.css.length <= 300 && typeof g.count === "number") {
                    locator = { strategy: "css", value: g.css };
                    const n = (await this.countOf(locator, origin?.frame)) ?? g.count;
                    matches = n;
                    alternatives = [{ locator: ranked.chosen, matches: ranked.matches }, ...ranked.alternatives].slice(0, REC_LIMITS.maxAlternatives);
                    positional = false;
                    assert = { check, expected: n };
                } else assert = { check, expected: ranked.matches };
                break;
            }
        }
        if (!assert) return;
        const step: NewStep = { kind: "assert", locator, matches, ...(alternatives.length ? { alternatives } : {}), assert, ...where, describe: "", at };
        step.describe = describeStep(step, { positional, generated: ranked.generated });
        this.addStep(step);
    }

    private async syncInspect(): Promise<void> {
        const s = this.s;
        const page = s.page;
        if (!page || page.isClosed()) return;
        const st = { on: s.rec.inspect.on, mode: s.rec.inspect.mode };
        // Every frame of the page (and of the popup) has the recorder script: all of them switch, so an element inside a frame can be picked too.
        // The top of each page is reached through the page itself, its child frames one by one.
        const framesOf = (p: Page): Array<Pick<Frame, "evaluate">> => [p, ...(typeof p.frames === "function" ? p.frames().filter((fr) => fr !== p.mainFrame()) : [])];
        const frames = [...framesOf(page), ...(s.popup && !s.popup.isClosed() ? framesOf(s.popup) : [])].slice(0, 30);
        await Promise.all(
            frames.map((fr) =>
                fr
                    .evaluate(([name, state]) => {
                        const f = (window as unknown as Record<string, unknown>)[name as string];
                        return typeof f === "function" ? (f as (x: unknown) => boolean)(state) : false;
                    }, [s.ctl, st] as [string, { on: boolean; mode: string }])
                    .catch(() => undefined),
            ),
        );
    }

    // ── frames, popups, uploads, drag and drop ─────────────────────────────────
    /**
     * The step fields that say where a message came from: the frames its element is in (outermost first) and whether it was the popup. Undefined (with a
     * note) when the element cannot be found again: a frame nested deeper than the platform follows, or a frame with no name, title or address.
     */
    private async whereOf(origin?: Origin): Promise<Pick<RecStep, "frame" | "inPopup"> | undefined> {
        const s = this.s;
        if (!origin) return {};
        // The main frame of the page or of the popup: nothing to name.
        if (origin.frame === s.page?.mainFrame() || origin.frame === s.popup?.mainFrame()) return origin.inPopup ? { inPopup: true } : {};
        const chain: NonNullable<RecStep["frame"]> = [];
        let fr: Frame | null = origin.frame;
        try {
            while (fr && fr.parentFrame()) {
                const el = await withTimeout(fr.frameElement(), 1_500);
                const attrs = await withTimeout(el.evaluate((e) => ({ name: (e as Element).getAttribute("name"), title: (e as Element).getAttribute("title"), src: (e as Element).getAttribute("src") })), 1_500);
                await el.dispose().catch(() => undefined);
                const ref = describeFrame(attrs);
                if (!ref) {
                    this.note("Something was done inside a frame that has no name, title or address to find it by, so it was not recorded.");
                    return undefined;
                }
                chain.unshift(ref);
                if (chain.length > MAX_FRAME_DEPTH) {
                    this.note("Something was done inside frames nested more than " + MAX_FRAME_DEPTH + " deep, so it was not recorded.");
                    return undefined;
                }
                fr = fr.parentFrame();
            }
        } catch {
            return undefined; // the frame went away while it was being looked at
        }
        return { ...(chain.length ? { frame: chain } : {}), ...(origin.inPopup ? { inPopup: true } : {}) };
    }

    /** A window the recorded page (or its popup) opened becomes "the popup"; the click that opened it is marked. Any other window is only noted. */
    private async onNewPage(p: Page): Promise<void> {
        const s = this.s;
        if (!s.page || p === s.page) return;
        const opener = await p.opener().catch(() => null);
        if (!opener || (opener !== s.page && opener !== s.popup)) {
            this.note("A new tab or window opened that the recorded page did not open, so it is not recorded.");
            return;
        }
        const fromPopup = opener === s.popup;
        s.popup = p;
        p.on("close", () => {
            if (s.popup === p) s.popup = undefined;
        });
        // Where the popup goes is guarded like the page itself.
        p.on("framenavigated", (fr) => {
            if (fr !== p.mainFrame()) return;
            void this.blockedReason(fr.url()).then((reason) => {
                if (!reason || s.rec.status !== "recording") return;
                s.rec.error = this.blockedMessage(fr.url(), reason);
                void this.finish("stopped");
            });
        });
        // The click that opened it was reported before the window appeared: once the queue has caught up, it is the last click step.
        s.queue = s.queue
            .then(() => {
                const steps = s.rec.steps;
                for (let i = steps.length - 1; i >= 0; i--) {
                    const st = steps[i]!;
                    if (st.kind !== "click" || Boolean(st.inPopup) !== fromPopup) continue;
                    const marked: RecStep = { ...st, opensPopup: true };
                    marked.describe = describeStep(marked);
                    s.rec.steps = [...steps.slice(0, i), marked, ...steps.slice(i + 1)];
                    break;
                }
                this.note("A new tab or window opened. What you do in it is recorded as steps in the popup.");
                this.changed();
            })
            .catch(() => undefined);
        if (s.rec.inspect.on) await this.syncInspect();
    }

    private async recordUpload(ev: Record<string, unknown>, origin?: Origin): Promise<void> {
        const where = await this.whereOf(origin);
        if (!where) return;
        const ranked = rankCandidates(await this.refine(parseCands(ev.cands), origin?.frame));
        if (!ranked) {
            this.note("A file was chosen, but the file field could not be tied to a stable locator, so it was not recorded.");
            return;
        }
        const names = Array.isArray(ev.files) ? ev.files.filter((n): n is string => typeof n === "string") : [];
        const file = names.length ? testFileNameFrom(names[0]!) : undefined;
        if (!file) {
            this.note("A file was chosen, but its name cannot be used for a test file, so it was not recorded.");
            return;
        }
        // Only the name is kept: the file's content never leaves the person's computer. The test takes a file of that name from the project's test files.
        const step: NewStep = { kind: "upload", locator: ranked.chosen, matches: ranked.matches, ...(ranked.alternatives.length ? { alternatives: ranked.alternatives } : {}), value: file, ...where, describe: "", at: new Date().toISOString() };
        step.describe = describeStep(step, ranked);
        this.addStep(step);
        const more = typeof ev.count === "number" && ev.count > 1 ? " Only the first of the chosen files is kept." : "";
        this.note("A file was chosen: add “" + file + "” to the project's test files (Settings, Test data) before the test runs." + more);
    }

    private async recordDrag(ev: Record<string, unknown>, origin?: Origin): Promise<void> {
        const where = await this.whereOf(origin);
        if (!where) return;
        const ranked = rankCandidates(await this.refine(parseCands(ev.cands), origin?.frame));
        // The drop target is ranked by the page's own counts (only one element can carry the platform's check mark at a time).
        const target = rankCandidates(parseCands(ev.target));
        if (!ranked || !target) {
            this.note("A drag and drop could not be tied to stable locators for both elements, so it was not recorded.");
            return;
        }
        const step: NewStep = { kind: "drag", locator: ranked.chosen, matches: ranked.matches, ...(ranked.alternatives.length ? { alternatives: ranked.alternatives } : {}), target: target.chosen, ...where, describe: "", at: new Date().toISOString() };
        step.describe = describeStep(step, ranked);
        this.addStep(step);
    }

    // ── driving the page step by step (a tool, not a person: see act.ts) ──────────
    /** True while an action is being performed (only one runs at a time). */
    get acting(): boolean {
        return this.s.acting === true;
    }

    private livePage(): Page {
        const s = this.s;
        if (s.rec.status !== "recording" || !s.page || s.page.isClosed()) throw new RecorderError(409, "The recording has ended, so there is no page to drive. Start a new session.");
        return s.page;
    }

    /** What the page looks like now: its text, its interactive elements with the inspector's best locators, and (on request) a small picture. */
    async snapshot(o: { image?: boolean } = {}): Promise<LiveSnapshot> {
        const s = this.s;
        const page = this.livePage();
        this.touch();
        // The session counts as open before its start page has loaded (a busy computer can take seconds): wait for that first load once.
        if (s.firstLoad) await withTimeout(s.firstLoad, 30_000).catch(() => undefined);
        // A page that is still loading answers badly; a short wait for its document is enough, the rest is read as it is.
        await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
        let raw: RawSnapshot | null = null;
        try {
            raw = await withTimeout(
                page.evaluate(([name, arg]) => {
                    const f = (window as unknown as Record<string, unknown>)[name as string];
                    return typeof f === "function" ? (f as (x: unknown) => unknown)(arg) : null;
                }, [s.ctl, { snapshot: true, max: LIVE_LIMITS.maxElements }] as [string, { snapshot: boolean; max: number }]),
                5_000,
            ) as RawSnapshot | null;
        } catch {
            raw = null;
        }
        const url = page.url();
        const snap = shapeSnapshot(raw ?? { title: await page.title().catch(() => ""), text: "", elements: [] }, { url });
        if (s.typedKeys?.size) {
            for (const e of snap.elements) {
                if (!s.typedKeys.has(locatorKey(e.locator)) || e.value === undefined) continue;
                e.value = HIDDEN;
                e.secret = true;
            }
        }
        if (o.image) await this.addPicture(page, snap);
        return snap;
    }

    /** A picture of the page with every secret field covered; omitted (not failed) when it cannot be taken small enough. */
    private async addPicture(page: Page, snap: LiveSnapshot): Promise<void> {
        const s = this.s;
        const mark = (on: boolean) => page.evaluate(([name, v]) => { const f = (window as unknown as Record<string, unknown>)[name as string]; return typeof f === "function" ? (f as (x: unknown) => unknown)({ secretMark: v }) : false; }, [s.ctl, on] as [string, boolean]).catch(() => false);
        try {
            await mark(true);
            const shot = async (type: "png" | "jpeg") => (await page.screenshot({ type, ...(type === "jpeg" ? { quality: 45 } : {}), scale: "css", animations: "disabled", caret: "hide", timeout: 5_000, mask: [page.locator("[data-aitp-secret]")], maskColor: "#475569" })).toString("base64");
            let image = await shot("png");
            let imageType: "image/png" | "image/jpeg" = "image/png";
            if (!imageFits(image)) {
                image = await shot("jpeg");
                imageType = "image/jpeg";
            }
            if (imageFits(image)) {
                snap.image = image;
                snap.imageType = imageType;
            }
        } catch {
            /* no picture this time: the text and the elements are the accessible equivalent */
        } finally {
            await mark(false);
        }
    }

    /** Finds the one element a locator names, waiting a moment for it to appear. */
    private async uniqueElement(l: RecLocator): Promise<PwLocator> {
        const frame = this.livePage().mainFrame();
        const loc = pwLocator(frame, { strategy: l.strategy, value: l.value, name: l.name, exact: l.exact });
        let n = 0;
        for (let i = 0; i < 20; i++) {
            n = await withTimeout(loc.count(), 3_000).catch(() => 0);
            if (n > 0) break;
            await sleep(100);
        }
        if (n === 0) throw new RecorderError(422, "No element on the current page matches that locator. Take a snapshot and use one of its locators.");
        if (n > 1) throw new RecorderError(422, `That locator matches ${n} elements. Use a more specific one: the snapshot shows how many elements each locator finds.`);
        return loc;
    }

    /** Resolves an address the way a browser would (a path is relative to the current page) and runs it through the same guard as every page. */
    private async checkedAddress(raw: string): Promise<string> {
        const page = this.livePage();
        let u: URL;
        try {
            u = new URL(raw.trim(), page.url());
        } catch {
            throw new RecorderError(400, "That address is not valid.");
        }
        if (!/^https?:$/.test(u.protocol)) throw new RecorderError(400, "Only http and https pages can be opened.");
        if (u.username || u.password) throw new RecorderError(400, "The address must not contain a user name or password.");
        if (this.opts.guard) {
            try {
                await this.opts.guard(u.toString());
            } catch (e) {
                const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 400;
                throw new RecorderError(status, e instanceof Error ? e.message : "That address is not allowed.");
            }
        }
        return u.toString();
    }

    /**
     * Performs one action in the live page. Whatever the page reports because of it is recorded as a step exactly as if a person had done it (the recorder script
     * sees the same trusted events), so "save as a test" works unchanged. One action at a time. `secret` is the value of a stand-in (`{{credentials.password}}`)
     * the caller looked up on this machine's behalf: it is typed into the field and nowhere else, and never appears in the answer.
     */
    async act(action: LiveAction, o: { secret?: string; origins?: string[]; image?: boolean } = {}): Promise<ActOutcome> {
        const s = this.s;
        const page = this.livePage();
        if (s.acting) throw new RecorderError(409, "Another action is still running in this session. Wait for it to finish, then try again.");
        const recordable = action.action !== "waitForText" && action.action !== "scroll";
        if (recordable && s.rec.steps.length >= s.maxSteps) throw new RecorderError(409, `The recording has reached its ${s.maxSteps}-step limit, so more actions can't be recorded. Save it as a test, then start a new session.`);
        s.acting = true;
        this.touch();
        const before = s.rec.steps.map((x) => ({ ...x }));
        const urlBefore = page.url();
        const docsBefore = s.docCount;
        const timeout = LIVE_LIMITS.actionTimeoutMs;
        let slot: CredentialSlot | undefined;
        let typed: string | undefined;
        try {
            const doIt = async (): Promise<void> => {
                switch (action.action) {
                    case "navigate":
                        // A page that starts right after a click is taken as the click's result; this one was asked for, so it is a step of its own.
                        s.lastActionTs = 0;
                        await page.goto(await this.checkedAddress(action.url), { waitUntil: "domcontentloaded", timeout });
                        return;
                    case "click":
                        return void (await (await this.uniqueElement(action.locator)).click({ timeout }));
                    case "fill": {
                        if (credentialSlotOf(action.value) && o.secret !== undefined) this.requireOrigin(o.origins); // early: no waiting for an element on a site that is not the application's
                        const loc = await this.uniqueElement(action.locator);
                        const facts = await loc.evaluate((el) => ({
                            tag: el.tagName,
                            type: el.getAttribute("type") ?? undefined,
                            autocomplete: el.getAttribute("autocomplete") ?? undefined,
                            name: el.getAttribute("name") ?? undefined,
                            id: el.id || undefined,
                            ariaLabel: el.getAttribute("aria-label") ?? undefined,
                            placeholder: el.getAttribute("placeholder") ?? undefined,
                        }), undefined, { timeout: 3_000 });
                        const decision = decideFill(action.value, secretKindOfField(facts));
                        if (!decision.ok) throw new RecorderError(decision.status, decision.error);
                        slot = decision.slot;
                        if (slot && o.secret === undefined) throw new RecorderError(422, `There are no stored sign-in details to fill {{credentials.${slot}}} with. Save the project's sign-in details first.`);
                        typed = slot ? o.secret : action.value;
                        if (slot) {
                            // The platform checked the page's address when it looked the value up; the page may have moved since (a redirect while the field was being found).
                            // The check that counts is here, on the machine that owns the browser, right before the characters are typed.
                            this.requireOrigin(o.origins);
                            (s.standIns ??= []).push({ typed: typed!, slot });
                            if (s.standIns.length > 20) s.standIns.shift();
                            (s.typedKeys ??= new Set()).add(locatorKey(action.locator));
                        }
                        await loc.fill(typed!, { timeout });
                        if (slot) await loc.evaluate((el) => el.setAttribute("data-aitp-typed", "1"), undefined, { timeout: 3_000 }).catch(() => undefined);
                        // The recorder script reports a field when the person leaves it: a tool leaves it the same way.
                        await loc.blur({ timeout: 3_000 }).catch(() => undefined);
                        return;
                    }
                    case "select":
                        return void (await (await this.uniqueElement(action.locator)).selectOption(action.value, { timeout }));
                    case "check": {
                        const loc = await this.uniqueElement(action.locator);
                        return void (action.checked === false ? await loc.uncheck({ timeout }) : await loc.check({ timeout }));
                    }
                    case "press":
                        return void (action.locator ? await (await this.uniqueElement(action.locator)).press(action.value, { timeout }) : await page.keyboard.press(action.value));
                    case "waitForText": {
                        const ms = action.timeoutMs ?? 5_000;
                        try {
                            await page.getByText(action.value).first().waitFor({ state: "visible", timeout: ms });
                        } catch {
                            throw new RecorderError(422, `The text "${cleanLine(action.value, 80)}" did not appear within ${Math.max(1, Math.round(ms / 1000))} seconds.`);
                        }
                        return;
                    }
                    case "scroll":
                        return void (await page.evaluate((how) => {
                            const h = window.innerHeight;
                            if (how === "top") window.scrollTo(0, 0);
                            else if (how === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
                            else window.scrollBy(0, how === "up" ? -Math.round(h * 0.8) : Math.round(h * 0.8));
                        }, action.value ?? "down"));
                }
            };
            try {
                await doIt();
            } catch (e) {
                if (e instanceof RecorderError) throw e;
                // The recorder ended while the action ran (a blocked address, a closed window): say that, not a Playwright detail.
                if (s.rec.status !== "recording") throw new RecorderError(409, s.rec.error ?? "The recording ended while the action was running.");
                const why = actionFailure(e);
                throw new RecorderError(422, `That ${action.action === "navigate" ? "page" : "action"} could not be done: ${typed ? why.split(typed).join("[hidden]") : why}`);
            }
            if (recordable) {
                await this.stepSettled(before);
                // A click or a key may start a page change a moment later: if one begins, the new document is awaited before the page is read.
                if (action.action === "click" || action.action === "press" || action.action === "check") await this.pageChange(urlBefore, docsBefore);
            }
            const gained = stepsGained(before, s.rec.steps);
            const step = gained[gained.length - 1];
            let snapshot: LiveSnapshot;
            let note: string | undefined;
            try {
                snapshot = await this.snapshot(o.image ? { image: true } : {});
            } catch {
                snapshot = shapeSnapshot({ elements: [] }, { url: page.url() });
                note = "The page was still changing. Take a snapshot in a moment.";
            }
            if (recordable && !step) note = note ?? "The action was done, but it did not become a recorded step (the page did not report it, or it repeats the step before).";
            this.touch();
            return { recorded: Boolean(step), ...(step ? { step: { ...step } } : {}), ...(note ? { note } : {}), snapshot };
        } finally {
            s.acting = false;
        }
    }

    /** Gives a page change that an action started a moment to show itself (a new address or a new document), then waits for the document. */
    private async pageChange(urlBefore: string, docsBefore: number): Promise<void> {
        const s = this.s;
        const page = s.page;
        if (!page) return;
        const end = Date.now() + LIVE_LIMITS.pageChangeWaitMs;
        while (Date.now() < end && page.url() === urlBefore && s.docCount === docsBefore && s.rec.status === "recording") await sleep(40);
        if (page.url() !== urlBefore || s.docCount !== docsBefore) {
            await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
            await s.queue.catch(() => undefined);
        }
    }

    /** Waits (bounded) for the page to report the step an action caused, then for the recorder to finish handling it. */
    private async stepSettled(before: readonly RecStep[]): Promise<void> {
        const s = this.s;
        const end = Date.now() + LIVE_LIMITS.stepWaitMs;
        while (Date.now() < end && stepsGained(before, s.rec.steps).length === 0 && s.rec.status === "recording") await sleep(40);
        await s.queue.catch(() => undefined);
    }

    /** Refuses, with nothing typed, when the page in the browser is not on one of the origins the stored sign-in details belong to. Asked right before a stand-in is typed. */
    private requireOrigin(allowed: readonly string[] | undefined): void {
        if (!allowed?.length) return; // a caller that gave no origins (the recorder's own tests) has nothing to compare with; the platform always passes them
        const page = this.livePage();
        let here = "";
        try {
            here = new URL(page.url()).origin;
        } catch {
            /* refused below */
        }
        if (!allowed.includes(here)) throw new RecorderError(422, `The stored sign-in details are only typed on the application's own site (${allowed[0]}). The page is on ${here && here !== "null" ? here : "another site"} now, so nothing was typed.`);
    }

    // ── what the person (or the web page) does ──────────────────────────────────
    async setInspect(o: { on: boolean; mode?: "locator" | "assertion"; check?: RecAssertCheck }): Promise<void> {
        const s = this.s;
        if (s.rec.status !== "recording") throw new RecorderError(409, "The recording has ended, so there is no page to inspect. Start a new recording.");
        this.touch();
        s.rec.inspect = { on: o.on, mode: o.mode ?? s.rec.inspect.mode, ...((o.check ?? s.rec.inspect.assertCheck) ? { assertCheck: o.check ?? s.rec.inspect.assertCheck } : {}) };
        if (o.on) delete s.rec.picked;
        this.changed();
        await this.syncInspect();
    }

    /** A step can be edited while the session runs and after it has ended; only a session that is still starting refuses. */
    private editable(): void {
        if (this.s.rec.status === "starting") throw new RecorderError(409, "The recording is still starting.");
    }

    async patchStep(index: number, patch: StepPatch): Promise<void> {
        const s = this.s;
        this.editable();
        const cur = s.rec.steps[index];
        if (!cur) throw new RecorderError(404, `This recording has no step ${index + 1}.`);
        let step: RecStep = { ...cur };
        if (patch.locator) {
            if (!cur.locator) throw new RecorderError(400, "This step has no element to give another locator.");
            const want = locatorKey(patch.locator);
            const known = cur.alternatives?.find((a) => locatorKey(a.locator) === want);
            const matches = known ? known.matches : await this.countOf(patch.locator);
            const old: RecAlternative = { locator: cur.locator, ...(cur.matches !== undefined ? { matches: cur.matches } : { matches: 0 }) };
            const rest = [old, ...(cur.alternatives ?? [])].filter((a) => locatorKey(a.locator) !== want).slice(0, REC_LIMITS.maxAlternatives);
            step = { ...step, locator: patch.locator, alternatives: rest };
            if (matches === undefined) delete step.matches;
            else step.matches = matches;
            delete step.ref;
        }
        step = checkPatch(step, { ...(patch.value !== undefined ? { value: patch.value } : {}), ...(patch.assert ? { assert: patch.assert } : {}) });
        step.describe = describeStep(step);
        const steps = [...s.rec.steps];
        steps[index] = step;
        s.rec.steps = steps;
        this.touch();
        this.changed();
    }

    deleteStep(index: number): void {
        const s = this.s;
        this.editable();
        if (!s.rec.steps[index]) throw new RecorderError(404, `This recording has no step ${index + 1}.`);
        s.rec.steps = reindex(s.rec.steps.filter((_, i) => i !== index));
        this.touch();
        this.changed();
    }

    /** Marks a step as using a shared element of the object repository (the caller created or found the element). */
    setRef(index: number, name: string): void {
        const s = this.s;
        this.editable();
        const cur = s.rec.steps[index];
        if (!cur) throw new RecorderError(404, `This recording has no step ${index + 1}.`);
        const steps = [...s.rec.steps];
        steps[index] = { ...cur, ref: name };
        s.rec.steps = steps;
        this.changed();
    }

    step(index: number): RecStep {
        const st = this.s.rec.steps[index];
        if (!st) throw new RecorderError(404, `This recording has no step ${index + 1}.`);
        return { ...st };
    }
}
