/** Storage and backup: shapes the API answers with, and the small pure helpers the screens use. */
import { formatBytes } from "../../lib/format.js";

export const KINDS = ["screenshot", "video", "trace", "evidence", "report", "apk", "baseline", "script", "other"] as const;
export type StorageKind = (typeof KINDS)[number];

export const STORAGE_KIND_LABELS: Record<StorageKind, string> = {
    video: "Recordings",
    screenshot: "Screenshots",
    trace: "Detailed traces",
    evidence: "Network and console records",
    report: "Reports and models",
    apk: "Android apps",
    baseline: "Approved screenshots",
    script: "Test scripts",
    other: "Other files",
};

/** Not colour alone: every kind of file also has its name and size in the list under the bar. Tones come from the shared tick tokens. */
export const KIND_COLOUR: Record<StorageKind, string> = {
    video: "var(--text-secondary)",
    screenshot: "var(--tick-pass)",
    trace: "var(--tick-attention)",
    evidence: "var(--status-info-fg)",
    report: "var(--text-muted)",
    apk: "var(--tick-fail)",
    baseline: "var(--accent-600)",
    script: "var(--border-strong)",
    other: "var(--tick-idle)",
};

export interface KindUsage {
    files: number;
    bytes: number;
    text: string;
}
export interface Usage {
    bytes: number;
    text: string;
    files: number;
    byKind: Record<StorageKind, KindUsage>;
}

export interface PlatformStorage {
    generatedAt: string;
    truncated: boolean;
    database: { bytes: number; text: string };
    files: Usage;
    disk: { freeBytes: number; totalBytes: number; freeText: string; totalText: string } | null;
    projectCount: number;
    projects: Array<Usage & { id: string; name: string; retention: { enabled: boolean } | null }>;
    other: Usage;
    platformDefaultDays: number | null;
}

export interface ProjectStorage {
    project: { id: string; name: string };
    generatedAt: string;
    truncated: boolean;
    usage: Usage;
    removed: { files: number; bytes: number; text: string };
    retention: { enabled: boolean; source: "project" | "platform" | "default" };
    needsSecrets: Array<{ id: number; kind: string; label: string; detail: string | null }>;
    /** Round 21: the project has security assessment data (a backup can leave it out for an older platform). Absent on older servers. */
    securityData?: boolean;
}

export interface Policy {
    enabled: boolean;
    keepDays: number;
    keepFailedDays: number;
    keepLatestRuns: number;
    maxArtifactMB: number | null;
}

export interface RetentionState {
    policy: Policy;
    source: "project" | "platform" | "default";
    platformDefaultDays: number | null;
    limits: Record<"keepDays" | "keepFailedDays" | "keepLatestRuns" | "maxArtifactMB", { min: number; max: number; default?: number }>;
    busy: boolean;
    recent: Array<{ id: number; at: string; trigger: "manual" | "scheduled"; files: number; bytes: number; errors: number; errorSample: string | null }>;
}

export interface Preview {
    enabled: boolean;
    files: number;
    bytes: number;
    size: string;
    oldest: string | null;
    newest: string | null;
    byKind: Record<string, { files: number; bytes: number }>;
    kept: Record<string, number>;
    sentence: string;
    sample: Array<{ id: string; kind: string; size: number; test: string | null }>;
    sampleOf: number;
}

export interface RestoreResult {
    project: { id: string; name: string };
    restored: Record<string, number>;
    needsSecrets: Array<{ kind: string; label: string; detail?: string }>;
    notes: string[];
    message: string;
}

export interface BarSegment {
    kind: StorageKind;
    bytes: number;
    percent: number;
}

/** The kinds that use space, largest first, as shares of the total (they add up to 100). */
export function sizeBar(byKind: Record<StorageKind, number>): BarSegment[] {
    const total = KINDS.reduce((n, k) => n + (byKind[k] ?? 0), 0);
    if (total <= 0) return [];
    return KINDS.filter((k) => (byKind[k] ?? 0) > 0)
        .map((k) => ({ kind: k, bytes: byKind[k], percent: (byKind[k] / total) * 100 }))
        .sort((a, b) => b.bytes - a.bytes);
}

const FILE_NAMES: Record<string, string> = {
    screenshot: "screenshot",
    video: "recording",
    trace: "detailed trace",
    evidence: "list of network calls and console messages",
    "visual-actual": "new screenshot",
    "visual-diff": "comparison image",
    "vision-shot": "screenshot",
};
export const fileLabel = (kind: string): string => FILE_NAMES[kind] ?? "file";

const formatDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "an unknown date" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/** "This recording was removed to save space on Oct 5, 2026." (the same sentence the server uses). */
export const prunedNote = (kind: string, prunedAt: string): string => `This ${fileLabel(kind)} was removed to save space on ${formatDate(prunedAt)}.`;

/** What a run of the cleanup did, in words, for the history list. */
export function logLine(r: { trigger: "manual" | "scheduled"; files: number; bytes: number; errors: number }): string {
    const what = r.files === 0 ? "Nothing needed removing" : `Removed ${r.files} ${r.files === 1 ? "file" : "files"} (${formatBytes(r.bytes)})`;
    const problems = r.errors ? `, ${r.errors} could not be removed` : "";
    return `${what}${problems}, ${r.trigger === "scheduled" ? "by the daily pass" : "by you"}`;
}
