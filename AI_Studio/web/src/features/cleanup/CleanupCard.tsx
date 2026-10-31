import { Eraser, RotateCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Skeleton } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { CLEANUP_STATUS, leftBehind, runSentence, type CleanupItem, type ProjectCleanup, type RetryResult } from "./cleanup";
import "./cleanup.css";

const SHOWN = 6;

function Item({ item }: { item: CleanupItem }) {
    const s = CLEANUP_STATUS[item.status];
    return (
        <li className="cleanup-item">
            <span>
                <code>POST {item.path}</code>, id <code>{item.recordId}</code>
            </span>
            <Badge tone={s.tone}>{s.label}</Badge>
            {item.reason && <span className="why">{item.reason}</span>}
        </li>
    );
}

/**
 * What the tests that change data created in the application, and what became of it. On the project Overview it appears only when
 * some test changes data; in "panel" form (Tests, More actions) it always opens, so the switch can be reached from there too.
 */
export function CleanupCard({ projectId, variant = "card", onClose }: { projectId: string; variant?: "card" | "panel"; onClose?: () => void }) {
    const data = useFetch<ProjectCleanup>(`/projects/${projectId}/cleanup`);
    const [busy, setBusy] = useState<"" | "retry" | "switch">("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    /** The box shows the choice straight away, while it is being saved. */
    const [choice, setChoice] = useState<boolean | null>(null);

    async function retry() {
        setBusy("retry");
        setError("");
        setNotice("");
        try {
            const r = await api<RetryResult>(`/projects/${projectId}/cleanup/retry`, { method: "POST" });
            setNotice(
                r.failedAgain === 0 && r.notReached === 0
                    ? `Removed ${plural(r.removed, "record")}. Nothing is left to retry.`
                    : `Removed ${r.removed} of ${plural(r.retried, "record")}; ${r.failedAgain + r.notReached} still left behind.${r.notReached ? " Retry again for the rest." : ""}`,
            );
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function setEnabled(on: boolean) {
        setBusy("switch");
        setError("");
        setNotice("");
        setChoice(on);
        try {
            await api(`/projects/${projectId}/cleanup/settings`, { method: "PUT", body: { cleanupAfter: on } });
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setChoice(null);
            setBusy("");
        }
    }

    const panel = variant === "panel";
    const head = (
        <div className="row">
            <Eraser size={18} aria-hidden />
            <h2 className="t-section">Test data cleanup</h2>
            <span className="spacer" />
            {panel && onClose && (
                <Button size="sm" variant="ghost" onClick={onClose}>
                    Close
                </Button>
            )}
        </div>
    );

    if (data.loading) {
        return (
            <section className="stack-sm" aria-label="Test data cleanup">
                <Skeleton h={18} w={180} />
                <Skeleton h={48} />
            </section>
        );
    }
    if (data.error || !data.data) {
        if (!panel) return null; // a card that cannot load stays out of the way; the panel says what happened
        return (
            <section className="card card-pad stack-sm" aria-label="Test data cleanup">
                {head}
                <Callout tone="warning" title="Could not load test data cleanup" actions={<Button size="sm" onClick={() => void data.reload()}>Try again</Button>}>
                    This does not affect your tests. Try again in a moment.
                </Callout>
            </section>
        );
    }

    const d = data.data;
    // The Overview shows the card only for projects whose tests change data (or that already have a ledger).
    if (!panel && d.dataChangingTests === 0 && !d.latest) return null;
    const latest = d.latest;
    const enabled = choice ?? d.enabled;
    const left = latest ? leftBehind(latest.items) : [];
    const retryable = latest ? latest.items.filter((i) => i.canRetry).length : 0;

    return (
        <section className="card card-pad stack-sm" data-testid="cleanup-card" aria-label="Test data cleanup">
            {head}
            {d.dataChangingTests === 0 && !latest && (
                <p className="t-secondary" data-testid="cleanup-none">
                    None of this project’s tests change data, so there is nothing to clean up.
                </p>
            )}
            {d.dataChangingTests > 0 && !latest && (
                <p className="t-secondary" data-testid="cleanup-empty">
                    {plural(d.dataChangingTests, "test")} can create records in the application. When they run, the records they create are listed here and removed again.
                </p>
            )}
            {latest && (
                <>
                    <p data-testid="cleanup-summary">
                        <strong>{runSentence(latest.counts)}</strong>{" "}
                        <span className="t-meta">
                            {relativeTime(latest.at)}
                            {latest.environment ? `, on ${latest.environment}` : ""}
                        </span>
                    </p>
                    {left.length > 0 && (
                        <div className="stack-sm">
                            <div className="row">
                                <h3 className="t-card">Left in the application</h3>
                                <span className="spacer" />
                                {retryable > 0 && (
                                    <Button size="sm" icon={RotateCw} loading={busy === "retry"} disabled={busy !== ""} onClick={() => void retry()}>
                                        Retry removing {plural(retryable, "record")}
                                    </Button>
                                )}
                            </div>
                            <ul className="cleanup-list" aria-label="Records left in the application">
                                {left.slice(0, SHOWN).map((i) => (
                                    <Item key={i.id} item={i} />
                                ))}
                            </ul>
                            {left.length > SHOWN && (
                                <details>
                                    <summary>Show {left.length - SHOWN} more</summary>
                                    <ul className="cleanup-list" aria-label="More records left in the application">
                                        {left.slice(SHOWN).map((i) => (
                                            <Item key={i.id} item={i} />
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                    )}
                </>
            )}
            <label className="check">
                <input type="checkbox" checked={enabled} disabled={busy === "retry"} onChange={(e) => void setEnabled(e.target.checked)} />
                <span>
                    <span className="title">Remove the records tests create after each run</span>
                    <span className="hint">Only records a test created in that run are removed, and only where the application describes how to remove them.</span>
                </span>
            </label>
            {!enabled && (
                <Callout tone="warning" title="Cleanup is off">
                    Records the tests create will stay in the application. Turn it back on to remove them after each run; records already left behind are not removed automatically.
                </Callout>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            {notice && <Callout tone="success">{notice}</Callout>}
        </section>
    );
}
