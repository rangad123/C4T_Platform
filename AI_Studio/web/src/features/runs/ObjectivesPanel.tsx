import { ChevronRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type EventRow, type Job } from "../../api";
import { Badge, Callout } from "../../components/ui";
import { useCan } from "../auth/permissions";
import { describeApiError } from "../../lib/labels";
import { plural } from "../../lib/format";
import { mergeEvents } from "../../lib/stream";
import type { Fetched } from "../../lib/hooks";
import { useFetch } from "../../lib/hooks";
import { StopRun } from "./StopDialog";
import { announceRunsChanged } from "./runs";
import { layersLine, type LayerReport } from "./layers";
import { explorationNote, kindWord, OBJECTIVE_EVENT_KINDS, objectiveRows, operatorWord, pursuitOf, STATE_WORD, stopWord, tallyText, type CoverageAnswer, type ObjectiveRow, type ObjectivesAnswer, type ObjectiveState } from "./objectives";
import "./objectives.css";

const PAGE = 500;

/** The run's events about its objectives: read once from the platform, then what is new every few seconds while the run goes. */
function useObjectiveEvents(jobId: string, active: boolean): EventRow[] {
    const [rows, setRows] = useState<EventRow[]>([]);
    const last = useRef(0);
    const busy = useRef(false);
    const pull = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
            const got: EventRow[] = [];
            for (let i = 0; i < 200; i++) {
                const page = await api<EventRow[]>(`/test-generation/${jobId}/events?after=${last.current}`);
                for (const e of page) last.current = Math.max(last.current, e.id);
                // Facts are kept only for a pursuit's start and end, and only its ids and operator (pursuitOf).
                got.push(...page.filter((e) => OBJECTIVE_EVENT_KINDS.has(e.kind)).map((e) => ({ ...e, data: pursuitOf(e) ?? undefined })));
                if (page.length < PAGE) break;
            }
            if (got.length) setRows((prev) => mergeEvents(prev, got));
        } catch {
            // The next look tries again; the list keeps what it had.
        } finally {
            busy.current = false;
        }
    }, [jobId]);
    useEffect(() => {
        last.current = 0;
        setRows([]);
        void pull();
    }, [pull]);
    useEffect(() => {
        if (!active) {
            void pull();
            return;
        }
        const t = window.setInterval(() => void pull(), 3000);
        return () => clearInterval(t);
    }, [active, pull]);
    return rows;
}

const STATE_TONE: Record<ObjectiveState, "neutral" | "info" | "success" | "warning"> = { waiting: "neutral", running: "info", done: "success", skipped: "warning", unfinished: "warning" };

function ObjectiveItem({ row }: { row: ObjectiveRow }) {
    const o = row.objective;
    return (
        <li className={`obj-item is-${row.state}`} data-testid="objective" data-state={row.state} aria-current={row.state === "running" ? "step" : undefined}>
            <div className="obj-head">
                <p className="obj-question">{o.question}</p>
                <Badge tone={STATE_TONE[row.state]}>{STATE_WORD[row.state]}</Badge>
            </div>
            <p className="t-meta">
                <span className="obj-kind">{kindWord(o.kind)}</span> <span className="obj-source">{o.source}</span>
            </p>
            {o.expected && <p className="t-secondary">Expected: {o.expected}</p>}
            <p className="t-meta" data-testid="objective-reason">
                {o.reason}
            </p>
            {row.why && (
                <p className="obj-why" data-testid="objective-why">
                    {row.why}
                </p>
            )}
            {o.operators.length > 0 && (
                <ul className="obj-ops" aria-label="How it is explored">
                    {o.operators.map((op) => (
                        <li key={op}>{operatorWord(op)}</li>
                    ))}
                </ul>
            )}
            {row.notRun.length > 0 && (
                <ul className="obj-notrun" aria-label="Not run" data-testid="objective-not-run">
                    {row.notRun.map((n) => (
                        <li key={n.operator}>
                            {operatorWord(n.operator)}: {n.reason}
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}

/**
 * The live view's objectives (inside "Progress on the runner"): each with its priority sentence and state, and Stop while the run goes
 * for a person who may run tests. A runner too old to explore by objectives, or a project without an analysed model, gets the
 * platform's one sentence instead of the list. A refusal from the server is shown as its sentence.
 */
export function LiveObjectives({ projectId, job, active, explores, canStop, coverage }: { projectId: string; job: Pick<Job, "jobId" | "mode" | "planOnly">; active: boolean; /** The run explores by objectives (an AI agent project's exploration). */ explores: boolean; canStop: boolean; coverage?: CoverageAnswer }) {
    const events = useObjectiveEvents(job.jobId, active);
    const note = explorationNote(events);
    const planned = events.some((e) => e.kind === "objectives_planned");
    const shown = (explores || planned) && !note;
    const list = useFetch<ObjectivesAnswer>(shown ? `/projects/${projectId}/objectives` : null);
    const rows = useMemo(() => (list.data?.available ? objectiveRows(list.data.objectives, events, { active, coverage }) : []), [list.data, events, active, coverage]);

    if (note)
        return (
            <div className="stack-sm" data-testid="objectives-note">
                <h3 className="t-card">Objectives</h3>
                <Callout tone={note.kind === "need_runner" ? "warning" : "info"}>{note.text}</Callout>
            </div>
        );
    if (!shown) return null;
    const running = rows.find((r) => r.state === "running");
    return (
        <div className="stack-sm obj-live" data-testid="objectives-live">
            <div className="row obj-live-head">
                <h3 className="t-card">Objectives{rows.length ? ` (${rows.length})` : ""}</h3>
                {active && canStop && <StopRun job={{ jobId: job.jobId, projectId, mode: job.mode, planOnly: job.planOnly }} size="sm" onRequested={announceRunsChanged} />}
            </div>
            {list.error ? (
                <Callout tone="danger">{describeApiError(list.error)}</Callout>
            ) : list.loading ? (
                <p className="t-meta">Reading the objectives…</p>
            ) : list.data && !list.data.available ? (
                <p className="t-secondary" data-testid="objectives-unavailable">
                    {list.data.message}
                </p>
            ) : (
                <>
                    {active && !planned && <p className="t-meta">The objectives are explored after the application is understood, highest priority first.</p>}
                    <p className="sr-only" role="status" aria-live="polite">
                        {active && running ? `Exploring: ${running.objective.question}` : ""}
                    </p>
                    <ol className="obj-list" aria-label="Objectives, highest priority first">
                        {rows.map((r) => (
                            <ObjectiveItem key={r.objective.id} row={r} />
                        ))}
                    </ol>
                    {list.data?.available && list.data.overCap > 0 && <p className="t-meta">{plural(list.data.overCap, "more objective")} left out: over this session’s limit.</p>}
                </>
            )}
        </div>
    );
}

/** C12: the "Checked layers" line, and each layer not checked with why (features/runs/layers.ts). */
function CheckedLayers({ layers }: { layers: LayerReport }) {
    const line = layersLine(layers);
    return (
        <div className="stack-sm" data-testid="run-checked-layers">
            <p>
                <strong>Checked layers:</strong> {line.checked}
            </p>
            {line.notChecked.length > 0 && (
                <ul className="obj-reasons t-meta" aria-label="Layers not checked">
                    {line.notChecked.map((n) => (
                        <li key={n.layer}>
                            <span className="obj-what">{n.layer}</span>: not checked, {n.reason}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** A finished run's coverage record, read once (null while the run goes). */
export function useCoverage(projectId: string, jobId: string, enabled: boolean): Fetched<CoverageAnswer> {
    return useFetch<CoverageAnswer>(enabled ? `/projects/${projectId}/jobs/${jobId}/coverage` : null);
}

/**
 * On a finished exploration's page: why the session stopped, what it used of its limits, and its coverage record (what it exercised,
 * what it left unexplored and what did not run, with why). A run without a record shows only the layers it checked, or nothing. A refusal
 * from the server is shown as its sentence.
 */
export function RunCoverage({ coverage }: { coverage: Fetched<CoverageAnswer> }) {
    const can = useCan();
    if (coverage.loading || (!coverage.data && !coverage.error)) return null;
    if (coverage.error)
        return (
            <section className="card card-pad stack-sm" aria-labelledby="run-coverage-h" data-testid="run-coverage">
                <h2 className="t-section" id="run-coverage-h">
                    How the exploration went
                </h2>
                <Callout tone="danger">{describeApiError(coverage.error)}</Callout>
            </section>
        );
    const a = coverage.data!;
    if (!a.available) {
        // No coverage record: a card that would only explain its own emptiness is left out.
        if (!a.layers) return null;
        return (
            <section className="card card-pad stack-sm" aria-labelledby="run-coverage-h" data-testid="run-coverage">
                <h2 className="t-section" id="run-coverage-h">
                    How the exploration went
                </h2>
                <CheckedLayers layers={a.layers} />
            </section>
        );
    }
    const c = a.coverage;
    const tallies: Array<[string, { total: number; exercised: number }]> = [
        ["Pages", c.pages],
        ["Named elements", c.elements],
        ["Workflow steps", c.workflowSteps],
        ["Status changes", c.transitions],
        ["Input classes", c.inputClasses],
        ["Rules", c.rules],
        ["Endpoints", c.endpoints],
    ];
    const showAi = can("ai_studio.usage.view");
    return (
        <section className="card card-pad stack-sm" aria-labelledby="run-coverage-h" data-testid="run-coverage">
            <h2 className="t-section" id="run-coverage-h">
                How the exploration went
            </h2>
            {a.layers && <CheckedLayers layers={a.layers} />}
            <p className="obj-stop" data-testid="run-stop-reason">
                <Badge tone={a.stopReason === "objectives_done" ? "success" : a.stopReason === "cancelled" ? "neutral" : "warning"}>{stopWord(a.stopReason)}</Badge> <span>{a.stopDetail}</span>
            </p>
            <dl className="run-facts" aria-label="Limits used">
                <dt>Objectives</dt>
                <dd>
                    {a.usage.objectives} of {a.budgets.objectives}
                </dd>
                <dt>Actions</dt>
                <dd>
                    {a.usage.actions} of {a.budgets.actions}
                </dd>
                <dt>Minutes</dt>
                <dd>
                    {Math.round(a.usage.minutes * 10) / 10} of {a.budgets.minutes}
                </dd>
                {showAi && (
                    <>
                        <dt>AI calls</dt>
                        <dd>
                            {a.usage.aiCalls} of {a.budgets.aiCalls}
                        </dd>
                    </>
                )}
            </dl>
            <h3 className="t-card">Coverage</h3>
            <dl className="run-facts" data-testid="run-coverage-tallies">
                {tallies.map(([label, t]) => (
                    <Fragment key={label}>
                        <dt>{label}</dt>
                        <dd>{tallyText(t)}</dd>
                    </Fragment>
                ))}
                <dt>Different scenarios</dt>
                <dd>{c.uniqueScenarios}</dd>
            </dl>
            {c.notRun.length > 0 && (
                <details className="disclosure" data-testid="run-coverage-not-run">
                    <summary>
                        <ChevronRight size={16} className="chev" aria-hidden />
                        Not run ({c.notRun.length + c.notRunMore})
                    </summary>
                    <ul className="obj-reasons">
                        {c.notRun.map((n) => (
                            <li key={`${n.objectiveId ?? ""}:${n.operator}`}>
                                <span className="obj-what">{operatorWord(n.operator)}</span>
                                {n.objectiveId && <span className="obj-id"> {n.objectiveId}</span>}: {n.reason}
                            </li>
                        ))}
                    </ul>
                    {c.notRunMore > 0 && <p className="t-meta">And {c.notRunMore} more.</p>}
                </details>
            )}
            {c.unexplored.length > 0 && (
                <details className="disclosure" data-testid="run-coverage-unexplored">
                    <summary>
                        <ChevronRight size={16} className="chev" aria-hidden />
                        Left unexplored ({c.unexplored.length + c.unexploredMore}), highest priority first
                    </summary>
                    <ul className="obj-reasons">
                        {c.unexplored.map((u) => (
                            <li key={u.objectiveId}>
                                <span className="obj-what">
                                    {kindWord(u.kind)} {u.source}
                                </span>
                                : {u.status}
                                <span className="t-meta obj-block">{u.reason}</span>
                            </li>
                        ))}
                    </ul>
                    {c.unexploredMore > 0 && <p className="t-meta">And {c.unexploredMore} more.</p>}
                </details>
            )}
            <p className="t-meta">
                {plural(a.actionLog.length + a.actionLogOmitted, "action")} recorded on {plural(c.states, "page state")}.
            </p>
        </section>
    );
}
