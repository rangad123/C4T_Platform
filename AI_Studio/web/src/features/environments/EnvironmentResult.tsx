import { ArrowRight } from "lucide-react";
import type { Job } from "../../api";
import { Callout, LinkButton } from "../../components/ui";
import { plural } from "../../lib/format";
import { friendlyError, friendlyJobErrors } from "../../lib/labels";
import { routes } from "../../lib/router";

/** What the project page says when the latest job was a run against a named environment (not an analysis). */
export function EnvironmentResult({ job, projectId }: { job: Job; projectId: string }) {
    const where = job.environment ? `“${job.environment}”` : "that environment";
    if (job.status === "FAILED") {
        const e = friendlyError(job.error);
        return (
            <div className="card card-pad">
                <Callout tone={job.error === "Cancelled" ? "neutral" : "danger"} title={job.error === "Cancelled" ? "The run was cancelled" : `The run on ${where} didn’t finish`}>
                    {e.body}
                </Callout>
            </div>
        );
    }
    const c = job.counters;
    const bad = c.testsNeedingReview + c.testsFailedValidation;
    const problems = friendlyJobErrors(job.error);
    return (
        <div className="stack-sm">
            <Callout
                tone={bad > 0 ? "warning" : "success"}
                title={bad > 0 ? `${plural(bad, "test")} did not pass on ${where}` : `Everything that ran on ${where} passed`}
                actions={<LinkButton size="sm" href={routes.tests(projectId)} icon={ArrowRight}>View tests</LinkButton>}
            >
                {`${c.testsValidated} of ${plural(c.testsGenerated, "test")} passed. The results are kept for ${where}; your tests’ main results didn’t change. Open a test to see its result there.`}
            </Callout>
            {problems.map((e) => (
                <Callout key={e.title + e.body} tone="warning" title={e.title}>
                    {e.body}
                </Callout>
            ))}
        </div>
    );
}
