import { Layers } from "lucide-react";
import type { ProjectDetail } from "../../api";
import { Planned } from "../../components/Planned";
import { ProjectPlace } from "../../components/ProjectHub";
import { EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";

/**
 * The Test suites place. Today the platform groups tests by the area of the application they check (the "areas" of the Test cases
 * list); those groups are shown as they are stored. Suites a person builds, ordered and with how they run, arrive with Phase 3.
 */
export function SuitesPage({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const suites = project.data?.suites ?? [];
    return (
        <ProjectPlace id={id} place="suites" title="Test suites" subtitle="Groups of test cases that run together, and how they run.">
            <section className="stack-sm" aria-labelledby="suites-auto">
                <h2 className="t-section" id="suites-auto">
                    Groups by area
                </h2>
                <p className="t-secondary">The platform groups tests by the part of the application they check. These groups are made for you.</p>
                {project.loading ? (
                    <ListSkeleton rows={3} />
                ) : project.error ? (
                    <ErrorState error={friendlyError(project.error.message)} onRetry={project.reload} />
                ) : suites.length === 0 ? (
                    <div className="card">
                        <EmptyState icon={Layers} title="No groups yet">
                            Groups appear when the project has test cases.
                        </EmptyState>
                    </div>
                ) : (
                    <div className="card">
                        <ul className="list divided" aria-label="Groups by area">
                            {suites.map((s) => (
                                <li key={s.id}>
                                    <a className="list-row" href={routes.tests(id)}>
                                        <span className="main">
                                            <span className="title">{s.name}</span>
                                            <span className="meta">
                                                {plural(s.total, "test")}, {s.validated} passing
                                            </span>
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>
            <Planned
                title="Suites you build"
                phase="Phase 3"
                testId="planned-suites"
                will={[
                    "Choose test cases and their order, for example a smoke suite and a full regression suite.",
                    "Save how the suite runs: the environment, the runners, the browsers and the phones.",
                    "Run a suite, schedule it, or start it after a deploy. Only approved script versions run.",
                ]}
                today={<>Choose tests to run from Test cases (select them, then Run), and schedule runs in Runs → Schedules.</>}
            />
        </ProjectPlace>
    );
}
