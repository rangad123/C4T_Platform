import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { Badge, Callout } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { CAPTURE_WORD, CONFIDENCE_WORD, confidenceMeaning, findingOrder, NOT_SETTLED, replayText, sourceText, type FindingRecord, type FindingsAnswer } from "./findings";
import { kindWord, operatorWord } from "./objectives";
import "./findings.css";

const NONE = "This run has no findings to check: the AI found none, or the run is from before findings were recorded.";

function objectiveText(o: FindingRecord["finding"]["objective"]): string {
    if (!o) return "None: it came from a planned test";
    return `${kindWord(o.kind)} ${o.source}${o.operator ? ` · ${operatorWord(o.operator)}` : ""}`;
}

function Finding({ rec, n }: { rec: FindingRecord; n: number }) {
    const f = rec.finding;
    const ev = f.evidence;
    const h = `run-finding-${n}`;
    return (
        <li className={`fnd-item is-${f.capture}`} data-testid="finding" data-capture={f.capture} aria-labelledby={h}>
            <div className="fnd-head">
                <h3 className="t-card fnd-title" id={h} data-testid="finding-observed">
                    {f.observed}
                </h3>
                <div className="fnd-badges">
                    <Badge tone="warning">
                        <span data-testid="finding-status">{NOT_SETTLED}</span>
                    </Badge>
                    <Badge tone={f.capture === "captured" ? "info" : "neutral"}>
                        <span data-testid="finding-capture">{CAPTURE_WORD[f.capture]}</span>
                    </Badge>
                </div>
            </div>
            <dl className="run-facts fnd-facts">
                <dt>Objective</dt>
                <dd data-testid="finding-objective">{objectiveText(f.objective)}</dd>
                <dt>Steps in its test</dt>
                <dd data-testid="finding-actions">{plural(f.actions.stepCount, "action")}</dd>
                <dt>Expected</dt>
                <dd>
                    <span className="fnd-block" data-testid="finding-expected">
                        {f.expected.text}
                    </span>
                    <span className="t-meta fnd-block fnd-source" data-testid="finding-source">
                        {sourceText(f.expected.source)}
                    </span>
                </dd>
                <dt>Confidence</dt>
                <dd data-testid="finding-confidence">
                    <span className="fnd-conf">{CONFIDENCE_WORD[f.confidence]}</span>: {confidenceMeaning(f)}
                </dd>
            </dl>
            <details className="disclosure">
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    Evidence ({plural(ev.requests.length, "request")}, {plural(ev.console.length, "console line")})
                </summary>
                <div className="stack-sm fnd-evidence" data-testid="finding-evidence">
                    <p className="t-secondary" data-testid="finding-screenshots">
                        {ev.screenshots.length ? `${plural(ev.screenshots.length, "screenshot")} recorded; they are not shown here yet.` : "Screenshots are not saved with findings yet."}
                    </p>
                    {ev.requests.length > 0 && (
                        <>
                            <h4 className="t-meta fnd-sub">Requests</h4>
                            <ul className="fnd-lines" data-testid="finding-requests">
                                {ev.requests.map((l, i) => (
                                    <li key={i}>{l}</li>
                                ))}
                            </ul>
                        </>
                    )}
                    {ev.console.length > 0 && (
                        <>
                            <h4 className="t-meta fnd-sub">Console</h4>
                            <ul className="fnd-lines" data-testid="finding-console">
                                {ev.console.map((l, i) => (
                                    <li key={i}>{l}</li>
                                ))}
                            </ul>
                        </>
                    )}
                    {f.replays.length > 0 && (
                        <ul className="fnd-replays">
                            {f.replays.map((r, i) => (
                                <li key={i}>{replayText(r)}</li>
                            ))}
                        </ul>
                    )}
                </div>
            </details>
            <p className="t-meta fnd-foot">
                {rec.testId ? (
                    <a href={routes.test(rec.testId)}>
                        Open the saved test <ChevronRight size={14} aria-hidden />
                    </a>
                ) : (
                    <span>Its saved test was deleted.</span>
                )}
                {rec.seenCount > 1 && <span> Seen in {plural(rec.seenCount, "run")}.</span>}
                {f.modelVersion && <span className="fnd-model"> Model {f.modelVersion}</span>}
            </p>
        </li>
    );
}

/**
 * On a finished exploration's page: what the AI found that a person should check, captured findings first. Each finding is a candidate
 * only (found by the AI, needs a person to check), with its objective, expected result and source, what was observed, its evidence, its
 * confidence in words and a link to its saved test. Reading only: anyone who can open the run can read them. An older run, or one that
 * found nothing, says so in one sentence when the project explores by objectives. A refusal from the server is shown as its sentence.
 */
export function CandidateFindings({ projectId, jobId, explores }: { projectId: string; jobId: string; /** The project explores by objectives. */ explores: boolean }) {
    const got = useFetch<FindingsAnswer>(`/projects/${projectId}/candidate-findings?job=${encodeURIComponent(jobId)}`);
    const list = useMemo(() => findingOrder(got.data?.findings ?? []), [got.data]);
    if (got.loading || (!got.data && !got.error)) return null;
    if (!got.error && list.length === 0 && !explores) return null;
    return (
        <section className="card card-pad stack-sm" aria-labelledby="run-findings-h" data-testid="run-findings">
            <h2 className="t-section" id="run-findings-h">
                Findings to check{list.length ? ` (${list.length})` : ""}
            </h2>
            {got.error ? (
                <Callout tone="danger">{describeApiError(got.error)}</Callout>
            ) : list.length === 0 ? (
                <p className="t-secondary" data-testid="run-findings-none">
                    {NONE}
                </p>
            ) : (
                <>
                    <p className="t-secondary">Found by the AI, needs a person to check. Open a finding’s saved test to see what it does, then decide whether the application should behave that way.</p>
                    <ul className="fnd-list">
                        {list.map((r, i) => (
                            <Finding key={r.id} rec={r} n={i} />
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}
