/**
 * The work a pull request's webhook delivery queues (Phase 6; code-host/webhook.ts records it in pr_events with queued = 'impact'):
 *
 *   the PR's changed files (github.ts) and the repository's source at its head commit → impact analysis (engine/impact/analyze.ts) with
 *   the project's tests, app model, rules, requirement links and past findings (findings/past.ts) → the selection preview with the risk
 *   score (selection/preview.ts, risk.ts) → one pr_selections row per head commit → the sticky pull request comment (feedback.ts,
 *   behind the project's switch) and the pr_selection_ready notice (alerts.ts, channels that chose it).
 *
 * Automatic selection stays off: the row's mode is "full", and the run that follows is a full run unless a person or the API asks for a
 * focused one (routes/selection.ts). The same head commit is analysed once: a second delivery for it changes nothing.
 */
import { analyzeImpact, BROWSER_DIR } from "../../engine/impact/analyze.js";
import { isJsLike } from "../../engine/impact/diff.js";
import { routesOf } from "../../engine/impact/routes.js";
import { redactText } from "../../shared/redact-text.js";
import { AppIntelStore } from "../app-intel-store.js";
import type { Platform } from "../bootstrap.js";
import { pastFindings } from "../findings/past.js";
import { getScheduleServices } from "../schedule-services.js";
import { projectCoverage } from "../selection/facts.js";
import { heldWhy } from "../selection/held.js";
import { previewSelection, readChanges, type PreviewTest } from "../selection/preview.js";
import { riskFacts } from "../selection/risk-facts.js";
import { riskOf } from "../selection/risk.js";
import { postPrFeedback, type FeedbackOutcome } from "./feedback.js";
import type { GithubCodeHost } from "./github.js";
import type { CodeHostStore, PrSelection } from "./store.js";

/** Source files read per pull request (the changed ones first), and the largest one read. */
export const MAX_SOURCE_FILES = 300;
export const MAX_SOURCE_BYTES = 512_000;
const PARALLEL = 8;

/**
 * The repository's code files at the head commit: route registrations and the functions they call can sit in files the PR does not
 * change. shortcut: JS/TS files only (what impact/routes.ts reads), at most MAX_SOURCE_FILES; upgrade to a shallow checkout
 * (git-checkout.ts) if real repositories are larger.
 */
export async function repositorySources(client: Pick<GithubCodeHost, "tree" | "blob">, headSha: string, changed: string[]): Promise<{ sources: Record<string, string>; notes: string[] }> {
    const { files, truncated } = await client.tree(headSha);
    const first = new Set(changed);
    // Page files in the browser folder too: they say which scripts a page loads (analyze.ts pagesOf).
    const code = files.filter((f) => (isJsLike(f.path) || (BROWSER_DIR.test(f.path) && /\.html?$/i.test(f.path))) && !/(^|\/)node_modules\//.test(f.path));
    const tooBig = code.filter((f) => f.size > MAX_SOURCE_BYTES).length;
    const ordered = code.filter((f) => f.size <= MAX_SOURCE_BYTES).sort((a, b) => Number(first.has(b.path)) - Number(first.has(a.path)));
    const take = ordered.slice(0, MAX_SOURCE_FILES);
    const sources: Record<string, string> = {};
    for (let i = 0; i < take.length; i += PARALLEL) {
        const batch = take.slice(i, i + PARALLEL);
        const texts = await Promise.all(batch.map((f) => client.blob(f.sha)));
        batch.forEach((f, k) => (sources[f.path] = texts[k]!));
    }
    const notes: string[] = [];
    if (truncated) notes.push("GitHub listed only part of the repository's files, so routes in the rest were not read.");
    if (ordered.length > take.length) notes.push(`The repository has ${ordered.length} code files; the first ${MAX_SOURCE_FILES} (the changed ones first) were read.`);
    if (tooBig) notes.push(`${tooBig} code file${tooBig === 1 ? " is" : "s are"} larger than ${MAX_SOURCE_BYTES / 1000} kB and ${tooBig === 1 ? "was" : "were"} not read.`);
    return { sources, notes };
}

/** One table cell: one line, no table break, no @mention (GitHub would notify that account), secrets masked. */
const cell = (s: string, n = 300) =>
    redactText(s, n)
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .replace(/@(?=\w)/g, "@​");

export interface SelectionReasons {
    tests: Array<{
        testId: string;
        testKey: string;
        title: string;
        score: number;
        risk: string;
        reasons: string[];
        why?: string;
        /** No reason from the change: proposed because its own latest recorded run cannot vouch for its coverage (coverage.ts freshnessOf), in words. */
        stale?: string;
    }>;
    fullRunRecommended: boolean;
    fullRunReasons: string[];
    endpoints: string[];
    unmapped: Array<{ path: string; why: string[] }>;
    shared: string[];
    findings: Array<{ id: string; title: string }>;
    notes: string[];
}

/** The sticky comment's text for a selection. */
export function selectionComment(pr: number, headSha: string, total: number, r: SelectionReasons): string {
    const M = [`## AI Studio: tests for this change`, "", `${r.tests.length} of ${total} tests are proposed for pull request #${pr} (head ${headSha.slice(0, 7)}), highest risk first.`, ""];
    if (r.fullRunRecommended) M.push("**Full run recommended.**", "", ...r.fullRunReasons.slice(0, 10).map((x) => `- ${cell(x, 600)}`), "");
    if (r.tests.length) {
        M.push("| Risk | Test | Why |", "| ---: | --- | --- |");
        for (const t of r.tests.slice(0, 20)) M.push(`| ${t.score} | ${cell(t.testKey, 40)} ${cell(t.title, 120)} | ${cell([t.reasons[0] ?? t.why ?? "", t.risk].filter(Boolean).join(" "), 600)} |`);
        if (r.tests.length > 20) M.push("", `…and ${r.tests.length - 20} more.`);
        M.push("");
    }
    if (r.unmapped.length) M.push(`${r.unmapped.length} changed file${r.unmapped.length === 1 ? "" : "s"} reach no route on evidence: ${r.unmapped.slice(0, 5).map((u) => `\`${cell(u.path, 120).replace(/`/g, "")}\``).join(", ")}${r.unmapped.length > 5 ? ", …" : ""}.`, "");
    for (const n of r.notes) M.push(`_${cell(n, 300)}_`, "");
    M.push("<sub>The next run is a full run. A focused run of the proposed tests is chosen by a person in AI Studio or with the API.</sub>");
    return M.join("\n") + "\n";
}

export type PrImpactOutcome = { skipped: string } | { selection: PrSelection; feedback: FeedbackOutcome };

/** Process one queued pull request delivery. Throws on a GitHub or analysis error (the caller logs it); nothing is stored then. */
export async function processPrEvent(p: Platform, store: CodeHostStore, projectId: string, ev: { pr: number; headSha: string }): Promise<PrImpactOutcome> {
    if (store.selection(projectId, ev.pr, ev.headSha)) return { skipped: "This head commit was analysed already." };
    const client = store.client(projectId);
    if (!client) return { skipped: "No repository is connected to this project." };
    const { files, limit } = await client.files(ev.pr);
    const { sources, notes } = await repositorySources(client, ev.headSha, files.map((f) => f.path));
    if (limit) notes.unshift(limit);

    // The repository's own route registrations are templates a captured path part can resolve to (`/notes/{{note}}` → ANY /notes/{}).
    const templates = Object.entries(sources).flatMap(([file, src]) => routesOf(file, src).map((r) => ({ method: r.method, path: r.path })));
    const c = await projectCoverage(p.repo, p.store, projectId, { templates });
    const intel = new AppIntelStore(p.sql);
    const model = (await intel.latest(projectId))?.model;
    const rules = (await intel.rules(projectId)).filter((r) => r.status !== "rejected");
    const requirementLinks = p.db.all<{ requirement: string; testId: string }>(
        "SELECT r.ref_key AS requirement, l.test_case_id AS testId FROM requirement_links l JOIN requirements r ON r.id = l.requirement_id WHERE l.project_id = ? AND l.test_case_id IS NOT NULL",
        projectId,
    );
    const requirements = p.db
        .all<{ ref: string; title: string; description: string }>("SELECT ref, title, description FROM requirements WHERE project_id = ? AND status != 'retired'", projectId)
        .map((r) => ({ ref: r.ref, text: r.description || r.title }));
    const impact = await analyzeImpact({
        files: files.map((f) => ({ path: f.path, ...(f.previousPath ? { previousPath: f.previousPath } : {}), status: f.status, ...(f.patch !== undefined ? { patch: f.patch } : {}) })),
        sources,
        tests: c.tests,
        ...(c.apiPrefix ? { apiPrefix: c.apiPrefix } : {}),
        ...(model ? { model } : {}),
        rules,
        requirementLinks,
        requirements,
        findings: await pastFindings(p.sql, p.repo, projectId),
    });
    // Files that are not application code are said so, and not counted as changed application files.
    if (impact.notApp.length) notes.push(`Not counted as application changes: ${impact.notApp.slice(0, 5).map((n) => n.why).join(" ")}${impact.notApp.length > 5 ? ` …and ${impact.notApp.length - 5} more.` : ""}`);

    // As the preview route: a test no runner runs (unreadable, never approved, held back) is listed apart, never proposed.
    const approved = new Set(p.db.all<{ test_case_id: string }>("SELECT DISTINCT test_case_id FROM test_versions WHERE project_id = ? AND state = 'approved'", projectId).map((r) => r.test_case_id));
    const cannotRun = new Map<string, { why: string; unreadable?: boolean; nowhere?: boolean; held?: boolean }>();
    for (const t of p.repo.listTests(projectId)) {
        if (t.unreadable) cannotRun.set(t.id, { why: "Cannot run: its stored steps cannot be read.", unreadable: true });
        else if (!approved.has(t.id)) cannotRun.set(t.id, { why: "Cannot run: it has no approved version yet.", nowhere: true });
        else if (c.held.has(t.id)) cannotRun.set(t.id, { why: heldWhy(c.held.get(t.id)!), nowhere: true, held: true });
    }
    const { changes, ignored, notProcessed } = readChanges(impact.changes, c.app);
    const risk = await riskFacts(p, projectId, c.tests, c.apiPrefix);
    const preview = previewSelection(c.tests, changes, ignored, {
        ...(c.apiPrefix ? { apiPrefix: c.apiPrefix } : {}),
        notProcessed,
        cannotRun,
        risk,
        impact: { files: impact.files.length, unmapped: impact.unmapped.map((u) => u.path), shared: impact.shared },
    });
    const staleOf = new Map(c.tests.flatMap((t) => (t.stale ? [[t.testId, t.stale] as const] : [])));
    // A test linked to a requirement the PR edits is proposed for that reason, also when its footprint does not reach the change.
    const byRequirement = new Map(impact.requirementTests.map((t) => [t.id, t.evidence.map((e) => `It is ${e}.`)]));
    const linked = preview.notMatched.filter((t) => byRequirement.has(t.testId)).map(({ why: _notProposed, ...t }) => ({ ...t, risk: riskOf(1, risk.get(t.testId)) }));
    const proposed: PreviewTest[] = [...preview.matched, ...preview.unknown, ...linked].sort((a, b) => b.risk!.score - a.risk!.score || a.testKey.localeCompare(b.testKey));
    const sentences = (t: PreviewTest) => [...t.reasons.map((r) => r.sentence), ...(byRequirement.get(t.testId) ?? [])];
    const reasons: SelectionReasons = {
        tests: proposed.map((t) => ({ testId: t.testId, testKey: t.testKey, title: t.title, score: t.risk!.score, risk: t.risk!.reason, reasons: sentences(t), ...(t.why ? { why: t.why } : {}), ...(!sentences(t).length && staleOf.has(t.testId) ? { stale: staleOf.get(t.testId)! } : {}) })),
        fullRunRecommended: preview.fullRunRequired,
        fullRunReasons: preview.fullRunReasons,
        endpoints: impact.endpoints.map((e) => e.route),
        unmapped: impact.unmapped,
        shared: impact.shared,
        findings: impact.findings.map((f) => ({ id: f.id, title: f.name })),
        notes,
    };
    // One row per head commit: when another delivery for the same head got here first, it posts the comment, not this one.
    if (!store.saveSelection(projectId, { pr: ev.pr, headSha: ev.headSha, mode: "full", selected: proposed.map((t) => t.testId), reasons })) return { skipped: "This head commit was analysed already." };
    const selection = store.selection(projectId, ev.pr, ev.headSha)!;
    const feedback = await postPrFeedback(store, projectId, { pr: ev.pr, headSha: ev.headSha, selection: selectionComment(ev.pr, ev.headSha, c.tests.length, reasons) });

    const project = p.repo.getProject(projectId);
    const { alerts } = getScheduleServices(p);
    const summary = `${proposed.length} of ${c.tests.length} tests are proposed for pull request #${ev.pr}${preview.fullRunRequired ? "; a full run is recommended" : ""}.`;
    await alerts
        .notifyEvent(alerts.subject({ id: projectId, name: String(project?.name ?? projectId), url: null }), {
            event: "pr_selection_ready",
            summary,
            items: [...proposed.slice(0, 5).map((t) => ({ title: `${t.testKey} ${t.title}`, reason: t.risk!.reason })), ...preview.fullRunReasons.slice(0, 3).map((r) => ({ title: "Full run recommended", reason: r }))],
        })
        .catch((err) => console.error("[alerts] pull request notice failed:", err));
    return { selection, feedback };
}
