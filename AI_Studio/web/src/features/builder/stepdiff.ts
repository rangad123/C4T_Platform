/**
 * Step-level difference between two versions of a test (no React, so a plain test can run it).
 *
 * Steps have no ids, so they are matched by content: a longest common run of identical steps stays "unchanged"; between those
 * anchors a removed step and an added step of the same kind of action are shown as one "changed" step (what the person edited),
 * and an identical removed/added pair is a "moved" step. Everything else is plainly added or removed.
 */
import { FIELDS, fieldsFor, type Step } from "./builder.js";

export interface Snapshot {
    title: string;
    testData?: Record<string, string>;
    steps: Step[];
}

export type StepRow =
    | { kind: "same"; before: number; after: number; step: Step }
    | { kind: "added"; after: number; step: Step }
    | { kind: "removed"; before: number; step: Step }
    | { kind: "moved"; before: number; after: number; step: Step }
    | { kind: "changed"; before: number; after: number; from: Step; to: Step; fields: string[] };

export interface DetailChange {
    what: string;
    kind: "added" | "removed" | "changed";
    from?: string;
    to?: string;
}

export interface StepDiff {
    rows: StepRow[];
    details: DetailChange[];
    stats: { added: number; removed: number; changed: number; moved: number };
    /** True when nothing differs at all. */
    same: boolean;
}

/** Same value, whatever the order of keys. */
export const canon = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1))) : val));

/** Plain names for the parts of a step that differ, using the field labels the editor shows. */
export function changedFields(from: Step, to: Step): string[] {
    const labels = new Map<string, string>();
    for (const s of [from, to]) {
        for (const f of fieldsFor(s)) labels.set(f.name, f.label);
        for (const f of FIELDS[s.action] ?? []) if (!labels.has(f.name)) labels.set(f.name, f.label);
    }
    labels.set("description", "Note");
    labels.set("check", "What to check");
    const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
    const out: string[] = [];
    for (const k of keys) {
        if (k === "action") continue;
        if (canon(from[k]) !== canon(to[k])) out.push(labels.get(k) ?? k);
    }
    return out;
}

export function diffSteps(before: Snapshot, after: Snapshot): StepDiff {
    const a = before.steps.map(canon);
    const b = after.steps.map(canon);

    // longest common subsequence table
    const n = a.length;
    const m = b.length;
    const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);

    const rows: StepRow[] = [];
    const flush = (removed: number[], added: number[]) => {
        let j = 0;
        for (const r of removed) {
            const k = added.findIndex((x, idx) => idx >= j && after.steps[x]!.action === before.steps[r]!.action);
            if (k < 0) {
                rows.push({ kind: "removed", before: r + 1, step: before.steps[r]! });
                continue;
            }
            for (; j < k; j++) rows.push({ kind: "added", after: added[j]! + 1, step: after.steps[added[j]!]! });
            const to = after.steps[added[k]!]!;
            const from = before.steps[r]!;
            rows.push({ kind: "changed", before: r + 1, after: added[k]! + 1, from, to, fields: changedFields(from, to) });
            j = k + 1;
        }
        for (; j < added.length; j++) rows.push({ kind: "added", after: added[j]! + 1, step: after.steps[added[j]!]! });
    };

    let i = 0;
    let j = 0;
    let removed: number[] = [];
    let added: number[] = [];
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            flush(removed, added);
            removed = [];
            added = [];
            rows.push({ kind: "same", before: i + 1, after: j + 1, step: after.steps[j]! });
            i++;
            j++;
        } else if (j >= m || (i < n && t[i + 1]![j]! >= t[i]![j + 1]!)) {
            removed.push(i++);
        } else {
            added.push(j++);
        }
    }
    flush(removed, added);

    // A step that only changed place shows once, as moved, instead of as one removal and one addition.
    for (let x = 0; x < rows.length; x++) {
        const r = rows[x]!;
        if (r.kind !== "removed") continue;
        const y = rows.findIndex((o) => o.kind === "added" && canon(o.step) === canon(r.step));
        if (y < 0) continue;
        const add = rows[y] as Extract<StepRow, { kind: "added" }>;
        rows[y] = { kind: "moved", before: r.before, after: add.after, step: add.step };
        rows.splice(x, 1);
        x--;
    }

    const details: DetailChange[] = [];
    if (before.title !== after.title) details.push({ what: "Test name", kind: "changed", from: before.title, to: after.title });
    const bd = before.testData ?? {};
    const ad = after.testData ?? {};
    for (const k of Object.keys(bd)) if (!(k in ad)) details.push({ what: `Test value ${k}`, kind: "removed", from: bd[k] });
    for (const k of Object.keys(ad)) {
        if (!(k in bd)) details.push({ what: `Test value ${k}`, kind: "added", to: ad[k] });
        else if (bd[k] !== ad[k]) details.push({ what: `Test value ${k}`, kind: "changed", from: bd[k], to: ad[k] });
    }

    const count = (kind: StepRow["kind"]) => rows.filter((r) => r.kind === kind).length;
    const stats = { added: count("added"), removed: count("removed"), changed: count("changed"), moved: count("moved") };
    const same = stats.added + stats.removed + stats.changed + stats.moved === 0 && details.length === 0;
    return { rows, details, stats, same };
}

/** "2 steps added, 1 step changed" for the line above the difference. */
export function summarise(d: StepDiff): string {
    const part = (n: number, word: string) => (n ? `${n} ${n === 1 ? "step" : "steps"} ${word}` : "");
    const parts = [part(d.stats.added, "added"), part(d.stats.removed, "removed"), part(d.stats.changed, "changed"), part(d.stats.moved, "moved")].filter(Boolean);
    if (d.details.length) parts.push(d.details.length === 1 ? "1 detail changed" : `${d.details.length} details changed`);
    return parts.length ? parts.join(", ") : "No differences";
}
