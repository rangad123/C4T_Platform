import { ArrowRight } from "lucide-react";
import type { Job } from "../../api";
import { Callout, LinkButton } from "../../components/ui";
import { plural } from "../../lib/format";
import { friendlyError, friendlyJobErrors } from "../../lib/labels";
import { routes } from "../../lib/router";

/** What the project page says when the latest job was a browser / screen-size check (not an analysis). */
export function VariantsResult({ job, projectId }: { job: Job; projectId: string }) {
    if (job.status === "FAILED") {
        const e = friendlyError(job.error);
        return (
            <div className="card card-pad">
                <Callout tone={job.error === "Cancelled" ? "neutral" : "danger"} title={job.error === "Cancelled" ? "The browser check was cancelled" : "The browser check didn’t finish"}>
                    {e.body}
                </Callout>
            </div>
        );
    }
    const c = job.counters;
    const differ = c.testsNeedingReview;
    const problems = friendlyJobErrors(job.error);
    return (
        <div className="stack-sm">
            <Callout
                tone={differ > 0 ? "warning" : problems.length ? "info" : "success"}
                title={differ > 0 ? `${plural(differ, "test")} ${differ === 1 ? "doesn’t" : "don’t"} behave the same on every browser or screen size` : "Browser and screen-size check finished"}
                actions={
                    <LinkButton size="sm" href={routes.tests(projectId)} icon={ArrowRight}>
                        View tests
                    </LinkButton>
                }
            >
                {differ > 0
                    ? `Look for “Fails on …” next to a test, or open it to see where and why. ${plural(c.variantChecks ?? 0, "check")} ran; ${c.variantFailures ?? 0} failed.`
                    : `${plural(c.variantChecks ?? 0, "check")} ran and none failed.`}
            </Callout>
            {problems.map((e) => (
                <Callout key={e.title + e.body} tone="warning" title={e.title}>
                    {e.body}
                </Callout>
            ))}
        </div>
    );
}
