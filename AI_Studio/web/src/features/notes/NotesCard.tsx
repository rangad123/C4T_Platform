import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";

/** GET /api/projects/:id/notes (src/platform/routes/notes.ts). */
interface Note {
    id: string;
    path: string;
    text: string;
}

/**
 * Project Settings → General: "Notes for the AI". Plain hints for the analysis, the plan and the test writers, optionally for a page
 * ("/checkout"). A note that starts with "never" is a hard rule: the AI does not use the control it names.
 */
export function NotesCard({ projectId }: { projectId: string }) {
    const notes = useFetch<{ notes: Note[]; max: number }>(`/projects/${projectId}/notes`);
    const noSettings = useHere(projectId).why("ai_studio.project.settings");
    const [path, setPath] = useState("");
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            await notes.reload();
            return true;
        } catch (e) {
            setError(describeApiError(e));
            return false;
        } finally {
            setBusy(false);
        }
    };
    const add = async () => {
        if (await run(() => api(`/projects/${projectId}/notes`, { method: "POST", body: { path: path.trim(), text: text.trim() } }))) {
            setPath("");
            setText("");
        }
    };

    if (notes.loading) return <Skeleton h={80} />;
    const list = notes.data?.notes ?? [];
    const full = Boolean(notes.data && list.length >= notes.data.max);
    return (
        <section className="card card-pad stack-sm" data-testid="notes-card" aria-labelledby="notes-title">
            <h2 className="t-section" id="notes-title">
                Notes for the AI{" "}
                <HelpTip
                    label="notes for the AI"
                    text={'Hints the AI reads when it explores, plans and writes tests: test data to use, what a page does, what to avoid. Add a page path to keep a note to that page and the pages under it (/product/* for every product). A note that starts with "never" is a rule: the AI does not use the control it names, for example: never press Delete account.'}
                />
            </h2>
            {notes.error && <Callout tone="warning" title="Could not load the notes">{describeApiError(notes.error)}</Callout>}
            {list.length === 0 && !notes.error && <p className="t-meta">No notes yet. For example: /checkout, the coupon TEST10 gives 10% off.</p>}
            {list.length > 0 && (
                <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }} data-testid="notes-list">
                    {list.map((n) => (
                        <li key={n.id} className="row" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
                            <span>
                                <span className="t-meta">{n.path || "Whole site"}</span>
                                <span style={{ display: "block" }}>{n.text}</span>
                            </span>
                            {!noSettings && (
                                <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove the note ${n.text}`} onClick={() => void run(() => api(`/projects/${projectId}/notes/${n.id}`, { method: "DELETE" }))}>
                                    <Trash2 size={16} aria-hidden />
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {noSettings ? (
                <p className="t-meta">{noSettings}</p>
            ) : (
                <form
                    className="stack-sm"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}
                >
                    <div className="field">
                        <label htmlFor="note-path">Page (optional)</label>
                        <input id="note-path" className="input" value={path} placeholder="Empty: the whole site. Or /checkout, /product/*" autoComplete="off" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="note-text">Note</label>
                        <textarea id="note-text" className="input" rows={2} maxLength={500} value={text} placeholder="Use the Demo school. Never press Delete account." onChange={(e) => setText(e.target.value)} />
                    </div>
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div>
                        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={busy || !text.trim() || full}>
                            Add note
                        </Button>
                    </div>
                </form>
            )}
        </section>
    );
}
