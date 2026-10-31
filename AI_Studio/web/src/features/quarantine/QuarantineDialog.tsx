import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { apiMessage, DEFAULT_DAYS, MAX_DAYS, MAX_REASON, saveName, savedName } from "./quarantine";
import "./quarantine.css";

interface Props {
    projectId: string;
    testId: string;
    title: string;
    /** "release" ends an existing quarantine; `entryId` is then required. */
    mode: "quarantine" | "release";
    entryId?: string;
    /** The reason the platform suggests, put in the box so the person only confirms or edits it. */
    suggestedReason?: string | null;
    onClose: () => void;
    onDone: () => void;
}

/**
 * A real modal dialog (keyboard stays inside, Escape closes it) that asks for the reason, how long and who is doing it.
 * Quarantine is always a person's decision: the dialog only opens after a click, and the server refuses what it must.
 */
export function QuarantineDialog({ projectId, testId, title, mode, entryId, suggestedReason, onClose, onDone }: Props) {
    const ref = useRef<HTMLDialogElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const [reason, setReason] = useState(mode === "quarantine" ? (suggestedReason ?? "") : "");
    const [days, setDays] = useState(String(DEFAULT_DAYS));
    const [name, setName] = useState(savedName());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        nameRef.current?.focus();
    }, []);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        if (!name.trim()) return setError("Enter your name so the decision can be traced to you.");
        if (mode === "quarantine") {
            if (!reason.trim()) return setError("Say why this test is in quarantine, so the next person knows when to bring it back.");
            const n = Number(days);
            if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return setError(`Enter a number of days from 1 to ${MAX_DAYS}.`);
        }
        setBusy(true);
        try {
            if (mode === "quarantine") {
                await api(`/projects/${projectId}/quarantine`, { method: "POST", body: { testId, by: name.trim(), reason: reason.trim(), days: Number(days), suggested: Boolean(suggestedReason) && reason.trim() === suggestedReason } });
            } else {
                await api(`/projects/${projectId}/quarantine/${entryId}/release`, { method: "POST", body: { by: name.trim(), ...(reason.trim() ? { note: reason.trim() } : {}) } });
            }
            saveName(name.trim());
            onDone();
        } catch (err) {
            setError(apiMessage(err));
            setBusy(false);
        }
    }

    const quarantining = mode === "quarantine";
    return (
        <dialog ref={ref} className="q-dialog" aria-labelledby="q-dialog-title" onClose={onClose} onCancel={onClose}>
            <form className="inner" onSubmit={submit} noValidate>
                <div className="stack-sm">
                    <h2 className="t-section" id="q-dialog-title">
                        {quarantining ? "Put this test in quarantine" : "Release this test from quarantine"}
                    </h2>
                    <p className="t-secondary">{title}</p>
                </div>
                <p className="t-secondary">
                    {quarantining
                        ? "The test keeps running and its results are kept. It stops counting against pass rates, alerts, readiness, run sequence checks and sign-off until the time is up or you release it."
                        : "The test counts again from now on, in pass rates, alerts, readiness, run sequence checks and sign-off."}
                </p>
                <div className="field">
                    <label htmlFor="q-reason">{quarantining ? "Why is it in quarantine?" : "Note (optional)"}</label>
                    <textarea id="q-reason" className="input" rows={3} maxLength={MAX_REASON} value={reason} onChange={(e) => setReason(e.target.value)} />
                    {quarantining && <span className="hint">Up to {MAX_REASON} characters.</span>}
                </div>
                {quarantining && (
                    <div className="field">
                        <label htmlFor="q-days">Keep it in quarantine for (days)</label>
                        <input id="q-days" className="input q-days" type="number" inputMode="numeric" min={1} max={MAX_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
                        <span className="hint">From 1 to {MAX_DAYS} days. When the time is up the test counts again.</span>
                    </div>
                )}
                <div className="field">
                    <label htmlFor="q-name">Your name</label>
                    <input id="q-name" ref={nameRef} className="input" value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button type="button" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="primary" loading={busy}>
                        {quarantining ? "Put in quarantine" : "Release from quarantine"}
                    </Button>
                </div>
            </form>
        </dialog>
    );
}
