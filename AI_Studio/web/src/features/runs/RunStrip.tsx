import { CircleCheck, CircleX, Clock, LoaderCircle, Minus, TriangleAlert, X, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, LinkButton } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { help } from "../../lib/help";
import { duration, plural } from "../../lib/format";
import { routes } from "../../lib/router";
import { StopRun } from "./StopDialog";
import { announceRunsChanged, ranSentence, runningLine, STATE_WORD, stoppedLine, useActiveRun, useRunAnswer, whereOf, type RunAnswer, type RunState } from "./runs";
import "./runs.css";

const STATE_ICON = { waiting: Clock, running: LoaderCircle, passed: CircleCheck, failed: CircleX, finding: TriangleAlert, not_run: Minus } as const;
const SHOWN = 50;

/** Seconds since a moment, ticking. Not announced: the live line is the only part a screen reader hears. */
function Elapsed({ since }: { since: string | null }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    if (!since) return null;
    return <span aria-hidden>{duration(Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000) * 1000))}</span>;
}

/** The tests of a run, one row each: state, title (a link), time. At most `SHOWN` until asked for more. */
export function RunTestList({ tests, onlyId }: { tests: RunAnswer["tests"]; onlyId?: string }) {
    const [all, setAll] = useState(false);
    const rows = onlyId ? tests.filter((t) => t.id === onlyId) : tests;
    const shown = all ? rows : rows.slice(0, SHOWN);
    return (
        <>
            <ul className="run-tests" aria-label="Tests in this run">
                {shown.map((t) => {
                    const Icon = STATE_ICON[t.state];
                    return (
                        <li key={t.id} className={`run-test is-${t.state}`} data-state={t.state}>
                            <span className="mark" aria-hidden>
                                <Icon size={16} className={t.state === "running" ? "spin" : undefined} />
                            </span>
                            <span className="what">
                                <a href={routes.test(t.id)}>{t.title}</a>
                                <span className="t-meta">{t.testId}</span>
                                {t.reason && t.state !== "passed" && <span className="why t-meta">{t.reason}</span>}
                            </span>
                            {t.flaky ? (
                                <Tooltip content={help("metric", "flakyPass")}>
                                    <span className="state" tabIndex={0}>
                                        {STATE_WORD[t.state as RunState]}, unreliable
                                    </span>
                                </Tooltip>
                            ) : (
                                <span className="state">{STATE_WORD[t.state as RunState]}</span>
                            )}
                            <span className="t-meta time">{t.durationMs !== undefined ? duration(t.durationMs) : ""}</span>
                        </li>
                    );
                })}
            </ul>
            {rows.length > shown.length && (
                <Button onClick={() => setAll(true)}>
                    Show all {rows.length} tests
                </Button>
            )}
        </>
    );
}

/**
 * A run in progress, pinned to the top of the project's pages and of a test's page: what is running, how far it is, where, and a way to
 * stop it, with a live list of the tests. When the run ends it says how it ended until it is dismissed.
 * `testId` (the test page): shows only a run that includes that test, and only that test.
 * `exceptJobId` (the run's own page): that run is not repeated in a strip, a different run still is.
 */
export function RunStrip({ projectId, testId, exceptJobId }: { projectId: string; testId?: string; exceptJobId?: string }) {
    const active = useActiveRun(projectId);
    // The run last seen going stays on screen once it ends, so its outcome is not missed.
    const [followed, setFollowed] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState<string | null>(null);
    useEffect(() => {
        if (active.job) setFollowed(active.job.jobId);
    }, [active.job]);
    const jobId = active.job?.jobId ?? followed;
    const answer = useRunAnswer(projectId, jobId, Boolean(active.job));
    const [open, setOpen] = useState(false);

    const a = answer.data;
    // The run is over when the run itself says so.
    const finished = a ? !a.active : false;
    if (!jobId || !a || dismissed === jobId || jobId === exceptJobId) return null;
    if (testId && !a.tests.some((t) => t.id === testId)) return null;

    const c = a.counts;
    const job = a.job;
    const scoped = Boolean(testId);
    const done = c.passed + c.failed + c.findings;
    const where = whereOf(job);
    const cancelled = job.cancelled;

    if (finished) {
        const failedRun = job.status === "FAILED" && !cancelled;
        return (
            <section className="run-strip is-finished" aria-label="Run finished" data-testid="run-strip" data-tour="run-strip">
                <div className="head">
                    <span className="mark" aria-hidden>{cancelled ? <Minus size={18} /> : failedRun || c.failed ? <CircleX size={18} /> : <CircleCheck size={18} />}</span>
                    <div className="grow">
                        <p className="t-card" role="status">
                            {cancelled ? stoppedLine({ ran: cancelled.ran, planned: cancelled.planned }) : failedRun ? "The run did not finish" : scoped ? "The run finished" : `Run finished, ${plural(c.planned, "test")}`}
                        </p>
                        <p className="t-secondary">{cancelled ? cancelled.note : failedRun ? (job.error ?? "") : ranSentence(c)}</p>
                    </div>
                    <div className="acts">
                        <LinkButton href={routes.run(projectId, jobId)}>See the run</LinkButton>
                        <Button variant="ghost" iconOnly icon={X} aria-label="Dismiss" tip="Hides this summary. The run stays in Runs." onClick={() => setDismissed(jobId)} />
                    </div>
                </div>
            </section>
        );
    }

    return (
        <section className="run-strip" aria-label="Run in progress" data-testid="run-strip" data-tour="run-strip">
            <div className="head">
                <span className="mark spin-wrap" aria-hidden>
                    <LoaderCircle size={18} className="spin" />
                </span>
                <div className="grow">
                    <p className="t-card line">
                        <span>{runningLine(job.mode, c, scoped)}</span>
                        {!scoped && c.planned > 0 && (
                            <>
                                <span className="dot-sep" aria-hidden />
                                <span>{done} done</span>
                                {c.failed + c.findings > 0 && (
                                    <>
                                        <span className="dot-sep" aria-hidden />
                                        <span>{c.failed ? `${c.failed} failing` : `${c.findings} ${c.findings === 1 ? "needs" : "need"} a look`}</span>
                                    </>
                                )}
                            </>
                        )}
                        <span className="dot-sep" aria-hidden />
                        <span>{where === "this server" ? "On this server" : where}</span>
                        {job.startedAt && (
                            <>
                                <span className="dot-sep" aria-hidden />
                                <Elapsed since={job.startedAt} />
                            </>
                        )}
                    </p>
                    {/* The one line a screen reader is told about: it changes only when the numbers do. */}
                    <p className="sr-only" role="status" aria-live="polite">{`${runningLine(job.mode, c, scoped)}, ${done} done${c.failed ? `, ${c.failed} failing` : ""}`}</p>
                    {answer.stream.latest && <p className="t-meta latest truncate">{answer.stream.latest}</p>}
                </div>
                <div className="acts">
                    {!scoped && (
                        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                            <ChevronDown size={16} className={open ? "chev is-open" : "chev"} aria-hidden />
                            {open ? "Hide tests" : "Show tests"}
                        </Button>
                    )}
                    <StopRun job={{ jobId, projectId, mode: job.mode }} onRequested={announceRunsChanged} />
                </div>
            </div>
            {(open || scoped) && <RunTestList tests={a.tests} onlyId={testId} />}
        </section>
    );
}
