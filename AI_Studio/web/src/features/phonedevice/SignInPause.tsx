import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type EventRow, type Job } from "../../api";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { QUESTION_TITLE, openQuestionOf, timeLeft } from "./phonedevice";

/**
 * On the page of a running phone exploration: the AI met a one-time code, a captcha, or a sign-in it may not fill, and waits for a person.
 * Continue: the person did it on the phone. Go on without signing in: the AI explores what it can reach. Nobody answering by the time limit is
 * the same as going on (the platform says so in the steps).
 */
export function SignInPause({ job, events, onAnswered }: { job: Pick<Job, "jobId" | "projectId">; events: Array<EventRow & { data?: unknown }> | undefined; onAnswered?: () => void }) {
    const [now, setNow] = useState(Date.now());
    const [busy, setBusy] = useState<"" | "continue" | "skip">("");
    const [error, setError] = useState("");
    const [answered, setAnswered] = useState("");
    const q = openQuestionOf(events, now);
    useEffect(() => {
        if (!q) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [q?.requestId]);
    if (!q || answered === q.requestId) return null;

    async function answer(choice: "continue" | "skip") {
        setBusy(choice);
        setError("");
        try {
            await api(`/projects/${job.projectId}/jobs/${job.jobId}/phone-sign-in`, { method: "POST", body: { choice } });
            setAnswered(q!.requestId);
            onAnswered?.();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    return (
        <div role="region" aria-label="The exploration is waiting for you" data-testid="signin-pause">
            <Callout
                tone="warning"
                title={QUESTION_TITLE[q.kind]}
                actions={
                    <>
                        <Button variant="primary" icon={KeyRound} loading={busy === "continue"} disabled={busy !== ""} onClick={() => void answer("continue")} tip="Choose this once you have done it on the phone. The AI looks at the phone again and goes on signed in.">
                            Continue
                        </Button>
                        <Button loading={busy === "skip"} disabled={busy !== ""} onClick={() => void answer("skip")} tip="The AI goes on without signing in and explores what it can reach. Tests that need signing in are left out of the plan.">
                            Go on without signing in
                        </Button>
                    </>
                }
            >
                <span className="pd-pause-body">
                    <span>{q.message}</span>
                    <span className="t-meta" aria-live="off">
                        {q.screen ? `On “${q.screen}”. ` : ""}The exploration waits, {timeLeft(q.deadline, now)}; then it goes on without signing in. The platform never reads or types the code.
                    </span>
                    {error && <span role="alert">{error}</span>}
                </span>
            </Callout>
        </div>
    );
}
