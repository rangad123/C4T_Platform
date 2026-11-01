import { useEffect, useState } from "react";
import { Badge } from "../../components/ui";
import { cleanReason } from "../../lib/labels";
import { routes } from "../../lib/router";
import { capi, errorText } from "./code";

type Phase = { kind: "queued" } | { kind: "running" } | { kind: "passed" } | { kind: "failed"; reason: string } | { kind: "broken"; reason: string } | { kind: "held"; reason: string };

const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

/** What happened to the run started by a save: queued, running, then passed or failed. A null job id means nothing was started, and says why. */
export function RunStatus({ testId, jobId, note }: { testId: string; jobId: string | null; note?: string }) {
    const [phase, setPhase] = useState<Phase>({ kind: "queued" });

    useEffect(() => {
        if (!jobId) return;
        let cancelled = false;
        let timer: number | undefined;
        setPhase({ kind: "queued" });
        const tick = async () => {
            try {
                const job = await capi<{ status: string; error: string | null }>(`/test-generation/${jobId}`);
                if (cancelled) return;
                if (FINAL.includes(job.status)) {
                    const t = await capi<{ validationStatus: string; validationReason: string | null }>(`/tests/${testId}`);
                    if (cancelled) return;
                    if (job.status === "FAILED" && /^Nothing ran: /.test(job.error ?? "")) setPhase({ kind: "held", reason: job.error! });
                    else if (job.status === "FAILED" && job.error) setPhase({ kind: "broken", reason: job.error ?? "The run could not finish." });
                    else if (t.validationStatus === "VALIDATED") setPhase({ kind: "passed" });
                    else setPhase({ kind: "failed", reason: cleanReason(t.validationReason) || job.error || "The script did not pass." });
                    return;
                }
                setPhase({ kind: job.status === "QUEUED" ? "queued" : "running" });
            } catch (e) {
                if (cancelled) return;
                setPhase({ kind: "broken", reason: errorText(e) });
                return;
            }
            timer = window.setTimeout(() => void tick(), 1500);
        };
        void tick();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [jobId, testId]);

    if (!jobId) {
        return (
            <p className="code-run" role="status" data-testid="run-status">
                <Badge tone="neutral">Not run</Badge>
                <span>Not run: {note || "the script was saved, but no run was started."}</span>
                <a href={routes.test(testId)}>Open the test</a>
            </p>
        );
    }
    const badge =
        phase.kind === "passed" ? <Badge tone="success">Passed</Badge> : phase.kind === "failed" ? <Badge tone="danger">Did not pass</Badge> : phase.kind === "broken" ? <Badge tone="warning">Run stopped</Badge> : phase.kind === "held" ? <Badge tone="neutral">Nothing ran</Badge> : phase.kind === "queued" ? <Badge tone="info">Queued</Badge> : <Badge tone="info">Running</Badge>;
    const text =
        phase.kind === "passed" ? (note ? "The approved version ran and passed." : "The saved script ran and passed.") : phase.kind === "failed" ? phase.reason : phase.kind === "broken" || phase.kind === "held" ? phase.reason : phase.kind === "queued" ? "Waiting for the run to start." : "Running your script now.";
    return (
        <p className="code-run" role="status" data-testid="run-status">
            {badge}
            <span>
                {text}
                {note ? ` ${note}` : ""}
            </span>
            <a href={routes.test(testId)}>Open the test</a>
        </p>
    );
}
