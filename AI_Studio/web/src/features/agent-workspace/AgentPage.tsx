import { History, Play } from "lucide-react";
import type { Job } from "../../api";
import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { Badge, Callout, EmptyState, ErrorState, JobBadge, LinkButton, ListSkeleton } from "../../components/ui";
import { friendlyError, isActive, jobLabel } from "../../lib/labels";
import { jobHelp } from "../../lib/help";
import { BadgeKey } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { AGENT_TABS, routes, type AgentTab } from "../../lib/router";
import { RunDetail } from "../runs/RunDetail";
import { RelTime } from "../runs/RunTime";
import type { AgentDetail, AgentId } from "../testing-agents/testing-agents";
import { AGENT_VIEWS } from "./registry";
import { statusWords, type WorkspaceAnswer } from "./workspace";
import "./workspace.css";

export const agentTabOf = (v: string | null): AgentTab => ((AGENT_TABS as readonly string[]).includes(v ?? "") ? (v as AgentTab) : "outcome");

/**
 * One testing agent of a project with the Agent Workspace (SPEC §2): Outcome (its result only), Runs (its runs only) and Setup (its
 * inputs only), under the project's Workspace tab. What each tab shows is the agent's own file in ./agents (registry.ts).
 */
export function AgentPage({ id, agentId, tab, runId }: { id: string; agentId: string; tab: AgentTab; runId?: string }) {
    const ws = useFetch<WorkspaceAnswer>(`/projects/${id}/workspace`, (d) => (d?.agents.some((a) => a.status === "running") ? 3000 : null));
    const a = ws.data?.agents.find((x) => x.id === agentId);
    const view = AGENT_VIEWS[agentId as AgentId] ?? null;
    const missing = Boolean(ws.data && !a) || Boolean(ws.error);
    const body = (render: () => JSX.Element) => () =>
        missing ? <ErrorState error={friendlyError(ws.error?.message ?? "This testing agent is not one of this project's agents.")} onRetry={ws.error ? () => void ws.reload() : undefined} /> : !a ? <ListSkeleton rows={3} /> : render();
    const sections: HubSection[] = [
        { key: "outcome", label: "Outcome", hint: "What this agent found: its result only", render: body(() => (view ? <view.Outcome projectId={id} /> : <NotShownYet name={a!.name} />)) },
        {
            key: "runs",
            label: "Runs",
            hint: "This agent’s runs only",
            render: body(() => (runId ? view?.Run ? <view.Run projectId={id} jobId={runId} /> : <RunDetail id={id} jobId={runId} /> : view?.Runs ? <view.Runs projectId={id} /> : <AgentRuns projectId={id} agentId={agentId} />)),
        },
        { key: "setup", label: "Setup", hint: "What this agent uses, and where each is kept", render: body(() => (view?.Setup ? <view.Setup projectId={id} /> : <AgentNeeds projectId={id} agentId={agentId} needs={a!.needs} />)) },
    ];
    const s = a ? statusWords(a) : null;
    return (
        <ProjectHub
            id={id}
            place="overview"
            title={a?.name ?? "…"}
            subtitle={
                a && (
                    <>
                        <span>{a.summary}</span> <Badge tone={s!.tone}>{s!.label}</Badge>
                    </>
                )
            }
            actions={
                a && a.status !== "running" ? (
                    <LinkButton href={routes.newProject({ project: id, agent: agentId })} variant="primary" icon={Play}>
                        Run
                    </LinkButton>
                ) : undefined
            }
            sections={sections}
            current={runId ? "runs" : tab}
            hrefOf={(k) => routes.projectAgent(id, agentId, k as AgentTab)}
        />
    );
}

function NotShownYet({ name }: { name: string }) {
    return (
        <Callout tone="info" title="Not shown here yet">
            The {name}’s outcome comes in a later update. Its runs are listed under Runs.
        </Callout>
    );
}

/** The default Runs tab: this agent's runs, newest first, each opening the run page. */
function AgentRuns({ projectId, agentId }: { projectId: string; agentId: string }) {
    const runs = useFetch<Job[]>(`/projects/${projectId}/workspace/${agentId}/runs`, (d) => (d?.some((j) => isActive(j.status)) ? 3000 : null));
    if (runs.loading) return <ListSkeleton rows={3} />;
    if (runs.error) return <ErrorState error={friendlyError(runs.error.message)} onRetry={() => void runs.reload()} />;
    const list = runs.data ?? [];
    if (!list.length)
        return (
            <div className="card">
                <EmptyState icon={History} title="No runs yet">
                    Each run of this agent is listed here.
                </EmptyState>
            </div>
        );
    return (
        <>
        <p className="t-meta">
            <BadgeKey label="the run statuses" entries={list.map((j) => ({ word: jobLabel(j).label, text: jobHelp(j) }))} />
        </p>
        <ul className="card divided ws-runs" data-testid="agent-runs">
            {list.map((j, i) => (
                <li key={j.jobId} className="row section">
                    <a href={routes.projectAgentRun(projectId, agentId, j.jobId)}>Run {list.length - i}</a>
                    <JobBadge job={j} />
                    <span className="spacer" />
                    <span className="t-meta">
                        Started <RelTime iso={j.createdAt} />
                    </span>
                </li>
            ))}
        </ul>
        </>
    );
}

/** The default Setup tab: what the agent needs (the catalogue's words) and what it misses now. */
function AgentNeeds({ projectId, agentId, needs }: { projectId: string; agentId: string; needs: string[] }) {
    const agent = useFetch<AgentDetail>(`/testing-agents/${agentId}`);
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            {needs.length > 0 && (
                <Callout tone="warning" title="Needs input">
                    {needs.join(" ")}
                </Callout>
            )}
            <h3 className="t-card">What it needs</h3>
            {agent.loading ? <ListSkeleton rows={2} /> : <ul className="ws-needs">{(agent.data?.agent.needs ?? []).map((n) => <li key={n}>{n}</li>)}</ul>}
            <p className="t-meta">
                The address and sign-in are kept in <a href={routes.projectSettings(projectId, "general")}>Settings</a>; the OpenAPI document and the requirements on the <a href={routes.requirements(projectId)}>Requirements</a> tab.
            </p>
        </section>
    );
}
