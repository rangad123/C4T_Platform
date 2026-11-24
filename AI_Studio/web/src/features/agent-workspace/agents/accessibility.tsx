import type { CSSProperties, ReactNode } from "react";
import { Accessibility, Play, type LucideIcon } from "lucide-react";
import type { Job } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { Badge, Callout, EmptyState, ErrorState, JobBadge, LinkButton, ListSkeleton, Metric } from "../../../components/ui";
import { friendlyError, isActive, type Tone } from "../../../lib/labels";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { routes } from "../../../lib/router";
import type { AgentInputs } from "../../requirements/AgentInputs";
import { RelTime } from "../../runs/RunTime";
import type { AgentView } from "../registry";

const ID = "accessibility";

/** GET /api/projects/:id/workspace/accessibility/outcome (src/platform/agent-outcomes/accessibility.ts). */
type Severity = "critical" | "serious" | "moderate" | "minor";
interface Issue {
    rule: string;
    severity: Severity;
    help: string;
    elements: number;
    where: string;
}
interface Page {
    path: string;
    state: "issues" | "clean" | "not-checked";
    issues: Issue[];
    moreRules: number;
    note: string | null;
    run: number;
    jobId: string;
}
interface Outcome {
    runs: number;
    pages: Page[];
    rules: Array<{ rule: string; severity: Severity; help: string; pages: number; elements: number }>;
    counts: { issues: number; clean: number; notChecked: number };
}

export const LIST: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };
export const WRAP: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };
export const counted = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The frame both check agents' outcomes share (this file and ux.tsx): the agent's outcome, or one run's part of it (`jobId`), polled while
 * that run goes, with its progress; a project not run yet offers Run. `children` draws the outcome itself.
 */
export function OutcomeFrame<T extends { runs: number }>(props: { projectId: string; agentId: string; jobId?: string; icon: LucideIcon; what: string; children: (o: T) => ReactNode }) {
    const { projectId, agentId, jobId } = props;
    const runs = useFetch<Job[]>(`/projects/${projectId}/workspace/${agentId}/runs`, (d) => (d?.some((j) => isActive(j.status)) ? 2000 : null));
    const at = jobId ? (runs.data ?? []).findIndex((j) => j.jobId === jobId) : 0;
    const job = at >= 0 ? runs.data?.[at] : undefined;
    const active = isActive(job?.status);
    const outcome = useFetch<T>(`/projects/${projectId}/workspace/${agentId}/outcome${jobId ? `?run=${encodeURIComponent(jobId)}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void outcome.reload());
    if (!outcome.data && !outcome.error) return <ListSkeleton rows={4} />;
    return (
        <div className="stack" data-testid={`${agentId}-outcome`}>
            {jobId && job && (
                <div className="row">
                    <h3 className="t-card" style={{ margin: 0 }}>
                        Run {runs.data!.length - at}
                    </h3>
                    <JobBadge job={job} />
                    <span className="t-meta">
                        Started <RelTime iso={job.createdAt} />
                    </span>
                    <span className="spacer" />
                    <a href={routes.projectAgent(projectId, agentId, "runs")}>All runs</a>
                </div>
            )}
            {job && active && <JobProgress job={job} onChanged={() => void runs.reload()} />}
            {jobId && job?.status === "FAILED" && job.error && job.error !== "Cancelled" && (
                <Callout tone="danger" title="This run failed">
                    {friendlyError(job.error).body}
                </Callout>
            )}
            {!outcome.data ? (
                <ErrorState error={{ title: "The outcome could not be loaded", body: outcome.error?.message ?? "" }} onRetry={() => void outcome.reload()} />
            ) : outcome.data.runs === 0 ? (
                <div className="card">
                    <EmptyState
                        icon={props.icon}
                        title="Not run yet"
                        actions={
                            <LinkButton href={routes.newProject({ project: projectId, agent: agentId })} variant="primary" icon={Play}>
                                Run the agent
                            </LinkButton>
                        }
                    >
                        {props.what}
                    </EmptyState>
                </div>
            ) : (
                props.children(outcome.data)
            )}
        </div>
    );
}

/** The run a page's result is from: a link, except on that run's own page. */
export function RunLink({ projectId, agentId, page, inRun }: { projectId: string; agentId: string; page: { run: number; jobId: string }; inRun: boolean }) {
    if (inRun) return null;
    return (
        <a className="t-meta" href={routes.projectAgentRun(projectId, agentId, page.jobId)}>
            Run {page.run}
        </a>
    );
}

/** A titled card holding a list (the sections of both outcomes). */
export function ListCard({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
    return (
        <section className="card" data-testid={testId}>
            <div className="card-head">
                <h3 className="t-card" style={{ margin: 0 }}>
                    {title}
                </h3>
            </div>
            {children}
        </section>
    );
}

/** This agent's inputs, and where each is kept (GET /projects/:id/agent-inputs). */
export function InputsFrame({ projectId, children }: { projectId: string; children: (d: AgentInputs) => ReactNode }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    if (!inputs.data) return <ErrorState error={{ title: "What this agent uses could not be loaded", body: inputs.error?.message ?? "" }} onRetry={() => void inputs.reload()} />;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            {children(inputs.data)}
        </section>
    );
}

const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
    critical: { label: "Critical", tone: "danger" },
    serious: { label: "Serious", tone: "warning" },
    moderate: { label: "Moderate", tone: "info" },
    minor: { label: "Minor", tone: "neutral" },
};
const Sev = ({ s }: { s: Severity }) => <Badge tone={SEVERITY[s].tone}>{SEVERITY[s].label}</Badge>;
const STATE: Record<Page["state"], { label: string; tone: Tone }> = {
    issues: { label: "Issues", tone: "warning" },
    clean: { label: "Clean", tone: "success" },
    "not-checked": { label: "Not checked", tone: "neutral" },
};

/** The issues on each page, by rule and severity, and the pages clean and with issues (SPEC §3): nothing else. */
function Report({ o, projectId, inRun }: { o: Outcome; projectId: string; inRun: boolean }) {
    return (
        <>
            <div className="card divided" style={{ overflow: "hidden" }}>
                <div className="metrics">
                    <Metric value={o.counts.issues} label="Pages with issues" tone={o.counts.issues ? "warn" : undefined} />
                    <Metric value={o.counts.clean} label="Clean pages" tone={o.counts.clean ? "ok" : undefined} />
                    <Metric value={o.counts.notChecked} label="Not checked" />
                    <Metric value={o.rules.length} label="Rules broken" />
                </div>
                <p className="section t-meta" style={{ margin: 0 }}>
                    Each key page is checked signed out against the WCAG 2.1 A and AA rules (axe-core). Issues of serious or critical impact are reported. The rules are facts, not AI judgement.
                </p>
            </div>
            {o.rules.length > 0 && (
                <ListCard title="Rules broken" testId="a11y-rules">
                    <ul className="divided" style={LIST}>
                        {o.rules.map((r) => (
                            <li key={r.rule} className="row section">
                                <Sev s={r.severity} />
                                <span className="mono">{r.rule}</span>
                                <span style={WRAP}>{r.help}</span>
                                <span className="spacer" />
                                <span className="t-meta tnum">
                                    {counted(r.pages, "page")} · {counted(r.elements, "element")}
                                </span>
                            </li>
                        ))}
                    </ul>
                </ListCard>
            )}
            <ListCard title="Pages" testId="a11y-pages">
                {o.pages.length === 0 ? (
                    <p className="section t-secondary" style={{ margin: 0 }}>
                        No page checked yet.
                    </p>
                ) : (
                    <ul className="divided" style={LIST}>
                        {o.pages.map((p) => (
                            <li key={p.path} className="section stack-sm" data-testid="a11y-page">
                                <div className="row">
                                    <span className="mono" style={WRAP}>
                                        {p.path}
                                    </span>
                                    <Badge tone={STATE[p.state].tone}>{STATE[p.state].label}</Badge>
                                    <span className="spacer" />
                                    <RunLink projectId={projectId} agentId={ID} page={p} inRun={inRun} />
                                </div>
                                {p.note && (
                                    <p className="t-meta" style={{ margin: 0 }}>
                                        {p.note}
                                    </p>
                                )}
                                {p.issues.length > 0 && (
                                    <ul className="stack-sm" style={LIST}>
                                        {p.issues.map((i) => (
                                            <li key={i.rule} className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "nowrap" }}>
                                                <Sev s={i.severity} />
                                                <span style={WRAP}>
                                                    <span className="mono">{i.rule}</span>: {i.help}. {counted(i.elements, "element")}: <span className="mono">{i.where}</span>
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {p.moreRules > 0 && (
                                    <p className="t-meta" style={{ margin: 0 }}>
                                        And {counted(p.moreRules, "more rule")} broken on this page.
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </ListCard>
        </>
    );
}

const WHAT = "It checks the key pages of the application against the accessibility rules, and lists the issues on each page.";

function Outcome({ projectId }: { projectId: string }) {
    return (
        <OutcomeFrame<Outcome> projectId={projectId} agentId={ID} icon={Accessibility} what={WHAT}>
            {(o) => <Report o={o} projectId={projectId} inRun={false} />}
        </OutcomeFrame>
    );
}

/** One run: what it checked, the same way (a stopped run's part too). */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    return (
        <OutcomeFrame<Outcome> projectId={projectId} agentId={ID} jobId={jobId} icon={Accessibility} what={WHAT}>
            {(o) => <Report o={o} projectId={projectId} inRun />}
        </OutcomeFrame>
    );
}

function Setup({ projectId }: { projectId: string }) {
    return (
        <InputsFrame projectId={projectId}>
            {(d) => (
                <>
                    <p className="t-secondary" style={{ margin: 0 }}>
                        It explores the application to find its key pages, then checks each one against the accessibility rules. Nothing is clicked or submitted.
                    </p>
                    <dl className="ws-inputs">
                        <dt>Application address</dt>
                        <dd>
                            {d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a>
                        </dd>
                        <dt>AI model</dt>
                        <dd>
                            To explore and find the pages; the checks themselves are rules · <a href={routes.aiKeys}>Settings → AI keys</a>
                        </dd>
                        <dt>Pages checked</dt>
                        <dd>The key pages a visitor can open without signing in</dd>
                    </dl>
                </>
            )}
        </InputsFrame>
    );
}

/** The Accessibility Testing Agent's screens (SPEC §3); its Runs tab is the default list. */
export const view: AgentView = { Outcome, Run, Setup };
