/**
 * The person's own runner (docs/features/runner-settings.md): one runner per person, set up once in Settings and used for every run they start.
 * A runner is the program on your computer that runs your tests. The shapes here are those of GET /api/me/runner and its routes.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError, csrfHeader, getKey, type PlatformConfig } from "../../api.js";
import { useConfig, type Fetched } from "../../lib/hooks.js";
import { signedOutText } from "../../lib/labels.js";
import { routes } from "../../lib/router.js";
import type { RunnerCheck, RunnerUpdateView } from "./runners.js";
import { DISPATCH_OFF, executionModeOf, RUNS_OFF_TIP, type ExecutionMode } from "../runs/runs-here.js";

export type RunnerState = "online" | "busy" | "offline";

/** What the runner may run beyond tests made of steps: the owner's three switches. */
export interface RunnerSwitchValues {
    codeScripts: boolean;
    privateTargets: boolean;
    realPhone: boolean;
}

/** One thing the runner can or cannot do now, with the server's own sentence when it cannot (the same one it refuses a start with). */
export interface Can {
    ok: boolean;
    why?: string;
}
export type RunnerNeed = "web" | "phone" | "ios" | "windows" | "record" | "recordHeaded" | "phoneSession";
export type RunnerCan = Record<RunnerNeed, Can>;

/** GET /api/me/runner → runner (null until the person has set one up). */
export interface RunnerMine {
    id: string;
    name: string;
    status: RunnerState;
    lastSeenAt: string | null;
    os: string | null;
    arch: string | null;
    hostname?: string | null;
    version?: string | null;
    update?: RunnerUpdateView;
    check?: RunnerCheck;
    /** One sentence about how the runner reaches the platform (proxy, certificates, last problem). */
    network?: string | null;
    switches: RunnerSwitchValues;
    currentRun?: { jobId: string; projectId: string; title: string } | null;
    /** What it can start now, as the server would answer a start (missing from an older server: the server decides at the click). */
    can?: RunnerCan;
}

export interface MyRunnerAnswer {
    runner: RunnerMine | null;
    /** The server lets this person see every person's runner (GET /api/admin/runners). Missing: no. */
    canSeeEveryone?: boolean;
}

/** GET /api/me/runner/enrollments/:id: whether the computer has connected with the code inside the download. */
export interface EnrollmentStatus {
    status: "waiting" | "connected" | "expired" | "used";
}

/** GET /api/admin/runners: every person's runner (platform admins and people who manage runners). */
export interface AdminRunnerRow {
    id: string;
    name: string;
    status: RunnerState | "retired" | "not-connected";
    lastSeenAt: string | null;
    version?: string | null;
    ownerName?: string | null;
}

// ── the person's runner, one answer for the whole page ───────────────────────

/**
 * Every part of the page that shows the person's runner reads this one answer: one request, polled at the fastest rate anyone
 * showing it asks for, read again when the window gets the focus and after a start the server refused (reloadMyRunner). It is kept
 * while anything shows it, so Run, the "runs on" line and Settings never disagree.
 */
type Snap = { data?: MyRunnerAnswer; error?: Error };
let snap: Snap = {};
let generation = 0;
const listeners = new Set<() => void>();
const wants = new Map<object, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flying: Promise<void> | undefined;
let queued: Promise<void> | undefined;

const emit = (next: Snap) => {
    snap = next;
    for (const l of listeners) l();
};
function schedule() {
    clearTimeout(timer);
    const every = [...wants.values()].filter((ms) => ms > 0);
    timer = every.length ? setTimeout(() => void reloadMyRunner(), Math.min(...every)) : undefined;
}
async function readOnce(): Promise<void> {
    const mine = generation;
    try {
        const data = await api<MyRunnerAnswer>("/me/runner");
        if (mine === generation) emit({ data });
    } catch (e) {
        // A failed refresh keeps the answer already on screen.
        if (mine === generation && snap.data === undefined) emit({ error: e as Error });
    }
    if (mine === generation && wants.size) schedule();
}

/** Ask the server again now (a read already going is followed by one more, so the answer is never older than the call). */
export function reloadMyRunner(): Promise<void> {
    if (!flying) {
        flying = readOnce().finally(() => (flying = undefined));
        return flying;
    }
    queued ??= flying.then(() => {
        queued = undefined;
        return reloadMyRunner();
    });
    return queued;
}

const onFocus = () => {
    farms.clear();
    void reloadMyRunner();
};

/**
 * Whether the project runs its phone tests on its device farm (GET /api/projects/:id/runner says `canRunMobile` then): the person's
 * runner then needs no phone of its own. Read once per project while the page shows the person's runner, again after the focus.
 */
const farms = new Map<string, Promise<boolean>>();
function useFarmPhones(projectId: string | undefined, on: boolean): boolean | undefined {
    const [farm, setFarm] = useState<{ id: string; yes: boolean }>();
    useEffect(() => {
        if (!on || !projectId) return;
        let live = true;
        let asked = farms.get(projectId);
        if (!asked) {
            asked = api<{ canRunMobile?: boolean }>(`/projects/${projectId}/runner`).then(
                (r) => r.canRunMobile === true,
                () => false,
            );
            farms.set(projectId, asked);
        }
        void asked.then((yes) => live && setFarm({ id: projectId, yes }));
        return () => {
            live = false;
        };
    }, [projectId, on, snap]);
    return farm && farm.id === projectId ? farm.yes : undefined;
}
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};

/** The person's runner. `pollMs` 0: read once (the shared answer still refreshes while others poll); `on` false: not read. */
export function useMyRunner(pollMs = 15_000, on = true): Fetched<MyRunnerAnswer> {
    const s = useSyncExternalStore(subscribe, () => snap);
    useEffect(() => {
        if (!on) return;
        const key = {};
        const first = wants.size === 0;
        wants.set(key, pollMs);
        if (first) {
            window.addEventListener("focus", onFocus);
            void reloadMyRunner();
        } else schedule();
        return () => {
            wants.delete(key);
            if (wants.size) return schedule();
            // Nothing shows it any more: forget it, so the next page asks afresh.
            window.removeEventListener("focus", onFocus);
            clearTimeout(timer);
            generation++;
            snap = {};
            farms.clear();
        };
    }, [on, pollMs]);
    if (!on) return { data: undefined, error: undefined, loading: false, reload: reloadMyRunner };
    return { data: s.data, error: s.data ? undefined : s.error, loading: s.data === undefined && s.error === undefined, reload: reloadMyRunner };
}

// ── what a start control says before a click ─────────────────────────────────

/** The server's typed refusals (409) for a run that has nowhere to go: the same words are said before the click. */
export const RUNNER_NOT_SET_UP = "Set up your runner in Settings to run tests.";
export const RUNNER_OFFLINE = "Your runner is offline. Start it on your computer, then try again.";
export const RUNNER_CODE_OFF = "Code scripts are switched off on your runner. Switch them on in Settings to run this test.";
/** The title over the "your runner can't take this" notice. */
export const NO_RUNNER_TITLE = "Your runner can’t take runs right now";

/** The code a refusal carries (in its details, or at the top of the answer). */
export function refusalCode(e: unknown): string | null {
    if (!(e instanceof ApiError)) return null;
    const d = e.details as { code?: unknown } | undefined;
    return typeof d?.code === "string" ? d.code : null;
}

/** Where a refusal says the fix is (`details.link`, a page of this site only), else Settings when it is a runner refusal. */
export function refusalLink(e: unknown): string | null {
    if (!(e instanceof ApiError)) return null;
    const link = (e.details as { link?: unknown } | undefined)?.link;
    if (typeof link === "string" && /^#\//.test(link)) return link;
    return isRunnerRefusal(e) ? routes.yourRunner : null;
}

/** A refusal that Settings fixes: the person's runner is not set up, is offline, or may not run this. The message is the server's own. */
export function isRunnerRefusal(e: unknown): boolean {
    if (!(e instanceof ApiError) || e.status !== 409) return false;
    const code = refusalCode(e);
    if (code) return code.startsWith("RUNNER_");
    return /\byour runner\b/i.test(e.message);
}

/** What a start needs from the person's runner: things it must be able to do (the server's `can`), and code scripts switched on. */
export interface RunnerNeeds {
    can?: readonly RunnerNeed[];
    code?: boolean;
}

/** What a test needs its runner to do: its framework when that says (iOS), else its kind. */
export function needOfTest(t: { kind: string; framework?: string }): RunnerNeed {
    if (t.framework === "taqwright-ios") return "ios";
    return t.kind === "mobile" ? "phone" : t.kind === "desktop" ? "windows" : "web";
}

/** Why a start now has nowhere to go, or null when the person's runner can take it. A busy runner can: the run waits. */
export function runnerProblem(answer: MyRunnerAnswer | undefined, needs: RunnerNeeds = {}): string | null {
    if (!answer) return null;
    const r = answer.runner;
    if (!r) return RUNNER_NOT_SET_UP;
    if (r.status === "offline") return RUNNER_OFFLINE;
    for (const n of needs.can ?? []) {
        const c = r.can?.[n];
        if (c && !c.ok) return c.why ?? RUNNER_OFFLINE;
    }
    if (needs.code && r.switches && !r.switches.codeScripts) return RUNNER_CODE_OFF;
    return null;
}

export interface Readiness {
    mode: ExecutionMode;
    /** Still asking (a start stays off in runners mode until the answer is in). */
    loading: boolean;
    /** A start now has somewhere to go. */
    ready: boolean;
    /** Why not, in one sentence (null when ready). */
    reason: string | null;
    /** The person's runner (runners mode), null when not set up, undefined until known. */
    runner: RunnerMine | null | undefined;
    /** The reason is the person's runner (Settings fixes it), not the platform. */
    runnerReason: boolean;
}

/**
 * Can this person start it now? The one answer every start control uses (Run, a suite's Run, Record, a phone session).
 * Local mode: when the server can run tests. Runners mode: when the platform hands runs out and the person's own runner is set up,
 * connected and able to do what the start needs (a busy one makes it wait).
 */
export function readiness(mode: ExecutionMode, config: PlatformConfig | undefined, me: Pick<Fetched<MyRunnerAnswer>, "data" | "loading">, needs: RunnerNeeds = {}): Readiness {
    const runner = me.data?.runner;
    if (mode === "local") {
        const off = config?.runsHere === false;
        return { mode, loading: false, ready: !off, reason: off ? RUNS_OFF_TIP : null, runner, runnerReason: false };
    }
    if (config?.runsHere === false) return { mode, loading: false, ready: false, reason: DISPATCH_OFF, runner, runnerReason: false };
    // The answer could not be read: the server decides at the click (and says why with a link to Settings).
    if (!me.data) return { mode, loading: me.loading, ready: !me.loading, reason: null, runner: undefined, runnerReason: false };
    const why = runnerProblem(me.data, needs);
    return { mode, loading: false, ready: !why, reason: why, runner: me.data.runner, runnerReason: Boolean(why) };
}

/**
 * The readiness hook: `readiness` for this page's config and the person's runner (read only in runners mode). With `projectId`, a
 * phone need is met by the project's device farm when it has one (the runner still has to be set up and online).
 */
export function useReadiness(needs: RunnerNeeds = {}, projectId?: string): Readiness & { reload: () => Promise<void> } {
    const config = useConfig();
    const mode = executionModeOf(config);
    const me = useMyRunner(15_000, mode === "runners");
    const phone = Boolean(needs.can?.includes("phone"));
    const farm = useFarmPhones(projectId, mode === "runners" && phone);
    // Until the project answers, the phone need is left to the server at the click (as with an unread runner answer).
    const met = projectId && phone && farm !== false ? { ...needs, can: needs.can!.filter((n) => n !== "phone") } : needs;
    return { ...readiness(mode, config, me, met), reload: me.reload };
}

// ── the download ────────────────────────────────────────────────────────────

export type RunnerOs = "windows" | "mac" | "linux";
export type RunnerArch = "x64" | "arm64";

export const OS_WORDS: Record<RunnerOs, string> = { windows: "Windows", mac: "Mac", linux: "Linux" };
export const ARCH_WORDS: Record<RunnerOs, Record<RunnerArch, string>> = {
    windows: { x64: "Intel or AMD processor", arm64: "ARM processor" },
    mac: { arm64: "Apple chip (M1 or newer)", x64: "Intel processor" },
    linux: { x64: "Intel or AMD processor", arm64: "ARM processor" },
};

/** One download this server can make: by system and processor, the installer (Windows, Mac) or the plain files (Linux). */
export interface DownloadSystem {
    os: RunnerOs;
    arch: RunnerArch;
    available: boolean;
    /** Set when it carries its own Node.js and test tools. */
    bytes?: number;
    note?: string;
    reason?: string;
}

/** GET /api/me/runner/download/info: which systems can be downloaded now, and whether this person may download at all. */
export interface DownloadInfo {
    available?: boolean;
    reason?: string;
    urlOk?: boolean;
    urlWarning?: string;
    /** false: show `refusal` (for example a session signed in with the server's access key) instead of the button. */
    mayDownload?: boolean;
    refusal?: string;
    systems?: DownloadSystem[];
}

/** Can this system and processor be downloaded, and if not, why; with the server's note. A server that does not say is taken to have it. */
export function systemAvailable(info: DownloadInfo | undefined, os: RunnerOs, arch?: RunnerArch): { ok: boolean; reason?: string; note?: string; bytes?: number } {
    if (info?.available === false) return { ok: false, ...(info.reason ? { reason: info.reason } : {}) };
    const list = Array.isArray(info?.systems) ? info!.systems : [];
    if (list.length === 0) return { ok: true };
    const s = list.find((x) => x.os === os && (arch === undefined || x.arch === arch)) ?? (arch === undefined ? undefined : list.find((x) => x.os === os));
    if (!s) return { ok: false };
    return { ok: s.available, ...(s.reason ? { reason: s.reason } : {}), ...(s.note ? { note: s.note } : {}), ...(s.bytes ? { bytes: s.bytes } : {}) };
}

/** "about 58 MB". */
export function sizeWords(bytes: number | undefined): string {
    if (!bytes || bytes <= 0) return "";
    return `about ${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** System and processor from what the browser says about itself (a Mac's browser says "Intel" even with an Apple chip, so a Mac counts as Apple chip). */
export function guessSystem(nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator): { os: RunnerOs; arch: RunnerArch } {
    const text = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
    const arm = /\b(arm64|aarch64|armv8l?|arm)\b/i.test(text);
    if (/Windows|Win32|Win64/i.test(text)) return { os: "windows", arch: arm ? "arm64" : "x64" };
    if (/Mac/i.test(text) && !/Linux|X11|CrOS/i.test(text)) return { os: "mac", arch: "arm64" };
    if (/Linux|X11|CrOS/i.test(text)) return { os: "linux", arch: arm ? "arm64" : "x64" };
    return { os: "windows", arch: "x64" };
}

/** Chromium-based browsers can say the processor; others keep the guess. Never throws. */
export async function refineArch(guess: { os: RunnerOs; arch: RunnerArch }, nav: unknown = typeof navigator === "undefined" ? undefined : navigator): Promise<{ os: RunnerOs; arch: RunnerArch }> {
    try {
        const data = (nav as { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> } } | undefined)?.userAgentData;
        if (!data?.getHighEntropyValues) return guess;
        const a = ((await data.getHighEntropyValues(["architecture", "bitness"])).architecture ?? "").toLowerCase();
        return a === "arm" ? { ...guess, arch: "arm64" } : a === "x86" ? { ...guess, arch: "x64" } : guess;
    } catch {
        return guess;
    }
}

export interface DownloadMade {
    fileName: string;
    enrollmentId: string | null;
    expiresAt: string | null;
    /** What the server made: an installer that was not built becomes plain files (with `note` saying so). */
    kind: "installer" | "files";
    note: string | null;
}

export class DownloadError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/**
 * POST /api/me/runner/download: the server puts a personal one-time code inside the zip and names its record in the headers. The page
 * saves the zip as an ordinary browser download and never reads inside it, so the code never reaches the page's state.
 */
export async function downloadMyRunner(os: RunnerOs, arch: RunnerArch, save: (blob: Blob, fileName: string) => void): Promise<DownloadMade> {
    let res: Response;
    try {
        res = await fetch("/api/me/runner/download", {
            method: "POST",
            headers: { "content-type": "application/json", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: JSON.stringify({ os, arch }),
        });
    } catch {
        throw new DownloadError(0, "We couldn’t reach the platform server. Check that it is running and try again.");
    }
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const text = body.error || res.statusText || "The runner download could not be made.";
        throw new DownloadError(res.status, res.status === 401 ? signedOutText(text) : text);
    }
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
    const fileName = named ? safeDecode(named) : "ai-testing-runner.zip";
    save(await res.blob(), fileName);
    const kind = res.headers.get("x-runner-kit-kind") === "files" ? "files" : os === "linux" ? "files" : "installer";
    return { fileName, enrollmentId: res.headers.get("x-runner-enrollment-id"), expiresAt: res.headers.get("x-runner-enrollment-expires"), kind, note: res.headers.get("x-runner-kit-note") };
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/** Save a blob as a browser download. */
export function saveBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "14:32", in the person's own clock. */
export const clockTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** What to do on the computer once the download is saved (on Windows the setup program itself, round 49): the installer on Windows and Mac, the plain files on Linux. `code` words are typed. */
export function startSteps(os: RunnerOs, kind: "installer" | "files" = os === "linux" ? "files" : "installer"): { steps: string[]; command?: string } {
    if (kind === "files" && os === "windows") {
        return { steps: ["Unzip the download and open the folder.", "Double-click start-runner.cmd. Leave the window open: the runner runs while it is open."] };
    }
    if (kind === "files" && os === "mac") {
        return { steps: ["Unzip the download.", "Open Terminal, type `cd` and a space, drag the unzipped folder into the window, press Enter, then run the command below. Leave the window open."], command: "sh start-runner.sh" };
    }
    if (os === "windows") {
        return {
            steps: [
                "Open AITestingRunnerSetup.exe from your downloads. There is nothing to unzip.",
                "If Windows says “Windows protected your PC”, choose More info, then Run anyway: the installer is not signed yet.",
                "Choose Install and start. It downloads only what this computer is missing, then the runner starts by itself whenever you sign in.",
            ],
        };
    }
    if (os === "mac") {
        return {
            steps: [
                "Unzip the download and open the folder.",
                "Double-click “AI Testing Runner”. If macOS says it could not verify the app, choose Done, open System Settings, Privacy & Security and choose Open Anyway (on macOS 14 or older, right-click the app and choose Open).",
                "It downloads only what this Mac is missing, then the runner starts by itself whenever you sign in.",
            ],
        };
    }
    return {
        steps: ["Unzip the download.", "Open a terminal in the unzipped folder and run the command below. Leave the window open: the runner runs while it is open."],
        command: "sh start-runner.sh",
    };
}

/** The last line under the steps: what to open when the runner does not connect. */
export function checkComputerHelp(os: RunnerOs, kind: "installer" | "files" = os === "linux" ? "files" : "installer"): string {
    // The one-file Windows download has no folder: Setup runs the same check when it finishes and shows it in its window.
    if (os === "windows" && kind === "installer") return "If it does not connect, open the runner's window (its icon next to the clock, or AI Testing Runner in the Start menu). Setup checked this computer when it finished and says there what to fix.";
    if (os === "windows") return "If it does not connect, double-click check-computer.cmd in the unzipped folder. It checks this computer and says what to fix.";
    if (os === "mac") return "If it does not connect, double-click check-computer.command in the unzipped folder. It checks this Mac and says what to fix.";
    return "If it does not connect, run `sh check-computer.sh` in the same folder. It checks this computer and says what to fix, and changes nothing.";
}
