import { Camera, Check, ChevronRight, Circle, CircleX } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, getKey, type EventRow, type Job } from "../../api";
import { Button } from "../../components/ui";
import { mergeEvents, type JobStream } from "../../lib/stream";
import { RelTime } from "./RunTime";
import { useMyRunner } from "../runners/my-runner";
import { currentLine, foldLiveRun, isRunnerEvent, liveShotUrl, LIVE_STEPS, PHASE_STEP_WORD, phaseEnded, phaseSentence, runnerIdOf, stepOf, runPhase, shotCaption, type LiveRun, type TaskPhase } from "./live-run";
import "./runs.css";

const PAGE = 500;

/**
 * A run's runner events, with their facts, kept fresh: all of them read once from the platform, then the new ones as the live stream
 * brings them (a runner event's frame carries its facts). A frame without them (an older platform) makes it read the new events
 * back from the platform instead, and so does every few seconds without a stream. Everything comes from stored events, so a refresh,
 * or coming back later, shows the same picture.
 */
export function useLiveRun(jobId: string | null, enabled: boolean, active: boolean, stream: Pick<JobStream, "events" | "live">): { live: LiveRun; loaded: boolean } {
    const [rows, setRows] = useState<EventRow[]>([]);
    const [loaded, setLoaded] = useState(false);
    const last = useRef(0);
    const flying = useRef<Promise<void> | null>(null);
    const again = useRef(false);
    const generation = useRef(0);

    const pull = useCallback((): Promise<void> => {
        if (!jobId) return Promise.resolve();
        if (flying.current) {
            again.current = true;
            return flying.current;
        }
        const mine = generation.current;
        const read = async () => {
            const got: EventRow[] = [];
            // Pages of 500 until a short one; a run with a very long log is read in a few pages, never all at once.
            for (let i = 0; i < 200; i++) {
                const page = await api<EventRow[]>(`/test-generation/${jobId}/events?after=${last.current}`);
                if (mine !== generation.current) return;
                for (const e of page) last.current = Math.max(last.current, e.id);
                got.push(...page.filter(isRunnerEvent));
                if (page.length < PAGE) break;
            }
            if (got.length) setRows((prev) => mergeEvents(prev, got));
            setLoaded(true);
        };
        flying.current = read()
            .catch(() => undefined)
            .finally(() => {
                flying.current = null;
                if (again.current && mine === generation.current) {
                    again.current = false;
                    void pull();
                }
            });
        return flying.current;
    }, [jobId]);

    useEffect(() => {
        generation.current++;
        last.current = 0;
        merged.current = 0;
        again.current = false;
        flying.current = null;
        setRows([]);
        setLoaded(false);
        if (enabled && jobId) void pull();
    }, [jobId, enabled, pull]);

    // The stream brought events: the runner's ones join the picture at once; if one came without its facts, read what is new instead.
    const newest = stream.events.at(-1)?.id ?? 0;
    const merged = useRef(0);
    useEffect(() => {
        if (!enabled || newest <= merged.current) return;
        const fresh = stream.events.filter((e) => e.id > merged.current && isRunnerEvent(e));
        merged.current = newest;
        if (fresh.length === 0) return;
        if (fresh.some((e) => e.kind.startsWith("runner_") && e.data === undefined)) {
            const t = window.setTimeout(() => void pull(), 300);
            return () => clearTimeout(t);
        }
        setRows((prev) => mergeEvents(prev, fresh));
    }, [newest, enabled, pull, stream.events]);

    // Without the stream, look every few seconds while the run goes.
    useEffect(() => {
        if (!enabled || !active || stream.live) return;
        const t = window.setInterval(() => void pull(), 3000);
        return () => clearInterval(t);
    }, [enabled, active, stream.live, pull]);

    // The run just ended: one last read, so the picture is complete.
    const wasActive = useRef(active);
    useEffect(() => {
        if (wasActive.current && !active && enabled) void pull();
        wasActive.current = active;
    }, [active, enabled, pull]);

    const live = useMemo(() => foldLiveRun(rows), [rows]);
    return { live, loaded };
}

/** True when the run is on the person's own runner (GET /api/me/runner, the page's shared answer). */
export function useIsMine(job: Pick<Job, "ranOn">): boolean {
    const runnerId = runnerIdOf(job);
    const me = useMyRunner(0, Boolean(runnerId));
    return Boolean(runnerId && me.data?.runner?.id === runnerId);
}

/** Waiting for your runner, Getting ready, Running, Done: where the run is, and how far it got before a bad ending. */
function PhaseSteps({ phase, furthest, mine }: { phase: TaskPhase; furthest: number; mine: boolean }) {
    const normal = stepOf(phase);
    const bad = normal < 0;
    const reached = bad ? furthest : normal;
    const steps = bad ? LIVE_STEPS.slice(0, Math.max(0, furthest + 1)) : LIVE_STEPS;
    return (
        <ol className="run-phases" aria-label="Where the run is">
            {steps.map((p, i) => {
                const state = !bad && i === reached ? (i === LIVE_STEPS.length - 1 ? "done" : "now") : i < reached || (bad && i <= reached) ? "done" : "ahead";
                return (
                    <li key={p.word} className={`is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                        <span className="pdot" aria-hidden>
                            {state === "done" ? <Check size={12} /> : <Circle size={8} />}
                        </span>
                        {i === 0 && !mine ? "Waiting for the runner" : p.word}
                        {state === "now" && <span className="sr-only"> (now)</span>}
                    </li>
                );
            })}
            {bad && (
                <li className="is-bad" aria-current="step">
                    <span className="pdot" aria-hidden>
                        <CircleX size={12} />
                    </span>
                    {PHASE_STEP_WORD[phase]}
                </li>
            )}
        </ol>
    );
}

const SHOTS_SHOWN = 6;

/**
 * One live screenshot. A signed-in browser loads it as a plain image; with an access key (which a plain image request cannot carry)
 * it is fetched with the key in a header and shown from memory. A picture that is gone (kept with the task for a day) says so.
 */
function ShotImage({ url, caption }: { url: string; caption: string }) {
    const key = getKey();
    const [src, setSrc] = useState<string | null>(key ? null : url);
    const [gone, setGone] = useState(false);
    useEffect(() => {
        if (!key) {
            setSrc(url);
            return;
        }
        let made: string | null = null;
        let cancelled = false;
        void fetch(url, { headers: { "x-api-key": key } })
            .then(async (r) => {
                if (!r.ok) throw new Error(String(r.status));
                const blob = await r.blob();
                if (cancelled) return;
                made = URL.createObjectURL(blob);
                setSrc(made);
            })
            .catch(() => !cancelled && setGone(true));
        return () => {
            cancelled = true;
            if (made) URL.revokeObjectURL(made);
        };
    }, [url, key]);
    if (gone)
        return (
            <span className="run-shot-missing">
                <Camera size={20} aria-hidden />
                This picture is no longer kept. The run’s own screenshots are with its results.
            </span>
        );
    if (!src) return <span className="run-shot-missing" aria-hidden />;
    return (
        <a href={src} target="_blank" rel="noreferrer" aria-label={`Open the screenshot of ${caption} in a new tab`}>
            <img src={src} alt={caption} loading="lazy" onError={() => setGone(true)} />
        </a>
    );
}

function Shots({ live, projectId, jobId }: { live: LiveRun; projectId: string; jobId: string }) {
    const [all, setAll] = useState(false);
    const newestFirst = [...live.shots].reverse();
    const shown = all ? newestFirst : newestFirst.slice(0, SHOTS_SHOWN);
    return (
        <div className="stack-sm">
            <h3 className="t-card">Screenshots ({live.shots.length})</h3>
            <ul className="run-shots" aria-label="Screenshots from the runner, newest first" data-testid="run-live-shots">
                {shown.map((s) => {
                    const caption = shotCaption(s, live.tests);
                    const url = liveShotUrl(projectId, jobId, s);
                    return (
                        <li key={s.id}>
                            <figure>
                                {url ? (
                                    <ShotImage url={url} caption={caption} />
                                ) : (
                                    <span className="run-shot-missing">
                                        <Camera size={20} aria-hidden />
                                        It arrives with the results.
                                    </span>
                                )}
                                <figcaption>
                                    <span className="caption">{caption}</span>
                                    <RelTime iso={s.at} />
                                </figcaption>
                            </figure>
                        </li>
                    );
                })}
            </ul>
            {newestFirst.length > shown.length && <Button onClick={() => setAll(true)}>Show all {newestFirst.length} screenshots</Button>}
        </div>
    );
}

function Lines({ live, folded }: { live: LiveRun; folded: boolean }) {
    const box = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    useLayoutEffect(() => {
        // Follows new lines only while the reader is at the bottom; never pulls the log away from what they read.
        const el = box.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [live.lines.length]);
    const log = (
        <div
                className="log"
                tabIndex={0}
                aria-label="Runner log"
                ref={box}
                data-testid="run-live-log"
                onScroll={(e) => {
                    const el = e.currentTarget;
                    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
            >
                {live.lines.map((l) => (
                    <div key={l.id} className={l.level}>
                        <time>{new Date(l.at).toLocaleTimeString()}</time>
                        {l.text}
                    </div>
                ))}
                {live.lines.length === 0 && <span className="muted">Nothing yet.</span>}
            </div>
    );
    // Once the run is over the log is history: folded, one click away.
    if (folded)
        return (
            <details className="disclosure">
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    Runner log
                </summary>
                {log}
            </details>
        );
    return (
        <div className="stack-sm">
            <h3 className="t-card">Runner log</h3>
            {log}
        </div>
    );
}

/** "3 passed, 1 failed": the results the runner reported so far, every number with what it is. */
export function liveCounts(live: Pick<LiveRun, "passed" | "failed" | "skipped" | "tests">): string {
    const parts = [`${live.passed} passed`, `${live.failed} failed`];
    if (live.skipped) parts.push(`${live.skipped} skipped`);
    const going = live.tests.filter((t) => t.status === "running").length;
    if (going) parts.push(`${going} running`);
    return parts.join(", ");
}

/**
 * The run on its runner, as it happens and afterwards: where it is (four steps, and a sentence only when it ended badly), the test and
 * step it is on, what failed with its text, the screenshots as they arrive and the runner's log (folded once the run is over). The
 * run's facts (which runner, when, how long, results) are said once, in About this run. Everything comes from the run's stored
 * events (useLiveRun, called by the page so its list of tests shares the same picture).
 */
export function LiveRunPanel({ job, active, live, loaded, planned, answer, projectId }: { projectId: string; job: Job; active: boolean; /** From useLiveRun. */ live: LiveRun; loaded: boolean; planned: number; /** The run's answer, which may name the task's phase. */ answer?: object }) {
    const onRunner = job.ranOn?.kind === "agent";
    const mine = useIsMine(job);
    if (!onRunner && !live.detailed && live.phase === null) return null;
    if (!loaded && live.lines.length === 0) return null;

    const runner = job.ranOn?.kind === "agent" ? job.ranOn.name : null;
    const phase = runPhase(job, live, active, answer);
    const badEnding = phase !== null && phaseEnded(phase) && phase !== "completed";
    const position = live.current ? live.tests.indexOf(live.current.test) + 1 : 0;
    // Told to a screen reader: the phase and the test, never every step (that would talk over everything else).
    const spoken = [phase ? phaseSentence(phase, runner, live.phaseReason) : null, live.current ? `Test ${position}${planned ? ` of ${planned}` : ""}: ${live.current.test.title ?? live.current.test.key}.` : null].filter(Boolean).join(" ");

    return (
        <section className="card card-pad stack-sm run-live" aria-labelledby="run-live-h" data-testid="run-live">
            <h2 className="t-section" id="run-live-h">
                {active ? "Progress on the runner" : "On the runner"}
            </h2>
            {phase && <PhaseSteps phase={phase} furthest={live.furthest} mine={mine} />}
            {badEnding && phase && (
                <p className="run-live-phase is-bad" data-testid="run-live-phase">
                    {phaseSentence(phase, runner, live.phaseReason)}
                </p>
            )}
            <p className="sr-only" role="status" aria-live="polite">
                {active ? spoken : ""}
            </p>
            {active && (
                <p className="t-secondary">
                    Now: <span data-testid="run-live-current">{live.current ? currentLine(live.current) : live.detailed ? "between tests" : phase === "running" ? "the runner reports progress as text lines, below" : "nothing yet"}</span>
                </p>
            )}
            {!live.detailed && onRunner && (
                <p className="t-meta" data-testid="run-live-text-only">
                    This runner reports its progress as text lines only, so steps and screenshots appear when the results arrive.
                </p>
            )}
            {live.failures.length > 0 && (
                <div className="stack-sm" data-testid="run-live-failures">
                    <h3 className="t-card">What failed ({live.failures.length})</h3>
                    <ul className="run-failures">
                        {live.failures.map((f) => (
                            <li key={f.testKey}>
                                <p className="t-card">{f.testTitle ? `${f.testTitle} (${f.testKey})` : f.testKey}</p>
                                {f.step && <p className="t-meta">{f.step}</p>}
                                <pre className="run-error">{f.error}</pre>
                                {f.stack && (
                                    <details className="disclosure">
                                        <summary>
                                            <ChevronRight size={16} className="chev" aria-hidden />
                                            Stack trace
                                        </summary>
                                        <pre className="run-error inner">{f.stack}</pre>
                                    </details>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {live.shots.length > 0 && <Shots live={live} projectId={projectId} jobId={job.jobId} />}
            <Lines live={live} folded={!active} />
        </section>
    );
}

/** Whether a run's live view needs reading at all: runs on a runner. */
export const followsRunner = (job: Pick<Job, "ranOn"> | undefined): boolean => job?.ranOn?.kind === "agent";
