/**
 * The switch of smaller page snapshots (docs/features/smaller-snapshots.md): on by default; `LLM_COMPACT_SNAPSHOTS=false` (or off/0/no)
 * turns it off; a choice saved in Settings (AI model) wins over both. The platform installs where the saved choice is read
 * (platform/snapshot-setting.ts). It is read when an authoring session or a phone exploration starts, so a change applies to the next one.
 */
import type { Config } from "../../config.js";

export type SnapshotSettingSource = "app" | "environment" | "default";

/** An environment value: on unless it says off. */
export const envCompactSnapshots = (value: string | undefined): boolean => !/^\s*(false|off|0|no)\s*$/i.test(value ?? "");

let appSource: (() => boolean | undefined) | undefined;
/** Where the Settings choice is read (`undefined` from it: nobody chose in the app). */
export function setCompactSnapshotSource(fn: (() => boolean | undefined) | undefined): void {
    appSource = fn;
}

export function compactSnapshotSetting(cfg: Partial<Pick<Config, "LLM_COMPACT_SNAPSHOTS">> | undefined): { enabled: boolean; source: SnapshotSettingSource } {
    let fromApp: boolean | undefined;
    try {
        fromApp = appSource?.();
    } catch {
        fromApp = undefined;
    }
    if (fromApp !== undefined) return { enabled: fromApp, source: "app" };
    const env = cfg?.LLM_COMPACT_SNAPSHOTS;
    if ((env ?? "").trim()) return { enabled: envCompactSnapshots(env), source: "environment" };
    return { enabled: true, source: "default" };
}

export const compactSnapshotsOn = (cfg: Partial<Pick<Config, "LLM_COMPACT_SNAPSHOTS">> | undefined): boolean => compactSnapshotSetting(cfg).enabled;

/** The job event an authoring session or phone exploration writes with its snapshot counts; the usage answer adds them up (platform/routes/usage.ts). */
export const EVENT_SNAPSHOT_SAVINGS = "snapshot_savings";
