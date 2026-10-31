import { GitCompare, Play, RotateCcw, Save, Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui";
import "./workbench.css";

/**
 * The bar that follows the tester while changes are not saved: how many, a way to see them, and the four things they can do.
 * Save and Save and run are separate: saving never starts a run by itself. The preview (what changed) opens above the buttons.
 */
export function UnsavedBar({
    label,
    preview,
    previewOpen,
    onTogglePreview,
    canSave,
    saving,
    why,
    onDiscard,
    onSave,
    onSaveAndRun,
    problem,
}: {
    label: string;
    /** What changed, as a step or line difference. */
    preview: ReactNode;
    previewOpen: boolean;
    onTogglePreview: () => void;
    canSave: boolean;
    saving: "" | "save" | "run";
    /** Why saving is not possible right now, in a sentence. */
    why?: string;
    onDiscard: () => void;
    onSave: () => void;
    onSaveAndRun: () => void;
    /** A problem found while saving (shown in the bar so it is not missed). */
    problem?: ReactNode;
}) {
    return (
        <section className="wb-unsaved" aria-label="Unsaved changes" data-testid="unsaved-bar">
            {previewOpen && (
                <div className="wb-unsaved-preview" data-testid="unsaved-preview" role="region" aria-label="What changed" tabIndex={0}>
                    {preview}
                </div>
            )}
            {problem && <div className="wb-unsaved-problem">{problem}</div>}
            <div className="wb-unsaved-row">
                <span className="wb-unsaved-label" role="status">
                    <span className="wb-dot" aria-hidden />
                    {label}
                </span>
                <span className="wb-unsaved-acts">
                    <Button icon={GitCompare} aria-expanded={previewOpen} onClick={onTogglePreview}>
                        {previewOpen ? "Hide changes" : "Preview changes"}
                    </Button>
                    <Button icon={RotateCcw} disabled={!!saving} onClick={onDiscard} tip="Puts back the last saved version. You are asked first.">
                        Discard changes
                    </Button>
                    <Button icon={Save} loading={saving === "save"} disabled={!canSave || !!saving} tip={canSave ? "Saves your changes as a new version. The test is not run." : why} onClick={onSave}>
                        Save
                    </Button>
                    <Button variant="primary" icon={Play} loading={saving === "run"} disabled={!canSave || !!saving} tip={canSave ? "Saves your changes as a new version, then runs this test once." : why} onClick={onSaveAndRun}>
                        Save and run
                    </Button>
                </span>
            </div>
            {!canSave && why && (
                <p className="t-meta wb-unsaved-why" data-testid="unsaved-why">
                    {why}
                </p>
            )}
        </section>
    );
}

/** After a save: which version it made and how to take it back. Stays until dismissed or the next save. */
export function SavedBar({ headline, detail, canUndo, undoHint, undoing, onUndo, onDismiss }: { headline: string; detail: string; canUndo: boolean; undoHint?: string | undefined; undoing: boolean; onUndo: () => void; onDismiss: () => void }) {
    return (
        <p className="wb-saved" role="status" data-testid="saved-bar">
            <span>
                <strong>{headline}</strong> {detail}
            </span>
            <span className="wb-saved-acts">
                {canUndo && (
                    <Button size="sm" icon={Undo2} loading={undoing} disabled={undoing} tip={undoHint ?? "Goes back to the version before this save. It is saved again as the newest version, so nothing is lost."} onClick={onUndo}>
                        Undo
                    </Button>
                )}
                <Button size="sm" variant="ghost" iconOnly icon={X} aria-label="Dismiss" onClick={onDismiss} />
            </span>
        </p>
    );
}
