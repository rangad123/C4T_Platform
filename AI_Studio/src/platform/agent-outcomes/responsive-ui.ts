/**
 * The Responsive UI Testing Agent's outcome (SPEC §3), read from what its runs saved:
 *
 *   grid    page × screen size. Desktop comes from its visual checks (test meta `visual`: a picture compared with the approved one); the
 *           other sizes and browsers from the repeats its runs recorded (variants-store.ts, executions tagged with their variant). Each
 *           cell has its result and the picture kept for it: the run's own screenshot, the approved baseline, or the new picture and its
 *           difference when the page changed. A repeat keeps a picture only when it failed (repo-sink.ts recordVariant).
 *   issues  layout issues: a desktop change once it is verified (Phase 5 lifecycle), and a page that passes on desktop but fails on
 *           another size or browser, with its evidence (the repeat is a real run; Phase 5 does not verify repeats).
 *
 * Nothing of another agent: only visual checks, and the tests its runs repeated on other sizes, are read.
 */
import { STATE_LABEL } from "../../engine/findings/lifecycle.js";
import { CONDITION_VARIANT_IDS, VARIANT_IDS, VARIANTS, type VariantId } from "../../engine/validation/variants.js";
import type { TestSpec } from "../../engine/spec/schema.js";
import { redactText } from "../../shared/redact-text.js";
import type { Platform } from "../bootstrap.js";
import type { Row } from "../db.js";
import type { TestRow } from "../repo.js";
import { findingsOfTests, testsOfRuns, VERIFIED_STATES } from "./security.js";
import type { AgentOutcomeModule } from "./types.js";

export type CellStatus = "same" | "changed" | "passed" | "failed" | "could-not-run" | "not-checked" | "not-run";

export interface Viewport {
    id: string;
    label: string;
    width: number;
    height: number;
}

export interface GridCell {
    status: CellStatus;
    testKey: string;
    /** Why it changed, failed, could not run or was not checked, in the run's words. */
    reason: string | null;
    /** The picture kept for this cell (GET /api/artifacts/:id), or null when none was kept. */
    shot: string | null;
    /** The difference from the approved picture, for a page that changed. */
    diff: string | null;
    /** A desktop change's finding: its state in words, `verified` when it is a layout issue. */
    finding: { id: string; label: string; verified: boolean } | null;
}

export interface GridRow {
    path: string;
    /** By viewport id; a size its runs did not try for this page has no cell. */
    cells: Record<string, GridCell>;
}

export interface LayoutIssue {
    path: string;
    viewport: string;
    kind: "changed" | "fails";
    testKey: string;
    reason: string | null;
    /** The evidence pictures: the new picture and its difference, or the failed repeat's screenshot. */
    shots: string[];
    finding: { id: string; label: string } | null;
}

export interface ResponsiveOutcome {
    runs: number;
    viewports: Viewport[];
    pages: GridRow[];
    issues: LayoutIssue[];
}

const DESKTOP: Viewport = { id: "desktop", label: "Desktop", width: VARIANTS["chromium-desktop"].viewport.width, height: VARIANTS["chromium-desktop"].viewport.height };
const VIEWPORT_IDS = VARIANT_IDS.filter((v) => v !== "chromium-desktop" && !(CONDITION_VARIANT_IDS as readonly string[]).includes(v));

const isVisual = (t: TestRow) => t.generationMeta?.visual === true || t.spec.type === "visual";

/** The page a test looks at: a visual check's last opened address (after any sign-in), another test's first. */
function pageOf(t: TestRow): string {
    const opened = t.spec.steps.filter((s): s is Extract<TestSpec["steps"][number], { action: "navigate" }> => s.action === "navigate");
    const url = (isVisual(t) ? opened.at(-1) : opened[0])?.url ?? "/";
    try {
        return new URL(url, "http://page.invalid").pathname;
    } catch {
        return url;
    }
}

/** Worst first: a cell shows the worst result of the tests at that page. */
const RANK: CellStatus[] = ["changed", "failed", "could-not-run", "not-run", "not-checked", "passed", "same"];
const VARIANT_STATUS: Record<string, CellStatus> = { passed: "passed", failed: "failed", unavailable: "could-not-run", skipped: "not-checked" };

async function responsiveOutcome(p: Platform, projectId: string, runIds: readonly string[]): Promise<ResponsiveOutcome> {
    const db = p.repo.db;
    const execs = runIds.length
        ? db.all<Row>(
              `SELECT e.id, e.test_case_id, e.status, e.error, e.variant FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id
               WHERE t.project_id = ? AND e.environment IS NULL AND e.job_id IN (${runIds.map(() => "?").join(",")}) ORDER BY e.started_at DESC, ${db.dialect.insertionOrder("e")} DESC`,
              projectId,
              ...runIds,
          )
        : [];
    // The newest run of each test on desktop ("" key) and on each size or browser.
    const newest = new Map<string, Row>();
    for (const e of execs) {
        if (e.variant && !(VIEWPORT_IDS as readonly string[]).includes(e.variant)) continue;
        const k = `${e.test_case_id}|${e.variant ?? ""}`;
        if (!newest.has(k)) newest.set(k, e);
    }
    const repeated = new Set(execs.filter((e) => e.variant).map((e) => String(e.test_case_id)));
    const tests = testsOfRuns(p, projectId, runIds, (t) => isVisual(t) || repeated.has(t.id));
    const findingOf = await findingsOfTests(p, projectId, new Set(tests.filter(isVisual).map((t) => t.id)));
    const artifactsOf = (executionId: string | undefined, kind: string): string | null =>
        executionId ? ((p.repo.listArtifacts({ executionId }).find((a) => a.kind === kind && !a.pruned_at)?.id as string | undefined) ?? null) : null;

    const rows = new Map<string, GridRow>();
    const seen = new Set<string>(["desktop"]);
    const put = (path: string, viewport: string, cell: GridCell) => {
        const row = rows.get(path) ?? { path, cells: {} };
        rows.set(path, row);
        const was = row.cells[viewport];
        if (!was || RANK.indexOf(cell.status) < RANK.indexOf(was.status)) row.cells[viewport] = cell;
    };
    const why = (s: unknown) => (typeof s === "string" && s ? redactText(s, 600) : null);

    for (const t of tests) {
        const path = pageOf(t);
        const base = newest.get(`${t.id}|`);
        const id = base?.id as string | undefined;
        if (isVisual(t)) {
            const status: CellStatus = t.validationStatus === "VALIDATED" ? "same" : t.validationStatus === "NEEDS_REVIEW" ? "changed" : t.validationStatus === "FAILED_VALIDATION" ? "could-not-run" : "not-run";
            const baseline = (p.repo.listArtifacts({ testId: t.id }).find((a) => a.kind === "baseline" && !a.pruned_at)?.id as string | undefined) ?? null;
            const f = findingOf.get(t.id);
            put(path, "desktop", {
                status,
                testKey: t.testKey,
                reason: status === "same" || status === "not-run" ? null : why(t.validationReason),
                shot: status === "changed" ? (artifactsOf(id, "visual-actual") ?? artifactsOf(id, "screenshot")) : status === "not-run" ? null : (artifactsOf(id, "screenshot") ?? baseline),
                diff: status === "changed" ? artifactsOf(id, "visual-diff") : null,
                finding: status === "changed" && f ? { id: f.id, label: STATE_LABEL[f.state], verified: VERIFIED_STATES.includes(f.state) } : null,
            });
        } else {
            put(path, "desktop", { status: t.validationStatus === "VALIDATED" ? "passed" : "failed", testKey: t.testKey, reason: t.validationStatus === "VALIDATED" ? null : why(t.validationReason), shot: artifactsOf(id, "screenshot"), diff: null, finding: null });
        }
        for (const v of VIEWPORT_IDS) {
            const e = newest.get(`${t.id}|${v}`);
            if (!e) continue;
            seen.add(v);
            const status = VARIANT_STATUS[String(e.status)] ?? "not-checked";
            put(path, v, { status, testKey: t.testKey, reason: why(e.error), shot: status === "failed" ? artifactsOf(String(e.id), "screenshot") : null, diff: null, finding: null });
        }
    }

    const viewports = [DESKTOP, ...VIEWPORT_IDS.filter((v) => seen.has(v)).map((v: VariantId) => ({ id: v, label: VARIANTS[v].label, width: VARIANTS[v].viewport.width, height: VARIANTS[v].viewport.height }))];
    const pages = [...rows.values()];
    const issues: LayoutIssue[] = [];
    for (const row of pages)
        for (const v of viewports) {
            const c = row.cells[v.id];
            if (c?.status === "changed" && c.finding?.verified) issues.push({ path: row.path, viewport: v.id, kind: "changed", testKey: c.testKey, reason: c.reason, shots: [c.shot, c.diff].filter((x): x is string => Boolean(x)), finding: { id: c.finding.id, label: c.finding.label } });
            else if (c?.status === "failed" && v.id !== "desktop") issues.push({ path: row.path, viewport: v.id, kind: "fails", testKey: c.testKey, reason: c.reason, shots: c.shot ? [c.shot] : [], finding: null });
        }
    return { runs: runIds.length, viewports, pages, issues };
}

const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const outcome: AgentOutcomeModule<ResponsiveOutcome> = {
    outcome: (ctx) => responsiveOutcome(ctx.p, ctx.projectId, ctx.runs.map((j) => j.id)),
    runOutcome: (ctx, jobId) => responsiveOutcome(ctx.p, ctx.projectId, [jobId]),
    headline: (o) => (o.pages.length ? `${o.issues.length ? counted(o.issues.length, "layout issue") : "No layout issues"}, ${counted(o.pages.length, "page")} on ${counted(o.viewports.length, "screen size")}` : null),
};
