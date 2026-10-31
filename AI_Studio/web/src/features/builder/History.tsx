import { stepSentence } from "../../lib/labels";
import type { Step } from "./builder";
import { summarise, type StepDiff, type StepRow } from "./stepdiff";

/** The person's own note on a step if there is one, else the automatic sentence (same rule as the step list). */
function sentence(step: Step): string {
    const note = typeof step.description === "string" ? step.description.trim() : "";
    return note || stepSentence(step);
}

const MARK: Record<StepRow["kind"], { symbol: string; word: string }> = {
    same: { symbol: " ", word: "Unchanged" },
    added: { symbol: "+", word: "Added" },
    removed: { symbol: "−", word: "Removed" },
    changed: { symbol: "~", word: "Changed" },
    moved: { symbol: "↕", word: "Moved" },
};

/** Long runs of unchanged steps fold into one line so the changes stand out. */
function fold(rows: StepRow[]): Array<StepRow | { kind: "gap"; count: number }> {
    const out: Array<StepRow | { kind: "gap"; count: number }> = [];
    let run: StepRow[] = [];
    const end = () => {
        if (run.length > 3) out.push({ kind: "gap", count: run.length });
        else out.push(...run);
        run = [];
    };
    for (const r of rows) {
        if (r.kind === "same") run.push(r);
        else {
            end();
            out.push(r);
        }
    }
    end();
    return out;
}

/** Added, removed, changed and moved steps in plain words. A symbol and a word carry the meaning, not only colour. */
export function StepDiffView({ diff, leftLabel, rightLabel }: { diff: StepDiff; leftLabel: string; rightLabel: string }) {
    if (diff.same) {
        return (
            <p className="muted" data-testid="step-diff-same">
                These two versions are identical.
            </p>
        );
    }
    return (
        <div className="bld-diff" role="group" aria-label={`Differences between ${leftLabel} and ${rightLabel}`} data-testid="step-diff">
            <p className="t-meta bld-diff-sum" data-testid="step-diff-summary">
                {summarise(diff)}
            </p>
            {diff.details.length > 0 && (
                <ul className="bld-diff-details" aria-label="Other changes">
                    {diff.details.map((d, i) => (
                        <li key={i} className={`bld-diff-row is-${d.kind}`}>
                            <span className="bld-diff-sym" aria-hidden>
                                {d.kind === "added" ? "+" : d.kind === "removed" ? "−" : "~"}
                            </span>
                            <span className="bld-diff-word">{d.kind === "added" ? "Added" : d.kind === "removed" ? "Removed" : "Changed"}</span>
                            <span className="bld-diff-body">
                                <strong>{d.what}</strong>
                                {d.kind === "changed" && (
                                    <>
                                        {": "}
                                        <span className="bld-diff-was">{d.from || "(empty)"}</span> became <span className="bld-diff-now">{d.to || "(empty)"}</span>
                                    </>
                                )}
                                {d.kind === "added" && <>: {d.to || "(empty)"}</>}
                                {d.kind === "removed" && <>: {d.from || "(empty)"}</>}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <ol className="bld-diff-steps" aria-label="Steps">
                {fold(diff.rows).map((r, i) =>
                    r.kind === "gap" ? (
                        <li key={i} className="bld-diff-gap">
                            {r.count} unchanged steps
                        </li>
                    ) : (
                        <li key={i} className={`bld-diff-row is-${r.kind}`} data-change={r.kind}>
                            <span className="bld-diff-sym" aria-hidden>
                                {MARK[r.kind].symbol}
                            </span>
                            <span className="bld-diff-word">{MARK[r.kind].word}</span>
                            <span className="bld-diff-body">
                                <span className="bld-diff-n">
                                    {r.kind === "added" ? `Step ${r.after}` : r.kind === "removed" ? `Was step ${r.before}` : r.kind === "same" ? `Step ${r.after}` : r.before === r.after ? `Step ${r.after}` : `Step ${r.after}, was step ${r.before}`}
                                </span>{" "}
                                {r.kind === "changed" ? (
                                    <>
                                        <span className="bld-diff-was">{sentence(r.from)}</span> became <span className="bld-diff-now">{sentence(r.to)}</span>
                                        {r.fields.length > 0 && <span className="t-meta bld-diff-fields"> Changed: {r.fields.join(", ")}.</span>}
                                    </>
                                ) : (
                                    <span>{sentence(r.step)}</span>
                                )}
                            </span>
                        </li>
                    ),
                )}
            </ol>
        </div>
    );
}
