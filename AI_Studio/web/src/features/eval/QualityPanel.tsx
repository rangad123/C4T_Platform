import { Copy, Gauge } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Disclosure, EmptyState, Skeleton } from "../../components/ui";
import { BadgeKey, HelpTip, Tooltip, keyEntries } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { duration, FAILURE_WORD, HEADLINE, OUTCOME_WORD, pct, STATUS_WORD, when, type Change, type MetricChange, type RunDetail, type RunSummary } from "./eval";
import "./eval.css";

const COMMAND = "node scripts/eval.mjs";

/** Settings, "Quality of the AI tester": the evaluation runs the harness kept, newest first, each compared with the run before it. */
export function QualityPanel() {
    const runs = useFetch<{ runs: RunSummary[] }>("/eval/runs");
    return (
        <section className="card card-pad stack" data-testid="quality-panel" aria-labelledby="quality-heading">
            <div className="stack-sm">
                <h2 className="t-section" id="quality-heading">
                    Quality of the AI tester
                </h2>
                <p className="t-secondary">How well the AI tester did on your own list of websites and apps. Each run comes from the evaluation command and is compared with the run before it.</p>
            </div>
            {runs.loading ? (
                <div className="stack-sm" aria-busy="true">
                    <Skeleton h={56} />
                    <Skeleton h={56} />
                </div>
            ) : runs.error || !runs.data ? (
                <Callout tone="warning" title="Could not load the evaluation runs" actions={<Button size="sm" onClick={() => void runs.reload()}>Try again</Button>}>
                    {describeApiError(runs.error)} This does not affect your tests.
                </Callout>
            ) : runs.data.runs.length === 0 ? (
                <EmptyState icon={Gauge} title="No evaluation runs yet" actions={<CopyCommand />}>
                    Run the evaluation on the computer that has this platform to measure the AI tester on the apps listed in eval/corpus.json. It uses your AI model, so it costs money.
                </EmptyState>
            ) : (
                <>
                    <ul className="eval-runs" aria-label="Evaluation runs">
                        {runs.data.runs.map((r) => (
                            <RunRow key={r.id} run={r} onRemoved={() => void runs.reload()} />
                        ))}
                    </ul>
                    <p className="t-secondary eval-hint">
                        Run it again with <code className="mono">{COMMAND}</code>. See docs/features/evaluation.md for the options and what each measure means.
                    </p>
                </>
            )}
        </section>
    );
}

function CopyCommand() {
    const [copied, setCopied] = useState(false);
    return (
        <div className="eval-command">
            <code className="mono">{COMMAND}</code>
            <Button
                size="sm"
                icon={Copy}
                onClick={() => {
                    void navigator.clipboard?.writeText(COMMAND).then(
                        () => setCopied(true),
                        () => setCopied(false),
                    );
                }}
            >
                {copied ? "Copied" : "Copy command"}
            </Button>
        </div>
    );
}

const hintOf = (key: (typeof HEADLINE)[number]["key"]) => HEADLINE.find((h) => h.key === key)!.hint;

const changeOf = (c: MetricChange[] | undefined, metric: string): Change | undefined => c?.find((x) => x.metric === metric)?.change;

function ChangeBadge({ change }: { change?: Change }) {
    if (change === "better") return <Badge tone="success" tip="Better than in the evaluation run before this one.">Better</Badge>;
    if (change === "worse") return <Badge tone="danger" tip="Worse than in the evaluation run before this one.">Worse</Badge>;
    return null;
}

/** What each entry result means (src/eval/harness.ts). */
const ENTRY_HELP: Record<keyof typeof STATUS_WORD, string> = {
    done: "The application was explored, tests were created and each was run again to check it is stable.",
    planned: "The application was explored and tests were planned; nothing was created or run (a plan-only evaluation).",
    skipped: "This entry was not started, for example because its sign-in details or app file were missing or the evaluation was stopped. The reason is shown.",
    failed: "The entry started but could not finish; the reason is shown.",
};

function RunRow({ run, onRemoved }: { run: RunSummary; onRemoved: () => void }) {
    const [open, setOpen] = useState(false);
    const o = run.overall;
    return (
        <li className="eval-run" data-testid="eval-run">
            <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
                <summary>
                    <span className="eval-run-head">
                        <span className="title">{when(run.startedAt)}</span>
                        <span className="t-secondary">
                            {run.corpus}, {o.entriesDone} of {o.entries} {o.entries === 1 ? "entry" : "entries"} finished{run.planOnly ? ", plan only" : `, ${o.created} tests`}
                        </span>
                    </span>
                    <span className="eval-scores">
                        {HEADLINE.map((h) => (
                            <Tooltip key={h.key} content={h.hint}>
                                {/* Inside the summary a tab stop per number would be noise: hover shows it here, the table headings below have the same words for the keyboard. */}
                                <span className="eval-score" tabIndex={-1}>
                                    <span className="lbl">{h.label}</span>
                                    <span className="num" data-testid={`eval-${h.key}`}>
                                        {pct(o.rates[h.key])}
                                    </span>
                                    <ChangeBadge change={changeOf(run.comparison?.overall, `rates.${h.key}`)} />
                                </span>
                            </Tooltip>
                        ))}
                    </span>
                </summary>
                {open && <RunDetailView id={run.id} onRemoved={onRemoved} />}
            </details>
        </li>
    );
}

const COMPARE_LABEL: Record<string, string> = {
    "rates.firstPass": "Passing first time",
    "rates.stable": "Stable",
    "rates.flaky": "Flaky",
    "rates.coverage": "Coverage",
    "rates.duplicates": "Duplicates",
    "rates.testWrong": "Failing because the test is wrong",
    planned: "Tests planned",
    created: "Tests created",
    durationMs: "Time",
    aiCalls: "AI calls",
    cost: "Cost",
    safetyRefusals: "Actions refused as unsafe",
};
const shown = (metric: string, v: number | null) => (v === null ? "Not measured" : metric.startsWith("rates.") ? pct(v) : metric === "durationMs" ? duration(v) : String(v));

function RunDetailView({ id, onRemoved }: { id: string; onRemoved: () => void }) {
    const detail = useFetch<RunDetail>(`/eval/runs/${id}`);
    const [confirming, setConfirming] = useState(false);
    const [removeError, setRemoveError] = useState<string>();
    if (detail.loading) return <div className="eval-detail" aria-busy="true"><Skeleton h={90} /></div>;
    if (detail.error || !detail.data)
        return (
            <div className="eval-detail">
                <Callout tone="warning" title="Could not load this run" actions={<Button size="sm" onClick={() => void detail.reload()}>Try again</Button>}>
                    {describeApiError(detail.error)}
                </Callout>
            </div>
        );
    const d = detail.data;
    const o = d.overall;
    const moved = d.comparison?.overall.filter((c) => c.change !== "same") ?? [];
    return (
        <div className="eval-detail stack-sm" data-testid="eval-detail">
            <p className="t-secondary">
                {d.run.planOnly ? "Explored and planned only: nothing was created or run." : `Every created test was run ${d.run.repeat} more times.`} AI model {d.run.platform.model}. {o.aiCalls} AI calls, {duration(o.durationMs)}.
                {o.created > 0 && ` Of the tests that kept failing, ${o.failingProduct} look like product problems and ${o.failingTestWrong} like a wrong test (a guess from the reason, check a few).`}
            </p>
            {d.run.gates?.length ? (
                <ul className="eval-gates" aria-label="Quality gates">
                    {d.run.gates.map((g) => (
                        <li key={g.name}>
                            <Badge tone={g.passed ? "success" : "danger"}>{g.passed ? "Gate passed" : "Gate failed"}</Badge> <span>{g.message}</span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <div className="eval-table-wrap">
                <table className="eval-table">
                    <caption className="sr-only">Entries of this run</caption>
                    <thead>
                        <tr>
                            <th scope="col">Entry</th>
                            <th scope="col">
                                Result <BadgeKey label="the results" entries={keyEntries(["done", "planned", "skipped", "failed"] as const, d.run.entries.map((e) => e.status), (s) => STATUS_WORD[s], (s) => ENTRY_HELP[s])} />
                            </th>
                            <th scope="col" className="num">Planned</th>
                            <th scope="col" className="num">Created</th>
                            <th scope="col" className="num">Stable <HelpTip label="Stable" text={hintOf("stable")} /></th>
                            <th scope="col" className="num">Flaky <HelpTip label="Flaky" text={hintOf("flaky")} /></th>
                            <th scope="col" className="num">Coverage <HelpTip label="Coverage" text={hintOf("coverage")} /></th>
                        </tr>
                    </thead>
                    <tbody>
                        {d.run.entries.map((e) => (
                            <tr key={e.id}>
                                <th scope="row">
                                    <span className="mono">{e.id}</span>
                                    <span className="t-secondary eval-kind">{e.kind === "web" ? "Website" : "Android app"}</span>
                                </th>
                                <td>
                                    {STATUS_WORD[e.status]}
                                    {e.reason && <span className="t-secondary eval-reason">{e.reason}</span>}
                                </td>
                                <td className="num">{e.metrics?.planned ?? ""}</td>
                                <td className="num">{e.metrics?.created ?? ""}</td>
                                <td className="num">{e.metrics ? pct(e.rates?.stable) : ""}</td>
                                <td className="num">{e.metrics ? pct(e.rates?.flaky) : ""}</td>
                                <td className="num">{e.metrics ? `${e.metrics.covered} of ${e.metrics.found} ${e.metrics.coverageUnit}` : ""}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {d.run.entries.some((e) => e.tests?.some((t) => t.outcome !== "stable-pass")) && (
                <Disclosure label="Tests to look at">
                    <ul className="eval-tests">
                        {d.run.entries.flatMap((e) =>
                            (e.tests ?? [])
                                .filter((t) => t.outcome !== "stable-pass")
                                .slice(0, 30)
                                .map((t) => (
                                    <li key={`${e.id}-${t.id}`}>
                                        <span>{t.title}</span> <span className="mono t-secondary">{t.testId}</span>
                                        <span className="t-secondary">
                                            {" "}
                                            {e.id}: {OUTCOME_WORD[t.outcome]}
                                            {t.failure ? `, ${FAILURE_WORD[t.failure]}` : ""}
                                            {t.reason ? `. ${t.reason}` : ""}
                                        </span>
                                    </li>
                                )),
                        )}
                    </ul>
                </Disclosure>
            )}
            {d.comparison ? (
                <div className="stack-sm">
                    <h3 className="t-card">Compared with the run of {when(d.comparison.comparedWith.startedAt)}</h3>
                    {moved.length === 0 ? (
                        <p className="t-secondary">No measure moved.</p>
                    ) : (
                        <ul className="eval-changes" data-testid="eval-changes">
                            {moved.map((c) => (
                                <li key={c.metric}>
                                    <span>{COMPARE_LABEL[c.metric] ?? c.metric}</span>
                                    <span className="t-secondary">
                                        {shown(c.metric, c.previous)} to {shown(c.metric, c.current)}
                                    </span>
                                    <ChangeBadge change={c.change} />
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : (
                <p className="t-secondary">This is the first kept run of “{d.corpus}”{d.planOnly ? " (plan only)" : ""}, so there is nothing to compare with yet.</p>
            )}
            <div className="row eval-actions">
                {confirming ? (
                    <>
                        <span className="t-secondary">Remove this run from the list? The projects it created stay.</span>
                        <Button
                            size="sm"
                            variant="danger"
                            onClick={async () => {
                                try {
                                    await api(`/eval/runs/${id}`, { method: "DELETE" });
                                    onRemoved();
                                } catch (e) {
                                    setRemoveError(describeApiError(e));
                                }
                            }}
                        >
                            Remove run
                        </Button>
                        <Button size="sm" onClick={() => setConfirming(false)}>
                            Keep it
                        </Button>
                    </>
                ) : (
                    <Button size="sm" onClick={() => setConfirming(true)}>
                        Remove run
                    </Button>
                )}
            </div>
            {removeError && <Callout tone="danger" title="Could not remove the run">{removeError}</Callout>}
        </div>
    );
}
