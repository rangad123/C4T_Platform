import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { Button, Callout } from "../../components/ui";
import { apiMessage, MIN_OVERRIDE, saveName, savedName, type Reason, type ReleaseView } from "./manual";

export type Decision = "approved" | "rejected" | "reopen";

interface Props {
    projectId: string;
    release: ReleaseView;
    decision: Decision;
    /** The person's name from the checklist, if they already typed it. */
    name: string;
    onClose: () => void;
    onDone: (release: ReleaseView) => void;
}

const COPY: Record<Decision, { title: string; confirm: string; help: string }> = {
    approved: { title: "Approve this release", confirm: "Approve release", help: "Your name and the decision are recorded in the history and cannot be changed." },
    rejected: { title: "Reject this release", confirm: "Reject release", help: "A reason helps the team, but it is not required." },
    reopen: { title: "Reopen this release", confirm: "Reopen release", help: "The earlier decision stays in the history. Say why the release is being reopened." },
};

/**
 * The name behind a decision, and a comment. A real modal dialog, so the keyboard stays inside it and Escape closes it.
 * When something blocks the approval it says what, and asks for a comment that explains why the release goes ahead anyway.
 */
export function DecisionDialog({ projectId, release, decision, name: initialName, onClose, onDone }: Props) {
    const ref = useRef<HTMLDialogElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(initialName || savedName());
    const [comment, setComment] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [refused, setRefused] = useState<Reason[] | null>(null);

    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        nameRef.current?.focus();
    }, []);

    // Also after the server refused: the page the dialog opened from was out of date.
    const needsOverride = decision === "approved" && (!release.signoff.canApprove || refused !== null);
    const blocking = refused ?? release.signoff.blocking;
    const copy = COPY[decision];
    const commentNeeded = needsOverride || decision === "reopen";
    const minLength = needsOverride ? MIN_OVERRIDE : 1;

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        if (!name.trim()) return setError("Enter your name so the decision can be traced to you.");
        if (commentNeeded && comment.trim().length < minLength) {
            return setError(needsOverride ? `Explain in at least ${MIN_OVERRIDE} characters why the release goes ahead anyway.` : "Say why this release is being reopened.");
        }
        setBusy(true);
        try {
            const base = `/projects/${projectId}/releases/${release.id}`;
            const updated =
                decision === "reopen"
                    ? await api<ReleaseView>(`${base}/reopen`, { method: "POST", body: { by: name.trim(), comment: comment.trim() } })
                    : await api<ReleaseView>(`${base}/signoff`, { method: "POST", body: { decision, by: name.trim(), comment: comment.trim(), override: needsOverride } });
            saveName(name.trim());
            onDone(updated);
        } catch (err) {
            // The page was out of date: the server says what blocks the approval now.
            const details = err instanceof ApiError ? (err.details as { blocking?: Reason[] } | undefined) : undefined;
            if (details?.blocking) setRefused(details.blocking);
            setError(apiMessage(err));
            setBusy(false);
        }
    }

    return (
        <dialog ref={ref} className="rel-dialog" aria-labelledby="rel-dialog-title" onClose={onClose} onCancel={onClose}>
            <form className="inner" onSubmit={submit} noValidate>
                <div className="stack-sm">
                    <h2 className="t-section" id="rel-dialog-title">
                        {copy.title}
                    </h2>
                    <p className="t-secondary">{release.name}</p>
                </div>

                {needsOverride && (
                    <Callout tone="danger" title="Something blocks this approval">
                        You can still approve it with a comment that explains why. The override is recorded.
                    </Callout>
                )}
                {needsOverride && (
                    <ul className="rel-reasons" aria-label="Why this release is blocked">
                        {blocking.map((b) => (
                            <li key={b.code + b.text}>{b.text}</li>
                        ))}
                    </ul>
                )}

                <div className="field">
                    <label htmlFor="rel-name">Your name</label>
                    <input id="rel-name" ref={nameRef} className="input" value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="rel-comment">{needsOverride ? "Why does the release go ahead anyway?" : decision === "reopen" ? "Why reopen it?" : "Comment (optional)"}</label>
                    <textarea id="rel-comment" className="input" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} aria-describedby="rel-comment-help" />
                    <span className="hint" id="rel-comment-help">
                        {needsOverride ? `At least ${MIN_OVERRIDE} characters. ` : ""}
                        {copy.help}
                    </span>
                </div>

                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button type="button" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="primary" loading={busy}>
                        {needsOverride ? "Approve anyway" : copy.confirm}
                    </Button>
                </div>
            </form>
        </dialog>
    );
}
