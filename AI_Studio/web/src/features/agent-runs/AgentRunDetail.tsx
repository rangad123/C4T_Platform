import { Ban, Check, ChevronLeft, CircleAlert, CircleCheck, CircleSlash, FilePlus2, FileText, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, artifactUrl, type ProjectDetail } from "../../api";
import { Badge, Button, Callout, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { apiMessage } from "../manual/manual";
import { APPROVAL_WORDS, CATEGORY_WORDS, isActive, runBadge, type AgentApproval, type AgentRunDetail as Detail, type AgentRunStep } from "./agent-runs";

/** One agent run: while it goes, the latest picture, its steps, Stop and any approval it waits for; afterwards, the result. */
export function AgentRunDetail({ projectId, runId }: { projectId: string; runId: string }) {
    const run = useFetch<Detail>(`/projects/${projectId}/agent-runs/${runId}`, (d) => (d && !isActive(d) ? null : 1500));
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const access = project.data?.access?.permissions;
    const canRun = !access || access.includes("ai_studio.agent.run");
    const canWrite = !access || access.includes("ai_studio.tests.write");
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");

    const send = async (name: string, path: string, body?: unknown) => {
        setBusy(name);
        setError("");
        try {
            await api(`/projects/${projectId}/agent-runs/${runId}${path}`, { method: "POST", ...(body ? { body } : {}) });
            await run.reload();
        } catch (e) {
            setError(apiMessage(e));
        } finally {
            setBusy("");
        }
    };

    const d = run.data;
    if (run.loading) return <ListSkeleton rows={4} />;
    if (!d) return <ErrorState error={friendlyError(run.error?.message)} onRetry={run.reload} />;
    const badge = runBadge(d);
    const active = isActive(d);
    const pending = d.approvals.find((a) => a.state === "pending");
    const pictured = [...d.steps].reverse().find((s) => s.screenshotId);
    const tokens = d.inputTokens !== undefined && d.outputTokens !== undefined ? d.inputTokens + d.outputTokens : undefined;

    return (
        <div className="stack">
            <a className="agent-back" href={routes.agentRuns(projectId)}>
                <ChevronLeft size={16} aria-hidden /> All agent runs
            </a>
            <section className="card card-pad stack-sm" aria-label="This run">
                <div className="row wrap">
                    <h2 className="t-section agent-objective">{d.objective}</h2>
                    <span className="spacer" />
                    <Badge tone={badge.tone} tip={badge.help}>
                        {badge.label}
                    </Badge>
                    {active && canRun && (
                        <Button size="sm" icon={Square} loading={busy === "stop"} onClick={() => void send("stop", "/stop")} tip="Stops the agent at its next step. What it did so far is kept.">
                            Stop
                        </Button>
                    )}
                </div>
                {d.successCriteria && <p className="agent-pre t-secondary">Success criteria: {d.successCriteria}</p>}
                <p className="t-secondary">
                    Started by {d.startedBy.name} {relativeTime(d.createdAt)}, on {d.environment ? `“${d.environment}”` : d.startAddress}. {plural(d.stepsTaken, "step")} of at most {d.limits.maxSteps}, at most {plural(d.limits.maxMinutes, "minute")}.
                </p>
            </section>

            {error && (
                <Callout tone="danger" title="That did not work">
                    {error}
                </Callout>
            )}
            {pending && <ApprovalPrompt approval={pending} canAnswer={canRun && d.canApprove !== false} busy={busy} onAnswer={(approve) => void send(approve ? "approve" : "refuse", `/approvals/${pending.id}`, { approve })} />}
            {!active && <Result run={d} tokens={tokens} canWrite={canWrite} busy={busy === "draft"} onDraft={() => void send("draft", "/draft", {})} />}

            {active && pictured?.screenshotId && (
                <section className="card card-pad stack-sm" aria-label="What the agent sees">
                    <h2 className="t-section">What the agent sees</h2>
                    <img className="agent-shot" src={artifactUrl(pictured.screenshotId)} alt={`The page after step ${pictured.seq}: ${pictured.summary}`} />
                </section>
            )}

            <section className="card" aria-labelledby="agent-steps-title">
                <div className="card-head">
                    <h2 className="t-section" id="agent-steps-title">
                        Steps
                    </h2>
                </div>
                {d.steps.length === 0 ? (
                    <p className="card-pad t-secondary">{d.state === "queued" ? "Waiting for the worker to pick this run up." : "No steps yet."}</p>
                ) : (
                    <ol className="list divided agent-steps">
                        {d.steps.map((s) => (
                            <StepRow key={s.seq} step={s} />
                        ))}
                    </ol>
                )}
            </section>

            {d.approvals.some((a) => a.state !== "pending") && (
                <section className="card card-pad stack-sm" aria-label="Approvals">
                    <h2 className="t-section">Approvals</h2>
                    <ul className="agent-approvals">
                        {d.approvals
                            .filter((a) => a.state !== "pending")
                            .map((a) => (
                                <li key={a.id}>
                                    {a.action}: {APPROVAL_WORDS[a.state]}
                                    {a.decidedBy ? ` by ${a.decidedBy}` : ""}
                                </li>
                            ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

/** The run waits here. What the action says comes from the page, so it is shown as text and the person decides. */
function ApprovalPrompt({ approval, canAnswer, busy, onAnswer }: { approval: AgentApproval; canAnswer: boolean; busy: string; onAnswer: (approve: boolean) => void }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = window.setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, []);
    const left = Math.max(0, Math.round((Date.parse(approval.expiresAt) - Date.now()) / 1000));
    // What the agent said it does, and what the page really shows there (set by the server).
    const [said, onPage] = approval.action.split(" | On the page: ");
    return (
        <section aria-live="polite" data-testid="agent-approval">
            <Callout
                tone="warning"
                title="The agent is waiting for your approval"
                actions={
                    canAnswer ? (
                        <>
                            <Button variant="primary" size="sm" icon={Check} loading={busy === "approve"} onClick={() => onAnswer(true)}>
                                Approve
                            </Button>
                            <Button size="sm" icon={X} loading={busy === "refuse"} onClick={() => onAnswer(false)}>
                                Refuse
                            </Button>
                        </>
                    ) : undefined
                }
            >
                <p>
                    <strong>{said}</strong>
                </p>
                {onPage && <p data-testid="agent-approval-element">On the page: {onPage}</p>}
                <p>
                    {approval.why} On {approval.url || "this page"}. Without an answer in {plural(left, "second")} the run stops and the action is not done. A run waits at most 10 minutes for an answer.
                    {!canAnswer && " Answering needs a Project Admin of this project who may approve tests."}
                </p>
            </Callout>
        </section>
    );
}

function Result({ run, tokens, canWrite, busy, onDraft }: { run: Detail; tokens: number | undefined; canWrite: boolean; busy: boolean; onDraft: () => void }) {
    const badge = runBadge(run);
    const canDraft = run.steps.some((s) => s.tool === "assert" && s.status === "done");
    return (
        <section className="card card-pad stack-sm" aria-label="Result">
            <div className="row wrap">
                <h2 className="t-section">Result: {badge.label}</h2>
                <span className="spacer" />
                {run.draftTestId ? (
                    <LinkButton size="sm" icon={FileText} href={routes.test(run.draftTestId)}>
                        Open the draft test
                    </LinkButton>
                ) : (
                    canWrite && (
                        <Button size="sm" icon={FilePlus2} loading={busy} disabled={!canDraft} onClick={onDraft} tip={canDraft ? "Makes a draft test from the steps that worked. It goes through review like any draft." : "This run checked nothing that passed, so a test made from it would verify nothing."}>
                            Turn into a draft test
                        </Button>
                    )
                )}
            </div>
            {badge.help && <p className="t-secondary">{badge.help}</p>}
            {run.stopReason && <p>{run.stopReason}</p>}
            {run.failureCategory && <p>Where the trouble seems to lie: {CATEGORY_WORDS[run.failureCategory]}.</p>}
            {run.reasoning && (
                <div className="agent-reasoning">
                    <p className="agent-label">
                        <Badge tone="neutral">AI suggestion</Badge> The agent's reasoning. Nobody has confirmed it.
                    </p>
                    <p className="agent-pre">{run.reasoning}</p>
                </div>
            )}
            {tokens !== undefined && <p className="t-secondary">AI usage: {tokens.toLocaleString()} tokens.</p>}
        </section>
    );
}

const STEP_ICON = { done: CircleCheck, failed: CircleAlert, refused: Ban } as const;
const STEP_WORD = { done: "Done", failed: "Failed", refused: "Not done" } as const;

function StepRow({ step: s }: { step: AgentRunStep }) {
    const Icon = STEP_ICON[s.status] ?? CircleSlash;
    return (
        <li className={`agent-step agent-step-${s.status}`}>
            <span className="agent-step-no">{s.seq}</span>
            <Icon size={16} aria-hidden />
            <span className="main">
                <span className="title">{s.summary}</span>
                <span className="meta">
                    {STEP_WORD[s.status]}
                    {s.url ? `, on ${s.url}` : ""}
                </span>
                {s.detail && <span className="meta agent-pre">{s.detail}</span>}
            </span>
            {s.screenshotId && (
                <a href={artifactUrl(s.screenshotId)} target="_blank" rel="noreferrer" aria-label={`Open the picture of step ${s.seq}`}>
                    <img className="agent-thumb" src={artifactUrl(s.screenshotId)} alt="" loading="lazy" />
                </a>
            )}
        </li>
    );
}
