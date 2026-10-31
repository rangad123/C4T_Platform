import type { Job, TestSummary } from "../../api";
import { Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { Outcome } from "./WriteTestDialog";

/** Overview: how the last "Write a test" job ended, with the way to its test. */
export function PlainResult({ job, projectId }: { job: Job; projectId: string }) {
    const made = useFetch<TestSummary[]>(`/projects/${projectId}/tests?jobId=${job.jobId}`);
    if (made.loading) return <Skeleton h={64} style={{ borderRadius: 8 }} />;
    const test = made.data?.[0];
    return (
        <div className="card card-pad stack-sm" data-testid="plain-result">
            <Outcome job={job} test={test} />
            {!test && job.status !== "FAILED" && (
                <p className="t-secondary">
                    A test was rebuilt from a new description. <a href={routes.tests(projectId)}>See the tests</a>
                </p>
            )}
        </div>
    );
}
