import { Save } from "lucide-react";
import { useState } from "react";
import { Button, Callout } from "../../components/ui";
import { routes } from "../../lib/router";
import { api } from "../../api";
import { describeApiError } from "../../lib/labels";


export interface Saved {
    testId: string;
    jobId: string | null;
    /** A plain sentence from the platform, for example why no run was queued. */
    note?: string;
}

/** After stopping: name the test and save it. The platform then runs it for real to make sure it passes. */
export function SaveForm({ rid, projectId, canSave, saved, onSaved, onAgain }: { rid: string; projectId: string; canSave: boolean; saved: Saved | null; onSaved: (s: Saved) => void; onAgain: () => void }) {
    const [title, setTitle] = useState("");
    const [category, setCategory] = useState("");
    const [titleError, setTitleError] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    if (saved) {
        return (
            <section className="card card-pad stack-sm rec-save" aria-labelledby="rec-save-title">
                <h2 className="t-section" id="rec-save-title">
                    Test saved
                </h2>
                <Callout
                    tone="success"
                    title="Your recording is now a test"
                    actions={
                        <>
                            <a className="btn btn-sm btn-primary" href={routes.test(saved.testId)}>
                                Open the test
                            </a>
                            {saved.jobId && (
                                <a className="btn btn-sm" href={routes.runs(projectId)}>
                                    Watch the run
                                </a>
                            )}
                            <Button size="sm" onClick={onAgain}>
                                Record again
                            </Button>
                        </>
                    }
                >
                    {saved.jobId ? "We’re running it now to make sure it passes." : "No run was queued because this project can’t run tests right now. The test shows as not run yet until you run it."}
                    {saved.note ? ` ${saved.note}` : ""}
                </Callout>
            </section>
        );
    }

    async function save(e: React.FormEvent) {
        e.preventDefault();
        const t = title.trim();
        if (t.length < 3 || t.length > 160) return setTitleError(t.length < 3 ? "Give the test a name of at least 3 characters." : "Keep the name under 160 characters.");
        setTitleError("");
        setError("");
        setBusy(true);
        try {
            const body = { title: t, ...(category.trim() ? { category: category.trim() } : {}) };
            onSaved(await api<Saved>(`/recordings/${rid}/save`, { method: "POST", body }));
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack-sm rec-save" onSubmit={save} noValidate aria-labelledby="rec-save-title">
            <h2 className="t-section" id="rec-save-title">
                Save as a test
            </h2>
            <p className="t-secondary">Check the steps above, change anything that looks wrong, then name the test. We run it once to make sure it passes.</p>
            {!canSave && <Callout tone="warning">There is nothing to save yet. Record at least one click or entry first, or record again.</Callout>}
            <div className="field">
                <label htmlFor="rec-title">Test name</label>
                <input id="rec-title" className="input" value={title} maxLength={200} disabled={!canSave} aria-invalid={!!titleError} aria-describedby={titleError ? "rec-title-error" : undefined} placeholder="Add a product to the cart" onChange={(e) => { setTitle(e.target.value); if (titleError) setTitleError(""); }} />
                {titleError && (
                    <p className="error-text" id="rec-title-error">
                        {titleError}
                    </p>
                )}
            </div>
            <div className="field">
                <label htmlFor="rec-category">Category (optional)</label>
                <input id="rec-category" className="input" value={category} maxLength={80} disabled={!canSave} placeholder="Checkout" onChange={(e) => setCategory(e.target.value)} />
            </div>
            {error && (
                <Callout tone="danger" title="We couldn’t save the test">
                    {error} Your steps and the name are still here. Try again.
                </Callout>
            )}
            <div className="rec-row">
                <Button type="submit" variant="primary" icon={Save} loading={busy} disabled={!canSave}>
                    Save as a test
                </Button>
                <Button type="button" onClick={onAgain}>
                    Record again
                </Button>
            </div>
        </form>
    );
}
