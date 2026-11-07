import { Camera, Check, ChevronRight, Circle, CircleX } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, getKey, type EventRow, type Job } from "../../api";
import { Badge, Button } from "../../components/ui";
import { duration } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { mergeEvents, type JobStream } from "../../lib/stream";
import { Elapsed, RelTime } from "./RunTime";
import { currentLine, foldLiveRun, isRunnerEvent, liveShotUrl, PHASE_STEP_WORD, PHASE_STEPS, phaseEnded, phaseSentence, runnerIdOf, runPhase, shotCaption, type LiveRun, type TaskPhase } from "./live-run";
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

/** The part of GET /api/projects/:id/runner-choices this view reads: which runners are the caller's own and which are the team's. */
interface RunnerChoices {
    runners: Array<{ id: string; name: string; kind: "personal" | "team"; mine: boolean }>;
}

/** "Your computer" or "Team runner", when the platform says which; nothing when it does not. */
function useRunnerKind(projectId: string, runnerId: string | undefined): "mine" | "team" | "personal" | null {
    const choices = useFetch<RunnerChoices>(runnerId ? `/projects/${projectId}/runner-choices` : null);
    const r = runnerId ? choices.data?.runners?.find((x) => x.id === runnerId) : undefined;
    if (!r) return null;
    return r.mine ? "mine" : r.kind === "team" ? "team" : "personal";
}
const KIND_WORD = { mine: "Your computer", team: "Team runner", personal: "Someone’s own computer" } as const;

/** Queued, Offered, Accepted, Getting ready, Running, Sending results, Done: where the runner's task is, and how far it got. */
function PhaseSteps({ phase, furthest }: { phase: TaskPhase; furthest: number }) {
    const normal = PHASE_STEPS.indexOf(phase);
    const bad = normal < 0;
    const reached = bad ? furthest : normal;
    const steps = bad ? PHASE_STEPS.slice(0, Math.max(0, furthest + 1)) : PHASE_STEPS;
    return (
        <ol className="run-phases" aria-label="Where the run is">
            {steps.map((p, i) => {
                const state = !bad && i === reached ? (p === "completed" ? "done" : "now") : i < reached || (bad && i <= reached) ? "done" : "ahead";
                return (
                    <li key={p} className={`is-${state}`} aria-current={state === "now" ? "step" : undefined}>
                        <span className="pdot" aria-hidden>
                            {state === "done" ? <Check size={12} /> : <Circle size={8} />}
                        </span>
                        {PHASE_STEP_WORD[p]}
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

function Lines({ live }: { live: LiveRun }) {
    const box = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    useLayoutEffect(() => {
        // Follows new lines only while the reader is at the bottom; never pulls the log away from what they read.
        const el = box.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [live.lines.length]);
    return (
        <div className="stack-sm">
            <h3 className="t-card">Runner log</h3>
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
 * The run on its runner, as it happens and afterwards: the task's phase, the runner (yours or the team's, with a link), when it
 * started and for how long, the test and step it is on, steps done, passed and failed so far, what failed with its text, the
 * screenshots as they arrive and the runner's log. Everything comes from the run's stored events (useLiveRun, called by the page so
 * its list of tests shares the same picture).
 */
export function LiveRunPanel({ projectId, job, active, live, loaded, planned, answer }: { projectId: string; job: Job; active: boolean; /** From useLiveRun. */ live: LiveRun; loaded: boolean; planned: number; /** The run's answer, which may name the task's phase. */ answer?: object }) {
    const onRunner = job.ranOn?.kind === "agent";
    // The runner (an agent_tokens id: the id of its page and of the runner choices), when the platform names it.
    const runnerId = runnerIdOf(job);
    const kind = useRunnerKind(projectId, runnerId);
    if (!onRunner && !live.detailed && live.phase === null) return null;
    if (!loaded && live.lines.length === 0) return null;

    const runner = job.ranOn?.kind === "agent" ? job.ranOn.name : null;
    const phase = runPhase(job, live, active, answer);
    const started = live.startedAt ?? job.startedAt;
    const tookMs = !active && started && job.finishedAt ? Math.max(0, new Date(job.finishedAt).getTime() - new Date(started).getTime()) : null;
    const position = live.current ? live.tests.indexOf(live.current.test) + 1 : 0;
    // Told to a screen reader: the phase and the test, never every step (that would talk over everything else).
    const spoken = [phase ? phaseSentence(phase, runner, live.phaseReason) : null, live.current ? `Test ${position}${planned ? ` of ${planned}` : ""}: ${live.current.test.title ?? live.current.test.key}.` : null].filter(Boolean).join(" ");

    return (
        <section className="card card-pad stack-sm run-live" aria-labelledby="run-live-h" data-testid="run-live">
            <div className="row run-live-head">
                <h2 className="t-section" id="run-live-h">
                    {active ? "Progress on the runner" : "On the runner"}
                </h2>
                {kind && <Badge tone={kind === "mine" ? "brand" : "neutral"}>{KIND_WORD[kind]}</Badge>}
            </div>
            {phase && <PhaseSteps phase={phase} furthest={live.furthest} />}
            {phase && (
                <p className={phaseEnded(phase) && phase !== "completed" ? "run-live-phase is-bad" : "run-live-phase"} data-testid="run-live-phase">
                    {phaseSentence(phase, runner, live.phaseReason)}
                </p>
            )}
            <p className="sr-only" role="status" aria-live="polite">
                {active ? spoken : ""}
            </p>
            <dl className="run-facts">
                {runner && (
                    <>
                        <dt>Runner</dt>
                        <dd>
                            {runnerId ? (
                                <a href={routes.runner(runnerId)} data-testid="run-live-runner">
                                    {runner}
                                    <ChevronRight size={14} aria-hidden />
                                </a>
                            ) : (
                                runner
                            )}
                        </dd>
                    </>
                )}
                {started && (
                    <>
                        <dt>Started</dt>
                        <dd>
                            <RelTime iso={started} />
                        </dd>
                    </>
                )}
                <dt>{active ? "Running for" : "Took"}</dt>
                <dd data-testid="run-live-duration">{active ? started ? <Elapsed since={started} hidden={false} /> : "Not started yet" : tookMs !== null ? duration(tookMs) : "Not known"}</dd>
                {active && (
                    <>
                        <dt>Now</dt>
                        <dd data-testid="run-live-current">{live.current ? currentLine(live.current) : live.detailed ? "Between tests" : phase === "running" ? "The runner reports progress as text lines, below" : "Nothing yet"}</dd>
                    </>
                )}
                {live.detailed && (
                    <>
                        <dt>Steps done</dt>
                        <dd data-testid="run-live-steps">{live.stepsDone}</dd>
                        <dt>{active ? "Results so far" : "Results"}</dt>
                        <dd data-testid="run-live-counts">{liveCounts(live)}</dd>
                    </>
                )}
            </dl>
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
            <Lines live={live} />
        </section>
    );
}

/** Whether a run's live view needs reading at all: runs on a runner. */
export const followsRunner = (job: Pick<Job, "ranOn"> | undefined): boolean => job?.ranOn?.kind === "agent";
