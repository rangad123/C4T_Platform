import { diffStats, type DiffRow } from "./code";
import "./code.css";

/* A code test's versions are listed, compared and restored on the History tab of its page (workbench/HistoryTab.tsx), which uses this. */

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
