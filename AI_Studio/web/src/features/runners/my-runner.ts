/**
 * The person's own runner (docs/features/runner-settings.md): one runner per person, set up once in Settings and used for every run they start.
 * A runner is the program on your computer that runs your tests. The shapes here are those of GET /api/me/runner and its routes.
 */
import { ApiError, csrfHeader, getKey } from "../../api.js";
import { useFetch, type Fetched } from "../../lib/hooks.js";
import { signedOutText } from "../../lib/labels.js";
import { routes } from "../../lib/router.js";
import type { RunnerCheck, RunnerUpdateView } from "../agents/agents.js";

export type RunnerState = "online" | "busy" | "offline";

/** What the runner may run beyond tests made of steps: the owner's three switches. */
export interface RunnerSwitchValues {
    codeScripts: boolean;
    privateTargets: boolean;
    realPhone: boolean;
}

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

/** The person's runner, polled while the page is shown (a runner that comes online unlocks Run within seconds). */
export function useMyRunner(pollMs = 15_000, on = true): Fetched<MyRunnerAnswer> {
    return useFetch<MyRunnerAnswer>(on ? "/me/runner" : null, () => (on && pollMs > 0 ? pollMs : null));
}

// ── what Run says before a click ─────────────────────────────────────────────

/** The server's typed refusals (409) for a run that has nowhere to go: the same words are said before the click. */
export const RUNNER_NOT_SET_UP = "Set up your runner in Settings to run tests.";
export const RUNNER_OFFLINE = "Your runner is offline. Start it on your computer, then try again.";
export const RUNNER_CODE_OFF = "Code scripts are switched off on your runner. Switch them on in Settings to run this test.";

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
    return isRunnerRefusal(e) ? routes.allRunners : null;
}

/** A refusal that Settings fixes: the person's runner is not set up, is offline, or may not run this. The message is the server's own. */
export function isRunnerRefusal(e: unknown): boolean {
    if (!(e instanceof ApiError) || e.status !== 409) return false;
    const code = refusalCode(e);
    if (code) return code.startsWith("RUNNER_");
    return /\byour runner\b/i.test(e.message);
}

/** Why a run started now has nowhere to go, or null when the person's runner can take it. A busy runner can: the run waits. */
export function runnerProblem(answer: MyRunnerAnswer | undefined, needs: { code?: boolean } = {}): string | null {
    if (!answer) return null;
    const r = answer.runner;
    if (!r) return RUNNER_NOT_SET_UP;
    if (r.status === "offline") return RUNNER_OFFLINE;
    if (needs.code && r.switches && !r.switches.codeScripts) return RUNNER_CODE_OFF;
    return null;
}

/** "Runs on your runner, Maya's laptop (online)." */
export function runsOnSentence(r: RunnerMine): string {
    return `Runs on your runner, ${r.name} (${r.status === "busy" ? "busy" : r.status === "online" ? "online" : "offline"})`;
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
    kind?: "installer" | "files";
    /** It carries its own Node.js and test tools. */
    ownNode?: boolean;
    bytes?: number;
    note?: string;
    reason?: string;
}

/** GET /api/me/runner/download/info: which systems can be downloaded now, and whether this person may download at all. */
export interface DownloadInfo {
    available?: boolean;
    reason?: string;
    kitVersion?: string;
    platformUrl?: string;
    urlOk?: boolean;
    urlWarning?: string;
    nodeMin?: number;
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

/** What to do on the computer once the zip is saved: the installer on Windows and Mac, the plain files on Linux. `code` words are typed. */
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
                "Unzip the download and open the folder.",
                "Double-click AITestingRunnerSetup.exe. If Windows says “Windows protected your PC”, choose More info, then Run anyway: the installer is not signed yet.",
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
export function checkComputerHelp(os: RunnerOs): string {
    if (os === "windows") return "If it does not connect, double-click check-computer.cmd in the unzipped folder. It checks this computer and says what to fix.";
    if (os === "mac") return "If it does not connect, double-click check-computer.command in the unzipped folder. It checks this Mac and says what to fix.";
    return "If it does not connect, run `sh check-computer.sh` in the same folder. It checks this computer and says what to fix, and changes nothing.";
}
