import { ChevronRight, CircleSlash, Download, LoaderCircle, Network, OctagonPause, TriangleAlert, X } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "../../components/ui";
import { OutcomeTree } from "./OutcomeTree";
import { PRIORITY_LABEL, TYPE_LABEL, buildTree, casesForNode, lastRunNote, nodeCaseCounts, notOpenedLine, plural, summaryLine, unplacedCases, type CaseOutcome as Outcome, type CaseOutcomeCase } from "./outcome";
import "./outcome.css";

/**
 * The outcome report of a Test Case Generation project (founder 2026-11-19 P3, P7, R8, R15): one summary line, one tree of the
 * application's pages with the number of test cases on each, the selected page's test cases, the addresses that could not be opened (once,
 * apart from the pages), what the understanding says is missing, and one download. Nothing else: no pass or fail, no runs of tests.
 *
 * `downloadHref` is the workbook's address (GET /api/projects/:id/outcome/workbook); leave it out when the person may not export, and the
 * button is not shown. `emptyActions` is what the page offers when there is nothing yet (for example "Explore").
 */
export function CaseOutcome({ outcome, downloadHref, emptyActions, title = "Pages and test cases" }: { outcome: Outcome; downloadHref?: string | null; emptyActions?: ReactNode; title?: string }) {
    const headingId = useId();
    const roots = useMemo(() => buildTree(outcome.tree), [outcome.tree]);
    const counts = useMemo(() => nodeCaseCounts(outcome.tree, outcome.cases), [outcome.tree, outcome.cases]);
    const unplaced = useMemo(() => unplacedCases(outcome.tree, outcome.cases), [outcome.tree, outcome.cases]);
    const [selected, setSelected] = useState<string | null>(null);
    const node = selected === null ? null : (outcome.tree.find((n) => n.node === selected) ?? null);
    const page = node ? outcome.pages.find((p) => p.path === node.page) : undefined;
    const shown = casesForNode(outcome.cases, node ? node.node : null);
    const pageTitle = useMemo(() => new Map(outcome.tree.map((n) => [n.node, n.title || n.node])), [outcome.tree]);

    const last = outcome.runs[0];
    const note = lastRunNote(outcome.runs);
    const notOpened = notOpenedLine(outcome.notOpened);
    const nothing = outcome.tree.length === 0 && outcome.cases.length === 0;

    return (
        <section className="card oc" data-testid="case-outcome" aria-labelledby={headingId}>
            <header className="oc-head">
                <div className="oc-titles">
                    <h2 className="t-section" id={headingId}>
                        {title}
                    </h2>
                    {!nothing && (
                        <p className="oc-summary" data-testid="outcome-summary">
                            {summaryLine(outcome)}
                        </p>
                    )}
                </div>
                {downloadHref && outcome.runs.length > 0 && !nothing && (
                    <a className="btn btn-primary" href={downloadHref} download data-testid="outcome-download">
                        <Download size={18} aria-hidden />
                        Download test cases
                    </a>
                )}
            </header>

            {note && !nothing && (
                <p className={`oc-note is-${last.status}`} data-testid="outcome-run-note">
                    {last.status === "running" ? <LoaderCircle size={16} className="spin" aria-hidden /> : last.status === "stopped" ? <OctagonPause size={16} aria-hidden /> : <TriangleAlert size={16} aria-hidden />}
                    {note}
                </p>
            )}

            {nothing ? (
                <Empty outcome={outcome} actions={emptyActions} />
            ) : (
                <>
                    {outcome.missing.length > 0 && (
                        <div className="oc-missing" data-testid="outcome-missing">
                            <h3 className="oc-subhead">
                                <TriangleAlert size={16} aria-hidden />
                                What is missing
                            </h3>
                            <ul>
                                {outcome.missing.map((m, i) => (
                                    <li key={i}>{m}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div className="oc-body">
                        <div className="oc-pages">
                            <h3 className="oc-subhead">Pages</h3>
                            {roots.length > 0 ? (
                                <OutcomeTree roots={roots} counts={counts} selected={selected} onSelect={setSelected} label="Pages of the application" />
                            ) : (
                                <p className="oc-quiet">No pages yet.</p>
                            )}
                            {notOpened && (
                                <p className="oc-failed" data-testid="outcome-not-opened">
                                    <CircleSlash size={16} aria-hidden />
                                    <span>
                                        {notOpened}
                                        <span className="oc-failed-hint">They are not counted as pages.</span>
                                    </span>
                                </p>
                            )}
                        </div>
                        <div className="oc-cases" data-testid="outcome-cases">
                            <div className="oc-cases-head">
                                <h3 className="oc-subhead" aria-live="polite">
                                    {node ? `Test cases on ${node.title || node.node}` : "All test cases"}
                                    <span className="oc-count-text">{shown.length}</span>
                                </h3>
                                {node && (
                                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>
                                        <X size={16} aria-hidden />
                                        Show all
                                    </button>
                                )}
                            </div>
                            {node && (
                                <p className="oc-page-line">
                                    <span className="oc-mono">{page?.url || node.page}</span>
                                    {page?.purpose && <span className="oc-purpose">{page.purpose}</span>}
                                </p>
                            )}
                            {shown.length > 0 ? (
                                <ul className="oc-list">
                                    {shown.map((c) => (
                                        <CaseRow key={c.id} c={c} pageTitle={pageTitle.get(c.page)} />
                                    ))}
                                </ul>
                            ) : (
                                <p className="oc-quiet">{node ? "No test case starts on this page." : "No test cases yet."}</p>
                            )}
                            {!node && unplaced.length > 0 && <p className="oc-quiet">{plural(unplaced.length, "test case")} not tied to a page of the tree.</p>}
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}

function Empty({ outcome, actions }: { outcome: Outcome; actions?: ReactNode }) {
    const last = outcome.runs[0];
    if (last?.status === "running")
        return (
            <EmptyState icon={LoaderCircle} title="Exploring the application">
                Pages and test cases appear here as the run finds them.
            </EmptyState>
        );
    if (last)
        return (
            <EmptyState icon={OctagonPause} title={last.status === "stopped" ? "The run was stopped before it found a page" : "The run ended before it found a page"} actions={actions}>
                Explore again to build the map of the application and write its test cases.
            </EmptyState>
        );
    return (
        <EmptyState icon={Network} title="Not explored yet" actions={actions}>
            Explore the application. We will build a map of its pages and write test cases for each one.
        </EmptyState>
    );
}

function CaseRow({ c, pageTitle }: { c: CaseOutcomeCase; pageTitle?: string }) {
    const [open, setOpen] = useState(false);
    const detailId = useId();
    const manual = c.type === "manual";
    return (
        <li className="oc-case" data-case={c.id}>
            <button type="button" className="oc-case-btn" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
                <ChevronRight size={16} className="oc-case-chev" aria-hidden />
                <span className="oc-case-main">
                    <span className="oc-case-title">
                        <span className="oc-id">{c.id}</span>
                        {c.title}
                    </span>
                    <span className="oc-case-meta">
                        <span className={`badge ${manual ? "badge-neutral" : "badge-brand"}`}>{TYPE_LABEL[c.type]}</span>
                        <span className={`oc-prio is-${c.priority}`}>{PRIORITY_LABEL[c.priority]} priority</span>
                        <span className="oc-case-page">{pageTitle ?? (c.page || "No page")}</span>
                    </span>
                </span>
            </button>
            <div className="oc-detail" id={detailId} hidden={!open}>
                {manual ? (
                    c.steps.length > 0 ? (
                        <ol className="oc-steps">
                            {c.steps.map((s, i) => (
                                <li key={i}>
                                    <span>{s.action}</span>
                                    {s.expected && <span className="oc-expect">Expected: {s.expected}</span>}
                                </li>
                            ))}
                        </ol>
                    ) : (
                        <p className="oc-quiet">No steps written yet.</p>
                    )
                ) : (
                    <>
                        <Lines label="Before you start" lines={c.preconditions} />
                        <Lines label="Expected result" lines={c.expected} />
                        {c.preconditions.length === 0 && c.expected.length === 0 && <p className="oc-quiet">Only a title. Its steps are written when its test script is made in a code project.</p>}
                    </>
                )}
                {manual && c.expected.length > 0 && <Lines label="Expected result" lines={c.expected} />}
                {c.requirement && (
                    <p className="oc-req">
                        <span className="oc-label">Requirement</span>
                        {c.requirement}
                    </p>
                )}
            </div>
        </li>
    );
}

function Lines({ label, lines }: { label: string; lines: string[] }) {
    if (!lines.length) return null;
    return (
        <div className="oc-lines">
            <span className="oc-label">{label}</span>
            {lines.length === 1 ? (
                <p>{lines[0]}</p>
            ) : (
                <ul>
                    {lines.map((l, i) => (
                        <li key={i}>{l}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}
