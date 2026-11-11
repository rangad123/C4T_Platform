import { Code2, PencilLine } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Callout, LinkButton, Skeleton } from "../../components/ui";
import { go, routes } from "../../lib/router";
import { type CustomInfo } from "./code";
import { announceTestChanged } from "../workbench/changed";
import { Modal } from "../../components/Modal";
import { api } from "../../api";
import { describeApiError } from "../../lib/labels";


interface Offer {
    allowed: boolean;
    reason?: string;
    losses: string[];
}

/** "Take over this test?": says plainly what the person gives up before the script becomes the one thing that runs. */
export function TakeOverDialog({ testId, onClose }: { testId: string; onClose: () => void }) {
    const [offer, setOffer] = useState<Offer | null>(null);
    const [loadError, setLoadError] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let gone = false;
        setOffer(null);
        setLoadError("");
        api<Offer>(`/tests/${testId}/take-over`)
            .then((o) => !gone && setOffer(o))
            .catch((e) => !gone && setLoadError(describeApiError(e)));
        return () => {
            gone = true;
        };
    }, [testId, attempt]);

    async function confirm() {
        setBusy(true);
        setError("");
        try {
            await api(`/tests/${testId}/take-over`, { method: "POST", body: { confirm: true } });
            // The page that shows this test (the workbench) asks again: it may already be on the Code tab.
            announceTestChanged(testId);
            onClose();
            go(routes.code(testId));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <Modal
            title="Switch this test to code?"
            titleId="code-takeover-title"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose} data-autofocus>
                        Cancel
                    </Button>
                    <Button variant="primary" icon={PencilLine} loading={busy} disabled={!offer?.allowed} onClick={() => void confirm()}>
                        Switch to code
                    </Button>
                </>
            }
        >
            {!offer && !loadError && (
                <div className="stack-sm" aria-busy="true" aria-label="Loading">
                    <Skeleton w="80%" h={14} />
                    <Skeleton w="60%" h={14} />
                    <Skeleton w="70%" h={14} />
                </div>
            )}
            {loadError && (
                <Callout tone="danger" title="We couldn’t check this test" actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
                    {loadError}
                </Callout>
            )}
            {offer && !offer.allowed && <Callout tone="warning" title="This test can’t be switched to code right now">{offer.reason ?? "Try again in a moment."}</Callout>}
            {offer && (
                <>
                    <p className="t-secondary">After you switch to code, the script you edit is the test. It is no longer made again from the test’s steps.</p>
                    {offer.losses.length > 0 && (
                        <div>
                            <h3 className="t-card" style={{ marginBottom: 4 }}>What stops for this test</h3>
                            <ul className="bullets" data-testid="takeover-losses">
                                {offer.losses.map((l, i) => (
                                    <li key={i}>{l}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <p className="t-secondary">You can go back to the generated version later.</p>
                </>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
    );
}

/** "Switch to code" on a test page: opens the dialog that says what stops for a generated test, or "Edit the code" opens the editor for a code test. */
export function EditScriptButton({ testId, custom }: { testId: string; custom?: CustomInfo }) {
    const [open, setOpen] = useState(false);
    if (custom) return <LinkButton size="sm" icon={Code2} href={routes.code(testId)}>Edit the code</LinkButton>;
    return (
        <>
            <Button size="sm" icon={PencilLine} onClick={() => setOpen(true)}>
                Switch to code
            </Button>
            {open && <TakeOverDialog testId={testId} onClose={() => setOpen(false)} />}
        </>
    );
}

export function HandWrittenBadge() {
    return (
        <Badge tone="brand" icon={Code2} title="The code is the source of truth for this test">
            Code test
        </Badge>
    );
}
