import { Network, Play } from "lucide-react";
import type { Job, Severity } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { Badge, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, SeverityBadge } from "../../../components/ui";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { friendlyError, isActive, type Tone } from "../../../lib/labels";
import { routes } from "../../../lib/router";
import { agentInputsHref, type AgentInputs } from "../../requirements/AgentInputs";
import { RelTime } from "../../runs/RunTime";
import type { AgentView } from "../registry";
import { RunStatus } from "../RunStatus";
import "../../environments/environments.css";

const ID = "api";

/** GET /api/projects/:id/workspace/api/outcome (src/platform/agent-outcomes/api.ts). */
interface ApiOutcome {
    runs: number;
    endpoints: Array<{ method: string; path: string; statuses: number[]; contract: "matches" | "differs" | "not-checked"; contractNote: string | null; jobId: string }>;
    findings: Array<{ id: string; testId: string; endpoint: string | null; title: string; stateLabel: string; severity: string | null; expected: string; observed: string; reproduced: { same: number; of: number } }>;
}

const CONTRACT: Record<ApiOutcome["endpoints"][number]["contract"], { label: string; tone: Tone }> = {
    matches: { label: "Matches", tone: "success" },
    differs: { label: "Differs", tone: "warning" },
    "not-checked": { label: "Not checked", tone: "neutral" },
};
const SEVERITIES: readonly string[] = ["critical", "high", "medium", "low"];

/** The endpoint table and the verified findings, of every run or of one. */
function Body({ projectId, run, active }: { projectId: string; run?: string; active: boolean }) {
    const o = useFetch<ApiOutcome>(`/projects/${projectId}/workspace/${ID}/outcome${run ? `?run=${run}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void o.reload());
    if (!o.data && !o.error) return <ListSkeleton rows={4} />;
    if (!o.data) return <ErrorState error={friendlyError(o.error?.message)} onRetry={() => void o.reload()} />;
    const { endpoints, findings } = o.data;
    if (!o.data.runs)
        return (
            <div className="card">
                <EmptyState icon={Network} title="No endpoints tested yet" actions={<LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Play}>Run the agent</LinkButton>}>
                    Each run tests the API calls it finds and checks every answer against the OpenAPI document.
                </EmptyState>
            </div>
        );
    return (
        <div className="stack" data-testid="api-outcome">
            <section className="stack-sm">
                <div className="section-head">
                    <h3 className="t-section">Endpoints</h3>
                    <span className="t-meta">Contract: whether the answer matches the OpenAPI document. Not checked: the document has no schema for it, or the call failed first.</span>
                </div>
                {endpoints.length ? (
                    <div className="data-table-wrap" role="region" aria-label="Endpoints" tabIndex={0}>
                        <table className="data-table" data-testid="api-endpoints" style={{ minWidth: 520 }}>
                            <thead>
                                <tr>
                                    <th scope="col" className="nowrap">Method</th>
                                    <th scope="col">Path</th>
                                    <th scope="col" className="nowrap">Status</th>
                                    <th scope="col">Contract</th>
                                </tr>
                            </thead>
                            <tbody>
                                {endpoints.map((e) => (
                                    <tr key={`${e.method} ${e.path}`}>
                                        <td className="mono">{e.method}</td>
                                        <td className="mono">{e.path}</td>
                                        <td className="mono tnum">{e.statuses.length ? e.statuses.join(", ") : "No answer"}</td>
                                        <td>
                                            <Badge tone={CONTRACT[e.contract].tone}>{CONTRACT[e.contract].label}</Badge>
                                            {e.contractNote && <div className="t-meta">{e.contractNote}</div>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="t-secondary">No API call was tested in {run ? "this run" : "its runs"}.</p>
                )}
            </section>
            <section className="stack-sm">
                <h3 className="t-section">Verified findings</h3>
                {findings.length ? (
                    <ul className="card list divided" data-testid="api-findings">
                        {findings.map((f) => (
                            <li key={f.id} className="card-pad stack-sm">
                                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                    <h4 className="t-card" style={{ margin: 0 }}>{f.title}</h4>
                                    {f.severity && SEVERITIES.includes(f.severity) && <SeverityBadge severity={f.severity as Severity} tipFocusable />}
                                    <Badge tone="danger">{f.stateLabel}</Badge>
                                </div>
                                <dl className="ws-inputs">
                                    <dt>Expected</dt>
                                    <dd>{f.expected}</dd>
                                    <dt>What happened</dt>
                                    <dd>{f.observed}</dd>
                                    {f.reproduced.of > 0 && (
                                        <>
                                            <dt>Repeated</dt>
                                            <dd>Failed the same way {f.reproduced.same} of {f.reproduced.of} times</dd>
                                        </>
                                    )}
                                </dl>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="t-secondary">None. A failing API test is listed here once repeating it confirms the problem.</p>
                )}
            </section>
        </div>
    );
}

/** This agent's runs, polled while one goes. */
const useRuns = (projectId: string) => useFetch<Job[]>(`/projects/${projectId}/workspace/${ID}/runs`, (d) => (d?.some((j) => isActive(j.status)) ? 2000 : null));

function Outcome({ projectId }: { projectId: string }) {
    const runs = useRuns(projectId);
    const job = runs.data?.[0];
    const active = isActive(job?.status);
    return (
        <div className="stack">
            {job && active && <JobProgress job={job} onChanged={() => void runs.reload()} />}
            <Body projectId={projectId} active={active} />
        </div>
    );
}

/** One run: what it tested and found, numbered as in the Runs list. */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    const runs = useRuns(projectId);
    const list = runs.data ?? [];
    const at = list.findIndex((j) => j.jobId === jobId);
    const job = list[at];
    if (runs.loading) return <ListSkeleton rows={4} />;
    if (!job) return <ErrorState error={friendlyError(runs.error?.message ?? "This run is not one of this agent's runs.")} />;
    return (
        <div className="stack" data-testid="agent-run">
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                <h3 className="t-card">Run {list.length - at}</h3>
                <RunStatus job={job} />
                <span className="t-meta">
                    Started <RelTime iso={job.createdAt} />
                </span>
                <span className="spacer" />
                <a href={routes.projectAgent(projectId, ID, "runs")}>All runs</a>
            </div>
            {isActive(job.status) && <JobProgress job={job} onChanged={() => void runs.reload()} />}
            <Body projectId={projectId} run={jobId} active={isActive(job.status)} />
        </div>
    );
}

/** What it uses: the OpenAPI document (it cannot run without it), the API access, data-changing calls, and the address it explores. */
function Setup({ projectId }: { projectId: string }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    const d = inputs.data;
    if (!d) return <ErrorState error={friendlyError(inputs.error?.message)} onRetry={() => void inputs.reload()} />;
    const missing = d.missing.filter((m) => m.agent === ID);
    const here = agentInputsHref(projectId);
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            {missing.length > 0 && (
                <Callout tone="warning" title="Needs input">
                    {missing.map((m) => m.text).join(" ")}
                </Callout>
            )}
            <p className="t-secondary">It notes the API calls the application makes while exploring, tests each safe one, and checks every answer against the OpenAPI document.</p>
            <dl className="ws-inputs">
                <dt>OpenAPI document</dt>
                <dd>{d.openApiUrl || "None yet: it cannot run without it"} · <a href={here}>Requirements</a></dd>
                <dt>API access</dt>
                <dd>{d.apiAccess.hasToken ? "An API token is saved" : d.apiAccess.oauth2 ? "OAuth2 client credentials are saved" : "None: it calls the API without a token"} · <a href={here}>Requirements</a></dd>
                <dt>Calls that change data</dt>
                <dd>{d.allowMutatingApiTests ? "Tested" : "Left out"} · <a href={here}>Requirements</a></dd>
                <dt>Application address</dt>
                <dd>{d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a></dd>
            </dl>
        </section>
    );
}

export const view: AgentView = { Outcome, Run, Setup };
