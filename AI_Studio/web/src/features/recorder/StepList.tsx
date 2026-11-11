import { BadgeCheck, Globe, Keyboard, KeyRound, Link2, ListChecks, MousePointerClick, Pencil, Replace, SquareCheck, Square, TextCursorInput, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Badge, Button } from "../../components/ui";
import { candidateWords, locatorWords, sameLocator, type RecStep, type Recording, type StepKind } from "./recorder";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";

const ICON: Record<StepKind, LucideIcon> = {
    goto: Globe,
    click: MousePointerClick,
    fill: TextCursorInput,
    select: ListChecks,
    check: SquareCheck,
    uncheck: Square,
    press: Keyboard,
    assert: BadgeCheck,
};
const KIND_WORD: Record<StepKind, string> = { goto: "Open a page", click: "Click", fill: "Type", select: "Choose", check: "Tick", uncheck: "Untick", press: "Press a key", assert: "Check" };

interface Props {
    rid: string;
    steps: RecStep[];
    editable: boolean;
    /** False once the shared elements feature turned out not to exist on this platform. */
    canShare: boolean;
    onChanged: (r: Recording) => void;
    onShareUnavailable: () => void;
}

/** What a step is checked against, for steps whose value can be edited. */
const valueEditable = (s: RecStep): boolean => !s.secret && (s.kind === "fill" || s.kind === "select" || (s.kind === "assert" && !!s.assert && ["text", "value", "count"].includes(s.assert.check)));
const currentValue = (s: RecStep): string => (s.kind === "assert" ? String(s.assert?.expected ?? "") : (s.value ?? ""));

export function StepList({ rid, steps, editable, canShare, onChanged, onShareUnavailable }: Props) {
    return (
        <ol className="rec-steps" aria-label="Recorded steps">
            {steps.map((s) => (
                <StepRow key={`${s.index}-${s.at}`} rid={rid} step={s} editable={editable} canShare={canShare} onChanged={onChanged} onShareUnavailable={onShareUnavailable} />
            ))}
        </ol>
    );
}

type Panel = null | "locator" | "value" | "share";

function StepRow({ rid, step, editable, canShare, onChanged, onShareUnavailable }: Omit<Props, "steps"> & { step: RecStep }) {
    const [panel, setPanel] = useState<Panel>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [value, setValue] = useState("");
    const [name, setName] = useState("");
    const [chosen, setChosen] = useState(0); // the way of finding it the person just chose, shown until the platform answers
    const n = step.index + 1;
    const Icon = step.secret ? KeyRound : ICON[step.kind];
    const base = `/recordings/${rid}/steps/${step.index}`;
    const alternatives = (step.alternatives ?? []).filter((a) => !step.locator || !sameLocator(a.locator, step.locator));

    async function run(fn: () => Promise<Recording>, done?: () => void, failed?: () => void) {
        setBusy(true);
        setError("");
        try {
            const rec = await fn();
            setPanel(null);
            done?.();
            onChanged(rec);
        } catch (e) {
            failed?.();
            if (e instanceof ApiError && e.status === 404 && panel === "share") onShareUnavailable();
            else setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    const toggle = (p: Exclude<Panel, null>) => {
        setError("");
        setPanel((cur) => (cur === p ? null : p));
        if (p === "value") setValue(currentValue(step));
        if (p === "share") setName("");
    };

    return (
        <li className={`rec-step${step.secret ? " is-secret" : ""}`} data-step={step.index} data-kind={step.kind}>
            <span className="rec-ico" aria-hidden>
                <Icon size={18} />
            </span>
            <div className="rec-main">
                <p className="rec-desc">
                    <span className="rec-n">Step {n}</span>
                    <span className="sr-only">: {KIND_WORD[step.kind]}. </span>
                    <span className="rec-text">{step.describe}</span>
                </p>
                {(step.locator || step.secret) && (
                    <div className="rec-badges">
                        {step.ref ? (
                            <span className="rec-chip">
                                <Link2 size={12} aria-hidden /> Shared: {step.ref}
                            </span>
                        ) : step.matches !== undefined ? (
                            step.matches === 1 ? (
                                <Badge tone="success" title="The locator finds exactly one element on the page">
                                    Unique
                                </Badge>
                            ) : (
                                <Badge tone="warning" title="The locator finds more than one element, or none; choose a more exact one if the test picks the wrong thing">
                                    {step.matches === 0 ? "No match now" : `Matches ${step.matches} elements`}
                                </Badge>
                            )
                        ) : null}
                        {step.secret && (
                            <Badge tone="info" title="The real value is never recorded; the test uses the saved sign-in details">
                                Secret
                            </Badge>
                        )}
                        {step.locator && !step.ref && <span className="rec-loc">{locatorWords(step.locator)}</span>}
                    </div>
                )}

                {editable && (
                    <div className="rec-acts">
                        {alternatives.length > 0 && !step.ref && (
                            <Button size="sm" variant="ghost" icon={Replace} aria-expanded={panel === "locator"} aria-label={`Change locator for step ${n}`} onClick={() => toggle("locator")}>
                                Change locator
                            </Button>
                        )}
                        {valueEditable(step) && (
                            <Button size="sm" variant="ghost" icon={Pencil} aria-expanded={panel === "value"} aria-label={`Edit value of step ${n}`} onClick={() => toggle("value")}>
                                Edit value
                            </Button>
                        )}
                        {canShare && step.locator && !step.ref && (
                            <Button size="sm" variant="ghost" icon={Link2} aria-expanded={panel === "share"} aria-label={`Use step ${n} as a shared element`} onClick={() => toggle("share")}>
                                Use as shared element
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" className="btn-danger" icon={Trash2} aria-label={`Delete step ${n}`} tip="Removes this step from the recording at once." loading={busy && panel === null} onClick={() => void run(() => api<Recording>(base, { method: "DELETE" }))}>
                            Delete
                        </Button>
                    </div>
                )}

                {panel === "locator" && step.locator && (
                    <fieldset className="rec-panel rec-choices" disabled={busy}>
                        <legend>Locator for step {n}</legend>
                        {[{ locator: step.locator, matches: step.matches }, ...alternatives].map((a, i) => {
                            const id = `rec-loc-${step.index}-${i}`;
                            return (
                                <label key={id} htmlFor={id} className="rec-choice">
                                    <input
                                        id={id}
                                        type="radio"
                                        name={`rec-loc-${step.index}`}
                                        checked={i === chosen}
                                        onChange={() => {
                                            if (i === 0) return;
                                            setChosen(i);
                                            void run(() => api<Recording>(base, { method: "PATCH", body: { locator: a.locator } }), undefined, () => setChosen(0));
                                        }}
                                    />
                                    <span>
                                        {candidateWords(a.locator, a.matches)}
                                        {i === 0 && <span className="hint"> (current)</span>}
                                    </span>
                                </label>
                            );
                        })}
                    </fieldset>
                )}

                {panel === "value" && (
                    <form
                        className="rec-panel"
                        aria-label={`Edit value of step ${n}`}
                        onSubmit={(e) => {
                            e.preventDefault();
                            const body = step.kind === "assert" ? { assert: { check: step.assert!.check, expected: step.assert!.check === "count" && /^\d+$/.test(value.trim()) ? Number(value) : value } } : { value };
                            void run(() => api<Recording>(base, { method: "PATCH", body }));
                        }}
                    >
                        <div className="field">
                            <label htmlFor={`rec-val-${step.index}`}>{step.kind === "assert" ? "Expected value" : step.kind === "select" ? "Option to choose" : "Text to type"}</label>
                            <input id={`rec-val-${step.index}`} className="input" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
                        </div>
                        <div className="rec-row">
                            <Button type="submit" size="sm" variant="primary" loading={busy}>
                                Save value
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setPanel(null)}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                )}

                {panel === "share" && (
                    <form
                        className="rec-panel"
                        aria-label={`Use step ${n} as a shared element`}
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!name.trim()) return setError("Give the element a name, for example Add to cart button.");
                            void run(() => api<Recording>(`${base}/share`, { method: "POST", body: { name: name.trim() } }));
                        }}
                    >
                        <div className="field">
                            <label htmlFor={`rec-share-${step.index}`}>Name for the shared element</label>
                            <input id={`rec-share-${step.index}`} className="input" value={name} maxLength={80} autoFocus placeholder="Add to cart button" onChange={(e) => setName(e.target.value)} />
                            <p className="hint">Other tests can use it, and a fix to it applies everywhere.</p>
                        </div>
                        <div className="rec-row">
                            <Button type="submit" size="sm" variant="primary" loading={busy}>
                                Use as shared element
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setPanel(null)}>
                                Cancel
                            </Button>
                        </div>
                    </form>
                )}

                {error && (
                    <p className="error-text" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </li>
    );
}
