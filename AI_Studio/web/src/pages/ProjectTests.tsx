import { ChevronDown, ChevronRight, Clock, Download, FileJson, FileText, FileUp, FileX, MonitorSmartphone, MoreHorizontal, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { RunsOnLine } from "../features/agents/RunsOnLine";
import { FrameworksLine } from "../features/frameworks/FrameworksLine";
import { CheckVariantsPanel } from "../features/variants/CheckVariantsPanel";
import { MaestroImportPanel } from "../features/imports/MaestroImportPanel";
import { WriteTestDialog } from "../features/authoring/WriteTestDialog";
import { BuildTestDialog } from "../features/builder/BuildTestButton";
import { NewTestMenu } from "../features/authoring/NewTestMenu";
import { EXPORT_ICONS, ExportDialog, ImportDialog, type ExportItem } from "../features/authoring/ImportExport";
import { GitImportDialog } from "../features/code/GitImportDialog";
import { useHere } from "../features/auth/project-access";
import { HandWrittenBadge } from "../features/code/TakeOver";
import { CompatBadge } from "../features/variants/CompatBadge";
import { api, getKey, projectKind, type ProjectDetail, type TestSummary, type ValidationStatus } from "../api";
import { usePage } from "../components/Shell";
import { Button, Callout, EmptyState, ErrorState, ListSkeleton, Menu, MenuItem, PageHeader, SeverityBadge, StatusBadge, Badge, severityKey, statusKey } from "../components/ui";
import { BadgeKey, Tooltip } from "../components/Tooltip";
import { help } from "../lib/help";
import { downloadBlob, plural } from "../lib/format";
import { useDocumentTitle, useFetch, useOnFinish } from "../lib/hooks";
import { KIND_LABEL, PRIORITY_LABEL, cleanReason, describeApiError, friendlyError, isActive, typeLabel } from "../lib/labels";
import { go, routes, useRoute } from "../lib/router";
import { ProjectTabs } from "./ProjectOverview";
import { RunMenu } from "../features/runs/RunMenu";
import { RunStrip } from "../features/runs/RunStrip";
import { SelectToggle, SelectionBar, useTestSelection, type TestSelection } from "../features/runs/Selection";
import { SuiteFromSelection } from "../features/suites/SuiteFromSelection";
import { EXPLORING_OFF_HERE, EXPLORING_ON_RUNNERS, useExecutionMode, useRunsHere } from "../features/runs/runs-here";
import { versionHref, type ScriptRow } from "../features/review/review";
import "../features/authoring/authoring.css";

/** Tests rendered per area before "Show more": keeps big suites fast and scannable. */
const PAGE_SIZE = 50;

type Filter = "all" | "validated" | "review" | "failed" | "notrun";

const FILTERS: Array<{ key: Filter; label: string; match: (s: ValidationStatus) => boolean }> = [
    { key: "all", label: "All", match: () => true },
    { key: "validated", label: "Passing", match: (s) => s === "VALIDATED" },
    { key: "review", label: "Needs a look", match: (s) => s === "NEEDS_REVIEW" },
    { key: "failed", label: "Failing", match: (s) => s === "FAILED_VALIDATION" },
    { key: "notrun", label: "Not run yet", match: (s) => s === "PENDING" || s === "VALIDATING" },
];

/** What each status chip keeps (the filter's own `match` above): the status definitions, and "Not run yet" also holds tests running now. */
const FILTER_TIP: Record<Filter, string | undefined> = {
    all: undefined,
    validated: help("testStatus", "VALIDATED"),
    review: help("testStatus", "NEEDS_REVIEW"),
    failed: help("testStatus", "FAILED_VALIDATION"),
    notrun: "Tests that have no result yet, including any that are running right now.",
};

/** The requirements a script covers (GET /projects/:id/requirements/links), as chips. */
interface RequirementLink {
    requirementId: string;
    ref: string;
    title: string;
    kind: "automated" | "manual";
    testId: string;
}
const authHeaders = (): Record<string, string> => (getKey() ? { "x-api-key": getKey() } : {});

export function ProjectTests({ id }: { id: string }) {
    const route = useRoute();
    const project = useFetch<ProjectDetail>(`/projects/${id}`, (d) => (isActive(d?.latestJob?.status) ? 3000 : null));
    const tests = useFetch<TestSummary[]>(`/projects/${id}/tests`, () => (isActive(project.data?.latestJob?.status) ? 3000 : null));
    // The Requirement column, and the Status column's word about drafts waiting for review (features/review).
    const reqLinks = useFetch<{ links: RequirementLink[] }>(`/projects/${id}/requirements/links`);
    const reviews = useFetch<{ scripts: ScriptRow[] }>(`/projects/${id}/scripts`);
    // What this person may do in this project: Import needs tests.write, other browsers tests.run, the downloads reports.export.
    const here = useHere(id, project);
    const writeWhy = here.why("ai_studio.tests.write");
    const runWhy = here.why("ai_studio.tests.run");
    const exportWhy = here.why("ai_studio.reports.export");
    const name = project.data?.name;
    useOnFinish(isActive(project.data?.latestJob?.status), () => {
        void tests.reload();
        void reviews.reload();
    });
    useDocumentTitle(name ? `Test scripts · ${name}` : "Test scripts");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Test scripts" }], nav: "projects" });

    const initial = (route.query.get("status") as Filter | null) ?? "all";
    const [filter, setFilter] = useState<Filter>(FILTERS.some((f) => f.key === initial) ? initial : "all");
    const [q, setQ] = useState("");
    const [showMore, setShowMore] = useState(false);
    const [kind, setKind] = useState("");
    const [priority, setPriority] = useState("");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [limits, setLimits] = useState<Record<string, number>>({});
    const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    // Test development opens a way of writing a test straight away (routes.newTest).
    const [showWrite, setShowWrite] = useState(route.query.get("start") === "describe");
    const [showBuild, setShowBuild] = useState(route.query.get("start") === "build");
    // The first-run page ("Start from tests I have") opens the import chooser straight away.
    const [showImport, setShowImport] = useState(route.query.get("start") === "import");
    const [showVariants, setShowVariants] = useState(false);
    const [showExport, setShowExport] = useState(false);
    const [showMaestro, setShowMaestro] = useState(false);
    const [showGit, setShowGit] = useState(route.query.get("git") === "1");
    /** Only tests that pass in Chrome but fail on another browser or screen size. */
    const [differs, setDiffers] = useState(false);
    const [weak, setWeak] = useState(route.query.get("quality") === "weak");
    /** Only tests in quarantine (they still run, but count for nothing). */
    const [held, setHeld] = useState(route.query.get("quarantine") === "1");
    /** Choosing tests to run (the Run control counts them). */
    const selection = useTestSelection();

    const all = tests.data ?? [];
    const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((t) => f.match(t.validationStatus)).length])) as Record<Filter, number>, [all]);
    const shown = useMemo(() => {
        const f = FILTERS.find((x) => x.key === filter)!;
        const needle = q.trim().toLowerCase();
        return all.filter((t) => f.match(t.validationStatus) && (!kind || t.kind === kind) && (!priority || t.priority === priority) && (!differs || (t.compat?.failing.length ?? 0) > 0) && (!weak || t.quality?.level === "weak") && (!held || Boolean(t.quarantine)) && (!needle || `${t.testId} ${t.title}`.toLowerCase().includes(needle)));
    }, [all, filter, q, kind, priority, differs, weak, held]);
    const groups = useMemo(() => {
        const m = new Map<string, TestSummary[]>();
        for (const t of shown) m.set(t.suite, [...(m.get(t.suite) ?? []), t]);
        // Areas with something to look at first, then alphabetical.
        const needs = (items: TestSummary[]) => items.some((t) => t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION");
        return [...m.entries()].sort(([a, ia], [b, ib]) => Number(needs(ib)) - Number(needs(ia)) || a.localeCompare(b));
    }, [shown]);

    const job = project.data?.latestJob;
    const hasValidated = counts.validated > 0;
    const filtersActive = filter !== "all" || q || kind || priority || differs || weak || held;
    const heldCount = all.filter((t) => t.quarantine).length;
    const weakCount = all.filter((t) => t.quality?.level === "weak").length;
    const differCount = all.filter((t) => (t.compat?.failing.length ?? 0) > 0).length;
    const reqsOf = useMemo(() => {
        const m = new Map<string, RequirementLink[]>();
        for (const l of reqLinks.data?.links ?? []) if (l.kind === "automated") m.set(l.testId, [...(m.get(l.testId) ?? []), l]);
        for (const list of m.values()) list.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
        return m;
    }, [reqLinks.data]);
    const reviewOf = useMemo(() => new Map((reviews.data?.scripts ?? []).map((r) => [r.testId, r])), [reviews.data]);
    // Exploring makes tests only for agent projects (and mixed ones, made before round 37); a code project never offers it.
    const explores = projectKind(project.data) !== "code";
    const runsHere = useRunsHere();
    // Runners mode: the platform refuses an exploration (the AI explores with a browser on the server), so none is offered.
    const runnersOnly = useExecutionMode() === "runners";
    const reloadAll = () => void Promise.all([tests.reload(), project.reload(), reviews.reload()]);

    async function fetchFile(path: string, filename: string, type?: string) {
        try {
            const res = await fetch(`/api${path}`, { headers: authHeaders() });
            if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
            downloadBlob(await res.blob(), filename);
        } catch (e) {
            setNotice({ tone: "danger", text: `Download failed: ${describeApiError(e)}` });
        }
        void type;
    }

    const exportItems: ExportItem[] = [
        { key: "zip", icon: EXPORT_ICONS.zip, title: "Tests to run in your own pipeline", text: "The tests that pass, as a folder that runs anywhere: exact package versions, a lockfile and a README with three steps.", button: "Download tests", disabled: !hasValidated || Boolean(exportWhy), ...(exportWhy ? { tip: exportWhy } : hasValidated ? {} : { tip: "Needs at least one passing test: only passing tests are in the folder." }), run: () => void fetchFile(`/projects/${id}/download`, `${name ?? "tests"}-tests.zip`) },
        { key: "json", icon: FileJson, title: "Tests as JSON", text: "Every test, in the format Import understands.", button: "Export as JSON", disabled: all.length === 0, run: () => void fetchFile(`/projects/${id}/specs`, `${name ?? "tests"}-specs.json`) },
        { key: "pdf", icon: FileText, title: "Report as PDF", text: "The project's results, ready to share.", button: "Download PDF", disabled: all.length === 0 || Boolean(exportWhy), ...(exportWhy ? { tip: exportWhy } : {}), run: () => void fetchFile(`/projects/${id}/report?format=pdf`, `${name ?? "project"}-report.pdf`) },
        { key: "html", icon: FileText, title: "Report as a web page", text: "The same report as one HTML file.", button: "Download web page", disabled: all.length === 0 || Boolean(exportWhy), ...(exportWhy ? { tip: exportWhy } : {}), run: () => void fetchFile(`/projects/${id}/report?format=html`, `${name ?? "project"}-report.html`) },
        { key: "junit", icon: EXPORT_ICONS.junit, title: "Results for your pipeline", text: "JUnit XML, read by most CI tools.", button: "Download results", disabled: all.length === 0 || Boolean(exportWhy), ...(exportWhy ? { tip: exportWhy } : {}), run: () => void fetchFile(`/projects/${id}/junit`, `${name ?? "tests"}-results.xml`) },
    ];

    async function importSpecs(file: File) {
        try {
            const json = JSON.parse(await file.text());
            const specs = Array.isArray(json) ? json : json.specs;
            if (!Array.isArray(specs)) throw new Error("The file should contain a list of test specs, or an object with a “specs” list.");
            const res = await api(`/projects/${id}/specs`, { method: "POST", body: { specs } });
            setNotice({ tone: "success", text: `Imported ${res.tests.length} test${res.tests.length === 1 ? "" : "s"}${res.jobId ? ". We’re running them now." : res.notRun ? `. ${res.notRun}` : "."}` });
            reloadAll();
        } catch (e) {
            const details = (e as { details?: Array<{ index: number }> }).details;
            setNotice({ tone: "danger", text: `Import failed: ${e instanceof SyntaxError ? "that file isn’t valid JSON." : describeApiError(e)}${details?.length ? ` (test ${details[0]!.index + 1} is invalid)` : ""}` });
        }
    }

    return (
        <>
            <PageHeader
                title="Scripts"
                subtitle={all.length ? `${plural(all.length, "test script")}, ${counts.validated} passing${counts.review + counts.failed ? `, ${counts.review + counts.failed} not passing` : ""}` : name}
                actions={
                    <>
                        <Button icon={FileUp} disabled={Boolean(writeWhy) || isActive(job?.status)} tip={writeWhy ?? (isActive(job?.status) ? "Wait until the job that is running has finished." : "Bring scripts from a JSON file, Maestro flows or a Git repository.")} onClick={() => setShowImport(true)}>
                            Import
                        </Button>
                        {/* Choosing where tests run and which ones is one control (UX-A); making a script is another. */}
                        <RunMenu projectId={id} tests={all} selectedIds={[...selection.picked]} />
                        <NewTestMenu projectId={id} onDescribe={() => setShowWrite(true)} onImport={() => setShowImport(true)} onMade={() => void Promise.all([tests.reload(), reqLinks.reload(), reviews.reload()])} />
                        <Menu label="More actions" icon={MoreHorizontal} iconOnly>
                            {(close) => (
                                <>
                                    <MenuItem icon={Download} onClick={() => { close(); setShowExport(true); }}>
                                        Export…
                                    </MenuItem>
                                    <MenuItem icon={MonitorSmartphone} disabled={Boolean(runWhy) || isActive(job?.status) || counts.validated === 0} tip={runWhy ?? (counts.validated === 0 ? "Needs at least one passing test." : isActive(job?.status) ? "Wait until the job that is running has finished." : "Choose other browsers and screen sizes to run the passing web tests on.")} onClick={() => { close(); setShowVariants(true); }}>
                                        Check other browsers &amp; screen sizes
                                    </MenuItem>
                                </>
                            )}
                        </Menu>
                    </>
                }
            />
            <ProjectTabs id={id} active="scripts" count={all.length} />

            <div className="stack">
                <RunsOnLine projectId={id} />
                <FrameworksLine projectId={id} />
                {notice && <Callout tone={notice.tone}>{notice.text}</Callout>}
                {showWrite && <WriteTestDialog projectId={id} busy={isActive(job?.status)} onClose={() => setShowWrite(false)} onStarted={() => void project.reload()} onDone={reloadAll} />}
                {showBuild && <BuildTestDialog projectId={id} onClose={() => setShowBuild(false)} />}
                {showMaestro && <MaestroImportPanel projectId={id} busy={isActive(job?.status)} onClose={() => setShowMaestro(false)} onImported={reloadAll} />}
                {showGit && <GitImportDialog projectId={id} onClose={() => setShowGit(false)} onImported={reloadAll} />}
                {showImport && !writeWhy && <ImportDialog onClose={() => setShowImport(false)} disabled={isActive(job?.status)} onJsonFile={(file) => void importSpecs(file)} onMaestro={() => setShowMaestro(true)} onGit={() => setShowGit(true)} />}
                {showVariants && <CheckVariantsPanel projectId={id} onStarted={() => void project.reload()} onClose={() => setShowVariants(false)} />}
                {showExport && <ExportDialog onClose={() => setShowExport(false)} items={exportItems} />}
                <RunStrip projectId={id} />
                {isActive(job?.status) && (job?.mode === "generate" || job?.mode === "plain" || job?.mode === undefined) && (
                    <Callout tone="info" title="Tests are still being created" actions={<a className="btn btn-sm" href={routes.project(id)}>View progress</a>}>
                        New tests appear here as soon as they’re ready.
                    </Callout>
                )}

                {tests.loading ? (
                    <ListSkeleton rows={6} />
                ) : tests.error ? (
                    <ErrorState error={friendlyError(tests.error.message)} onRetry={tests.reload} />
                ) : all.length === 0 ? (
                    <div className="card">
                        {isActive(job?.status) ? (
                            <EmptyState icon={Clock} title="Your test scripts are on their way">We’re still exploring the application. They’ll show up here as they’re created.</EmptyState>
                        ) : (
                            <EmptyState
                                icon={FileX}
                                title="No test scripts yet"
                                seeHow={{ topic: "first-steps", query: "start in 10 minutes" }}
                                actions={
                                    // New test script and Import are in the header above: the empty list does not repeat them.
                                    explores && !runnersOnly ? (
                                        <a className="btn" href={routes.newProject({ project: id })}>
                                            Start exploring
                                        </a>
                                    ) : undefined
                                }
                            >
                                {explores ? "Make your first test script with New test script, bring scripts you already have with Import, or explore the application and the AI writes tests for it." : "Make your first test script with New test script, generate them from your test cases, or bring scripts you already have with Import."}
                                {explores && runnersOnly ? ` ${EXPLORING_ON_RUNNERS}` : explores && !runsHere ? ` ${EXPLORING_OFF_HERE}` : ""}
                            </EmptyState>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="stack-sm">
                            <div className="row">
                                <div className="input-wrap" style={{ flex: "1 1 240px", maxWidth: 360 }}>
                                    <Search size={16} className="lead" aria-hidden />
                                    <input className="input" type="search" placeholder="Search scripts" aria-label="Search scripts" value={q} onChange={(e) => setQ(e.target.value)} />
                                </div>
                                <Button variant="ghost" icon={SlidersHorizontal} aria-expanded={showMore} onClick={() => setShowMore((s) => !s)}>
                                    Filters
                                </Button>
                                <SelectToggle selection={selection} />
                            </div>
                            {selection.selecting && <SelectionBar selection={selection} shownIds={shown.map((t) => t.id)} run={<><SuiteFromSelection projectId={id} testIds={[...selection.picked]} canWrite={!writeWhy} /><RunMenu projectId={id} tests={all} selectedIds={[...selection.picked]} label="Run selected" variant="primary" /></>} />}
                            <div className="chips" role="group" aria-label="Filter by status">
                                {FILTERS.filter((f) => f.key === "all" || counts[f.key] > 0 || filter === f.key).map((f) => (
                                    <Tooltip key={f.key} content={FILTER_TIP[f.key]}>
                                        <button className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                                            {f.label} <span className="n">{counts[f.key]}</span>
                                        </button>
                                    </Tooltip>
                                ))}
                                {(weakCount > 0 || weak) && (
                                    <Tooltip content="Tests that pass but check very little, so they could pass even if the feature broke.">
                                        <button className="chip" aria-pressed={weak} onClick={() => setWeak((w) => !w)}>
                                            Weak checks <span className="n">{weakCount}</span>
                                        </button>
                                    </Tooltip>
                                )}
                                {(heldCount > 0 || held) && (
                                    <Tooltip content="Unreliable tests that still run but do not count.">
                                        <button className="chip" aria-pressed={held} onClick={() => setHeld((h) => !h)}>
                                            Quarantined <span className="n">{heldCount}</span>
                                        </button>
                                    </Tooltip>
                                )}
                                {(differCount > 0 || differs) && (
                                    <Tooltip content="Tests that pass in Chrome but fail on another browser or screen size.">
                                        <button className="chip" aria-pressed={differs} onClick={() => setDiffers((d) => !d)}>
                                            Differs by browser <span className="n">{differCount}</span>
                                        </button>
                                    </Tooltip>
                                )}
                                {/* The badges in the rows are not tab stops (one per row): this explains the ones the list shows. */}
                                <BadgeKey label="the badges in this list" entries={[...statusKey(all.map((t) => t.validationStatus)), ...severityKey(all.map((t) => t.severity?.severity))]} />
                            </div>
                            {showMore && (
                                <div className="grid-2" style={{ maxWidth: 520 }}>
                                    <div className="field">
                                        <label htmlFor="f-kind">Type</label>
                                        <select id="f-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                                            <option value="">All types</option>
                                            {(["web", "api", "mobile", "desktop"] as const).filter((k) => all.some((t) => t.kind === k)).map((k) => (
                                                <option key={k} value={k}>{KIND_LABEL[k]}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="field">
                                        <label htmlFor="f-pri">Priority</label>
                                        <select id="f-pri" className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                                            <option value="">Any priority</option>
                                            {Object.entries(PRIORITY_LABEL).map(([k, v]) => (
                                                <option key={k} value={k}>{v}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            )}
                        </div>

                        {groups.length === 0 ? (
                            <div className="card">
                                <EmptyState icon={Search} title="No tests match" actions={<Button onClick={() => { setFilter("all"); setQ(""); setKind(""); setPriority(""); setDiffers(false); setWeak(false); setHeld(false); }}>Clear filters</Button>}>
                                    Nothing matches your search and filters.
                                </EmptyState>
                            </div>
                        ) : (
                            <div>
                                {groups.map(([suite, items]) => {
                                    const open = !collapsed.has(suite);
                                    const ok = items.filter((t) => t.validationStatus === "VALIDATED").length;
                                    const attn = items.filter((t) => t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION").length;
                                    return (
                                        <section className="card group" key={suite}>
                                            <button className="group-head" aria-expanded={open} onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(suite) ? n.delete(suite) : n.add(suite); return n; })}>
                                                <ChevronDown size={16} className="chev" aria-hidden />
                                                <span className="name">{suite}</span>
                                                <span className="t-meta">
                                                    {items.length} test{items.length === 1 ? "" : "s"} · {ok} passing{attn ? ` · ${attn} not passing` : ""}
                                                </span>
                                            </button>
                                            {open && (
                                                <>
                                                    <ScriptHead suite={suite} ids={items.slice(0, limits[suite] ?? PAGE_SIZE).map((t) => t.id)} selection={selection} />
                                                    <ul className="list divided" aria-label={`Test scripts in ${suite}`}>
                                                        {items.slice(0, limits[suite] ?? PAGE_SIZE).map((t) => (
                                                            <li key={t.id}>
                                                                <ScriptRowView t={t} projectId={id} app={project.data?.mobile?.appPackage ?? undefined} reqs={reqsOf.get(t.id) ?? []} review={reviewOf.get(t.id)} selection={selection} />
                                                            </li>
                                                        ))}
                                                    </ul>
                                                    {items.length > (limits[suite] ?? PAGE_SIZE) && (
                                                        <div className="more-row">
                                                            <Button size="sm" onClick={() => setLimits((l) => ({ ...l, [suite]: (l[suite] ?? PAGE_SIZE) + PAGE_SIZE }))}>
                                                                Show {Math.min(PAGE_SIZE, items.length - (limits[suite] ?? PAGE_SIZE))} more
                                                            </Button>
                                                            <span className="t-meta">
                                                                Showing {limits[suite] ?? PAGE_SIZE} of {items.length}
                                                            </span>
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                        </section>
                                    );
                                })}
                                {filtersActive && <p className="t-meta" style={{ marginTop: 12 }}>Showing {shown.length} of {all.length} test scripts.</p>}
                            </div>
                        )}
                    </>
                )}
            </div>
        </>
    );
}

/** The column names above a group's rows, with a box that chooses every row shown in the group. */
function ScriptHead({ suite, ids, selection }: { suite: string; ids: string[]; selection: TestSelection }) {
    const all = ids.length > 0 && ids.every((x) => selection.picked.has(x));
    return (
        <div className="script-head">
            <label className="run-pick sr-check">
                <input
                    type="checkbox"
                    checked={all}
                    aria-label={`Select every script in ${suite}`}
                    onChange={() => {
                        if (!selection.selecting) selection.setSelecting(true);
                        selection.set(all ? [...selection.picked].filter((x) => !ids.includes(x)) : [...new Set([...selection.picked, ...ids])]);
                    }}
                />
            </label>
            <span>ID</span>
            <span>Test script</span>
            <span>Script</span>
            <span>Requirement</span>
            <span>Status</span>
            <span />
        </div>
    );
}

/** Where a script's row opens it: its DSL tab, or the Code tab for a script that is code only (a hand-written one has no DSL). */
const scriptHref = (t: TestSummary) => routes.testTab(t.id, t.custom ? "code" : "text");

/** The review word of a script whose latest version waits for a decision (drafts never run until approved, D-18). */
function reviewWord(projectId: string, r: ScriptRow | undefined): { text: string; href: string } | null {
    if (!r?.latest || (r.latest.state !== "draft" && r.latest.state !== "in_review")) return null;
    const inReview = r.latest.state === "in_review";
    // `waiting`: no version of it is approved, so it does not run at all yet.
    const text = r.waiting ? (inReview ? "In review, not run yet" : "Draft, waiting for review") : inReview ? "New version in review" : "New version, waiting for review";
    return { text, href: versionHref(projectId, r.testId, r.latest.version) };
}

/**
 * One script: ID, title (the link to its workbench), the DSL | Code pair that opens it on that tab, the requirements it covers, its
 * status. A click anywhere else on the row opens the script too.
 */
function ScriptRowView({ t, projectId, app, reqs, review, selection }: { t: TestSummary; projectId: string; /** The project’s Android app: shown after Phone on a phone test. */ app?: string; reqs: RequirementLink[]; review: ScriptRow | undefined; selection: TestSelection }) {
    const tone = { VALIDATED: "var(--status-success-fg)", NEEDS_REVIEW: "var(--status-warning-fg)", FAILED_VALIDATION: "var(--status-error-fg)", PENDING: "var(--text-muted)", VALIDATING: "var(--status-info-fg)" }[t.validationStatus];
    const word = reviewWord(projectId, review);
    const shownReqs = reqs.slice(0, 2);
    return (
        <div
            className="list-row script-row"
            data-testid="script-row"
            onClick={(e) => {
                if ((e.target as HTMLElement).closest("a, button, input, label")) return;
                go(scriptHref(t));
            }}
        >
            <label className="run-pick sr-check">
                <input
                    type="checkbox"
                    checked={selection.picked.has(t.id)}
                    aria-label={`Select ${t.title}`}
                    onChange={() => {
                        if (!selection.selecting) selection.setSelecting(true);
                        selection.toggle(t.id);
                    }}
                />
            </label>
            <span className="sr-id mono">{t.testId}</span>
            <span className="main">
                <a className="title sr-title" href={scriptHref(t)}>
                    {t.title}
                </a>
                <span className="meta">
                    {typeLabel(t.type)}
                    <span className="dot-sep" />
                    {PRIORITY_LABEL[t.priority]}
                    <span className="dot-sep" />
                    {KIND_LABEL[t.kind]}
                    {t.kind === "mobile" && app ? <span className="ph-app">, {app}</span> : null}
                </span>
                {t.validationStatus !== "VALIDATED" && t.validationReason && <span className="meta truncate" style={{ color: tone }}>{cleanReason(t.validationReason)}</span>}
                {t.quarantine && <span className="meta truncate" data-testid="quarantine-reason">In quarantine, not counted: {t.quarantine.reason}</span>}
                {(t.custom || t.quarantine || t.quality?.level === "weak" || t.compat || t.severity) && (
                    <span className="sr-badges">
                        {t.custom && <HandWrittenBadge />}
                        {t.quarantine && <Badge tone="info" title={`In quarantine: ${t.quarantine.reason}`}>Quarantined</Badge>}
                        {t.quality?.level === "weak" && <Badge tone="neutral" title={t.quality.reasons.join(" ")}>Weak checks</Badge>}
                        <CompatBadge compat={t.compat} />
                        {t.severity && <SeverityBadge severity={t.severity.severity} basis={t.severity.basis} />}
                    </span>
                )}
            </span>
            <span className="sr-views" role="group" aria-label="Open the script as">
                <a href={routes.testTab(t.id, "text")} aria-label={`DSL of ${t.testId}`} title={t.custom ? "This script is code only: the DSL tab says so" : "The plain steps of this script"}>
                    DSL
                </a>
                <a href={routes.testTab(t.id, "code")} aria-label={`Code of ${t.testId}`} title="The code of this script">
                    Code
                </a>
            </span>
            <span className="sr-reqs">
                {shownReqs.map((r) => (
                    <a key={r.requirementId} className="req-chip" href={routes.requirement(projectId, r.requirementId)} title={r.title}>
                        {r.ref}
                    </a>
                ))}
                {reqs.length > shownReqs.length && <span className="t-meta" title={reqs.slice(2).map((r) => r.ref).join(", ")}>+{reqs.length - shownReqs.length}</span>}
                {reqs.length === 0 && <span className="t-meta">None</span>}
            </span>
            <span className="sr-status">
                <StatusBadge status={t.validationStatus} />
                {word && (
                    <a className="sr-review" href={word.href} data-testid="script-review-link">
                        {word.text}
                    </a>
                )}
            </span>
            <ChevronRight size={18} className="chev" aria-hidden />
        </div>
    );
}
