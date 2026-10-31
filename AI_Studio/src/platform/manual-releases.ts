/**
 * Releases: a named checkpoint that combines the automated state of a project (exactly what the dashboard says) with the
 * manual checks someone ran for it, and records a sign-off.
 *
 * An open release always shows live data. A signed release shows what was true when it was signed (the automated state and
 * every manual check are frozen with it), however the project or its manual cases change afterwards.
 */
import type { ManualCase, ManualResult } from "../engine/manual/cases.js";
import { priorityRank } from "../engine/manual/cases.js";
import { evaluateSignoff, overrideCommentOk, releaseSentence, rollup, SIGNOFF_RULES, type AutomatedState, type Rollup, type SignoffEvaluation } from "../engine/manual/signoff.js";
import { buildDashboard } from "./dashboard.js";
import type { Db } from "./db.js";
import { HttpError } from "./http-error.js";
import type { AuditEntry, AutomatedSnapshot, FrozenItem, ManualCaseStore, ReleaseRow, ResultRow } from "./manual-case-store.js";

/** The project's automated state right now, taken from the dashboard so the two can never disagree. */
export function automatedSnapshot(db: Db, projectId: string, nowMs = Date.now()): AutomatedSnapshot {
    const p = buildDashboard(db, { now: nowMs }).projects.find((x) => x.id === projectId);
    if (!p) throw new HttpError(404, "Project not found");
    return {
        takenAt: new Date(nowMs).toISOString(),
        readiness: p.readiness,
        tests: p.tests,
        latestRun: p.latestRun,
        findings: p.findings,
        flaky: p.flaky,
        apiBreakingChanges: p.apiBreakingChanges,
        lastRunAt: p.lastRunAt,
        ...(p.quarantine ? { quarantine: p.quarantine } : {}),
    };
}

export interface ViewItem extends FrozenItem {
    issue: ResultRow["issue"];
    linkedTestIds: string[];
}

/** Every case with its result in this release, grouped by area (alphabetical), most important first inside an area. */
export function liveItems(cases: ManualCase[], results: Map<string, ResultRow>): ViewItem[] {
    return cases
        .map((c, order) => ({ c, order }))
        .sort((a, b) => a.c.area.localeCompare(b.c.area, undefined, { sensitivity: "base" }) || priorityRank(a.c.priority) - priorityRank(b.c.priority) || a.order - b.order)
        .map(({ c }) => {
            const r = results.get(c.id);
            return {
                id: c.id,
                title: c.title,
                area: c.area,
                priority: c.priority,
                requirement: c.requirement,
                steps: c.steps,
                linkedTestIds: c.linkedTestIds,
                result: r?.result ?? ("not_run" as ManualResult),
                note: r?.note ?? "",
                by: r?.by ?? "",
                at: r?.at ?? null,
                issue: r?.issue ?? null,
            };
        });
}

export interface ReleaseView {
    id: string;
    projectId: string;
    name: string;
    notes: string;
    status: ReleaseRow["status"];
    /** approved or rejected while signed, otherwise null. */
    decision: "approved" | "rejected" | null;
    createdAt: string;
    updatedAt: string;
    signedAt: string | null;
    signedBy: string | null;
    /** True for a signed release: nothing in it changes any more. */
    frozen: boolean;
    sentence: string;
    automated: AutomatedSnapshot;
    manual: { rollup: Rollup; items: ViewItem[] };
    signoff: SignoffEvaluation & { rules: typeof SIGNOFF_RULES };
    audit: AuditEntry[];
}

export interface ReleaseSummary {
    id: string;
    name: string;
    notes: string;
    status: ReleaseRow["status"];
    decision: "approved" | "rejected" | null;
    createdAt: string;
    signedAt: string | null;
    signedBy: string | null;
    sentence: string;
    readiness: AutomatedState;
    rollup: Rollup;
}

const decisionOf = (r: ReleaseRow): "approved" | "rejected" | null => (r.status === "open" ? null : r.status);

function itemsOf(store: ManualCaseStore, release: ReleaseRow, cases: ManualCase[]): { items: ViewItem[]; frozen: boolean } {
    const results = store.results(release.id);
    if (release.frozen) {
        // The decision and the checks are frozen; an issue filed afterwards is only a link and is read live.
        return { items: release.frozen.items.map((i) => ({ ...i, issue: results.get(i.id)?.issue ?? null, linkedTestIds: cases.find((c) => c.id === i.id)?.linkedTestIds ?? [] })), frozen: true };
    }
    return { items: liveItems(cases, results), frozen: false };
}

export function releaseView(store: ManualCaseStore, db: Db, release: ReleaseRow, nowMs = Date.now()): ReleaseView {
    const cases = store.listCases(release.projectId);
    const { items, frozen } = itemsOf(store, release, cases);
    const automated = release.frozen ? release.frozen.automated : automatedSnapshot(db, release.projectId, nowMs);
    const r = rollup(items);
    return {
        id: release.id,
        projectId: release.projectId,
        name: release.name,
        notes: release.notes,
        status: release.status,
        decision: decisionOf(release),
        createdAt: release.createdAt,
        updatedAt: release.updatedAt,
        signedAt: release.signedAt,
        signedBy: release.signedBy,
        frozen,
        sentence: releaseSentence(release.name, r, automated.readiness.state),
        automated,
        manual: { rollup: r, items },
        signoff: { ...evaluateSignoff({ automated: automated.readiness, items, quarantined: automated.quarantine?.count }), rules: SIGNOFF_RULES },
        audit: store.audit(release.id),
    };
}

/** The list page: newest first, one automated snapshot shared by every open release. */
export function releaseSummaries(store: ManualCaseStore, db: Db, projectId: string, nowMs = Date.now()): ReleaseSummary[] {
    const releases = store.listReleases(projectId);
    if (releases.length === 0) return [];
    const cases = store.listCases(projectId);
    let live: AutomatedSnapshot | undefined;
    return releases.map((rel) => {
        const { items } = itemsOf(store, rel, cases);
        const automated = rel.frozen ? rel.frozen.automated : (live ??= automatedSnapshot(db, projectId, nowMs));
        const r = rollup(items);
        return {
            id: rel.id,
            name: rel.name,
            notes: rel.notes,
            status: rel.status,
            decision: decisionOf(rel),
            createdAt: rel.createdAt,
            signedAt: rel.signedAt,
            signedBy: rel.signedBy,
            sentence: releaseSentence(rel.name, r, automated.readiness.state),
            readiness: automated.readiness.state,
            rollup: r,
        };
    });
}

export const requireOpen = (release: ReleaseRow): void => {
    if (release.status !== "open") throw new HttpError(409, "This release is signed and cannot be changed. Reopen it first.");
};

/** What the audit trail keeps of a release at one moment. */
function auditState(automated: AutomatedSnapshot, r: Rollup, ev: SignoffEvaluation): Record<string, unknown> {
    return {
        automated: { state: automated.readiness.state, reasons: automated.readiness.reasons.map((x) => x.text), passRate: automated.latestRun?.passRate ?? null, tests: automated.tests },
        manual: r,
        blocking: ev.blocking.map((b) => b.text),
        warnings: ev.warnings.map((b) => b.text),
    };
}

export interface SignoffRequest {
    decision: "approved" | "rejected";
    by: string;
    comment: string;
    override: boolean;
}

/** Apply the sign-off rules. Approving past a block needs `override` and a real comment; rejecting never needs a reason. */
export function signRelease(store: ManualCaseStore, db: Db, release: ReleaseRow, req: SignoffRequest, nowMs = Date.now()): void {
    requireOpen(release);
    const cases = store.listCases(release.projectId);
    const items = liveItems(cases, store.results(release.id));
    const automated = automatedSnapshot(db, release.projectId, nowMs);
    const ev = evaluateSignoff({ automated: automated.readiness, items, quarantined: automated.quarantine?.count });

    let overridden = false;
    if (req.decision === "approved" && !ev.canApprove) {
        if (!req.override) {
            throw new HttpError(409, `This release cannot be approved yet: ${ev.blocking.map((b) => b.text).join("; ")}.`, { blocking: ev.blocking, warnings: ev.warnings, needsOverride: true });
        }
        if (!overrideCommentOk(req.comment)) throw new HttpError(400, "An override needs a comment of at least 10 characters that says why the release goes ahead anyway.");
        overridden = true;
    }
    store.sign(release.id, {
        status: req.decision,
        by: req.by,
        comment: req.comment,
        override: overridden,
        frozen: { automated, items: items.map(({ issue: _issue, linkedTestIds: _linked, ...frozen }) => frozen) },
        state: auditState(automated, rollup(items), ev),
    });
}

export function reopenRelease(store: ManualCaseStore, release: ReleaseRow, req: { by: string; comment: string }): void {
    if (release.status === "open") throw new HttpError(409, "This release is not signed, so there is nothing to reopen.");
    const frozen = release.frozen;
    store.reopen(release.id, {
        by: req.by,
        comment: req.comment,
        state: { previousDecision: release.status, signedBy: release.signedBy, signedAt: release.signedAt, manual: frozen ? rollup(frozen.items) : null, automated: frozen ? { state: frozen.automated.readiness.state } : null },
    });
}
