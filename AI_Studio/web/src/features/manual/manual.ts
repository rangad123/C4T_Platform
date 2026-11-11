/** Types of the manual-cases and releases API, and the small pure helpers the pages use. */
import type { Tone } from "../../lib/labels";

export type Priority = "critical" | "high" | "medium" | "low";
export type Result = "not_run" | "passed" | "failed" | "blocked" | "skipped";
export type Readiness = "ready" | "needs-attention" | "blocked" | "unknown";
type Tick = "pass" | "attention" | "fail" | "idle";

export interface Step {
    action: string;
    expected: string;
}

/** Whether a written case can be checked by a tool (a test script can be made from it) or needs a person. */
export type Automation = "automated" | "manual";
export const AUTOMATION_WORDS: Record<Automation, string> = { automated: "Automated", manual: "Manual" };
export const AUTOMATION_HINT: Record<Automation, string> = {
    automated: "A tool can do its steps and check its results, so a test script can be made from it.",
    manual: "A person does it by hand: how something looks, a printout, a device, a judgement call.",
};

export interface ManualCase {
    id: string;
    /** TC-001: the id people read, from the case's number in its project. */
    ref: string;
    number: number;
    automation: Automation;
    /** The requirement record the case comes from (Requirements place). */
    requirementId: string | null;
    title: string;
    area: string;
    priority: Priority;
    requirement: string;
    steps: Step[];
    linkedTestIds: string[];
    createdAt: string;
    updatedAt: string;
}

export interface CaseList {
    cases: ManualCase[];
    total: number;
    max: number;
    areas: string[];
}

export interface CaseInput {
    title: string;
    area: string;
    priority: Priority;
    requirement: string;
    steps: Step[];
    linkedTestIds: string[];
    automation: Automation;
    requirementId: string | null;
}

export interface ImportResult {
    created: number;
    duplicates: number;
    skipped: Array<{ row: number; reason: string }>;
    total: number;
}

export interface ViewItem {
    id: string;
    title: string;
    area: string;
    priority: Priority;
    requirement: string;
    steps: Step[];
    linkedTestIds: string[];
    result: Result;
    note: string;
    by: string;
    at: string | null;
    issue: { provider: string; externalId: string; url: string } | null;
}

export interface Rollup {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    notRun: number;
    left: number;
    done: number;
}

export interface Reason {
    code: string;
    text: string;
}

export interface AuditEntry {
    id: number;
    at: string;
    kind: "approved" | "rejected" | "reopened";
    by: string;
    comment: string;
    override: boolean;
}

export interface Automated {
    takenAt: string;
    readiness: { state: Readiness; label: string; reasons: Reason[]; stale: boolean };
    tests: { total: number; validated: number; needsAttention: number; couldNotValidate: number; waiting: number };
    /** sentence and others say what the pass rate is made of and what it leaves out (absent in releases signed before they existed). */
    latestRun: { passRate: number | null; finishedAt: string; sentence?: string; others?: string } | null;
    findings: { critical: number; high: number; medium: number; low: number; highOrCritical: number };
    flaky: number;
    apiBreakingChanges: number;
}

export interface ReleaseView {
    id: string;
    projectId: string;
    name: string;
    notes: string;
    status: "open" | "approved" | "rejected";
    decision: "approved" | "rejected" | null;
    createdAt: string;
    signedAt: string | null;
    signedBy: string | null;
    frozen: boolean;
    /** Which written cases the release lists: the Manual ones and the Automated ones without a script (releases made now), or every case (made before). */
    cases?: "every-case" | "manual-and-unscripted";
    sentence: string;
    automated: Automated;
    manual: { rollup: Rollup; items: ViewItem[] };
    signoff: { blocking: Reason[]; warnings: Reason[]; canApprove: boolean; rules: { blocking: string[]; warnings: string[]; override: string; immutable: string } };
    audit: AuditEntry[];
}

export interface ReleaseSummary {
    id: string;
    name: string;
    notes: string;
    status: "open" | "approved" | "rejected";
    decision: "approved" | "rejected" | null;
    createdAt: string;
    signedAt: string | null;
    signedBy: string | null;
    sentence: string;
    readiness: Readiness;
    rollup: Rollup;
}

export const PRIORITY_LABEL: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
export const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

export const RESULTS: Result[] = ["not_run", "passed", "failed", "blocked", "skipped"];
export const RESULT_LABEL: Record<Result, string> = { not_run: "Not run", passed: "Passed", failed: "Failed", blocked: "Blocked", skipped: "Skipped" };

/** `help`: what the decision means (src/platform/manual-releases.ts: a signed release is frozen until it is reopened). */
export const DECISION_BADGE: Record<ReleaseSummary["status"], { label: string; tone: Tone; help: string }> = {
    open: { label: "Open", tone: "info", help: "Nobody has signed it yet: new results and manual checks still count until someone approves or rejects it." },
    approved: { label: "Approved", tone: "success", help: "Someone approved this release. What it showed then is kept, and it cannot change unless it is reopened." },
    rejected: { label: "Rejected", tone: "danger", help: "Someone rejected this release. What it showed then is kept, and it cannot change unless it is reopened." },
};

export const READINESS_TONE: Record<Readiness, Tone> = { ready: "success", "needs-attention": "warning", blocked: "danger", unknown: "neutral" };

export const MAX_STEPS = 30;
export const MIN_OVERRIDE = 10;

/** Items grouped by area, in the order the server sent them (areas alphabetical, most important first inside an area). */
export function groupByArea<T extends { area: string }>(items: T[]): Array<[string, T[]]> {
    const out: Array<[string, T[]]> = [];
    for (const item of items) {
        const group = out.find(([area]) => area === item.area);
        if (group) group[1].push(item);
        else out.push([item.area, [item]]);
    }
    return out;
}

/** The manual run as ribbon ticks: passed, blocked, failed, and everything not decided yet. Skipped counts as decided. */
export function manualTicks(r: Rollup): Tick[] {
    const rep = (t: Tick, n: number) => Array.from({ length: n }, () => t);
    return [...rep("pass", r.passed + r.skipped), ...rep("attention", r.blocked), ...rep("fail", r.failed), ...rep("idle", r.notRun)];
}

/** "Dana approved this release" for the history list. */
export function auditSentence(e: Pick<AuditEntry, "kind" | "by" | "override">): string {
    const verb = e.kind === "approved" ? (e.override ? "approved this release with an override" : "approved this release") : e.kind === "rejected" ? "rejected this release" : "reopened this release";
    return `${e.by} ${verb}`;
}

/** The sentence under a signed release's title. */
export function signedSentence(v: Pick<ReleaseView, "decision" | "signedBy" | "signedAt">, fmt: (iso: string) => string): string {
    if (!v.decision || !v.signedBy || !v.signedAt) return "";
    return `${v.decision === "approved" ? "Approved" : "Rejected"} by ${v.signedBy}, ${fmt(v.signedAt)}`;
}

const NAME_KEY = "aitp.manual.name";
/** The name the person last used, so they type it once. Storage can be blocked: never fail because of it. */
export function savedName(): string {
    try {
        return localStorage.getItem(NAME_KEY) ?? "";
    } catch {
        return "";
    }
}
export function saveName(name: string): void {
    try {
        localStorage.setItem(NAME_KEY, name);
    } catch {
        /* a blocked store only means the name is not remembered */
    }
}
