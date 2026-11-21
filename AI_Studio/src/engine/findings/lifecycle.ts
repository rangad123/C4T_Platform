/**
 * The finding lifecycle (testing-engine Phase 5, spec §5.1 item 1). Pure: the states, who may move a finding from one to another, and
 * the sentence that says why a move is refused. The store (candidate-finding-store.ts, slot 71) keeps the history; this table decides.
 *
 * The owner's path: Detected → Candidate → Verification pending → Reproduced → Confirmed or Unconfirmed → Classified → Reported, plus the
 * side states Duplicate, Flaky, Environment issue, Automation issue and Needs manual review. "Not a bug" is a person's verdict (the
 * card's action), so it is a state too. Classified and Reported follow Confirmed only: an unconfirmed finding stays explicitly
 * unverified, moves to a side state, or waits for a person. Fixed and Accepted risk close a finding as the security module's states do
 * (S2 maps them); a person accepts a confirmed risk with a reason, and only the regression service (X1) will move a finding to Fixed.
 *
 * A failed test enters as Detected and never becomes a Candidate while its failure is the test's own step (validation/test-fault.ts):
 * not every failed test is an application defect.
 */
import type { FindingConfidence } from "../explore/finding.js";

export const MAIN_STATES = ["detected", "candidate", "verification_pending", "reproduced", "confirmed", "unconfirmed", "classified", "reported"] as const;
export const SIDE_STATES = ["duplicate", "flaky", "environment_issue", "automation_issue", "needs_manual_review", "not_a_bug"] as const;
export const CLOSED_STATES = ["fixed", "accepted_risk"] as const;
export const FINDING_STATES = [...MAIN_STATES, ...SIDE_STATES, ...CLOSED_STATES] as const;
export type FindingState = (typeof FINDING_STATES)[number];
export type Actor = "engine" | "person";

export const STATE_LABEL: Record<FindingState, string> = {
    detected: "Detected",
    candidate: "Candidate",
    verification_pending: "Verification pending",
    reproduced: "Reproduced",
    confirmed: "Confirmed",
    unconfirmed: "Unconfirmed",
    classified: "Classified",
    reported: "Reported",
    duplicate: "Duplicate",
    flaky: "Flaky",
    environment_issue: "Environment issue",
    automation_issue: "Automation issue",
    needs_manual_review: "Needs manual review",
    not_a_bug: "Not a bug",
    fixed: "Fixed",
    accepted_risk: "Accepted risk",
};

/** A move into one of these needs a reason (who decided what, and why). */
export const NEEDS_REASON: readonly FindingState[] = ["unconfirmed", "not_a_bug", "duplicate", "accepted_risk"];

const E: readonly Actor[] = ["engine"];
const P: readonly Actor[] = ["person"];
const EP: readonly Actor[] = ["engine", "person"];

/**
 * Moves beyond the two every open state has (→ Duplicate by either, → Not a bug by a person). A person's verdict (Not a bug) and a
 * merge (Duplicate) are undone only by a person: the engine never reopens what a person closed.
 */
const MOVES: Record<FindingState, Partial<Record<FindingState, readonly Actor[]>>> = {
    detected: { candidate: E, automation_issue: E, environment_issue: E, needs_manual_review: E },
    candidate: { verification_pending: E, needs_manual_review: EP },
    verification_pending: { reproduced: E, unconfirmed: E, flaky: E, automation_issue: E, environment_issue: E, needs_manual_review: E },
    reproduced: { confirmed: EP, unconfirmed: EP, needs_manual_review: E },
    confirmed: { classified: EP, needs_manual_review: P, accepted_risk: P },
    unconfirmed: { verification_pending: EP, flaky: E, automation_issue: E, environment_issue: E, needs_manual_review: EP, confirmed: P },
    classified: { reported: EP, accepted_risk: P },
    reported: { accepted_risk: P },
    flaky: { verification_pending: EP, needs_manual_review: P, confirmed: P },
    environment_issue: { verification_pending: EP, needs_manual_review: P, confirmed: P },
    automation_issue: { verification_pending: EP, needs_manual_review: P, confirmed: P },
    needs_manual_review: { verification_pending: EP, confirmed: P, unconfirmed: P },
    duplicate: { candidate: P },
    not_a_bug: { candidate: P },
    // Fixed comes back: verify it again. Nothing moves a finding to Fixed yet.
    fixed: { verification_pending: EP },
    accepted_risk: { verification_pending: P },
};

/** States a verdict closed: no default move to Duplicate or Not a bug out of them. */
const CLOSED: readonly FindingState[] = ["duplicate", "not_a_bug", ...CLOSED_STATES];

/** Who may move a finding from `from` to `to`; empty when nobody may. */
export function moversOf(from: FindingState, to: FindingState): readonly Actor[] {
    const own = MOVES[from][to];
    if (own) return own;
    const open = !CLOSED.includes(from);
    if (open && to === "duplicate") return from === "reported" ? P : EP;
    if (open && to === "not_a_bug") return P;
    return [];
}

/** Engine moves that would treat the finding as an application defect; a test-step fault blocks them. */
const DEFECT_PATH: readonly FindingState[] = ["candidate", "verification_pending", "reproduced", "confirmed"];

export interface TransitionRequest {
    from: FindingState;
    to: FindingState;
    by: Actor;
    reason?: string | null;
    /** testStepFault's sentence when the failure is the test's own step. */
    stepFault?: string | null;
    /** The finding's confidence (score.ts): the engine confirms only at high. */
    confidence?: FindingConfidence;
}

/** Undefined when the move is allowed, else the sentence that says why not. */
export function checkTransition(t: TransitionRequest): string | undefined {
    const name = (s: FindingState) => STATE_LABEL[s];
    if (t.from === t.to) return `The finding is already ${name(t.to)}.`;
    const movers = moversOf(t.from, t.to);
    if (!movers.includes(t.by)) {
        if (movers.length === 0) return `A finding cannot move from ${name(t.from)} to ${name(t.to)}.`;
        return `Only ${movers[0] === "person" ? "a person" : "the engine"} can move a finding from ${name(t.from)} to ${name(t.to)}.`;
    }
    if (NEEDS_REASON.includes(t.to) && !t.reason?.trim()) return `Say why this finding is ${name(t.to)}: add a reason.`;
    if (t.stepFault && (t.to === "candidate" || (t.by === "engine" && DEFECT_PATH.includes(t.to))))
        return `The failure is the test's own step, not the application, so the finding cannot become ${name(t.to)}. ${t.stepFault}`;
    if (t.to === "confirmed" && t.by === "engine" && t.confidence !== "high")
        return `The engine confirms only at high confidence; this finding is ${t.confidence ?? "not scored"}. A person can confirm it.`;
    return undefined;
}
