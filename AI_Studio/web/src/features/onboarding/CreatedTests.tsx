import { useEffect, useState } from "react";
import { duration, plural } from "../../lib/format";
import { RunTestList } from "../runs/RunStrip";
import { useRunAnswer } from "../runs/runs";
import "./onboarding.css";

/** Time since a moment, ticking. Not announced to a screen reader: the status line is the only live part. */
export function Elapsed({ since }: { since: string | null | undefined }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = window.setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);
    if (!since) return null;
    const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
    return <span aria-hidden>{s < 60 ? `${s} s` : duration(s * 1000)}</span>;
}

/**
 * The tests of a creation run as they appear: each with what it did so far (Waiting, Passing, Failing, Needs a look). Reads the same
 * per-test answer the Runs page uses, so the numbers here are the ones the run page will show.
 */
export function CreatedTests({ projectId, jobId }: { projectId: string; jobId: string }) {
    const run = useRunAnswer(projectId, jobId, true);
    const a = run.data;
    const c = a?.counts;
    const made = c?.planned ?? 0;
    const done = c ? c.passed + c.failed + c.findings : 0;
    return (
        <section className="created-tests" aria-label="Tests created so far" data-testid="created-tests">
            <h3 className="t-card">Tests so far</h3>
            <p className="t-secondary" role="status" data-testid="created-count">
                {made === 0 ? "No tests yet. They appear here as they are made." : `${plural(made, "test")} created${done > 0 ? `, ${done} run so far` : ""}.`}
            </p>
            {a && a.tests.length > 0 && <RunTestList tests={a.tests} />}
        </section>
    );
}
