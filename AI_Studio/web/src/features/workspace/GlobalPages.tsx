import { FolderKanban, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectRow } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader, Skeleton } from "../../components/ui";
import { EmbeddedContext } from "../../lib/embedded";
import { useConfig, useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useCan } from "../auth/permissions";
import { FleetDashboard } from "../dashboard/FleetDashboard";
import { ReviewQueueCard } from "../review/ReviewCards";
import { RunnerHealthCard, RunnersList } from "../runners/RunnersPages";
import { EmulatorSetup } from "../setup/EmulatorSetup";

/**
 * The global places of AI Studio (docs/product-restructure/INFORMATION_ARCHITECTURE.md), beside the project list (`#/`, pages/Home).
 * Each shows what exists today and, where its backend is not built yet, says so plainly (decision D-28).
 */

function GlobalPage({ title, nav, subtitle, actions, children }: { title: string; nav: "dashboard" | "develop" | "runners" | "folders" | "profile"; subtitle: ReactNode; actions?: ReactNode; children: ReactNode }) {
    useDocumentTitle(title);
    usePage({ crumbs: [{ label: title }], nav });
    return (
        <>
            <PageHeader title={title} subtitle={subtitle} actions={actions} />
            <div className="stack">{children}</div>
        </>
    );
}

/** Dashboard: how every project is doing, then the machines and the AI. */
export function DashboardPage() {
    const can = useCan();
    return (
        <GlobalPage title="Dashboard" nav="dashboard" subtitle="How your projects are doing, the machines that run them, and the AI they use.">
            {/* The fleet view of the project list, shown here as a section of the dashboard (its own header becomes a section heading). */}
            <EmbeddedContext.Provider value={true}>
                <FleetDashboard
                    fallback={
                        <p className="t-secondary">
                            <a href={routes.home}>Open your projects</a>
                        </p>
                    }
                />
            </EmbeddedContext.Provider>
            {/* Outstanding reviews across the person's projects (features/review/ReviewCards.tsx). */}
            <ReviewQueueCard />
            <RunnerHealthCard />
            {can("ai_studio.usage.view") && (
                <section className="card card-pad stack-sm" data-testid="dashboard-ai">
                    <h2 className="t-section">AI usage</h2>
                    <p className="t-secondary">Usage and the estimated cost of every project, by model, by month and by who pays (Crowd4Test or the customer), with the limits that stop a run.</p>
                    <div>
                        <LinkButton href={routes.settings}>Open AI usage</LinkButton>
                    </div>
                </section>
            )}
        </GlobalPage>
    );
}

/** Test development: a launcher that opens each way of writing tests in any of your projects, and the review queue of drafts across them. */
export function TestDevelopmentPage() {
    const projects = useFetch<ProjectRow[]>("/projects");
    const can = useCan();
    return (
        <GlobalPage title="Test development" nav="develop" subtitle="Pick a project and write tests: with the AI, in your own words, by recording, or step by step. Drafts wait below for review.">
            {projects.loading ? (
                <ListSkeleton rows={3} />
            ) : projects.error ? (
                <ErrorState error={friendlyError(projects.error.message)} onRetry={projects.reload} />
            ) : (projects.data ?? []).length === 0 ? (
                <div className="card">
                    <EmptyState icon={FolderKanban} title="No projects yet" actions={can("ai_studio.project.create") ? <LinkButton variant="primary" href={routes.newProject()}>Create a project</LinkButton> : undefined}>
                        Tests belong to a project. {can("ai_studio.project.create") ? "Create one first." : "Ask a Project Admin to add you to one."}
                    </EmptyState>
                </div>
            ) : (
                <ul className="card list divided" aria-label="Your projects">
                    {(projects.data ?? []).map((p) => (
                        <li key={p.id} className="list-row" style={{ flexWrap: "wrap" }}>
                            <span className="main">
                                <span className="title truncate">{p.name}</span>
                                <span className="meta">{p.test_count === 1 ? "1 test" : `${p.test_count} tests`}</span>
                            </span>
                            <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                {can("ai_studio.tests.generate") && (
                                    <LinkButton size="sm" icon={Sparkles} href={routes.newProject({ project: p.id })} tip="The AI explores the application and writes tests for it.">
                                        Explore with AI
                                    </LinkButton>
                                )}
                                {can("ai_studio.tests.generate") && (
                                    <LinkButton size="sm" href={routes.newTest(p.id, "describe")} tip="Say what to test in your own words. The AI writes the steps.">
                                        Describe in words
                                    </LinkButton>
                                )}
                                {can("ai_studio.tests.write") && (
                                    <LinkButton size="sm" href={routes.record(p.id)} tip="Use the application while the platform writes down each step.">
                                        Record
                                    </LinkButton>
                                )}
                                {can("ai_studio.tests.write") && (
                                    <LinkButton size="sm" href={routes.newTest(p.id, "build")} tip="Add the steps one by one. The script is made for you.">
                                        Build steps
                                    </LinkButton>
                                )}
                                <LinkButton size="sm" variant="ghost" href={routes.tests(p.id)} tip="The project's test cases, with every way to add one (New test).">
                                    Test cases
                                </LinkButton>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {/* The review queue across projects (GET /api/reviews, features/review/ReviewCards.tsx). */}
            <ReviewQueueCard />
        </GlobalPage>
    );
}

/** The Android emulator on this computer (it moved here from Settings: it is about machines, not about the platform). */
function MobileTooling() {
    const config = useConfig();
    return (
        <section className="card card-pad stack-sm" data-testid="mobile-tooling">
            <div className="row">
                <h2 className="t-section">Mobile tooling on this computer</h2>
                <span className="spacer" />
                {config ? <Badge tone={config.mobile?.available ? "success" : "neutral"}>{config.mobile?.available ? "Ready" : "Not set up"}</Badge> : <Skeleton w={80} h={22} />}
            </div>
            {!config ? (
                <Skeleton h={40} />
            ) : config.mobile?.available ? (
                <p className="t-secondary">
                    Mobile tests can run on an Android emulator here: <strong>{config.mobile.avds.join(", ")}</strong>. Choose the app to test per project (Settings → Mobile app).
                </p>
            ) : (
                <>
                    <p className="t-secondary">{config.mobile?.toolchain === "none" ? "Mobile tests run on an Android emulator, which isn’t set up on this computer yet." : "The Android tools are installed, but there’s no emulator to run tests on yet."}</p>
                    <EmulatorSetup />
                </>
            )}
        </section>
    );
}

/** Runners: every machine the person may see, each given to any number of projects (features/runners/RunnersPages.tsx). */
export function RunnersPage() {
    return (
        <GlobalPage title="Runners" nav="runners" subtitle="The computers that run your tests: Windows and Mac machines, their browsers and phones.">
            <RunnersList />
            <MobileTooling />
        </GlobalPage>
    );
}

export { RunnerPage } from "../runners/RunnersPages";

// Folders and Profile have their own files (round 34); main.tsx keeps importing them from here.
export { FoldersPage } from "./FoldersPage";
export { ProfilePage } from "./ProfilePage";
