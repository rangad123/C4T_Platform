import { FileText } from "lucide-react";
import type { Job } from "../../api";
import { Planned } from "../../components/Planned";
import { ProjectPlace } from "../../components/ProjectHub";
import { LinkButton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { relativeTime } from "../../lib/format";
import { routes } from "../../lib/router";

/**
 * The Requirements place. Requirements are not separate records yet (Phase 3): today a requirements document goes with an
 * exploration, the AI plans tests from it, and the job counts how many requirements its plan covers. That count is shown here as
 * it was stored; nothing is invented.
 */
export function RequirementsPage({ id }: { id: string }) {
    const jobs = useFetch<Job[]>(`/projects/${id}/jobs`);
    const withRequirements = (jobs.data ?? []).filter((j) => (j.counters.requirementsTotal ?? 0) > 0);
    const latest = withRequirements[0];
    return (
        <ProjectPlace
            id={id}
            place="requirements"
            title="Requirements"
            subtitle="What the application must do, and which test cases check it."
            actions={
                <LinkButton variant="primary" icon={FileText} href={routes.newProject({ project: id })} tip="Start an exploration and add a requirements document under Advanced options. The AI plans tests from it.">
                    Generate tests from requirements
                </LinkButton>
            }
        >
            {latest && (
                <section className="card card-pad stack-sm" data-testid="requirements-latest">
                    <h2 className="t-section">From the last requirements document</h2>
                    <p className="t-secondary">
                        The latest exploration with a requirements document ({relativeTime(latest.createdAt)}) found {latest.counters.requirementsTotal} requirements in it. Its plan covers {latest.counters.requirementsCovered ?? 0} of them.
                    </p>
                    <a href={routes.run(id, latest.jobId)}>Open that exploration</a>
                </section>
            )}
            <Planned
                title="Requirements you manage"
                phase="Phase 3"
                testId="planned-requirements"
                will={[
                    "Each requirement as its own record: a title, a description and acceptance criteria.",
                    "Generate test cases from one requirement, and see which test cases cover it.",
                    "Coverage on the project dashboard: requirements with no test case stand out.",
                ]}
                today={<>Add a requirements document to an exploration (Advanced options when you explore). Each test the AI writes from it names the requirements it covers.</>}
            />
        </ProjectPlace>
    );
}
