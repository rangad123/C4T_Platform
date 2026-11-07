/** Types and wording for runner agents (the API shapes are fixed in .scratch/briefs/AGENT-API-SHAPES.md). */
import { useEffect } from "react";
import { useFetch, type Fetched } from "../../lib/hooks.js";

/** What a runner reports about its network (docs/features/company-networks.md). The proxy is host:port only: never a user name or password. */
export interface RunnerNetwork {
    proxy?: string;
    proxySource?: "flag" | "env" | "file" | "windows";
    proxyTests?: boolean;
    certificates?: Array<"system" | "file" | "extra">;
    problem?: string;
    problemAt?: string;
}

/** A runner's updates, as the platform shows them on its row (docs/features/runner-updates.md). Present for a runner started from a download. */
export interface RunnerUpdateView {
    /** The runner can replace its own files (a download from the version with updates on). */
    can: boolean;
    auto: boolean;
    /** The platform's runner version. */
    latest?: string;
    outOfDate: boolean;
    requested: boolean;
    /** "needs-manual": an update exists but its signature could not be checked on that computer, so it must be downloaded by hand. */
    state?: "idle" | "preparing" | "ready" | "updated" | "failed" | "rolled-back" | "needs-manual";
    /** false when this platform offers no signed update (the reason in `unpublished`). */
    published?: boolean;
    unpublished?: string;
    from?: string;
    to?: string;
    error?: string;
    at?: string;
    retryAt?: string;
}

/** The runner's "Check this computer" (docs/features/runner-check.md): never a token, a password or a path. */
export interface RunnerCheck {
    at: string;
    items: Array<{ id: string; status: "ok" | "missing" | "optional"; title: string; fix?: string }>;
}

export interface AgentToken {
    id: string;
    label: string | null;
    /** A fingerprint such as "aitg_…x7Qd". The token itself is shown once, when it is made. */
    hint: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    /** Given to this project from outside it (a runner of the organisation or a shared machine): the access list above manages it. */
    shared?: boolean;
}

export interface AndroidDevice {
    serial: string;
    model?: string;
    state: string;
    emulator: boolean;
}

export interface Agent {
    id: string;
    name: string;
    version: string;
    tokenId: string;
    os: "win32" | "darwin" | "linux";
    arch: string;
    node: string;
    online: boolean;
    lastSeenAt: string;
    firstSeenAt: string;
    activeTasks: number;
    concurrency: number;
    /** Runner updates (only for a runner started from a download). */
    update?: RunnerUpdateView;
    capabilities: {
        browsers: Array<"chromium" | "firefox" | "webkit">;
        /** Version of the downloaded runner kit; only a runner started from a kit reports one (the platform sends it inside capabilities). */
        kitVersion?: string;
        /** The runner's proxy (host:port), trusted certificates and last network problem (newer runners only; see network.tsx). */
        network?: RunnerNetwork;
        /** "Check this computer": what the runner found when it started, one line per item (newer runners only; see check.tsx). */
        check?: RunnerCheck;
        /** The browser web tests use on this runner, the Chrome and Edge it found, and a sentence while none is ready (newer runners only). */
        browser?: WebBrowserUsed;
        installedBrowsers?: Array<{ name: "chrome" | "msedge"; version?: string; usable: boolean; reason?: string }>;
        browserNote?: string;
        /** `summary` is the platform's own sentence (from the rule that decides whether phone tests can run), so the card and the setting agree. */
        android?: { adb: boolean; devices: AndroidDevice[]; avds: string[]; state?: "no-tools" | "phone" | "emulator" | "none"; summary?: string };
        /** True (or a description) when this runner can let the AI explore a phone app. Absent on a runner started before phone exploration. */
        deviceSession?: boolean | { android?: boolean };
        /** The runner's own Android phone tools (newer runners started from a download only): it fetches Google's adb when a phone session needs it. */
        phoneTools?: { state: "ready" | "can-fetch" | "fetching" | "failed" | "off" | "unsupported"; version?: string; note?: string };
        ios?: { xcode: boolean; simulators: string[] };
        windows?: { winappdriver?: boolean; uiautomation?: boolean; interactive?: boolean; elevated?: boolean; allowedApps?: string[] };
    };
}

export interface RunnerChoice {
    runOn: "platform" | "agent";
    agentId: string | null;
    /** One plain sentence, for example "Runs on Maya's laptop (online)." */
    status: string;
    canRunWeb: boolean;
    canRunMobile: boolean;
    /** One sentence about phone tests that agrees with the agent card (present from a server that has it). */
    phones?: { canRun: boolean; text: string };
    /** Present from a server that supports iOS tests. */
    canRunIos?: boolean;
    unavailableReason: string | null;
}

import type { RanOn, WebBrowserUsed } from "../../api.js";
export type { RanOn, WebBrowserUsed };

const WEB_BROWSER_LABEL: Record<WebBrowserUsed["name"], string> = { chromium: "Chromium", chrome: "Google Chrome", msedge: "Microsoft Edge" };

/** "Microsoft Edge 155", from a full version such as 155.0.4283.62. */
export function browserName(b: { name: WebBrowserUsed["name"]; version?: string }): string {
    const major = /^(\d{1,4})\./.exec(b.version ?? "")?.[1];
    return `${WEB_BROWSER_LABEL[b.name]}${major ? ` ${major}` : ""}`;
}

/** "Microsoft Edge 155, installed on Maya's laptop" (the runner's window says the same about "this computer"). */
export function browserSentence(b: WebBrowserUsed, where: string): string {
    if (b.source === "installed") return `${browserName(b)}, installed on ${where}`;
    if (b.source === "downloaded") return `${browserName(b)}, downloaded by the runner`;
    return `${browserName(b)}, the browser that comes with the test tools`;
}

export const OS_LABEL: Record<Agent["os"], string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const BROWSER_LABEL = { chromium: "Chromium", firefox: "Firefox", webkit: "WebKit" } as const;
const POLL_MS = 5000;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Chromium, Firefox, WebKit. Android: 2 devices, 1 emulator." */
export function capabilitySummary(c: Agent["capabilities"]): string {
    const browsers = c.browsers.length ? c.browsers.map((b) => BROWSER_LABEL[b]).join(", ") : "No browsers installed";
    let android = "";
    if (c.android) {
        const d = c.android.devices;
        if (c.android.summary) return `${browsers}. ${c.android.summary}.`;
        const emulators = d.filter((x) => x.emulator).length;
        if (!c.android.adb) android = "Android: adb not found";
        else if (d.length === 0) android = "Android: no devices connected";
        else android = `Android: ${count(d.length, "device")}${emulators ? `, ${count(emulators, "emulator")}` : ""}`;
    }
    return `${browsers}.${android ? ` ${android}.` : ""}`;
}

/** What adb calls a state, in words a person would use. */
export function deviceState(state: string): string {
    if (state === "device") return "Ready";
    if (state === "offline") return "Offline";
    if (state === "unauthorized") return "Waiting for permission on the phone";
    return state;
}

/** The runner's own Android phone tools, in one plain sentence. */
export function phoneToolsSentence(p: NonNullable<Agent["capabilities"]["phoneTools"]>): string {
    if (p.state === "ready") return `The runner got Google's Android phone tools (adb${p.version ? ` ${p.version}` : ""}) into its own folder. Plug in a phone with USB debugging on.`;
    if (p.state === "can-fetch") return "Not on this computer yet. The runner gets Google's Android phone tools (adb, about 7 to 15 MB) itself when a phone session needs them. A phone needs USB debugging on.";
    if (p.state === "fetching") return "The runner is getting Google's Android phone tools now.";
    return p.note ?? "The runner can't get the Android phone tools on this computer.";
}

/** The command to run on the machine. Pass the token while it is on screen, otherwise a placeholder is shown. */
export function agentCommand(origin: string, token?: string): string {
    return `node bin/ai-test-agent.mjs --url ${origin} --token ${token ?? "<your token>"}`;
}

/** What a runner whose update could not be checked shows, on its page, in the list and on its row. */
export const NEEDS_MANUAL_UPDATE = "An update is available but couldn't be checked on this computer. Download the new version from Add this computer.";

/** Sentence for the "where did it run" line. */
export function ranOnSentence(r: RanOn): string {
    return r.kind === "platform" ? "Ran on this server" : `Ran on ${r.name}`;
}

/**
 * Fetch `path` every few seconds while the page is visible. Polling stops when the tab is hidden and
 * picks up again, with an immediate refresh, when it is shown (the same useFetch pattern the other pages use).
 */
export function usePolled<T>(path: string | null, everyMs: number = POLL_MS): Fetched<T> {
    const f = useFetch<T>(path, () => (document.hidden ? null : everyMs));
    const { reload } = f;
    useEffect(() => {
        const on = () => {
            if (!document.hidden) void reload();
        };
        document.addEventListener("visibilitychange", on);
        return () => document.removeEventListener("visibilitychange", on);
    }, [reload]);
    return f;
}
