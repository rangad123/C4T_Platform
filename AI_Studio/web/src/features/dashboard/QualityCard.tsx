import { Activity, ChevronRight } from "lucide-react";
import { Metric } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import "./dashboard.css";

/** GET /api/projects/:id/quality: the card part (src/platform/dashboard.ts QualityCard). */
interface Quality {
    card: {
        numbers: { confirmed: number; reopened: number; passRate: number | null; workflowSteps: { total: number; exercised: number } | null; hoursToConfirm: number | null; pullRequests: number };
        areas: { total: number; items: Array<{ area: string; runs: number; tests: number; testId: string }> };
        flaky: { total: number; items: Array<{ id: string; testKey: string; title: string; flips: number; executions: number }> };
        weeks: number;
        runs: number;
    };
    history: { stability: { runs: number } };
}

/**
 * The project dashboard's quality card: up to five numbers and two lists, each row a link to the test to look at. Hidden until there is
 * history. Workflow steps and pull requests show only when there is something to count; "Bugs confirmed" opens the run that found the
 * latest confirmed bug, where the findings are.
 */
export function QualityCard({ projectId }: { projectId: string }) {
    const q = useFetch<Quality>(`/projects/${projectId}/quality`);
    const confirmed = q.data?.card.numbers.confirmed ?? 0;
    // Newest seen first; the run it was last seen in lists it among Confirmed.
    const findings = useFetch<{ findings: Array<{ state: string; lastJobId: string | null }> }>(confirmed ? `/projects/${projectId}/candidate-findings` : null);
    if (!q.data) return null;
    const { numbers: n, areas, flaky, weeks, runs } = q.data.card;
    if (!q.data.history.stability.runs && !n.confirmed && !n.pullRequests) return null;
    const latestRun = findings.data?.findings.find((f) => f.state === "confirmed" && f.lastJobId)?.lastJobId;
    const metrics = [
        <Metric
            key="confirmed"
            value={latestRun ? <a href={routes.run(projectId, latestRun)} data-testid="quality-confirmed-link">{n.confirmed}</a> : n.confirmed}
            label="Bugs confirmed"
            tip={latestRun ? "Findings that were checked again and failed the same way. The number opens the run that found the latest one." : "Findings that were checked again and failed the same way."}
        />,
        <Metric key="reopened" value={n.reopened} label="Came back after a fix" tone={n.reopened ? "warn" : undefined} tip="Bugs marked fixed that failed again later." />,
        <Metric key="pass" value={n.passRate === null ? "–" : `${n.passRate}%`} label={`Pass rate, last ${runs} runs`} tip="The average of the latest runs' pass rates." />,
        n.workflowSteps && <Metric key="workflow" value={`${n.workflowSteps.exercised} of ${n.workflowSteps.total}`} label="Workflow steps tried" tip="Steps of the application's workflows that the latest exploration tried." />,
        n.pullRequests > 0 && <Metric key="prs" value={n.pullRequests} label="Pull requests checked" tip="Pull requests whose tests were chosen from the change." />,
    ].filter(Boolean);
    return (
        <section className="card divided" aria-labelledby="quality-title" data-testid="quality-card">
            <div className="card-head">
                <Activity size={18} aria-hidden />
                <h2 className="t-section" id="quality-title">
                    Quality
                </h2>
                <span className="t-meta">Last {weeks} weeks</span>
            </div>
            <div className="metrics quality-metrics" data-count={metrics.length}>
                {metrics}
            </div>
            <div className="quality-lists">
                <div data-testid="quality-areas">
                    <h3 className="t-card">Areas that keep failing{areas.total > areas.items.length ? ` (${areas.total})` : ""}</h3>
                    {areas.items.length ? (
                        <ul className="list divided" aria-label="Areas that keep failing">
                            {areas.items.map((a) => (
                                <li key={a.area}>
                                    <a className="list-row" href={routes.test(a.testId)}>
                                        <span className="main">
                                            <code className="title">{a.area}</code>
                                            <span className="meta">
                                                Failed in {a.runs} of the last {runs} runs, {plural(a.tests, "test")}
                                            </span>
                                        </span>
                                        <ChevronRight size={16} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="t-secondary">None in the last {runs} runs.</p>
                    )}
                </div>
                <div data-testid="quality-flaky">
                    <h3 className="t-card">Unreliable tests to fix{flaky.total > flaky.items.length ? ` (${flaky.total})` : ""}</h3>
                    {flaky.items.length ? (
                        <ul className="list divided" aria-label="Unreliable tests to fix">
                            {flaky.items.map((t) => (
                                <li key={t.id}>
                                    <a className="list-row" href={routes.test(t.id)}>
                                        <span className="main">
                                            <span className="title">
                                                <code>{t.testKey}</code> {t.title}
                                            </span>
                                            <span className="meta">
                                                Changed between pass and fail {plural(t.flips, "time")} in {t.executions} runs
                                            </span>
                                        </span>
                                        <ChevronRight size={16} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="t-secondary">None.</p>
                    )}
                </div>
            </div>
        </section>
    );
}
