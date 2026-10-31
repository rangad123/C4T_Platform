import { Code2, ListPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Callout } from "../../components/ui";
import { StepDiffView } from "../builder/History";
import type { StepDiff } from "../builder/stepdiff";
import { diffStats, lineDiff } from "../code/code";
import { Modal } from "../code/Modal";
import { DiffView } from "../code/VersionHistory";
import { TakeOverDialog } from "../code/TakeOver";
import { UnsavedBar } from "../workbench/UnsavedBar";
import { changesWord } from "../workbench/test-model";
import { dapi, DslError, errorText, fileNameFor, type DslDiagnostic, type ParseAnswer, type SaveTextAnswer } from "./dsl";
import { TextView } from "./TextView";
import type { TextDraft } from "./useTextDraft";
import "./dsl.css";

interface Props {
    testId: string;
    title: string;
    draft: TextDraft;
    /** False when the test cannot be edited right now (a run in progress, a framework that is off). */
    editable: boolean;
    /** Why not, in a sentence. */
    editReason?: string;
    /** True when the steps view has changes that were not saved: the text carries them, and saving the text saves them. */
    carriesUnsaved: boolean;
    /** What those unsaved steps changed, for the preview. */
    stepDiff?: StepDiff | null;
    /** Where the unsaved bar goes (the workbench keeps it on screen across tabs). Without it the bar follows the text. */
    barSlot?: HTMLElement | null;
    /** A problem found while leaving this view (the text does not read yet). */
    blocked?: { message: string; problems: DslDiagnostic[] } | null;
    onDiscardAndLeave?: () => void;
    onSaved: (r: SaveTextAnswer) => Promise<void> | void;
    /** How many lines the text has changed, whenever it changes. */
    onDirty?: (changedLines: number) => void;
    onSwitchToSteps?: () => void;
}

/**
 * The text of a test inside the workbench. Every generated test has a text: where a step has no phrase, the line stands in for it
 * (`# not expressible`) and the text is read-only, because saving it would lose that step. Then the page says why and offers the two
 * ways on: the steps, or code. Saving goes through the same checks as the steps; Save and Save and run are separate.
 */
export function TextMode({ testId, title, draft, editable, editReason, carriesUnsaved, stepDiff, barSlot, blocked, onDiscardAndLeave, onSaved, onDirty, onSwitchToSteps }: Props) {
    const printed = draft.printed;
    const expressible = printed?.expressible ?? true;
    const canEdit = editable && expressible;
    const [saving, setSaving] = useState<"" | "save" | "run">("");
    const [saveError, setSaveError] = useState("");
    const [problems, setProblems] = useState<{ forText: string; items: DslDiagnostic[] } | undefined>();
    const [parse, setParse] = useState<{ forText: string; answer: ParseAnswer } | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [showChanges, setShowChanges] = useState(false);
    const [toCode, setToCode] = useState(false);

    const knownBroken = !!parse && parse.forText === draft.text && parse.answer.diagnostics.some((d) => d.severity === "error");
    const unsaved = canEdit && (draft.dirty || carriesUnsaved);
    const canSave = canEdit && unsaved && !knownBroken && !saving;

    // The lines that changed, for the count and the preview.
    const rows = useMemo(() => (draft.dirty ? lineDiff(draft.base, draft.text) : []), [draft.base, draft.text, draft.dirty]);
    const stats = diffStats(rows);
    const lines = draft.dirty ? Math.max(1, Math.max(stats.added, stats.removed)) : 0;
    useEffect(() => onDirty?.(canEdit ? lines : 0), [lines, canEdit]); // eslint-disable-line react-hooks/exhaustive-deps

    async function save(run: boolean) {
        if (!canSave) return;
        setSaving(run ? "run" : "save");
        setSaveError("");
        const sent = draft.text;
        try {
            const r = await dapi<SaveTextAnswer>(`/tests/${testId}/dsl`, { method: "PUT", body: { text: sent, ...(run ? {} : { run: false }) } });
            setProblems(undefined);
            await onSaved(r);
        } catch (e) {
            if (e instanceof DslError && e.status === 422) {
                setProblems({ forText: sent, items: e.diagnostics });
                setSaveError(e.diagnostics.length ? "The text was not saved. Fix the problems listed below and save again. Your text is still here." : `The text was not saved. ${e.message}`);
            } else setSaveError(errorText(e));
        } finally {
            setSaving("");
        }
    }

    const why = !expressible ? (
        <>
            <strong>Part of this test has no text form.</strong> The text below is the closest version: a line that starts with <code># not expressible</code> stands where a step could not be written. It is read-only, because saving it would lose those steps.
            {printed && printed.reasons.length > 0 && (
                <ul className="bullets dsl-reasons" aria-label="What has no text form">
                    {printed.reasons.slice(0, 6).map((r, i) => (
                        <li key={i}>{r}</li>
                    ))}
                </ul>
            )}
        </>
    ) : !editable ? (
        (editReason ?? "This test cannot be edited right now.")
    ) : undefined;

    const count = Math.max(lines, carriesUnsaved ? 1 : 0, 1);
    const bar =
        barSlot && unsaved
            ? createPortal(
                  <UnsavedBar
                      label={changesWord(draft.dirty ? lines : count)}
                      preview={
                          <div className="stack-sm">
                              {carriesUnsaved && stepDiff && (
                                  <>
                                      <h3 className="t-card">Changes made in the steps</h3>
                                      <StepDiffView diff={stepDiff} leftLabel="the saved steps" rightLabel="your changes" />
                                  </>
                              )}
                              {draft.dirty && (
                                  <>
                                      <h3 className="t-card">Changes made in the text</h3>
                                      <DiffView rows={rows} leftLabel="The text as it was" rightLabel="Your text" />
                                  </>
                              )}
                          </div>
                      }
                      previewOpen={showChanges}
                      onTogglePreview={() => setShowChanges((v) => !v)}
                      canSave={canSave}
                      saving={saving}
                      {...(knownBroken ? { why: "The text does not read yet: fix the problems listed under the text first." } : {})}
                      onDiscard={() => setConfirmDiscard(true)}
                      onSave={() => void save(false)}
                      onSaveAndRun={() => void save(true)}
                  />,
                  barSlot,
              )
            : null;

    return (
        <div className="stack">
            {blocked && (
                <Callout
                    tone="warning"
                    title="The text does not read yet"
                    actions={
                        onDiscardAndLeave ? (
                            <Button size="sm" onClick={onDiscardAndLeave}>
                                Discard the text and show the steps
                            </Button>
                        ) : undefined
                    }
                >
                    {blocked.message} The steps cannot show it until these problems are fixed.
                </Callout>
            )}
            {saveError && (
                <Callout tone="danger" title="That didn’t save">
                    {saveError}
                </Callout>
            )}
            {!expressible && (
                <Callout
                    tone="info"
                    title="To change this part, use the steps or code"
                    actions={
                        <>
                            {onSwitchToSteps && (
                                <Button size="sm" icon={ListPlus} onClick={onSwitchToSteps}>
                                    Edit the steps
                                </Button>
                            )}
                            <Button size="sm" icon={Code2} onClick={() => setToCode(true)}>
                                Switch to code
                            </Button>
                        </>
                    }
                >
                    Saving the text would lose the steps it cannot show, so Save is off here. The steps view keeps every setting. Switching to code makes the script the test: you can go back to the generated version later.
                </Callout>
            )}
            <TextView
                text={draft.text}
                onChange={draft.setText}
                readOnly={!canEdit}
                readOnlyWhy={why}
                filename={fileNameFor(title)}
                idPrefix="dsl-edit"
                saveProblems={problems}
                onParsed={(answer, forText) => setParse(answer ? { forText, answer } : null)}
            />
            {bar}
            {confirmDiscard && (
                <Modal
                    title="Discard your changes?"
                    titleId="dsl-discard-title"
                    onClose={() => setConfirmDiscard(false)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirmDiscard(false)}>
                                Keep editing
                            </Button>
                            <Button
                                variant="danger"
                                onClick={() => {
                                    draft.discard();
                                    setProblems(undefined);
                                    setSaveError("");
                                    setShowChanges(false);
                                    setConfirmDiscard(false);
                                }}
                            >
                                Discard changes
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">The text goes back to how it was when you opened this view. This cannot be undone.</p>
                </Modal>
            )}
            {toCode && <TakeOverDialog testId={testId} onClose={() => setToCode(false)} />}
        </div>
    );
}
