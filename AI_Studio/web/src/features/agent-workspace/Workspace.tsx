import { ArrowRight, ExternalLink, FileSpreadsheet, Network, Play, ShieldCheck } from "lucide-react";
import { projectShape, type ProjectDetail } from "../../api";
import { ArchivedNote } from "../../components/ProjectHub";
import { ProjectHead } from "../../components/ProjectKind";
import { Badge, Callout, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { hostOf } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { ProjectTabs } from "../../pages/ProjectOverview";
import { sec } from "../security/security";
import { AgentAvatar } from "../testing-agents/testing-agents";
import { SetupChecklist } from "../workspace/SetupChecklist";
import { statusWords, type WorkspaceAgent, type WorkspaceAnswer } from "./workspace";
import "./workspace.css";

/**
 * The landing of a project with the Agent Workspace (SPEC §1, owner decision D2): one card per chosen agent (what it does, its status,
 * its outcome in one line, Run and Open) and the handoffs between agents. Nothing moves between agents by itself (D4).
 */
export function Workspace({ id, p, needsSecrets }: { id: string; p: ProjectDetail; needsSecrets: Array<{ label: string }> }) {
    const ws = useFetch<WorkspaceAnswer>(`/projects/${id}/workspace`, (d) => (d?.agents.some((a) => a.status === "running") ? 3000 : null));
    const url = p.application?.url;
    const agents = ws.data?.agents ?? [];
    return (
        <>
            <ProjectHead
                project={p}
                subtitle={
                    url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
                            {hostOf(url)} <ExternalLink size={13} aria-hidden />
                        </a>
                    ) : (
                        !p.mobile && <span>No application yet</span>
                    )
                }
            />
            <ProjectTabs id={id} active="overview" modes={projectShape(p).testingModes} />
            {p.archived_at && <ArchivedNote id={id} />}
            <div className="stack" data-testid="workspace">
                <SetupChecklist id={id} />
                {needsSecrets.length > 0 && (
                    <Callout tone="warning" title="Some details need entering again" actions={<LinkButton size="sm" href={routes.setup(id, "storage")}>Open Storage and backup</LinkButton>}>
                        {needsSecrets.map((n) => n.label).join("; ")}. They are never part of a backup.
                    </Callout>
                )}
                {ws.loading ? (
                    <ListSkeleton rows={3} />
                ) : ws.error ? (
                    <ErrorState error={friendlyError(ws.error.message)} onRetry={() => void ws.reload()} />
                ) : (
                    <>
                        <section aria-labelledby="ws-agents-h">
                            <div className="section-head">
                                <h2 className="t-section" id="ws-agents-h">
                                    Agents
                                </h2>
                                <span className="t-meta">Each does one job and shows its own outcome</span>
                            </div>
                            <div className="ws-grid">
                                {agents.map((a) => (
                                    <AgentCard key={a.id} projectId={id} a={a} />
                                ))}
                            </div>
                        </section>
                        <Flow projectId={id} agents={agents} />
                    </>
                )}
            </div>
        </>
    );
}

function AgentCard({ projectId, a }: { projectId: string; a: WorkspaceAgent }) {
    const s = statusWords(a);
    return (
        <article className="card card-pad ws-card" data-agent={a.id} aria-labelledby={`ws-${a.id}-h`}>
            <div className="ws-card-head">
                <AgentAvatar id={a.id} size="sm" />
                <h3 className="t-card" id={`ws-${a.id}-h`}>
                    <a href={routes.projectAgent(projectId, a.id)}>{a.name}</a>
                </h3>
            </div>
            <Badge tone={s.tone}>{s.label}</Badge>
            <p className="t-secondary">{a.summary}</p>
            {a.headline && (
                <p className="ws-headline" data-testid="agent-headline">
                    {a.headline}
                </p>
            )}
            {a.status === "needs-input" && (
                <ul className="ws-needs" data-testid="agent-needs">
                    {a.needs.map((n) => (
                        <li key={n}>{n}</li>
                    ))}
                </ul>
            )}
            <div className="row ws-actions">
                {a.status !== "running" && (
                    <LinkButton size="sm" variant="primary" icon={Play} href={routes.newProject({ project: projectId, agent: a.id })}>
                        Run
                    </LinkButton>
                )}
                <LinkButton size="sm" icon={ArrowRight} href={routes.projectAgent(projectId, a.id)}>
                    Open
                </LinkButton>
            </div>
        </article>
    );
}

/** The real handoffs (SPEC §1): the shared tree, and the manual exports between agents and places (D4). */
function Flow({ projectId, agents }: { projectId: string; agents: WorkspaceAgent[] }) {
    const has = (id: string) => agents.some((a) => a.id === id);
    return (
        <section className="card card-pad stack-sm" aria-labelledby="ws-flow-h" data-testid="workspace-flow">
            <h2 className="t-section" id="ws-flow-h">
                How work moves between agents
            </h2>
            <ol className="ws-flow">
                <li>
                    <Network size={18} aria-hidden />
                    <span>
                        <strong>One tree of the application.</strong> Every agent’s run explores the application and adds to the same tree of its pages, and every agent starts from it.
                    </span>
                </li>
                {has("test-generation") && (
                    <li>
                        <FileSpreadsheet size={18} aria-hidden />
                        <span>
                            <strong>Test cases to a code project.</strong> Download the test case workbook from <a href={routes.projectAgent(projectId, "test-generation")}>Test Case Generation</a> and import it into a code project to make test scripts.
                        </span>
                    </li>
                )}
                {has("security") && (
                    <li>
                        <ShieldCheck size={18} aria-hidden />
                        <span>
                            <strong>Security findings to the Security Assessment.</strong> What the Security agent finds is evidence for a <a href={sec.overview(projectId)}>Security Assessment</a>.
                        </span>
                    </li>
                )}
            </ol>
            <p className="t-meta">Nothing moves by itself: each agent runs when you start it.</p>
        </section>
    );
}
