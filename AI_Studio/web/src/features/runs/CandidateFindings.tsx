import { ChevronRight, ExternalLink } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { api, artifactUrl } from "../../api";
import { Modal } from "../../components/Modal";
import { Badge, Button, Callout } from "../../components/ui";
import { useHere } from "../auth/project-access";
import { TRACKER_LABEL, type Integration, type IssueLink } from "../integrations/types";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { externalHref } from "../../lib/url";
import { actionsOf, bucketOf, CAPTURE_WORD, CONFIDENCE_WORD, findingSections, replayText, reproductionText, SEVERITY_WORD, shotAlt, sourceText, stepText, type FindingRecord, type FindingsAnswer } from "./findings";
import { kindWord, operatorWord } from "./objectives";
import "./findings.css";

const NONE = "This run has no findings to check: the AI found none, or the run is from before findings were recorded.";

function objectiveText(o: FindingRecord["finding"]["objective"]): string {
    if (!o) return "None: it came from a planned test";
    return `${kindWord(o.kind)} ${o.source}${o.operator ? ` · ${operatorWord(o.operator)}` : ""}`;
}

const STATUS_TONE = { confirmed: "danger", review: "warning", rest: "neutral" } as const;

/** What a person may change: the actions the lifecycle allows them, a reason for Not a bug, and the issue it was filed as. */
interface Act {
    write: boolean;
    tracker: Integration | undefined;
    onChanged: () => void;
}

function Actions({ rec, projectId, act }: { rec: FindingRecord; projectId: string; act: Act }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [asking, setAsking] = useState(false);
    const [reason, setReason] = useState("");
    const [filed, setFiled] = useState<IssueLink | null>(null);
    const can = actionsOf(rec, act.tracker !== undefined);
    if (!act.write || !(can.confirm || can.notABug || can.split || can.fileIssue)) return null;

    async function run(go: () => Promise<unknown>): Promise<boolean> {
        setBusy(true);
        setError("");
        try {
            await go();
            return true;
        } catch (e) {
            setError(describeApiError(e));
            return false;
        } finally {
            setBusy(false);
        }
    }
    const move = (action: "confirm" | "not_a_bug" | "split", why?: string) =>
        run(() => api(`/projects/${projectId}/findings/${rec.id}/transition`, { method: "POST", body: { action, ...(why ? { reason: why } : {}) } })).then((ok) => ok && act.onChanged());
    const fileIssue = () => run(async () => setFiled((await api<{ link: IssueLink }>(`/projects/${projectId}/findings/${rec.id}/issue`, { method: "POST", body: { integrationId: act.tracker!.id } })).link));
    function notABug(e: FormEvent) {
        e.preventDefault();
        if (!reason.trim()) return setError("Say why this is not a bug.");
        void move("not_a_bug", reason.trim()).then(() => setAsking(false));
    }

    return (
        <div className="stack-sm">
            <div className="fnd-actions" role="group" aria-label="What to do with this finding">
                {can.confirm && (
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void move("confirm")}>
                        Confirm
                    </Button>
                )}
                {can.notABug && (
                    <Button size="sm" disabled={busy} onClick={() => { setError(""); setAsking(true); }}>
                        Not a bug
                    </Button>
                )}
                {can.split && (
                    <Button size="sm" disabled={busy} tip="Take this finding out of its group, so it is checked on its own." onClick={() => void move("split")}>
                        Split
                    </Button>
                )}
                {can.fileIssue && !filed && (
                    <Button size="sm" disabled={busy} tip={`Create an issue in ${TRACKER_LABEL[act.tracker!.kind]} (${act.tracker!.name}).`} onClick={() => void fileIssue()}>
                        File issue
                    </Button>
                )}
            </div>
            {filed && (
                <p className="t-meta" data-testid="finding-issue">
                    Filed as{" "}
                    <a href={externalHref(filed.url)} target="_blank" rel="noreferrer">
                        {TRACKER_LABEL[filed.provider]} {filed.externalId}
                        <ExternalLink size={13} aria-hidden />
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                </p>
            )}
            {error && !asking && <Callout tone="danger">{error}</Callout>}
            {asking && (
                <Modal title="Not a bug" titleId={`fnd-nab-${rec.id}`} onClose={() => setAsking(false)} onSubmit={notABug}>
                    <p className="t-secondary">{rec.finding.observed}</p>
                    <div className="field">
                        <label htmlFor={`fnd-reason-${rec.id}`}>Why is this not a bug?</label>
                        <textarea id={`fnd-reason-${rec.id}`} data-autofocus className="input" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
                    </div>
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div className="foot">
                        <Button type="button" onClick={() => setAsking(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={busy}>
                            Not a bug
                        </Button>
                    </div>
                </Modal>
            )}
        </div>
    );
}

function Finding({ rec, n, projectId, act }: { rec: FindingRecord; n: number; projectId: string; act: Act }) {
    const f = rec.finding;
    const ev = f.evidence;
    const rv = rec.review;
    const h = `run-finding-${n}`;
    return (
        <li className={`fnd-item is-${f.capture}`} data-testid="finding" data-capture={f.capture} data-state={rec.state} aria-labelledby={h}>
            <div className="fnd-head">
                <h3 className="t-card fnd-title" id={h} data-testid="finding-observed">
                    {f.observed}
                </h3>
                <div className="fnd-badges">
                    <Badge tone={STATUS_TONE[bucketOf(rec)]}>
                        <span data-testid="finding-status">{rv.label}</span>
                    </Badge>
                    <Badge tone={rv.severity === "critical" || rv.severity === "high" ? "danger" : rv.severity === "medium" ? "warning" : "neutral"}>
                        <span data-testid="finding-severity">{SEVERITY_WORD[rv.severity]} severity</span>
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
                <dd>
                    {rv.steps.length ? (
                        <details className="disclosure">
                            <summary data-testid="finding-actions">
                                <ChevronRight size={16} className="chev" aria-hidden />
                                {plural(rv.steps.length, "step")}
                            </summary>
                            <ol className="fnd-steps" data-testid="finding-steps">
                                {rv.steps.map((s, i) => (
                                    <li key={i}>{stepText(s)}</li>
                                ))}
                            </ol>
                        </details>
                    ) : (
                        <span data-testid="finding-actions">{plural(f.actions.stepCount, "action")}</span>
                    )}
                </dd>
                <dt>Expected</dt>
                <dd>
                    <span className="fnd-block" data-testid="finding-expected">
                        {f.expected.text}
                    </span>
                    <span className="t-meta fnd-block fnd-source" data-testid="finding-source">
                        {sourceText(f.expected.source)}
                    </span>
                </dd>
                <dt>Severity</dt>
                <dd data-testid="finding-severity-basis">
                    <span className="fnd-conf">{SEVERITY_WORD[rv.severity]}</span>
                    {rv.severityBasis ? `: ${rv.severityBasis}` : ""}
                </dd>
                <dt>Confidence</dt>
                <dd data-testid="finding-confidence">
                    <span className="fnd-conf">{CONFIDENCE_WORD[rv.confidence]}</span>: {rv.confidenceBasis}
                </dd>
                <dt>Reproduced</dt>
                <dd data-testid="finding-reproduction">{reproductionText(rv.reproduction)}</dd>
                <dt>Likely cause</dt>
                <dd data-testid="finding-cause">
                    <Badge tone="neutral">
                        <span data-testid="finding-cause-label">{rv.cause.label}</span>
                    </Badge>{" "}
                    {rv.cause.text}
                </dd>
            </dl>
            {ev.screenshots.length > 0 && (
                <ul className="fnd-shots" data-testid="finding-screenshots">
                    {ev.screenshots.map((id, i) => (
                        <li key={id}>
                            <a href={artifactUrl(id)} target="_blank" rel="noreferrer">
                                <img className="fnd-thumb" src={artifactUrl(id)} alt={shotAlt(i, ev.screenshots.length)} loading="lazy" />
                                <span className="t-meta">Open larger</span>
                            </a>
                        </li>
                    ))}
                </ul>
            )}
            <details className="disclosure">
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    Evidence ({plural(ev.screenshots.length, "screenshot")}, {plural(ev.requests.length, "request")}, {plural(ev.console.length, "console line")})
                </summary>
                <div className="stack-sm fnd-evidence" data-testid="finding-evidence">
                    {ev.screenshots.length ? (
                        <p className="t-meta">Password fields and stored secrets are covered in the pictures above.</p>
                    ) : (
                        <p className="t-secondary" data-testid="finding-screenshots">
                            No screenshot was saved for this finding.
                        </p>
                    )}
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
            <Actions rec={rec} projectId={projectId} act={act} />
        </li>
    );
}

/**
 * On a finished exploration's page: what the AI found, in the order a person should look at it. Confirmed findings first, worst
 * severity first; then the ones that need a person's review; the rest folded by their state. Each shows its status (never "Confirmed"
 * below high confidence: the server's label), severity and confidence apart, how often it reproduced, its test's steps, thumbnails, the
 * likely cause with its label, and the actions the lifecycle allows a person who may change tests: Confirm, Not a bug (with a reason),
 * Split (out of its group) and File issue (to the first connected tracker). Anyone who can open the run can read them. An older run, or
 * one that found nothing, says so in one sentence when the project explores by objectives. A refusal from the server is shown as its
 * sentence.
 */
export function CandidateFindings({ projectId, jobId, explores }: { projectId: string; jobId: string; /** The project explores by objectives. */ explores: boolean }) {
    const got = useFetch<FindingsAnswer>(`/projects/${projectId}/candidate-findings?job=${encodeURIComponent(jobId)}`);
    const here = useHere(projectId);
    const write = !here.why("ai_studio.tests.write");
    const trackers = useFetch<Integration[]>(write ? `/projects/${projectId}/integrations` : null);
    const list = got.data?.findings ?? [];
    const sections = useMemo(() => findingSections(got.data?.findings ?? []), [got.data]);
    if (got.loading || (!got.data && !got.error)) return null;
    if (!got.error && list.length === 0 && !explores) return null;
    const act: Act = { write, tracker: trackers.data?.[0], onChanged: () => void got.reload() };
    let n = 0;
    const rows = (rs: FindingRecord[]) => (
        <ul className="fnd-list">
            {rs.map((r) => (
                <Finding key={r.id} rec={r} n={n++} projectId={projectId} act={act} />
            ))}
        </ul>
    );
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
                    <p className="t-secondary">Found by the AI. Confirmed bugs come first, then findings a person needs to check. Open a finding’s saved test to see what it does.</p>
                    {sections.confirmed.length > 0 && (
                        <div className="stack-sm" data-testid="findings-confirmed">
                            <h3 className="t-meta fnd-sub">Confirmed ({sections.confirmed.length})</h3>
                            {rows(sections.confirmed)}
                        </div>
                    )}
                    {sections.review.length > 0 && (
                        <div className="stack-sm" data-testid="findings-review">
                            <h3 className="t-meta fnd-sub">Needs manual review ({sections.review.length})</h3>
                            {rows(sections.review)}
                        </div>
                    )}
                    {sections.folded.map((g) => (
                        <details key={g.state} className="disclosure" data-testid="findings-folded" data-state={g.state}>
                            <summary>
                                <ChevronRight size={16} className="chev" aria-hidden />
                                {g.label} ({g.findings.length})
                            </summary>
                            {rows(g.findings)}
                        </details>
                    ))}
                </>
            )}
        </section>
    );
}
