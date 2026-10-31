import { ChevronRight, FolderKanban, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { ProjectRow } from "../../api";
import { Planned } from "../../components/Planned";
import { usePage } from "../../components/Shell";
import { Badge, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader, Skeleton } from "../../components/ui";
import { EmbeddedContext } from "../../lib/embedded";
import { useConfig, useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useAuth } from "../auth/auth";
import { YourAccount } from "../auth/PeopleSettings";
import { PERMISSION_WORDS, SIDE_WORDS, permissionsOf, sideOf, useCan, type Permission } from "../auth/permissions";
import { FleetDashboard } from "../dashboard/FleetDashboard";
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
            <Planned
                title="Runner health"
                phase="Phase 4"
                testId="planned-dashboard-runners"
                will={["Runners online, busy and offline, the phones and browsers they offer, and how long runs wait in the queue."]}
                today={<>Each project shows its own runner in Settings → Runners.</>}
            />
            {can("ai_studio.usage.view") && (
                <section className="card card-pad stack-sm" data-testid="dashboard-ai">
                    <h2 className="t-section">AI usage</h2>
                    <p className="t-secondary">Usage and the estimated cost of every project, by model and by month, with the limits that stop a run.</p>
                    <div>
                        <LinkButton href={routes.settings}>Open AI usage</LinkButton>
                    </div>
                    <p className="t-meta">Planned (Phase 7): cost by who pays, Crowd4Test or the customer.</p>
                </section>
            )}
        </GlobalPage>
    );
}

/** Test development: start writing tests in any of your projects, with the AI or by hand. */
export function TestDevelopmentPage() {
    const projects = useFetch<ProjectRow[]>("/projects");
    const can = useCan();
    return (
        <GlobalPage title="Test development" nav="develop" subtitle="Write tests in any of your projects: with the AI, by recording, step by step, or as code.">
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
                                {can("ai_studio.tests.write") && (
                                    <LinkButton size="sm" href={routes.record(p.id)} tip="Use the application while the platform writes down each step.">
                                        Record
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
            <Planned
                title="Drafts waiting for review"
                phase="Phase 3"
                testId="planned-review-queue"
                will={["Every test case and script the AI wrote that is still a draft, across your projects, with Approve and Ask for changes for Project Admins."]}
            />
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

/** Runners: the machines that run tests. One registry of machines, granted to projects, is Phase 4 (decision D-16). */
export function RunnersPage() {
    const projects = useFetch<ProjectRow[]>("/projects");
    return (
        <GlobalPage title="Runners" nav="runners" subtitle="The computers that run your tests: Windows and Mac machines, their browsers and phones.">
            <Planned
                title="One list of machines"
                phase="Phase 4"
                testId="planned-runner-registry"
                will={[
                    "Register a computer once, then give it to any number of projects.",
                    "See each runner online, busy or offline, with its browsers, phones and current work, and diagnose problems.",
                    "Approve new runners, pause one so it finishes its work and takes no more (drain), or remove one at once (revoke).",
                ]}
                today={<>Today a runner belongs to one project. Set it up in that project’s Settings → Runners.</>}
            />
            {(projects.data ?? []).length > 0 && (
                <section className="stack-sm" aria-labelledby="runners-by-project">
                    <h2 className="t-section" id="runners-by-project">
                        Runners by project
                    </h2>
                    <ul className="card list divided">
                        {(projects.data ?? []).map((p) => (
                            <li key={p.id}>
                                <a className="list-row" href={routes.runners(p.id)}>
                                    <span className="main">
                                        <span className="title truncate">{p.name}</span>
                                        <span className="meta">Settings → Runners</span>
                                    </span>
                                    <ChevronRight size={18} className="chev" aria-hidden />
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            <MobileTooling />
        </GlobalPage>
    );
}

/** Folders: projects grouped inside an organisation (open question Q-08 in the decisions document). */
export function FoldersPage() {
    return (
        <GlobalPage title="Folders" nav="folders" subtitle="Keep projects in order.">
            <Planned
                title="Folders"
                phase="after the MVP"
                testId="planned-folders"
                will={["Put projects into folders within your organisation, and see a folder’s projects together.", "Later: building blocks shared by several projects (reusable steps, shared elements)."]}
                today={<>All your projects are listed in Projects.</>}
            />
        </GlobalPage>
    );
}

/** Profile: who is signed in, which features they have, and their own settings. */
export function ProfilePage() {
    const { state } = useAuth();
    const me = state?.me;
    const perms = permissionsOf(me);
    const side = sideOf(me);
    const fromCrowd4Test = me?.via === "crowd4test";
    const granted = (Object.keys(PERMISSION_WORDS) as Permission[]).filter((p) => perms.has(p));
    return (
        <GlobalPage title="Profile" nav="profile" subtitle="Your account, and what you can do in AI Studio.">
            <section className="card card-pad stack-sm" data-testid="profile-account">
                <h2 className="t-section">Account</h2>
                <dl className="kv">
                    <dt>Name</dt>
                    <dd>{me?.name ?? "—"}</dd>
                    {me?.email && (
                        <>
                            <dt>Email</dt>
                            <dd>{me.email}</dd>
                        </>
                    )}
                    {side !== "local" && (
                        <>
                            <dt>Side</dt>
                            <dd>{SIDE_WORDS[side]}</dd>
                        </>
                    )}
                </dl>
                {fromCrowd4Test && state?.crowd4test && (
                    <p className="t-secondary">
                        You sign in with your Crowd4Test account. Change your name, email or password in <a href={state.crowd4test.portalUrl}>your Crowd4Test portal</a>.
                    </p>
                )}
            </section>
            <section className="card card-pad stack-sm" data-testid="profile-permissions">
                <h2 className="t-section">What you can do</h2>
                {granted.length === 0 ? (
                    <p className="t-secondary">Nothing yet. Ask your Crowd4Test administrator.</p>
                ) : (
                    <ul className="planned-list">
                        {granted.map((p) => (
                            <li key={p}>{PERMISSION_WORDS[p]}</li>
                        ))}
                    </ul>
                )}
                <p className="t-meta">{fromCrowd4Test ? "A Crowd4Test administrator chooses these. Projects open to you are the ones you were added to." : "These follow your role on this platform."}</p>
            </section>
            {/* Password and personal API tokens: only for accounts of this platform itself. A Crowd4Test sign-in has neither here. */}
            {me?.kind === "user" && !fromCrowd4Test && <YourAccount />}
            <Planned title="Preferences and notifications" phase="after the MVP" testId="planned-profile-preferences" will={["Choose which emails and alerts you receive, and your default project."]} />
        </GlobalPage>
    );
}
