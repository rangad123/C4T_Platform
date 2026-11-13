import { ListTree, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import { draftNameProblem, moveScript, requirementPlanLine, type RequirementSuitesAnswer, type SuiteProposal } from "./suites";
import { NO_AI_KEY } from "../aiconfig/aiconfig";

/**
 * "Generate suites" on the Test suites page (src/platform/routes/suites.ts): by requirement (no AI; it says what it will make before it
 * makes anything) and using AI (the AI proposes suites, the person edits and approves them, and only then are they saved).
 */

const errorWords = (e: unknown) => (e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing ? `${describeApiError(e) || NO_AI_KEY} You can still generate suites by requirement or make them by hand.` : describeApiError(e));

type ReqState = { step: "checking" } | { step: "confirm"; plan: RequirementSuitesAnswer } | { step: "saving"; plan: RequirementSuitesAnswer } | { step: "done"; answer: RequirementSuitesAnswer } | { step: "failed"; error: string };

/** One suite per requirement that has test scripts. Asks the server what it would do first (dryRun), then does it when the person says so. */
export function RequirementSuites({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
    const [state, setState] = useState<ReqState>({ step: "checking" });
    const send = (dryRun: boolean) => api<RequirementSuitesAnswer>(`/projects/${projectId}/test-suites/generate`, { method: "POST", body: { by: "requirement", dryRun } });

    useEffect(() => {
        let live = true;
        send(true).then(
            (plan) => live && setState({ step: "confirm", plan }),
            (e) => live && setState({ step: "failed", error: describeApiError(e) }),
        );
        return () => {
            live = false;
        };
        // Once, when the panel opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    async function save(plan: RequirementSuitesAnswer) {
        setState({ step: "saving", plan });
        try {
            const answer = await send(false);
            setState({ step: "done", answer });
            onSaved();
        } catch (e) {
            setState({ step: "failed", error: describeApiError(e) });
        }
    }

    const close = (
        <Button size="sm" variant="ghost" onClick={onClose}>
            Close
        </Button>
    );
    return (
        <section className="card-pad stack-sm suite-gen" aria-labelledby="suite-gen-req">
            <div className="row">
                <ListTree size={18} aria-hidden />
                <h3 className="t-card" id="suite-gen-req">
                    Suites by requirement
                </h3>
            </div>
            {state.step === "checking" && (
                <>
                    <p className="t-secondary" role="status">
                        Finding the test scripts of each requirement…
                    </p>
                    <ListSkeleton rows={2} />
                </>
            )}
            {state.step === "failed" && (
                <Callout tone="danger" title="No suites were made" actions={close}>
                    {state.error}
                </Callout>
            )}
            {state.step === "done" && (
                <Callout tone="success" title="Suites generated" actions={close}>
                    {`${requirementPlanLine(state.answer.created, state.answer.updated, true) || "Nothing changed"}.`}
                    {state.answer.skipped.length > 0 && ` ${plural(state.answer.skipped.length, "requirement")} got no suite or not every script.`}
                </Callout>
            )}
            {(state.step === "confirm" || state.step === "saving") && <RequirementPlan plan={state.plan} saving={state.step === "saving"} onSave={() => void save(state.plan)} onCancel={onClose} />}
        </section>
    );
}

function RequirementPlan({ plan, saving, onSave, onCancel }: { plan: RequirementSuitesAnswer; saving: boolean; onSave: () => void; onCancel: () => void }) {
    const line = requirementPlanLine(plan.created, plan.updated);
    const upToDate = plan.suites.filter((s) => s.action === "up-to-date").length;
    return (
        <>
            <p className="t-secondary">
                One suite per requirement, holding the test scripts made from its test cases or linked to it. A suite made here before gets only the scripts that are new to its requirement, at the end: nothing is removed, a script you took out stays out, and suites you made yourself are not touched. No AI is used.
            </p>
            {plan.suites.length > 0 && (
                <ul className="list divided suite-gen-list" aria-label="Suites by requirement">
                    {plan.suites.map((s) => (
                        <li key={s.requirementId} className="suite-gen-item" data-action={s.action}>
                            <span className="title">{s.name}</span>
                            <span className="meta">{rowLine(s)}</span>
                            {s.action === "add" && s.schedules.length > 0 && (
                                <span className="meta suite-gen-sched">
                                    {s.schedules.length === 1 ? `The schedule “${s.schedules[0]!.name}” runs this suite: its next run includes the added scripts.` : `${s.schedules.length} schedules run this suite (${s.schedules.map((x) => `“${x.name}”`).join(", ")}): their next runs include the added scripts.`}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {plan.skipped.length > 0 && (
                <details className="suite-gen-skipped">
                    <summary className="t-meta">{plural(plan.skipped.length, "requirement")} without a suite or with scripts left out</summary>
                    <ul>
                        {plan.skipped.map((s, i) => (
                            <li key={`${s.requirementId}-${i}`} className="t-meta">
                                {s.detail}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            {line ? (
                <div className="row">
                    <Button variant="primary" icon={ListTree} loading={saving} onClick={onSave}>
                        {line}
                    </Button>
                    <Button variant="ghost" onClick={onCancel} disabled={saving}>
                        Cancel
                    </Button>
                </div>
            ) : (
                <Callout
                    tone="info"
                    title="Nothing to generate"
                    actions={
                        <Button size="sm" variant="ghost" onClick={onCancel}>
                            Close
                        </Button>
                    }
                >
                    {upToDate
                        ? "Every requirement with test scripts already has its suite, with all its scripts."
                        : "No requirement has test scripts yet. Make scripts from the test cases of a requirement first (Test cases, Generate test scripts using AI), or link scripts to it on Requirements."}
                </Callout>
            )}
        </>
    );
}

/** One plan row in words: what happens to the requirement's suite, and the scripts a person took out that stay out. */
function rowLine(s: RequirementSuitesAnswer["suites"][number]): string {
    const main = s.action === "create" ? `New suite with ${plural(s.adding, "script")}` : s.action === "add" ? `Adds ${plural(s.adding, "new script")} to this suite` : "Up to date: no script is new to this requirement";
    return s.keptOut ? `${main}. ${plural(s.keptOut, "script")} you took out ${s.keptOut === 1 ? "stays" : "stay"} out.` : main;
}

interface Draft {
    key: string;
    name: string;
    description: string;
    testIds: string[];
}
type AiState = { step: "proposing" } | { step: "review"; drafts: Draft[]; notes: string[]; scripts: SuiteProposal["scripts"]; nameLength: number } | { step: "done"; saved: number } | { step: "failed"; error: string };

/** The AI proposes suites; the person renames, removes suites, moves or removes scripts, then saves. Nothing is saved before that. */
export function AiSuites({ projectId, existingNames, onClose, onSaved }: { projectId: string; existingNames: string[]; onClose: () => void; onSaved: () => void }) {
    const [state, setState] = useState<AiState>({ step: "proposing" });
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        api<SuiteProposal>(`/projects/${projectId}/test-suites/propose`, { method: "POST", body: {} }).then(
            (p) => live && setState({ step: "review", drafts: p.suites.map((s, i) => ({ key: `s${i}`, name: s.name, description: s.description, testIds: s.testIds })), notes: p.notes, scripts: p.scripts, nameLength: p.limits.nameLength }),
            (e) => live && setState({ step: "failed", error: errorWords(e) }),
        );
        return () => {
            live = false;
        };
        // Once, when the panel opens: every proposal is a model call.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    const close = (
        <Button size="sm" variant="ghost" onClick={onClose}>
            Close
        </Button>
    );
    return (
        <section className="card-pad stack-sm suite-gen" aria-labelledby="suite-gen-ai">
            <div className="row">
                <Sparkles size={18} aria-hidden />
                <h3 className="t-card" id="suite-gen-ai">
                    Suites proposed by the AI
                </h3>
            </div>
            {state.step === "proposing" && (
                <>
                    <p className="t-secondary" role="status">
                        The AI is grouping your test scripts into suites. Nothing is saved until you check and save them.
                    </p>
                    <ListSkeleton rows={3} />
                </>
            )}
            {state.step === "failed" && (
                <Callout tone="danger" title="The AI did not propose suites" actions={close}>
                    {state.error}
                </Callout>
            )}
            {state.step === "done" && (
                <Callout tone="success" title="Suites saved" actions={close}>
                    {`${plural(state.saved, "suite")} saved. Open one to put its scripts in order or to choose how it runs.`}
                </Callout>
            )}
            {state.step === "review" && (
                <ProposalEditor
                    drafts={state.drafts}
                    notes={state.notes}
                    scripts={state.scripts}
                    nameLength={state.nameLength}
                    existingNames={existingNames}
                    saving={saving}
                    error={saveError}
                    onChange={(drafts) => setState({ ...state, drafts })}
                    onCancel={onClose}
                    onSave={async (drafts) => {
                        setSaving(true);
                        setSaveError(null);
                        try {
                            const r = await api<{ suites: unknown[] }>(`/projects/${projectId}/test-suites/batch`, { method: "POST", body: { suites: drafts.map((d) => ({ name: d.name.trim(), ...(d.description.trim() ? { description: d.description.trim() } : {}), testIds: d.testIds })) } });
                            setState({ step: "done", saved: r.suites.length });
                            onSaved();
                        } catch (e) {
                            setSaveError(describeApiError(e));
                        } finally {
                            setSaving(false);
                        }
                    }}
                />
            )}
        </section>
    );
}

function ProposalEditor({
    drafts,
    notes,
    scripts,
    nameLength,
    existingNames,
    saving,
    error,
    onChange,
    onCancel,
    onSave,
}: {
    drafts: Draft[];
    notes: string[];
    scripts: SuiteProposal["scripts"];
    nameLength: number;
    existingNames: string[];
    saving: boolean;
    error: string | null;
    onChange: (d: Draft[]) => void;
    onCancel: () => void;
    onSave: (d: Draft[]) => void;
}) {
    const byId = new Map(scripts.map((s) => [s.id, s]));
    const kept = drafts.filter((d) => d.testIds.length > 0);
    const problems = drafts.map((d, i) => (d.testIds.length ? draftNameProblem(d.name, i, drafts.filter((x) => x.testIds.length), existingNames) : null));
    const blocked = problems.some(Boolean);
    const set = (i: number, patch: Partial<Draft>) => onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
    return (
        <>
            <p className="t-secondary">Check the suites before saving them: change their names, remove suites, and move or remove scripts. Each suite is saved with the usual settings; open it afterwards to change how it runs.</p>
            {notes.map((n) => (
                <p key={n} className="t-meta">
                    {n}
                </p>
            ))}
            {drafts.length === 0 && <p className="t-secondary">No suites left to save.</p>}
            <ol className="suite-props" aria-label="Proposed suites">
                {drafts.map((d, i) => {
                    const nameId = `suite-prop-name-${d.key}`;
                    const problem = problems[i];
                    return (
                        <li key={d.key} className="suite-prop" data-proposed={d.key}>
                            <div className="suite-prop-head">
                                <div className="field grow">
                                    <label htmlFor={nameId}>Name of suite {i + 1}</label>
                                    <input id={nameId} className="input" value={d.name} maxLength={nameLength} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${nameId}-problem` : undefined} onChange={(e) => set(i, { name: e.target.value })} />
                                    {problem && (
                                        <p className="t-meta suite-prop-problem" id={`${nameId}-problem`}>
                                            {problem}
                                        </p>
                                    )}
                                </div>
                                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove the suite ${d.name || i + 1}`} onClick={() => onChange(drafts.filter((_, j) => j !== i))}>
                                    Remove suite
                                </Button>
                            </div>
                            {d.description && <p className="t-meta">{d.description}</p>}
                            {d.testIds.length === 0 ? (
                                <p className="t-meta">No scripts left in this suite, so it is not saved.</p>
                            ) : (
                                <ul className="suite-prop-scripts" aria-label={`Scripts in ${d.name || `suite ${i + 1}`}`}>
                                    {d.testIds.map((tid) => {
                                        const s = byId.get(tid);
                                        const title = s?.title ?? tid;
                                        return (
                                            <li key={tid}>
                                                <span className="main">
                                                    <span className="title">{title}</span>
                                                    {s && (
                                                        <span className="meta">
                                                            {s.testId}
                                                            {s.area ? `, ${s.area}` : ""}
                                                        </span>
                                                    )}
                                                </span>
                                                {drafts.length > 1 && (
                                                    <select
                                                        className="input suite-prop-move"
                                                        aria-label={`Move ${title} to another suite`}
                                                        value=""
                                                        onChange={(e) => {
                                                            const to = Number(e.target.value);
                                                            if (Number.isInteger(to)) onChange(moveScript(drafts, i, to, tid));
                                                        }}
                                                    >
                                                        <option value="">Move to…</option>
                                                        {drafts.map((o, j) =>
                                                            j === i ? null : (
                                                                <option key={o.key} value={j}>
                                                                    {o.name || `Suite ${j + 1}`}
                                                                </option>
                                                            ),
                                                        )}
                                                    </select>
                                                )}
                                                <Button size="sm" variant="ghost" icon={X} iconOnly aria-label={`Remove ${title} from ${d.name || `suite ${i + 1}`}`} onClick={() => set(i, { testIds: d.testIds.filter((x) => x !== tid) })}>
                                                    Remove
                                                </Button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ol>
            {error && <Callout tone="danger" title="The suites were not saved">{error}</Callout>}
            <div className="row">
                <Button variant="primary" loading={saving} disabled={kept.length === 0 || blocked} tip={kept.length === 0 ? "No suite has scripts left to save." : blocked ? "Give every suite its own name first." : undefined} onClick={() => onSave(kept)}>
                    {kept.length ? `Save ${plural(kept.length, "suite")}` : "Save suites"}
                </Button>
                <Button variant="ghost" onClick={onCancel} disabled={saving}>
                    Cancel
                </Button>
            </div>
        </>
    );
}
