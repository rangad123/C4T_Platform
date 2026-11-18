import { Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api, type Job } from "../../api";
import { Button, LinkButton } from "../../components/ui";
import { ExploreStartError } from "../runs/ExploreOnRunner";
import { exploreAgainHref } from "../phone/phone";

/** What a stopped exploration keeps, said before the person chooses (the server decides exactly where it carries on, explore-resume.ts). */
export function continueNote(job: Pick<Job, "planOnly" | "fromPlan">): string {
    return job.fromPlan
        ? "Continue keeps the tests already made and makes only the rest of the plan; tests that had not run yet run now. Start over explores the application again."
        : "Continue carries on from where it stopped: pages already found are not explored again, and the AI’s reading of the application is kept when it had finished. Start over explores everything again.";
}

/**
 * Continue and Start over for a stopped exploration (`job.canContinue`): Continue asks the platform to carry on from where it stopped
 * (POST /projects/:id/explorations/:jobId/continue) and shows its refusal as its sentence; Start over is the usual Explore again.
 */
export function ContinueExploring({ job, projectId, onStarted, size = "sm" }: { job: Pick<Job, "jobId" | "targets" | "canContinue">; projectId: string; onStarted?: () => void; size?: "sm" | "md" }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    if (!job.canContinue) return null;
    async function go() {
        setBusy(true);
        setError(null);
        try {
            await api(`/projects/${projectId}/explorations/${job.jobId}/continue`, { method: "POST" });
            onStarted?.();
        } catch (e) {
            setError(e);
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="stack-sm" data-testid="continue-exploring">
            <div className="row">
                <Button size={size} variant="primary" icon={Play} loading={busy} onClick={() => void go()} data-testid="continue-button">
                    {busy ? "Continuing…" : "Continue"}
                </Button>
                <LinkButton size={size} href={exploreAgainHref(job, projectId)} icon={RefreshCw}>
                    Start over
                </LinkButton>
            </div>
            {error !== null && <ExploreStartError error={error} />}
        </div>
    );
}
