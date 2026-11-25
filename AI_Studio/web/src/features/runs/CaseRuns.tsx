import { ChevronRight, Download, History } from "lucide-react";
import { useState } from "react";
import { downloadFrom, type Job, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, JobBadge, ListSkeleton, PageHeader } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { duration } from "../../lib/format";
import { jobHelp } from "../../lib/help";
import { caseJobLabel, friendlyError, friendlyJobErrors, isActive } from "../../lib/labels";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { useProjectStream } from "../../lib/stream";
import { LiveBadge } from "../live/LiveStatus";
import { ScheduledBadge } from "../schedules/ScheduledBadge";
import { RelTime } from "./RunTime";
import { caseRunLine, caseRunTitle } from "./run-text";
import { runNumbers, runWorkbookPath, useCaseOutcome } from "./case-runs";
import { useCan } from "../auth/permissions";
import "./runs.css";

/**
 * The runs of a Test Case Generation project (founder 2026-11-19 R10, P2, P7.2; PLAN.md U5). Each run explores the application, adds to
 * the project's one tree and writes test cases, so a row says what it added; a stopped run says that what it found is kept (Q4). There is
 * no Run button, no run strip of tests and no "See each test": nothing is run in such a project. Older runs that are not part of the tree
 * (runs of tests made before the project only wrote test cases, or forgotten with "Forget what we learned") are counted in one line.
 */
export function CaseRuns({ id, jobsPath }: { id: string; /** Whose runs to count: the agent's own in the Agent Workspace (W3 review M2); default every run of the project. */ jobsPath?: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const jobs = useFetch<Job[]>(jobsPath ?? `/projects/${id}/jobs`, (d) => (d?.some((j) => isActive(j.status)) ? 3000 : null));
    const anyActive = Boolean(jobs.data?.some((j) => isActive(j.status)));
    const outcome = useCaseOutcome(id, null, (o) => anyActive || Boolean(o?.runs.some((r) => r.status === "running")));
    const live = useProjectStream(id, anyActive, () => {
        void jobs.reload();
        void outcome.reload();
    });
    const name = project.data?.name;
    const can = useCan();
    const [downloadError, setDownloadError] = useState<string | null>(null);
    useDocumentTitle(name ? `Runs · ${name}` : "Runs");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Runs" }], nav: "projects" });

    const byId = new Map((jobs.data ?? []).map((j) => [j.jobId, j]));
    const runs = outcome.data?.runs ?? [];
    const numbers = runNumbers(outcome.data);
    const shown = new Set(runs.map((r) => r.jobId));
    const others = (jobs.data ?? []).filter((j) => !shown.has(j.jobId)).length;

    return (
        <>
            <PageHeader
                title="All runs"
                subtitle={
                    <>
                        Each run explores the application, adds to its tree and writes test cases. Nothing is run.{" "}
                        {shown.size > 0 && <BadgeKey label="the run statuses" entries={(jobs.data ?? []).filter((j) => shown.has(j.jobId)).map((j) => ({ word: caseJobLabel(j).label, text: jobHelp({ ...j, caseAgent: true }) }))} />}
                    </>
                }
            />
            <div className="stack" data-testid="case-runs">
                {downloadError && (
                    <Callout tone="danger" title="The test cases could not be downloaded">
                        {downloadError}
                    </Callout>
                )}
                {jobs.loading || outcome.loading ? (
                    <ListSkeleton rows={3} />
                ) : jobs.error || outcome.error ? (
                    <ErrorState error={friendlyError((jobs.error ?? outcome.error)!.message)} onRetry={() => void (jobs.reload(), outcome.reload())} />
                ) : runs.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={History} title="No runs yet" actions={<a className="btn btn-primary" href={routes.newProject({ project: id, agent: "test-generation" })}>Start exploring</a>}>
                            Each run explores the application, adds pages to the tree and writes test cases for them.
                        </EmptyState>
                    </div>
                ) : (
                    runs.map((r) => {
                        const j = byId.get(r.jobId);
                        const ms = j?.startedAt && j.finishedAt ? new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime() : null;
                        const problems = j && j.status !== "COMPLETED" && !j.cancelled && !isActive(j.status) ? friendlyJobErrors(j.error) : [];
                        const title = caseRunTitle(numbers.get(r.jobId));
                        return (
                            <section className="card card-pad stack-sm" key={r.jobId} data-run={r.jobId}>
                                <div className="row">
                                    <h2 className="t-card">
                                        <a href={routes.projectAgentRun(id, "test-generation", r.jobId)}>{title}</a>
                                    </h2>
                                    {j ? <JobBadge job={{ ...j, caseAgent: true }} /> : <Badge tone="info">Exploring</Badge>}
                                    {j && isActive(j.status) && <LiveBadge state={live.state} />}
                                    {j && <ScheduledBadge job={j} />}
                                    <span className="spacer" />
                                    <span className="t-meta">
                                        Started <RelTime iso={j?.createdAt ?? r.startedAt} />
                                        {ms !== null && ` · took ${duration(ms)}`}
                                    </span>
                                </div>
                                <p className="t-secondary" data-testid="case-run-line">
                                    {caseRunLine(r)}
                                </p>
                                {j && isActive(j.status) && live.live && live.latestByJob[r.jobId] && <p className="t-meta">{live.latestByJob[r.jobId]}</p>}
                                {problems.map((e) => (
                                    <Callout key={e.title + e.body} tone={j?.status === "FAILED" ? "danger" : "warning"} title={e.title}>
                                        {e.body}
                                    </Callout>
                                ))}
                                <div className="row">
                                    <a className="btn btn-sm" href={routes.projectAgentRun(id, "test-generation", r.jobId)}>
                                        See what it found
                                        <ChevronRight size={16} aria-hidden />
                                    </a>
                                    {/* Every ended run's own test cases, as the latest run's are downloaded on Outcome (sheet #29). */}
                                    {r.status !== "running" && can("ai_studio.reports.export") && (
                                        <Button
                                            size="sm"
                                            icon={Download}
                                            data-testid="case-run-download"
                                            tip="Downloads the test cases this run wrote as the test case workbook (.xlsx)."
                                            onClick={() => {
                                                setDownloadError(null);
                                                downloadFrom(runWorkbookPath(id, r.jobId), `${name ?? "Project"} test cases.xlsx`).catch((e: Error) => setDownloadError(e.message));
                                            }}
                                        >
                                            Download test cases
                                        </Button>
                                    )}
                                </div>
                            </section>
                        );
                    })
                )}
                {!jobs.loading && others > 0 && (
                    <p className="t-meta" data-testid="case-runs-others">
                        {others === 1 ? "1 earlier run is" : `${others} earlier runs are`} not part of the tree, so {others === 1 ? "it is" : "they are"} not listed.
                    </p>
                )}
            </div>
        </>
    );
}
