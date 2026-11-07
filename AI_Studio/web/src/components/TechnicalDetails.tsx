import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventRow, Job } from "../api";
import { JobUsageRows, useJobUsage } from "../features/usage/JobUsage";
import { useFetch } from "../lib/hooks";
import { Button, Skeleton } from "./ui";
import { LiveLine } from "../features/live/LiveStatus";
import { mergeEvents, useJobStream } from "../lib/stream";
import { PHASE_STEP_WORD, taskPhaseOf } from "../features/runs/live-run";

/** Counters, activity log and ids for one analysis. Loaded only when opened. */
export function TechnicalDetails({ job }: { job: Job }) {
    const [open, setOpen] = useState(false);
    return (
        <details className="disclosure" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>
                <ChevronRight size={16} className="chev" aria-hidden />
                View technical details
            </summary>
            <div className="inner">{open && <Body job={job} />}</div>
        </details>
    );
}

function Body({ job }: { job: Job }) {
    const active = !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status);
    // Events arrive by stream while it is connected; the old 3 s polling runs only while it is not (and once at the start, for the backlog).
    const stream = useJobStream(job.jobId, active);
    const streamLive = useRef(false);
    streamLive.current = stream.live;
    const events = useFetch<EventRow[]>(`/test-generation/${job.jobId}/events`, () => (active && !streamLive.current ? 3000 : null));
    const wasLive = useRef(false);
    useEffect(() => {
        // The stream just dropped: look once now and let the polling carry on from there.
        if (wasLive.current && !stream.live && active) void events.reload();
        // The stream is over: one last read so the log is complete.
        wasLive.current = stream.live;
    }, [stream.live]); // eslint-disable-line react-hooks/exhaustive-deps
    const rows = stream.paused ? stream.events : mergeEvents(events.data, stream.events);
    const logRef = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    const seen = useRef(new Set<number>());
    const firstPaint = useRef(true);
    useEffect(() => {
        firstPaint.current = false;
    }, []);
    useLayoutEffect(() => {
        // Follow new lines only if the reader is already at the bottom; never pull them back up while they read.
        const el = logRef.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [rows.length]);
    const usage = useJobUsage(job.jobId, active);
    const c = job.counters;
    return (
        <div className="stack-sm">
            <dl className="kv">
                <dt>Run ID</dt>
                <dd>{job.jobId}</dd>
                {job.ranOn?.kind === "agent" && (
                    <>
                        <dt>Runner</dt>
                        <dd>
                            {job.ranOn.name}
                            {job.ranOn.agentId ? ` (${job.ranOn.agentId})` : ""}
                        </dd>
                        {taskPhaseOf(job) && (
                            <>
                                <dt>Runner task</dt>
                                <dd data-testid="tech-task-phase">{PHASE_STEP_WORD[taskPhaseOf(job)!]}</dd>
                            </>
                        )}
                    </>
                )}
                <dt>Pages explored</dt>
                <dd>{c.pagesDiscovered}</dd>
                <dt>API endpoints</dt>
                <dd>{c.apisDiscovered}</dd>
                <dt>Test ideas planned</dt>
                <dd>{c.scenariosPlanned}</dd>
                {c.scenariosSkipped > 0 && (
                    <>
                        <dt>Test ideas not turned into tests</dt>
                        <dd>{c.scenariosSkipped}</dd>
                    </>
                )}
                {usage && usage.totals.calls > 0 && <JobUsageRows usage={usage} />}
                {!(usage && usage.totals.calls > 0) && (c.llmInputTokens ?? 0) > 0 && (
                    <>
                        <dt>AI usage</dt>
                        <dd>
                            {(c.llmInputTokens! / 1000).toFixed(0)}K input · {((c.llmOutputTokens ?? 0) / 1000).toFixed(0)}K output tokens
                        </dd>
                    </>
                )}
            </dl>
            <div className="t-card">Activity</div>
            {active && (
                <div className="log-head">
                    <LiveLine state={stream.state} />
                    {stream.live && (
                        <Button size="sm" variant="ghost" aria-pressed={stream.paused} tip={stream.paused ? "Shows the lines that arrived meanwhile and follows the log again." : "Holds new lines so the log stops moving while you read. The run itself goes on."} onClick={() => stream.setPaused(!stream.paused)}>
                            {stream.paused ? `Resume updates${stream.held > 0 ? ` (${stream.held} new)` : ""}` : "Pause updates"}
                        </Button>
                    )}
                </div>
            )}
            {events.loading && stream.events.length === 0 ? (
                <Skeleton h={80} />
            ) : (
                <div
                    className="log"
                    tabIndex={0}
                    aria-label="Activity log"
                    ref={logRef}
                    onScroll={(e) => {
                        const el = e.currentTarget;
                        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                    }}
                >
                    {rows.map((e) => {
                        // Lines that arrive after the first paint fade in over 140 ms (not at all with reduced motion).
                        const fresh = !firstPaint.current && !seen.current.has(e.id);
                        seen.current.add(e.id);
                        return (
                            <div key={e.id} className={`${e.level}${fresh ? " fresh" : ""}`}>
                                <time>{new Date(e.createdAt).toLocaleTimeString()}</time>
                                {e.message}
                            </div>
                        );
                    })}
                    {rows.length === 0 && <span className="muted">No activity recorded.</span>}
                </div>
            )}
        </div>
    );
}
