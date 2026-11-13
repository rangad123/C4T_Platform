import { Eye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Job } from "../../api";
import { isActive } from "../../lib/labels";
import { Tooltip } from "../../components/Tooltip";
import { StopRun } from "../runs/StopDialog";
import { useExplorerFrames, useNow, useTabVisible, useThrottled } from "./explorer";
import { phoneFinishedWords, isPhoneJob, isPhoneOnly } from "../phone/phone";
import { ELSEWHERE, EXPLAIN, EXPLAIN_FINISHED, EXPLAIN_RUNNER, EXPLAIN_RUNNER_FINISHED, EXPLAIN_PHONE, EXPLAIN_PHONE_FINISHED, NOTHING, WAITING, canOfferWatch, finishedWords, forget, keptFor, pagesWords, phaseWords, readWatch, updatedWords, writeWatch } from "./explorer-text";
import "./explorer.css";

type Stoppable = Pick<Job, "jobId" | "projectId" | "mode"> & { planOnly?: boolean };

/** A labelled switch (a button with role "switch"), off until asked for. */
function WatchSwitch({ on, onChange, phone }: { on: boolean; onChange: (v: boolean) => void; phone?: boolean }) {
    return (
        <div className="ex-toggle">
            <Tooltip content="Remembered in this browser. While it is off, nothing is asked for and the platform takes no pictures.">
                <button type="button" id="ex-watch" role="switch" aria-checked={on} aria-labelledby="ex-watch-label ex-watch-state" aria-describedby="ex-watch-hint" className="ex-switch" onClick={() => onChange(!on)}>
                    <span className="ex-knob" aria-hidden />
                    <span id="ex-watch-label">Watch live</span>
                    <span id="ex-watch-state" className="ex-switch-state">
                        {on ? "On" : "Off"}
                    </span>
                </button>
            </Tooltip>
            <span id="ex-watch-hint" className="hint">
                {phone ? "See the phone screen the AI is using." : "See the browser the AI is using."}
            </span>
        </div>
    );
}

/**
 * The Explorer view of a job: a picture of the browser the AI is using, its address, what it just did, and the usual Stop control.
 * `running` false is the finished state: the last picture this tab had stays on screen (the platform no longer holds it).
 */
function Panel({ job, running, onStopped }: { job: Job; running: boolean; onStopped?: () => void }) {
    const visible = useTabVisible();
    const polling = running && visible;
    const w = useExplorerFrames(job.projectId, job.jobId, polling, () => job.counters?.pagesDiscovered ?? 0);
    const now = useNow(running && visible);
    const shown = w.shown;
    const note = shown?.note ?? "";
    // The line is always visible as it changes; a screen reader hears it at most once every five seconds.
    const heard = useThrottled(running ? note : "");
    const kept = keptFor(job.jobId);
    const pages = Math.max(job.counters?.pagesDiscovered ?? 0, kept?.pages ?? 0, shown?.pagesSeen ?? 0);
    // A phone picture is portrait and belongs to an app: the frame, the words and the facts follow it. A job that has only the phone app says so before its first picture.
    const phone = shown?.kind === "phone" || isPhoneOnly(job);
    const phase = running ? phaseWords(shown?.phase, phone) : "";

    const calm = !running
        ? ""
        : w.state === "waiting" && !shown
          ? WAITING
          : w.state === "nothing"
            ? w.reason || NOTHING
            : w.state === "elsewhere"
              ? w.reason || ELSEWHERE
              : w.state === "stopping" || w.state === "unavailable"
                ? w.reason
                : "";

    return (
        <section className="ex-panel" aria-labelledby="ex-title" data-testid="explorer-view">
            <div className="ex-head">
                <Eye size={18} aria-hidden />
                {/* Under the progress card it is a sub-heading; on its own, after the exploration, it follows the page title. */}
                {running ? (
                    <h3 className="t-card" id="ex-title">
                        Explorer view
                    </h3>
                ) : (
                    <h2 className="t-card" id="ex-title">
                        Explorer view
                    </h2>
                )}
                <span className="spacer" />
                {running && <StopRun job={job as Stoppable} onRequested={onStopped} />}
            </div>

            <div className={`ex-frame${calm && shown ? " is-stale" : ""}${phone ? " ex-frame-phone" : ""}`}>
                {shown && phone ? (
                    <div className="ph-device">
                        <img className="ex-img ph-screen" data-testid="explorer-image" src={shown.src} alt={`${shown.app || "The phone app"}, ${shown.title || "current screen"}`} />
                    </div>
                ) : shown ? (
                    <img className="ex-img" data-testid="explorer-image" src={shown.src} alt={`${shown.title || "The page"}, at ${shown.url}`} />
                ) : (
                    <p className="ex-empty t-secondary" role="status" data-testid="explorer-empty">
                        {running ? calm || WAITING : "There is no picture to show."}
                    </p>
                )}
            </div>

            {running && visible && (w.state === "error" || calm) && shown && (
                <p className="hint" role="status" data-testid="explorer-state">
                    {w.state === "error" ? w.problem : calm}
                </p>
            )}
            {running && w.state === "error" && !shown && (
                <p className="hint" role="status" data-testid="explorer-state">
                    {w.problem}
                </p>
            )}
            {running && !visible && <p className="hint">Paused while this tab is in the background.</p>}

            {shown && (
                <dl className="ex-facts">
                    {phone ? (
                        <>
                            <div>
                                <dt>App</dt>
                                <dd data-testid="explorer-app">{shown.app || "The phone app"}</dd>
                            </div>
                            <div>
                                <dt>Screen</dt>
                                <dd data-testid="explorer-title">{shown.title || "No title"}</dd>
                            </div>
                        </>
                    ) : (
                        <>
                            <div>
                                <dt>Address</dt>
                                <dd className="ex-mono" data-testid="explorer-url">
                                    {shown.url}
                                </dd>
                            </div>
                            <div>
                                <dt>Page title</dt>
                                <dd data-testid="explorer-title">{shown.title || "No title"}</dd>
                            </div>
                        </>
                    )}
                    {running && (
                        <div>
                            <dt>Doing now</dt>
                            <dd>
                                <span data-testid="explorer-note" aria-hidden>
                                    {note}
                                </span>
                                <span className="sr-only" aria-live="polite" data-testid="explorer-note-live">
                                    {heard}
                                </span>
                            </dd>
                        </div>
                    )}
                </dl>
            )}

            {running ? (
                <p className="t-meta ex-line" data-testid="explorer-status">
                    {[phase, phone ? "" : pagesWords(pages), shown ? updatedWords(now - shown.takenAt) : ""].filter(Boolean).join(", ")}
                </p>
            ) : (
                <p className="t-secondary" role="status" data-testid="explorer-finished">
                    {phone ? phoneFinishedWords(pages, job.status === "FAILED" && job.error === "Cancelled") : finishedWords(job.mode, pages, job.status === "FAILED" && job.error === "Cancelled")}
                </p>
            )}

            <p className="hint ex-explain" data-testid="explorer-explain">{phone ? (running ? EXPLAIN_PHONE : EXPLAIN_PHONE_FINISHED) : shown?.onRunner ? (running ? EXPLAIN_RUNNER : EXPLAIN_RUNNER_FINISHED) : running ? EXPLAIN : EXPLAIN_FINISHED}</p>
        </section>
    );
}

/**
 * Where a person turns the Explorer view on: under the steps of an exploration or of a test built from a sentence. Off by default and remembered in this
 * browser. Costs nothing while off: no request is made and the platform takes no pictures. When the job has ended, the last picture this tab had stays.
 */
export function ExplorerWatch({ job, onPanel }: { job: Job; onPanel?: (open: boolean) => void }) {
    const active = isActive(job.status);
    const [on, setOn] = useState(readWatch);
    const eligible = canOfferWatch(job);
    const open = eligible && active && on;
    const lastActive = useRef(active);
    lastActive.current = active;

    useEffect(() => {
        onPanel?.(open);
        return () => onPanel?.(false);
    }, [open, onPanel]);

    // A finished panel drops what it kept when the person leaves (a running one hands its picture on to the finished one).
    useEffect(
        () => () => {
            if (!lastActive.current) forget(job.jobId);
        },
        [job.jobId],
    );

    if (!eligible) return null;
    if (!active) return keptFor(job.jobId) ? <Panel job={job} running={false} /> : null;
    return (
        <div className="ex-watch" data-tour="explorer-view">
            <WatchSwitch
                phone={isPhoneJob(job)}
                on={on}
                onChange={(v) => {
                    setOn(v);
                    writeWatch(v);
                }}
            />
            {open && <Panel job={job} running />}
        </div>
    );
}
