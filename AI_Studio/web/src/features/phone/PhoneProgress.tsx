import type { EventRow, Job } from "../../api";
import { Disclosure } from "../../components/ui";
import { isActive } from "../../lib/labels";
import { usePolled } from "../../lib/hooks";
import { SKIP_CAP, countsLine, phoneCounts, skippedOf } from "./phone";
import { coverageCounts, coverageOf } from "../phonedevice/phonedevice";
import { SignInPause } from "../phonedevice/SignInPause";
import "./phone.css";

/** The job's events, read from the platform's list (the stream is the fast path elsewhere; this list is the record). Polled only while the job runs. */
function useJobEvents(jobId: string | null, running: boolean) {
    // usePolled already rests while the tab is in the background. A finished job is read once more per hour at most: effectively once.
    return usePolled<EventRow[]>(jobId ? `/test-generation/${jobId}/events` : null, running ? 3000 : 3_600_000);
}

/** The calm list of what the AI left alone and why, once each: "Skipped “Delete account” because it looks destructive". */
function SkippedList({ skips }: { skips: string[] }) {
    const shown = skips.slice(0, SKIP_CAP);
    return (
        <>
            <ul className="bullets ph-skips" data-testid="phone-skipped">
                {shown.map((m) => (
                    <li key={m}>{m}</li>
                ))}
            </ul>
            {skips.length > shown.length && <p className="t-meta">and {skips.length - shown.length} more.</p>}
        </>
    );
}

/**
 * Under the steps of a phone exploration: how far it got in numbers, and, if there is any, what it chose not to touch and why.
 * The picture of the phone is the Explorer view's job; this part is always there, with or without it.
 */
export function PhoneProgress({ job }: { job: Job }) {
    const running = isActive(job.status);
    const events = useJobEvents(job.jobId, running);
    const counts = phoneCounts(job, events.data);
    const skips = skippedOf(events.data);
    // Round 24: the explorer says screens, activities, actions and AI calls as it goes, and why it stopped (older platforms: the line above only).
    const coverage = coverageOf(events.data);
    return (
        <section className="ph-progress" aria-label="Phone app exploration" data-testid="phone-progress">
            {running && <SignInPause job={job} events={events.data} onAnswered={() => void events.reload()} />}
            <p className="t-secondary" data-testid="phone-counts">
                {coverage ? coverageCounts(coverage) : countsLine(counts)}
            </p>
            {coverage?.stoppedBecause && (
                <p className="t-secondary" data-testid="phone-stop-reason">
                    Stopped because {coverage.stoppedBecause.charAt(0).toLowerCase() + coverage.stoppedBecause.slice(1).replace(/\.$/, "")}.
                </p>
            )}
            {skips.length > 0 && (
                <div className="stack-sm">
                    <h3 className="t-card">What the AI left alone</h3>
                    <p className="hint">The AI looked at these and did not touch them. Each line says why.</p>
                    <SkippedList skips={skips} />
                </div>
            )}
        </section>
    );
}

/**
 * The same list inside the plan, for a person who wants to know what was not explored. `known` is what the plan itself says; without it the job's events are read.
 * Nothing is shown when nothing was skipped.
 */
export function LeftAlone({ jobId, known }: { jobId: string; known?: string[] }) {
    const events = useJobEvents(known ? null : jobId, false);
    const skips = known ?? skippedOf(events.data);
    if (skips.length === 0) return null;
    return (
        <Disclosure label={`What the AI left alone (${skips.length})`}>
            <SkippedList skips={skips} />
        </Disclosure>
    );
}
