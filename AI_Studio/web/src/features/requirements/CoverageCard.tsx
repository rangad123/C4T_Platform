import { ListChecks } from "lucide-react";
import { Badge } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { COVERAGE_HINT, COVERAGE_TONE, COVERAGE_WORDS, type Coverage, type CoverageSummary, type RequirementStatus } from "./requirements";
import "./requirements.css";

/** The project dashboard's coverage panel: how many requirements are passing, failing, covered and not covered (retired left out). */
export function RequirementsCoverageCard({ projectId }: { projectId: string }) {
    const s = useFetch<CoverageSummary>(`/projects/${projectId}/requirements/coverage`);
    if (!s.data) return null;
    const d = s.data;
    const parts: Array<[Coverage, number]> = [
        ["passing", d.passing],
        ["failing", d.failing],
        ["covered", d.covered],
        ["not_covered", d.notCovered],
    ];
    return (
        <section className="card card-pad stack-sm" aria-labelledby="req-coverage-title" data-testid="requirements-coverage">
            <div className="row">
                <ListChecks size={18} aria-hidden />
                <h2 className="t-card" id="req-coverage-title">
                    Requirements coverage
                </h2>
                <span className="spacer" />
                <a href={routes.requirements(projectId)}>Open requirements</a>
            </div>
            {d.total === 0 ? (
                <p className="t-secondary">No requirements yet. Add them in Requirements to see which ones the test cases check.</p>
            ) : (
                <>
                    <div className="req-bar" role="img" aria-label={`${plural(d.total, "requirement")}: ${parts.map(([c, n]) => `${n} ${COVERAGE_WORDS[c].toLowerCase()}`).join(", ")}`}>
                        {parts.filter(([, n]) => n > 0).map(([c, n]) => (
                            <span key={c} className={`req-bar-part req-${c}`} style={{ flexGrow: n }} />
                        ))}
                    </div>
                    <ul className="chips req-counts" aria-label="Requirements by coverage">
                        {parts.map(([c, n]) => (
                            <li key={c}>
                                <Badge tone={COVERAGE_TONE[c]} tip={COVERAGE_HINT[c]}>
                                    {n} {COVERAGE_WORDS[c].toLowerCase()}
                                </Badge>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}

/** On a test's page: the requirements it covers, each a link to its page. Nothing is shown when it covers none. */
export function CoveredRequirements({ testId, projectId }: { testId: string; projectId: string }) {
    const r = useFetch<{ requirements: Array<{ id: string; ref: string; title: string; status: RequirementStatus }> }>(`/tests/${testId}/requirements`);
    const list = r.data?.requirements ?? [];
    if (list.length === 0) return null;
    return (
        <section className="card card-pad stack-sm" aria-labelledby="test-reqs-title" data-testid="test-requirements">
            <h2 className="t-card" id="test-reqs-title">
                Requirements it covers
            </h2>
            <ul className="req-links">
                {list.map((q) => (
                    <li key={q.id}>
                        <a href={routes.requirement(projectId, q.id)}>
                            <span className="req-ref mono">{q.ref}</span> {q.title}
                        </a>
                        {q.status === "retired" && <span className="t-meta"> (retired)</span>}
                    </li>
                ))}
            </ul>
        </section>
    );
}
