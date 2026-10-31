import { CircleCheck, CircleX, Download, ExternalLink, ListChecks, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, getKey, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, Disclosure, ErrorState, LinkButton, Metric, PageHeader, Ribbon, RibbonLegend, Skeleton } from "../../components/ui";
import { downloadBlob, plural, relativeTime } from "../../lib/format";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError, plainWords } from "../../lib/labels";
import { routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { STATE_HELP, ticksFor } from "../dashboard/dashboard";
import { help } from "../../lib/help";
import { BadgeKey, Tooltip } from "../../components/Tooltip";
import type { Integration } from "../integrations/types";
import { DecisionDialog, type Decision } from "./DecisionDialog";
import {
    apiMessage,
    auditSentence,
    DECISION_BADGE,
    groupByArea,
    manualTicks,
    PRIORITY_LABEL,
    READINESS_TONE,
    RESULT_LABEL,
    RESULTS,
    saveName,
    savedName,
    signedSentence,
    type AuditEntry,
    type ReleaseView,
    type Result,
    type ViewItem,
} from "./manual";
import "./manual.css";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
/** An approval past a block (manual-releases.ts: it needs `override` and a written reason). */
const OVERRIDE = "Approved although something stopped an approval; the person wrote why it went ahead anyway.";

/** One release: how the automated tests look, the manual checklist, the blocking reasons, the decision and its history. */
export function ReleaseDetail({ id, releaseId }: { id: string; releaseId: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const fetched = useFetch<ReleaseView>(`/projects/${id}/releases/${releaseId}`);
    const trackers = useFetch<Integration[]>(`/projects/${id}/integrations`);
    const [view, setView] = useState<ReleaseView>();
    const [dialog, setDialog] = useState<Decision | null>(null);
    const [name, setName] = useState(savedName);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => setView(fetched.data), [fetched.data]);

    const v = view;
    const projectName = project.data?.name;
    useDocumentTitle(v ? `${v.name}, release` : "Release");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: projectName ?? "…", href: routes.project(id) }, { label: "Releases", href: routes.releases(id) }, { label: v?.name ?? "…" }], nav: "projects" });

    if (fetched.loading) {
        return (
            <div className="stack">
                <Skeleton w={260} h={28} />
                <Skeleton h={120} style={{ borderRadius: 8 }} />
                <Skeleton h={220} style={{ borderRadius: 8 }} />
            </div>
        );
    }
    if (fetched.error || !v) return <ErrorState error={friendlyError(fetched.error?.message ?? "Release not found")} onRetry={fetched.reload} />;

    const signed = v.frozen;
    const badge = DECISION_BADGE[v.status];
    // The platform's sentence starts with "Release <name>:"; a release that is itself called "Release 1.4" would read "Release Release 1.4".
    const sentence = /^release/i.test(v.name) ? v.sentence.replace(/^Release /, "") : v.sentence;

    async function refresh() {
        setBusy(true);
        setError("");
        try {
            setView(await api<ReleaseView>(`/projects/${id}/releases/${releaseId}/refresh`, { method: "POST" }));
        } catch (e) {
            setError(apiMessage(e));
        } finally {
            setBusy(false);
        }
    }

    async function downloadReport() {
        setError("");
        try {
            const res = await fetch(`/api/projects/${id}/releases/${releaseId}/report?format=html`, { headers: getKey() ? { "x-api-key": getKey() } : {} });
            if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
            downloadBlob(await res.blob(), `sign-off-${v!.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.html`);
        } catch (e) {
            setError(`Download failed. ${apiMessage(e)}`);
        }
    }

    return (
        <>
            <PageHeader
                title={v.name}
                subtitle={
                    <>
                        <Badge tone={badge.tone} tip={badge.help} tipFocusable>
                            {badge.label}
                        </Badge>
                        <span>Opened {relativeTime(v.createdAt)}</span>
                    </>
                }
                actions={
                    <>
                        <LinkButton href={routes.manualCases(id)} icon={ListChecks}>
                            Manual cases
                        </LinkButton>
                        {!signed && (
                            <Button icon={RefreshCw} loading={busy} onClick={() => void refresh()} tip="Reads the automated results again now. Nothing is run.">
                                Refresh automated results
                            </Button>
                        )}
                        <Button icon={Download} onClick={() => void downloadReport()} tip="Saves the sign-off, with both kinds of results and the history, as an HTML file.">
                            Download report
                        </Button>
                        {signed && (
                            <Button icon={Undo2} onClick={() => setDialog("reopen")}>
                                Reopen
                            </Button>
                        )}
                    </>
                }
            />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />

            <div className="stack">
                <p className="rel-sentence" aria-live="polite" data-testid="release-sentence">
                    {sentence}
                </p>
                {v.notes && <p className="t-secondary rel-notes">{v.notes}</p>}
                {error && <Callout tone="danger">{error}</Callout>}

                {v.decision && (
                    <Callout tone={v.decision === "approved" ? "success" : "danger"} title={signedSentence(v, when)}>
                        {[...v.audit].reverse().find((a) => a.kind !== "reopened")?.comment || "This release is signed. Reopen it to change anything."}
                    </Callout>
                )}

                <Automated v={v} />

                <Checklist v={v} projectId={id} name={name} setName={setName} setView={setView} trackers={trackers.data ?? []} />

                <SignOff v={v} openDialog={setDialog} />

                <History audit={v.audit} />
            </div>

            {dialog && (
                <DecisionDialog
                    projectId={id}
                    release={v}
                    decision={dialog}
                    name={name}
                    onClose={() => setDialog(null)}
                    onDone={(updated) => {
                        setView(updated);
                        setDialog(null);
                    }}
                />
            )}
        </>
    );
}

function Automated({ v }: { v: ReleaseView }) {
    const a = v.automated;
    const ticks = ticksFor(a.tests);
    const reasons = a.readiness.reasons;
    const rate = a.latestRun?.passRate;
    const findings = a.findings.critical + a.findings.high + a.findings.medium + a.findings.low;
    return (
        <section aria-labelledby="rel-auto">
            <div className="section-head">
                <h2 className="t-section" id="rel-auto">
                    Automated tests
                </h2>
                <Badge tone={READINESS_TONE[a.readiness.state]} tip={STATE_HELP[a.readiness.state]} tipFocusable icon={a.readiness.state === "ready" ? CircleCheck : a.readiness.state === "blocked" ? CircleX : TriangleAlert}>
                    {a.readiness.label}
                </Badge>
                <span className="t-meta">{v.frozen ? `As it was when signed, ${when(a.takenAt)}` : `Live, checked ${relativeTime(a.takenAt)}`}</span>
            </div>
            <div className="card divided" style={{ overflow: "hidden" }}>
                {ticks.length > 0 ? (
                    <div className="ribbon-wrap">
                        <Ribbon ticks={ticks} label={`${plural(a.tests.total, "automated test")}: ${a.tests.validated} passing, ${a.tests.needsAttention} need a look, ${a.tests.couldNotValidate} failing, ${a.tests.waiting} not run yet`} />
                        <RibbonLegend pass={a.tests.validated} attention={a.tests.needsAttention} fail={a.tests.couldNotValidate} idle={a.tests.waiting} />
                    </div>
                ) : (
                    <p className="section t-secondary">This project has no automated tests yet, so there is nothing to show here. <a href={routes.newProject({ project: v.projectId })}>Explore the application</a> to create some.</p>
                )}
                <div className="metrics">
                    <Metric value={rate === null || rate === undefined ? "No run" : `${Math.round(rate)}%`} label="Of the tests that ran, passed" tip={`From the newest run. ${help("metric", "passRate")}`} tone={rate === 100 && !a.tests.couldNotValidate && !a.tests.needsAttention ? "ok" : undefined} />
                    <Metric value={findings} label="Findings" tip="Tests that need a look now, at any severity. Tests in quarantine are not counted." tone={findings ? "warn" : undefined} />
                    <Metric value={a.flaky} label="Unreliable tests" tip="Tests whose last 20 results changed at least twice, or that passed when run again straight after failing." tone={a.flaky ? "warn" : undefined} />
                    <Metric value={a.apiBreakingChanges} label="Breaking API changes" tip="Changes between the API answers of the last two runs that can break existing clients: a field, type or endpoint they rely on." tone={a.apiBreakingChanges ? "warn" : undefined} />
                </div>
                {a.latestRun?.sentence && (
                    <p className="section t-secondary" data-testid="rel-last-run">
                        Last run: {a.latestRun.sentence} {a.latestRun.others}
                    </p>
                )}
                <div className="section stack-sm">
                    {reasons.length > 0 ? (
                        <ul className="rel-reasons" aria-label="Why the automated tests are not ready">
                            {reasons.map((r) => (
                                <li key={r.code}>{plainWords(r.text)}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className="t-secondary">{a.readiness.state === "ready" ? "Nothing in the automated tests needs attention." : "There is not enough information yet to say how the automated tests look."}</p>
                    )}
                </div>
            </div>
        </section>
    );
}

function Checklist({ v, projectId, name, setName, setView, trackers }: { v: ReleaseView; projectId: string; name: string; setName: (n: string) => void; setView: (v: ReleaseView) => void; trackers: Integration[] }) {
    const r = v.manual.rollup;
    const groups = groupByArea(v.manual.items);
    const [pending, setPending] = useState<Record<string, Result>>({});
    const [error, setError] = useState("");

    async function save(item: ViewItem, patch: { result: Result; note?: string }) {
        setError("");
        setPending((p) => ({ ...p, [item.id]: patch.result }));
        try {
            const updated = await api<ReleaseView>(`/projects/${projectId}/releases/${v.id}/results/${item.id}`, { method: "PUT", body: { ...patch, ...(name.trim() ? { by: name.trim() } : {}) } });
            setView(updated);
        } catch (e) {
            setError(`Could not save the result for “${item.title}”. ${apiMessage(e)}`);
        } finally {
            setPending((p) => {
                const { [item.id]: _gone, ...rest } = p;
                return rest;
            });
        }
    }

    return (
        <section aria-labelledby="rel-manual">
            <div className="section-head">
                <h2 className="t-section" id="rel-manual">
                    Manual checks
                </h2>
                {r.total === 0 ? (
                    <span className="t-meta">None yet</span>
                ) : (
                    <Tooltip content="Not run and Blocked count as left. Passed, Failed and Skipped count as done.">
                        <span className="t-meta" tabIndex={0}>
                            {r.left === 0 ? `All ${r.total} done` : `${r.left} of ${r.total} left`}
                        </span>
                    </Tooltip>
                )}
            </div>
            {r.total === 0 ? (
                <div className="card card-pad stack-sm">
                    <p>This project has no manual cases, so there is nothing to check by hand. Add the checks a person has to do, like looking at a printout or asking another team, and every release will list them.</p>
                    <div>
                        <LinkButton href={routes.manualCases(projectId)} icon={ListChecks}>
                            Add manual cases
                        </LinkButton>
                    </div>
                </div>
            ) : (
                <div className="card divided" style={{ overflow: "hidden" }}>
                    <div className="ribbon-wrap">
                        <Ribbon ticks={manualTicks(r)} label={`${plural(r.total, "manual check")}: ${r.passed} passed, ${r.failed} failed, ${r.blocked} blocked, ${r.skipped} skipped, ${r.notRun} not run`} />
                        <div className="ribbon-legend">
                            {r.passed + r.skipped > 0 && (
                                <span>
                                    <i className="pass" aria-hidden />
                                    {r.passed} passed{r.skipped ? `, ${r.skipped} skipped` : ""}
                                </span>
                            )}
                            {r.blocked > 0 && (
                                <span>
                                    <i className="attention" aria-hidden />
                                    {r.blocked} blocked
                                </span>
                            )}
                            {r.failed > 0 && (
                                <span>
                                    <i className="fail" aria-hidden />
                                    {r.failed} failed
                                </span>
                            )}
                            {r.notRun > 0 && (
                                <span>
                                    <i className="idle" aria-hidden />
                                    {r.notRun} not run
                                </span>
                            )}
                        </div>
                    </div>
                    {!v.frozen && (
                        <div className="section rel-name">
                            <div className="field">
                                <label htmlFor="rel-by">Your name (recorded with each result)</label>
                                <input
                                    id="rel-by"
                                    className="input"
                                    value={name}
                                    maxLength={80}
                                    autoComplete="name"
                                    onChange={(e) => setName(e.target.value)}
                                    onBlur={() => name.trim() && saveName(name.trim())}
                                />
                            </div>
                        </div>
                    )}
                    {error && (
                        <div className="section">
                            <Callout tone="danger">{error}</Callout>
                        </div>
                    )}
                    {groups.map(([area, items]) => {
                        const done = items.filter((i) => i.result !== "not_run" && i.result !== "blocked").length;
                        return (
                            <div key={area} className="rel-area" role="group" aria-label={`Area ${area}`}>
                                <div className="group-head-static">
                                    <h3 className="t-card">{area}</h3>
                                    <span className="t-meta">
                                        {done} of {items.length} done
                                    </span>
                                </div>
                                <ul className="list divided">
                                    {items.map((item) => (
                                        <CheckItem key={item.id} item={item} shown={pending[item.id] ?? item.result} locked={v.frozen} trackers={trackers} releaseId={v.id} projectId={projectId} onSave={(patch) => save(item, patch)} onChanged={setView} />
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

function CheckItem({ item, shown, locked, trackers, releaseId, projectId, onSave, onChanged }: { item: ViewItem; shown: Result; locked: boolean; trackers: Integration[]; releaseId: string; projectId: string; onSave: (p: { result: Result; note?: string }) => void; onChanged: (v: ReleaseView) => void }) {
    const [note, setNote] = useState(item.note);
    const [editingNote, setEditingNote] = useState(false);
    const [issueError, setIssueError] = useState("");
    const [filing, setFiling] = useState(false);
    const lastSaved = useRef(item.note);
    useEffect(() => {
        setNote(item.note);
        lastSaved.current = item.note;
    }, [item.note]);

    const commitNote = () => {
        if (note !== lastSaved.current) {
            lastSaved.current = note;
            onSave({ result: shown, note });
        }
    };
    const tracker = trackers[0];

    async function fileIssue() {
        if (!tracker) return;
        setFiling(true);
        setIssueError("");
        try {
            await api(`/projects/${projectId}/releases/${releaseId}/results/${item.id}/issue`, { method: "POST", body: { integrationId: tracker.id } });
            onChanged(await api<ReleaseView>(`/projects/${projectId}/releases/${releaseId}`));
        } catch (e) {
            setIssueError(`The issue was not created. ${apiMessage(e)}`);
        } finally {
            setFiling(false);
        }
    }

    return (
        <li className="mc-item" data-result={shown}>
            <div className="mc-item-main">
                <span className="title">{item.title}</span>
                <span className="t-meta">
                    {PRIORITY_LABEL[item.priority]} priority
                    {item.by && item.at ? (
                        <>
                            <span className="dot-sep" />
                            {RESULT_LABEL[item.result]} by {item.by}, {relativeTime(item.at)}
                        </>
                    ) : null}
                </span>
                {item.steps.length > 0 && (
                    <details className="mc-steps-view">
                        <summary>Steps ({item.steps.length})</summary>
                        <ol>
                            {item.steps.map((s, i) => (
                                <li key={i}>
                                    {s.action}
                                    {s.expected && <span className="t-meta"> Expected: {s.expected}</span>}
                                </li>
                            ))}
                        </ol>
                        {item.requirement && <p className="t-meta">Requirement: {item.requirement}</p>}
                    </details>
                )}
            </div>
            <fieldset className="mc-result" disabled={locked}>
                <legend className="sr-only">Result for {item.title}</legend>
                {RESULTS.map((r) => (
                    <label key={r} className={`mc-opt mc-opt-${r}`}>
                        <input type="radio" name={`result-${item.id}`} value={r} checked={shown === r} onChange={() => onSave({ result: r, note })} />
                        <span>{RESULT_LABEL[r]}</span>
                    </label>
                ))}
            </fieldset>
            <div className="mc-note">
                {locked ? (
                    item.note && <p className="t-secondary">Note: {item.note}</p>
                ) : editingNote || item.note ? (
                    <div className="field">
                        <label htmlFor={`note-${item.id}`}>Note for “{item.title}”</label>
                        <textarea id={`note-${item.id}`} className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} onBlur={commitNote} />
                    </div>
                ) : (
                    <Button size="sm" variant="ghost" onClick={() => setEditingNote(true)} aria-label={`Add a note to ${item.title}`}>
                        Add a note
                    </Button>
                )}
                {locked && !item.note && null}
                {item.result === "failed" && (
                    <div className="mc-issue">
                        {item.issue ? (
                            <a href={item.issue.url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                                Issue {item.issue.externalId} <ExternalLink size={13} aria-hidden />
                            </a>
                        ) : tracker ? (
                            <Button size="sm" loading={filing} onClick={() => void fileIssue()}>
                                Create issue in {tracker.name}
                            </Button>
                        ) : null}
                        {issueError && <span className="error-text">{issueError}</span>}
                    </div>
                )}
            </div>
        </li>
    );
}

function SignOff({ v, openDialog }: { v: ReleaseView; openDialog: (d: Decision) => void }) {
    const { blocking, warnings, rules } = v.signoff;
    return (
        <section aria-labelledby="rel-sign">
            <div className="section-head" data-tour="release-signoff">
                <h2 className="t-section" id="rel-sign">
                    Sign-off
                </h2>
            </div>
            <div className="card card-pad stack-sm">
                {v.frozen ? (
                    <p className="t-secondary">This release is signed and cannot be changed. To change the decision, reopen it; that is recorded in the history.</p>
                ) : (
                    <>
                        {blocking.length > 0 ? (
                            <div className="callout callout-danger" role="status">
                                <CircleX size={18} aria-hidden style={{ flex: "none", marginTop: 2 }} />
                                <div className="body">
                                    <div className="title">Not ready to approve</div>
                                    <ul className="rel-reasons" aria-label="Reasons this release cannot be approved">
                                        {blocking.map((b) => (
                                            <li key={b.code + b.text}>{b.text}</li>
                                        ))}
                                    </ul>
                                    <p>You can still approve with an override and a comment that explains why.</p>
                                </div>
                            </div>
                        ) : (
                            <Callout tone="success" title="Nothing blocks this approval" />
                        )}
                        {warnings.length > 0 && (
                            <div className="callout callout-warning">
                                <TriangleAlert size={18} aria-hidden style={{ flex: "none", marginTop: 2 }} />
                                <div className="body">
                                    <div className="title">Worth knowing</div>
                                    <ul className="rel-reasons" aria-label="Warnings">
                                        {warnings.map((b) => (
                                            <li key={b.code + b.text}>{b.text}</li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        )}
                        <div className="row">
                            <Button variant="primary" onClick={() => openDialog("approved")}>
                                Approve
                            </Button>
                            <Button onClick={() => openDialog("rejected")}>Reject</Button>
                        </div>
                    </>
                )}
                <Disclosure label="How the decision is made">
                    <div className="stack-sm">
                        <div>
                            <h3 className="t-card">Stops an approval</h3>
                            <ul className="bullets">
                                {rules.blocking.map((r) => (
                                    <li key={r}>{r}</li>
                                ))}
                            </ul>
                        </div>
                        <div>
                            <h3 className="t-card">Only a warning</h3>
                            <ul className="bullets">
                                {rules.warnings.map((r) => (
                                    <li key={r}>{r}</li>
                                ))}
                            </ul>
                        </div>
                        <p className="t-secondary">{rules.override}</p>
                        <p className="t-secondary">{rules.immutable}</p>
                    </div>
                </Disclosure>
            </div>
        </section>
    );
}

function History({ audit }: { audit: AuditEntry[] }) {
    return (
        <section aria-labelledby="rel-history">
            <div className="section-head">
                <h2 className="t-section" id="rel-history">
                    History
                </h2>
                <BadgeKey label="Override" entries={[audit.some((e) => e.override) && { word: "Override", text: OVERRIDE }]} />
            </div>
            {audit.length === 0 ? (
                <div className="card card-pad">
                    <p className="t-secondary">Nothing recorded yet. Every approval, rejection and reopening is listed here with who did it and when, and cannot be edited.</p>
                </div>
            ) : (
                <ol className="card list divided rel-history" aria-label="History of decisions">
                    {audit.map((e) => (
                        <li key={e.id} className="rel-entry">
                            <div className="row">
                                <strong>{auditSentence(e)}</strong>
                                {e.override && <Badge tone="warning" tip={OVERRIDE}>Override</Badge>}
                                <span className="t-meta">{when(e.at)}</span>
                            </div>
                            {e.comment && <p className="t-secondary">{e.comment}</p>}
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
