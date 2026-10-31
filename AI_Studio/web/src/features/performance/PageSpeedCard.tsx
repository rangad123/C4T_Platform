import { Gauge } from "lucide-react";
import { Badge, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { HelpTip } from "../../components/Tooltip";
import { METRIC_HELP, METRIC_LABEL, METRIC_ORDER, formatValue, sparkPoints, verdictOf, VERDICT_TEXT, type SpeedHistory } from "./performance";
import "./performance.css";

/** What the last run measured for a page-speed test, against its budgets, with a small history line per metric. */
export function PageSpeedCard({ testId, kind = "web" }: { testId: string; kind?: "web" | "api" | "mobile" }) {
    const speed = useFetch<SpeedHistory>(`/tests/${testId}/performance`);
    if (speed.loading) {
        return (
            <section className="section stack-sm" aria-label="Page speed">
                <Skeleton h={18} w={140} />
                <Skeleton h={80} />
            </section>
        );
    }
    if (speed.error || !speed.data) return null; // the test page still works without it
    // A load check records its own set of values (see engine/performance/load.ts); counts that are zero are left out to keep the list short.
    const isLoad = speed.data.latest.some((m) => m.metric.startsWith("load_"));
    const rows = [...speed.data.latest]
        .filter((m) => !(isLoad && ["load_4xx", "load_5xx", "load_429", "load_network"].includes(m.metric) && m.value === 0))
        .sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric));
    const users = speed.data.latest.find((m) => m.metric === "load_users")?.value;
    const title = isLoad ? (users ? `Handles ${Math.round(users)} users at once` : "Handles several users at once") : kind === "api" ? "Response speed" : "Page speed";
    const how = isLoad ? "read-only requests, about 10 seconds, at most 300" : kind === "api" ? "one request at a time" : "median of 3 fresh loads";
    return (
        <section className="section stack-sm" aria-label={title} data-testid={isLoad ? "load-check" : "page-speed"}>
            <div className="row">
                <Gauge size={18} aria-hidden />
                <h2 className="t-section">{title}</h2>
                <span className="t-meta">{how}{speed.data.history.length > 1 ? `, ${speed.data.history.length} runs recorded` : ""}</span>
            </div>
            {rows.length === 0 ? (
                <p className="t-secondary">{isLoad ? "No measurements yet. Run the test to see how the endpoint copes with several users." : "No measurements yet. Run the test to see how fast this page loads."}</p>
            ) : (
                <ul className="speed-list">
                    {rows.map((m) => {
                        const verdict = verdictOf(m);
                        const series = speed.data!.history.map((h) => h.values[m.metric]).filter((v): v is number => typeof v === "number");
                        const points = sparkPoints(series);
                        return (
                            <li key={m.metric} className="speed-row" data-metric={m.metric}>
                                <span className="speed-name">
                                    {METRIC_LABEL[m.metric] ?? m.metric}
                                    {METRIC_HELP[m.metric] && <HelpTip label={METRIC_LABEL[m.metric] ?? m.metric} text={METRIC_HELP[m.metric]} />}
                                </span>
                                <span className="speed-value">{formatValue(m)}</span>
                                <span className="speed-budget">{m.budget === undefined ? "" : `budget ${formatValue({ ...m, value: m.budget })}`}</span>
                                {verdict !== "none" && <Badge tone={verdict === "good" ? "success" : "warning"}>{VERDICT_TEXT[verdict]}</Badge>}
                                {points && (
                                    <svg className="speed-spark" width="120" height="28" viewBox="0 0 120 28" role="img" aria-label={`${METRIC_LABEL[m.metric] ?? m.metric} over the last ${series.length} runs`}>
                                        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
                                    </svg>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
