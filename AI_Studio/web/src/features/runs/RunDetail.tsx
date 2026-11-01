import { ArrowLeft, History } from "lucide-react";
import type { ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { TechnicalDetails } from "../../components/TechnicalDetails";
import { Badge, Callout, EmptyState, ErrorState, ListSkeleton, PageHeader } from "../../components/ui";
import { duration, plural, relativeTime } from "../../lib/format";
import { friendlyJobErrors, friendlyError, isActive, nothingRan } from "../../lib/labels";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { browserSentence } from "../agents/agents";
import { versionHref } from "../review/review";
import { RunMenu } from "./RunMenu";
import { RunStrip } from "./RunStrip";
import { RunTestList } from "./RunStrip";
import { StopRun } from "./StopDialog";
import { RelTime } from "./RunTime";
import { announceRunsChanged, ranSentence, runTitle, startedByText, STATE_WORD, stoppedLine, useRunAnswer, whereOf, type RunState } from "./runs";
import { BadgeKey, keyEntries } from "../../components/Tooltip";
import { RUN_TEST_STATE } from "../../lib/help";

const RUN_STATES: RunState[] = ["passed", "finding", "failed", "running", "waiting", "not_run"];
import "./runs.css";

/** One run opened: what ran, where, when, how long and who started it; every test with failures first; what changed since the last run; and ways to run again. */
export function RunDetail({ id, jobId }: { id: string; jobId: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const run = useRunAnswer(id, jobId, true);
    const name = project.data?.name;
    const a = run.data;
    useDocumentTitle(a ? `${runTitle(a.job)} · ${name ?? "Runs"}` : "Run");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Runs", href: routes.runs(id) }, { label: "Run" }], nav: "projects" });

    if (run.loading) return <ListSkeleton rows={5} />;
    if (run.error || !a) {
        return (
            <div className="stack">
                <ErrorState error={friendlyError(run.error?.message ?? "Run not found")} onRetry={run.reload} />
                <a className="run-back" href={routes.runs(id)}>
                    <ArrowLeft size={16} aria-hidden /> All runs
                </a>
            </div>
        );
    }

    const job = a.job;
    const c = a.counts;
    const active = a.active;
    const ms = job.startedAt && job.finishedAt ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime() : null;
    const exploration = job.mode === "generate" || job.mode === undefined;
    const failing = a.tests.filter((t) => t.state === "failed");
    const problems = job.status === "FAILED" || job.status === "PARTIALLY_COMPLETED" ? friendlyJobErrors(job.error) : [];
    const sameEnvironment = job.mode === "environment" && job.environment ? { environment: job.environment } : {};

    return (
        <>
            <PageHeader
                title={runTitle(job)}
                subtitle={
                    <>
                        {active ? <Badge tone="info">Running</Badge> : job.cancelled ? <Badge tone="neutral">Stopped</Badge> : nothingRan(job) ? <Badge tone="neutral">Nothing ran</Badge> : job.status === "FAILED" ? <Badge tone="danger">Did not finish</Badge> : c.failed + c.findings > 0 ? <Badge tone="warning">Finished, with problems</Badge> : <Badge tone="success">Finished</Badge>}
                        <span>{relativeTime(job.startedAt ?? job.createdAt)}</span>
                    </>
                }
                actions={active ? <StopRun job={{ jobId, projectId: id, mode: job.mode }} size="md" onRequested={announceRunsChanged} /> : undefined}
            />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />

            <div className="stack">
                <RunStrip projectId={id} exceptJobId={jobId} />
                <a className="run-back" href={routes.runs(id)}>
                    <ArrowLeft size={16} aria-hidden /> All runs
                </a>

                <section className="card card-pad stack-sm" aria-label="About this run">
                    <dl className="run-facts">
                        <dt>What ran</dt>
                        <dd>{exploration ? `The AI explored the app and created ${plural(c.planned, "test")}` : job.mode === "agent" ? "An agent run" : job.mode === "plain" ? "A test built from a description" : job.mode === "variants" ? `${plural(c.planned, "test")} on other browsers and screen sizes` : `${plural(c.planned, "test")}${job.environment ? ` against ${job.environment}` : ""}`}</dd>
                        <dt>Where</dt>
                        <dd>{whereOf(job) === "this server" ? "On this server" : `On ${whereOf(job)}`}</dd>
                        {job.ranOn?.kind === "agent" && job.ranOn.browser && (
                            <>
                                <dt>Browser</dt>
                                <dd data-testid="run-browser">Ran in {browserSentence(job.ranOn.browser, job.ranOn.name)}.</dd>
                            </>
                        )}
                        <dt>When</dt>
                        <dd>
                            <RelTime iso={job.startedAt ?? job.createdAt} />
                        </dd>
                        <dt>How long</dt>
                        <dd>{ms !== null ? duration(ms) : active ? "Still going" : "Not known"}</dd>
                        <dt>Started by</dt>
                        <dd>{startedByText(a.startedBy)}</dd>
                    </dl>
                    <p className="run-summary" data-testid="run-summary">
                        {active ? `${c.ran} of ${plural(c.planned, "test")} have a result so far.` : job.cancelled ? `${stoppedLine({ ran: job.cancelled.ran, planned: job.cancelled.planned })}. ${job.cancelled.note}` : ranSentence(c)}
                    </p>
                    {job.counters.variantChecks ? (
                        <p className="t-secondary">
                            Also checked on other browsers and screen sizes: {plural(job.counters.variantChecks, "check")}, {job.counters.variantFailures ?? 0} failed.
                        </p>
                    ) : null}
                    {!active && !exploration && (
                        <div className="row">
                            <RunMenu projectId={id} scope="fixed" label={`Run failing tests again${failing.length ? ` (${failing.length})` : ""}`} fixed={{ ids: failing.map((t) => t.id), description: `The ${plural(failing.length, "failing test")} of this run.`, ...sameEnvironment }} variant="primary" />
                            <RunMenu projectId={id} scope="fixed" label="Run these tests again" fixed={{ ids: a.tests.map((t) => t.id), description: `The ${plural(a.tests.length, "test")} of this run.`, ...sameEnvironment }} />
                        </div>
                    )}
                    {!active && exploration && c.planned > 0 && (
                        <div className="row">
                            <RunMenu projectId={id} scope="fixed" label="Run these tests" fixed={{ ids: a.tests.map((t) => t.id), description: `The ${plural(a.tests.length, "test")} this exploration created.` }} />
                        </div>
                    )}
                </section>

                {!job.cancelled && problems.map((e) => (
                    <Callout key={e.title + e.body} tone={nothingRan(job) ? "info" : job.status === "FAILED" ? "danger" : "warning"} title={e.title}>
                        {e.body}
                    </Callout>
                ))}

                {a.heldBack.length > 0 && (
                    <section className="card card-pad stack-sm" aria-labelledby="run-held" data-testid="run-held-back">
                        <h2 className="t-section" id="run-held">
                            Waiting for approval ({a.heldBack.length})
                        </h2>
                        <p className="t-secondary">{a.heldBack.length === 1 ? "This test was left out of the run" : "These tests were left out of the run"}: only approved versions run. A Project Admin reviews a draft and approves it.</p>
                        <ul className="run-changes">
                            {a.heldBack.map((t) => (
                                <li key={t.id}>
                                    <a href={t.version !== null ? versionHref(id, t.id, t.version) : routes.scripts(id)}>Review {t.testId}</a>
                                    <span className="t-meta"> {t.title}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {a.changes && (a.changes.newlyFailing.length > 0 || a.changes.newlyPassing.length > 0) && (
                    <section className="card card-pad stack-sm" aria-labelledby="run-changed">
                        <h2 className="t-section" id="run-changed">
                            Changed since the last run
                        </h2>
                        <p className="t-meta">Compared with each test’s earlier result, from {relativeTime(a.changes.comparedWith.at)}.</p>
                        {a.changes.newlyFailing.length > 0 && (
                            <div>
                                <h3 className="t-card">Newly failing ({a.changes.newlyFailing.length})</h3>
                                <ul className="run-changes">
                                    {a.changes.newlyFailing.map((t) => (
                                        <li key={t.id}>
                                            <a href={routes.test(t.id)}>{t.title}</a>
                                            {t.reason && <span className="t-meta"> {t.reason}</span>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        {a.changes.newlyPassing.length > 0 && (
                            <div>
                                <h3 className="t-card">Newly passing ({a.changes.newlyPassing.length})</h3>
                                <ul className="run-changes">
                                    {a.changes.newlyPassing.map((t) => (
                                        <li key={t.id}>
                                            <a href={routes.test(t.id)}>{t.title}</a>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </section>
                )}
                {a.changes && a.changes.newlyFailing.length === 0 && a.changes.newlyPassing.length === 0 && !active && <p className="t-secondary">No test changed its result since the last run.</p>}

                <section className="card" aria-labelledby="run-tests-h" data-tour="run-tests">
                    <div className="run-tests-head row">
                        <h2 className="t-section" id="run-tests-h">
                            {exploration ? "Tests created" : "Tests in this run"}
                        </h2>
                        <BadgeKey label="the results in this list" entries={keyEntries(RUN_STATES, a.tests.map((t) => t.state as RunState), (s) => STATE_WORD[s], (s) => RUN_TEST_STATE[s])} />
                    </div>
                    {a.tests.length === 0 ? (
                        <EmptyState icon={History} title={active ? "Nothing to show yet" : "No tests in this run"}>
                            {active ? "The tests appear here as they are created or run." : exploration ? "This exploration did not create any tests." : "This run did not include any test."}
                        </EmptyState>
                    ) : (
                        <div className="run-tests-wrap">
                            <RunTestList tests={a.tests} />
                        </div>
                    )}
                </section>

                <div className="card" style={{ padding: "0 20px" }}>
                    <TechnicalDetails job={job} />
                </div>
            </div>
            {isActive(job.status) && <p className="sr-only" role="status">This run is still going.</p>}
        </>
    );
}
