import { Badge, Disclosure } from "../../components/ui";
import { BadgeKey, HelpTip, Tooltip, keyEntries } from "../../components/Tooltip";
import { routes } from "../../lib/router";
import { BENCH_HEADLINE, CATEGORY_HELP, CATEGORY_WORD, duration, pct, type BenchHeadline, type Benchmark, type FindingCategory } from "./eval";

const money = (v: number | null) => (v === null ? "Not priced" : `$${v.toFixed(2)}`);
const TONE: Record<FindingCategory, "success" | "danger" | "warning" | "neutral"> = { confirmed: "success", combined: "success", false_positive: "danger", unreproduced: "warning" };

/** The headline numbers of a benchmark run, in the run list. */
export function BenchmarkScores({ b }: { b: BenchHeadline }) {
    return (
        <span className="eval-scores">
            {BENCH_HEADLINE.map((h) => (
                <Tooltip key={h.key} content={h.hint}>
                    <span className="eval-score" tabIndex={-1}>
                        <span className="lbl">{h.label}</span>
                        <span className="num" data-testid={`bench-${h.key}`}>
                            {pct(b[h.key])}
                        </span>
                    </span>
                </Tooltip>
            ))}
        </span>
    );
}

/** One benchmark run: the configuration, the numbers, and every seeded defect and finding with its test. */
export function BenchmarkView({ b }: { b: Benchmark }) {
    const m = b.metrics;
    const c = b.config;
    const categories = b.apps.flatMap((a) => a.findings.map((f) => f.category));
    return (
        <div className="stack-sm" data-testid="bench-detail">
            <h3 className="t-card">
                Seeded-defect benchmark ({b.mode === "discovery" ? "finding defects that are already there" : "noticing defects added after the tests were made"}){b.baseline ? ", baseline" : ""}
            </h3>
            <p className="t-secondary">
                Found {m.detected} of {m.seeded} seeded defects, confirmed by replaying each finding against the app with and without them. {m.findings} findings reported, {m.falsePositives} false positives, {m.unreproduced} not reproduced. Model {c.model.provider} {c.model.model}
                {c.model.fastModel ? `, fast model ${c.model.fastModel}` : ""}. Engine {c.engineCommit.slice(0, 12)}
                {c.engineDirty ? " with uncommitted changes" : ""}. {money(m.cost)} estimated AI cost, {duration(m.durationMs)}.
            </p>
            <div className="eval-table-wrap">
                <table className="eval-table">
                    <caption className="sr-only">Benchmark numbers</caption>
                    <thead>
                        <tr>
                            <th scope="col">Measure</th>
                            <th scope="col" className="num">Value</th>
                        </tr>
                    </thead>
                    <tbody>
                        {BENCH_HEADLINE.map((h) => (
                            <tr key={h.key}>
                                <th scope="row">
                                    {h.label} <HelpTip label={h.label} text={h.hint} />
                                </th>
                                <td className="num">{pct(m[h.key])}</td>
                            </tr>
                        ))}
                        <tr>
                            <th scope="row">Time to the first confirmed defect</th>
                            <td className="num">{m.detectionTimeMs === null ? "None found" : duration(m.detectionTimeMs)}</td>
                        </tr>
                        <tr>
                            <th scope="row">Cost per confirmed defect</th>
                            <td className="num">{money(m.costPerConfirmedDefect)}</td>
                        </tr>
                        <tr>
                            <th scope="row">Tests created, areas reached</th>
                            <td className="num">
                                {m.testsGenerated}, {m.workflowsCovered} of {m.workflows}
                            </td>
                        </tr>
                        <tr>
                            <th scope="row">AI calls, tokens in and out</th>
                            <td className="num">
                                {m.aiCalls}, {m.inputTokens.toLocaleString()} and {m.outputTokens.toLocaleString()}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            {b.apps.map((a) => (
                <Disclosure key={a.id} label={`${a.id}: ${a.status === "done" ? `found ${a.metrics.detected} of ${a.metrics.seeded}` : a.status === "skipped" ? "skipped" : "could not finish"}`}>
                    <div className="stack-sm">
                        {a.reason && <p className="t-secondary">{a.reason}</p>}
                        {a.defects.length > 0 && (
                            <div className="eval-table-wrap">
                                <table className="eval-table">
                                    <caption className="sr-only">Seeded defects of {a.id}</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">Defect</th>
                                            <th scope="col">Kind</th>
                                            <th scope="col">Area</th>
                                            <th scope="col">Found</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {a.defects.map((d) => (
                                            <tr key={d.id}>
                                                <th scope="row">
                                                    <span className="mono">{d.id}</span>
                                                </th>
                                                <td>
                                                    {d.category}, {d.severity}
                                                </td>
                                                <td>{d.workflow}</td>
                                                <td>
                                                    {d.detected ? <Badge tone="success">Found</Badge> : d.labeledOnly ? <Badge tone="warning">Only by a person's label</Badge> : <Badge tone="neutral">Missed</Badge>}
                                                    {d.findings.length > 0 && <span className="t-secondary eval-kind mono">{d.findings.join(", ")}</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {a.findings.length > 0 && (
                            <div className="stack-sm">
                                <p className="t-secondary">
                                    Findings <BadgeKey label="the finding results" entries={keyEntries(["confirmed", "combined", "false_positive", "unreproduced"] as const, categories, (k) => CATEGORY_WORD[k], (k) => CATEGORY_HELP[k])} />
                                </p>
                                <ul className="eval-tests" aria-label={`Findings of ${a.id}`}>
                                    {a.findings.map((f) => (
                                        <li key={f.id}>
                                            <a href={routes.test(f.id)}>{f.title}</a> <span className="mono t-secondary">{f.testKey}</span>{" "}
                                            <Badge tone={TONE[f.category]} tip={CATEGORY_HELP[f.category]}>
                                                {CATEGORY_WORD[f.category]}
                                            </Badge>
                                            {f.defects.length > 0 && <span className="t-secondary"> {f.defects.join(", ")}</span>}
                                            {f.label && <span className="t-secondary"> labelled {f.label === "false_positive" ? "false positive" : f.label}</span>}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                </Disclosure>
            ))}
            {b.notes.length > 0 && (
                <ul className="eval-gates" aria-label="Benchmark notes">
                    {b.notes.map((n) => (
                        <li key={n}>{n}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}
