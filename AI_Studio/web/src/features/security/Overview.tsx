import { ChevronRight, Plus, ShieldCheck } from "lucide-react";
import { EmptyState, ErrorState, LinkButton, ListSkeleton, Metric } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { help } from "../../lib/help";
import { friendlyError } from "../../lib/labels";
import { relativeTime } from "../../lib/format";
import { routes } from "../../lib/router";
import { SecurityLayout, SeverityTag, StateTag, ValidationTag, canRun, severityKey, stateKey, useRole, validationKey } from "./SecurityChrome";
import { BadgeKey } from "../../components/Tooltip";
import { SEC, SEVERITY_ORDER, SEVERITY_WORDS, TESTING_TYPES, isOpen, listOf, sec, useTestingType, type AppRow, type AssessmentRow, type FindingBrief, type OverviewAnswer } from "./security";

/** The security section's front page: what was assessed, what needs attention, what was fixed, and how the risk line is decided. */
export function SecurityOverview({ id }: { id: string }) {
    const role = useRole();
    const type = useTestingType(id);
    const overview = useFetch<OverviewAnswer>(`${SEC}/projects/${id}/overview`);
    const apps = useFetch<unknown>(`${SEC}/projects/${id}/applications`);
    const assessments = useFetch<unknown>(`${SEC}/projects/${id}/assessments`);
    const appList = listOf<AppRow>(apps.data, "applications");
    const addApp = canRun(role) ? (
        <LinkButton href={sec.newApplication(id)} variant="primary" icon={Plus}>
            Add an application
        </LinkButton>
    ) : null;

    const loading = overview.loading || apps.loading || assessments.loading;
    const failed = apps.error ?? overview.error;
    const body = () => {
        if (loading) return <ListSkeleton rows={3} />;
        if (failed) return <ErrorState error={friendlyError(failed.message)} onRetry={() => void Promise.all([overview.reload(), apps.reload(), assessments.reload()])} />;
        const list = listOf<AssessmentRow>(assessments.data, "assessments");
        if (appList.length === 0)
            return (
                <div className="card">
                    <EmptyState icon={ShieldCheck} title="No assessments yet" actions={addApp}>
                        No assessments yet. Add an application and run your first passive assessment.
                    </EmptyState>
                </div>
            );
        const o = overview.data ?? {};
        const c = o.counts ?? {};
        const bySev = o.risk?.openBySeverity;
        const finished = list.filter((a) => a.state === "COMPLETED" || a.state === "PARTIALLY_COMPLETED");
        const assessed = c.applicationsAssessed ?? new Set(finished.map((a) => a.applicationId)).size;
        const completed = c.assessmentsCompleted ?? finished.length;
        const critHigh = c.openCriticalHigh ?? (bySev?.critical ?? 0) + (bySev?.high ?? 0);
        const review = c.awaitingReview ?? 0;
        const attention = (o.needsAttention ?? []).filter((f) => !f.validation || isOpen(f.validation));
        const fixed = o.fixedRecently ?? [];
        const appName = (appId: string) => appList.find((a) => a.id === appId)?.name ?? "";
        return (
            <div className="stack">
                <div className="card" style={{ overflow: "hidden" }}>
                    <div className="metrics" data-testid="sec-metrics">
                        <Metric value={assessed} label={`Application${assessed === 1 ? "" : "s"} assessed`} tip={help("metric", "applicationsAssessed")} />
                        <Metric value={completed} label={`Assessment${completed === 1 ? "" : "s"} completed`} tip={help("metric", "assessmentsCompleted")} />
                        <Metric value={critHigh} label="Open critical or high" tone={critHigh ? "warn" : undefined} tip={help("metric", "openCriticalHigh")} />
                        <Metric value={review} label="Awaiting review" tone={review ? "warn" : undefined} tip={help("metric", "awaitingReview")} />
                    </div>
                </div>

                {o.risk && (
                    <section className="card card-pad stack-sm" aria-labelledby="sec-risk" data-testid="sec-risk">
                        <h2 className="t-section" id="sec-risk">
                            Risk overview{o.risk.label ? `: ${o.risk.label}` : ""}
                        </h2>
                        {o.risk.reason && <p className="t-secondary">{o.risk.reason}</p>}
                        {bySev && (
                            <p className="t-secondary">
                                Open findings by severity: {SEVERITY_ORDER.map((s) => `${SEVERITY_WORDS[s].label.toLowerCase()} ${bySev[s] ?? 0}`).join(", ")}.
                            </p>
                        )}
                        {(o.risk.rules?.length ?? 0) > 0 && (
                            <>
                                <h3 className="t-card">How this is decided</h3>
                                <ul className="bullets">
                                    {o.risk.rules!.map((r) => (
                                        <li key={r}>{r}</li>
                                    ))}
                                </ul>
                            </>
                        )}
                        <p className="t-meta">This is never a promise that an application is secure: it summarizes what a passive assessment could see and what people entered.</p>
                    </section>
                )}

                <div className="sec-two">
                    <section aria-labelledby="sec-attention">
                        <div className="section-head">
                            <h2 className="t-section" id="sec-attention">
                                Needs attention
                            </h2>
                            <span className="t-meta">Most serious first</span>
                            <BadgeKey label="the severities and states in this list" entries={findingKey(attention.slice(0, 8))} />
                            <span className="spacer" />
                            <a href={sec.findings(id, { open: "1" })}>All open findings</a>
                        </div>
                        {attention.length === 0 ? (
                            <div className="card card-pad">
                                <p className="t-secondary">Nothing open needs attention.</p>
                            </div>
                        ) : (
                            <FindingList id={id} findings={attention.slice(0, 8)} appName={appName} testId="sec-attention-list" />
                        )}
                    </section>
                    <section aria-labelledby="sec-fixed">
                        <div className="section-head">
                            <h2 className="t-section" id="sec-fixed">
                                Fixed after retest
                            </h2>
                            <BadgeKey label="the severities and states in this list" entries={findingKey(fixed.slice(0, 8).map((f) => ({ ...f, validation: f.validation ?? "fixed" })))} />
                        </div>
                        {fixed.length === 0 ? (
                            <div className="card card-pad">
                                <p className="t-secondary">Nothing yet. A retest re-checks open findings and marks the ones it no longer sees as fixed.</p>
                            </div>
                        ) : (
                            <FindingList id={id} findings={fixed.slice(0, 8).map((f) => ({ ...f, validation: f.validation ?? "fixed" }))} appName={appName} testId="sec-fixed-list" />
                        )}
                    </section>
                </div>

                <section aria-labelledby="sec-apps">
                    <div className="section-head">
                        <h2 className="t-section" id="sec-apps">
                            Applications
                        </h2>
                        <BadgeKey
                            label="the assessment states in this list"
                            entries={stateKey(appList.slice(0, 8).map((a) => (a.lastAssessment ?? o.applications?.find((x) => x.id === a.id)?.lastAssessment ?? list.filter((x) => x.applicationId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0])?.state))}
                        />
                        <span className="spacer" />
                        <a href={sec.applications(id)}>All applications</a>
                    </div>
                    <ul className="card list divided">
                        {appList.slice(0, 8).map((a) => {
                            const fromOverview = o.applications?.find((x) => x.id === a.id);
                            const last = a.lastAssessment ?? fromOverview?.lastAssessment ?? list.filter((x) => x.applicationId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0];
                            const open = fromOverview?.openFindings;
                            return (
                                <li key={a.id}>
                                    <a className="list-row" href={sec.application(id, a.id)}>
                                        <span className="main">
                                            <span className="title">{a.name}</span>
                                            <span className="meta sec-list-cols">
                                                <span className="sec-loc">{a.targetUrl}</span>
                                                <span>{last ? `Last assessed ${relativeTime(last.finishedAt ?? last.createdAt)}` : "Not assessed yet"}</span>
                                                {open !== undefined && <span>{open === 1 ? "1 open finding" : `${open} open findings`}</span>}
                                            </span>
                                        </span>
                                        <span className="tail">{last && <StateTag state={last.state} />}</span>
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                </section>
                {type && type.type !== "both" && (
                    <p className="t-meta">
                        This project is for {TESTING_TYPES.find((t) => t.value === type.type)?.label.toLowerCase()} only. <a href={routes.setup(id)}>Change the testing type in Settings</a>
                    </p>
                )}
            </div>
        );
    };
    return (
        <SecurityLayout id={id} active="overview" title="Security assessment" subtitle="Passive, read-only assessments of applications the client authorized, and what they found." actions={appList.length > 0 ? addApp : null}>
            {body()}
        </SecurityLayout>
    );
}

/** The BadgeKey lines for a FindingList: the severities, then the states, its findings show. */
export const findingKey = (findings: FindingBrief[]) => [...severityKey(findings.map((f) => f.severity)), ...validationKey(findings.map((f) => f.validation))];

export function FindingList({ id, findings, appName, testId }: { id: string; findings: FindingBrief[]; appName?: (appId: string) => string; testId?: string }) {
    return (
        <ul className="card list divided" data-testid={testId}>
            {findings.map((f) => {
                const seen = f.fixedAt ?? f.lastSeenAt;
                return (
                    <li key={f.id}>
                        <a className="list-row" href={sec.finding(id, f.id)}>
                            <span className="main">
                                <span className="title">{f.title}</span>
                                <span className="meta sec-list-cols">
                                    <span className="sec-loc">{f.location}</span>
                                    {appName?.(f.applicationId) && <span>{appName(f.applicationId)}</span>}
                                    {seen && <span>{f.fixedAt ? "Fixed" : "Last seen"} {relativeTime(seen)}</span>}
                                </span>
                            </span>
                            <span className="tail">
                                <SeverityTag severity={f.severity} />
                                {f.validation && <ValidationTag validation={f.validation} />}
                            </span>
                            <ChevronRight size={18} className="chev" aria-hidden />
                        </a>
                    </li>
                );
            })}
        </ul>
    );
}
