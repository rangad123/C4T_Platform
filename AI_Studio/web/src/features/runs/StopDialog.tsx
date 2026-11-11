import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Job } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { announceRunsChanged, stopLabel, stopQuestion, type RunAnswer } from "./runs";
import "./runs.css";

/** It says what stopping does before it does it. The safe choice (keep running) comes first and has the focus. */
export function StopDialog({ job, onClose, onConfirmed }: { job: Pick<Job, "jobId" | "projectId" | "mode"> & { planOnly?: boolean }; onClose: () => void; onConfirmed: () => void }) {
    const [counts, setCounts] = useState<RunAnswer["counts"] | undefined>();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

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
        <Modal
            title={q.title}
            titleId="run-stop-title"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose}>Keep running</Button>
                    <Button variant="danger" icon={X} loading={busy} disabled={loading} onClick={() => void stop()}>
                        {stopLabel(job.mode)}
                    </Button>
                </>
            }
        >
            <p className="t-secondary" data-testid="stop-body" aria-busy={loading}>
                {loading ? "Checking what has finished…" : q.body}
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
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
