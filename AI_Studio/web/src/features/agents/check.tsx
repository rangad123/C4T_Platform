/**
 * "Check this computer" on the runner's row (docs/features/runner-check.md): what the runner found when it started. The row says how many
 * things need a look and lists them with how to fix each; Show details lists every line.
 */
import { relativeTime } from "../../lib/format";
import type { RunnerCheck } from "./agents";
import "./check.css";

const STATUS: Record<RunnerCheck["items"][number]["status"], string> = { ok: "OK", missing: "Needs a look", optional: "Optional" };

/** "2 things need a look" with the lines, on the runner's row. Nothing when every required thing is there (or the runner reports no check). */
export function RunnerCheckNote({ check, name }: { check?: RunnerCheck; name: string }) {
    const missing = check?.items.filter((i) => i.status === "missing") ?? [];
    if (!check || missing.length === 0) return null;
    return (
        <div className="ag-check" data-testid="agent-check" role="group" aria-label={`Computer check for ${name}`}>
            <p className="ag-check-head">
                <span className="ag-check-count">{missing.length === 1 ? "1 thing needs a look" : `${missing.length} things need a look`}</span>
                <span className="t-secondary"> on this computer, checked when the runner started {relativeTime(check.at)}</span>
            </p>
            <ul className="ag-check-list">
                {missing.map((i) => (
                    <li key={i.id} data-check={i.id}>
                        {i.title}.{i.fix && <span className="t-secondary"> To fix: {i.fix}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Every line of the check, for Show details. */
export function RunnerCheckDetails({ check }: { check: RunnerCheck }) {
    return (
        <ul className="ag-check-all" data-testid="agent-check-all">
            {check.items.map((i) => (
                <li key={i.id} data-status={i.status}>
                    <span className={`ag-check-status is-${i.status}`}>{STATUS[i.status]}</span>
                    <span>
                        {i.title}.{i.status !== "ok" && i.fix && <span className="t-secondary"> {i.fix}</span>}
                    </span>
                </li>
            ))}
        </ul>
    );
}
