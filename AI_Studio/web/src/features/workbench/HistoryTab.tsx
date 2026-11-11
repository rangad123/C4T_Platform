import { Bot, CircleCheck, CircleX, Code2, Download, FilePen, GitCompare, History, RotateCcw, ShieldOff, Wrench, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { artifactUrl, api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, Skeleton } from "../../components/ui";
import { BadgeKey, Tooltip } from "../../components/Tooltip";
import { duration, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError, describeApiError } from "../../lib/labels";
import { bapi } from "../builder/builder";
import { StepDiffView } from "../builder/History";
import { diffSteps } from "../builder/stepdiff";
import { lineDiff, type VersionRow } from "../code/code";
import { Modal } from "../../components/Modal";
import { DiffView } from "../code/VersionHistory";
import type { Suggestion } from "../healing/healing";
import { originOf } from "../provenance/provenance";
import { HISTORY_WORDS, type TestQuarantine } from "../quarantine/quarantine";
import { buildHistory, comparePair, type Detail, type HistoryEntry, type HistoryKind, type SpecVersionRow } from "./test-model";
import { restoreSpecVersion, type SpecVersionBody } from "./restore";


/** A run of this test in its history (test-model.ts: anything but passed counts as did not pass, findings included). */
const RUN_PASSED = "This run of the test passed: every step and check worked.";
const RUN_NOT_PASSED = "This run of the test did not pass: a step or check failed, it could not run, or it found something that needs a look.";
const ICON: Record<HistoryKind, LucideIcon> ={ steps: FilePen, text: FilePen, restore: RotateCcw, original: FilePen, code: Code2, run: CircleCheck, repair: Wrench, "auto-fix": Bot, import: Download, quarantine: ShieldOff };

export interface Restored {
    family: "steps" | "code";
    from: number;
    changed: boolean;
    jobId: string | null;
    /** What the run really runs, when that is not this version (a draft never runs). */
    note?: string | undefined;
}

/**
 * Everything that happened to this test in one list, newest first: versions of the steps (edited as steps or as text), versions of
 * the code, runs with their evidence, repairs and auto-fixes, an import, quarantine. A version can be compared with another of the
 * same kind (a step difference or a line difference) and restored; nothing is deleted by a restore.
 */
export function HistoryTab({ test: t, versions, versionsState, refreshKey, unsaved, onRestored }: { test: Detail; versions: SpecVersionRow[] | undefined; versionsState: { loading: boolean; error?: Error; reload: () => Promise<void> }; refreshKey: number; unsaved: number; onRestored: (r: Restored) => void }) {
    const code = useFetch<VersionRow[]>(`/tests/${t.id}/script-versions`);
    const healing = useFetch<{ proposals: Suggestion[] }>((t.kind === "web" || t.kind === "mobile") && !t.custom ? `/tests/${t.id}/healing` : null);
    const quarantine = useFetch<TestQuarantine>(`/tests/${t.id}/quarantine`);
    useEffect(() => {
        if (refreshKey > 0) {
            void code.reload();
            void healing.reload();
            void quarantine.reload();
        }
    }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const origin = originOf(t as never);
    const firstScript = t.scripts.map((s) => s.createdAt).filter((d): d is string => !!d).sort()[0] ?? null;
    const entries = useMemo(() => {
        const meta = t.generationMeta ?? {};
        const imported = t.custom?.origin === "git" ? { text: `Imported from Git${t.custom.git ? ` (${t.custom.git.host}${t.custom.git.path.startsWith("/") ? "" : "/"}${t.custom.git.path}, ${t.custom.git.ref})` : ""}`, at: t.custom.git?.importedAt ?? t.custom.since } : meta.source === "git-import" ? { text: "Imported from Git", at: firstScript } : meta.imported ? { text: "Imported from a file", at: firstScript } : null;
        return buildHistory({
            specVersions: versions ?? [],
            codeVersions: (code.data ?? []).map((v) => ({ version: v.version, createdAt: v.createdAt, note: v.note, kind: v.kind, by: v.by })),
            executions: t.executions,
            repairs: healing.data?.proposals ?? [],
            autoFix: origin.autoFix ? { attempts: origin.autoFix.attempts, at: t.executions.find((e) => e.status === "passed")?.startedAt ?? null } : null,
            imported,
            quarantine: (quarantine.data?.history ?? []).map((h) => ({ id: String(h.id), at: h.at, by: h.by, kind: HISTORY_WORDS[h.kind] ?? h.kind, reason: h.reason })),
        });
    }, [versions, code.data, healing.data, quarantine.data, t, origin.autoFix, firstScript]);

    const [picked, setPicked] = useState<Array<{ family: "steps" | "code"; n: number }>>([]);
    const [restoring, setRestoring] = useState<HistoryEntry | null>(null);
    const [busy, setBusy] = useState(false);
    const [restoreError, setRestoreError] = useState("");
    const [done, setDone] = useState<Restored | null>(null);

    const newestOf = (family: "steps" | "code") => {
        const ns = entries.filter((e) => e.version?.family === family).map((e) => e.version!.n);
        return ns.length ? Math.max(...ns) : undefined;
    };
    const pair = comparePair(picked, { steps: newestOf("steps"), code: newestOf("code") });
    const [compare, setCompare] = useState<{ key: string; state: "loading" | "error" | "ready"; error?: string; steps?: ReturnType<typeof diffSteps>; lines?: ReturnType<typeof lineDiff> } | null>(null);
    useEffect(() => {
        if (!pair || "problem" in pair) return setCompare(null);
        const key = `${pair.family}:${pair.from}:${pair.to}:${refreshKey}`;
        let gone = false;
        setCompare({ key, state: "loading" });
        const load = pair.family === "steps"
            ? Promise.all([bapi<SpecVersionBody>(`/tests/${t.id}/spec-versions/${pair.from}`), bapi<SpecVersionBody>(`/tests/${t.id}/spec-versions/${pair.to}`)]).then(([a, b]) => ({ steps: diffSteps(a.spec, b.spec) }))
            : Promise.all([api<{ content: string }>(`/tests/${t.id}/script-versions/${pair.from}`), api<{ content: string }>(`/tests/${t.id}/script-versions/${pair.to}`)]).then(([a, b]) => ({ lines: lineDiff(a.content, b.content) }));
        load.then((r) => !gone && setCompare({ key, state: "ready", ...r })).catch((e) => !gone && setCompare({ key, state: "error", error: describeApiError(e) }));
        return () => {
            gone = true;
        };
    }, [pair && !("problem" in pair) ? `${pair.family}:${pair.from}:${pair.to}` : "", refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

    function toggle(e: HistoryEntry) {
        if (!e.version) return;
        const v = { family: e.version.family, n: e.version.n };
        setPicked((p) => (p.some((x) => x.family === v.family && x.n === v.n) ? p.filter((x) => !(x.family === v.family && x.n === v.n)) : [...p, v].slice(-2)));
    }

    async function restore() {
        if (!restoring?.version) return;
        setBusy(true);
        setRestoreError("");
        const { family, n } = restoring.version;
        try {
            if (family === "steps") {
                const r = await restoreSpecVersion(t.id, n, { run: true });
                setDone({ family, from: n, changed: r.changed, jobId: r.jobId, note: r.note });
                onRestored({ family, from: n, changed: r.changed, jobId: r.jobId, note: r.note });
            } else {
                const r = await api<{ jobId?: string | null; note?: string }>(`/tests/${t.id}/script-versions/${n}/restore`, { method: "POST" });
                setDone({ family, from: n, changed: true, jobId: r.jobId ?? null, note: r.note });
                onRestored({ family, from: n, changed: true, jobId: r.jobId ?? null, note: r.note });
            }
            setRestoring(null);
            setPicked([]);
        } catch (e) {
            setRestoreError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    const loading = versionsState.loading || code.loading;
    if (loading) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading the history">
                <ListSkeleton rows={5} />
            </div>
        );
    }
    if (versionsState.error) return <ErrorState error={friendlyError(versionsState.error.message)} onRetry={() => void versionsState.reload()} />;

    return (
        <section className="card" aria-labelledby="wb-history-title" data-testid="history">
            <div className="card-head wrap">
                <History size={18} aria-hidden />
                <h2 className="t-section" id="wb-history-title">
                    Everything that happened to this test
                </h2>
                <BadgeKey
                    label="the badges in the history"
                    entries={[
                        entries.some((e) => e.version?.current) && { word: "Current", text: "The version the test uses now." },
                        entries.some((e) => e.run?.status === "passed") && { word: "Passed", text: RUN_PASSED },
                        entries.some((e) => e.run && e.run.status !== "passed") && { word: "Did not pass", text: RUN_NOT_PASSED },
                    ]}
                />
                <span className="t-meta">Newest first. Tick one version to compare it with the newest, or two to compare them. Restoring saves an old version again as the newest: nothing is deleted.</span>
            </div>
            {done && (
                <div className="wb-history-note" role="status">
                    <Callout tone="success" title={`${done.family === "steps" ? "Steps" : "Code"} version ${done.from} is restored`}>
                        {done.changed ? "It was saved as the newest version." : "These were already the current steps, so nothing was saved."} {done.jobId ? "The test is running again." : ""} {done.jobId && done.note ? done.note : ""}
                    </Callout>
                </div>
            )}
            {entries.length === 0 ? (
                <EmptyState icon={History} title="Nothing has happened yet">
                    Edits, runs and repairs of this test appear here as they happen.
                </EmptyState>
            ) : (
                <ol className="wb-history divided" aria-label="History of this test">
                    {entries.map((e) => {
                        const Icon = e.kind === "run" ? (e.run?.status === "passed" ? CircleCheck : CircleX) : ICON[e.kind];
                        const on = !!e.version && picked.some((x) => x.family === e.version!.family && x.n === e.version!.n);
                        return (
                            <li key={e.key} className={`wb-hist is-${e.kind}${e.run ? ` is-${e.run.status}` : ""}`} data-kind={e.kind}>
                                {e.version ? (
                                    <label className="wb-hist-pick">
                                        <input type="checkbox" checked={on} onChange={() => toggle(e)} />
                                        <span className="sr-only">Compare {e.version.family === "steps" ? "steps" : "code"} version {e.version.n}</span>
                                    </label>
                                ) : (
                                    <span className="wb-hist-pick" aria-hidden>
                                        <Icon size={18} />
                                    </span>
                                )}
                                <span className="wb-hist-main">
                                    <span className="wb-hist-title">
                                        {e.version && <Icon size={16} aria-hidden />}
                                        <span className="t-card">{e.title}</span>
                                        {e.version && <Badge tone="neutral">{e.version.family === "steps" ? `Steps, version ${e.version.n}` : `Code, version ${e.version.n}`}</Badge>}
                                        {e.version?.current && <Badge tone="success" tip="The version the test uses now.">Current</Badge>}
                                        {e.run && <Badge tone={e.run.status === "passed" ? "success" : "danger"} tip={e.run.status === "passed" ? RUN_PASSED : RUN_NOT_PASSED}>{e.run.status === "passed" ? "Passed" : "Did not pass"}</Badge>}
                                    </span>
                                    <span className="t-meta">
                                        {e.at ? (
                                            <Tooltip content={new Date(e.at).toLocaleString()}>
                                                <time dateTime={e.at} tabIndex={0}>
                                                    {relativeTime(e.at)}
                                                </time>
                                            </Tooltip>
                                        ) : (
                                            "Date not recorded"
                                        )}
                                        {e.run ? `, attempt ${e.run.attempt}, ${duration(e.run.durationMs)}` : ""}
                                    </span>
                                    {e.detail && <span className="t-secondary">{e.detail}</span>}
                                    {e.run?.evidence && (
                                        <a href={artifactUrl(e.run.evidence.id)} target="_blank" rel="noreferrer">
                                            See the screenshot<span className="sr-only"> (opens in a new tab)</span>
                                        </a>
                                    )}
                                </span>
                                {e.version && !e.version.current && (
                                    <Button size="sm" icon={RotateCcw} aria-label={`Restore ${e.version.family === "steps" ? "steps" : "code"} version ${e.version.n}`} onClick={() => (setRestoreError(""), setRestoring(e))}>
                                        Restore this version
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}

            {pair && "problem" in pair && (
                <div className="code-diff-wrap">
                    <Callout tone="warning">{pair.problem}</Callout>
                </div>
            )}
            {pair && !("problem" in pair) && (
                <div className="code-diff-wrap" data-testid="history-compare">
                    <h3 className="t-card">
                        {pair.family === "steps" ? "Steps" : "Code"} version {pair.from} compared with version {pair.to}
                    </h3>
                    {compare?.state === "loading" && <Skeleton h={80} />}
                    {compare?.state === "error" && (
                        <Callout tone="danger" title="We couldn’t load those versions">
                            {compare.error}
                        </Callout>
                    )}
                    {compare?.state === "ready" && compare.steps && <StepDiffView diff={compare.steps} leftLabel={`version ${pair.from}`} rightLabel={`version ${pair.to}`} />}
                    {compare?.state === "ready" && compare.lines && <DiffView rows={compare.lines} leftLabel={`Version ${pair.from}`} rightLabel={`Version ${pair.to}`} />}
                </div>
            )}

            {restoring?.version && (
                <Modal
                    title={`Restore ${restoring.version.family === "steps" ? "steps" : "code"} version ${restoring.version.n}?`}
                    titleId="wb-restore-title"
                    onClose={() => setRestoring(null)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setRestoring(null)}>
                                Cancel
                            </Button>
                            <Button variant="primary" loading={busy} onClick={() => void restore()}>
                                Restore this version
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">
                        This saves version {restoring.version.n} again as the newest version and runs the test. Nothing is deleted: the versions in between stay in the history.
                        {unsaved > 0 ? " The changes you have not saved are replaced." : ""}
                    </p>
                    {restoreError && <Callout tone="danger">{restoreError}</Callout>}
                </Modal>
            )}
        </section>
    );
}
