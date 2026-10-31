import { GitCompare, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Callout, ErrorState, ListSkeleton, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import { VERSION_KIND_LABEL, capi, diffStats, errorText, lineDiff, type DiffRow, type SaveResult, type VersionRow } from "./code";
import { Modal } from "./Modal";
import { RunStatus } from "./RunStatus";

const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);

/** Side by side on a wide screen, stacked on a phone. Added and removed lines carry a symbol and a word for screen readers, not only colour. */
export function DiffView({ rows, leftLabel, rightLabel }: { rows: DiffRow[]; leftLabel: string; rightLabel: string }) {
    const stats = diffStats(rows);
    if (rows.length === 0) return <p className="muted" data-testid="diff-same">These two versions are identical.</p>;
    return (
        <div className="code-diff" role="group" aria-label="Line differences" data-testid="diff">
            <p className="t-meta code-diff-sum" data-testid="diff-summary">
                {stats.added} {stats.added === 1 ? "line" : "lines"} added, {stats.removed} {stats.removed === 1 ? "line" : "lines"} removed
            </p>
            <div className="code-diff-head" aria-hidden>
                <span>{leftLabel}</span>
                <span>{rightLabel}</span>
            </div>
            {rows.map((r, i) =>
                r.kind === "gap" ? (
                    <div className="code-diff-gap" key={i}>
                        {r.count} unchanged {r.count === 1 ? "line" : "lines"}
                    </div>
                ) : (
                    <div className={`code-diff-row ${r.kind}`} key={i}>
                        <div className={`cell left ${r.left ? (r.kind === "change" ? "del" : "") : "empty"}`}>
                            {r.left && (
                                <>
                                    <span className="n">{r.left.n}</span>
                                    <span className="sym" aria-hidden>{r.kind === "change" ? "−" : " "}</span>
                                    {r.kind === "change" && <span className="sr-only">Removed: </span>}
                                    <code>{r.left.text || " "}</code>
                                </>
                            )}
                        </div>
                        <div className={`cell right ${r.right ? (r.kind === "change" ? "add" : "") : "empty"}`}>
                            {r.right && (
                                <>
                                    <span className="n">{r.right.n}</span>
                                    <span className="sym" aria-hidden>{r.kind === "change" ? "+" : " "}</span>
                                    {r.kind === "change" && <span className="sr-only">Added: </span>}
                                    <code>{r.right.text || " "}</code>
                                </>
                            )}
                        </div>
                    </div>
                ),
            )}
        </div>
    );
}

/** The list of saved versions, a two-version line diff, and "Restore this version" (which makes a new version). */
export function VersionHistory({ testId, refreshKey, dirty, onRestored }: { testId: string; refreshKey: number; dirty: boolean; onRestored: () => void }) {
    const versions = useFetch<VersionRow[]>(`/tests/${testId}/script-versions`);
    useEffect(() => {
        if (refreshKey > 0) void versions.reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshKey]);
    const [picked, setPicked] = useState<number[]>([]);
    const [contents, setContents] = useState<Record<number, string>>({});
    const [loadingDiff, setLoadingDiff] = useState(false);
    const [diffError, setDiffError] = useState("");
    const [restoring, setRestoring] = useState<VersionRow | null>(null);
    const [busy, setBusy] = useState(false);
    const [restoreError, setRestoreError] = useState("");
    const [restored, setRestored] = useState<{ res: SaveResult; from: number } | null>(null);

    const list = versions.data ?? [];
    const latest = list[0] ? Math.max(...list.map((v) => v.version)) : undefined;

    // The two versions to compare: two picked, or one picked against the newest.
    const pair = useMemo(() => {
        if (picked.length === 2) return [Math.min(...picked), Math.max(...picked)] as const;
        if (picked.length === 1 && latest !== undefined && picked[0] !== latest) return [picked[0]!, latest] as const;
        return null;
    }, [picked, latest]);

    useEffect(() => {
        if (!pair) return;
        const need = pair.filter((v) => contents[v] === undefined);
        if (!need.length) return;
        let gone = false;
        setLoadingDiff(true);
        setDiffError("");
        Promise.all(need.map((v) => capi<{ version: number; content: string }>(`/tests/${testId}/script-versions/${v}`)))
            .then((rows) => !gone && setContents((c) => ({ ...c, ...Object.fromEntries(rows.map((r) => [r.version, r.content])) })))
            .catch((e) => !gone && setDiffError(errorText(e)))
            .finally(() => !gone && setLoadingDiff(false));
        return () => {
            gone = true;
        };
    }, [pair?.[0], pair?.[1], testId]); // eslint-disable-line react-hooks/exhaustive-deps

    const rows = pair && contents[pair[0]] !== undefined && contents[pair[1]] !== undefined ? lineDiff(contents[pair[0]]!, contents[pair[1]]!) : null;

    function toggle(v: number) {
        setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : p.length >= 2 ? [p[1]!, v] : [...p, v]));
    }

    async function restore() {
        if (!restoring) return;
        setBusy(true);
        setRestoreError("");
        try {
            const res = await capi<SaveResult>(`/tests/${testId}/script-versions/${restoring.version}/restore`, { method: "POST" });
            setRestored({ res, from: restoring.version });
            setRestoring(null);
            setPicked([]);
            onRestored();
        } catch (e) {
            setRestoreError(errorText(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card" aria-labelledby="code-history-title" id="code-history">
            <div className="card-head wrap">
                <GitCompare size={18} aria-hidden />
                <h2 className="t-section" id="code-history-title">Version history</h2>
                <span className="t-meta">Every save is kept. Tick one version to compare it with the newest, or two to compare them.</span>
            </div>
            {versions.loading ? (
                <ListSkeleton rows={3} />
            ) : versions.error ? (
                <ErrorState error={friendlyError(versions.error.message)} onRetry={versions.reload} />
            ) : list.length === 0 ? (
                <p className="code-ok t-secondary">No versions yet. Save the script and it appears here.</p>
            ) : (
                <ul className="divided code-versions" data-testid="versions">
                    {list.map((v) => (
                        <li className="code-version" key={v.version} data-version={v.version}>
                            <label className="code-version-pick">
                                <input type="checkbox" checked={picked.includes(v.version)} onChange={() => toggle(v.version)} />
                                <span className="sr-only">Compare version {v.version}</span>
                            </label>
                            <span className="code-version-main">
                                <span className="t-card">Version {v.version}</span>
                                <Badge tone={v.kind === "generated" ? "neutral" : v.kind === "restored" ? "info" : "brand"}>{VERSION_KIND_LABEL[v.kind]}</Badge>
                                {v.version === latest && <Badge tone="success">Current</Badge>}
                                <span className="t-meta">
                                    {relativeTime(v.createdAt)}, {kb(v.bytes)}
                                    {v.by ? `, by ${v.by}` : ""}
                                </span>
                                {v.note && <span className="code-version-note">{v.note}</span>}
                            </span>
                            {v.version !== latest && (
                                <Button size="sm" icon={RotateCcw} onClick={() => { setRestoreError(""); setRestoring(v); }} aria-label={`Restore version ${v.version}`}>
                                    Restore this version
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {pair && (
                <div className="code-diff-wrap">
                    <h3 className="t-card">
                        Version {pair[0]} compared with version {pair[1]}
                    </h3>
                    {loadingDiff && <Skeleton h={80} />}
                    {diffError && <Callout tone="danger" title="We couldn’t load those versions">{diffError}</Callout>}
                    {rows && <DiffView rows={rows} leftLabel={`Version ${pair[0]}`} rightLabel={`Version ${pair[1]}`} />}
                </div>
            )}

            {restored && (
                <div className="code-diff-wrap">
                    <Callout tone="success" title={`Version ${restored.from} is restored`}>
                        {restored.res.version !== undefined ? `It was saved as the new version ${restored.res.version}. ` : ""}The editor shows it now.
                    </Callout>
                    <RunStatus testId={testId} jobId={restored.res.jobId ?? null} note={restored.res.note} key={restored.res.version ?? restored.from} />
                </div>
            )}

            {restoring && (
                <Modal
                    title={`Restore version ${restoring.version}?`}
                    titleId="code-restore-title"
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
                        This saves version {restoring.version} again as the newest version and runs the test. Nothing is deleted: the versions in between stay in the history.
                        {dirty ? " The changes you have not saved in the editor are replaced." : ""}
                    </p>
                    {restoreError && <Callout tone="danger">{restoreError}</Callout>}
                </Modal>
            )}
        </section>
    );
}
