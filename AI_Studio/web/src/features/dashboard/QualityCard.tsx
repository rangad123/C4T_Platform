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

const hours = (h: number | null) => (h === null ? "–" : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);

/** The project dashboard's quality card: six numbers and two lists, each row a link to the test to look at. Hidden until there is history. */
export function QualityCard({ projectId }: { projectId: string }) {
    const q = useFetch<Quality>(`/projects/${projectId}/quality`);
    if (!q.data) return null;
    const { numbers: n, areas, flaky, weeks, runs } = q.data.card;
    if (!q.data.history.stability.runs && !n.confirmed && !n.pullRequests) return null;
    return (
        <section className="card divided" aria-labelledby="quality-title" data-testid="quality-card">
            <div className="card-head">
                <Activity size={18} aria-hidden />
                <h2 className="t-section" id="quality-title">
                    Quality
                </h2>
                <span className="t-meta">Last {weeks} weeks</span>
            </div>
            <div className="metrics quality-metrics">
                <Metric value={n.confirmed} label="Bugs confirmed" tip="Findings that were checked again and failed the same way." />
                <Metric value={n.reopened} label="Came back after a fix" tone={n.reopened ? "warn" : undefined} tip="Bugs marked fixed that failed again later." />
                <Metric value={n.passRate === null ? "–" : `${n.passRate}%`} label={`Pass rate, last ${runs} runs`} tip="The average of the latest runs' pass rates." />
                <Metric value={n.workflowSteps ? `${n.workflowSteps.exercised} of ${n.workflowSteps.total}` : "–"} label="Workflow steps tried" tip="Steps of the application's workflows that the latest exploration tried." />
                <Metric value={hours(n.hoursToConfirm)} label="Time to confirm" tip="The middle time from a bug first seen to confirmed." />
                <Metric value={n.pullRequests} label="Pull requests checked" tip="Pull requests whose tests were chosen from the change." />
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
