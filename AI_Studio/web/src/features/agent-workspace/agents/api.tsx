import { Check, ChevronRight, Download, LoaderCircle, Minus, Network, Play, X } from "lucide-react";
import { Fragment, useState } from "react";
import { downloadFrom, type Job, type PhaseKey, type Severity } from "../../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, SeverityBadge } from "../../../components/ui";
import { useCan } from "../../auth/permissions";
import { useFetch, useOnFinish } from "../../../lib/hooks";
import { friendlyError, isActive, progressPercent, type Tone } from "../../../lib/labels";
import { routes } from "../../../lib/router";
import { StopRun } from "../../runs/StopDialog";
import { agentInputsHref, type AgentInputs } from "../../requirements/AgentInputs";
import { RelTime } from "../../runs/RunTime";
import type { AgentView } from "../registry";
import type { WorkspaceAgent } from "../workspace";
import { RunStatus } from "../RunStatus";
import "../../environments/environments.css";

const ID = "api";

type Contract = "matches" | "differs" | "not-checked";
type Result = "pass" | "fail" | "not-run";
interface ApiTestRow {
    testId: string;
    testKey: string;
    title: string;
    method: string;
    path: string;
    expectedStatus: string | null;
    contract: Contract;
    contractNote: string | null;
    result: Result;
    jobId: string;
    /** The statuses the run saw for this endpoint. */
    answered: number[];
    evidence: { request: { method: string; path: string; query: Record<string, string> | null; body: string | null }; response: { statuses: number[]; reason: string } } | null;
}

/** GET /api/projects/:id/workspace/api/outcome (src/platform/agent-outcomes/api.ts). */
interface ApiOutcome {
    runs: number;
    /** One run's report (?run=): which run, numbered as in the Runs list. */
    run?: { jobId: string; number: number; status: string; createdAt: string };
    headline: string;
    summary: { tests: number; passed: number; failed: number; notRun: number };
    tests: ApiTestRow[];
    findings: Array<{ id: string; testId: string; endpoint: string | null; title: string; stateLabel: string; severity: string | null; expected: string; observed: string; reproduced: { same: number; of: number } }>;
}

/** Against the OpenAPI document. */
const CONTRACT: Record<Contract, string> = { matches: "Contract matches", differs: "Contract differs", "not-checked": "Contract not checked" };
const RESULT: Record<Result, { label: string; tone: Tone }> = { pass: { label: "PASS", tone: "success" }, fail: { label: "FAIL", tone: "danger" }, "not-run": { label: "Not run", tone: "neutral" } };
const SEVERITIES: readonly string[] = ["critical", "high", "medium", "low"];

/** A failed test's evidence: what it sent and what came back. */
function Evidence({ e }: { e: NonNullable<ApiTestRow["evidence"]> }) {
    const query = e.request.query && Object.keys(e.request.query).length ? `?${new URLSearchParams(e.request.query).toString()}` : "";
    return (
        <dl className="ws-inputs" data-testid="api-evidence">
            <dt>Request</dt>
            <dd className="mono">
                {e.request.method} {e.request.path}
                {query}
            </dd>
            {e.request.body !== null && (
                <>
                    <dt>Request body</dt>
                    <dd>
                        <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.request.body}</pre>
                    </dd>
                </>
            )}
            <dt>Response</dt>
            <dd className="mono tnum">{e.response.statuses.length ? `HTTP ${e.response.statuses.join(", ")}` : "No answer recorded"}</dd>
            <dt>Why it failed</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{e.response.reason || "No reason was recorded."}</dd>
        </dl>
    );
}

/** What the test checks, without the endpoint its title starts with ("GET /x: succeeds with a valid request"). */
const what = (t: ApiTestRow) => (t.title.startsWith(`${t.method} ${t.path}: `) ? t.title.slice(t.method.length + t.path.length + 3) : t.title);

/** One row of the table, and below it, opened from its FAIL, what a failed test sent and got back. */
function TestRow({ t }: { t: ApiTestRow }) {
    const [open, setOpen] = useState(false);
    const r = RESULT[t.result];
    const evidenceId = `api-ev-${t.testId}`;
    return (
        <Fragment>
            <tr data-result={t.result}>
                <td className="mono">{t.method}</td>
                <td>
                    <span className="mono">{t.path}</span>
                    <div className="t-meta">{what(t)}</div>
                </td>
                <td style={{ overflowWrap: "normal" }}>
                    <span className="mono tnum">{t.expectedStatus ? `HTTP ${t.expectedStatus}` : "Any answer"}</span>
                    <div className="t-meta">{CONTRACT[t.contract]}</div>
                    {t.contractNote && <div className="t-meta">{t.contractNote}</div>}
                </td>
                <td className="nowrap">
                    {t.evidence ? (
                        <button type="button" className="row" style={{ gap: 4, background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", color: "inherit" }} aria-label={`${r.label}: ${open ? "hide" : "show"} the request and response`} aria-expanded={open} aria-controls={evidenceId} onClick={() => setOpen(!open)}>
                            <Badge tone={r.tone}>{r.label}</Badge>
                            <ChevronRight size={14} aria-hidden style={{ transform: open ? "rotate(90deg)" : undefined }} />
                        </button>
                    ) : (
                        <Badge tone={r.tone}>{r.label}</Badge>
                    )}
                </td>
            </tr>
            {t.evidence && (
                <tr id={evidenceId} hidden={!open}>
                    <td colSpan={4}>
                        <Evidence e={t.evidence} />
                        <p className="t-meta" style={{ margin: "8px 0 0" }}>
                            {t.testKey}: <a href={routes.test(t.testId)}>open the test</a>
                        </p>
                    </td>
                </tr>
            )}
        </Fragment>
    );
}

const answeredText = (s: number[]) => (s.length ? `HTTP ${s.join(", ")}` : "no answer recorded");

/** The report as a file (GET …/workspace/api/report, the same page as HTML or PDF), of one run or of every run; for who may export. */
function ReportDownload({ projectId, run }: { projectId: string; run?: string }) {
    const can = useCan();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"html" | "pdf" | null>(null);
    if (!can("ai_studio.reports.export")) return null;
    const get = async (format: "html" | "pdf") => {
        setError(null);
        setBusy(format);
        try {
            await downloadFrom(`/projects/${projectId}/workspace/${ID}/report?${run ? `run=${run}&` : ""}format=${format}`, `api-report.${format}`);
        } catch (e) {
            setError(friendlyError((e as Error).message).body ?? (e as Error).message);
        } finally {
            setBusy(null);
        }
    };
    return (
        <div className="stack-sm">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Button size="sm" icon={Download} loading={busy === "html"} onClick={() => void get("html")}>
                    Download report (web page)
                </Button>
                <Button size="sm" icon={Download} loading={busy === "pdf"} onClick={() => void get("pdf")}>
                    Download report (PDF)
                </Button>
            </div>
            {error && (
                <Callout tone="danger" title="The report could not be downloaded">
                    {error}
                </Callout>
            )}
        </div>
    );
}

/** The Workspace card's report: the latest finished run's counts and its failed endpoints (method, path, expected, actual), linking to that run. */
function Card({ projectId, agent }: { projectId: string; agent: WorkspaceAgent }) {
    const o = useFetch<ApiOutcome>(agent.runs ? `/projects/${projectId}/workspace/${ID}/outcome?run=latest` : null);
    useOnFinish(agent.status === "running", () => void o.reload());
    const r = o.data?.run;
    if (!o.data || !r)
        return agent.headline ? (
            <p className="ws-headline" data-testid="agent-headline">
                {agent.headline}
            </p>
        ) : null;
    const failed = o.data.tests.filter((t) => t.result === "fail");
    const MAX = 5;
    return (
        <div className="stack-sm" data-testid="api-latest-report">
            <p className="ws-headline" data-testid="agent-headline">
                {o.data.headline}
            </p>
            <p className="t-meta" style={{ margin: 0 }}>
                Latest report: Run {r.number}, started <RelTime iso={r.createdAt} />
            </p>
            {failed.length > 0 && (
                <ul className="ws-needs" data-testid="api-failed" aria-label="Failed endpoints">
                    {failed.slice(0, MAX).map((t) => (
                        <li key={t.testId}>
                            <span className="mono" style={{ color: "var(--text-primary)", overflowWrap: "anywhere" }}>
                                {t.method} {t.path}
                            </span>
                            <span style={{ display: "block" }}>
                                Expected {t.expectedStatus ? `HTTP ${t.expectedStatus}` : "any answer"} · Got {answeredText(t.answered)}
                                {t.contractNote ? `: ${t.contractNote}` : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {failed.length > MAX && <p className="t-meta" style={{ margin: 0 }}>and {failed.length - MAX} more failed</p>}
            <a href={routes.projectAgentRun(projectId, ID, r.jobId)}>Open the full report</a>
        </div>
    );
}

/** The API tests (PASS or FAIL) and the verified findings, of every run or of one. */
function Body({ projectId, run, active }: { projectId: string; run?: string; active: boolean }) {
    const o = useFetch<ApiOutcome>(`/projects/${projectId}/workspace/${ID}/outcome${run ? `?run=${run}` : ""}`, () => (active ? 3000 : null));
    useOnFinish(active, () => void o.reload());
    if (!o.data && !o.error) return <ListSkeleton rows={4} />;
    if (!o.data) return <ErrorState error={friendlyError(o.error?.message)} onRetry={() => void o.reload()} />;
    const { tests, findings } = o.data;
    if (!o.data.runs)
        return (
            <div className="card">
                <EmptyState icon={Network} title="No API tests yet" actions={<LinkButton href={routes.newProject({ project: projectId, agent: ID })} variant="primary" icon={Play}>Run the agent</LinkButton>}>
                    Each run tests the API from its OpenAPI document and the calls found earlier, and says PASS or FAIL for each test.
                </EmptyState>
            </div>
        );
    return (
        <div className="stack" data-testid="api-outcome">
            <section className="stack-sm">
                <div className="section-head">
                    <h3 className="t-section">API tests</h3>
                    <span className="ws-headline" data-testid="api-headline">{o.data.headline}</span>
                </div>
                <p className="t-meta" style={{ margin: 0 }}>Contract: whether the answer matches the OpenAPI document. Open a FAIL to see the request and the response.</p>
                <ReportDownload projectId={projectId} run={run} />
                {tests.length ? (
                    <div className="data-table-wrap" role="region" aria-label="API tests" tabIndex={0}>
                        <table className="data-table" data-testid="api-tests">
                            <thead>
                                <tr>
                                    <th scope="col" className="nowrap">Method</th>
                                    <th scope="col">Path</th>
                                    <th scope="col">Expected</th>
                                    <th scope="col">Result</th>
                                </tr>
                            </thead>
                            <tbody>
                                {tests.map((t) => (
                                    <TestRow key={t.testId} t={t} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="t-secondary">No API test was made in {run ? "this run" : "its runs"}.</p>
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

const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;
/** The API run's own steps; the exploration's other stages (pages, journeys, test ideas) are not part of it. */
const STEPS: Array<{ phase: PhaseKey; title: string; detail: (c: Job["counters"]) => string | undefined }> = [
    { phase: "discovery", title: "Finding the app's API calls", detail: (c) => (c.apisDiscovered ? `${n(c.apisDiscovered, "API endpoint")} found` : undefined) },
    { phase: "generation", title: "Writing the API tests", detail: (c) => (c.testsGenerated ? n(c.testsGenerated, "API test") : undefined) },
    { phase: "validation", title: "Running the API tests", detail: (c) => (c.testsGenerated && c.testsValidated ? `${c.testsValidated} of ${c.testsGenerated} passed` : undefined) },
];

/** A going API run: its API steps only, one bar, and Stop (no page list, browser view or test ideas). */
function ApiProgress({ job, onChanged }: { job: Job; onChanged: () => void }) {
    const pct = progressPercent(job);
    return (
        <section className="card card-pad stack" data-testid="api-progress">
            <h2 className="t-section">Testing the API</h2>
            <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="API run progress">
                <span style={{ width: `${pct}%` }} />
            </div>
            <ol className="steps">
                {STEPS.map((s) => {
                    const state = job.progress[s.phase];
                    const detail = state === "skipped" ? undefined : s.detail(job.counters);
                    return (
                        <li key={s.phase} className={`step ${state}`}>
                            <span className="mark" aria-hidden>
                                {state === "done" ? <Check size={14} /> : state === "running" ? <LoaderCircle size={14} className="spin" /> : state === "failed" ? <X size={14} /> : state === "skipped" ? <Minus size={14} /> : null}
                            </span>
                            <span className="what">
                                <span className="name">{s.title}</span>
                                {detail && <span className="t-meta" style={{ display: "block" }}>{detail}</span>}
                                <span className="sr-only">{state}</span>
                            </span>
                        </li>
                    );
                })}
            </ol>
            <div>
                <StopRun job={job} onRequested={onChanged} />
            </div>
        </section>
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
            {job && active && <ApiProgress job={job} onChanged={() => void runs.reload()} />}
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
            {isActive(job.status) && <ApiProgress job={job} onChanged={() => void runs.reload()} />}
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

export const view: AgentView = { Outcome, Run, Setup, Card };
