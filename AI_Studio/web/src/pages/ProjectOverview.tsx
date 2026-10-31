import { useEffect, useRef } from "react";
import { ArrowRight, ChevronRight, ExternalLink, ListChecks, RefreshCw, Sparkles } from "lucide-react";
import { projectShape, type ProjectDetail, type Severity, type TestSummary, type TestingMode } from "../api";
import { JobProgress } from "../components/JobProgress";
import { ExplorerWatch } from "../features/explorer/ExplorerView";
import { NextSteps } from "../features/onboarding/NextSteps";
import { PlanPreview } from "../features/onboarding/PlanPreview";
import { exploreAgainHref, phoneJobOf } from "../features/phone/phone";
import { HelpPlace } from "../features/guide/HelpContext";
import { ApiChangesCard } from "../features/contracts/ApiChangesCard";
import { SiteMemoryCard } from "../features/memory/SiteMemoryCard";
import { CleanupCard } from "../features/cleanup/CleanupCard";
import { SlowestPages } from "../features/performance/SlowestPages";
import { VariantsResult } from "../features/variants/VariantsResult";
import { EnvironmentResult } from "../features/environments/EnvironmentResult";
import { PlainResult } from "../features/authoring/PlainResult";
import { SecurityProjectTab } from "../features/security/TestingType";
import { SecuritySummaryCard } from "../features/security/SecurityPage";
import { SetupChecklist } from "../features/workspace/SetupChecklist";
import { usePage } from "../components/Shell";
import { TechnicalDetails } from "../components/TechnicalDetails";
import { Badge, Callout, EmptyState, ErrorState, JobBadge, LinkButton, ListSkeleton, Metric, PageHeader, Ribbon, RibbonLegend, SeverityBadge, Skeleton, StatusBadge, severityKey, statusKey, type Tick } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { useEmbedded } from "../lib/embedded";
import type { ScheduleList } from "../features/schedules/schedules";
import { hostOf, plural, relativeTime } from "../lib/format";
import { cleanReason, friendlyError, friendlyJobErrors, isActive } from "../lib/labels";
import { useDocumentTitle, useFetch, useOnFinish, useProjectChanged } from "../lib/hooks";
import { help } from "../lib/help";
import { routes } from "../lib/router";
import { countedSentence } from "../features/quarantine/quarantine";
import { stoppedLine } from "../features/runs/runs";
import "../features/quarantine/quarantine.css";

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const attentionRank = (t: TestSummary) => (t.severity ? SEV_RANK[t.severity.severity] : t.validationStatus === "NEEDS_REVIEW" ? 4 : 5);

/** The six places of a project, one job each. */
/** The project's places, in the order of the testing lifecycle (docs/product-restructure/INFORMATION_ARCHITECTURE.md). */
export type PlaceKey = "overview" | "requirements" | "tests" | "suites" | "scripts" | "agent" | "runs" | "settings";

export function ProjectTabs({ id, active, count, modes }: { id: string; active: PlaceKey; count?: number; /** The project's testing modes, when the page already has them (else they are asked for). */ modes?: TestingMode[] }) {
    const nav = useRef<HTMLElement>(null);
    // A section shown inside a hub is under the hub's own tab bar.
    const embedded = useEmbedded();
    // Agent runs only for a project with agent mode on (US-010); the place itself says so if opened anyway.
    const fetched = useFetch<ProjectDetail>(modes || embedded ? null : `/projects/${id}`);
    useProjectChanged(id, fetched.reload);
    const agentOn = (modes ?? projectShape(fetched.data).testingModes).includes("agent");
    // On a narrow screen the tab row scrolls sideways: bring the current tab into view so it is never clipped.
    useEffect(() => {
        nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }, [active, count]);
    if (embedded) return null;
    const tab = (href: string, label: string, key: string, n?: number, tour?: string) => (
        <a className="tab" href={href} aria-current={active === key ? "page" : undefined} data-tour={tour}>
            {label}
            {n !== undefined && <span className="count">{n}</span>}
        </a>
    );
    return (
        <nav className="tabs" aria-label="Project sections" ref={nav} data-tour="project-tabs">
            {tab(routes.project(id), "Dashboard", "overview", undefined, "tab-overview")}
            {tab(routes.requirements(id), "Requirements", "requirements", undefined, "tab-requirements")}
            {tab(routes.tests(id), "Test cases", "tests", count, "tab-tests")}
            {tab(routes.suites(id), "Test suites", "suites", undefined, "tab-suites")}
            {tab(routes.scripts(id), "Test scripts", "scripts", undefined, "tab-scripts")}
            {(agentOn || active === "agent") && tab(routes.agentRuns(id), "Agent runs", "agent", undefined, "tab-agent")}
            {tab(routes.runs(id), "Runs", "runs", undefined, "tab-runs")}
            <SecurityProjectTab id={id} />
            {tab(routes.projectSettings(id), "Settings", "settings", undefined, "tab-settings")}

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
    useOnFinish(isActive(p?.latestJob?.status), () => void tests.reload());
    useDocumentTitle(p?.name ?? "Project");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: p?.name ?? "…" }], nav: "projects" });

    if (project.loading) return <Loading />;
    if (project.error || !p) return <ErrorState error={friendlyError(project.error?.message ?? "Project not found")} onRetry={project.reload} />;

    // The job answer may not say what it explored; a project whose application is a phone app has phone jobs.
    const job = p.latestJob ? phoneJobOf(p.latestJob, p.application?.url) : p.latestJob;
    const list = tests.data ?? [];
    const weakCount = list.filter((t) => t.quality?.level === "weak").length;
    const heldCount = list.filter((t) => t.quarantine).length;
    const attention = list.filter((t) => t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION").sort((a, b) => attentionRank(a) - attentionRank(b));
    const validated = list.filter((t) => t.validationStatus === "VALIDATED").length;
    const active = isActive(job?.status);
    // An exploration that stops at a plan has made no tests: what it shows is the plan, not a result.
    const planStage = job?.planOnly === true;
    const settled = Boolean(job) && !active && !planStage;
    const hasSignIn = (p.application as { hasCredentials?: boolean } | null)?.hasCredentials === true;
    const url = p.application?.url;
    // The soonest enabled schedule; nothing is shown when there is none (an empty line would only say "nothing yet").
    const nextRun = (schedules.data?.schedules ?? []).filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];

    return (
        <>
            <PageHeader
                title={p.name}
                subtitle={
                    <>
                        {url && (
                            <a href={url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                                {hostOf(url)} <ExternalLink size={13} aria-hidden />
                            </a>
                        )}
                        {job && <JobBadge job={job} tipFocusable />}
                    </>
                }
                actions={
                    <>
                        <LinkButton href={exploreAgainHref(job, id)} icon={RefreshCw}>
                            Explore again
                        </LinkButton>
                        {list.length > 0 && (
                            <LinkButton href={routes.tests(id)} variant="primary" icon={ListChecks}>
                                View tests
                            </LinkButton>
                        )}
                    </>
                }
            />
            <ProjectTabs id={id} active="overview" count={tests.data?.length} modes={projectShape(p).testingModes} />

            <div className="stack">
                {/* What the project's platforms and modes still need (US-010); hidden when all is set. */}
                <SetupChecklist id={id} />
                {!job && (
                    <div className="card">
                        <EmptyState icon={Sparkles} title="Not explored yet" actions={<LinkButton href={routes.newProject({ project: id })} variant="primary" icon={Sparkles}>Start exploring</LinkButton>}>
                            Start with the application’s URL. We’ll explore it, create tests and run them.
                        </EmptyState>
                    </div>
                )}

                <SecuritySummaryCard id={id} />

                {(storage.data?.needsSecrets.length ?? 0) > 0 && (
                    <Callout tone="warning" title="Some details need entering again" actions={<LinkButton size="sm" href={routes.setup(id, "storage")}>Open Storage and backup</LinkButton>}>
                        {storage.data!.needsSecrets.map((n) => n.label).join("; ")}. They are never part of a backup.
                    </Callout>
                )}

                {job && active && <JobProgress job={job} onChanged={project.reload} />}

                {/* The last picture of the Explorer view stays on screen after the exploration (only when this tab was watching). */}
                {job && !active && <ExplorerWatch job={job} />}

                {job && !active && planStage && (job.status === "FAILED" ? <Result job={job} total={list.length} validated={validated} attention={attention.length} projectId={id} /> : <><HelpPlace place="plan-preview" /><PlanPreview key={job.jobId} projectId={id} job={job} onChanged={project.reload} /></>)}

                {job && settled && <Result job={job} total={list.length} validated={validated} attention={attention.length} projectId={id} />}

                {job && settled && (list.length > 0 || job.status !== "FAILED") && (
                    <div className="card divided" style={{ overflow: "hidden" }}>
                        {list.length > 0 && <RunRibbon list={list} />}
                        <div className="metrics">
                            <Metric value={list.length || p.test_count} label="Tests" tip={help("metric", "tests")} />
                            <Metric value={validated || p.validated_count} label="Passing" tone="ok" tip={help("metric", "passing")} />
                            <Metric value={attention.length} label="Not passing" tone={attention.length ? "warn" : undefined} tip={attention.length ? `${help("metric", "notPassing")} They are listed below, most serious first.` : help("metric", "notPassing")} />
                            {/* The project's latest job, which can be a run as well as an exploration: the tip says so. */}
                            <Metric value={relativeTime(job.finishedAt ?? job.createdAt)} label="Last explored" tip="When the project's latest job ended. That job can be a run of the tests as well as an exploration." />
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
                    <NextSteps projectId={id} tests={list} scheduleCount={schedules.data ? schedules.data.schedules.length : schedules.error ? 0 : undefined} hasSignIn={hasSignIn} firstNotPassing={attention[0]} notPassing={attention.length} />
                )}

                {job && settled && <ApiChangesCard projectId={id} />}

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

function Result({ job, total, validated, attention, projectId }: { job: NonNullable<ProjectDetail["latestJob"]>; total: number; validated: number; attention: number; projectId: string }) {
    if (job.mode === "variants") return <VariantsResult job={job} projectId={projectId} />;
    if (job.mode === "environment") return <EnvironmentResult job={job} projectId={projectId} />;
    if (job.mode === "plain") return <PlainResult job={job} projectId={projectId} />;
    if (job.status === "FAILED" && job.planOnly && job.error === "Cancelled") {
        return (
            <div className="card card-pad">
                <Callout tone="neutral" title="Exploring was stopped" actions={<LinkButton size="sm" variant="primary" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>Explore again</LinkButton>}>
                    No plan was made and nothing was created. Tests you already had are unchanged.
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
                            {(!job.cancelled || job.mode === "generate" || job.mode === undefined) && (
                                <LinkButton size="sm" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>
                                    Try again
                                </LinkButton>
                            )}
                            {e.fix && <LinkButton size="sm" href={e.fix.href}>{e.fix.label}</LinkButton>}
                        </>
                    }
                >
                    {job.cancelled?.note ?? e.body}
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
                {allGood
                    ? `${plural(validated, "test")} created and ${validated === 1 ? "it was" : "all were"} run successfully.`
                    : `${plural(validated, "test")} passed.${attention > 0 ? " The rest found something worth checking or couldn’t be made reliable." : ""}`}
            </Callout>
            {problems.map((e) => (
                <Callout
                    key={e.title + e.body}
                    tone="warning"
                    title={e.title}
                    actions={e.fix ? <LinkButton size="sm" href={e.fix.href}>{e.fix.label}</LinkButton> : <LinkButton size="sm" href={exploreAgainHref(job, projectId)} icon={RefreshCw}>Explore again</LinkButton>}
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
