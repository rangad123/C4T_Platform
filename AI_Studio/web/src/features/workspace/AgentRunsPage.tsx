import { Bot, ChevronRight } from "lucide-react";
import { type ProjectDetail } from "../../api";
import { ProjectPlace } from "../../components/ProjectHub";
import { Badge, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { AgentRunDetail } from "../agent-runs/AgentRunDetail";
import { AgentRunForm } from "../agent-runs/AgentRunForm";
import { isActive, runBadge, type AgentRunList } from "../agent-runs/agent-runs";
import "../agent-runs/agent-runs.css";

/**
 * The Agent runs place (decision D-21, flow B): a person gives an objective, the AI pursues it in a real browser, and a person approves its
 * high-impact actions. `runId` opens one run (`#/projects/:id/agent/:runId`). The AI writing tests, the other half of agent mode, is under Test cases.
 */
export function AgentRunsPage({ id, runId }: { id: string; runId?: string }) {
    return (
        <ProjectPlace id={id} place="agent" title="Agent runs" subtitle="Give the AI an objective. It works through the application in a real browser and reports what it found.">
            {runId ? <AgentRunDetail projectId={id} runId={runId} /> : <RunIndex id={id} />}
        </ProjectPlace>
    );
}

function RunIndex({ id }: { id: string }) {
    const list = useFetch<AgentRunList>(`/projects/${id}/agent-runs`, (d) => (d?.runs.some(isActive) ? 3000 : null));
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const access = project.data?.access?.permissions;
    const canRun = !access || access.includes("ai_studio.agent.run");
    const seesUsage = !access || access.includes("ai_studio.usage.view");
    const data = list.data;

    return (
        <div className="stack">
            {data && !data.agentModeOn && (
                <Callout tone="info" title="Agent mode is off for this project">
                    Turn it on in <a href={routes.projectSettings(id, "general")}>Settings → General</a> to use agent runs.
                </Callout>
            )}
            {data && !data.canStart.ok && (
                <Callout tone="warning" title="Agent runs cannot start here">
                    {data.canStart.reason}
                </Callout>
            )}
            {data && <p className="t-secondary">{data.whereItRuns}</p>}
            {data && canRun && <AgentRunForm projectId={id} list={data} seesUsage={seesUsage} onStarted={(r) => go(routes.agentRun(id, r.id))} />}
            <section className="card" aria-labelledby="agent-runs-title">
                <div className="card-head">
                    <h2 className="t-section" id="agent-runs-title">
                        Runs
                    </h2>
                </div>
                {list.loading ? (
                    <ListSkeleton rows={3} />
                ) : !data ? (
                    <div className="card-pad">
                        <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                    </div>
                ) : data.runs.length === 0 ? (
                    <EmptyState icon={Bot} title="No agent runs yet">
                        A run takes an objective in plain words, like “a new customer can add a gift card to the cart”. {canRun ? "" : "Starting one needs permission to run agents."}
                    </EmptyState>
                ) : (
                    <ul className="list divided" aria-label="Agent runs">
                        {data.runs.map((r) => {
                            const badge = runBadge(r);
                            return (
                                <li key={r.id}>
                                    <a className="list-row" href={routes.agentRun(id, r.id)} data-agent-run={r.id}>
                                        <span className="main">
                                            <span className="title">{r.objective}</span>
                                            <span className="meta">
                                                {plural(r.stepsTaken, "step")}, started by {r.startedBy.name} {relativeTime(r.createdAt)}
                                            </span>
                                        </span>
                                        <span className="tail">
                                            <Badge tone={badge.tone} tip={badge.help}>
                                                {badge.label}
                                            </Badge>
                                        </span>
                                        <ChevronRight size={16} className="chev" aria-hidden />
                                    </a>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </div>
    );
}
