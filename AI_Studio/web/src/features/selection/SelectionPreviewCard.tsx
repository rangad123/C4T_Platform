import { GitBranch, ScanSearch } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Metric } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { linesOf, SOURCE_WORDS, type DetectedChanges, type SelectionPreview, type SelectionTest } from "./selection";

/**
 * "Which tests would a change call for?" beside the deploy tokens. A person names changed pages and endpoints (or takes the ones the
 * platform detected) and sees which tests touch them and why. It is a recommendation only: nothing is run or skipped, and a deploy
 * still runs every runnable test.
 */
export function SelectionPreviewCard({ projectId }: { projectId: string }) {
    const [pages, setPages] = useState("");
    const [endpoints, setEndpoints] = useState("");
    const [busy, setBusy] = useState<"preview" | "detected" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [result, setResult] = useState<SelectionPreview | null>(null);

    const preview = async () => {
        setBusy("preview");
        setError(null);
        try {
            setResult(await api<SelectionPreview>(`/projects/${projectId}/selection-preview`, { method: "POST", body: { pages: linesOf(pages), endpoints: linesOf(endpoints) } }));
        } catch (e) {
            setResult(null);
            setError(describeApiError(e));
        } finally {
            setBusy(null);
        }
    };
    const useDetected = async () => {
        setBusy("detected");
        setError(null);
        setNote(null);
        try {
            const d = await api<DetectedChanges>(`/projects/${projectId}/selection-preview/detected-changes`);
            setPages(d.pages.join("\n"));
            setEndpoints(d.endpoints.join("\n"));
            setNote(d.message ?? d.sources.join(" "));
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(null);
        }
    };
    const empty = linesOf(pages).length === 0 && linesOf(endpoints).length === 0;

    return (
        <section className="card" aria-labelledby="selection-title" data-testid="selection-preview">
            <div className="card-head wrap">
                <ScanSearch size={18} aria-hidden />
                <h2 className="t-section" id="selection-title">Which tests a change calls for</h2>
            </div>
            <div className="card-pad stack-sm">
                <p className="t-secondary">Name the pages and endpoints a release changes. The preview shows which tests open or call them, and why. It never runs or skips a test: a deploy still runs every runnable test.</p>
                <div className="field">
                    <label htmlFor="sel-pages">Changed pages, one per line</label>
                    <textarea id="sel-pages" className="input" rows={3} maxLength={20_000} value={pages} placeholder={"/checkout\n/orders/{id}"} onChange={(e) => setPages(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="sel-endpoints">Changed endpoints, one per line (a method and a path)</label>
                    <textarea id="sel-endpoints" className="input" rows={3} maxLength={20_000} value={endpoints} placeholder={"POST /api/orders\nGET /api/orders/{id}"} onChange={(e) => setEndpoints(e.target.value)} />
                </div>
                <div className="row wrap">
                    <Button variant="primary" icon={ScanSearch} loading={busy === "preview"} disabled={empty || busy !== null} tip={empty ? "Name at least one changed page or endpoint first." : undefined} onClick={() => void preview()}>
                        Preview the tests
                    </Button>
                    <Button icon={GitBranch} loading={busy === "detected"} disabled={busy !== null} tip="Fill in what earlier runs and analyses saw change: API responses and the pages the last analysis found different." onClick={() => void useDetected()}>
                        Use detected changes
                    </Button>
                </div>
                {note && <p className="t-meta" data-testid="selection-detected-note">{note}</p>}
                {error && <Callout tone="danger">{error}</Callout>}
                {result && <PreviewResult r={result} />}
            </div>
        </section>
    );
}

function PreviewResult({ r }: { r: SelectionPreview }) {
    return (
        <div className="stack-sm" data-testid="selection-result" aria-live="polite">
            <Callout tone="info" title="Recommendation only">
                {r.note}
            </Callout>
            {r.fullRunRequired && (
                <Callout tone="warning" title="A full run is required">
                    <div data-testid="selection-full-run">
                        The preview could not judge everything, so only running every test is safe:
                        <ul>
                            {r.fullRunReasons.map((why) => (
                                <li key={why}>{why}</li>
                            ))}
                        </ul>
                    </div>
                </Callout>
            )}
            <div className="row wrap">
                <Metric value={r.counts.proposed} label="tests proposed" tip="Tests that touch a change, plus tests whose coverage is not fully known." />
                <Metric value={r.counts.unknown} label="with unknown coverage" tone={r.counts.unknown ? "warn" : undefined} tip="Proposed because what they touch is not fully known. A missing mapping never leaves a test out." />
                <Metric value={r.counts.notMatched} label="not matched" tip="Their pages and endpoints are fully known and none is in the change." />
                {r.counts.cannotRun > 0 && <Metric value={r.counts.cannotRun} label="cannot run" tone="warn" tip="Their steps cannot be read, or your runner leaves them out of runs. Each says why." />}
            </div>
            {r.ignored.length > 0 && (
                <Callout tone="warning" title="Some entries were not used">
                    <ul>
                        {r.ignored.map((i) => (
                            <li key={i.given}>
                                <code>{i.given}</code>: {i.why}
                            </li>
                        ))}
                    </ul>
                </Callout>
            )}
            {r.uncoveredChanges.length > 0 && (
                <p className="t-meta" data-testid="selection-uncovered">
                    No known coverage reaches: {r.uncoveredChanges.map((c, i) => <code key={c}>{i ? ", " : ""}{c}</code>)}.
                </p>
            )}
            <Group title="Proposed: touch a change" tests={r.matched} testId="selection-matched" />
            <Group title="Proposed: coverage unknown" tests={r.unknown} testId="selection-unknown" />
            <Group title="Not matched" tests={r.notMatched} testId="selection-not-matched" collapsed />
            <Group title="Cannot run" tests={r.cannotRun} testId="selection-cannot-run" />
            {r.triggers.some((t) => t.parity === "same") && (
                <p className="t-meta" data-testid="selection-triggers-same">
                    Deploy triggers that run the same tests as your runner: {r.triggers.filter((t) => t.parity === "same").map((t) => t.trigger).join(", ")}.
                </p>
            )}
            <p className="t-meta">A test's recorded coverage counts only when its latest run passed on its current version within the last {r.freshDays} days.</p>
            {r.notProcessed.length > 0 && (
                <p className="t-meta" data-testid="selection-not-processed">
                    Not compared with any test: {r.notProcessed.length} {r.notProcessed.length === 1 ? "entry" : "entries"} past the limit.
                </p>
            )}
        </div>
    );
}

function Group({ title, tests, testId, collapsed }: { title: string; tests: SelectionTest[]; testId: string; collapsed?: boolean }) {
    if (tests.length === 0) return null;
    const list = (
        <ul className="list divided" aria-label={title}>
            {tests.map((t) => (
                <li key={t.testId} className="list-row" data-test={t.testKey}>
                    <span className="main">
                        <span className="title">
                            <code>{t.testKey}</code> {t.title}
                        </span>
                        {t.reasons.map((reason, i) => (
                            <span key={i} className="meta">
                                <Badge tone={reason.source === "observed" ? "brand" : "neutral"} tip={SOURCE_WORDS[reason.source].tip} tipFocusable>
                                    {SOURCE_WORDS[reason.source].label}
                                </Badge>{" "}
                                {reason.sentence}
                            </span>
                        ))}
                        {t.why && <span className="meta">{t.why}</span>}
                        {t.notes?.map((n) => (
                            <span key={n} className="meta" data-testid="selection-test-note">
                                {n}
                            </span>
                        ))}
                    </span>
                </li>
            ))}
        </ul>
    );
    return (
        <div data-testid={testId}>
            {collapsed ? (
                <details>
                    <summary>
                        {title} ({tests.length})
                    </summary>
                    {list}
                </details>
            ) : (
                <>
                    <h3 className="t-card">
                        {title} ({tests.length})
                    </h3>
                    {list}
                </>
            )}
        </div>
    );
}
