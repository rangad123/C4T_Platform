import { Fragment } from "react";
import { Gauge, Play } from "lucide-react";
import type { Job } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { Badge, ErrorState, EmptyState, JobBadge, LinkButton, ListSkeleton } from "../../../components/ui";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { friendlyError, isActive, type Tone } from "../../../lib/labels";
import { routes } from "../../../lib/router";
import type { AgentInputs } from "../../requirements/AgentInputs";
import { RelTime } from "../../runs/RunTime";
import { formatValue, METRIC_LABEL, type Measured } from "../../performance/performance";
import type { AgentView } from "../registry";
import "../../environments/environments.css";

const ID = "performance";

type Verdict = "within" | "over" | "not-measured";
type Endpoint = { testId: string; endpoint: string; verdict: Verdict; note: string | null; metrics: Measured[] };
/** GET /api/projects/:id/workspace/performance/outcome (src/platform/agent-outcomes/performance.ts). */
interface PerformanceOutcome {
    runs: number;
    pages: Array<{ testId: string; path: string; signedIn: boolean; verdict: Verdict; note: string | null; metrics: Measured[] }>;
    slowest: Array<Measured & { testId: string; path: string }>;
    calls: Endpoint[];
    load: Endpoint[];
}

const PAGE_VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
    within: { label: "Within budget", tone: "success" },
    over: { label: "Over budget", tone: "warning" },
    "not-measured": { label: "Not measured", tone: "neutral" },
};
const LOAD_VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
    within: { label: "Coped", tone: "success" },
    over: { label: "Struggled", tone: "warning" },
    "not-measured": { label: "Not measured", tone: "neutral" },
};
/** The timings shown per page, in the order a visitor feels them. */
const TIMINGS = ["ttfb", "fcp", "lcp", "load"];
const LOAD_SHOWN = ["load_users", "load_requests", "load_p95", "load_error_rate"];
const value = (metrics: Measured[], metric: string) => {
    const m = metrics.find((x) => x.metric === metric);
    return m ? formatValue(m) : "–";
};

/** Each page's timings, the slowest pages and the load result, of every run or of one. */
function Body({ projectId, run, active }: { projectId: string; run?: string; active: boolean }) {
    const o = useFetch<PerformanceOutcome>(`/projects/${projectId}/workspace/${ID}/outcome${run ? `?run=${run}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void o.reload());
    if (!o.data && !o.error) return <ListSkeleton rows={4} />;
    if (!o.data) return <ErrorState error={friendlyError(o.error?.message)} onRetry={() => void o.reload()} />;
    const { pages, slowest, calls, load } = o.data;
    if (!o.data.runs)
        return (
            <div className="card">
                <EmptyState icon={Gauge} title="No pages timed yet" actions={<LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Play}>Run the agent</LinkButton>}>
                    Each run loads the key pages it finds three times from scratch and compares the timings with their budgets.
                </EmptyState>
            </div>
        );
    return (
        <div className="stack" data-testid="performance-outcome">
            <section className="stack-sm">
                <div className="section-head">
                    <h3 className="t-section">Pages</h3>
                    <span className="t-meta">The middle of three fresh loads</span>
                </div>
                {pages.length ? (
                    <div className="data-table-wrap" role="region" aria-label="Page timings" tabIndex={0}>
                        <table className="data-table" data-testid="performance-pages" style={{ minWidth: 720 }}>
                            <thead>
                                <tr>
                                    <th scope="col">Page</th>
                                    {TIMINGS.map((t) => (
                                        <th key={t} scope="col">{METRIC_LABEL[t]}</th>
                                    ))}
                                    <th scope="col">Budget</th>
                                </tr>
                            </thead>
                            <tbody>
                                {pages.map((p) => (
                                    <tr key={`${p.signedIn}${p.path}`}>
                                        <td>
                                            <span className="mono">{p.path}</span>
                                            {p.signedIn && <div className="t-meta">Signed in</div>}
                                        </td>
                                        {TIMINGS.map((t) => (
                                            <td key={t} className="tnum nowrap">{value(p.metrics, t)}</td>
                                        ))}
                                        <td>
                                            <Badge tone={PAGE_VERDICT[p.verdict].tone}>{PAGE_VERDICT[p.verdict].label}</Badge>
                                            {p.note && p.verdict !== "within" && <div className="t-meta">{p.note}</div>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="t-secondary">No page was timed in {run ? "this run" : "its runs"}.</p>
                )}
            </section>
            {slowest.length > 0 && (
                <section className="stack-sm">
                    <div className="section-head">
                        <h3 className="t-section">Slowest pages</h3>
                        <span className="t-meta">By when the main content appears</span>
                    </div>
                    <ol className="card list divided" data-testid="performance-slowest">
                        {slowest.map((s) => (
                            <li key={s.testId} className="list-row">
                                <span className="main mono">{s.path}</span>
                                <span className="tnum">{formatValue(s)}</span>
                                {s.budget !== undefined && <span className="t-meta">{s.value > s.budget ? `over the ${formatValue({ ...s, value: s.budget })} budget` : "within budget"}</span>}
                            </li>
                        ))}
                    </ol>
                </section>
            )}
            {calls.length > 0 && (
                <section className="stack-sm">
                    <div className="section-head">
                        <h3 className="t-section">API call timings</h3>
                        <span className="t-meta">Safe calls, one at a time</span>
                    </div>
                    <div className="data-table-wrap" role="region" aria-label="API call timings" tabIndex={0}>
                        <table className="data-table" data-testid="performance-calls" style={{ minWidth: 520 }}>
                            <thead>
                                <tr>
                                    <th scope="col">Call</th>
                                    <th scope="col">{METRIC_LABEL.p50}</th>
                                    <th scope="col">{METRIC_LABEL.p95}</th>
                                    <th scope="col">Budget</th>
                                </tr>
                            </thead>
                            <tbody>
                                {calls.map((c) => (
                                    <tr key={c.testId}>
                                        <td className="mono">{c.endpoint}</td>
                                        <td className="tnum nowrap">{value(c.metrics, "p50")}</td>
                                        <td className="tnum nowrap">{value(c.metrics, "p95")}</td>
                                        <td>
                                            <Badge tone={PAGE_VERDICT[c.verdict].tone}>{PAGE_VERDICT[c.verdict].label}</Badge>
                                            {c.note && c.verdict !== "within" && <div className="t-meta">{c.note}</div>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
            <section className="stack-sm">
                <h3 className="t-section">Load check</h3>
                {load.length ? (
                    <ul className="card list divided" data-testid="performance-load">
                        {load.map((l) => (
                            <li key={l.testId} className="card-pad stack-sm">
                                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                    <span className="mono">{l.endpoint}</span>
                                    <Badge tone={LOAD_VERDICT[l.verdict].tone}>{LOAD_VERDICT[l.verdict].label}</Badge>
                                </div>
                                {l.note && <p className="t-meta" style={{ margin: 0 }}>{l.note}</p>}
                                {l.metrics.length > 0 && (
                                    <dl className="ws-inputs">
                                        {LOAD_SHOWN.map((m) => (
                                            <Fragment key={m}>
                                                <dt>{METRIC_LABEL[m]}</dt>
                                                <dd className="tnum">{value(l.metrics, m)}</dd>
                                            </Fragment>
                                        ))}
                                    </dl>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="t-secondary">None in {run ? "this run" : "its runs"}. Tick Include a load check when you run the agent. It never runs on a production environment.</p>
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

/** One run: what it timed, numbered as in the Runs list. */
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
                <JobBadge job={job} tipFocusable />
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

/** What it uses: the address it explores, the sign-in for pages behind one, and when a load check runs. */
function Setup({ projectId }: { projectId: string }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    const d = inputs.data;
    if (!d) return <ErrorState error={friendlyError(inputs.error?.message)} onRetry={() => void inputs.reload()} />;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            <p className="t-secondary">It times the key pages the exploration finds. Timings depend on the environment, so use a steady test environment.</p>
            <dl className="ws-inputs">
                <dt>Application address</dt>
                <dd>{d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a></dd>
                <dt>Sign in</dt>
                <dd>{d.signIn.username ? `As ${d.signIn.username}: pages behind the sign-in are timed signed in` : "None: it times the pages a visitor sees"} · <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a></dd>
                <dt>Load check</dt>
                <dd>When you tick Include a load check for a run: up to ten users at once on up to three safe calls, never on a production environment</dd>
            </dl>
        </section>
    );
}

export const view: AgentView = { Outcome, Run, Setup };
