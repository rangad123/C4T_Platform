import { useFetch } from "../../lib/hooks";
import { costText, exact, type JobUsage } from "./usage";

/** What one job's model use looks like, loaded with the job's technical details; null when it used no AI (or cannot be read). */
export function useJobUsage(jobId: string, live: boolean) {
    return useFetch<JobUsage>(`/jobs/${jobId}/usage`, () => (live ? 5000 : null)).data;
}

/** The rows added to the technical details: "AI use: 41K in, 6K out, 12 calls", and the limit that stopped the job, if one did. */
export function JobUsageRows({ usage }: { usage: JobUsage }) {
    return (
        <>
            <dt>AI use</dt>
            <dd data-testid="job-ai-use">
                {usage.summary}
                {usage.totals.cost !== null ? `, cost ${costText(usage.totals.cost, usage.currency)}` : ""}
                {usage.totals.estimated ? " (partly estimated)" : ""}
            </dd>
            {usage.snapshotSavings && (
                <>
                    <dt>Page snapshots</dt>
                    <dd data-testid="job-snapshot-savings">{usage.snapshotSavings.summary} (an estimate)</dd>
                </>
            )}
            {usage.withoutAi && (
                <>
                    <dt>Done without AI</dt>
                    <dd data-testid="job-without-ai">{usage.withoutAi.summary}</dd>
                </>
            )}
            {usage.stop && (
                <>
                    <dt>Stopped by</dt>
                    <dd data-testid="job-ai-stop">
                        {usage.stop.message} ({usage.stop.scope.toLowerCase()}: {exact(usage.stop.usedTokens)} of {exact(usage.stop.limitTokens)} tokens)
                    </dd>
                </>
            )}
        </>
    );
}
