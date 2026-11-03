import { ArrowLeft, Bot } from "lucide-react";
import { PLATFORM_WORDS } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader, Skeleton } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { AgentAvatar, type AgentDetail, type AgentList, type AgentProjectRef, type AgentWhere } from "./testing-agents";

/** What this server cannot do for the agents, said once at the top (production has no worker and no AI key). */
function ServerNotes({ where }: { where: AgentWhere }) {
    return (
        <>
            {!where.ai.configured && (
                <Callout tone="warning" title="AI is not set up on this server">
                    The agents explore with an AI model, so none of them can work here until one is set up in Settings. You can still choose agents for your projects.
                </Callout>
            )}
            {!where.canRun.ok && (
                <Callout tone="warning" title="Tests do not run on this server">
                    {where.canRun.reason ?? "Nothing runs the tests here."} The agents’ checks run where your tests run.
                </Callout>
            )}
        </>
    );
}

const platformsText = (ps: readonly string[]) => (ps.length ? ps.map((p) => PLATFORM_WORDS[p as keyof typeof PLATFORM_WORDS] ?? p).join(", ") : "None yet");

/** Agents: the testing agents, each with what it does, and the projects of yours that use it. */
export function AgentsPage() {
    useDocumentTitle("Agents");
    usePage({ crumbs: [{ label: "Agents" }], nav: "agents" });
    const list = useFetch<AgentList>("/testing-agents");
    return (
        <>
            <PageHeader title="Agents" subtitle="The testing agents of AI Studio. Choose the ones a project uses when you create it, or later in its Settings." />
            <div className="stack" data-testid="agents-page">
                {list.loading ? (
                    <ListSkeleton rows={4} />
                ) : list.error || !list.data ? (
                    <ErrorState error={friendlyError(list.error?.message ?? "The agents could not be loaded.")} onRetry={list.reload} />
                ) : (
                    <>
                        <ServerNotes where={list.data} />
                        <ul className="ta-grid" aria-label="Testing agents">
                            {list.data.agents.map((a) => (
                                <li key={a.id}>
                                    <a className={`card ta-card${a.available ? "" : " is-off"}`} href={routes.agent(a.id)} data-testid={`agent-card-${a.id}`}>
                                        <span className="ta-card-head">
                                            <AgentAvatar id={a.id} available={a.available} />
                                            <span className="t-card">{a.name}</span>
                                        </span>
                                        <span className="t-secondary">{a.summary}</span>
                                        <span className="ta-card-foot">
                                            {a.available ? <Badge tone="neutral">{platformsText(a.platforms)}</Badge> : <Badge tone="warning">Not available yet</Badge>}
                                            {a.available && <span className="t-meta">{a.projects.length === 1 ? "1 project uses it" : `${a.projects.length} projects use it`}</span>}
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </>
    );
}

function ProjectList({ projects }: { projects: AgentProjectRef[] }) {
    if (projects.length === 0)
        return (
            <EmptyState icon={Bot} title="No project uses it yet">
                Choose it for a project in the project’s Settings → General, or when you create a project tested by the AI agent.
            </EmptyState>
        );
    return (
        <ul className="list divided" aria-label="Projects that use it">
            {projects.map((x) => (
                <li key={x.id} className="list-row">
                    <span className="main">
                        <a className="title truncate" href={routes.project(x.id)}>
                            {x.name}
                        </a>
                        {x.source === "matched" && <span className="meta">From the project’s earlier exploration settings. No choice saved yet.</span>}
                    </span>
                    <LinkButton size="sm" variant="ghost" href={routes.projectSettings(x.id)}>
                        Change agents
                    </LinkButton>
                </li>
            ))}
        </ul>
    );
}

/** One agent opened: what it checks, where it works, what it needs, and the projects that use it. */
export function AgentDetailPage({ id }: { id: string }) {
    const d = useFetch<AgentDetail>(`/testing-agents/${encodeURIComponent(id)}`);
    const name = d.data?.agent.name ?? "Agent";
    useDocumentTitle(name);
    usePage({ crumbs: [{ label: "Agents", href: routes.agents }, { label: name }], nav: "agents" });
    if (d.loading) return <Skeleton h={260} />;
    if (d.error || !d.data) return <ErrorState error={friendlyError(d.error?.message ?? "Testing agent not found")} onRetry={d.reload} />;
    const a = d.data.agent;
    return (
        <div className="stack" data-testid="agent-detail">
            <div className="ta-detail-head">
                <AgentAvatar id={a.id} available={a.available} size="lg" />
                <div className="main">
                    <PageHeader title={a.name} subtitle={a.summary} />
                    {!a.available && (
                        <div>
                            <Badge tone="warning">Not available yet</Badge>
                        </div>
                    )}
                </div>
            </div>
            {a.available && <ServerNotes where={d.data} />}
            <section className="card card-pad stack-sm" aria-labelledby="agent-what">
                <h2 className="t-section" id="agent-what">
                    What it does
                </h2>
                <p className="t-secondary">{a.description}</p>
            </section>
            {a.available ? (
                <>
                    <div className="grid-2">
                        <section className="card card-pad stack-sm" aria-labelledby="agent-checks">
                            <h2 className="t-section" id="agent-checks">
                                What it checks
                            </h2>
                            <ul className="ta-list">
                                {a.checks.map((c) => (
                                    <li key={c}>{c}</li>
                                ))}
                            </ul>
                        </section>
                        <section className="card card-pad stack-sm" aria-labelledby="agent-needs">
                            <h2 className="t-section" id="agent-needs">
                                What it needs
                            </h2>
                            <ul className="ta-list">
                                {a.needs.map((c) => (
                                    <li key={c}>{c}</li>
                                ))}
                            </ul>
                            <p className="t-meta">Works on: {platformsText(a.platforms)}.</p>
                        </section>
                    </div>
                    <section className="card stack-sm" aria-labelledby="agent-projects">
                        <div className="card-head">
                            <h2 className="t-section" id="agent-projects">
                                Projects that use it
                            </h2>
                        </div>
                        <ProjectList projects={d.data.projects} />
                    </section>
                </>
            ) : (
                <Callout tone="info" title="It cannot be chosen yet">
                    No project can use this agent until AI Studio can do this kind of testing.
                </Callout>
            )}
            <div>
                <LinkButton variant="ghost" icon={ArrowLeft} href={routes.agents}>
                    All agents
                </LinkButton>
            </div>
        </div>
    );
}
