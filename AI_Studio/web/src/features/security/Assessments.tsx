import { Check, ChevronRight, FileText, Play, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, Metric, Skeleton } from "../../components/ui";
import { BadgeKey, HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { help } from "../../lib/help";
import { friendlyError, describeApiError } from "../../lib/labels";
import { duration, relativeTime } from "../../lib/format";
import { go, routes, useRoute } from "../../lib/router";
import { isRunnerRefusal, refusalLink, useReadiness } from "../runners/my-runner";
import { AuthTag, SecurityLayout, StateTag, canRun, stateKey, useRole } from "./SecurityChrome";
import { AUTH_WORDS, SEC, STATE_WORDS, STEPS, authStateOf, isRunning, listOf, oneOf, sec, useApps, useAssessments, useSecurityStatus, when, type AppRow, type AssessmentRow, type AssessmentState, type SecurityAssessment, type SecurityAuthorization } from "./security";

// ── new assessment ───────────────────────────────────────────────────────────

const DOES = [
    "Opens the application like an ordinary visitor’s browser and follows links within the authorized scope.",
    "Reads the answers it gets: security headers, cookie settings, the HTTPS certificate, cross-site access answers to ordinary requests, version banners.",
    "Asks for a short list of well-known files that should not be public (for example .env) and notes directory listings.",
    "Notes pages, forms (field names and types only) and API calls it sees, and says plainly what it could not inspect.",
];
/** Runners mode (round 52): where the assessment runs, before the click. */
export const assessesOnRunner = (name: string): string => `Runs on your runner, ${name}. Its browser and every check are sent from that computer, never from the platform.`;

const DOES_NOT = [
    "Never submits forms, signs in, or clicks anything that changes data.",
    "Never sends attack payloads, guesses passwords or tries to break in.",
    "Never requests addresses outside the scope or excluded paths. Private network addresses only where they are allowed (your runner’s setting, or this server’s), and never cloud metadata addresses.",
    "Never uses an AI model on the application.",
];

export function NewAssessmentPage({ id }: { id: string }) {
    const role = useRole();
    const query = useRoute().query;
    const status = useSecurityStatus();
    const apps = useApps(id);
    const [appId, setAppId] = useState(query.get("app") ?? "");
    const retestOf = query.get("retest") ?? undefined;
    const chosen = apps.list.find((a) => a.id === appId) ?? (apps.list.length === 1 ? apps.list[0] : undefined);
    const auths = useFetch<unknown>(chosen ? `${SEC}/applications/${chosen.id}/authorizations` : null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [problemLink, setProblemLink] = useState<string | null>(null);
    // Round 52: on a platform that runs tests only on runners, the assessment runs on the person's runner (a start is refused without one).
    const ready = useReadiness({ can: ["assessment"] });
    const runnerBlocks = ready.mode === "runners" && !ready.ready;
    const auth = chosen ? authStateOf(chosen, listOf<SecurityAuthorization>(auths.data, "authorizations")) : "none";
    const limits = status?.limits ?? {};
    const cap = typeof limits.maxRequestsPerAssessment === "number" ? limits.maxRequestsPerAssessment : typeof limits.requestCap === "number" ? limits.requestCap : undefined;
    const minutes = typeof limits.assessmentMinutes === "number" ? limits.assessmentMinutes : undefined;

    async function start() {
        if (!chosen) return;
        setBusy(true);
        setProblem("");
        setProblemLink(null);
        try {
            const answer = await api<unknown>(`${SEC}/applications/${chosen.id}/assessments`, { method: "POST", body: retestOf ? { retestOf } : {} });
            go(sec.assessment(id, oneOf<SecurityAssessment>(answer, "assessment")!.id));
        } catch (e) {
            setProblem(describeApiError(e));
            setProblemLink(refusalLink(e));
            if (isRunnerRefusal(e)) void ready.reload();
            setBusy(false);
        }
    }

    const content = () => {
        if (apps.loading) return <ListSkeleton rows={2} />;
        if (apps.error) return <ErrorState error={friendlyError(apps.error.message)} onRetry={apps.reload} />;
        if (!apps.list.length)
            return (
                <div className="card">
                    <EmptyState icon={ShieldCheck} title="No applications yet" actions={canRun(role) ? <LinkButton href={sec.newApplication(id)} variant="primary">Add an application</LinkButton> : null}>
                        No assessments yet. Add an application and run your first passive assessment.
                    </EmptyState>
                </div>
            );
        return (
            <div className="stack" style={{ maxWidth: 900 }}>
                {retestOf && (
                    <Callout tone="info" title="This is a retest">
                        It re-checks only the locations of the earlier assessment’s open findings. Findings it no longer sees are marked fixed; ones it sees again keep their state.
                    </Callout>
                )}
                <div className="card card-pad stack-sm">
                    <div className="field">
                        <label htmlFor="na-app">Application</label>
                        <select id="na-app" className="input" value={chosen?.id ?? ""} onChange={(e) => setAppId(e.target.value)} disabled={!!retestOf}>
                            {!chosen && <option value="">Choose an application</option>}
                            {apps.list.map((a) => (
                                <option key={a.id} value={a.id}>
                                    {a.name}, {a.targetUrl}
                                </option>
                            ))}
                        </select>
                    </div>
                    {chosen && (
                        <dl className="kv" data-testid="na-limits">
                            <dt>Target</dt>
                            <dd className="sec-loc">{chosen.targetUrl}</dd>
                            <dt>Also in scope</dt>
                            <dd>{chosen.scope.length ? chosen.scope.join(", ") : "Only the target’s own origin"}</dd>
                            <dt>Never requested</dt>
                            <dd>{chosen.excludedPaths.length ? chosen.excludedPaths.join(", ") : "No exclusions"}</dd>
                            <dt>Request limit</dt>
                            <dd>
                                At most {chosen.maxRequestsPerSecond} per second{cap ? `, ${cap} in all` : ""}
                                {minutes ? `, stops after ${minutes} minutes` : ""}
                                {(cap || minutes) && <HelpTip label="Request limit" text="The rate is the application’s own setting. The total and the time limit are platform settings (SECURITY_MAX_REQUESTS, SECURITY_ASSESSMENT_MINUTES) that apply to every assessment." />}
                            </dd>
                            <dt>Authorization</dt>
                            <dd>{auths.loading ? "Checking…" : <AuthTag state={auth} tipFocusable />}</dd>
                        </dl>
                    )}
                </div>
                <div className="sec-does">
                    <section className="card card-pad stack-sm" aria-labelledby="na-does">
                        <h2 className="t-card" id="na-does">
                            What the passive assessment does
                        </h2>
                        <ul className="bullets">
                            {DOES.map((d) => (
                                <li key={d}>{d}</li>
                            ))}
                        </ul>
                    </section>
                    <section className="card card-pad stack-sm" aria-labelledby="na-not">
                        <h2 className="t-card" id="na-not">
                            What it does not do
                        </h2>
                        <ul className="bullets">
                            {DOES_NOT.map((d) => (
                                <li key={d}>{d}</li>
                            ))}
                        </ul>
                    </section>
                </div>
                {chosen && !auths.loading && auth !== "current" && (
                    <Callout tone="warning" title={AUTH_WORDS[auth].label} actions={<LinkButton size="sm" href={sec.application(id, chosen.id, { authorize: true })}>Open the authorization</LinkButton>}>
                        {AUTH_WORDS[auth].text}
                    </Callout>
                )}
                {ready.mode === "runners" && !ready.loading && (ready.reason ? (
                    <Callout tone="warning" title="Your runner can’t take this assessment" actions={ready.runnerReason ? <LinkButton size="sm" href={routes.yourRunner}>Open Your runner in Settings</LinkButton> : undefined}>
                        {ready.reason}
                    </Callout>
                ) : ready.runner ? (
                    <p className="hint" data-testid="na-runner">{assessesOnRunner(ready.runner.name)}</p>
                ) : null)}
                {problem && (
                    <Callout tone="danger" title="The assessment did not start" actions={problemLink ? <LinkButton size="sm" href={problemLink}>Open Your runner in Settings</LinkButton> : undefined}>
                        {problem}
                    </Callout>
                )}
                <div className="row">
                    <Button variant="primary" size="lg" icon={Play} loading={busy} disabled={!chosen || auth !== "current" || !canRun(role) || runnerBlocks} onClick={() => void start()}>
                        {retestOf ? "Start retest" : "Start assessment"}
                    </Button>
                    {!canRun(role) && <span className="hint">Editors and owners can start assessments.</span>}
                    {canRun(role) && <span className="hint">You can stop it at any time; what was found until then is kept.</span>}
                </div>
            </div>
        );
    };
    return (
        <SecurityLayout id={id} active="new" title={retestOf ? "Retest" : "New assessment"} subtitle="A passive, read-only look at an authorized application.">
            {content()}
        </SecurityLayout>
    );
}

// ── history ──────────────────────────────────────────────────────────────────

export function AssessmentsPage({ id }: { id: string }) {
    const role = useRole();
    const list = useAssessments(id, true);
    const apps = useApps(id);
    const appName = (a: AssessmentRow) => a.applicationName ?? apps.list.find((x) => x.id === a.applicationId)?.name ?? "Application";
    const rows = [...list.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return (
        <SecurityLayout
            id={id}
            active="assessments"
            title="Assessments"
            subtitle={
                <>
                    Every assessment of this project, newest first. <BadgeKey label="the assessment states" entries={stateKey(rows.map((a) => a.state))} />
                </>
            }
        >
            {list.loading ? (
                <ListSkeleton rows={4} />
            ) : list.error ? (
                <ErrorState error={friendlyError(list.error.message)} onRetry={list.reload} />
            ) : rows.length === 0 ? (
                <div className="card">
                    <EmptyState icon={ShieldCheck} title="No assessments yet" actions={canRun(role) ? <LinkButton href={sec.newAssessment(id)} variant="primary" icon={Play}>New assessment</LinkButton> : null}>
                        No assessments yet. Add an application and run your first passive assessment.
                    </EmptyState>
                </div>
            ) : (
                <ul className="card list divided" data-testid="sec-assessments">
                    {rows.map((a) => (
                        <li key={a.id}>
                            <a className="list-row" href={sec.assessment(id, a.id)}>
                                <span className="main">
                                    <span className="title">
                                        {appName(a)}
                                        {a.retestOf ? ", retest" : ""}
                                    </span>
                                    <span className="meta sec-list-cols">
                                        <span>Started {when(a.startedAt ?? a.createdAt)}</span>
                                        {a.finishedAt && <span>took {duration(Date.parse(a.finishedAt) - Date.parse(a.startedAt ?? a.createdAt))}</span>}
                                        <span>by {a.startedBy}</span>
                                        {isRunning(a.state) && a.progressText && <span>{a.progressText}</span>}
                                    </span>
                                </span>
                                <span className="tail">
                                    <StateTag state={a.state} />
                                </span>
                                <ChevronRight size={18} className="chev" aria-hidden />
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </SecurityLayout>
    );
}

// ── one assessment: progress, cancel, coverage ───────────────────────────────

const stepIndex = (s: AssessmentState) => STEPS.findIndex((x) => x.state === s);

export function AssessmentDetail({ id, aid }: { id: string; aid: string }) {
    const role = useRole();
    const a = useFetch<unknown>(`${SEC}/assessments/${aid}`, (d) => { const s = oneOf<AssessmentRow>(d, "assessment"); return s && !isRunning(s.state) ? null : 2000; });
    const x = a.data ? oneOf<AssessmentRow>(a.data, "assessment") : undefined;
    const appAnswer = useFetch<unknown>(x ? `${SEC}/applications/${x.applicationId}` : null);
    const appData = appAnswer.data ? oneOf<AppRow>(appAnswer.data, "application") : undefined;
    const running = isRunning(x?.state);
    const content = () => {
        if (a.loading) return <Skeleton h={220} style={{ borderRadius: 12 }} />;
        if (a.error || !x) return <ErrorState error={friendlyError(a.error?.message ?? "Assessment not found")} onRetry={a.reload} />;
        const at = stepIndex(x.state);
        const finished = !running;
        const cov = x.coverage;
        return (
            <div className="stack">
                {running && (
                    <section className="card card-pad stack-sm" aria-labelledby="as-progress" data-testid="sec-progress">
                        <div className="row">
                            <h2 className="t-section" id="as-progress" style={{ flex: 1 }}>
                                {STATE_WORDS[x.state].label}
                            </h2>
                            <span className="t-meta">{x.progress}%</span>
                        </div>
                        <div className="bar" role="progressbar" aria-label="Assessment progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={x.progress}>
                            <span style={{ width: `${Math.max(2, Math.min(100, x.progress))}%` }} />
                        </div>
                        <p className="t-secondary" role="status" aria-live="polite">
                            {x.progressText || STATE_WORDS[x.state].help}
                        </p>
                        <ol className="steps sec-steps">
                            {STEPS.map((s, i) => {
                                const st = x.state === "QUEUED" ? "pending" : i < at ? "done" : i === at ? "running" : "pending";
                                return (
                                    <li key={s.state} className={`step ${st}`}>
                                        <span className="mark">{st === "done" ? <Check size={14} aria-hidden /> : <span aria-hidden>{i + 1}</span>}</span>
                                        <span className="what">
                                            <span className="name">{s.label}</span>
                                            <span className="sr-only">{st === "done" ? ", done" : st === "running" ? ", now" : ", waiting"}</span>
                                        </span>
                                    </li>
                                );
                            })}
                        </ol>
                    </section>
                )}
                {finished && <Outcome a={x} />}
                {cov && (
                    <section className="card" aria-labelledby="as-cov" data-testid="sec-coverage">
                        <div className="card-head">
                            <h2 className="t-section" id="as-cov">
                                What was looked at
                            </h2>
                        </div>
                        <div className="metrics">
                            <Metric value={cov.pagesSeen} label="Pages" tip={help("metric", "pagesSeen")} />
                            <Metric value={cov.formsSeen} label="Forms (not submitted)" tip={help("metric", "formsSeen")} />
                            <Metric value={cov.apiCallsSeen} label="API calls seen" tip={help("metric", "apiCallsSeen")} />
                            <Metric value={cov.notInspected.length} label="Not inspected" tone={cov.notInspected.length ? "warn" : undefined} tip={help("metric", "notInspected")} />
                        </div>
                        {cov.notInspected.length > 0 && (
                            <div className="section stack-sm" style={{ borderTop: "1px solid var(--border-default)" }}>
                                <h3 className="t-card">Not inspected</h3>
                                <ul className="bullets">
                                    {cov.notInspected.map((n) => (
                                        <li key={n}>{n}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </section>
                )}
                <section className="card card-pad" aria-labelledby="as-facts">
                    <h2 className="t-section" id="as-facts" style={{ marginBottom: 12 }}>
                        Details
                    </h2>
                    <dl className="kv">
                        <dt>Application</dt>
                        <dd>{appData ? <a href={sec.application(id, appData.id)}>{appData.name}</a> : x.applicationName ?? "…"}</dd>
                        <dt>Kind</dt>
                        <dd>{x.retestOf ? <>Retest of <a href={sec.assessment(id, x.retestOf)}>an earlier assessment</a></> : "Passive assessment"}</dd>
                        <dt>Started by</dt>
                        <dd>{x.startedBy}</dd>
                        <dt>Queued</dt>
                        <dd>{when(x.createdAt)}</dd>
                        {x.startedAt && (
                            <>
                                <dt>Started</dt>
                                <dd>{when(x.startedAt)}</dd>
                            </>
                        )}
                        {x.finishedAt && (
                            <>
                                <dt>Finished</dt>
                                <dd>
                                    {when(x.finishedAt)} ({relativeTime(x.finishedAt)})
                                </dd>
                            </>
                        )}
                    </dl>
                </section>
            </div>
        );
    };
    return (
        <SecurityLayout
            id={id}
            active="assessments"
            title={x?.retestOf ? "Retest" : "Assessment"}
            subtitle={x ? <StateTag state={x.state} tipFocusable /> : undefined}
            crumb={[{ label: "Assessments", href: sec.assessments(id) }, { label: x ? when(x.createdAt) : "…" }]}
            actions={
                x ? (
                    running ? (
                        canRun(role) && <CancelAssessment aid={x.id} onDone={() => void a.reload()} />
                    ) : (
                        <>
                            <LinkButton href={sec.findings(id, { application: x.applicationId })}>See findings</LinkButton>
                            <LinkButton href={sec.reports(id, x.id)} icon={FileText}>
                                Report
                            </LinkButton>
                            {canRun(role) && (x.state === "COMPLETED" || x.state === "PARTIALLY_COMPLETED") && (
                                <LinkButton href={sec.newAssessment(id, x.applicationId, x.id)} icon={RotateCcw} tip="Re-checks only the locations of this assessment’s open findings. Findings it no longer sees are marked fixed, if it finishes checking every location.">
                                    Retest
                                </LinkButton>
                            )}
                        </>
                    )
                ) : null
            }
        >
            {content()}
        </SecurityLayout>
    );
}

function Outcome({ a }: { a: SecurityAssessment }) {
    const w = STATE_WORDS[a.state];
    const body =
        a.state === "COMPLETED"
            ? "Every step finished. The coverage below says what was looked at and what could not be."
            : a.state === "PARTIALLY_COMPLETED"
              ? `Some steps did not finish${a.error ? `: ${a.error}` : "."} What was found is kept; the coverage says what was not inspected.`
              : a.state === "CANCELLED"
                ? "It was stopped before the end. What it found until then is kept, and it sent no more requests."
                : a.error ?? "It stopped with a problem.";
    return (
        <Callout tone={w.tone} title={w.label}>
            {body}
        </Callout>
    );
}

function CancelAssessment({ aid, onDone }: { aid: string; onDone: () => void }) {
    const [asking, setAsking] = useState(false);
    const [requested, setRequested] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function cancel() {
        setBusy(true);
        setError("");
        try {
            await api(`${SEC}/assessments/${aid}/cancel`, { method: "POST" });
            setAsking(false);
            setRequested(true);
            onDone();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <Button icon={X} loading={requested} disabled={requested} onClick={() => setAsking(true)} tip={requested ? undefined : "Asks first. It then stops within seconds and sends no more requests; what it found is kept."}>
                {requested ? "Stopping…" : "Stop assessment"}
            </Button>
            {asking && (
                <Modal
                    title="Stop this assessment?"
                    titleId="as-cancel-title"
                    onClose={() => setAsking(false)}
                    foot={
                        <>
                            <Button onClick={() => setAsking(false)}>Keep running</Button>
                            <Button variant="danger" icon={X} loading={busy} onClick={() => void cancel()}>
                                Stop assessment
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">It stops within seconds and sends no more requests. What it found until now is kept.</p>
                    {error && <Callout tone="danger">{error}</Callout>}
                </Modal>
            )}
        </>
    );
}
