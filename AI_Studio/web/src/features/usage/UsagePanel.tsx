import { useState } from "react";
import { Badge, Callout, Button, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { LimitsForms, PricesForm } from "./UsageForms";
import { HelpTip } from "../../components/Tooltip";
import { costText, exact, LEVEL_TONE, monthName, PURPOSE_LABEL, tokensText, type GroupBy, type Level, type MonthBlock, type UsageAnswer, type UsageGroup } from "./usage";
import "./usage.css";

const LEVEL_WORD: Record<Level, string> = { none: "No limit", ok: "Within the limit", warning: "Close to the limit", reached: "Limit reached" };

/** Settings, "AI usage": this month against its limit, a bar per day, who used it, and the forms for limits and prices. */
export function UsagePanel() {
    const month = useFetch<UsageAnswer>("/usage");
    const [by, setBy] = useState<GroupBy>("project");
    const groups = useFetch<UsageAnswer>(`/usage?groupBy=${by}`);

    const reloadAll = async () => {
        await Promise.all([month.reload(), groups.reload()]);
    };

    return (
        <section className="card card-pad stack" data-testid="usage-panel" aria-labelledby="usage-heading">
            <div className="row">
                <h2 className="t-section" id="usage-heading">
                    AI usage
                </h2>
                <span className="spacer" />
                {month.data && <Badge tone={LEVEL_TONE[month.data.month.level]}>{LEVEL_WORD[month.data.month.level]}</Badge>}
            </div>

            {month.loading ? (
                <div className="stack-sm">
                    <Skeleton h={28} w={200} />
                    <Skeleton h={8} />
                    <Skeleton h={80} />
                </div>
            ) : month.error || !month.data ? (
                <Callout tone="warning" title="Could not load AI usage" actions={<Button size="sm" onClick={() => void month.reload()}>Try again</Button>}>
                    {describeApiError(month.error)} This does not affect your tests.
                </Callout>
            ) : (
                <>
                    <ThisMonth data={month.data} />
                    <DayBars series={month.data.series} />
                    <Breakdown by={by} onBy={setBy} state={groups} currency={month.data.currency} />
                </>
            )}

            <LimitsForms onSaved={reloadAll} />
            <PricesForm onSaved={reloadAll} />
        </section>
    );
}

function ThisMonth({ data }: { data: UsageAnswer }) {
    const m: MonthBlock = data.month;
    const t = data.totals;
    const used = m.usedTokens;
    const width = m.limitTokens ? Math.min(100, Math.round((used / m.limitTokens) * 100)) : 0;
    return (
        <div className="usage-month" data-testid="usage-month">
            <div className="row" style={{ alignItems: "baseline" }}>
                <span className="usage-figure" data-testid="usage-month-tokens">
                    {exact(used)} tokens
                </span>
                <span className="t-secondary">in {monthName(m.month)}, all projects</span>
            </div>
            {m.limitTokens ? (
                <>
                    <div
                        className={`usage-meter ${m.level}`}
                        role="meter"
                        aria-label="AI tokens used this month"
                        aria-valuemin={0}
                        aria-valuemax={m.limitTokens}
                        aria-valuenow={Math.min(used, m.limitTokens)}
                        aria-valuetext={`${exact(used)} of ${exact(m.limitTokens)} tokens`}
                    >
                        <span style={{ width: `${width}%` }} />
                    </div>
                    <p className="t-secondary" data-testid="usage-month-limit">
                        {m.level === "reached"
                            ? `The monthly limit of ${exact(m.limitTokens)} tokens is used up. New AI work stops until you raise the limit or the month ends.`
                            : `${m.percent}% of the monthly limit of ${exact(m.limitTokens)} tokens.${m.level === "warning" ? ` Warnings start at ${m.warnPercent}%.` : ""}`}
                    </p>
                </>
            ) : (
                <p className="t-secondary" data-testid="usage-month-limit">
                    No monthly limit is set. Use the form below to set one.
                </p>
            )}
            <p className="t-meta" data-testid="usage-month-detail">
                {exact(t.inputTokens)} in, {exact(t.outputTokens)} out, {t.calls} {t.calls === 1 ? "call" : "calls"}
                {t.estimated ? ", some counts are estimates because the model did not report them" : ""}.{" "}
                {t.cacheReadTokens || t.cacheWriteTokens ? (
                    <span data-testid="usage-cache-detail">
                        {exact(t.cacheReadTokens ?? 0)} of the input came from the prompt cache and {exact(t.cacheWriteTokens ?? 0)} went into it. Toward the limits, a token read from the cache counts as a tenth of a token and a token written to it as one and a quarter.{" "}
                    </span>
                ) : null}
                {t.escalations ? (
                    <span data-testid="usage-escalations">
                        The fast model handed work to the main model {t.escalations === 1 ? "once" : `${exact(t.escalations)} times`} (escalated to the main model).{" "}
                    </span>
                ) : null}
                {t.cost !== null ? <strong data-testid="usage-cost">Cost so far: {costText(t.cost, data.currency)}</strong> : (data.pricing ?? "")}
                {t.cost !== null && data.pricing ? ` ${data.pricing}` : ""}
            </p>
        </div>
    );
}

/** One small bar per day, drawn as plain SVG from the design tokens (no chart library). */
function DayBars({ series }: { series: UsageGroup[] }) {
    const max = Math.max(1, ...series.map((d) => d.totalTokens));
    const STEP = Math.max(10, Math.floor(480 / Math.max(series.length, 1))); // a viewBox close to the drawn width keeps the labels at a readable size
    const W = Math.max(series.length * STEP, 120);
    const H = 64;
    const busiest = series.reduce((a, b) => (b.totalTokens > a.totalTokens ? b : a), series[0]!);
    const summary = busiest.totalTokens === 0 ? "No AI use yet this month." : `Tokens per day. The busiest day was ${busiest.key} with ${tokensText(busiest.totalTokens)} tokens.`;
    return (
        <figure style={{ margin: 0 }} className="stack-sm" data-testid="usage-days">
            <svg className="usage-days" viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={summary} preserveAspectRatio="none">
                <line x1="0" y1={H + 0.5} x2={W} y2={H + 0.5} />
                {series.map((d, i) => {
                    const h = d.totalTokens === 0 ? 1.5 : Math.max(2, (d.totalTokens / max) * (H - 4));
                    return (
                        <rect key={d.key} className={d.totalTokens === 0 ? "zero" : undefined} x={i * STEP + 1.5} y={H - h} width={STEP - 3} height={h}>
                            <title>{`${d.key}: ${exact(d.totalTokens)} tokens`}</title>
                        </rect>
                    );
                })}
                <text x="1" y={H + 12}>{series[0]?.key.slice(5)}</text>
                <text x={W - 1} y={H + 12} textAnchor="end">{series[series.length - 1]?.key.slice(5)}</text>
            </svg>
            <figcaption className="t-meta">{summary}</figcaption>
        </figure>
    );
}

const BY_LABEL: Record<GroupBy, string> = { project: "By project", purpose: "By purpose", model: "By model" };

function Breakdown({ by, onBy, state, currency }: { by: GroupBy; onBy: (b: GroupBy) => void; state: ReturnType<typeof useFetch<UsageAnswer>>; currency: string }) {
    const rows = state.data?.groups ?? [];
    // The prompt-cache column appears only once something was cached.
    const cached = rows.some((g) => (g.cacheReadTokens ?? 0) > 0);
    const nameOf = (g: UsageGroup) => (by === "purpose" ? (PURPOSE_LABEL[g.key] ?? g.key) : by === "project" ? (g.label ?? g.key) : g.key);
    return (
        <div className="stack-sm">
            <div className="row">
                <h3 className="t-card">
                    Where it went <HelpTip label="the usage table" text="In: tokens sent to the model (page content and instructions). From cache: the part of In the provider read from its prompt cache, at a lower price. Out: tokens the model wrote back. Cost: worked out from the prices you set below." />
                </h3>
                <span className="spacer" />
                <div className="usage-seg" role="group" aria-label="Group usage">
                    {(Object.keys(BY_LABEL) as GroupBy[]).map((b) => (
                        <Button key={b} size="sm" aria-pressed={by === b} onClick={() => onBy(b)}>
                            {BY_LABEL[b]}
                        </Button>
                    ))}
                </div>
            </div>
            {state.loading ? (
                <Skeleton h={90} />
            ) : rows.length === 0 ? (
                <p className="t-secondary" data-testid="usage-empty">
                    No AI use recorded yet this month. It appears here after the first exploration or repair that uses the model.
                </p>
            ) : (
                <div className="usage-table-wrap" tabIndex={0} role="region" aria-label={`AI usage ${BY_LABEL[by].toLowerCase()}`}>
                    <table className="usage-table" data-testid="usage-table">
                        <thead>
                            <tr>
                                <th scope="col">{by === "project" ? "Project" : by === "purpose" ? "Purpose" : "Model"}</th>
                                <th scope="col" className="num">Calls</th>
                                <th scope="col" className="num">In</th>
                                {cached && <th scope="col" className="num">From cache</th>}
                                <th scope="col" className="num">Out</th>
                                <th scope="col" className="num">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((g) => (
                                <tr key={g.key}>
                                    <th scope="row">{nameOf(g)}</th>
                                    <td className="num">{g.calls}</td>
                                    <td className="num">{tokensText(g.inputTokens)}</td>
                                    {cached && <td className="num">{tokensText(g.cacheReadTokens ?? 0)}</td>}
                                    <td className="num">{tokensText(g.outputTokens)}</td>
                                    <td className="num">{g.cost !== null ? costText(g.cost, currency) : "no price"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
