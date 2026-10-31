import { CircleCheck, CircleHelp, CircleX, Search, TriangleAlert, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { NewProjectLink } from "../../components/NewProjectLink";
import { Badge, Button, Callout, Disclosure, EmptyState, ListSkeleton, PageHeader, Ribbon } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { friendlyError, plainWords, type Tone } from "../../lib/labels";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { attentionHref, countOf, matches, STATE_HELP, STATE_LABEL, STATE_ORDER, ticksFor, type FleetData, type FleetProject, type Readiness } from "./dashboard";
import { Sparkline } from "./Sparkline";
import { BadgeKey, Tooltip, keyEntries } from "../../components/Tooltip";
import "./dashboard.css";

const STATE_TONE: Record<Readiness, Tone> = { blocked: "danger", "needs-attention": "warning", unknown: "neutral", ready: "success" };
const STATE_ICON: Record<Readiness, LucideIcon> = { blocked: CircleX, "needs-attention": TriangleAlert, unknown: CircleHelp, ready: CircleCheck };

/**
 * The projects page when there are two or more projects: which application is healthy, which needs a look and
 * which should not be released. If the dashboard cannot be loaded the plain list (`fallback`) is shown instead,
 * so the page never gets worse than it was.
 */
export function FleetDashboard({ fallback }: { fallback: ReactNode }) {
    useDocumentTitle("Projects");
    const { data, error, loading, reload } = useFetch<FleetData>("/dashboard", (d) => (d?.projects.some((p) => p.analysis?.active) ? 4000 : null));
    const [filter, setFilter] = useState<Readiness | "all">("all");
    const [q, setQ] = useState("");

    const shown = useMemo(() => (data?.projects ?? []).filter((p) => (filter === "all" || p.readiness.state === filter) && matches(p, q)), [data, filter, q]);

    if (loading) {
        return (
            <>
                <PageHeader title="Projects" subtitle="Checking every project…" />
                <ListSkeleton rows={3} />
            </>
        );
    }
    if (error || !data) {
        const f = friendlyError(error?.message ?? "");
        return (
            <>
                <div style={{ marginBottom: 16 }}>
                    <Callout
                        tone="warning"
                        title="The dashboard could not be loaded"
                        actions={
                            <Button size="sm" onClick={reload}>
                                Try again
                            </Button>
                        }
                    >
                        {f.body} Your projects are listed below.
                    </Callout>
                </div>
                {fallback}
            </>
        );
    }

    const filtering = filter !== "all" || q.trim() !== "";
    return (
        <>
            <PageHeader title="Projects" subtitle={<span aria-live="polite">{data.summary.sentence}</span>} actions={<NewProjectLink />} />

            <div className="dash-tools">
                <div className="chips" role="group" aria-label="Filter by readiness">
                    <button className="chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                        All <span className="n">{data.summary.total}</span>
                    </button>
                    {STATE_ORDER.filter((s) => countOf(data.summary, s) > 0 || filter === s).map((s) => (
                        <button key={s} className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>
                            {STATE_LABEL[s]} <span className="n">{countOf(data.summary, s)}</span>
                        </button>
                    ))}
                    <BadgeKey label="the readiness of the projects" entries={keyEntries(STATE_ORDER, data.projects.map((p) => p.readiness.state), (s) => STATE_LABEL[s], (s) => STATE_HELP[s])} />
                </div>
                <div className="input-wrap dash-search">
                    <Search size={16} className="lead" aria-hidden />
                    <input className="input" type="search" aria-label="Search projects" placeholder="Search by name or address" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
            </div>

            {shown.length === 0 ? (
                <div className="card">
                    <EmptyState
                        icon={Search}
                        title="No projects match"
                        actions={
                            <Button
                                onClick={() => {
                                    setFilter("all");
                                    setQ("");
                                }}
                            >
                                Clear filters
                            </Button>
                        }
                    >
                        Nothing matches the filter and search. Clear them to see every project.
                    </EmptyState>
                </div>
            ) : (
                <ul className="card dash-list divided" aria-label="Projects">
                    {shown.map((p) => (
                        <ProjectRow key={p.id} p={p} />
                    ))}
                </ul>
            )}
            {filtering && shown.length > 0 && (
                <p className="t-meta" style={{ marginTop: 12 }} role="status">
                    Showing {shown.length} of {data.summary.total} projects.
                </p>
            )}

            <div style={{ marginTop: 24 }}>
                <Disclosure label="How readiness is decided">
                    <div className="dash-rules">
                        {data.rules.map((r) => (
                            <section key={r.state}>
                                <h2 className="t-card">{r.label}</h2>
                                <p className="t-meta">{plainWords(r.summary)}</p>
                                <ul>
                                    {r.when.map((w) => (
                                        <li key={w}>{plainWords(w)}</li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                </Disclosure>
            </div>
        </>
    );
}

function scheduleText(s: FleetProject["schedule"]): string {
    if (!s.exists) return "No schedule";
    if (s.enabled === 0) return "Schedule paused";
    if (s.lastRunOk === false) return "Last scheduled run failed";
    if (s.lastRunOk === true) return "Scheduled, last run worked";
    return "Scheduled, no run yet";
}

function ProjectRow({ p }: { p: FleetProject }) {
    const { state, reasons } = p.readiness;
    const Icon = STATE_ICON[state];
    const top = reasons.slice(0, 2);
    const more = reasons.length - top.length;
    const ticks = ticksFor(p.tests);
    const rate = p.latestRun?.passRate ?? null;
    const trendLabel = p.trend.length
        ? `Pass rate of the last ${plural(p.trend.length, "run")}: ${p.trend.map((t) => (t.passRate === null ? "no tests ran" : `${Math.round(t.passRate)}%`)).join(", ")}`
        : "No runs yet";
    const needAttention = p.tests.needsAttention + p.tests.couldNotValidate;

    return (
        <li className={`dash-row ${state}`}>
            <div className="dash-main">
                <div className="dash-title">
                    <Badge tone={STATE_TONE[state]} icon={Icon} tip={STATE_HELP[state]}>
                        {STATE_LABEL[state]}
                    </Badge>
                    <a className="dash-name truncate" href={routes.project(p.id)}>
                        {p.name}
                    </a>
                </div>
                <div className="t-meta truncate">
                    {p.host || "No application yet"}
                    <span className="dot-sep" />
                    {p.analysis?.active ? "Running now" : p.lastRunAt ? `Last run ${relativeTime(p.lastRunAt)}` : "Never run"}
                </div>
                {top.length > 0 ? (
                    <ul className="dash-reasons" aria-label={`Why ${p.name} is ${STATE_LABEL[state].toLowerCase()}`}>
                        {top.map((r) => (
                            <li key={r.code}>{plainWords(r.text)}</li>
                        ))}
                        {more > 0 && <li className="t-meta">and {more} more</li>}
                    </ul>
                ) : (
                    <p className="t-meta dash-clear">Nothing needs attention.</p>
                )}
                <div className="dash-links">
                    {needAttention > 0 && (
                        <Tooltip content={p.tests.needsAttention > 0 ? "Opens this project’s tests that need a look." : "Opens this project’s failing tests."}>
                            <a href={attentionHref(p)}>Attention list</a>
                        </Tooltip>
                    )}
                    <a href={routes.runs(p.id)}>Runs</a>
                    <a href={routes.releases(p.id)}>Releases</a>
                </div>
            </div>

            <div className="dash-figs">
                {ticks.length > 0 ? (
                    <div className="dash-fig">
                        <Ribbon
                            small
                            ticks={ticks}
                            label={`${plural(p.tests.total, "test")}: ${p.tests.validated} passing, ${p.tests.needsAttention} need a look, ${p.tests.couldNotValidate} failing, ${p.tests.waiting} not run yet`}
                        />
                        <span className="t-meta">
                            {p.tests.validated} of {plural(p.tests.total, "test")} passing
                        </span>
                    </div>
                ) : (
                    <div className="dash-fig">
                        <span className="t-meta">No tests yet</span>
                    </div>
                )}
                <div className="dash-fig">
                    {/* One run is a dot, not a trend: the sparkline needs at least two. */}
                    {p.trend.length > 1 ? <Sparkline points={p.trend} label={trendLabel} /> : null}
                    <span className="t-meta">{rate === null ? (p.latestRun ? "No tests ran last time" : "No runs yet") : p.latestRun?.sentence ? `Last run: ${p.latestRun.sentence.replace(/.$/, "")} (${Math.round(rate)}%).` : `${Math.round(rate)}% of the tests that ran passed in the last run`}</span>
                    {rate !== null && p.latestRun?.others ? <span className="t-meta">{p.latestRun.others}</span> : null}
                </div>
                <div className="t-meta">{scheduleText(p.schedule)}</div>
            </div>
        </li>
    );
}
