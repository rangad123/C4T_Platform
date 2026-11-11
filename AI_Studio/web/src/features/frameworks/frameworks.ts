/** Types and wording for the Frameworks section of a project's settings (API: GET/PUT /projects/:id/framework-settings). */

export type FrameworkId = "playwright" | "playwright-api" | "taqwright" | "windows-uia" | "taqwright-ios";

export interface FrameworkSettings {
    enabled: Record<FrameworkId, boolean>;
    web: { headless: boolean; workers: number | null; testTimeoutSeconds: number };
    api: { testTimeoutSeconds: number };
    android: { keepEmulator: boolean; defaultAvd: string; testTimeoutSeconds: number };
    windows: { testTimeoutSeconds: number; startTimeoutSeconds: number };
    ios: { keepSimulator: boolean; defaultSimulator: string; testTimeoutSeconds: number };
}

export interface FrameworkAdapterInfo {
    id: FrameworkId;
    label: string;
    enabled: boolean;
    available: { platform: boolean; agent: boolean | null; reason?: string };
}

export interface SettingsChange {
    id: number;
    at: string;
    by: string | null;
    summary: string;
}

export interface FrameworkSettingsAnswer {
    settings: FrameworkSettings;
    effective: { web: { headless: boolean; workers: number; workersLimit: number | null; testTimeoutSeconds: number }; notes: string[] };
    adapters: FrameworkAdapterInfo[];
    runner: { runOn: "platform" | "agent"; agentName?: string };
    defaults: FrameworkSettings;
    limits: { timeoutSeconds: { min: number; max: number }; workers: { min: number; max: number }; startTimeoutSeconds: { min: number; max: number }; platformWorkers: number };
    avds: string[];
    changes: SettingsChange[];
    /** Present on a save: what clamping moved, in words. */
    adjusted?: string[];
}

export const FRAMEWORK_NAME: Record<FrameworkId, string> = {
    playwright: "Web tests",
    "playwright-api": "API tests",
    taqwright: "Android tests",
    "windows-uia": "Windows desktop tests",
    "taqwright-ios": "iOS tests",
};

const NOUN: Record<FrameworkId, string> = { playwright: "web", "playwright-api": "API", taqwright: "Android", "windows-uia": "Windows", "taqwright-ios": "iOS" };

/** "Ready on this server", "Ready on Maya's laptop", "Needs Windows", "Needs an Android emulator". */
export function availabilityLine(a: FrameworkAdapterInfo, runner: FrameworkSettingsAnswer["runner"]): { text: string; ok: boolean } {
    if (runner.runOn === "agent") {
        const who = runner.agentName ?? "the runner";
        if (a.available.agent === null) return { text: "No runner is connected", ok: false };
        if (a.available.agent) return { text: `Ready on ${who}`, ok: true };
        if (a.id === "taqwright") return { text: `Needs an Android emulator or phone on ${who}`, ok: false };
        if (a.id === "windows-uia") return { text: `Needs Windows on ${who}`, ok: false };
        if (a.id === "taqwright-ios") return { text: `Needs a Mac with Xcode on ${who}`, ok: false };
        return { text: `Needs a browser on ${who}`, ok: false };
    }
    if (a.available.platform) return { text: "Ready on this server", ok: true };
    if (a.id === "taqwright") return { text: "Needs an Android emulator", ok: false };
    if (a.id === "taqwright-ios") return { text: "Needs a runner on a Mac", ok: false };
    if (a.id === "windows-uia") return { text: /Windows computer/.test(a.available.reason ?? "") ? "Needs Windows" : "Needs Windows UI Automation", ok: false };
    return { text: "Not available on this server", ok: false };
}

/** One quiet sentence for the Tests page, or "" when everything is as the platform always did. */
export function settingsSentence(s: FrameworkSettings, d: FrameworkSettings): string {
    const parts: string[] = [];
    const off = (Object.keys(s.enabled) as FrameworkId[]).filter((id) => !s.enabled[id]);
    if (off.length) parts.push(`${off.map((id) => NOUN[id]).join(" and ")} tests are turned off`);
    if (s.web.testTimeoutSeconds !== d.web.testTimeoutSeconds) parts.push(`web tests stop after ${s.web.testTimeoutSeconds} s`);
    if (s.api.testTimeoutSeconds !== d.api.testTimeoutSeconds) parts.push(`API tests stop after ${s.api.testTimeoutSeconds} s`);
    if (s.android.testTimeoutSeconds !== d.android.testTimeoutSeconds) parts.push(`Android tests stop after ${s.android.testTimeoutSeconds} s`);
    if (s.ios.testTimeoutSeconds !== d.ios.testTimeoutSeconds) parts.push(`iOS tests stop after ${s.ios.testTimeoutSeconds} s`);
    if (s.windows.testTimeoutSeconds !== d.windows.testTimeoutSeconds) parts.push(`Windows tests stop after ${s.windows.testTimeoutSeconds} s`);
    if (!s.web.headless) parts.push("the browser window is visible on a runner");
    if (s.web.workers !== null) parts.push(`at most ${s.web.workers} browser worker${s.web.workers === 1 ? "" : "s"}`);
    const text = parts.join(", ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
