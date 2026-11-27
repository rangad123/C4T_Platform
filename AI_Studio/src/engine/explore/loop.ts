/**
 * The bounded exploration loop (Phase 3, P3-06). Pure: the browser, the model, the clock and the AI usage counter are all injected.
 *
 * One session pursues objectives by priority under fixed budgets. The loop, not the model, decides when to stop:
 * - every action goes through `ctx.act` before it reaches the application, which the loop counts and refuses once a budget is spent,
 *   when the same action is tried again on the same state, or when one state is visited more often than the depth allows (both tracked
 *   per pass of a pursuit: after the safe reset and after `ctx.freshPass`); a replay without AI is counted through `ctx.replay`;
 * - AI calls and tokens are read from the injected usage counter (relative to the session start), never from what a pursuit reports;
 * - time is read from the injected clock, and a pursuit that never returns is abandoned when the time is up or the session is cancelled;
 * - N consecutive environment failures (a failed run, a thrown error, a failed reset) stop the session as unstable;
 * - an objective run that reports an unsafe action stops the session.
 * The session ends with exactly one stop reason, the first one recorded. The action log and per-objective outcomes say what happened, so
 * a stuck or stopped session can be explained from its record alone.
 */

export const STOP_REASONS = ["time", "actions", "ai_calls", "tokens", "objectives_done", "instability", "safety", "cancelled"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface Budgets {
    /**
     * Objective pursuits (one objective with one operator) started in the session; skipped duplicates do not count. The cap on
     * objectives themselves is applied when the list is built (orchestrator.ts objectivePursuits, the same number).
     */
    objectives: number;
    actions: number;
    aiCalls: number;
    tokens: number;
    minutes: number;
    /** How often one state may be visited in one pursuit. */
    depth: number;
    /**
     * The actions (not replays) all pursuits of one objective may take together (`LoopObjective.share`); absent: no share. A pursuit is
     * refused past it, and the objective's later pursuits are not started, so one objective cannot spend the session's actions.
     */
    objectiveActions?: number;
}

export interface LoopObjective {
    id: string;
    priority: number;
    /** `objectiveFingerprint` (P3-02): the same objective twice is pursued once. */
    fingerprint: string;
    /** The objective this pursuit belongs to: its pursuits share `Budgets.objectiveActions`. Absent: its own id. */
    share?: string;
}

export interface UsageCounter {
    aiCalls: number;
    tokens: number;
}

export interface LoopAction {
    /** `stateFingerprint(url, outline)` of the page the action is taken on. */
    state: string;
    /** What is done, as a stable key (for example "click button Add" or "fill Email"). */
    action: string;
    /** It only reads the page (a wait, a check): counted and refused on a repeat, but not a new visit of its state for the depth. */
    read?: boolean;
    /** Why the action's own tracker refuses it (the request bound, CP3b R-2): refused like a repeat, and the pursuit ends. */
    refusal?: string;
}

export type ActVerdict = { allowed: true } | { allowed: false; reason: string };

export interface ObjectiveContext {
    /** Ask before every action, before it reaches the application; a refusal means it is not performed and the pursuit must end (its signal is aborted too). */
    act(action: LoopAction): ActVerdict;
    /** A new pass of the same pursuit from its start page (a review's fix, a redo): repeat and depth tracking start again; budgets do not. */
    freshPass(): void;
    /**
     * Ask before saved steps are replayed without the AI (`steps` actions, for example a finding's fresh replays): counted against the
     * session's actions; refused (and logged) when they would go past the actions budget or the pursuit has ended. A refusal does not end the pursuit.
     */
    replay(steps: number, what: string): ActVerdict;
    /** The session stop reason if a budget is spent now (call it before an AI call), else null. */
    check(): StopReason | null;
    /** Aborted when the loop ends this pursuit. */
    signal: AbortSignal;
}

export type ObjectiveRun<R = unknown> =
    | { status: "completed"; result?: R }
    | { status: "environment_failure"; reason: string }
    | { status: "unsafe"; reason: string }
    /** The test writer stopped before it finished (a plain reply, no finish): the objective was not finished, the environment is fine. */
    | { status: "writer_stopped"; reason: string; result?: R };

export type OutcomeStatus = "completed" | "stopped" | "writer_stopped" | "environment_failure" | "unsafe" | "interrupted" | "skipped" | "not_reached";

export interface ObjectiveOutcome<R = unknown> {
    objectiveId: string;
    status: OutcomeStatus;
    reason: string;
    actions: number;
    result?: R;
}

export interface ActionLogRow {
    seq: number;
    objectiveId: string;
    state: string;
    action: string;
    /** Milliseconds since the session started, by the injected clock. */
    atMs: number;
    result: "performed" | "refused";
    reason?: string;
}

export interface ExplorationResult<R = unknown> {
    stopReason: StopReason;
    stopDetail: string;
    outcomes: Array<ObjectiveOutcome<R>>;
    actionLog: ActionLogRow[];
    usage: { objectives: number; actions: number; aiCalls: number; tokens: number; minutes: number };
}

export interface ExplorationInput<O extends LoopObjective, R = unknown> {
    objectives: readonly O[];
    budgets: Budgets;
    runObjective: (objective: O, ctx: ObjectiveContext) => Promise<ObjectiveRun<R>>;
    /** Milliseconds. */
    now: () => number;
    /** Totals so far from the run's own AI counter; the loop uses the change since the session started. */
    usage: () => UsageCounter;
    /** The safe reset between objectives (for the web: a new browser context). */
    reset: () => Promise<void>;
    /** Objective fingerprints done before this session. */
    doneFingerprints?: Iterable<string>;
    /** Consecutive environment failures that stop the session (default 3). */
    instabilityLimit?: number;
    cancel?: AbortSignal;
    /** Resolves after `ms` or when `signal` aborts; injected in tests. Default: a timer. */
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /**
     * Told when a pursuit starts (just before `runObjective`) and when it ends (with its outcome), for the live list of the run page.
     * Objectives the loop skips or never reaches are not pursued, so it is not told about them. Never throws into the loop.
     */
    onPursuit?: (objective: O, outcome?: ObjectiveOutcome<R>) => void;
}

const TEXT_CAP = 300;
const clip = (value: unknown): string => {
    const s = String(value ?? "");
    return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + "…" : s;
};

function timerWait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
        signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
        }, { once: true });
    });
}

function checkBudgets(b: Budgets, instabilityLimit: number): void {
    for (const [name, value] of [...Object.entries(b), ["instabilityLimit", instabilityLimit]] as Array<[string, number]>) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new Error(`The exploration budget "${name}" must be a number of at least 1.`);
    }
}

export async function runExploration<O extends LoopObjective, R = unknown>(input: ExplorationInput<O, R>): Promise<ExplorationResult<R>> {
    const { budgets, now } = input;
    const instabilityLimit = input.instabilityLimit ?? 3;
    checkBudgets(budgets, instabilityLimit);
    const wait = input.wait ?? timerWait;

    const startedAt = now();
    const base = input.usage();
    const spent = () => {
        const u = input.usage();
        return { aiCalls: u.aiCalls - base.aiCalls, tokens: u.tokens - base.tokens };
    };

    // A box, so TypeScript does not narrow it to null across the closures that set it.
    const session: { stop: { reason: StopReason; detail: string } | null } = { stop: null };
    const stopSession = (reason: StopReason, detail: string): void => {
        session.stop ??= { reason, detail };
    };
    const current = () => session.stop;
    let actions = 0;

    // E6: the tokens budget is kept before a call, not one call after it. Each check comes just before an AI call (the caller's gate), so
    // the tokens added between two checks are the calls made in between; the largest per-call amount seen is reserved for the next one.
    let reserve = 0;
    let last = { aiCalls: 0, tokens: 0 };
    /** Records and returns the session stop reason if one applies now. */
    const budgetStop = (): StopReason | null => {
        if (session.stop) return session.stop.reason;
        if (input.cancel?.aborted) stopSession("cancelled", "The session was stopped by a person.");
        else if (now() - startedAt >= budgets.minutes * 60_000) stopSession("time", `The session's time limit of ${budgets.minutes} minutes was reached.`);
        else if (actions >= budgets.actions) stopSession("actions", `The session's limit of ${budgets.actions} actions was reached.`);
        else {
            const u = spent();
            if (u.aiCalls > last.aiCalls) reserve = Math.max(reserve, (u.tokens - last.tokens) / (u.aiCalls - last.aiCalls));
            last = u;
            if (u.aiCalls >= budgets.aiCalls) stopSession("ai_calls", `The session's limit of ${budgets.aiCalls} AI calls was reached.`);
            else if (u.tokens >= budgets.tokens) stopSession("tokens", `The session's limit of ${budgets.tokens} AI tokens was reached.`);
            else if (u.tokens + reserve > budgets.tokens) stopSession("tokens", `The session's limit of ${budgets.tokens} AI tokens would be passed by the next AI call (about ${Math.ceil(reserve)} tokens; ${u.tokens} used).`);
        }
        return current()?.reason ?? null;
    };

    const ordered = input.objectives
        .map((objective, index) => ({ objective, index }))
        .sort((a, b) => b.objective.priority - a.objective.priority || a.index - b.index)
        .map((x) => x.objective);
    const done = new Set(input.doneFingerprints ?? []);
    const outcomes: Array<ObjectiveOutcome<R>> = [];
    const actionLog: ActionLogRow[] = [];
    let pursued = 0;
    let failuresInARow = 0;
    const shareUsed = new Map<string, number>();

    const environmentFailure = (detail: string): void => {
        failuresInARow += 1;
        if (failuresInARow >= instabilityLimit) stopSession("instability", `${failuresInARow} environment failures in a row; the last: ${detail}`);
    };

    for (const objective of ordered) {
        const objectiveId = clip(objective.id);
        if (session.stop) {
            outcomes.push({ objectiveId, status: "not_reached", reason: `The session stopped first: ${session.stop.detail}`, actions: 0 });
            continue;
        }
        if (done.has(objective.fingerprint)) {
            outcomes.push({ objectiveId, status: "skipped", reason: "The same objective was already done in this session or an earlier one.", actions: 0 });
            continue;
        }
        if (pursued >= budgets.objectives) stopSession("objectives_done", `The session's limit of ${budgets.objectives} objective pursuits was reached.`);
        if (budgetStop()) {
            outcomes.push({ objectiveId, status: "not_reached", reason: `The session stopped first: ${session.stop!.detail}`, actions: 0 });
            continue;
        }
        const share = objective.share ?? objective.id;
        const shareFull = budgets.objectiveActions !== undefined ? `The objective's share of ${budgets.objectiveActions} actions was used.` : null;
        if (shareFull && (shareUsed.get(share) ?? 0) >= budgets.objectiveActions!) {
            outcomes.push({ objectiveId, status: "stopped", reason: `${shareFull} Its other pursuits leave the rest of the session to other objectives.`, actions: 0 });
            continue;
        }

        if (pursued > 0) {
            try {
                await input.reset();
            } catch (err) {
                const detail = `The safe reset before this objective failed: ${clip(err instanceof Error ? err.message : err)}`;
                outcomes.push({ objectiveId, status: "environment_failure", reason: detail, actions: 0 });
                environmentFailure(detail);
                continue;
            }
        }
        pursued += 1;

        // Per pursuit: what was done on which state, and why the loop ended it (if it did).
        const visits = new Map<string, number>();
        const seen = new Set<string>();
        const controller = new AbortController();
        let pursuitActions = 0;
        let loopRefusal: string | null = null;
        let sessionStoppedDuring = false;
        let refusalLogged = false;

        const refuse = (state: string, action: string, reason: string): ActVerdict => {
            if (!refusalLogged) {
                actionLog.push({ seq: actionLog.length + 1, objectiveId, state, action, atMs: now() - startedAt, result: "refused", reason });
                refusalLogged = true;
            }
            controller.abort();
            return { allowed: false, reason };
        };

        const ctx: ObjectiveContext = {
            signal: controller.signal,
            check: () => {
                const s = budgetStop();
                if (s) {
                    sessionStoppedDuring = true;
                    controller.abort();
                }
                return s;
            },
            act: (a) => {
                const state = clip(a?.state);
                const action = clip(a?.action);
                if (controller.signal.aborted) return refuse(state, action, loopRefusal ?? session.stop?.detail ?? "This pursuit has ended.");
                if (budgetStop()) {
                    sessionStoppedDuring = true;
                    return refuse(state, action, session.stop!.detail);
                }
                const key = JSON.stringify([state, action]);
                if (seen.has(key)) {
                    loopRefusal = `The same action on the same state was tried again (${action}); it is not repeated.`;
                    return refuse(state, action, loopRefusal);
                }
                if (a?.refusal) {
                    loopRefusal = clip(a.refusal);
                    return refuse(state, action, loopRefusal);
                }
                if (shareFull && (shareUsed.get(share) ?? 0) >= budgets.objectiveActions!) {
                    loopRefusal = shareFull;
                    return refuse(state, action, loopRefusal);
                }
                const visitsHere = (visits.get(state) ?? 0) + (a?.read ? 0 : 1);
                if (visitsHere > budgets.depth) {
                    loopRefusal = `The state ${state} was visited more often than the depth of ${budgets.depth} allows.`;
                    return refuse(state, action, loopRefusal);
                }
                seen.add(key);
                visits.set(state, visitsHere);
                actions += 1;
                pursuitActions += 1;
                shareUsed.set(share, (shareUsed.get(share) ?? 0) + 1);
                actionLog.push({ seq: actionLog.length + 1, objectiveId, state, action, atMs: now() - startedAt, result: "performed" });
                return { allowed: true };
            },
            freshPass: () => {
                seen.clear();
                visits.clear();
            },
            replay: (steps, what) => {
                const n = Math.max(0, Math.floor(Number(steps) || 0));
                const action = clip(`replay: ${what} (${n} steps)`);
                const row = (result: "performed" | "refused", reason?: string) =>
                    actionLog.push({ seq: actionLog.length + 1, objectiveId, state: "", action, atMs: now() - startedAt, result, ...(reason ? { reason } : {}) });
                const ended = controller.signal.aborted ? (loopRefusal ?? session.stop?.detail ?? "This pursuit has ended.") : budgetStop() ? session.stop!.detail : null;
                const over = !ended && actions + n > budgets.actions ? `It would go past the session's limit of ${budgets.actions} actions (${actions} used).` : null;
                const reason = ended ?? over;
                if (reason) {
                    row("refused", reason);
                    return { allowed: false, reason };
                }
                actions += n;
                pursuitActions += n;
                row("performed");
                return { allowed: true };
            },
        };

        const tell = (outcome?: ObjectiveOutcome<R>) => {
            try {
                input.onPursuit?.(objective, outcome);
            } catch {
                /* the live list is told only; it never changes the session */
            }
        };
        tell();

        // The pursuit never rejects: a thrown error is an environment failure.
        let settled: ObjectiveRun<R> | undefined;
        const pursuit = Promise.resolve()
            .then(() => input.runObjective(objective, ctx))
            .then(
                (r) => r,
                (err: unknown): ObjectiveRun<R> => ({ status: "environment_failure", reason: clip(err instanceof Error ? err.message : err) }),
            )
            .then((r) => {
                settled = r;
            });

        // Wait for the pursuit, but no longer than the session's time and not past a cancel.
        let abandoned = false;
        while (settled === undefined) {
            const round = new AbortController();
            const cancelled = new Promise<void>((resolve) => {
                if (input.cancel?.aborted) resolve();
                input.cancel?.addEventListener("abort", () => resolve(), { once: true, signal: round.signal });
            });
            const remaining = budgets.minutes * 60_000 - (now() - startedAt);
            await Promise.race([pursuit, cancelled, wait(remaining, round.signal)]);
            round.abort();
            if (settled !== undefined) break;
            budgetStop();
            // A cancel or the end of the session's time abandons the pursuit whatever stop was recorded first. Asking the stored reason
            // instead kept a session an earlier budget had stopped (actions, AI calls, tokens) in this loop after a cancel, racing promises
            // that had already settled, so the event loop never ran again and the pursuit could never finish (CP2 H-1).
            if (input.cancel?.aborted || now() - startedAt >= budgets.minutes * 60_000) {
                abandoned = true;
                sessionStoppedDuring = true;
                controller.abort();
                break;
            }
        }

        const run = settled as ObjectiveRun<R> | undefined;
        const outcome: ObjectiveOutcome<R> = { objectiveId, status: "completed", reason: "Pursued to the end.", actions: pursuitActions };
        if (abandoned || run === undefined) {
            outcome.status = "interrupted";
            outcome.reason = `The pursuit was abandoned: ${current()?.detail ?? "the session stopped."}`;
        } else if (run.status === "unsafe") {
            outcome.status = "unsafe";
            outcome.reason = clip(run.reason);
            stopSession("safety", `An unsafe action was reported: ${outcome.reason}`);
        } else if (run.status === "environment_failure") {
            outcome.status = "environment_failure";
            outcome.reason = clip(run.reason);
            environmentFailure(outcome.reason);
        } else if (run.status !== "completed" && run.status !== "writer_stopped") {
            outcome.status = "environment_failure";
            outcome.reason = "The objective run returned no recognisable result.";
            environmentFailure(outcome.reason);
        } else {
            failuresInARow = 0;
            done.add(objective.fingerprint);
            if ("result" in run) outcome.result = run.result;
            if (sessionStoppedDuring) {
                outcome.status = "interrupted";
                outcome.reason = `The session stopped during this objective: ${current()?.detail ?? ""}`;
            } else if (loopRefusal) {
                outcome.status = "stopped";
                outcome.reason = loopRefusal;
            } else if (run.status === "writer_stopped") {
                outcome.status = "writer_stopped";
                outcome.reason = clip(run.reason);
            }
        }
        controller.abort();
        outcomes.push(outcome);
        tell(outcome);
        if (!session.stop) budgetStop();
    }

    stopSession("objectives_done", "Every objective was pursued or skipped.");
    const u = spent();
    const final = session.stop!;
    return {
        stopReason: final.reason,
        stopDetail: final.detail,
        outcomes,
        actionLog,
        usage: { objectives: pursued, actions, aiCalls: u.aiCalls, tokens: u.tokens, minutes: (now() - startedAt) / 60_000 },
    };
}
