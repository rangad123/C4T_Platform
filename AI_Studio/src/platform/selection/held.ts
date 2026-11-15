/**
 * Tests held back because a shared part they use (reusable steps, a shared element, a helper) changed after their approval, worked out
 * READ-ONLY for the preview. It mirrors what a run's check does (review-store.ts `toRun` / `partsChanged`) without its writes: no
 * dependency record is made or replaced, no version to approve again is drafted, no comment is added.
 *
 *   no record          the version was approved before records existed: a run records it at its first check and counts it as
 *                      unchanged, so here it is unchanged too;
 *   record differs     a run holds the test back when the project's policy asks for approval of people's changes (`edits`, what
 *                      `needsApproval(policy, "dependency")` reads), so it is "held". Otherwise a run approves it again at once and runs
 *                      it: what its latest run touched was before the change ("changed", the coverage is out of date);
 *   approved again by  a run approved it again (record `policy`) at `since`; a latest run on the deploy target older than that ran
 *   the policy         before the change (a variant's run can be the one that approved it again).
 */
import { changedParts, DepsReader, describeParts, readDeps } from "../approval-deps.js";
import type { Db } from "../db.js";
import { ReviewStore } from "../review-store.js";

export type SharedPartChange =
    /** A run holds it back: it does not run until it is approved again. */
    | { held: true; what: string }
    /** A run approves it again and runs it; `since`: when that happened (then only runs before it are out of date). */
    | { held: false; what: string; since?: string };

const SOME_PART = "a shared part it uses";

/** By test id, the tests of the project whose latest approved version's shared parts changed (or were approved again by the policy). */
export function sharedPartChanges(db: Db, projectId: string): Map<string, SharedPartChange> {
    const out = new Map<string, SharedPartChange>();
    const seen = new Set<string>();
    const reader = new DepsReader(db);
    const asksApproval = new ReviewStore(db).policy(projectId).edits;
    for (const v of db.all<{ id: string; test_case_id: string; spec_json: string; code: string | null }>(
        "SELECT id, test_case_id, spec_json, code FROM test_versions WHERE project_id = ? AND state = 'approved' ORDER BY version DESC",
        projectId,
    )) {
        if (seen.has(v.test_case_id)) continue;
        seen.add(v.test_case_id);
        const rec = readDeps(db, v.id);
        if (!rec) continue;
        let now;
        try {
            now = reader.of({ projectId, spec: JSON.parse(v.spec_json), code: v.code ?? null });
        } catch {
            continue; // unreadable steps are listed as "Cannot run" by the route already
        }
        if (rec.hash !== now.hash) {
            const what = describeParts(changedParts(rec.covers, now.covers)) || SOME_PART;
            out.set(v.test_case_id, asksApproval ? { held: true, what } : { held: false, what });
        } else if (rec.recorded === "policy") out.set(v.test_case_id, { held: false, what: SOME_PART, since: rec.recordedAt });
    }
    return out;
}

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "Cannot run" words for a held test. */
export const heldWhy = (what: string): string => `Cannot run: ${what} changed after its approval, so runs hold it back until it is approved again.`;

/**
 * Why the latest run cannot vouch for a test whose shared part changed and that runs anyway (policy), or undefined when the latest run
 * (`startedAt`) is after the change.
 */
export function changedAfterRun(change: SharedPartChange, startedAt: string): string | undefined {
    if (change.held) return undefined;
    if (change.since && Date.parse(startedAt) >= Date.parse(change.since)) return undefined;
    return `${upperFirst(change.what)} changed after its latest run (${startedAt.slice(0, 10)}), and no run on the deploy target has used the change yet.`;
}
