import { useEffect, useRef, useState } from "react";
import { Button, Callout } from "../../components/ui";
import { errorText } from "./recorder";

/** A real modal dialog: keyboard stays inside, Escape closes it. Discarding closes the recorded browser and drops the steps. */
export function DiscardDialog({ again, onClose, onConfirm }: { again?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
    const ref = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        d?.querySelector<HTMLButtonElement>("button")?.focus(); // the safe choice (keep) comes first
    }, []);

    async function confirm() {
        setBusy(true);
        setError("");
        try {
            await onConfirm();
        } catch (e) {
            setError(errorText(e));
            setBusy(false);
        }
    }

    return (
        <dialog ref={ref} className="rec-dialog" aria-labelledby="rec-discard-title" onClose={onClose} onCancel={onClose}>
            <div className="inner">
                <h2 className="t-section" id="rec-discard-title">
                    Discard this recording?
                </h2>
                <p className="t-secondary">The recorded steps are deleted and the browser window is closed. This cannot be undone.{again ? " You can then start a new recording." : ""}</p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button onClick={onClose}>Keep it</Button>
                    <Button variant="danger" loading={busy} onClick={() => void confirm()}>
                        Discard recording
                    </Button>
                </div>
            </div>
        </dialog>
    );
}
