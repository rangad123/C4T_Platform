import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Job } from "../../api";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { announceRunsChanged, stopLabel, stopQuestion, type RunAnswer } from "./runs";
import "./runs.css";

/** A real modal dialog: keyboard stays inside, Escape closes it. It says what stopping does before it does it. */
export function StopDialog({ job, onClose, onConfirmed }: { job: Pick<Job, "jobId" | "projectId" | "mode"> & { planOnly?: boolean }; onClose: () => void; onConfirmed: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const [counts, setCounts] = useState<RunAnswer["counts"] | undefined>();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        // The safe choice (keep running) comes first and has the focus.
        d?.querySelector<HTMLButtonElement>("button")?.focus();
    }, []);

    // How many results are already recorded, read now: the dialog only promises what the platform shows.
    useEffect(() => {
        let gone = false;
        api<RunAnswer>(`/projects/${job.projectId}/runs/${job.jobId}`)
            .then((a) => !gone && setCounts(a.counts))
            .catch(() => undefined)
            .finally(() => !gone && setLoading(false));
        return () => {
            gone = true;
        };
    }, [job.projectId, job.jobId]);

    const q = stopQuestion(job.mode, counts, job.planOnly);
    async function stop() {
        setBusy(true);
        setError("");
        try {
            await api(`/test-generation/${job.jobId}`, { method: "DELETE" });
            announceRunsChanged();
            onConfirmed();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <dialog ref={ref} className="run-dialog" aria-labelledby="run-stop-title" onClose={onClose} onCancel={onClose}>
            <div className="inner">
                <h2 className="t-section" id="run-stop-title">
                    {q.title}
                </h2>
                <p className="t-secondary" data-testid="stop-body" aria-busy={loading}>
                    {loading ? "Checking what has finished…" : q.body}
                </p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button onClick={onClose}>Keep running</Button>
                    <Button variant="danger" icon={X} loading={busy} disabled={loading} onClick={() => void stop()}>
                        {stopLabel(job.mode)}
                    </Button>
                </div>
            </div>
        </dialog>
    );
}

/**
 * The stop button of a run: asks first (see StopDialog), then says "Stopping…" until the run has ended (the page then replaces it).
 * `size` follows the buttons around it.
 */
export function StopRun({ job, size = "md", onRequested }: { job: Pick<Job, "jobId" | "projectId" | "mode"> & { planOnly?: boolean }; size?: "sm" | "md"; onRequested?: () => void }) {
    const [asking, setAsking] = useState(false);
    const [requested, setRequested] = useState(false);
    return (
        <>
            <Button size={size} variant="ghost" icon={X} loading={requested} disabled={requested} onClick={() => setAsking(true)}>
                {requested ? "Stopping…" : stopLabel(job.mode)}
            </Button>
            {asking && (
                <StopDialog
                    job={job}
                    onClose={() => setAsking(false)}
                    onConfirmed={() => {
                        setAsking(false);
                        setRequested(true);
                        onRequested?.();
                    }}
                />
            )}
        </>
    );
}
