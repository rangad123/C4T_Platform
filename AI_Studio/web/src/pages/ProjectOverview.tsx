import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronRight, Code2, ExternalLink, ListChecks, Play, RefreshCw, Sparkles, Upload } from "lucide-react";
import { downloadFrom, projectKind, projectShape, type ProjectDetail, type Severity, type TestSummary, type TestingMode } from "../api";
import { JobProgress } from "../components/JobProgress";
import { ArchivedNote } from "../components/ProjectHub";
import { ProjectHead } from "../components/ProjectKind";
import { ExplorerWatch } from "../features/explorer/ExplorerView";
import { NextSteps } from "../features/onboarding/NextSteps";
import { PlanPreview } from "../features/onboarding/PlanPreview";
import { ContinueExploring, continueNote } from "../features/explore/ContinueExploring";
import { exploreAgainHref, phoneJobOf } from "../features/phone/phone";
import { HelpPlace } from "../features/guide/HelpContext";
import { ApiChangesCard } from "../features/contracts/ApiChangesCard";
import { SiteMemoryCard } from "../features/memory/SiteMemoryCard";
import { ScreenMapCard } from "../features/explore/ScreenMapCard";
import { ExplorerKnowledge } from "../features/explore/ExplorerKnowledge";
import { CleanupCard } from "../features/cleanup/CleanupCard";
import { SlowestPages } from "../features/performance/SlowestPages";
import { VariantsResult } from "../features/variants/VariantsResult";
import { EnvironmentResult } from "../features/environments/EnvironmentResult";
import { PlainResult } from "../features/authoring/PlainResult";
import { SecurityProjectTab } from "../features/security/TestingType";
import { SecuritySummaryCard } from "../features/security/SecurityPage";
import { SetupChecklist } from "../features/workspace/SetupChecklist";
import { RequirementsCoverageCard } from "../features/requirements/CoverageCard";
import { UnderstandingCard } from "../features/understanding/UnderstandingCard";
import { understandsApp } from "../features/understanding/understanding";
import { usePage } from "../components/Shell";
import { TechnicalDetails } from "../components/TechnicalDetails";
import { Badge, Callout, EmptyState, ErrorState, JobBadge, LinkButton, ListSkeleton, Metric, Ribbon, RibbonLegend, SeverityBadge, Skeleton, StatusBadge, severityKey, statusKey, type Tick } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { useEmbedded } from "../lib/embedded";
import type { ScheduleList } from "../features/schedules/schedules";
import { hostOf, plural, relativeTime } from "../lib/format";
import { cleanReason, friendlyError, friendlyJobErrors, isActive, nothingRan } from "../lib/labels";
import { useDocumentTitle, useFetch, useOnFinish, useProjectChanged } from "../lib/hooks";
import { useCaseAgent } from "../features/runs/case-runs";
import { help } from "../lib/help";
import { routes } from "../lib/router";
import { countedSentence } from "../features/quarantine/quarantine";
import { stoppedLine } from "../features/runs/runs";
import "../features/quarantine/quarantine.css";
import { CaseOutcome } from "../features/outcome/CaseOutcome";
import type { CaseOutcome as Outcome } from "../features/outcome/outcome";
import { useCan } from "../features/auth/permissions";

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const attentionRank = (t: TestSummary) => (t.severity ? SEV_RANK[t.severity.severity] : t.validationStatus === "NEEDS_REVIEW" ? 4 : 5);

/**
 * The project's places. Which of them a project has as tabs depends on its kind (`projectKind`):
 * an AI agent project has Dashboard, Runs, Requirements, Settings; a code project (and a mixed one, made with both modes) has
 * Dashboard, Requirements, Test cases, Test scripts, Test suites, Runs, Settings. Agent runs has no tab; its pages still open from
 * a link, and so does any place whose tab a project's kind does not show (no tab is the open one then).
 */
export type PlaceKey = "overview" | "requirements" | "tests" | "suites" | "scripts" | "agent" | "runs" | "security" | "settings";

export function ProjectTabs({
    id,
    active,
    count,
    modes,
    caseCount,
}: {
    id: string;
    active: PlaceKey;
    /** The project's runnable tests, shown on Test scripts. */
    count?: number;
    /** The project's testing modes, when the page already has them (else they are asked for). */
    modes?: TestingMode[];
    /** The project's written test cases, shown on Test cases when the server says how many. */
    caseCount?: number;
}) {
    const nav = useRef<HTMLElement>(null);
    // A section shown inside a hub is under the hub's own tab bar.
    const embedded = useEmbedded();
    const fetched = useFetch<ProjectDetail>(modes || embedded ? null : `/projects/${id}`);
    useProjectChanged(id, fetched.reload);
    // Until the project is known no tab is drawn (a wrong row would flicker); if it cannot be read, every tab shows.
    const known = modes ?? (fetched.data ? projectShape(fetched.data).testingModes : fetched.error ? (["agent", "code"] as TestingMode[]) : undefined);
    const kind = known ? projectKind({ testingModes: known }) : null;
    const scripts = count ?? fetched.data?.test_count;
    const cases = caseCount ?? fetched.data?.case_count;
    // On a narrow screen the tab row scrolls sideways: bring the current tab into view so it is never clipped.
    useEffect(() => {
        nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }, [active, count, kind]);
    if (embedded) return null;
    const tab = (href: string, label: string, key: string, n?: number, tour?: string) => (
        <a className="tab" href={href} aria-current={active === key ? "page" : undefined} data-tour={tour}>
            {label}
            {n !== undefined && <span className="count">{n}</span>}
        </a>
    );
    return (
        <nav className="tabs" aria-label="Project sections" ref={nav} data-tour="project-tabs" data-kind={kind ?? undefined} aria-busy={kind ? undefined : true}>
            {kind === "agent" && (
                <>
                    {tab(routes.project(id), "Dashboard", "overview", undefined, "tab-overview")}
                    {tab(routes.runs(id), "Runs", "runs", undefined, "tab-runs")}
                    {tab(routes.requirements(id), "Requirements", "requirements", undefined, "tab-requirements")}
                </>
            )}
            {(kind === "code" || kind === "mixed") && (
                <>
                    {tab(routes.project(id), "Dashboard", "overview", undefined, "tab-overview")}
                    {tab(routes.requirements(id), "Requirements", "requirements", undefined, "tab-requirements")}
                    {tab(routes.cases(id), "Test cases", "tests", cases, "tab-tests")}
                    {tab(routes.scripts(id), "Test scripts", "scripts", scripts, "tab-scripts")}
                    {tab(routes.suites(id), "Test suites", "suites", undefined, "tab-suites")}
                    {tab(routes.runs(id), "Runs", "runs", undefined, "tab-runs")}
                </>
            )}
            {kind && (
                <>
                    <SecurityProjectTab id={id} current={active === "security"} />
                    {tab(routes.projectSettings(id), "Settings", "settings", undefined, "tab-settings")}
                </>
            )}
        </nav>
    );
}

export function ProjectOverview({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`, (d) => (isActive(d?.latestJob?.status) ? 2000 : null));
    const tests = useFetch<TestSummary[]>(`/projects/${id}/tests`, () => (isActive(project.data?.latestJob?.status) ? 4000 : null));
    const schedules = useFetch<ScheduleList>(`/projects/${id}/schedules`);
    // A restored project asks for the sign-in details a backup never holds: that needs a person, so it is said here, not only in Settings.
    const storage = useFetch<{ needsSecrets: Array<{ label: string }> }>(`/projects/${id}/storage`);
    const p = project.data;
    // A Test Case Generation project (SPEC D3; the server's `caseAgent`, FX14) has its outcome as the Dashboard; only it asks for the outcome.
    const caseAgent = useCaseAgent(id);
    const outcome = useFetch<Outcome>(caseAgent ? `/projects/${id}/outcome` : null, () => (isActive(project.data?.latestJob?.status) ? 3000 : null));
    useOnFinish(isActive(p?.latestJob?.status), () => void (tests.reload(), caseAgent && outcome.reload()));
    useDocumentTitle(p?.name ?? "Project");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: p?.name ?? "…" }], nav: "projects" });

    if (project.loading) return <Loading />;
    if (project.error || !p) return <ErrorState error={friendlyError(project.error?.message ?? "Project not found")} onRetry={project.reload} />;
    // Not `outcome.loading` alone: on the render the project arrives the outcome has not been asked for yet.
    if (caseAgent === undefined || (caseAgent && !outcome.data && !outcome.error)) return <Loading />;
    // An outcome that cannot be read (an older server) leaves the agent Dashboard as it was.
    if (caseAgent && outcome.data) return <CaseAgentDashboard id={id} p={p} outcome={outcome.data} needsSecrets={storage.data?.needsSecrets ?? []} onChanged={project.reload} />;

    // The job answer may not say what it explored; a project whose application is a phone app has phone jobs.
    const job = p.latestJob ? phoneJobOf(p.latestJob, p.application?.url) : p.latestJob;
    const list = tests.data ?? [];
    const weakCount = list.filter((t) => t.quality?.level === "weak").length;
    const heldCount = list.filter((t) => t.quarantine).length;
    const attention = list.filter((t) => t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION").sort((a, b) => attentionRank(a) - attentionRank(b));
    const validated = list.filter((t) => t.validationStatus === "VALIDATED").length;
    // Written and never run: the journeys' test cases a plan creates wait for the person's Run.
    const notRun = list.filter((t) => t.validationStatus === "PENDING").length;
    const active = isActive(job?.status);
    // An exploration that stops at a plan has made no tests: what it shows is the plan, not a result.
    const planStage = job?.planOnly === true;
    const settled = Boolean(job) && !active && !planStage;
    const hasSignIn = (p.application as { hasCredentials?: boolean } | null)?.hasCredentials === true;
    const url = p.application?.url;
    // The soonest enabled schedule; nothing is shown when there is none (an empty line would only say "nothing yet").
    const nextRun = (schedules.data?.schedules ?? []).filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
    // A code project is tested by its scripts: it is never explored, so nothing here offers exploring.
    const code = projectKind(p) === "code";
    const hasTests = list.length > 0 || p.test_count > 0;

    return (
        <>
            <ProjectHead
                project={p}
                subtitle={
                    <>
                        {url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                                {hostOf(url)} <ExternalLink size={13} aria-hidden />
                            </a>
                        ) : (
                            !p.mobile && <span>No application yet</span>
                        )}
                        {job && <JobBadge job={job} tipFocusable />}
                    </>
                }
                actions={
                    <>
                        {!code && (
                            <LinkButton href={exploreAgainHref(job, id)} icon={RefreshCw}>
                                Explore again
                            </LinkButton>
                        )}
                        {list.length > 0 && (
                            <LinkButton href={routes.tests(id)} variant="primary" icon={ListChecks}>
                                View tests
                            </LinkButton>
                        )}
                    </>
                }
            />
            <ProjectTabs id={id} active="overview" count={tests.data?.length} caseCount={p.case_count} modes={projectShape(p).testingModes} />
            {p.archived_at && <ArchivedNote id={id} />}

            <div className="stack">
                {/* What the project's platforms and modes still need (US-010); hidden when all is set. */}
                <SetupChecklist id={id} />
                {!job && !code && (
                    <div className="card">
                        <EmptyState icon={Sparkles} title="Not explored yet" actions={<LinkButton href={routes.newProject({ project: id })} variant="primary" icon={Sparkles}>Start exploring</LinkButton>}>
                            Start with the application’s URL. We’ll explore it and show you a plan. The test cases it writes run only when you run them.
                        </EmptyState>
                    </div>
                )}
                {code && !hasTests && !tests.loading && (
                    <div className="card" data-testid="code-empty">
                        <EmptyState icon={Code2} title="Set up your code-based tests" actions={<LinkButton href={routes.scripts(id)} variant="primary" icon={Upload}>Add test scripts</LinkButton>}>
                            Add your test scripts, configure the runner and start a test run.
                        </EmptyState>
                    </div>
                )}
                {code && hasTests && !job && (
                    <div className="card" data-testid="code-not-run">
                        <EmptyState icon={Play} title="Not run yet" actions={<LinkButton href={routes.scripts(id)} variant="primary" icon={Play}>Open test scripts</LinkButton>}>
                            {plural(list.length || p.test_count, "test script")} {(list.length || p.test_count) === 1 ? "is" : "are"} ready. Run them from Test scripts; the results show here.
                        </EmptyState>
                    </div>
                )}

                <SecuritySummaryCard id={id} />

                {/* Coverage by requirement (RP-02): passing, failing, covered, not covered. Not on an agent project's Dashboard (founder
                    2026-11-19 P6): its requirements are an input there, and the Requirements tab keeps them. */}
                {projectKind(p) !== "agent" && <RequirementsCoverageCard projectId={id} />}

                {/* What was learnt about the application, for a website the AI agent explores. */}
                {understandsApp(p) && <UnderstandingCard projectId={id} />}

                {(storage.data?.needsSecrets.length ?? 0) > 0 && (
                    <Callout tone="warning" title="Some details need entering again" actions={<LinkButton size="sm" href={routes.setup(id, "storage")}>Open Storage and backup</LinkButton>}>
                        {storage.data!.needsSecrets.map((n) => n.label).join("; ")}. They are never part of a backup.
                    </Callout>
                )}

                {job && active && <JobProgress job={job} onChanged={project.reload} />}

                {/* The last picture of the Explorer view stays on screen after the exploration (only when this tab was watching). */}
                {job && !active && <ExplorerWatch job={job} />}

                {job && !active && planStage && (job.status === "FAILED" ? <Result job={job} total={list.length} validated={validated} attention={attention.length} notRun={notRun} projectId={id} code={code} onChanged={project.reload} /> : <><HelpPlace place="plan-preview" /><PlanPreview key={job.jobId} projectId={id} job={job} onChanged={project.reload} /></>)}

                {job && settled && <Result job={job} total={list.length} validated={validated} attention={attention.length} notRun={notRun} projectId={id} code={code} onChanged={project.reload} />}

                {job && settled && (list.length > 0 || job.status !== "FAILED") && (
                    <div className="card divided" style={{ overflow: "hidden" }}>
                        {list.length > 0 && <RunRibbon list={list} />}
                        <div className="metrics">
                            <Metric value={list.length || p.test_count} label="Tests" tip={help("metric", "tests")} />
                            <Metric value={validated || p.validated_count} label="Passing" tone="ok" tip={help("metric", "passing")} />
                            <Metric value={attention.length} label="Not passing" tone={attention.length ? "warn" : undefined} tip={attention.length ? `${help("metric", "notPassing")} They are listed below, most serious first.` : help("metric", "notPassing")} />
                            {/* The project's latest job, which can be a run as well as an exploration: the tip says so. */}
                            {code ? (
                                <Metric value={relativeTime(job.finishedAt ?? job.createdAt)} label="Last run" tip="When the project's latest run of its tests ended." />
                            ) : (
                                <Metric value={relativeTime(job.finishedAt ?? job.createdAt)} label="Last explored" tip="When the project's latest job ended. That job can be a run of the tests as well as an exploration." />
                            )}
                        </div>
                        {heldCount > 0 && (
                            <p className="section t-secondary" data-testid="quarantine-line">
                                {countedSentence(heldCount)} <a className="q-link" href={`${routes.tests(id)}?quarantine=1`}>See them</a>
                            </p>
                        )}
                        {nextRun && (
                            <p className="section t-secondary" data-testid="next-run">
                                Next scheduled run: {nextRun.name}, {new Date(nextRun.nextRunAt!).toLocaleString()}. <a href={routes.schedule(id)}>Schedules</a>
                            </p>
                        )}
                        {weakCount > 0 && (
                            <p className="section t-secondary" data-testid="weak-tests">
                                {plural(weakCount, "test")} check{weakCount === 1 ? "s" : ""} very little and could pass even if the feature broke. <a href={`${routes.tests(id)}?quality=weak`}>See them</a>
                            </p>
                        )}
                    </div>
                )}

                {job && settled && list.length > 0 && (
                    <NextSteps projectId={id} explores={!code} tests={list} scheduleCount={schedules.data ? schedules.data.schedules.length : schedules.error ? 0 : undefined} hasSignIn={hasSignIn} firstNotPassing={attention[0]} notPassing={attention.length} />
                )}

                {job && settled && <ApiChangesCard projectId={id} />}

                {job && settled && !code && <ScreenMapCard key={`screens-${job.jobId}`} projectId={id} />}

                {/* The latest exploration's site map and what it reused (sheet #8), a plan-only one too; nothing for a run of tests. */}
                {job && !active && !code && (job.mode ?? "generate") === "generate" && !(job.targets?.includes("mobile") ?? false) && <ExplorerKnowledge key={`knows-${job.jobId}`} projectId={id} jobId={job.jobId} active={false} />}

                {job && settled && <SiteMemoryCard key={`memory-${job.jobId}`} projectId={id} />}

                {job && settled && <SlowestPages projectId={id} />}

                {/* Shown only when something was left behind or some test changes data; the full switch lives in Settings > Test data. */}
                {job && settled && <CleanupCard key={`cleanup-${job.jobId}`} projectId={id} />}

                {job && settled && attention.length > 0 && (
                    <section>
                        <div className="section-head">
                            <h2 className="t-section">Needs your attention</h2>
                            <span className="t-meta">Most serious first</span>
                            <BadgeKey label="the badges in this list" entries={[...statusKey(attention.slice(0, 5).map((t) => t.validationStatus)), ...severityKey(attention.slice(0, 5).map((t) => t.severity?.severity))]} />
                            <span className="spacer" />
                            {attention.length > 5 && (
                                <a href={routes.tests(id)} className="row" style={{ gap: 4 }}>
                                    View all {attention.length} <ArrowRight size={14} aria-hidden />
                                </a>
                            )}
                        </div>
                        <ul className="card list divided">
                            {attention.slice(0, 5).map((t) => (
                                <li key={t.id}>
                                    <a className="list-row" href={routes.test(t.id)}>
                                        <span className="main">
                                            <span className="title">{t.title}</span>
                                            <span className="meta truncate">{cleanReason(t.validationReason) || t.testId}</span>
                                        </span>
                                        <span className="tail">
                                            {t.quarantine && <Badge tone="info" title={`In quarantine: ${t.quarantine.reason}`}>Quarantined</Badge>}
                                            {t.severity && <SeverityBadge severity={t.severity.severity} basis={t.severity.basis} />}
                                            <StatusBadge status={t.validationStatus} />
                                        </span>
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {job && <div className="card" style={{ padding: "0 20px" }}><TechnicalDetails job={job} /></div>}
            </div>
        </>
    );
}

/**
 * The Dashboard of a Test Case Generation project (founder 2026-11-19 P1, P3, P5, P6, P7): the header (name, kind, Explore again), what is
 * still to set up, the run while one runs, and the outcome report with its one download. No pass or fail, no tests to run or open, no
 * plan to confirm, no requirements coverage: the agent writes test cases and stops.
 */
function CaseAgentDashboard({ id, p, outcome, needsSecrets, onChanged }: { id: string; p: ProjectDetail; outcome: Outcome; needsSecrets: Array<{ label: string }>; onChanged: () => void }) {
    const can = useCan();
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const job = p.latestJob ? phoneJobOf(p.latestJob, p.application?.url) : p.latestJob;
    const active = isActive(job?.status);
    const url = p.application?.url;
    const download = async () => {
        setDownloadError(null);
        try {
            await downloadFrom(`/projects/${id}/outcome/workbook`, `${p.name} test cases.xlsx`);
        } catch (e) {
            setDownloadError((e as Error).message);
        }
    };
    return (
        <>
            <ProjectHead
                project={p}
                subtitle={
                    <>
                        {url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                                {hostOf(url)} <ExternalLink size={13} aria-hidden />
                            </a>
                        ) : (
                            !p.mobile && <span>No application yet</span>
                        )}
                        {job && <JobBadge job={{ ...job, caseAgent: true }} tipFocusable />}
                    </>
                }
                actions={
                    <LinkButton href={exploreAgainHref(job, id)} icon={RefreshCw}>
                        Explore again
                    </LinkButton>
                }
            />
            <ProjectTabs id={id} active="overview" modes={projectShape(p).testingModes} />
            {p.archived_at && <ArchivedNote id={id} />}
            <div className="stack" data-testid="case-agent-dashboard">
                <SetupChecklist id={id} />
                {needsSecrets.length > 0 && (
                    <Callout tone="warning" title="Some details need entering again" actions={<LinkButton size="sm" href={routes.setup(id, "storage")}>Open Storage and backup</LinkButton>}>
                        {needsSecrets.map((n) => n.label).join("; ")}. They are never part of a backup.
                    </Callout>
                )}
                {job && active && <JobProgress job={job} onChanged={onChanged} />}
                {downloadError && (
                    <Callout tone="danger" title="The test cases could not be downloaded">
                        {downloadError}
                    </Callout>
                )}
                <CaseOutcome
                    outcome={outcome}
                    downloadHref={can("ai_studio.reports.export") ? `/api/projects/${id}/outcome/workbook` : null}
                    onDownload={() => void download()}
                    emptyActions={
                        <LinkButton href={routes.newProject({ project: id })} variant="primary" icon={Sparkles}>
                            Start exploring
                        </LinkButton>
                    }
                />
            </div>
        </>
    );
}

const notRunLine = (n: number) => `${plural(n, "test case")} ${n === 1 ? "is" : "are"} written and not run yet: run ${n === 1 ? "it" : "them"} when you choose.`;

function Result({ job, total, validated, attention, notRun = 0, projectId, code, onChanged }: { job: NonNullable<ProjectDetail["latestJob"]>; total: number; validated: number; attention: number; /** Tests written and not run yet. */ notRun?: number; projectId: string; /** A code project: nothing offers exploring. */ code: boolean; /** A Continue started a job: the page reads the project again. */ onChanged?: () => void }) {
    if (job.mode === "variants") return <VariantsResult job={job} projectId={projectId} />;
    if (job.mode === "environment") return <EnvironmentResult job={job} projectId={projectId} />;
    if (job.mode === "plain") return <PlainResult job={job} projectId={projectId} />;
    if (job.mode === "agent") {
        return (
            <div className="card card-pad">
                <Callout tone="neutral" title="The last run was an agent run" actions={<LinkButton size="sm" href={routes.agentRuns(projectId)}>Open agent runs</LinkButton>}>
                    Its steps and result are under Agent runs.
                </Callout>
            </div>
        );
    }
    if (job.status === "FAILED" && job.planOnly && job.error === "Cancelled" && !code) {
        return (
            <div className="card card-pad" data-testid="exploring-stopped">
                <Callout tone="neutral" title="Exploring was stopped" actions={job.canContinue ? <ContinueExploring job={job} projectId={projectId} onStarted={onChanged} /> : <LinkButton size="sm" variant="primary" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>Explore again</LinkButton>}>
                    No plan was made and nothing was created. Tests you already had are unchanged.{job.canContinue ? ` ${continueNote(job)}` : ""}
                </Callout>
            </div>
        );
    }
    if (nothingRan(job)) {
        const e = friendlyError(job.error);
        return (
            <div className="card card-pad">
                <Callout tone="info" title={e.title} actions={<LinkButton size="sm" href={routes.run(projectId, job.jobId)}>See each test</LinkButton>}>
                    {e.body}
                </Callout>
            </div>
        );
    }
    if (job.status === "FAILED") {
        const e = friendlyError(job.error);
        return (
            <div className="card card-pad">
                <Callout
                    tone={job.error === "Cancelled" ? "neutral" : "danger"}
                    title={job.cancelled ? stoppedLine(job.cancelled) : e.title}
                    actions={
                        <>
                            {job.cancelled && <LinkButton size="sm" href={routes.run(projectId, job.jobId)}>See each test</LinkButton>}
                            {!code && job.canContinue && <ContinueExploring job={job} projectId={projectId} onStarted={onChanged} />}
                            {!code && !job.canContinue && (!job.cancelled || job.mode === "generate" || job.mode === undefined) && (
                                <LinkButton size="sm" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>
                                    Try again
                                </LinkButton>
                            )}
                            {e.fix && <LinkButton size="sm" href={e.fix.href}>{e.fix.label}</LinkButton>}
                        </>
                    }
                >
                    {job.cancelled?.note ?? e.body}
                    {!code && job.canContinue && ` ${continueNote(job)}`}
                </Callout>
            </div>
        );
    }
    const problems = friendlyJobErrors(job.error);
    const allGood = job.status === "COMPLETED" && attention === 0;
    return (
        <div className="stack-sm">
            <Callout
                tone={allGood ? "success" : "warning"}
                title={allGood ? "Your test suite is ready" : attention > 0 ? `Your test suite is ready — ${plural(attention, "test")} ${attention === 1 ? "is" : "are"} not passing` : "Your test suite is ready, with a few gaps"}
                actions={
                    total > 0 && (
                        <LinkButton size="sm" href={routes.tests(projectId)} icon={ArrowRight} variant={allGood ? "primary" : "secondary"}>
                            View test suite
                        </LinkButton>
                    )
                }
            >
                {allGood && notRun === 0
                    ? `${plural(validated, "test")} created and ${validated === 1 ? "it was" : "all were"} run successfully.`
                    : allGood
                      ? `${validated ? `${plural(validated, "test")} passed. ` : ""}${notRunLine(notRun)}`
                      : `${plural(validated, "test")} passed.${attention > 0 ? " The rest found something worth checking or couldn’t be made reliable." : ""}${notRun ? ` ${notRunLine(notRun)}` : ""}`}
            </Callout>
            {problems.map((e) => (
                <Callout
                    key={e.title + e.body}
                    tone="warning"
                    title={e.title}
                    actions={e.fix ? <LinkButton size="sm" href={e.fix.href}>{e.fix.label}</LinkButton> : code ? undefined : <LinkButton size="sm" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>Explore again</LinkButton>}
                >
                    {e.body}
                </Callout>
            ))}
        </div>
    );
}

const tickOf = (t: TestSummary): Tick => (t.validationStatus === "VALIDATED" ? "pass" : t.validationStatus === "NEEDS_REVIEW" ? "attention" : t.validationStatus === "FAILED_VALIDATION" ? "fail" : "idle");

function RunRibbon({ list }: { list: TestSummary[] }) {
    const ticks = list.map(tickOf);
    const n = (k: Tick) => ticks.filter((t) => t === k).length;
    const c = { pass: n("pass"), attention: n("attention"), fail: n("fail"), idle: n("idle") };
    return (
        <div className="ribbon-wrap">
            <Ribbon ticks={ticks} label={`${plural(list.length, "test")}: ${c.pass} passing, ${c.attention} need a look, ${c.fail} failing, ${c.idle} not run yet`} />
            <RibbonLegend {...c} />
        </div>
    );
}

function Loading() {
    return (
        <div className="stack">
            <div className="stack-sm">
                <Skeleton w={240} h={28} />
                <Skeleton w={160} h={16} />
            </div>
            <Skeleton h={120} style={{ borderRadius: 12 }} />
            <ListSkeleton rows={3} />
        </div>
    );
}
