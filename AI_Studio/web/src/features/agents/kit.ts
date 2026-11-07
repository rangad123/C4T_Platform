/** "Add a runner" as a guided download: the shapes of the runner-kit API and the small rules the panel uses. */
import { csrfHeader, getKey } from "../../api.js";

export type KitPlatform = "windows" | "unix";
/** "complete" carries its own Node.js and test tools; "installer" is the setup program (Windows) or app (Mac); "files" is the plain zip with the start scripts. */
export type KitKind = "complete" | "installer" | "files";

/** The complete download exists once per system and processor. */
export type CompleteTarget = "win-x64" | "win-arm64" | "mac-arm64" | "mac-x64" | "linux-x64" | "linux-arm64";
export const COMPLETE_TARGETS: readonly CompleteTarget[] = ["win-x64", "win-arm64", "mac-arm64", "mac-x64", "linux-x64", "linux-arm64"];
/** How each one is said on screen ("We guessed Windows on an Intel or AMD processor."). */
export const TARGET_WORDS: Record<CompleteTarget, string> = {
    "win-x64": "Windows on an Intel or AMD processor",
    "win-arm64": "Windows on an ARM processor",
    "mac-arm64": "a Mac with an Apple chip",
    "mac-x64": "a Mac with an Intel processor",
    "linux-x64": "Linux on an Intel or AMD processor",
    "linux-arm64": "Linux on an ARM processor",
};
/** The targets that belong to the "Windows" and the "Mac or Linux" choice. */
export const targetsFor = (platform: KitPlatform): CompleteTarget[] => COMPLETE_TARGETS.filter((t) => (platform === "windows") === t.startsWith("win"));

/** GET /api/projects/:id/runner-kits/info */
export interface KitInfo {
    available: boolean;
    /** A plain sentence for why the kit cannot be made on this server (present when `available` is false). */
    reason?: string;
    /** The address the runner will connect to. */
    platformUrl: string;
    /** false when that address will not work from another computer (for example localhost or plain http on the internet). */
    urlOk: boolean;
    urlWarning?: string;
    nodeMin: number;
    kitVersion?: string;
    /** Which installers this server has built. Absent on a server that predates installers: then only plain files exist. */
    installer?: { windows: boolean; mac: boolean; reasons?: { windows?: string; mac?: string } };
    /** Which complete downloads this server has built, with their approximate size. Absent on a server that predates them. */
    complete?: { targets: Partial<Record<CompleteTarget, { available: boolean; bytes?: number; nodeVersion?: string; reason?: string }>> };
}

export interface KitDownload {
    fileName: string;
    /** The id of the access (token) made for this download. The secret itself never reaches the page's state. */
    tokenId: string | null;
    /** What the server made. It can differ from what was asked for: an installer that was not built becomes plain files. */
    kind: KitKind;
    /** True when the person asked for the installer and the server made plain files instead. */
    fellBack: boolean;
    /** A download from the Runners page carries a one-time enrollment code: its record (to ask whether the runner has connected) and when it expires. */
    enrollmentId?: string | null;
    expiresAt?: string | null;
}

/** A failed download, with the status the panel needs to choose its words. */
export class KitError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** Windows or Mac/Linux, from what the browser says about itself. Windows is the safer guess when the browser does not say. */
export function guessPlatform(nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator): KitPlatform {
    const text = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
    if (/Mac|Linux|X11|CrOS/i.test(text) && !/Windows|Win32|Win64/i.test(text)) return "unix";
    return "windows";
}

/**
 * System and processor from what the browser says about itself. Most browsers only say "x64" or nothing (a Mac's always says "Intel", even
 * with an Apple chip), so a Mac counts as an Apple chip and anything else as Intel or AMD unless the browser says ARM. refineTarget() asks
 * Chromium-based browsers for more.
 */
export function guessTarget(nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator): CompleteTarget {
    const text = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
    const arm = /\b(arm64|aarch64|armv8l?|arm)\b/i.test(text);
    if (guessPlatform(nav) === "windows") return arm ? "win-arm64" : "win-x64";
    if (/Mac/i.test(text) && !/Linux|X11|CrOS/i.test(text)) return "mac-arm64";
    return arm ? "linux-arm64" : "linux-x64";
}

/** The answer of navigator.userAgentData.getHighEntropyValues(["architecture", "bitness"]) applied to a guess ("arm" means ARM, "x86" Intel or AMD). */
export function targetFromHints(guess: CompleteTarget, hints: { architecture?: string; bitness?: string } | undefined): CompleteTarget {
    const a = (hints?.architecture ?? "").toLowerCase();
    if (a !== "arm" && a !== "x86") return guess;
    return `${guess.split("-")[0]}-${a === "arm" ? "arm64" : "x64"}` as CompleteTarget;
}

/** Asks a Chromium-based browser for the processor; others (Safari, Firefox) keep the guess. Never throws. */
export async function refineTarget(guess: CompleteTarget, nav: unknown = typeof navigator === "undefined" ? undefined : navigator): Promise<CompleteTarget> {
    try {
        const data = (nav as { userAgentData?: { getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string; bitness?: string }> } } | undefined)?.userAgentData;
        if (!data?.getHighEntropyValues) return guess;
        return targetFromHints(guess, await data.getHighEntropyValues(["architecture", "bitness"]));
    } catch {
        return guess;
    }
}

/** Has this server built the complete download for this target? */
export function completeAvailable(info: Pick<KitInfo, "complete"> | undefined, target: CompleteTarget | undefined): boolean {
    return Boolean(target && info?.complete?.targets?.[target]?.available);
}

/** "about 58 MB", for the panel. */
export function sizeWords(bytes: number | undefined): string {
    if (!bytes || bytes <= 0) return "";
    return `about ${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

/** Is there an installer for this computer on this server? "Mac or Linux" counts as a Mac: the app is for macOS only. */
export function installerAvailable(info: Pick<KitInfo, "installer"> | undefined, platform: KitPlatform): boolean {
    if (!info?.installer) return false;
    return platform === "windows" ? info.installer.windows : info.installer.mac;
}

/** Windows and Mac get the installer when the server has one; a Linux computer (and a server without installers) gets the plain files. */
export function defaultKind(info: Pick<KitInfo, "installer" | "complete"> | undefined, platform: KitPlatform, nav: { platform?: string; userAgent?: string } = typeof navigator === "undefined" ? {} : navigator, target?: CompleteTarget): KitKind {
    // The complete download needs nothing else on the computer, so it comes first wherever the server has it.
    if (completeAvailable(info, target)) return "complete";
    if (!installerAvailable(info, platform)) return "files";
    if (platform === "unix" && /Linux|X11|CrOS/i.test(`${nav.platform ?? ""} ${nav.userAgent ?? ""}`) && !/Mac/i.test(`${nav.platform ?? ""} ${nav.userAgent ?? ""}`)) return "files";
    return "installer";
}

/** What the person picked, or the default; never an installer the server does not have. */
export function effectiveKind(info: Pick<KitInfo, "installer" | "complete"> | undefined, platform: KitPlatform, chosen: KitKind | null, target?: CompleteTarget): KitKind {
    if (chosen === "files") return "files";
    // Once chosen, the complete download stays chosen when the person switches to a processor this server has not built: the panel says so.
    if (chosen === "complete") return info?.complete ? "complete" : "files";
    if (chosen === null && completeAvailable(info, target)) return "complete";
    if (!installerAvailable(info, platform)) return "files";
    return chosen ?? defaultKind(info, platform);
}

export const DEFAULT_RUNNER_NAME = "Office computer";
export const NAME_MAX = 60;

/**
 * Ask the platform to make the access and the kit, and save the zip as an ordinary browser download.
 * The zip holds a secret, so it is kept only as long as the download needs it and the page never reads inside it.
 */
export async function downloadRunnerKit(projectId: string, name: string, platform: KitPlatform, save: (blob: Blob, fileName: string) => void, kind: KitKind = "files", target?: CompleteTarget): Promise<KitDownload> {
    return postKit(`/api/projects/${projectId}/runner-kits`, kitBody(name, platform, kind, target), save, kind);
}

/** Who a download from the Runners page is for: the person's own computer, or a team runner of an organisation (null: Crowd4Test's shared runners) with the projects it may run. */
export type EnrollScope = { kind: "personal" } | { kind: "team"; organizationId: string | null; projectIds: string[] };

/** Where the Runners page asks for a download (src/platform/routes/runner-kits.ts): no project, because a personal runner belongs to a person. */
export const RUNNER_KITS_PATH = "/runners/kits";

/**
 * The download for "Add this computer" or "Add a team runner": the server makes a one-time enrollment code and puts it into the zip as
 * runner.enroll, never a runner credential; the answer names the code's record and its expiry. The page never reads inside the zip.
 */
export async function downloadEnrolledKit(scope: EnrollScope, name: string, platform: KitPlatform, save: (blob: Blob, fileName: string) => void, kind: KitKind = "files", target?: CompleteTarget): Promise<KitDownload> {
    const body = { runner: scope.kind, ...(scope.kind === "team" ? { ...(scope.organizationId ? { organizationId: scope.organizationId } : {}), projectIds: scope.projectIds } : {}), ...kitBody(name, platform, kind, target) };
    return postKit(`/api${RUNNER_KITS_PATH}`, body, save, kind);
}

/** The complete download is asked for by system and processor; the other two only by system. */
function kitBody(name: string, platform: KitPlatform, kind: KitKind, target?: CompleteTarget): Record<string, unknown> {
    return kind === "complete" && target
        ? { name, platform, complete: true, arch: target.endsWith("arm64") ? "arm64" : "x64", ...(platform === "unix" ? { os: target.startsWith("linux") ? "linux" : "mac" } : {}) }
        : { name, platform, kind: kind === "complete" ? "files" : kind };
}

async function postKit(url: string, body: Record<string, unknown>, save: (blob: Blob, fileName: string) => void, kind: KitKind): Promise<KitDownload> {
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: JSON.stringify(body),
        });
    } catch {
        throw new KitError(0, "We couldn’t reach the platform server. Check that it is running and try again.");
    }
    if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new KitError(res.status, body.error || res.statusText || "The runner could not be made.");
    }
    const fileName = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
    const blob = await res.blob();
    const finalName = fileName ? decodeURIComponentSafe(fileName) : "runner.zip";
    save(blob, finalName);
    // The server says what it really made (an installer that was not built becomes plain files).
    const header = res.headers.get("x-runner-kit-kind");
    const made: KitKind = header === "installer" ? "installer" : header === "complete" ? "complete" : "files";
    return { fileName: finalName, tokenId: res.headers.get("x-runner-token-id"), kind: made, fellBack: kind === "installer" && made === "files", enrollmentId: res.headers.get("x-runner-enrollment-id"), expiresAt: res.headers.get("x-runner-enrollment-expires") };
}

function decodeURIComponentSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/**
 * What the person does on the chosen computer, in plain words. `note` is the alternative way in, for a Mac; `nodeHelp` is the one line for
 * "it says it cannot find Node.js but I have it": a script started by a double-click does not get the PATH a terminal has, so the
 * person is shown how to check in the terminal and to start the script from that same window. `code` words are set in a code face.
 */
export function startInstructions(platform: KitPlatform, kind: KitKind = "files", nodeMin = 24, opts: { installerInside?: boolean } = {}): { steps: string[]; command?: string; note?: string; nodeHelp: string } {
    if (kind === "complete") {
        const ready = "It starts straight away: this download already has Node.js and the test tools, so nothing is installed. Leave the window open.";
        const nodeHelp = "You do not need Node.js: this download brings its own. If the window says that Node.js does not start, you have the download for another processor: go back and choose the other one.";
        if (platform === "windows") {
            return {
                steps: ["Open the folder you unzipped.", "Double-click start-runner.cmd. If Windows says “Windows protected your PC”, choose More info, then Run anyway: the file is not signed yet.", ready],
                ...(opts.installerInside ? { note: "You can also double-click AITestingRunnerSetup.exe instead. It keeps the runner running in the background with an icon next to the clock, and downloads nothing either." } : {}),
                nodeHelp,
            };
        }
        return {
            steps: ["Open Terminal, type `cd` and a space, drag the unzipped folder into the Terminal window, and press Enter.", "Run the command below. This way macOS does not ask for permission first.", ready],
            command: "sh start-runner.sh",
            note: "On a Mac you can also double-click start-runner.command. If macOS says it could not verify the file, open System Settings, Privacy & Security and choose Open Anyway (on macOS 14 or older, right-click the file and choose Open).",
            nodeHelp,
        };
    }
    if (kind === "installer") {
        const checks = "It checks what your computer already has, and only downloads what is missing: Node.js and the test tools. You do not need to install anything first.";
        const nodeHelp = `You do not need to install Node.js first. If this computer already has Node.js ${nodeMin} or newer, the installer uses it; if not, it downloads its own copy and changes nothing else on the computer.`;
        if (platform === "windows") {
            return {
                steps: [
                    "Open the folder you unzipped.",
                    "Double-click AITestingRunnerSetup.exe. If Windows says “Windows protected your PC”, choose More info, then Run anyway: the installer is not signed yet.",
                    `Choose Install and start. ${checks}`,
                ],
                nodeHelp,
            };
        }
        return {
            steps: [
                "Open the folder you unzipped.",
                "Double-click “AI Testing Runner”. macOS will probably say it could not verify the app, because it is not signed yet: choose Done, then open System Settings, Privacy & Security, scroll down to Security and choose Open Anyway next to “AI Testing Runner”, and sign in with your Mac password (on macOS 14 or older you can right-click the app and choose Open instead).",
                `A Terminal window opens and shows what it is checking. ${checks.replace("It checks", "It looks at").replace("what your computer", "what your Mac")}`,
            ],
            note: "If macOS still refuses, open Terminal, type `xattr -dr com.apple.quarantine` and a space, drag the app into the window, and press Enter. Then double-click it again.",
            nodeHelp,
        };
    }
    if (platform === "windows") {
        return {
            steps: ["Open the folder you unzipped.", "Double-click start-runner.cmd.", "The first start downloads what it needs and can take a few minutes. Leave the window open."],
            nodeHelp: "If it says it cannot find Node.js but you have it, open Command Prompt and run `node --version` there. If that works, run start-runner.cmd from that same window.",
        };
    }
    return {
        steps: [
            "Open Terminal, type `cd` and a space, drag the unzipped folder into the Terminal window, and press Enter.",
            "Run the command below. This way macOS does not ask for permission first.",
            "The first start downloads what it needs and can take a few minutes. Leave the window open.",
        ],
        command: "sh start-runner.sh",
        note: "You can also double-click start-runner.command. If macOS says it could not verify the file, open System Settings, Privacy & Security and choose Open Anyway (on macOS 14 or older, right-click the file and choose Open).",
        nodeHelp: "If it says it cannot find Node.js but you have it, open Terminal and run `node --version` there. If that works, run start-runner.sh from that same window.",
    };
}

/**
 * Which runner is the one the person just set up. The access made for the download is the surest sign; failing that the name they typed;
 * failing that any runner that was not online when they downloaded and is now.
 */
export function findNewRunner<T extends { id: string; name: string; tokenId: string; online: boolean }>(agents: T[], opts: { tokenId: string | null; name: string; onlineBefore: ReadonlySet<string> }): T | null {
    const fresh = agents.filter((a) => a.online && !opts.onlineBefore.has(a.id));
    if (opts.tokenId) {
        const byToken = fresh.find((a) => a.tokenId === opts.tokenId);
        if (byToken) return byToken;
    }
    const wanted = opts.name.trim().toLowerCase();
    return fresh.find((a) => a.name.trim().toLowerCase() === wanted) ?? fresh[0] ?? null;
}

export const WAIT_FOR_RUNNER_MS = 3 * 60_000;
export const CONNECT_POLL_MS = 3000;

/**
 * How long to wait before saying "still waiting". Three minutes; a test shortens it with `?runnerWaitMs=` in the page address
 * (documented in docs/features/ux-add-runner.md; anything outside 500 ms to 3 minutes is ignored).
 */
export function waitLimitMs(query: URLSearchParams): number {
    const n = Number(query.get("runnerWaitMs"));
    return Number.isFinite(n) && n >= 500 && n <= WAIT_FOR_RUNNER_MS ? n : WAIT_FOR_RUNNER_MS;
}

/** The plain words for a download that failed. The server's own sentence is used when it sent one. */
export function downloadErrorText(e: unknown): { text: string; limit: boolean } {
    if (e instanceof KitError) {
        if (e.status === 409) return { text: e.message, limit: true };
        if (e.status === 503) return { text: /\bask\b/i.test(e.message) ? e.message : `${e.message} Ask whoever runs the platform to prepare the runner download.`, limit: false };
        if (e.status === 401) return { text: "The server requires an API key. Add it in Settings, then try again.", limit: false };
        return { text: e.message, limit: false };
    }
    return { text: e instanceof Error ? e.message : String(e), limit: false };
}
