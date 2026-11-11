import { useState } from "react";
import { Modal } from "../../components/Modal";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";


/** Discarding closes the recorded browser and drops the steps. The safe choice (keep) comes first and has the focus. */
export function DiscardDialog({ again, onClose, onConfirm }: { again?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function confirm() {
        setBusy(true);
        setError("");
        try {
            await onConfirm();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <Modal
            title="Discard this recording?"
            titleId="rec-discard-title"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose}>Keep it</Button>
                    <Button variant="danger" loading={busy} onClick={() => void confirm()}>
                        Discard recording
                    </Button>
                </>
            }
        >
            <p className="t-secondary">The recorded steps are deleted and the browser window is closed. This cannot be undone.{again ? " You can then start a new recording." : ""}</p>
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
    );
}
