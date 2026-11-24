import { ArrowLeft, ShieldCheck, ShieldOff, Sparkles } from "lucide-react";
import type { Job } from "../../../api";
import { JobProgress } from "../../../components/JobProgress";
import { Badge, EmptyState, ErrorState, LinkButton, ListSkeleton, Metric } from "../../../components/ui";
import type { Tone } from "../../../lib/labels";
import { isActive } from "../../../lib/labels";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { routes } from "../../../lib/router";
import { useCan } from "../../auth/permissions";
import type { AgentInputs } from "../../requirements/AgentInputs";
import { sec } from "../../security/security";
import type { AgentView } from "../registry";

const ID = "security";

/** GET /api/projects/:id/workspace/security/outcome (src/platform/agent-outcomes/security.ts). */
type Area = "access" | "headers" | "exposure";
type Severity = "critical" | "high" | "medium" | "low";
interface Check {
    testId: string;
    testKey: string;
    title: string;
    area: Area;
    result: "passed" | "problem" | "could-not-check" | "not-run";
    reason: string | null;
    finding: { id: string; state: string; label: string; verified: boolean } | null;
    severity: Severity | null;
    problems: Array<{ severity: Severity; text: string }>;
    requested: string[];
    jobId: string | null;
}
interface Finding {
    id: string;
    testId: string;
    testKey: string;
    title: string;
    area: Area;
    label: string;
    severity: string | null;
    expected: string;
    observed: string;
    steps: string[];
    reproduced: { same: number; of: number };
}
interface Outcome {
    runs: number;
    checks: Check[];
    findings: Finding[];
    counts: Record<Severity, number> & { notVerified: number };
}

const AREAS: Array<{ id: Area; title: string; what: string }> = [
    { id: "access", title: "Access control", what: "Pages and API calls meant for one account stay closed to lesser accounts and visitors." },
    { id: "headers", title: "Headers, cookies and HTTPS", what: "Browser protection headers, session cookie flags, cross-origin access and the certificate." },
    { id: "exposure", title: "Exposure", what: "Secret files, backups, version banners and folder listings that should not be public." },
];
const RESULT: Record<Check["result"], { label: string; tone: Tone }> = {
    passed: { label: "Passed", tone: "success" },
    problem: { label: "Found a problem", tone: "warning" },
    "could-not-check": { label: "Could not check", tone: "neutral" },
    "not-run": { label: "Not run", tone: "neutral" },
};
const SEVERITY: Record<Severity, { label: string; tone: Tone }> = {
    critical: { label: "Critical", tone: "danger" },
    high: { label: "High", tone: "danger" },
    medium: { label: "Medium", tone: "warning" },
    low: { label: "Low", tone: "neutral" },
};
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const Sev = ({ s }: { s: Severity }) => <Badge tone={SEVERITY[s].tone}>{SEVERITY[s].label}</Badge>;
const LIST = { listStyle: "none", margin: 0, padding: 0 } as const;
const ROW = { flexWrap: "wrap", gap: 8 } as const;

/** What the agent checked, the problems it found and its verified findings, over all its runs or for one (`run`). */
function OutcomeBody({ projectId, run }: { projectId: string; run?: string }) {
    const can = useCan();
    const roles = useFetch<{ roles: unknown[] }>(`/projects/${projectId}/roles`);
    const runs = useFetch<Job[]>(`/projects/${projectId}/workspace/${ID}/runs`, (d) => (isActive(d?.[0]?.status) ? 2000 : null));
    const job = run ? runs.data?.find((j) => j.jobId === run) : runs.data?.[0];
    const active = isActive(job?.status);
    const outcome = useFetch<Outcome>(`/projects/${projectId}/workspace/${ID}/outcome${run ? `?run=${encodeURIComponent(run)}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void outcome.reload());
    if (!outcome.data && !outcome.error) return <ListSkeleton rows={4} />;
    if (!outcome.data) return <ErrorState error={{ title: "What the Security agent found could not be loaded", body: outcome.error?.message ?? "" }} onRetry={() => void outcome.reload()} />;
    const o = outcome.data;
    const progress = job && active ? <JobProgress job={job} onChanged={() => void runs.reload()} /> : null;
    const assessment = can("ai_studio.security.use") ? (
        <p className="t-meta" data-testid="security-assessment-link">
            <ShieldCheck size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
            These are read-only checks. A full, authorised assessment of the application is made in the <a href={sec.overview(projectId)}>Security Assessment</a>.
        </p>
    ) : null;
    if (!o.checks.length)
        return (
            <div className="stack" data-testid="security-outcome">
                {progress}
                <div className="card">
                    <EmptyState
                        icon={ShieldOff}
                        title={o.runs ? "No security checks yet" : "Not run yet"}
                        actions={
                            !run && !active ? (
                                <LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Sparkles}>
                                    Run the checks
                                </LinkButton>
                            ) : undefined
                        }
                    >
                        It reads the application’s security headers, cookies, exposed files and certificate, and with test accounts checks that restricted pages stay closed.
                    </EmptyState>
                </div>
                {assessment}
            </div>
        );
    const passed = o.checks.filter((c) => c.result === "passed").length;
    const problems = o.checks.filter((c) => c.result === "problem").sort((a, b) => RANK[a.severity ?? "low"] - RANK[b.severity ?? "low"]);
    // The check's own run: on a run's page it is that run, so the title is plain text.
    const name = (c: Check) =>
        run || !c.jobId ? (
            <strong style={{ overflowWrap: "anywhere" }}>{c.title}</strong>
        ) : (
            <a href={routes.projectAgentRun(projectId, ID, c.jobId)} style={{ overflowWrap: "anywhere" }}>
                {c.title}
            </a>
        );
    const noAccounts = roles.data?.roles.length === 0 && !o.checks.some((c) => c.area === "access");
    return (
        <div className="stack" data-testid="security-outcome">
            {progress}
            <div className="card divided" style={{ overflow: "hidden" }}>
                <div className="metrics" data-testid="security-counts">
                    {(["critical", "high", "medium", "low"] as const).map((s) => (
                        <Metric key={s} value={o.counts[s]} label={SEVERITY[s].label} tone={o.counts[s] && s !== "low" ? "warn" : undefined} />
                    ))}
                    {o.checks.some((c) => c.area === "access") && <Metric value={o.counts.notVerified} label="Access problems not verified yet" />}
                </div>
                <p className="section t-meta" style={{ margin: 0 }}>
                    {passed} of {o.checks.length} checks passed{run ? " in this run" : ` over ${o.runs === 1 ? "1 run" : `${o.runs} runs`}`}. Headers, cookies, cross-origin access, HTTPS and exposed files are judged by fixed rules, so what they find is a fact and is counted at once. An access-control problem depends on the test accounts, so it counts once a replay has confirmed it.
                </p>
            </div>
            {problems.length > 0 && (
                <section className="card card-pad stack-sm" aria-labelledby="sec-problems" data-testid="security-problems">
                    <h3 className="t-card" id="sec-problems">
                        Problems
                    </h3>
                    <ul className="stack-sm" style={LIST}>
                        {problems.map((c) => {
                            const f = c.area === "access" && c.finding?.verified ? o.findings.find((x) => x.id === c.finding!.id) : undefined;
                            return (
                                <li key={c.testId} className="stack-sm" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }} data-testid="security-problem">
                                    <div className="row" style={ROW}>
                                        {name(c)}
                                        <span className="t-meta">{AREAS.find((a) => a.id === c.area)!.title}</span>
                                    </div>
                                    {c.area === "access" ? (
                                        <>
                                            <div className="row" style={ROW} data-testid="security-verification">
                                                {c.severity && <Sev s={c.severity} />}
                                                <Badge tone={c.finding?.verified ? "danger" : "neutral"}>{c.finding?.label ?? "Not verified yet"}</Badge>
                                                {c.finding && !c.finding.verified && <span className="t-meta">Not verified yet: it counts once a replay confirms it.</span>}
                                            </div>
                                            {f ? (
                                                <dl className="ws-inputs" data-testid="security-finding">
                                                    <dt>Expected</dt>
                                                    <dd>{f.expected}</dd>
                                                    <dt>Found</dt>
                                                    <dd style={{ whiteSpace: "pre-line" }}>{f.observed}</dd>
                                                    <dt>Reproduction</dt>
                                                    <dd>
                                                        <ol style={{ margin: "0 0 4px", paddingLeft: 20 }}>
                                                            {f.steps.map((s, i) => (
                                                                <li key={i}>{s}</li>
                                                            ))}
                                                        </ol>
                                                        <span className="t-meta">
                                                            Failed the same way in {f.reproduced.same} of {f.reproduced.of} verification replays
                                                        </span>
                                                    </dd>
                                                </dl>
                                            ) : (
                                                c.reason && (
                                                    <span className="t-meta" style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>
                                                        {c.reason}
                                                    </span>
                                                )
                                            )}
                                        </>
                                    ) : (
                                        <dl className="ws-inputs">
                                            {c.requested.length > 0 && (
                                                <>
                                                    <dt>Requested</dt>
                                                    <dd className="mono" style={{ overflowWrap: "anywhere" }}>
                                                        {c.requested.join(", ")}
                                                    </dd>
                                                </>
                                            )}
                                            <dt>Came back</dt>
                                            <dd>
                                                {c.problems.length ? (
                                                    <ul className="stack-sm" style={LIST}>
                                                        {c.problems.map((x, i) => (
                                                            <li key={i} className="row" style={{ ...ROW, alignItems: "baseline", flexWrap: "nowrap" }}>
                                                                <Sev s={x.severity} />
                                                                <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{x.text}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <span style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>{c.reason}</span>
                                                )}
                                            </dd>
                                        </dl>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
            {noAccounts && (
                <p className="t-meta" style={{ margin: 0 }} data-testid="security-no-accounts">
                    Access control was not checked: add test accounts in <a href={routes.projectSettings(projectId, "accounts")}>Settings</a>.
                </p>
            )}
            {AREAS.map((a) => {
                const list = o.checks.filter((c) => c.area === a.id);
                if (!list.length) return null;
                return (
                    <section key={a.id} className="card card-pad stack-sm" aria-labelledby={`sec-${a.id}`} data-testid={`security-area-${a.id}`}>
                        <h3 className="t-card" id={`sec-${a.id}`}>
                            {a.title}
                        </h3>
                        <p className="t-meta" style={{ margin: 0 }}>
                            {a.what}
                        </p>
                        <ul className="divided" style={LIST}>
                            {list.map((c) => (
                                <li key={c.testId} className="stack-sm" style={{ padding: "8px 0" }} data-testid="security-check">
                                    <div className="row" style={ROW}>
                                        {name(c)}
                                        <Badge tone={RESULT[c.result].tone}>{RESULT[c.result].label}</Badge>
                                        {c.severity && <Sev s={c.severity} />}
                                    </div>
                                    {c.result === "could-not-check" && c.reason && (
                                        <span className="t-meta" style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>
                                            {c.reason}
                                        </span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
            {assessment}
        </div>
    );
}

function Outcome({ projectId }: { projectId: string }) {
    return <OutcomeBody projectId={projectId} />;
}

/** One run: what it checked and found, this agent's items only. */
function Run({ projectId, jobId }: { projectId: string; jobId: string }) {
    return (
        <div className="stack">
            <a href={routes.projectAgent(projectId, ID, "runs")} className="t-meta">
                <ArrowLeft size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
                All runs
            </a>
            <OutcomeBody projectId={projectId} run={jobId} />
        </div>
    );
}

/** Its inputs: the address it reads, and the test accounts its access checks use. */
function Setup({ projectId }: { projectId: string }) {
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    const roles = useFetch<{ roles: unknown[] }>(`/projects/${projectId}/roles`);
    if (inputs.loading) return <ListSkeleton rows={3} />;
    const d = inputs.data;
    if (!d) return <ErrorState error={{ title: "What this agent uses could not be loaded", body: inputs.error?.message ?? "" }} onRetry={() => void inputs.reload()} />;
    const n = roles.data?.roles.length ?? 0;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-setup">
            <p className="t-secondary">It only reads what the application sends: it never attacks, floods or changes anything.</p>
            <dl className="ws-inputs">
                <dt>Application address</dt>
                <dd>
                    {d.application?.url || "None yet"} · <a href={routes.projectSettings(projectId, "general")}>Settings → General</a>
                </dd>
                <dt>Test accounts</dt>
                <dd>
                    {n === 0 ? "None: the access checks are left out; the other checks still run" : `${n === 1 ? "1 account" : `${n} accounts`}, for the access checks`} · <a href={routes.projectSettings(projectId, "accounts")}>Settings → Sign-in</a>
                </dd>
            </dl>
        </section>
    );
}

export const view: AgentView = { Outcome, Run, Setup };
