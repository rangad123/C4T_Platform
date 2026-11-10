import { Check, Clock, LoaderCircle, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { RUN_STATUS, STEP_STATUS, TRIGGER_TEXT, tickOf, type RunDetail, type RunSummary, type StepStatus } from "./runbooks";

/** The mini ribbon: one tick per step, in the order of the steps (the shared ribbon colours). */
export function StepTicks({ ticks, label }: { ticks: StepStatus[]; label: string }) {
    return (
        <div className="ribbon sm rb-ticks" role="img" aria-label={label}>
            {ticks.map((t, i) => (
                <i key={i} className={tickOf(t)} style={{ animationDelay: `${i * 30}ms` }} />
            ))}
        </div>
    );
}

/** "3 passed, 1 failed, 2 skipped" for the ribbon's text alternative. */
export function ticksText(ticks: StepStatus[]): string {
    const count = (s: StepStatus) => ticks.filter((t) => t === s).length;
    const parts = [
        [count("passed"), "passed"],
        [count("failed") + count("timed_out"), "failed"],
        [count("skipped"), "skipped"],
        [count("stopped") + count("running"), "in progress or stopped"],
        [count("pending"), "waiting"],
    ].filter(([n]) => (n as number) > 0);
    return `${ticks.length} step${ticks.length === 1 ? "" : "s"}: ${parts.map(([n, t]) => `${n} ${t}`).join(", ")}`;
}

const MARK = {
    passed: Check,
    failed: X,
    timed_out: Clock,
    stopped: Square,
    skipped: Minus,
    pending: Minus,
    running: LoaderCircle,
} as const;

const CLASS: Record<StepStatus, string> = { passed: "done", failed: "failed", timed_out: "failed", running: "running", skipped: "skipped", stopped: "skipped", pending: "pending" };

export const durationText = (ms: number | null): string => {
    if (ms === null) return "";
    if (ms < 1000) return "under a second";
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} second${s === 1 ? "" : "s"}` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/**
 * One run of a runbook, step by step. Follows the run while it is going (every couple of seconds) and offers to cancel it.
 * Each step says what it did in plain words: what a check measured, why a step failed or was skipped.
 */
export function RunView({ projectId, runId, onChanged, onClose }: { projectId: string; runId: string; onChanged: () => void; onClose?: () => void }) {
    const run = useFetch<RunDetail>(`/projects/${projectId}/runbook-runs/${runId}`, (d) => (d && d.finished ? null : 1500));
    const [cancelling, setCancelling] = useState(false);
    const [error, setError] = useState("");
    // Cancelling is running tests (ai_studio.tests.run here): left out for a person who only looks.
    const mayCancel = useHere(projectId).may("ai_studio.tests.run");
    const finished = run.data?.finished;

    // When the run ends, the list around it has news (last result, ribbon).
    useEffect(() => {
        if (finished) onChanged();
    }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

    async function cancel() {
        if (!run.data) return;
        setCancelling(true);
        setError("");
        try {
            await api(`/projects/${projectId}/runbooks/${run.data.runbookId}/runs/${runId}/cancel`, { method: "POST" });
            await run.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setCancelling(false);
        }
    }

    if (run.loading) return <div className="rb-run" aria-busy="true" aria-label="Loading the run"><Skeleton w="40%" /><Skeleton w="70%" /></div>;
    if (run.error || !run.data) return <div className="rb-run"><ErrorState error={friendlyError(run.error?.message)} onRetry={run.reload} /></div>;
    const r = run.data;
    const st = RUN_STATUS[r.status];

    return (
        <section className="rb-run" aria-label={`Run of ${r.runbookName}`} data-run={r.runId} data-status={r.status}>
            <div className="row">
                <Badge tone={st.tone} tip={st.help} tipFocusable>{st.label}</Badge>
                <span className="t-secondary">
                    {TRIGGER_TEXT[r.trigger]}
                    {r.triggerLabel ? ` (${r.triggerLabel})` : ""}, {relativeTime(r.createdAt)}
                    {r.durationMs !== null ? `, took ${durationText(r.durationMs)}` : ""}
                </span>
                <span className="spacer" />
                {!r.finished && mayCancel && (
                    <Button size="sm" variant="danger" loading={cancelling || r.cancelRequested} onClick={cancel} tip="Ends the run now: the job of the current step is asked to stop, and the steps after it do not run.">
                        Cancel the run
                    </Button>
                )}
                {onClose && (
                    <Button size="sm" variant="ghost" onClick={onClose}>
                        Hide
                    </Button>
                )}
            </div>
            {r.reason && <p className="rb-reason">{r.reason}</p>}
            {error && <Callout tone="danger">{error}</Callout>}
            <ol className="steps rb-steps">
                {r.steps.map((s) => {
                    const Mark = MARK[s.status];
                    return (
                        <li key={s.index} className={`step ${CLASS[s.status]}`} data-step-status={s.status}>
                            <span className="mark" aria-hidden>
                                <Mark size={14} className={s.status === "running" ? "spin" : undefined} />
                            </span>
                            <div className="what">
                                <div className="name">
                                    {s.title} <span className="rb-step-status">{STEP_STATUS[s.status]}</span>
                                </div>
                                {s.measured && <div className="t-secondary">{s.measured}</div>}
                                {s.reason && <div className="t-secondary">{s.reason}</div>}
                                {s.jobId && (
                                    <a className="t-meta" href={routes.runs(projectId)}>
                                        See this run in Runs
                                    </a>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}

export type { RunSummary };
