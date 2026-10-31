import { History } from "lucide-react";
import type { Job, ProjectDetail, TestSummary } from "../api";
import { usePage } from "../components/Shell";
import { ScheduledBadge } from "../features/schedules/ScheduledBadge";
import { DeployBadge } from "../features/triggers/DeployBadge";
import { RanOnBadge } from "../features/agents/RunsOnLine";
import { TechnicalDetails } from "../components/TechnicalDetails";
import { Badge, Callout, EmptyState, ErrorState, JobBadge, ListSkeleton, PageHeader, jobKey } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { jobHelp } from "../lib/help";
import { duration } from "../lib/format";
import { RelTime } from "../features/runs/RunTime";
import { friendlyJobErrors, isActive } from "../lib/labels";
import { useDocumentTitle, useFetch } from "../lib/hooks";
import { useProjectStream } from "../lib/stream";
import { LiveBadge } from "../features/live/LiveStatus";
import { friendlyError } from "../lib/labels";
import { routes } from "../lib/router";
import { ProjectTabs } from "./ProjectOverview";
import { RunMenu } from "../features/runs/RunMenu";
import { RunStrip } from "../features/runs/RunStrip";
import { runCountsLine, runTitle, stoppedLine } from "../features/runs/runs";

export function ProjectRuns({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const tests = useFetch<TestSummary[]>(`/projects/${id}/tests`);
    const jobs = useFetch<Job[]>(`/projects/${id}/jobs`, (d) => (d?.some((j) => isActive(j.status)) ? 3000 : null));
    // Running jobs update live; the polling above keeps working when the stream is not connected.
    const anyActive = Boolean(jobs.data?.some((j) => isActive(j.status)));
    const live = useProjectStream(id, anyActive, () => void jobs.reload());
    const name = project.data?.name;
    useDocumentTitle(name ? `Runs · ${name}` : "Runs");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Runs" }], nav: "projects" });

    return (
        <>
            <PageHeader
                title="All runs"
                subtitle={
                    <>
                        Every time the AI explored this application or tests were run.{" "}
                        <BadgeKey label="the run statuses" entries={(jobs.data ?? []).map((j) => (j.cancelled ? { word: "Stopped", text: jobHelp({ status: "FAILED", error: "Cancelled" }) } : jobKey([j])[0]))} />
                    </>
                }
                actions={<RunMenu projectId={id} tests={tests.data ?? []} variant="primary" />} />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />
            <div className="stack">
                <RunStrip projectId={id} />
            {jobs.loading ? (
                <ListSkeleton rows={3} />
            ) : jobs.error ? (
                <ErrorState error={friendlyError(jobs.error.message)} onRetry={jobs.reload} />
            ) : !jobs.data?.length ? (
                <div className="card">
                    <EmptyState icon={History} title="No runs yet" seeHow={{ topic: "run-panel", query: "run tests now" }}>Runs appear here after the AI explores your application or you run tests.</EmptyState>
                </div>
            ) : (
                <div className="stack">
                    {jobs.data.map((j) => {
                        const ms = j.startedAt && j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime() : null;
                        const problems = j.status === "FAILED" || j.status === "PARTIALLY_COMPLETED" ? friendlyJobErrors(j.error) : [];
                        const line = j.cancelled ? null : runCountsLine(j);
                        return (
                            <section className="card card-pad stack-sm" key={j.jobId} data-run={j.jobId}>
                                <div className="row">
                                    <h2 className="t-card">
                                        <a href={routes.run(id, j.jobId)}>{runTitle(j)}</a>
                                    </h2>
                                    {j.cancelled ? <Badge tone="neutral">Stopped</Badge> : <JobBadge job={j} />}
                                    {isActive(j.status) && <LiveBadge state={live.state} />}
                                    <ScheduledBadge job={j} />
                                    <DeployBadge job={j} />
                                    <RanOnBadge ranOn={j.ranOn} />
                                    <span className="spacer" />
                                    <span className="t-meta">
                                        Started <RelTime iso={j.createdAt} />
                                        {ms !== null && ` · took ${duration(ms)}`}
                                    </span>
                                </div>
                                {isActive(j.status) && live.live && live.latestByJob[j.jobId] && <p className="t-secondary">{live.latestByJob[j.jobId]}</p>}
                                {j.cancelled && (
                                    <p className="t-secondary">
                                        <strong>{stoppedLine(j.cancelled)}.</strong> {j.cancelled.note}
                                    </p>
                                )}
                                {line && <p className="t-secondary">{line}</p>}
                                {problems.filter(() => !j.cancelled).map((e) => (
                                    <Callout key={e.title + e.body} tone={j.status === "FAILED" ? "danger" : "warning"} title={e.title}>
                                        {e.body}
                                    </Callout>
                                ))}
                                <div className="row">
                                    <a className="btn btn-sm" href={routes.run(id, j.jobId)}>
                                        See each test
                                    </a>
                                </div>
                                <TechnicalDetails job={j} />
                            </section>
                        );
                    })}
                </div>
            )}
            </div>
        </>
    );
}
