import { Tooltip } from "../../components/Tooltip";
import type { LiveState } from "../../lib/stream";
import "./live.css";

/**
 * One line that always takes the same space, so nothing jumps when live updates start, pause or stop.
 * Only this line is a polite live region (the newest message), never the whole log.
 */
export function LiveLine({ state, latest }: { state: LiveState; latest?: string }) {
    const retrying = state === "retrying";
    return (
        <div className="live-line" data-live-state={state}>
            {state === "live" || retrying ? <span className={`live-dot ${retrying ? "retrying" : ""}`} aria-hidden /> : null}
            <span className="live-text" role="status" aria-live="polite">
                {retrying ? "Live updates paused, retrying. This page still refreshes on its own." : state === "live" ? (latest ?? "Live. Waiting for the next step.") : ""}
            </span>
        </div>
    );
}

/** A small marker for a run that is updating live. */
export function LiveBadge({ state }: { state: LiveState }) {
    if (state !== "live") return null;
    return (
        <Tooltip content="This run is updating live: each step shows here as it happens, without reloading the page.">
            <span className="live-badge" tabIndex={0}>
                <span className="live-dot" aria-hidden />
                Live
            </span>
        </Tooltip>
    );
}
