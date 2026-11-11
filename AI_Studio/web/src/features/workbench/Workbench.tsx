import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../api";
import { usePage } from "../../components/Shell";
import { Callout, ErrorState, LinkButton, Skeleton } from "../../components/ui";
import { useConfig, useDocumentTitle, useFetch } from "../../lib/hooks";
import { describeApiError, frameworkLabel, friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { bapi } from "../builder/builder";
import type { RanOn } from "../agents/agents";
import { CodeTab } from "./CodeTab";
import { HistoryTab, type Restored } from "./HistoryTab";
import { announceRunsChanged, useActiveRun } from "../runs/runs";
import { TEST_CHANGED } from "./changed";
import { ResultsPane } from "./ResultsPane";
import { CoveredRequirements } from "../requirements/CoverageCard";
import { StepsTab } from "./StepsTab";
import { TestHeader } from "./TestHeader";
import { SavedBar } from "./UnsavedBar";
import { TAB_LABEL, TABS, lastEditBeforeFailure, marksCurrent, stepMarks, testTabHref, type Detail, type SpecVersionRow, type Tab } from "./test-model";
import { restoreSpecVersion } from "./restore";
import "./workbench.css";

const FINAL = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];

interface Saved {
    n: number;
    headline: string;
    detail: string;
    /** The version this save made, when it made one: Undo goes back to the one before. */
    version: number | null;
    ran: boolean;
}

/** Calls `onEnded` when a run of the project that was going has ended (renders nothing). */
function RunEndWatcher({ projectId, onEnded }: { projectId: string; onEnded: () => void }) {
    const active = useActiveRun(projectId);
    const running = Boolean(active.job);
    const was = useRef(false);
    useEffect(() => {
        if (running) was.current = true;
        else if (was.current) {
            was.current = false;
            onEnded();
        }
    }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
}

/**
 * One page per test: DSL, Code, Steps and History are tabs of the same page (and routes), the header and the results stay put when
 * the tab changes, and a run started from here shows its result here. Work that is not saved survives a change of tab.
 */
/** What a saved bar says about the run a save queued; the note says when that run does not use the saved change (a draft never runs). */
const runningWords = (note?: string) => (note ? `A run has started. ${note}` : "The test is running.");

export function Workbench({ id, tab }: { id: string; tab: Tab }) {
    // While the test is running (from here or from anywhere) the page keeps asking, so the verdict and the editors catch up by themselves.
    const test = useFetch<Detail>(`/tests/${id}`, (d) => (d?.validationStatus === "VALIDATING" ? 2500 : null));
    const t = test.data;
    const project = useFetch<{ name: string }>(t ? `/projects/${t.projectId}` : null);
    const versions = useFetch<SpecVersionRow[]>(t ? `/tests/${id}/spec-versions` : null);
    const config = useConfig();
    useDocumentTitle(t ? t.title : "Test");
    usePage({
        crumbs: t
            ? [{ label: "Projects", href: routes.home }, { label: project.data?.name ?? "…", href: routes.project(t.projectId) }, { label: "Test scripts", href: routes.tests(t.projectId) }, { label: t.testId }]
            : [{ label: "Projects", href: routes.home }, { label: "Test" }],
        nav: "projects",
    });
    /** A framework an adapter plug-in provides shows the plug-in's own label (the raw id means nothing to a person). */
    const plugin = (framework: string) => config?.adapters?.find((a) => a.id === framework && a.plugin);
    const fwName = (framework: string) => plugin(framework)?.label ?? frameworkLabel(framework);

    const [busy, setBusy] = useState<"" | "validate" | "baseline">("");
    const [actionError, setActionError] = useState("");
    const [ranOn, setRanOn] = useState<RanOn | null>(null);
    const [scriptFramework, setScriptFramework] = useState("");
    // The editor is rebuilt from the platform after an undo or a restore; its own work in progress is kept otherwise.
    const [epoch, setEpoch] = useState(0);
    const [refreshKey, setRefreshKey] = useState(0);
    const [historyKey, setHistoryKey] = useState(0);
    const [quarantineKey, setQuarantineKey] = useState(0);
    const [dirty, setDirty] = useState({ count: 0, label: "" });
    const [saved, setSaved] = useState<Saved | null>(null);
    const [undoing, setUndoing] = useState(false);

    // A tab is built the first time it is shown and then kept, so what is typed in it is still there when the tab comes back.
    const [visited, setVisited] = useState<Set<Tab>>(() => new Set([tab]));
    const mounted = new Set([...visited, tab]);
    useEffect(() => {
        setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)));
        if (tab === "history") setHistoryKey((k) => k + 1);
    }, [tab]);

    // The editor has two views, and the route says which one shows. Away from both tabs it remembers the last.
    const lastView = useRef<"steps" | "text">(tab === "text" ? "text" : "steps");
    if (tab === "steps" || tab === "text") lastView.current = tab;
    const switchRef = useRef<((mode: "steps" | "text") => Promise<boolean>) | null>(null);
    const [scriptSlot, setScriptSlot] = useState<HTMLElement | null>(null);
    const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);

    // ── runs ──
    /** Wait for a run of this test to end, remembering where it ran. */
    const follow = useCallback(async (jobId: string) => {
        for (;;) {
            await new Promise((r) => setTimeout(r, 1500));
            const job = await api(`/test-generation/${jobId}`);
            if (FINAL.includes(job.status)) {
                setRanOn(job.ranOn ?? null);
                break;
            }
        }
    }, []);
    const followRun = useCallback(
        async (jobId: string) => {
            setBusy("validate");
            setActionError("");
            // A run the page started itself (a save that runs, an undo): the run strip looks for it now instead of at its next check.
            announceRunsChanged();
            try {
                await follow(jobId);
                await test.reload();
                await versions.reload();
                setRefreshKey((k) => k + 1);
                setHistoryKey((k) => k + 1);
            } catch (e) {
                setActionError(describeApiError(e));
            } finally {
                setBusy("");
            }
        },
        [follow], // eslint-disable-line react-hooks/exhaustive-deps
    );
    async function run(kind: "validate" | "baseline") {
        setBusy(kind);
        setActionError("");
        try {
            const { jobId } = await api(`/tests/${id}/${kind}`, { method: "POST" });
            await follow(jobId);
            await test.reload();
            await versions.reload();
            setRefreshKey((k) => k + 1);
            setHistoryKey((k) => k + 1);
        } catch (e) {
            setActionError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }
    async function renderMobile() {
        try {
            await api(`/tests/${id}/scripts`, { method: "POST", body: { framework: "taqwright" } });
            setScriptFramework("taqwright");
            await test.reload();
            go(testTabHref(id, "code"));
        } catch (e) {
            setActionError(describeApiError(e));
        }
    }

    // ── saves, undo, restore ──
    /** A save from the Steps or the Text view: say what it made, refresh what the page knows, follow the run it started. */
    const handleSaved = useCallback(
        async (r: { changed: boolean; jobId: string | null; note?: string; via: "steps" | "text" }) => {
            setActionError("");
            let version: number | null = null;
            if (r.changed) {
                try {
                    const list = await bapi<SpecVersionRow[]>(`/tests/${id}/spec-versions`);
                    version = list.length ? Math.max(...list.map((v) => v.version)) : null;
                } catch {
                    version = null;
                }
            }
            setSaved((s) => ({
                n: (s?.n ?? 0) + 1,
                headline: !r.changed ? "Nothing changed." : version !== null ? `Saved version ${version}.` : "Saved.",
                detail: !r.changed ? (r.note ?? "So nothing was saved or run.") : r.jobId ? runningWords(r.note) : (r.note ?? "It has not been run since this change."),
                version: r.changed ? version : null,
                ran: !!r.jobId,
            }));
            await Promise.all([test.reload(), versions.reload()]);
            setHistoryKey((k) => k + 1);
            if (r.jobId) void followRun(r.jobId);
        },
        [id, followRun], // eslint-disable-line react-hooks/exhaustive-deps
    );

    /** Takes the steps back to an earlier version (saved again as the newest) and, when asked, runs the test. */
    async function goBackTo(version: number, o: { run: boolean; note: string; headline: string }) {
        setUndoing(true);
        setActionError("");
        try {
            const r = await restoreSpecVersion(id, version, { run: o.run, note: o.note });
            setSaved((s) => ({ n: (s?.n ?? 0) + 1, headline: o.headline, detail: r.jobId ? runningWords(r.note) : "It has not been run since this change.", version: null, ran: !!r.jobId }));
            setEpoch((n) => n + 1);
            await Promise.all([test.reload(), versions.reload()]);
            setHistoryKey((k) => k + 1);
            if (r.jobId) void followRun(r.jobId);
        } catch (e) {
            setActionError(describeApiError(e));
        } finally {
            setUndoing(false);
        }
    }

    const restoredFromHistory = useCallback(
        async (r: Restored) => {
            setSaved(null);
            setEpoch((n) => n + 1);
            await Promise.all([test.reload(), versions.reload()]);
            if (r.family === "code") setRefreshKey((k) => k + 1);
            if (r.jobId) void followRun(r.jobId);
        },
        [followRun], // eslint-disable-line react-hooks/exhaustive-deps
    );

    /** The platform's answer about this test is read again and the editors are rebuilt from it (after a switch to code, or back). */
    const refreshAll = useCallback(async () => {
        // A switch to code or back may have queued a run: the run strip and the watcher look for it now.
        announceRunsChanged();
        setEpoch((n) => n + 1);
        await Promise.all([test.reload(), versions.reload()]);
        setHistoryKey((k) => k + 1);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const on = (e: Event) => {
            if ((e as CustomEvent<string>).detail === id) void refreshAll();
        };
        window.addEventListener(TEST_CHANGED, on);
        return () => window.removeEventListener(TEST_CHANGED, on);
    }, [id, refreshAll]);

    // ── the tab strip ──
    const tabButtons = useRef<Record<string, HTMLButtonElement | null>>({});
    async function selectTab(next: Tab) {
        if (next === tab) return;
        // Steps and Text are two views of one editor: it checks the text reads before it lets go of it, and moves the route itself.
        if ((tab === "steps" || tab === "text") && (next === "steps" || next === "text") && switchRef.current && !(t?.custom && next === "text")) {
            await switchRef.current(next);
            return;
        }
        go(testTabHref(id, next));
    }
    function onKeys(e: KeyboardEvent<HTMLDivElement>) {
        const i = TABS.indexOf(tab);
        const to = e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length] : e.key === "ArrowLeft" ? TABS[(i + TABS.length - 1) % TABS.length] : e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : undefined;
        if (!to) return;
        e.preventDefault();
        tabButtons.current[to]?.focus();
        void selectTab(to);
    }

    // A run of this project that ended without this page following it (a switch back to the generated version, a scheduled run): the test
    // and what depended on it (whether the steps can be edited, the marks) are read again.
    const whenRunEnds = useCallback(() => {
        void test.reload();
        void versions.reload();
        setRefreshKey((k) => k + 1);
        setHistoryKey((k) => k + 1);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const marks = useMemo(() => (t && marksCurrent(versions.data, t.executions) ? stepMarks(t) : undefined), [t, versions.data]);
    const undo = useMemo(() => (t ? lastEditBeforeFailure(t, versions.data) : null), [t, versions.data]);

    if (test.loading) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading the test">
                <Skeleton w={380} h={28} />
                <Skeleton h={44} style={{ borderRadius: 12 }} />
                <Skeleton h={260} style={{ borderRadius: 12 }} />
            </div>
        );
    }
    if (test.error || !t) return <ErrorState error={friendlyError(test.error?.message ?? "Test not found")} onRetry={test.reload} />;

    const last = t.executions[0];
    const visualActual = (last?.artifacts ?? []).some((a) => a.kind === "visual-actual");
    const canAccept = t.validationStatus === "NEEDS_REVIEW" && visualActual;
    const canMobile = t.kind === "web" && !t.scripts.some((s) => s.framework === "taqwright");
    const editorOpen = mounted.has("steps") || mounted.has("text");
    const showEditor = tab === "steps" || tab === "text";

    return (
        <div className="wb">
            <RunEndWatcher projectId={t.projectId} onEnded={whenRunEnds} />
            <TestHeader
                test={t}
                {...(plugin(t.framework)?.plugin ? { pluginName: plugin(t.framework)!.plugin!.name } : {})}
                busy={busy}
                canAccept={canAccept}
                canMobile={canMobile}
                onAccept={() => void run("baseline")}
                onMobile={() => void renderMobile()}
                onStarted={(jobId) => void followRun(jobId)}
                onError={setActionError}
                onQuarantineChanged={() => {
                    setQuarantineKey((k) => k + 1);
                    void test.reload();
                }}
            />
            {actionError && (
                <Callout tone="danger" title="That didn’t work">
                    {actionError}
                </Callout>
            )}

            <div className="wb-tabs" role="tablist" aria-label="Views of this test" onKeyDown={onKeys} data-tour="workbench-tabs">
                {TABS.map((k) => (
                    <button
                        key={k}
                        ref={(el) => {
                            tabButtons.current[k] = el;
                        }}
                        type="button"
                        role="tab"
                        id={`wb-tab-${k}`}
                        data-tour={`wb-${k}`}
                        className="wb-tab"
                        aria-selected={tab === k}
                        aria-controls={k === "steps" || k === "text" ? "wb-panel-edit" : `wb-panel-${k}`}
                        tabIndex={tab === k ? 0 : -1}
                        onClick={() => void selectTab(k)}
                    >
                        {TAB_LABEL[k]}
                        {k === "steps" && dirty.count > 0 && <span className="wb-tab-dot" aria-hidden />}
                    </button>
                ))}
            </div>

            <div className="wb-grid">
                <div className="wb-main stack">
                    {saved && (
                        <SavedBar
                            key={saved.n}
                            headline={saved.headline}
                            detail={saved.detail}
                            canUndo={saved.version !== null && saved.version > 1 && dirty.count === 0}
                            undoHint={dirty.count > 0 ? "Save or discard your changes first" : undefined}
                            undoing={undoing}
                            onUndo={() => saved.version && void goBackTo(saved.version - 1, { run: saved.ran, note: `Undid version ${saved.version}`, headline: `Went back to version ${saved.version! - 1}.` })}
                            onDismiss={() => setSaved(null)}
                        />
                    )}

                    {editorOpen && (
                        <div role="tabpanel" id="wb-panel-edit" data-tour="wb-edit" aria-labelledby={`wb-tab-${showEditor ? tab : lastView.current}`} hidden={!showEditor}>
                            {t.custom && tab === "text" ? (
                                <Callout
                                    tone="info"
                                    title="This script is code only: it has no DSL"
                                    actions={
                                        <LinkButton size="sm" variant="primary" href={testTabHref(id, "code")}>
                                            Open the Code tab
                                        </LinkButton>
                                    }
                                >
                                    It was written as code, so there are no DSL steps to show. The code is the script: read or change it in the Code tab{t.custom.canRestoreGenerated ? ", or go back to the generated version there to get the steps and the DSL back" : ""}.
                                </Callout>
                            ) : (
                                <StepsTab
                                    key={epoch}
                                    test={t}
                                    refreshKey={refreshKey}
                                    onChanged={() => void test.reload()}
                                    editor={{
                                        mode: showEditor ? (tab as "steps" | "text") : lastView.current,
                                        active: showEditor,
                                        scriptSlot,
                                        barSlot,
                                        marks,
                                        onMode: (m) => {
                                            if (showEditor && m !== tab) go(testTabHref(id, m));
                                        },
                                        onDirty: setDirty,
                                        onSaved: (r) => void handleSaved(r),
                                        onReload: () => {
                                            void test.reload();
                                            void versions.reload();
                                            setHistoryKey((k) => k + 1);
                                        },
                                        switchRef,
                                    }}
                                />
                            )}
                        </div>
                    )}

                    {mounted.has("code") && (
                        <div role="tabpanel" id="wb-panel-code" aria-labelledby="wb-tab-code" hidden={tab !== "code"}>
                            <CodeTab test={t} reload={refreshAll} fwName={fwName} framework={scriptFramework} onFramework={setScriptFramework} />
                        </div>
                    )}

                    {mounted.has("history") && (
                        <div role="tabpanel" id="wb-panel-history" aria-labelledby="wb-tab-history" hidden={tab !== "history"}>
                            <HistoryTab test={t} versions={versions.data} versionsState={{ loading: versions.loading, ...(versions.error ? { error: versions.error } : {}), reload: versions.reload }} refreshKey={historyKey} unsaved={dirty.count} onRestored={(r) => void restoredFromHistory(r)} />
                        </div>
                    )}

                    <div className="wb-bar-slot" ref={setBarSlot} />
                </div>

                <aside className="wb-rail stack" aria-label="Results and script">
                    <ResultsPane
                        quarantineKey={quarantineKey}
                        test={t}
                        reload={test.reload}
                        running={busy === "validate"}
                        onRun={() => void run("validate")}
                        ranOn={ranOn}
                        undo={undo}
                        undoing={undoing}
                        onUndo={() => undo && void goBackTo(undo.goBackTo, { run: true, note: `Undid version ${undo.version}`, headline: `Went back to version ${undo.goBackTo}.` })}
                    />
                    <CoveredRequirements testId={t.id} projectId={t.projectId} />
                    <div className="stack wb-script-slot" ref={setScriptSlot} />
                </aside>
            </div>
        </div>
    );
}
