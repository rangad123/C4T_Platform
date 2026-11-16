import { useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { api, ApiError } from "../../api";
import { Badge, Button, Callout, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";
import { EVIDENCE_GONE, INFERRED_WORKFLOW, isStated, RULE_SOURCE_WORDS, rewordedLine, useLatestModel, type Rule, type RuleStatus, type Workflow } from "./understanding";
import "./understanding.css";

const DECIDED: Record<Exclude<RuleStatus, "unverified">, string> = { confirmed: "Confirmed", rejected: "Rejected" };

/**
 * "Rules to confirm" on the Requirements tab of a project tested by the AI agent: the business rules the analysis found that no person
 * has confirmed yet, each with where it came from, how sure the analysis is and the lines it rests on, plus any rule whose evidence a
 * later analysis no longer found. Tests treat a rule as expected behaviour only once it is stated by a source or confirmed here. People
 * who may only look see the rules without the buttons.
 */
export function RulesToConfirm({ projectId }: { projectId: string }) {
    const rules = useFetch<{ rules: Rule[] }>(`/projects/${projectId}/intel/rules`);
    const latest = useLatestModel(projectId);
    const canWrite = useHere(projectId).may("ai_studio.tests.write");
    const all = rules.data?.rules ?? [];
    // Waiting rules, and decided ones a person should look at again: evidence gone, or reworded since the decision.
    const shown = all.filter((r) => r.status === "unverified" || r.evidenceGone || rewordedLine(r));
    const workflows = new Map((latest.data?.model.workflows ?? []).map((w) => [w.id, w]));

    if (rules.loading) return <ListSkeleton rows={2} />;
    if (!rules.error && all.length === 0) return null;
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
        </section>
    );
}

function RuleRow({ projectId, rule: r, workflows, canWrite, onDecided }: { projectId: string; rule: Rule; workflows: Map<string, Workflow>; canWrite: boolean; onDecided: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const linked = r.workflows.map((id) => workflows.get(id)).filter((w): w is Workflow => Boolean(w));

    async function decide(status: RuleStatus) {
        setError("");
        setBusy(true);
        try {
            await api(`/projects/${projectId}/intel/rules/${encodeURIComponent(r.id)}/decision`, { method: "PUT", body: status === "unverified" ? { status } : { status, fingerprint: r.fingerprint } });
            await onDecided();
        } catch (e) {
            setError(describeApiError(e));
            // The rule changed since it was read: show it as it is now, with the sentence saying why nothing was decided.
            if (e instanceof ApiError && e.status === 409) await onDecided();
        } finally {
            setBusy(false);
        }
    }

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
            {r.evidence.length > 0 && (
                <ul className="understanding-list" aria-label="Evidence">
                    {r.evidence.map((e, i) => (
                        <li key={`${e.ref}-${i}`}>
                            <span className="t-meta">{e.ref}</span>
                            {e.excerpt && <blockquote>{e.excerpt}</blockquote>}
                        </li>
                    ))}
                </ul>
            )}
            {linked.map((w) => (
                <p key={w.id} className="t-secondary" data-testid="rule-workflow">
                    Workflow: {w.name}.{!isStated(w.sourceType) && ` ${INFERRED_WORKFLOW}`}
                </p>
            ))}
            {error && (
                <Callout tone="warning">
                    <span data-testid="rule-error">{error}</span>
                </Callout>
            )}
            {canWrite && (
                <div className="rule-actions">
                    {r.status === "unverified" ? (
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
            )}
        </article>
    );
}
