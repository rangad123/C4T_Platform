/**
 * The ledger of records a run created, and the plan for removing them.
 *
 * The script writes one line per event (see helper.ts); this module turns those lines into ledger items: for each created
 * record the DELETE operation that removes it (re-derived here with the same rules the script uses, never taken on trust
 * from the script), or the plain statement that none is known. Items only ever hold paths and ids.
 */
import type { TestSpec } from "../spec/schema.js";
import { MAX_RECORDS_PER_TEST, RUN_TAG, deleteOperationsOfSpec, loadCleanupRuntime, mergeOperations } from "./helper.js";

/** removed (we deleted it, or the test did), already-gone (404/410), failed, no-delete-operation, skipped (cleanup was off). */
export type CleanupStatus = "removed" | "already-gone" | "failed" | "no-delete-operation" | "skipped";

export const CLEANUP_STATUSES: CleanupStatus[] = ["removed", "already-gone", "failed", "no-delete-operation", "skipped"];

/** What a script wrote down, validated: it is output of a script built from untrusted input, so nothing is trusted. */
export type CreatedLine = { k: "created"; path: string; id: string; location?: string; at: string; /** The run tag of the generated data the record was made with (testdata/generate.ts). */ tag?: string } | { k: "deleted"; path: string; /** What the application answered to the test's own DELETE. */ status?: number };

export interface LedgerItem {
    /** The test's key (API-003), not a database id. */
    testId: string;
    /** Creation order within the run (global across tests; later = created later). */
    seq: number;
    method: "POST";
    /** The path POSTed to (the collection). */
    path: string;
    id: string;
    /** The concrete DELETE path planned for it; absent when no known operation removes it. */
    deletePath?: string;
    /** Address (origin) the run talked to; the delete goes to the same place. */
    origin?: string;
    environment?: string;
    status?: CleanupStatus;
    reason?: string;
    createdAt: string;
    /** The run tag the record's generated data carries: what to search the application for when it is left behind. */
    tag?: string;
}

/** A ledger item whose outcome is known. */
export type FinishedItem = LedgerItem & { status: CleanupStatus };

const SAFE_PATH = /^\/[^\s?#\u0000-\u001f]*$/;

/** Parse a script's event file. Malformed lines are ignored; a hostile or buggy script cannot make this throw or grow without bound. */
export function parseCreatedLog(text: string): CreatedLine[] {
    const out: CreatedLine[] = [];
    let created = 0;
    for (const raw of text.split("\n")) {
        if (!raw.trim() || raw.length > 4000) continue;
        let v: unknown;
        try {
            v = JSON.parse(raw);
        } catch {
            continue;
        }
        if (!v || typeof v !== "object") continue;
        const o = v as Record<string, unknown>;
        if (typeof o.path !== "string" || o.path.length > 1000 || !SAFE_PATH.test(o.path) || o.path.startsWith("//")) continue;
        if (o.k === "deleted") out.push({ k: "deleted", path: o.path, ...(typeof o.status === "number" && Number.isInteger(o.status) && o.status >= 100 && o.status < 600 ? { status: o.status } : {}) });
        else if (o.k === "created" && typeof o.id === "string" && o.id.length > 0 && o.id.length <= 200 && !/[\u0000-\u001f]/.test(o.id) && created < MAX_RECORDS_PER_TEST) {
            const location = typeof o.location === "string" && o.location.length <= 1000 && SAFE_PATH.test(o.location) && !o.location.startsWith("//") ? o.location : undefined;
            const at = typeof o.at === "string" && !Number.isNaN(Date.parse(o.at)) ? new Date(o.at).toISOString() : new Date().toISOString();
            const tag = typeof o.tag === "string" && RUN_TAG.test(o.tag) ? o.tag : undefined;
            created++;
            out.push({ k: "created", path: o.path, id: o.id, ...(location ? { location } : {}), at, ...(tag ? { tag } : {}) });
        }
    }
    return out;
}

/**
 * Turn one test's events into ledger items. `ops` are the DELETE operations known from the API description; the test's own
 * DELETE steps are added. A record the test deleted itself (a later DELETE of the same address succeeded) is already gone:
 * it is listed as removed and nothing is sent for it.
 */
export function planItems(spec: Pick<TestSpec, "testId" | "steps">, lines: CreatedLine[], ops: string[], firstSeq: number): LedgerItem[] {
    const rt = loadCleanupRuntime();
    const known = mergeOperations(ops, deleteOperationsOfSpec(spec));
    const items: LedgerItem[] = [];
    let seq = firstSeq;
    for (const line of lines) {
        if (line.k === "created") {
            const deletePath = rt.cleanupDeletePath(known, line.path, line.id, line.location);
            items.push({
                testId: spec.testId,
                seq: seq++,
                method: "POST",
                path: line.path,
                id: line.id,
                ...(deletePath ? { deletePath } : {}),
                ...(deletePath ? {} : { status: "no-delete-operation" as const, reason: "The API description has no way to remove it, so it stays in the application." }),
                createdAt: line.at,
                ...(line.tag ? { tag: line.tag } : {}),
            });
        } else {
            const target = [...items].reverse().find((i) => i.deletePath === line.path && i.status === undefined);
            if (target) {
                // A 404 or 410 to the test's own DELETE means the application had already dropped it.
                const gone = line.status === 404 || line.status === 410;
                target.status = gone ? "already-gone" : "removed";
                target.reason = gone ? "The test tried to delete it and the application said it was already gone." : "The test deleted it itself.";
            }
        }
    }
    return items;
}

/** Creation order, oldest first (cleanup walks it backwards). */
export const byCreation = (a: LedgerItem, b: LedgerItem): number => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.seq - b.seq;

export interface CleanupCounts {
    created: number;
    removed: number;
    leftBehind: number;
    failed: number;
    noWay: number;
    skipped: number;
}

/** Removed means gone: removed, already-gone and deleted-by-the-test. Everything else is left behind. */
export function countItems(items: Array<{ status?: CleanupStatus | string | null }>): CleanupCounts {
    const n = (s: string) => items.filter((i) => i.status === s).length;
    const removed = n("removed") + n("already-gone");
    return { created: items.length, removed, leftBehind: items.length - removed, failed: n("failed"), noWay: n("no-delete-operation"), skipped: n("skipped") };
}

/** The plain sentence for a run: used for the job event, the card and the CLI. */
export function summaryLine(c: CleanupCounts): string {
    if (c.created === 0) return "The tests created no records.";
    const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;
    if (c.skipped > 0 && c.skipped === c.leftBehind) return `Cleanup is switched off: ${records(c.leftBehind)} the tests created ${c.leftBehind === 1 ? "was" : "were"} left in the application.`;
    return `Removed ${c.removed} of ${records(c.created)} the tests created${c.leftBehind ? `; ${c.leftBehind} left behind` : ""}.`;
}

/** Plain sentences for records left behind that carry a run tag: "3 records with tag qa7k2q were left in the app." */
export function leftBehindByTag(items: Array<{ status?: CleanupStatus | string | null; tag?: string }>): string {
    const left = new Map<string, number>();
    for (const i of items) if (i.tag && i.status !== "removed" && i.status !== "already-gone") left.set(i.tag, (left.get(i.tag) ?? 0) + 1);
    return [...left].map(([tag, n]) => `${n} record${n === 1 ? "" : "s"} with tag ${tag} ${n === 1 ? "was" : "were"} left in the app.`).join(" ");
}
