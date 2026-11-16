import { useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { api, ApiError } from "../../api";
import { Badge, Button, Callout, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";
import { EVIDENCE_GONE, isStated, RULE_SOURCE_WORDS, rewordedLine, UNCONFIRMED_WORKFLOW, useLatestModel, workflowUsable, type Evidence, type Rule, type RuleStatus, type Workflow } from "./understanding";
import "./understanding.css";

const DECIDED: Record<Exclude<RuleStatus, "unverified">, string> = { confirmed: "Confirmed", rejected: "Rejected" };
const workflowAnchor = (id: string) => `workflow-${id.replace(/[^\w-]/g, "_")}`;

/**
 * "Rules to confirm" on the Requirements tab of a project tested by the AI agent: the business rules found that no person has confirmed
 * yet, each with where it came from, how sure we are and the lines it rests on, plus any rule whose evidence a later reading no longer
 * found; and the workflows that were only inferred, which tests follow once a person confirms them. People who may only look see both
 * without the buttons.
 */
export function RulesToConfirm({ projectId }: { projectId: string }) {
    const rules = useFetch<{ rules: Rule[] }>(`/projects/${projectId}/intel/rules`);
    const latest = useLatestModel(projectId);
    const canWrite = useHere(projectId).may("ai_studio.tests.write");
    const all = rules.data?.rules ?? [];
    // Waiting rules, and decided ones a person should look at again: evidence gone, or reworded since the decision.
    const shown = all.filter((r) => r.status === "unverified" || r.evidenceGone || rewordedLine(r));
    const allWorkflows = latest.data?.model.workflows ?? [];
    const workflows = new Map(allWorkflows.map((w) => [w.id, w]));
    // Inferred workflows nobody decided yet, and decided ones renamed since.
    const toConfirm = allWorkflows.filter((w) => !isStated(w.sourceType) && (!w.decision || w.rewordedName));

    if (rules.loading || latest.loading) return <ListSkeleton rows={2} />;
    if (!rules.error && all.length === 0 && toConfirm.length === 0) return null;
    return (
        <section aria-labelledby="rules-to-confirm-title" className="stack-sm" data-testid="rules-to-confirm">
            <div className="section-head">
                <h2 className="t-section" id="rules-to-confirm-title">
                    Rules to confirm
                </h2>
                {!rules.error && <span className="t-meta">{shown.length === 0 ? "Nothing waiting" : plural(shown.length, "rule")}</span>}
            </div>
            <p className="t-secondary">What we found the application should do. Tests treat a rule as expected behaviour once a source states it or a person confirms it.</p>
            {rules.error ? (
                <Callout tone="warning" title="The rules could not be loaded" actions={<Button size="sm" onClick={() => void rules.reload()}>Try again</Button>}>
                    {describeApiError(rules.error)}
                </Callout>
            ) : shown.length === 0 ? (
                <p className="t-secondary">Every rule found so far has been confirmed or rejected.</p>
            ) : (
                <ul className="card list divided" aria-label="Rules to confirm">
                    {shown.map((r) => (
                        <li key={r.id} className="card-pad">
                            <RuleRow projectId={projectId} rule={r} workflows={workflows} canWrite={canWrite} onDecided={rules.reload} />
                        </li>
                    ))}
                </ul>
            )}
            {toConfirm.length > 0 && (
                <div className="understanding-group" data-testid="workflows-to-confirm">
                    <h3 className="t-card" id="workflows-to-confirm-title">
                        Workflows to confirm
                    </h3>
                    <p className="t-secondary">Ways through the application we worked out ourselves. Tests follow a workflow once a person confirms it.</p>
                    <ul className="card list divided" aria-labelledby="workflows-to-confirm-title">
                        {toConfirm.map((w) => (
                            <li key={w.id} className="card-pad">
                                <WorkflowRow projectId={projectId} workflow={w} canWrite={canWrite} onDecided={latest.reload} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}

/**
 * A decision about a rule or a workflow: the version read is sent along (a rule's undo needs none, a workflow's always does); when it
 * changed meanwhile, the sentence is shown and the list read again.
 */
function useDecision(url: string, fingerprint: string | undefined, onDecided: () => Promise<void>, undoNeedsFingerprint = false) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function decide(status: RuleStatus) {
        setError("");
        setBusy(true);
        try {
            await api(url, { method: "PUT", body: status === "unverified" && !undoNeedsFingerprint ? { status } : { status, fingerprint } });
            await onDecided();
        } catch (e) {
            setError(describeApiError(e));
            if (e instanceof ApiError && e.status === 409) await onDecided();
        } finally {
            setBusy(false);
        }
    }
    return { busy, error, decide };
}

function Decide({ status, busy, decide }: { status: RuleStatus; busy: boolean; decide: (s: RuleStatus) => Promise<void> }) {
    return (
        <div className="rule-actions">
            {status === "unverified" ? (
                <>
                    <Button size="sm" variant="primary" icon={Check} loading={busy} onClick={() => void decide("confirmed")}>
                        Confirm
                    </Button>
                    <Button size="sm" icon={X} disabled={busy} onClick={() => void decide("rejected")}>
                        Reject
                    </Button>
                </>
            ) : (
                <Button size="sm" icon={Undo2} loading={busy} onClick={() => void decide("unverified")}>
                    Undo the decision
                </Button>
            )}
        </div>
    );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
    if (evidence.length === 0) return null;
    return (
        <ul className="understanding-list" aria-label="Evidence">
            {evidence.map((e, i) => (
                <li key={`${e.ref}-${i}`}>
                    <span className="t-meta">{e.ref}</span>
                    {e.excerpt && <blockquote>{e.excerpt}</blockquote>}
                </li>
            ))}
        </ul>
    );
}

function RuleRow({ projectId, rule: r, workflows, canWrite, onDecided }: { projectId: string; rule: Rule; workflows: Map<string, Workflow>; canWrite: boolean; onDecided: () => Promise<void> }) {
    const { busy, error, decide } = useDecision(`/projects/${projectId}/intel/rules/${encodeURIComponent(r.id)}/decision`, r.fingerprint, onDecided);
    const linked = r.workflows.map((id) => workflows.get(id)).filter((w): w is Workflow => Boolean(w));
    // The workflow is further down the same section: bring it into view and put the keyboard on it.
    const goTo = (w: Workflow) => {
        const el = document.getElementById(workflowAnchor(w.id));
        el?.scrollIntoView({ block: "center" });
        el?.focus({ preventScroll: true });
    };

    return (
        <article className="understanding-rule" aria-label={r.description} data-testid="rule">
            <div className="rule-head">
                <span className="t-card">{r.description}</span>
                <Badge tone={r.explicitness === "explicit" ? "info" : "neutral"}>{r.explicitness === "explicit" ? "Stated by a source" : "Inferred"}</Badge>
                {r.status !== "unverified" && <Badge tone={r.status === "confirmed" ? "success" : "neutral"}>{DECIDED[r.status]}</Badge>}
                {r.evidenceGone && <Badge tone="warning">Evidence gone</Badge>}
            </div>
            <p>Expected: {r.expected}</p>
            <p className="t-meta">
                From: {RULE_SOURCE_WORDS[r.sourceType] ?? "Another source"}
                {r.sourceRef ? ` (${r.sourceRef})` : ""} · How sure: {Math.round(r.confidence * 100)}%
            </p>
            {r.status !== "unverified" && rewordedLine(r) && (
                <p className="t-secondary" data-testid="rule-reworded">
                    {rewordedLine(r)}
                </p>
            )}
            {r.evidenceGone && (
                <p className="t-secondary" data-testid="evidence-gone">
                    {EVIDENCE_GONE}
                </p>
            )}
            <EvidenceList evidence={r.evidence} />
            {linked.map((w) => {
                const waiting = !workflowUsable(w) && w.decision?.status !== "rejected";
                return (
                    <p key={w.id} className="t-secondary" data-testid="rule-workflow">
                        Workflow: {w.name}
                        {w.decision?.status === "rejected" ? " (rejected)." : "."}
                        {waiting && ` ${UNCONFIRMED_WORKFLOW}`}
                        {waiting && canWrite && (
                            <>
                                {" "}
                                <button type="button" className="btn-link" onClick={() => goTo(w)}>
                                    Confirm the workflow
                                </button>
                            </>
                        )}
                    </p>
                );
            })}
            {error && (
                <Callout tone="warning">
                    <span data-testid="rule-error">{error}</span>
                </Callout>
            )}
            {canWrite && <Decide status={r.status} busy={busy} decide={decide} />}
        </article>
    );
}

function WorkflowRow({ projectId, workflow: w, canWrite, onDecided }: { projectId: string; workflow: Workflow; canWrite: boolean; onDecided: () => Promise<void> }) {
    const { busy, error, decide } = useDecision(`/projects/${projectId}/intel/workflows/${encodeURIComponent(w.id)}/decision`, w.fingerprint, onDecided, true);
    const status: RuleStatus = w.decision?.status ?? "unverified";
    const steps = [...(w.steps ?? [])].sort((a, b) => a.order - b.order);
    return (
        <article className="understanding-rule" aria-label={w.name} data-testid="workflow" id={workflowAnchor(w.id)} tabIndex={-1}>
            <div className="rule-head">
                <span className="t-card">{w.name}</span>
                <Badge tone="neutral">Inferred</Badge>
                {w.decision && <Badge tone={w.decision.status === "confirmed" ? "success" : "neutral"}>{DECIDED[w.decision.status]}</Badge>}
            </div>
            <p className="t-meta">From: {RULE_SOURCE_WORDS[w.sourceType] ?? "Another source"}</p>
            {w.decision && w.rewordedName && (
                <p className="t-secondary" data-testid="workflow-reworded">
                    Reworded since you decided: {w.rewordedName}
                </p>
            )}
            {steps.length > 0 && (
                <ol className="understanding-steps" aria-label="Steps">
                    {steps.map((s) => (
                        <li key={s.order}>{s.action}</li>
                    ))}
                </ol>
            )}
            <EvidenceList evidence={w.evidence ?? []} />
            {error && (
                <Callout tone="warning">
                    <span data-testid="workflow-error">{error}</span>
                </Callout>
            )}
            {canWrite && <Decide status={status} busy={busy} decide={decide} />}
        </article>
    );
}
