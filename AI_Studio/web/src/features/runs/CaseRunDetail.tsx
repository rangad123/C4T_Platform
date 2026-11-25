import { ArrowLeft, Check, LoaderCircle, Minus, Network, OctagonPause, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, downloadFrom, type EventRow, type Job, type ProjectDetail } from "../../api";
import { usePage } from "../../components/Shell";
import { Callout, EmptyState, ErrorState, JobBadge, ListSkeleton, PageHeader } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { friendlyError, friendlyJobErrors, isActive } from "../../lib/labels";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import type { JobStream } from "../../lib/stream";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { LiveLine } from "../live/LiveStatus";
import { CaseOutcome } from "../outcome/CaseOutcome";
import { StopRun } from "./StopDialog";
import { announceRunsChanged, CASE_STAGES, caseRunLine, caseRunTitle, caseStageText, useRunAnswer } from "./runs";
import { runWorkbookPath, useCaseOutcome } from "./case-runs";
import { useCan } from "../auth/permissions";
import "./runs.css";

/** The event a run of such a project ends with once it has said what it wrote (src/platform/case-outcome.ts noteCaseRunFinished). */
const FINAL_KIND = "case_outcome_written";

/**
 * One run of a Test Case Generation project (founder 2026-11-19 P3, P5.3, R10.3, Q4; PLAN.md U5): its status line, what it added to the
 * project's one tree ("Added 4 pages and 9 test cases"), and that run's part of the tree with the test cases it wrote. While it runs:
 * its three stages (Exploring, Understanding, Writing test cases) and the live line; when it ends, its last word ("Test cases written:
 * 9 (4 new)", written just after the final status, FX9). A stopped run shows what it kept. Nothing about running tests, scripts, a plan,
 * the runner, technical details or a second list of pages: the tree is the one list.
 */
export function CaseRunDetail({ id, jobId, number }: { id: string; jobId: string; number?: number }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const run = useRunAnswer(id, jobId, true);
    const a = run.data;
    const active = Boolean(a?.active);
    const outcome = useCaseOutcome(id, jobId, (o) => active || o?.runs[0]?.status === "running");
    const last = useFinalWord(jobId, a ? active : undefined, run.stream);
    const can = useCan();
    const [downloadError, setDownloadError] = useState<string | null>(null);
    // The status turned final: read what the run found once more, so the last pages and test cases show without a reload.
    const wasActive = useRef(false);
    useEffect(() => {
        if (wasActive.current && !active) void outcome.reload();
        wasActive.current = active;
    }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

    const name = project.data?.name;
    const title = caseRunTitle(number);
    useDocumentTitle(`${title} · ${name ?? "Runs"}`);
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Runs", href: routes.projectAgent(id, "test-generation", "runs") }, { label: title }], nav: "projects" });

    if (run.loading) return <ListSkeleton rows={5} />;
    if (run.error || !a) {
        return (
            <div className="stack">
                <ErrorState error={friendlyError(run.error?.message ?? "Run not found")} onRetry={run.reload} />
                <a className="run-back" href={routes.projectAgent(id, "test-generation", "runs")}>
                    <ArrowLeft size={16} aria-hidden /> All runs
                </a>
            </div>
        );
    }

    const job = a.job;
    const o = outcome.data;
    const facts = o?.runs[0];
    const problems = !active && !job.cancelled && job.status !== "COMPLETED" ? friendlyJobErrors(job.error) : [];
    const nothing = o ? o.tree.length === 0 && o.cases.length === 0 : false;

    return (
        <>
            <PageHeader
                title={title}
                subtitle={
                    <>
                        <JobBadge job={{ ...job, caseAgent: true }} tipFocusable />
                        <span>{relativeTime(job.startedAt ?? job.createdAt)}</span>
                    </>
                }
                actions={active ? <StopRun job={{ jobId, projectId: id, mode: job.mode, planOnly: job.planOnly, caseAgent: true }} size="md" onRequested={announceRunsChanged} /> : undefined}
            />
            <ProjectTabs id={id} active="runs" count={project.data?.test_count} />

            <div className="stack" data-testid="case-run">
                <a className="run-back" href={routes.projectAgent(id, "test-generation", "runs")}>
                    <ArrowLeft size={16} aria-hidden /> All runs
                </a>

                <section className="card card-pad stack-sm" aria-label="About this run">
                    {facts && (
                        <p className="run-summary" data-testid="case-run-summary">
                            {caseRunLine(facts)}
                        </p>
                    )}
                    {!active && last && (
                        <p className="t-secondary" data-testid="case-run-last-word">
                            {last}
                        </p>
                    )}
                </section>

                {active && (
                    <section className="card card-pad stack-sm" aria-labelledby="case-run-stages-h">
                        <h2 className="t-section" id="case-run-stages-h">
                            Progress
                        </h2>
                        <CaseStages job={job} />
                        <LiveLine state={run.stream.state} latest={run.stream.latest} />
                    </section>
                )}

                {problems.map((e) => (
                    <Callout key={e.title + e.body} tone={job.status === "FAILED" ? "danger" : "warning"} title={e.title}>
                        {e.body}
                    </Callout>
                ))}

                {downloadError && (
                    <Callout tone="danger" title="The test cases could not be downloaded">
                        {downloadError}
                    </Callout>
                )}
                {outcome.error ? (
                    <Callout tone="info" title="Nothing from this run to show">
                        {outcome.error.message}
                    </Callout>
                ) : !o ? (
                    <ListSkeleton rows={3} />
                ) : nothing ? (
                    <div className="card">
                        {active ? (
                            <EmptyState icon={LoaderCircle} title="Exploring the application">
                                Pages and test cases appear here as this run finds them.
                            </EmptyState>
                        ) : (
                            <EmptyState icon={job.cancelled ? OctagonPause : Network} title={job.cancelled ? "This run was stopped before it found a page" : "This run found no page"}>
                                The next run starts again from what the project already knows.
                            </EmptyState>
                        )}
                    </div>
                ) : (
                    // The run's status is shown above; the report is told it finished so it adds no note about "the last run".
                    <CaseOutcome
                        outcome={{ ...o, runs: o.runs.map((r) => ({ ...r, status: "completed" as const })) }}
                        title="What this run found"
                        // This run's test cases, as the latest run's are downloaded on the agent's Outcome (sheet #29); once it has ended.
                        downloadHref={!active && o.cases.length > 0 && can("ai_studio.reports.export") ? `/api${runWorkbookPath(id, jobId)}` : null}
                        onDownload={() => {
                            setDownloadError(null);
                            downloadFrom(runWorkbookPath(id, jobId), `${name ?? "Project"} test cases.xlsx`).catch((e: Error) => setDownloadError(e.message));
                        }}
                    />
                )}
            </div>
            {isActive(job.status) && <p className="sr-only" role="status">This run is still going.</p>}
        </>
    );
}

/** The three stages of such a run, as a checklist (also on the Dashboard while it runs, components/JobProgress.tsx). */
export function CaseStages({ job }: { job: Pick<Job, "progress" | "counters"> }) {
    return (
        <ol className="steps" data-testid="case-run-stages">
            {CASE_STAGES.map((p) => {
                const state = job.progress[p];
                const t = caseStageText(p, state, job.counters);
                return (
                    <li key={p} className={`step ${state}`}>
                        <span className="mark" aria-hidden>
                            {state === "done" ? <Check size={14} /> : state === "running" ? <LoaderCircle size={14} className="spin" /> : state === "failed" ? <X size={14} /> : state === "skipped" ? <Minus size={14} /> : null}
                        </span>
                        <span className="what">
                            <span className="name">{t.title}</span>
                            {t.detail && (
                                <span className="t-meta" style={{ display: "block" }}>
                                    {t.detail}
                                </span>
                            )}
                            <span className="sr-only">{state}</span>
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

/**
 * The run's last word once it has ended ("Test cases written: 9 (4 new)"; nothing for a run that ended without one). A run of such a project says what it wrote just after its status became final, so a page that
 * watched it end looks again (once a second, ten times at most) until that word is there; a page opened later reads it once.
 */
function useFinalWord(jobId: string, active: boolean | undefined, stream: JobStream): string | undefined {
    const [word, setWord] = useState<string>();
    const watched = useRef(false);
    const seen = useRef<EventRow | undefined>(undefined);
    seen.current = stream.events.at(-1) ?? seen.current;
    useEffect(() => {
        if (active === undefined) return;
        if (active) {
            watched.current = true;
            return;
        }
        let gone = false;
        let timer: number | undefined;
        let tries = 0;
        let lastEvent: EventRow | undefined = seen.current;
        let after = lastEvent?.id ?? 0;
        const look = async () => {
            try {
                for (let page = 0; page < 40; page++) {
                    const rows = await api<EventRow[]>(`/test-generation/${jobId}/events?after=${after}`);
                    if (rows.length) {
                        lastEvent = rows[rows.length - 1];
                        after = lastEvent.id;
                    }
                    if (rows.length < 500) break;
                }
            } catch {
                /* the line is left out; the page has everything else */
            }
            if (gone) return;
            if (lastEvent?.kind === FINAL_KIND) setWord(lastEvent.message);
            if (watched.current && lastEvent?.kind !== FINAL_KIND && ++tries < 10) timer = window.setTimeout(() => void look(), 1000);
        };
        void look();
        return () => {
            gone = true;
            clearTimeout(timer);
        };
    }, [jobId, active]);
    return word;
}
