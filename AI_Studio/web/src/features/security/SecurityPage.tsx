import { ChevronRight, Plus, ShieldCheck, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectRow } from "../../api";
import { usePage } from "../../components/Shell";
import { EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { ActivityPage } from "./Activity";
import { ApplicationDetail, ApplicationsPage, NewApplicationPage } from "./Applications";
import { NotificationsPage } from "./Notifications";
import { AssessmentDetail, AssessmentsPage, NewAssessmentPage } from "./Assessments";
import { FindingDetail, FindingsPage, NewFindingPage } from "./Findings";
import { SecurityOverview } from "./Overview";
import { ReportsPage } from "./Reports";
import { canRun, useRole } from "./SecurityChrome";
import { SEC, TESTING_TYPES, includesSecurity, loadTestingType, sec, useSecurityStatus, useTestingType, type OverviewAnswer, type TestingType } from "./security";
import "./security.css";

/** `#/projects/:id/security/<rest>`: one page per place of the security section. */
export function SecurityPage({ id, rest }: { id: string; rest: string[] }) {
    const status = useSecurityStatus();
    // Nothing of the section asks the server anything until the module is known to be on (off: its routes answer 404).
    if (!status) return <ListSkeleton rows={3} />;
    if (!status.enabled) return <SecurityOff id={id} />;
    return <SecurityRoutes id={id} rest={rest} />;
}

function SecurityOff({ id }: { id: string }) {
    useDocumentTitle("Security assessment");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: "Security assessment" }], nav: "projects" });
    return (
        <div className="card">
            <EmptyState icon={ShieldOff} title="Security assessment is turned off on this server" actions={<LinkButton href={routes.project(id)}>Open the project</LinkButton>}>
                The person who runs this platform can turn it on with the SECURITY_ASSESSMENT setting. Functional testing works as usual.
            </EmptyState>
        </div>
    );
}

function SecurityRoutes({ id, rest }: { id: string; rest: string[] }) {
    const [a, b] = rest;
    if (a === "applications") return b === "new" ? <NewApplicationPage id={id} /> : b ? <ApplicationDetail id={id} appId={b} key={b} /> : <ApplicationsPage id={id} />;
    if (a === "new") return <NewAssessmentPage id={id} />;
    if (a === "assessments") return b ? <AssessmentDetail id={id} aid={b} key={b} /> : <AssessmentsPage id={id} />;
    if (a === "findings") return b === "new" ? <NewFindingPage id={id} /> : b ? <FindingDetail id={id} fid={b} key={b} /> : <FindingsPage id={id} />;
    if (a === "reports") return <ReportsPage id={id} />;
    if (a === "activity") return <ActivityPage id={id} />;
    if (a === "notifications") return <NotificationsPage id={id} />;
    return <SecurityOverview id={id} />;
}

/** `#/security`: the top-level Security assessment place, listing the projects that include it. */
export function SecurityHome() {
    useDocumentTitle("Security assessment");
    usePage({ crumbs: [{ label: "Security assessment" }], nav: "security" });
    const role = useRole();
    const status = useSecurityStatus();
    const projects = useFetch<ProjectRow[]>(status?.enabled ? "/projects" : null);
    const [types, setTypes] = useState<Record<string, TestingType>>();
    useEffect(() => {
        const list = (projects.data ?? []).slice(0, 100);
        if (!projects.data) return;
        let gone = false;
        void Promise.all(list.map(async (p) => [p.id, (await loadTestingType(p.id)).type] as const)).then((pairs) => !gone && setTypes(Object.fromEntries(pairs)));
        return () => {
            gone = true;
        };
    }, [projects.data]);
    const newProject = canRun(role) ? (
        <LinkButton href={`${routes.newProject()}?type=security`} variant="primary" icon={Plus}>
            New security project
        </LinkButton>
    ) : null;
    const header = <PageHeader title="Security assessment" subtitle="Passive, read-only assessments of applications your clients authorized, kept apart from functional testing." actions={status?.enabled ? newProject : null} />;
    if (!status || (status.enabled && (projects.loading || (projects.data && !types))))
        return (
            <>
                {header}
                <ListSkeleton rows={3} />
            </>
        );
    if (!status.enabled)
        return (
            <>
                {header}
                <div className="card">
                    <EmptyState icon={ShieldOff} title="Security assessment is turned off on this server" actions={<LinkButton href={routes.home}>Open projects</LinkButton>}>
                        The person who runs this platform can turn it on with the SECURITY_ASSESSMENT setting. Functional testing works as usual.
                    </EmptyState>
                </div>
            </>
        );
    if (projects.error)
        return (
            <>
                {header}
                <ErrorState error={friendlyError(projects.error.message)} onRetry={projects.reload} />
            </>
        );
    const withSecurity = (projects.data ?? []).filter((p) => includesSecurity(types?.[p.id]));
    const others = (projects.data ?? []).filter((p) => !includesSecurity(types?.[p.id]));
    return (
        <>
            {header}
            <div className="stack">
                {withSecurity.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={ShieldCheck} title="No security projects yet" actions={newProject}>
                            No assessments yet. Create a project for security assessment, add an application and run your first passive assessment. An existing project can include it too: open its Settings and change the testing type.
                        </EmptyState>
                    </div>
                ) : (
                    <ul className="card list divided" data-testid="sec-projects" data-tour="sec-projects">
                        {withSecurity.map((p) => (
                            <li key={p.id}>
                                <a className="list-row" href={sec.overview(p.id)}>
                                    <span className="lead">
                                        <ShieldCheck size={18} aria-hidden />
                                    </span>
                                    <span className="main">
                                        <span className="title">{p.name}</span>
                                        <span className="meta">{TESTING_TYPES.find((t) => t.value === types?.[p.id])?.label}</span>
                                    </span>
                                    <ChevronRight size={18} className="chev" aria-hidden />
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
                {others.length > 0 && (
                    <p className="t-meta">
                        {others.length === 1 ? "1 other project is" : `${others.length} other projects are`} for functional testing only. To add security assessment to one, open its Settings and change the testing type.
                    </p>
                )}
            </div>
        </>
    );
}

/**
 * On a project's Overview: one small card that links to the security section (results never mix). A project that is for security
 * assessment only opens its security overview instead of the functional one.
 */
export function SecuritySummaryCard({ id }: { id: string }) {
    const info = useTestingType(id);
    const on = !!info?.available && includesSecurity(info.type);
    const overview = useFetch<OverviewAnswer>(on ? `${SEC}/projects/${id}/overview` : null);
    useEffect(() => {
        if (info?.available && info.type === "security") location.replace(`${location.pathname}${location.search}${sec.overview(id)}`);
    }, [info, id]);
    if (!on || info?.type === "security") return null;
    const c = overview.data?.counts ?? {};
    const critHigh = c.openCriticalHigh ?? 0;
    const review = c.awaitingReview ?? 0;
    return (
        <section className="card card-pad row" aria-labelledby="sec-sum" data-testid="security-summary">
            <ShieldCheck size={20} aria-hidden style={{ color: "var(--text-brand)" }} />
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                <h2 className="t-card" id="sec-sum">
                    Security assessment
                </h2>
                <p className="t-secondary">
                    {overview.loading ? "Loading…" : overview.error ? "Its summary could not be read." : `${critHigh} open critical or high, ${review} awaiting review.`} Kept apart from the tests on this page.
                </p>
            </div>
            <LinkButton href={sec.overview(id)}>Open security assessment</LinkButton>
        </section>
    );
}
