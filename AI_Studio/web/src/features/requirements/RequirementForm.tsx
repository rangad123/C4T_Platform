import { useState } from "react";
import { X } from "lucide-react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { PRIORITIES, PRIORITY_WORDS, STATUS_HINT, STATUS_WORDS, STATUSES, type Requirement, type RequirementPriority, type RequirementStatus } from "./requirements";
import { describeApiError } from "../../lib/labels";


type Fields = Pick<Requirement, "ref" | "title" | "description" | "acceptanceCriteria" | "priority" | "status">;
const EMPTY: Fields = { ref: "", title: "", description: "", acceptanceCriteria: "", priority: "medium", status: "active" };

/** Add a requirement, or change one (`initial` given). The reference may be left empty: the next REQ-n is given. */
export function RequirementForm({ projectId, initial, onCancel, onSaved }: { projectId: string; initial?: Requirement; onCancel: () => void; onSaved: (r: Requirement) => void | Promise<void> }) {
    const [f, setF] = useState<Fields>(initial ? { ref: initial.ref, title: initial.title, description: initial.description, acceptanceCriteria: initial.acceptanceCriteria, priority: initial.priority, status: initial.status } : EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((x) => ({ ...x, [k]: v }));

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!f.title.trim()) return setError("Give the requirement a title, like “A shopper can pay by card”.");
        setBusy(true);
        setError("");
        try {
            const body = { ...f, ref: f.ref.trim(), title: f.title.trim() };
            if (initial && !body.ref) body.ref = initial.ref;
            const saved = await api<Requirement>(initial ? `/projects/${projectId}/requirements/${initial.id}` : `/projects/${projectId}/requirements`, { method: initial ? "PATCH" : "POST", body });
            await onSaved(saved);
        } catch (err) {
            setError(describeApiError(err));
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack-sm" onSubmit={submit} aria-label={initial ? "Edit requirement" : "New requirement"} noValidate>
            <div className="row">
                <h2 className="t-section">{initial ? `Edit ${initial.ref}` : "New requirement"}</h2>
                <span className="spacer" />
                <Button type="button" size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label="Close the form">
                    Close
                </Button>
            </div>
            <div className="req-form-top">
                <div className="field">
                    <label htmlFor="req-ref">Reference</label>
                    <input id="req-ref" className="input mono" value={f.ref} maxLength={40} placeholder={initial ? initial.ref : "Given for you, like REQ-1"} onChange={(e) => set("ref", e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="req-title">Title</label>
                    <input id="req-title" className="input" value={f.title} maxLength={200} placeholder="A shopper can pay by card" autoFocus onChange={(e) => set("title", e.target.value)} />
                </div>
            </div>
            <div className="grid-2">
                <div className="field">
                    <label htmlFor="req-priority">Priority</label>
                    <select id="req-priority" className="input" value={f.priority} onChange={(e) => set("priority", e.target.value as RequirementPriority)}>
                        {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                                {PRIORITY_WORDS[p]}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="field">
                    <label htmlFor="req-status">Status</label>
                    <select id="req-status" className="input" value={f.status} onChange={(e) => set("status", e.target.value as RequirementStatus)} aria-describedby="req-status-hint">
                        {STATUSES.map((s) => (
                            <option key={s} value={s}>
                                {STATUS_WORDS[s]}
                            </option>
                        ))}
                    </select>
                    <span className="hint" id="req-status-hint">
                        {STATUS_HINT[f.status]}
                    </span>
                </div>
            </div>
            <div className="field">
                <label htmlFor="req-description">Description (optional)</label>
                <textarea id="req-description" className="input" value={f.description} maxLength={4000} rows={3} onChange={(e) => set("description", e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="req-criteria">Acceptance criteria (optional)</label>
                <textarea id="req-criteria" className="input" value={f.acceptanceCriteria} maxLength={4000} rows={4} placeholder={"One per line, for example:\nThe card is charged once\nThe shopper sees the order number"} onChange={(e) => set("acceptanceCriteria", e.target.value)} />
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    {initial ? "Save changes" : "Add requirement"}
                </Button>
                <Button type="button" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
