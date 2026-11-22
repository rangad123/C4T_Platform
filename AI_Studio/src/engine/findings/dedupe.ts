/**
 * Duplicate detection (testing-engine Phase 5, spec §5.1 item 4). Pure: a signature per finding, the merge rule, stable group ids and
 * a person's split.
 *
 * Merge rule: two findings are one issue only when they expect the same thing (the same source) AND at least two strong signals agree:
 * the endpoint that failed, the top application stack frames, the failing check (its kind and what it points at), the action
 * sequence up to the failure, a linked issue. The error message and the page are shown but never count: similar messages alone never
 * merge ("expect(locator).toHaveValue(expected) failed" is the same text for every value check). A different endpoint or different
 * stack frames on both sides refuse the merge, whatever else agrees. A group is complete-linkage: a finding joins only if it matches
 * every member, so a chain A~B~C cannot pull two different issues together. Members keep their own evidence and attempts; a group
 * only lists them. The store keeps the groups (slot 71); this decides where new sightings go. Findings of different projects never merge.
 *
 * A person's split is a list of pairs kept apart. It holds only while the caller passes every finding named in those pairs (whatever its
 * state now), and a new sighting that looks like both sides joins neither: it waits on its own for a person.
 */
import { createHash } from "node:crypto";
import { pathPattern } from "../explore/state.js";
import type { Attempt, FindingView } from "./view.js";

export interface Signature {
    projectId: string;
    /** What the finding expects; null = nothing says what it expects, so it never merges. */
    source: string | null;
    endpoint: string | null;
    stack: string | null;
    check: string | null;
    actions: string | null;
    issue: string | null;
    /** Shown, never counted. */
    error: string | null;
    page: string | null;
}
export const STRONG_SIGNALS = ["endpoint", "stack", "check", "actions", "issue"] as const;
type Strong = (typeof STRONG_SIGNALS)[number];
const SIGNAL_WORDS: Record<Strong, string> = { endpoint: "endpoint", stack: "stack frames", check: "failing check", actions: "action sequence", issue: "linked issue" };

/** Case, spacing and counts in brackets do not matter ("Cart (3)" = "Cart (12)"); other digits do ("Address line 1" is not line 2). */
const norm = (s: string | undefined | null) => (s ?? "").normalize("NFKC").toLowerCase().replace(/\(\d+\)/g, "(#)").replace(/\s+/g, " ").trim();
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const pattern = (url: string) => pathPattern(url).replace(/\/#$/, "");

/** `expected:<n>` names that test's own expected result: a source only together with the test. */
const LOCAL_SOURCE = /^expected:\d+$/;

/**
 * The attempt that stands for the finding: the failure that came back most often (the detection when all differ). Only failures
 * about the application: a runner error, the environment or the test's own step says nothing about which issue it is.
 */
function representative(attempts: readonly Attempt[]): Attempt | undefined {
    const failed = attempts.filter((a) => a.outcome === "failed" && !a.stepFault && !a.environment);
    const key = (a: Attempt) => [a.failedStep, norm(a.check), norm(a.target)].join("|");
    const count = (a: Attempt) => failed.filter((b) => key(b) === key(a)).length;
    return failed.reduce<Attempt | undefined>((best, a) => (best === undefined || count(a) > count(best) ? a : best), undefined);
}

export function signatureOf(f: Pick<FindingView, "projectId" | "expected" | "requirements" | "testId" | "attempts" | "steps" | "issueId">): Signature {
    const src = f.expected.source;
    const source =
        src && !LOCAL_SOURCE.test(src)
            ? `ref:${src}`
            : f.requirements.length
              ? `req:${[...f.requirements].sort().join(",")}`
              : src && f.testId
                ? `test:${f.testId}:${src}`
                : null;
    const a = representative(f.attempts);
    // The application's own server error only: a 4xx is often a stray background request (a favicon) or the refusal being tested.
    const failedReq = a?.requests.find((r) => r.own && (r.status ?? 0) >= 500);
    const frames = (a?.stack ?? [])
        // Frames of libraries, and minified frames (a one- or two-letter name), say nothing about which issue it is.
        .filter((s) => !/node_modules|node:internal/.test(s) && !/(?:^|\bat\s+|[\s.])[\w$]{1,2}\s*\(/.test(s))
        .slice(0, 3)
        // Line numbers move between builds.
        .map((s) => s.replace(/:\d+(?::\d+)?\)?$/, "").trim());
    // The steps before the failing one: the failing step itself is the `check` signal, so it is not counted twice.
    const upTo = a?.failedStep ? f.steps.slice(0, a.failedStep - 1) : f.steps;
    return {
        projectId: f.projectId,
        source,
        endpoint: failedReq ? `${failedReq.method.toUpperCase()} ${pattern(failedReq.path)}` : null,
        stack: frames.length ? frames.join(" < ") : null,
        check: a && (a.check || a.target) ? `${norm(a.check)}|${norm(a.target)}` : null,
        actions: upTo.length ? hash(upTo.map((s) => `${s.action}:${norm(s.target)}:${s.url ? pattern(s.url) : ""}`).join("\n")) : null,
        issue: f.issueId ?? null,
        error: a?.error ? norm(a.error.split("\n")[0]!.replace(/(["'`]).*?\1/g, "…")) : null,
        page: a?.page ? pattern(a.page) : null,
    };
}

/** The strong signals two signatures share (both present and equal). */
export function sharedSignals(a: Signature, b: Signature): Strong[] {
    return STRONG_SIGNALS.filter((k) => a[k] !== null && a[k] === b[k]);
}

/** Undefined when the two are one issue, else why not (for the doubt log and the person's view). */
export function mergeRefusal(a: Signature, b: Signature): string | undefined {
    if (a.projectId !== b.projectId) return "They belong to different projects.";
    if (a.source === null || b.source === null) return "Nothing says what one of them expects.";
    if (a.source !== b.source) return "They expect different things (different sources).";
    if (a.endpoint && b.endpoint && a.endpoint !== b.endpoint) return `Different endpoints failed (${a.endpoint}, ${b.endpoint}).`;
    if (!a.endpoint !== !b.endpoint) return "Only one of them had a server error.";
    if (a.stack && b.stack && a.stack !== b.stack) return "Different stack frames.";
    const shared = sharedSignals(a, b);
    if (shared.length < 2) return `Only ${shared.length === 0 ? "the source agrees" : `the source and the ${SIGNAL_WORDS[shared[0]!]} agree`}; a merge needs two strong signals besides it.`;
    return undefined;
}

export interface FindingGroup {
    /** `fg_` + 16 hex of the first member's id: the same group keeps its id as later sightings join. */
    id: string;
    memberIds: string[];
    /** Per joined member (not the first): the signals it shares with the first member. */
    why: Record<string, string>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\n${b}` : `${b}\n${a}`);

/**
 * Group findings of one project. `apart`: pairs a person split (never merged again). Findings are taken oldest first, and each joins
 * the first group whose every member it matches, else starts its own.
 */
export function dedupe(
    findings: ReadonlyArray<Pick<FindingView, "id" | "projectId" | "detectedAt" | "expected" | "requirements" | "testId" | "attempts" | "steps" | "issueId">>,
    apart: ReadonlyArray<readonly [string, string]> = [],
): FindingGroup[] {
    const kept = new Set(apart.map(([a, b]) => pairKey(a, b)));
    const partners = new Map<string, Set<string>>();
    for (const [a, b] of apart) for (const [x, y] of [[a, b], [b, a]] as const) partners.set(x, (partners.get(x) ?? new Set()).add(y));
    const ordered = [...findings].sort((x, y) => Date.parse(x.detectedAt) - Date.parse(y.detectedAt) || x.id.localeCompare(y.id));
    const sigs = new Map(ordered.map((f) => [f.id, signatureOf(f)]));
    const matches = (x: string, y: string) => !kept.has(pairKey(x, y)) && mergeRefusal(sigs.get(x)!, sigs.get(y)!) === undefined;
    const groups: FindingGroup[] = [];
    const placed: string[] = [];
    for (const f of ordered) {
        const s = sigs.get(f.id)!;
        // A split holds for later sightings too: a finding that matches an earlier one a person kept apart from a group's member stays out.
        const like = partners.size ? new Set(placed.filter((o) => partners.has(o) && matches(o, f.id))) : new Set<string>();
        const blocked = (g: FindingGroup) => like.size > 0 && g.memberIds.some((m) => [...(partners.get(m) ?? [])].some((p) => like.has(p)));
        placed.push(f.id);
        const home = groups.find((g) => g.memberIds.every((m) => matches(m, f.id)) && !blocked(g));
        if (!home) {
            groups.push({ id: `fg_${hash(f.id)}`, memberIds: [f.id], why: {} });
            continue;
        }
        const first = sigs.get(home.memberIds[0]!)!;
        home.memberIds.push(f.id);
        home.why[f.id] = `Same source and the same ${sharedSignals(first, s).map((k) => SIGNAL_WORDS[k]).join(", ")} as the first sighting.`;
    }
    return groups;
}

/** A person's split: the pairs between the members who leave and those who stay, to pass to `dedupe` from then on. */
export function splitPairs(group: FindingGroup, leaving: readonly string[]): Array<[string, string]> {
    const strangers = leaving.filter((l) => !group.memberIds.includes(l));
    if (strangers.length) throw new Error(`Not in this group: ${strangers.join(", ")}.`);
    const out = new Set(leaving);
    if (out.size === 0 || out.size === group.memberIds.length) throw new Error("A split leaves some members in the group and moves others out.");
    const stay = group.memberIds.filter((m) => !out.has(m));
    return stay.flatMap((s) => group.memberIds.filter((m) => out.has(m)).map((l) => [s, l] as [string, string]));
}
