import { Check, LoaderCircle, Minus, X } from "lucide-react";
import { useState } from "react";
import type { Job } from "../api";
import { PHASES, isActive, jobLabel, phaseText, progressPercent } from "../lib/labels";
import { StopRun } from "../features/runs/StopDialog";
import { LiveLine } from "../features/live/LiveStatus";
import { useJobStream } from "../lib/stream";
import { variantsPhaseText } from "../features/variants/variants";
import { plainPhaseText } from "../features/authoring/authoring";
import { CreatedTests, Elapsed } from "../features/onboarding/CreatedTests";
import { ExplorerWatch } from "../features/explorer/ExplorerView";
import { PhoneProgress } from "../features/phone/PhoneProgress";
import { isPhoneJob, isPhoneOnly, phoneCounts, phonePhase } from "../features/phone/phone";
import { useExecutionMode, workingOn } from "../features/runs/runs-here";

/** Live "what is happening" for a running analysis: a checklist, one progress bar, no jargon. */
export function JobProgress({ job: polled, onChanged }: { job: Job; onChanged?: () => void }) {
    // Live updates when the stream is connected; the page's own polling keeps working underneath and takes over when it is not.
    const stream = useJobStream(polled.jobId, isActive(polled.status), () => onChanged?.());
    // A live snapshot may not carry what the polled one was given (what the job explores), so that is kept.
    const job = stream.live && stream.job && stream.job.jobId === polled.jobId ? { ...stream.job, targets: stream.job.targets ?? polled.targets } : polled;
    const pct = progressPercent(job);
    const label = jobLabel(job);
    // Validation-only runs skip every earlier phase; hide them rather than listing five "skipped".
    const quick = job.mode === "plain" || job.mode === "agent" || job.mode === "validate" || job.mode === "variants" || job.mode === "environment";
    // An exploration that stops at a plan has no generation or run phase: listing them would only suggest it is about to run tests.
    const phases = job.planOnly ? PHASES.slice(0, 3) : quick ? PHASES.filter((p) => job.progress[p] !== "skipped") : PHASES;
    const creating = Boolean(job.fromPlan);
    // When the Explorer view is open it carries the Stop control itself (the same one), so it is not offered twice.
    const [explorerOpen, setExplorerOpen] = useState(false);
    // The live list of tests belongs to an exploration that creates tests (not to a plan, a re-run or a test built from a description).
    const makesTests = !quick && !job.planOnly;
    // An exploration of an Android app says so in its title and steps; the picture, counters and skipped list follow the app, not the page.
    const phoneJob = isPhoneJob(job) && (job.mode === undefined || job.mode === "generate");
    const phoneAlone = phoneJob && isPhoneOnly(job);
    const screens = phoneCounts(job, undefined).screens;
    // Runners mode (round 51): an exploration runs on the runner of the person who started it, which the job names once it is handed out.
    // Round 52: so do a described test and an agent run.
    const explores = job.mode === undefined || job.mode === "generate" || job.mode === "plain" || job.mode === "agent";
    const onRunner = useExecutionMode() === "runners" && explores && isActive(job.status) ? workingOn(job.mode, job.ranOn?.kind === "agent" ? job.ranOn.name : undefined) : null;

    return (
        <section className="card card-pad stack">
            <div className="row">
                <div className="stack-sm" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                    <h2 className="t-section">{creating ? "Creating your tests" : phoneAlone ? "Exploring your phone app" : job.mode === "agent" ? "The AI agent is working" : job.mode === "plain" ? "Building your test" : job.mode === "environment" ? `Running your tests on ${job.environment ?? "an environment"}` : job.mode === "variants" ? "Checking other browsers and screen sizes" : job.mode === "validate" ? "Running your tests" : "Exploring your application"}</h2>
                    <p className="t-secondary">{creating ? "We’re creating the tests you chose and running each one. You can leave this page." : job.mode === "agent" ? "Follow it, approve what it asks and stop it from Agent runs. You can leave this page." : job.planOnly ? (phoneAlone ? "The AI is using the app on a phone or emulator and planning tests. Nothing is created yet. You can leave this page." : "We’re looking at the application and planning tests. Nothing is created yet. You can leave this page.") : job.mode === "plain" ? "We’re doing what you described in a real browser, then running the finished test. This usually takes a minute or two." : job.mode === "environment" ? "We’re running your tests against that environment’s address. Your tests’ main results won’t change." : job.mode === "variants" ? "We’re repeating your validated web tests on the browsers and screen sizes you chose." : job.mode === "validate" ? "We’re running the tests again." : "The AI is exploring the application and building your test suite. This usually takes a few minutes. You can leave this page."}</p>
                </div>
                <span className="t-meta" data-testid="elapsed">
                    <Elapsed since={job.startedAt ?? job.createdAt} />
                </span>
            </div>

            <div>
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label.label}>
                    <span style={{ width: `${pct}%` }} />
                </div>
            </div>

            {onRunner && (
                <p className="t-secondary" data-testid="exploring-on">
                    {onRunner}. The browser runs on that computer; the AI works from the platform.
                </p>
            )}

            <LiveLine state={stream.state} latest={stream.latest} />

            <ol className="steps">
                {phases.map((p) => {
                    const state = job.progress[p];
                    const t = (phoneAlone ? phonePhase(p, state, screens) : null) ?? (job.mode === "plain" ? plainPhaseText(p, state) : job.mode === "variants" && p === "validation" ? variantsPhaseText(state, job.counters) : phaseText(p, state, job.counters));
                    return (
                        <li key={p} className={`step ${state}`}>
                            <span className="mark" aria-hidden>
                                {state === "done" ? <Check size={14} /> : state === "running" ? <LoaderCircle size={14} className="spin" /> : state === "failed" ? <X size={14} /> : state === "skipped" ? <Minus size={14} /> : null}
                            </span>
                            <span className="what">
                                <span className="name">{state === "skipped" ? `${t.title.replace(/…$/, "")} (not needed)` : t.title}</span>
                                {t.detail && state !== "skipped" && <span className="t-meta" style={{ display: "block" }}>{t.detail}</span>}
                                <span className="sr-only">{state}</span>
                            </span>
                        </li>
                    );
                })}
            </ol>

            <ExplorerWatch job={job} onPanel={setExplorerOpen} />

            {phoneJob && <PhoneProgress job={job} />}

            {makesTests && <CreatedTests projectId={job.projectId} jobId={job.jobId} />}

            {isActive(job.status) && !explorerOpen && (
                <div>
                    {/* Asks first, says what is kept, and then stops (see features/runs/StopDialog.tsx). */}
                    <StopRun job={{ jobId: job.jobId, projectId: job.projectId, mode: job.mode, planOnly: job.planOnly }} onRequested={() => onChanged?.()} />
                </div>
            )}
        </section>
    );
}
