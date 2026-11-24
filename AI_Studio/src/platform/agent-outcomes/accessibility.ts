/**
 * The Accessibility Testing Agent's outcome (SPEC §3): the issues on each page, by rule and by severity, and how many pages are clean and
 * how many have issues. Computed on read from what its runs saved: their axe audits (tests of type "accessibility", a11y/specs.ts), each
 * one's result and the audit's own message (a11y/audit.ts formatA11yViolations). An audit that fails is a finding by itself: axe's rules
 * are facts, not AI judgement (validation/validator.ts deterministicFinding).
 *
 * An Accessibility agent's run keeps every rule at every impact (audit.ts A11Y_ALL_RULES_PREFIX, in the reason of a passed audit too), so a
 * page that passed the "serious" threshold still lists its moderate and minor issues. Older runs have the failure message only (serious and
 * up, five rules named). A page whose finding a person marked "not a bug" (candidate_findings) is dismissed: listed, never counted.
 *
 * Each page shows its newest result; a run that could not check a page leaves its older result standing, so each run grows the outcome.
 * Stopped runs count with what they checked.
 */
import { A11Y_ALL_RULES_PREFIX, A11Y_FAILURE_PREFIX, A11Y_IMPACTS, type A11yImpact } from "../../engine/a11y/audit.js";
import { CandidateFindingStore } from "../candidate-finding-store.js";
import type { JobRow, TestRow } from "../repo.js";
import type { AgentOutcomeCtx, AgentOutcomeModule } from "./types.js";

export interface A11yIssue {
    rule: string;
    severity: A11yImpact;
    help: string;
    /** How many elements break the rule. */
    elements: number;
    /** The first of them, as axe names them. */
    where: string;
}
export interface A11yPage {
    path: string;
    state: "issues" | "clean" | "not-checked" | "dismissed";
    issues: A11yIssue[];
    /** Rules the audit's message left out (it names five at most). */
    moreRules: number;
    /** Why the page was not checked, or who dismissed it and why. */
    note: string | null;
    /** The number of the run this result is from, as the Runs tab counts them (1 = the first). */
    run: number;
    jobId: string;
}
export interface A11yRule {
    rule: string;
    severity: A11yImpact;
    help: string;
    pages: number;
    elements: number;
}
export interface AccessibilityOutcome {
    runs: number;
    pages: A11yPage[];
    rules: A11yRule[];
    counts: { issues: number; clean: number; notChecked: number; dismissed: number };
}

/** One page's newest check of one kind. */
export interface PageCheck {
    path: string;
    test: TestRow;
    run: number;
    jobId: string;
}
const decided = (t: TestRow) => t.validationStatus === "VALIDATED" || t.validationStatus === "NEEDS_REVIEW";
const pathOf = (t: TestRow): string => (t.spec.steps.find((s) => s.action === "navigate") as { url?: string } | undefined)?.url || "/";

/** Each page's newest check of `type` in `runs` (newest first): a result beats "not checked", so an older result outlives a newer gap. */
export function newestPerPage(ctx: AgentOutcomeCtx, runs: readonly JobRow[], type: string): PageCheck[] {
    const out = new Map<string, PageCheck>();
    for (const job of runs) {
        const run = ctx.runs.length - ctx.runs.findIndex((r) => r.id === job.id);
        for (const test of ctx.p.repo.listTests(ctx.projectId, { jobId: job.id })) {
            if (test.type !== type) continue;
            const path = pathOf(test);
            const had = out.get(path);
            if (!had || (!decided(had.test) && decided(test))) out.set(path, { path, test, run, jobId: job.id });
        }
    }
    return [...out.values()];
}
/** Why a page has no result: not run yet, or the first line of why it could not be checked. */
export const notCheckedNote = (t: TestRow): string =>
    t.validationStatus === "FAILED_VALIDATION" && t.validationReason ? `Could not be checked: ${t.validationReason.split("\n")[0]!.slice(0, 300)}` : "Not checked yet.";

/** The tests a person marked "not a bug" (a finding of theirs in that state), each with the sentence the page shows. */
export async function dismissedTests(ctx: AgentOutcomeCtx): Promise<Map<string, string>> {
    const store = new CandidateFindingStore(ctx.p.sql);
    const out = new Map<string, string>();
    for (const f of await store.inStates(ctx.projectId, ["not_a_bug"])) {
        if (!f.testId) continue;
        const why = (await store.history(ctx.projectId, f.id)).filter((e) => e.to === "not_a_bug").at(-1)?.reason;
        out.set(f.testId, `A person marked this not a bug${why ? `: ${why}` : "."}`);
    }
    return out;
}

/** One rule line of the audit's message: "- <rule> [<impact>]: <help> (<n> node(s): <targets>)". */
const RULE_LINE = /^- (\S+) \[(\w+)\]: (.*) \((\d+) nodes?: (.*)\)$/;
/** The full list when the audit kept every rule, else the failure message's lines. */
function issuesOf(reason: string): { issues: A11yIssue[]; moreRules: number } {
    const full = reason.indexOf(A11Y_ALL_RULES_PREFIX);
    const at = full >= 0 ? full : reason.indexOf(A11Y_FAILURE_PREFIX);
    const issues: A11yIssue[] = [];
    let moreRules = 0;
    for (const line of at < 0 ? [] : reason.slice(at).split("\n").slice(1)) {
        const m = RULE_LINE.exec(line);
        if (m) issues.push({ rule: m[1]!, severity: (A11Y_IMPACTS as readonly string[]).includes(m[2]!) ? (m[2] as A11yImpact) : "minor", help: m[3]!, elements: Number(m[4]), where: m[5]! });
        else moreRules += Number(/^- \.\.\.and (\d+) more rule/.exec(line)?.[1] ?? 0);
    }
    return { issues, moreRules };
}

const worst = (s: A11yImpact) => A11Y_IMPACTS.indexOf(s);
const STATE_ORDER = { issues: 0, "not-checked": 1, dismissed: 2, clean: 3 } as const;

async function build(ctx: AgentOutcomeCtx, runs: readonly JobRow[]): Promise<AccessibilityOutcome> {
    const dismissed = await dismissedTests(ctx);
    const pages: A11yPage[] = newestPerPage(ctx, runs, "accessibility").map(({ path, test, run, jobId }) => {
        const base = { path, run, jobId, issues: [] as A11yIssue[], moreRules: 0, note: null as string | null };
        if (test.validationStatus !== "VALIDATED" && test.validationStatus !== "NEEDS_REVIEW") return { ...base, state: "not-checked", note: notCheckedNote(test) };
        // A passed audit lists issues too when it kept every rule (moderate and minor ones pass the "serious" threshold).
        const found = issuesOf(test.validationReason ?? "");
        if (!found.issues.length && !found.moreRules) return { ...base, state: "clean" };
        const why = dismissed.get(test.id);
        return why ? { ...base, ...found, state: "dismissed", note: why } : { ...base, ...found, state: "issues" };
    });
    const top = (p: A11yPage) => Math.max(-1, ...p.issues.map((i) => worst(i.severity)));
    pages.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || top(b) - top(a) || a.path.localeCompare(b.path));
    const rules = new Map<string, A11yRule>();
    for (const i of pages.filter((p) => p.state === "issues").flatMap((p) => p.issues)) {
        const r = rules.get(i.rule) ?? { rule: i.rule, severity: i.severity, help: i.help, pages: 0, elements: 0 };
        rules.set(i.rule, { ...r, severity: worst(i.severity) > worst(r.severity) ? i.severity : r.severity, pages: r.pages + 1, elements: r.elements + i.elements });
    }
    const count = (s: A11yPage["state"]) => pages.filter((p) => p.state === s).length;
    return {
        runs: runs.length,
        pages,
        rules: [...rules.values()].sort((a, b) => worst(b.severity) - worst(a.severity) || b.pages - a.pages || a.rule.localeCompare(b.rule)),
        counts: { issues: count("issues"), clean: count("clean"), notChecked: count("not-checked"), dismissed: count("dismissed") },
    };
}

/** "2 pages with issues, 12 clean, 1 not checked": the first number says "page(s)", and each part shows only when it is not zero. */
export function countsLine(parts: Array<[number, string]>): string | null {
    const shown = parts.filter(([n]) => n > 0);
    if (!shown.length) return null;
    return shown.map(([n, words], i) => (i ? `${n} ${words}` : `${n} page${n === 1 ? "" : "s"} ${words}`)).join(", ");
}

export const outcome: AgentOutcomeModule<AccessibilityOutcome> = {
    outcome: (ctx) => build(ctx, ctx.runs),
    runOutcome: async (ctx, jobId) => {
        const job = ctx.runs.find((r) => r.id === jobId);
        return job && build(ctx, [job]);
    },
    headline: (o) => countsLine([[o.counts.issues, "with issues"], [o.counts.clean, "clean"], [o.counts.notChecked, "not checked"], [o.counts.dismissed, "dismissed"]]),
};
