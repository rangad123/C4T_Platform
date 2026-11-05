/**
 * The test workbench: types of the test answer and the plain functions behind the page (no React, so a unit test can run them).
 * Every statement the page makes about a test is computed here from what the platform stored; nothing is guessed.
 */
import type { TestSummary } from "../../api.js";
import type { EnvironmentDetail } from "../environments/environments.js";
import type { CompatDetail } from "../variants/variants.js";
import type { StepDiff } from "../builder/stepdiff.js";
import type { OriginInput } from "../provenance/provenance.js";

/** Every script has two views first, DSL (plain steps, the route `text`) and Code; then the step editor and the history. */
export const TABS = ["text", "code", "steps", "history"] as const;
export type Tab = (typeof TABS)[number];
export const TAB_LABEL: Record<Tab, string> = { text: "DSL", code: "Code", steps: "Steps", history: "History" };

/** The tab a path segment names (`#/tests/:id/<segment>`), or null when it names none. */
export const tabOf = (segment: string | undefined): Tab | null => (TABS as readonly string[]).includes(segment ?? "") ? (segment as Tab) : null;

export interface Execution {
    id: string;
    attempt: number;
    status: string;
    durationMs: number | null;
    error: string | null;
    startedAt: string;
    /** `expected` and `actual` are plain strings the platform reads from a failed check's error; absent when the error names none. */
    steps: Array<{ index: number; title: string; status: "passed" | "failed"; error: string | null; expected?: string; actual?: string }>;
    artifacts: Array<{ id: string; kind: string; pruned_at?: string | null }>;
}

export interface Detail extends TestSummary, Partial<CompatDetail>, EnvironmentDetail {
    spec: { description?: string; preconditions: string[]; steps: any[]; expectedResults: string[]; source?: { requirements?: string[]; origin?: string } };
    controls?: Array<{ id: string; framework: string; title: string }>;
    /** Only for a test that uses reusable steps: the steps that really run, each with the step of the test it belongs to. */
    runSteps?: Array<{ index: number; from: number; block?: string; step: any }>;
    quality?: { level: "good" | "weak"; reasons: string[] } | null;
    generationMeta: OriginInput["generationMeta"] & { visionObservations?: string[] };
    scripts: Array<{ id: string; framework: string; filename: string; version: number; executable: boolean; content: string; createdAt?: string }>;
    executions: Execution[];
    /** What the latest failure comes down to, when the platform can say (a failing test or a finding). */
    failure?: { kind: "mismatch" | "missing-api-token"; step?: { index: number; title: string }; expected?: string; actual?: string };
}

/** `#/tests/:id/<tab>`; the bare route opens Steps. */
export const testTabHref = (id: string, tab: Tab): string => `#/tests/${id}/${tab}`;

// ── what the last run said about each step ───────────────────────────────────

export interface StepMark {
    status: "passed" | "failed";
    error: string | null;
}

/**
 * The last run's verdict for each step of the test as listed (by position). A use of reusable steps is one listed step and
 * stands for all the steps inside it: it passed when all of them passed, and failed when any did.
 */
export function stepMarks(t: { spec: { steps: unknown[] }; runSteps?: Detail["runSteps"]; executions: Detail["executions"] }): Array<StepMark | undefined> {
    const last = t.executions[0];
    return t.spec.steps.map((_s, i) => {
        if (!last) return undefined;
        if (!t.runSteps) {
            const r = last.steps.find((s) => s.index === i);
            return r ? { status: r.status, error: r.error } : undefined;
        }
        const mine = t.runSteps.filter((r) => r.from === i).map((r) => last.steps.find((s) => s.index === r.index));
        const failed = mine.find((r) => r?.status === "failed");
        if (failed) return { status: "failed" as const, error: failed.error };
        return mine.length > 0 && mine.every((r) => r?.status === "passed") ? { status: "passed" as const, error: null } : undefined;
    });
}

/** The first non-empty line of a stored message, without colour codes, cut to a sentence. */
export const firstLineOf = (s: string | null | undefined, n = 200): string => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, n) ?? "";

const at = (iso: string | null | undefined): number => {
    const n = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(n) ? NaN : n;
};

export interface SpecVersionRow {
    version: number;
    createdAt: string;
    note: string | null;
    steps: number;
}

/**
 * Are the last run's step marks about the steps as they are now? Only when no edit was saved after that run began:
 * otherwise a mark would say "passed" about a step the person has since changed.
 */
export function marksCurrent(versions: SpecVersionRow[] | undefined, executions: Array<{ startedAt: string }>): boolean {
    const last = executions[0];
    if (!last) return false;
    if (!versions || versions.length === 0) return true;
    const newest = Math.max(...versions.map((v) => at(v.createdAt)));
    return Number.isNaN(newest) || newest <= at(last.startedAt);
}

/**
 * "Undo my last edit" is offered only when it is true: the test fails (or has a finding) now, the newest saved version of its
 * steps was made after a run that passed and before the run that did not, and an earlier version exists to go back to.
 */
export function lastEditBeforeFailure(
    t: { validationStatus: string; executions: Array<{ status: string; startedAt: string }> },
    versions: SpecVersionRow[] | undefined,
): { version: number; goBackTo: number; at: string } | null {
    if (t.validationStatus !== "FAILED_VALIDATION" && t.validationStatus !== "NEEDS_REVIEW") return null;
    const last = t.executions[0];
    if (!last || last.status === "passed" || !versions || versions.length < 2) return null;
    const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    const earlier = versions.filter((v) => v.version < newest.version);
    if (earlier.length === 0) return null;
    const goBackTo = Math.max(...earlier.map((v) => v.version));
    const made = at(newest.createdAt);
    if (Number.isNaN(made) || made > at(last.startedAt)) return null;
    // Something passed before the edit: the edit is the likely cause, and going back is a real way back.
    const passedBefore = t.executions.some((e) => e.status === "passed" && at(e.startedAt) < made);
    return passedBefore ? { version: newest.version, goBackTo, at: newest.createdAt } : null;
}

/** "2 unsaved changes": steps added, removed, changed or moved, plus changed details (name, test values). */
export function changeCount(d: StepDiff): number {
    return d.stats.added + d.stats.removed + d.stats.changed + d.stats.moved + d.details.length;
}
export const changesWord = (n: number): string => `${n} unsaved ${n === 1 ? "change" : "changes"}`;

// ── the history of one test ──────────────────────────────────────────────────

export type HistoryKind = "steps" | "text" | "code" | "restore" | "original" | "run" | "repair" | "auto-fix" | "import" | "quarantine";

export interface HistoryEntry {
    key: string;
    at: string;
    kind: HistoryKind;
    /** One line, plain words. */
    title: string;
    detail?: string;
    /** A version of the steps or of the code: it can be compared and restored. */
    version?: { family: "steps" | "code"; n: number; current: boolean };
    /** A run: how it ended and what it shows. */
    run?: { status: "passed" | "failed"; attempt: number; durationMs: number | null; evidence?: { id: string; kind: string } };
}

export interface HistoryInput {
    specVersions: SpecVersionRow[];
    codeVersions: Array<{ version: number; createdAt: string; note: string | null; kind: string; by: string | null }>;
    executions: Execution[];
    repairs: Array<{ id: string; status: string; oldDescription: string; newDescription: string; createdAt: string; decidedAt: string | null }>;
    /** From the origin strip: a test that passed on a later attempt, an import. */
    autoFix: { attempts: number; at: string | null } | null;
    imported: { text: string; at: string | null } | null;
    quarantine: Array<{ id: string; at: string; by: string; kind: string; reason?: string | null }>;
}

const CODE_KIND: Record<string, string> = { generated: "The generated script", "taken-over": "Switched to code", edited: "Code edited", git: "Imported from Git", restored: "Earlier code restored" };

/** One list, newest first, of everything that happened to a test. Entries without a date go last. */
export function buildHistory(i: HistoryInput): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    const newestSteps = i.specVersions.length ? Math.max(...i.specVersions.map((v) => v.version)) : -1;
    for (const v of i.specVersions) {
        const note = v.note ?? "";
        const kind: HistoryKind = /^Before the first edit/i.test(note) ? "original" : /^Edited as text/i.test(note) ? "text" : /^(Restored|Undid) version/i.test(note) ? "restore" : "steps";
        const title = kind === "original" ? "The steps as they were before the first edit" : kind === "text" ? "Steps edited as text" : kind === "restore" ? note : "Steps edited";
        out.push({ key: `steps-${v.version}`, at: v.createdAt, kind, title, ...(kind === "steps" || kind === "text" ? (note && kind === "steps" ? { detail: note } : {}) : {}), version: { family: "steps", n: v.version, current: v.version === newestSteps } });
    }
    const newestCode = i.codeVersions.length ? Math.max(...i.codeVersions.map((v) => v.version)) : -1;
    for (const v of i.codeVersions) {
        out.push({
            key: `code-${v.version}`,
            at: v.createdAt,
            kind: "code",
            title: CODE_KIND[v.kind] ?? "Code saved",
            ...(v.note || v.by ? { detail: [v.note, v.by ? `by ${v.by}` : ""].filter(Boolean).join(", ") } : {}),
            version: { family: "code", n: v.version, current: v.version === newestCode },
        });
    }
    for (const e of i.executions) {
        const evidence = e.status !== "passed" ? e.artifacts.filter((a) => !a.pruned_at).find((a) => a.kind === "screenshot" || a.kind === "visual-diff") : undefined;
        out.push({
            key: `run-${e.id}`,
            at: e.startedAt,
            kind: "run",
            title: e.status === "passed" ? "Run passed" : "Run did not pass",
            run: { status: e.status === "passed" ? "passed" : "failed", attempt: e.attempt, durationMs: e.durationMs, ...(evidence ? { evidence: { id: evidence.id, kind: evidence.kind } } : {}) },
        });
    }
    for (const r of i.repairs) {
        if (r.status === "proposed") continue;
        out.push({
            key: `repair-${r.id}`,
            at: r.decidedAt ?? r.createdAt,
            kind: "repair",
            title: r.status === "applied" ? "Repair applied" : "Repair dismissed",
            detail: r.status === "applied" ? `${r.oldDescription} is now found as ${r.newDescription}` : `A suggestion for ${r.oldDescription} was dismissed`,
        });
    }
    if (i.autoFix) out.push({ key: "auto-fix", at: i.autoFix.at ?? "", kind: "auto-fix", title: `Auto-fixed during creation: it passed on attempt ${i.autoFix.attempts}` });
    if (i.imported) out.push({ key: "import", at: i.imported.at ?? "", kind: "import", title: i.imported.text });
    for (const q of i.quarantine) out.push({ key: `q-${q.id}`, at: q.at, kind: "quarantine", title: `${q.by} ${q.kind}`, ...(q.reason ? { detail: q.reason } : {}) });
    return out.sort((a, b) => (at(b.at) || 0) - (at(a.at) || 0));
}

/** Two versions of the same family can be compared; the answer says which two and in which order (older first). */
export function comparePair(
    picked: Array<{ family: "steps" | "code"; n: number }>,
    /** The newest version of each kind: one version ticked is compared with it. */
    newest: { steps?: number; code?: number } = {},
): { family: "steps" | "code"; from: number; to: number } | { problem: string } | null {
    if (picked.length === 1) {
        const only = picked[0]!;
        const latest = newest[only.family];
        return latest !== undefined && latest !== only.n ? { family: only.family, from: Math.min(only.n, latest), to: Math.max(only.n, latest) } : null;
    }
    if (picked.length < 2) return null;
    const [a, b] = picked.slice(-2) as [(typeof picked)[number], (typeof picked)[number]];
    if (a.family !== b.family) return { problem: "Steps and code cannot be compared with each other. Pick two versions of the same kind." };
    return { family: a.family, from: Math.min(a.n, b.n), to: Math.max(a.n, b.n) };
}
