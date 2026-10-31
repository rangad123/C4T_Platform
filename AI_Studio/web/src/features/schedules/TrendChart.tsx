import { CalendarClock, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, EmptyState, ErrorState, Metric, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { help } from "../../lib/help";
import { Tooltip } from "../../components/Tooltip";
import { duration, plural, relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import type { TrendRun, Trends } from "./schedules";
import "./schedules.css";

const W = 640;
const H = 210;
const PAD = { l: 38, r: 14, t: 14, b: 26 };
const PERIODS = [7, 30, 90];

const tone = (rate: number) => (rate >= 100 ? "ok" : rate >= 70 ? "warn" : "bad");
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Pass rate of each recent run as an inline SVG line chart (no chart library), with the runs listed below. */
export function TrendChart({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
    const [days, setDays] = useState(30);
    const trends = useFetch<Trends>(`/projects/${projectId}/trends?days=${days}`);
    // A run finished elsewhere on the page: refresh quietly (no loading flash).
    useEffect(() => {
        if (reloadKey > 0) void trends.reload();
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const data = trends.data;
    const rated = (data?.runs ?? []).filter((r) => r.passRate !== null);

    return (
        <section className="card" aria-labelledby="trend-title">
            <div className="card-head wrap">
                <TrendingUp size={18} aria-hidden />
                <h2 className="t-section" id="trend-title">How your tests are doing</h2>
                <span className="spacer" />
                <div className="chips" role="group" aria-label="Period">
                    {PERIODS.map((d) => (
                        <button key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>
                            {d} days
                        </button>
                    ))}
                </div>
            </div>
            {trends.loading ? (
                <div className="card-pad stack-sm" aria-busy="true" aria-label="Loading">
                    <Skeleton h={140} />
                    <Skeleton w="50%" />
                </div>
            ) : trends.error || !data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(trends.error?.message)} onRetry={trends.reload} />
                </div>
            ) : data.runs.length === 0 ? (
                <EmptyState icon={TrendingUp} title="No runs in this period yet">
                    Each time the tests run — on a schedule or by hand — the result is added here, so you can see whether things are getting better or worse.
                </EmptyState>
            ) : (
                <>
                    <div className="metrics" style={{ borderBottom: "1px solid var(--border-default)" }}>
                        <Metric value={data.summary.latestPassRate === null ? "—" : `${data.summary.latestPassRate}%`} label="Latest pass rate" tip={`${help("metric", "latestPassRate")} ${help("metric", "passRate")}`} tone={data.summary.latestPassRate === 100 ? "ok" : "warn"} />
                        <Metric value={delta(data.summary.passRateDelta)} label={`Change over ${days} days`} tip={help("metric", "passRateChange")} tone={data.summary.passRateDelta !== null && data.summary.passRateDelta < 0 ? "warn" : undefined} />
                        <Metric value={data.summary.averagePassRate === null ? "—" : `${data.summary.averagePassRate}%`} label="Average" tip={`${help("metric", "averagePassRate")} Every run counts once, whatever its size.`} />
                        <Metric value={data.summary.runs} label="Runs" />
                    </div>
                    <div className="card-pad stack-sm">
                        {rated.length > 0 ? <Chart runs={rated} /> : <p className="t-secondary">None of these runs executed tests, so there is no pass rate to draw yet.</p>}
                        <div className="trend-legend" aria-hidden>
                            <span className="key"><span className="swatch ok" />All passed</span>
                            <span className="key"><span className="swatch warn" />70% or more</span>
                            <span className="key"><span className="swatch bad" />Below 70%</span>
                            <span className="key"><span className="swatch sched" />Scheduled run</span>
                        </div>
                    </div>
                    <RunList runs={data.runs} projectId={projectId} />
                </>
            )}
        </section>
    );
}

const delta = (d: number | null) => (d === null ? "—" : d === 0 ? "No change" : `${d > 0 ? "+" : "−"}${Math.abs(d)} points`);

function Chart({ runs }: { runs: TrendRun[] }) {
    const x = (i: number) => (runs.length === 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (runs.length - 1));
    const y = (rate: number) => PAD.t + ((100 - rate) * (H - PAD.t - PAD.b)) / 100;
    const first = runs[0]!;
    const last = runs.at(-1)!;
    const label = `Pass rate over the last ${plural(runs.length, "run")}, from ${first.passRate}% on ${shortDate(first.finishedAt)} to ${last.passRate}% on ${shortDate(last.finishedAt)}.`;
    return (
        <svg className="trend-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
            {[0, 50, 100].map((g) => (
                <g key={g}>
                    <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} />
                    <text className="axis" x={PAD.l - 8} y={y(g) + 4} textAnchor="end">{g}%</text>
                </g>
            ))}
            {runs.length > 1 && <polyline className="line" points={runs.map((r, i) => `${x(i)},${y(r.passRate!)}`).join(" ")} />}
            {runs.map((r, i) => (
                <circle key={r.jobId} className={`pt ${tone(r.passRate!)} ${r.trigger === "schedule" ? "sched" : ""}`} cx={x(i)} cy={y(r.passRate!)} r={5}>
                    <title>{`${new Date(r.finishedAt).toLocaleString()}: ${r.passRate}% passed (${r.validated} of ${r.total})${r.trigger === "schedule" ? ", scheduled run" : ""}`}</title>
                </circle>
            ))}
            <text className="axis" x={PAD.l} y={H - 6}>{shortDate(first.finishedAt)}</text>
            {runs.length > 1 && <text className="axis" x={W - PAD.r} y={H - 6} textAnchor="end">{shortDate(last.finishedAt)}</text>}
        </svg>
    );
}

function RunList({ runs, projectId }: { runs: TrendRun[]; projectId: string }) {
    const recent = [...runs].reverse().slice(0, 8);
    return (
        <div>
            <h3 className="t-card" style={{ padding: "0 20px 8px" }}>Recent runs</h3>
            <ul className="list divided no-lead" style={{ borderTop: "1px solid var(--border-default)" }}>
                {recent.map((r) => {
                    const t = Math.max(r.total, 1);
                    return (
                        <li key={r.jobId}>
                            <Tooltip content={`Finished ${new Date(r.finishedAt).toLocaleString()}`}>
                            <a className="list-row" href={routes.runs(projectId)}>
                                <span className="main">
                                    <span className="title">
                                        {r.total === 0 ? "Run could not complete" : `${r.validated} of ${plural(r.total, "test")} passed`}
                                        {r.passRate !== null && <span className="muted"> · {r.passRate}%</span>}
                                    </span>
                                    <span className="meta">
                                        <time dateTime={r.finishedAt}>{relativeTime(r.finishedAt)}</time>
                                        {r.durationMs !== null && r.durationMs > 0 && ` · took ${duration(r.durationMs)}`}
                                        {r.flaky > 0 && ` · ${plural(r.flaky, "unreliable test")}`}
                                    </span>
                                </span>
                                <span className="tail">
                                    {r.total > 0 && (
                                        <span className="run-mix" aria-hidden>
                                            <span className="ok" style={{ width: `${(r.validated / t) * 100}%` }} />
                                            <span className="warn" style={{ width: `${(r.needsReview / t) * 100}%` }} />
                                            <span className="bad" style={{ width: `${(r.failed / t) * 100}%` }} />
                                        </span>
                                    )}
                                    {r.trigger === "schedule" && <Badge tone="info" icon={CalendarClock}>Scheduled</Badge>}
                                    {r.trigger === "deploy" && <Badge tone="info">After a deploy</Badge>}
                                </span>
                            </a>
                            </Tooltip>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
