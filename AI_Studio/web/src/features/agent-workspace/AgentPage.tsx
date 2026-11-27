import { CalendarClock, History, Play } from "lucide-react";
import { ProjectHub, type HubSection } from "../../components/ProjectHub";
import { Badge, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { friendlyError, isActive } from "../../lib/labels";
import { BadgeKey } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { routes, type AgentTab } from "../../lib/router";
import { CandidateFindings } from "../runs/CandidateFindings";
import { RunDetail } from "../runs/RunDetail";
import { RelTime } from "../runs/RunTime";
import type { AgentDetail, AgentId } from "../testing-agents/testing-agents";
import { AgentDefaults } from "./AgentSettings";
import { AGENT_VIEWS } from "./registry";
import { RunStatus } from "./RunStatus";
import { failedWhy, RUN_STATUS_HELP, runStatusOf, statusWords, type AgentRun, type WorkspaceAnswer } from "./workspace";
import "./workspace.css";

/**
 * One testing agent of a project with the Agent Workspace (SPEC §2): Outcome (its result only), Runs (its runs only) and Settings (its own
 * saved defaults, its schedules and the inputs it uses; the old Setup tab), under the project's Workspace tab. What each tab shows is the agent's own file in ./agents (registry.ts).
 */
export function AgentPage({ id, agentId, tab, runId }: { id: string; agentId: string; tab: AgentTab; runId?: string }) {
    // Its own card only, polled only while its own run is going.
    const ws = useFetch<WorkspaceAnswer>(`/projects/${id}/workspace?agent=${encodeURIComponent(agentId)}`, (d) => (d?.agents.some((a) => a.id === agentId && a.status === "running") ? 3000 : null));
    const a = ws.data?.agents.find((x) => x.id === agentId);
    const view = AGENT_VIEWS[agentId as AgentId] ?? null;
    const missing = Boolean(ws.data && !a) || Boolean(ws.error);
    const body = (render: () => JSX.Element) => () =>
        missing ? <ErrorState error={friendlyError(ws.error?.message ?? "This testing agent is not one of this project's agents.")} onRetry={ws.error ? () => void ws.reload() : undefined} /> : !a ? <ListSkeleton rows={3} /> : render();
    const sections: HubSection[] = [
        {
            key: "outcome",
            label: "Outcome",
            hint: "What this agent found: its result only",
            render: body(() => (
                <div className="stack">
                    {/* Test Case Generation's Outcome says why its run failed in its own words; every other agent's says it here. */}
                    {agentId !== "test-generation" && failedWhy(a!) && (
                        <Callout tone="danger" title="The last run failed">
                            <span data-testid="agent-failed-why">{failedWhy(a!)}</span>
                        </Callout>
                    )}
                    {view ? <view.Outcome projectId={id} /> : <NotShownYet name={a!.name} />}
                    {/* What a check agent found, to Confirm, call Not a bug or file as an issue; shown only when it found any. */}
                    {agentId !== "test-generation" && <CandidateFindings projectId={id} agentId={agentId} explores={false} />}
                </div>
            )),
        },
        {
            key: "runs",
            label: "Runs",
            hint: "This agent’s runs only",
            render: body(() => (runId ? view?.Run ? <view.Run projectId={id} jobId={runId} /> : <RunDetail id={id} jobId={runId} /> : view?.Runs ? <view.Runs projectId={id} /> : <AgentRuns projectId={id} agentId={agentId} />)),
        },
        {
            key: "settings",
            label: "Settings",
            hint: "How this agent runs, its schedules, and what it uses",
            render: body(() => (
                <div className="stack" data-testid="agent-settings">
                    <AgentDefaults projectId={id} agentId={agentId} />
                    <AgentSchedulesLink projectId={id} agentId={agentId} />
                    <h3 className="t-section">What it uses</h3>
                    {view?.Setup ? <view.Setup projectId={id} /> : <AgentNeeds projectId={id} agentId={agentId} needs={a!.needs} />}
                </div>
            )),
        },
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

/** Where this agent's schedules are: Schedules, showing this agent's only (W3 review M4). */
export function AgentSchedulesLink({ projectId, agentId }: { projectId: string; agentId: string }) {
    return (
        <p className="t-meta" data-testid="agent-schedules-link">
            <CalendarClock size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
            To run this agent on a timetable, open <a href={routes.agentSchedules(projectId, agentId)}>Schedules</a>.
        </p>
    );
}

/** The default Runs tab: this agent's runs, newest first, each with what it found in one line and opening that run's page. */
function AgentRuns({ projectId, agentId }: { projectId: string; agentId: string }) {
    const runs = useFetch<AgentRun[]>(`/projects/${projectId}/workspace/${agentId}/runs`, (d) => (d?.some((j) => isActive(j.status)) ? 3000 : null));
    if (runs.loading) return <ListSkeleton rows={3} />;
    if (runs.error) return <ErrorState error={friendlyError(runs.error.message)} onRetry={() => void runs.reload()} />;
    const list = runs.data ?? [];
    if (!list.length)
        return (
            <div className="stack">
                <div className="card">
                    <EmptyState icon={History} title="No runs yet">
                        Each run of this agent is listed here.
                    </EmptyState>
                </div>
                <AgentSchedulesLink projectId={projectId} agentId={agentId} />
            </div>
        );
    const words = list.map((j) => ({ ...statusWords({ status: runStatusOf(j), lastRun: j }), help: RUN_STATUS_HELP[runStatusOf(j)] ?? "" }));
    return (
        <div className="stack">
            <p className="t-meta">
                <BadgeKey label="the run statuses" entries={words.map((w) => ({ word: w.label, text: w.help }))} />
            </p>
            <ul className="card divided ws-runs" data-testid="agent-runs">
                {list.map((j, i) => (
                    <li key={j.jobId} className="row section">
                        <a href={routes.projectAgentRun(projectId, agentId, j.jobId)}>Run {list.length - i}</a>
                        <RunStatus job={j} />
                        <span className="spacer" />
                        <span className="t-meta">
                            Started <RelTime iso={j.createdAt} />
                        </span>
                        {j.headline && (
                            <p className="ws-run-headline" data-testid="run-headline">
                                {j.headline}
                            </p>
                        )}
                    </li>
                ))}
            </ul>
            <AgentSchedulesLink projectId={projectId} agentId={agentId} />
        </div>
    );
}

/** The default What it uses part of the Settings tab: what the agent needs (the catalogue's words) and what it misses now. */
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
