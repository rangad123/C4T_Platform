/**
 * Start-up time: how long the app takes to show its first screen from a cold start (its process stopped first), as Android itself measures it
 * (`am start -S -W -n <launcher activity>`, the TotalTime line). One measurement per exploration or test run, compared with the project's budget.
 */
import type { StartupMeasure } from "./types.js";

/** The project's budget when none is set: 5 s, a generous limit for a cold start on an emulator. */
export const DEFAULT_STARTUP_BUDGET_MS = 5000;
export const MIN_STARTUP_BUDGET_MS = 500;
export const MAX_STARTUP_BUDGET_MS = 60_000;

const COMPONENT = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/((?:\.)?[A-Za-z][A-Za-z0-9_$]*(?:\.[A-Za-z][A-Za-z0-9_$]*)*)$/;

/** Is this `package/activity` safe to pass to `am start -n` (letters, digits, dots, underscores; no spaces, no options)? */
export function isComponent(s: string): boolean {
    return s.length <= 300 && COMPONENT.test(s);
}

/** The launcher activity from `cmd package resolve-activity --brief`: the last line, when it is a component of this package. */
export function launcherFromResolve(text: string, appPackage: string): string | undefined {
    const last = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
    if (!last || !isComponent(last)) return undefined;
    return last.slice(0, last.indexOf("/")) === appPackage ? last : undefined;
}

/** Parses `am start -W`. Undefined when the start did not work or no time was reported. */
export function parseStartOutput(text: string): StartupMeasure | undefined {
    if (/^Error\b/m.test(text) || /Status:\s*(timeout|error)/i.test(text)) return undefined;
    const total = /^\s*TotalTime:\s*(\d{1,7})\s*$/m.exec(text)?.[1];
    if (total === undefined) return undefined;
    const wait = /^\s*WaitTime:\s*(\d{1,7})\s*$/m.exec(text)?.[1];
    const state = /^\s*LaunchState:\s*([A-Z]{3,12})\s*$/m.exec(text)?.[1];
    return { totalMs: Number(total), ...(wait !== undefined ? { waitMs: Number(wait) } : {}), ...(state ? { launchState: state } : {}) };
}

export const clampBudget = (ms: number | undefined): number => (ms === undefined || !Number.isFinite(ms) ? DEFAULT_STARTUP_BUDGET_MS : Math.round(Math.min(MAX_STARTUP_BUDGET_MS, Math.max(MIN_STARTUP_BUDGET_MS, ms))));

/** "7.4 s" / "850 ms". */
export function formatMs(ms: number): string {
    return ms >= 1000 ? `${(Math.round(ms / 100) / 10).toString()} s` : `${Math.round(ms)} ms`;
}
