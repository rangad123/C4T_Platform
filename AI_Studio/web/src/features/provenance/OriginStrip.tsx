import { Wrench } from "lucide-react";
import { Disclosure, Term } from "../../components/ui";
import { cleanReason } from "../../lib/labels";
import { originOf, type OriginInput } from "./provenance";
import "./provenance.css";

/**
 * One line under the title saying where the test came from, with "Why this test?" and, for a test the platform corrected on its
 * way to passing, what the run history recorded. Only stored facts are shown: when the answer does not say what the AI looked at,
 * the strip does not say it either.
 */
export function OriginStrip({ test }: { test: OriginInput }) {
    const o = originOf(test);
    return (
        <section className="origin" aria-label="Where this test came from" data-testid="origin-strip">
            <p className="origin-line t-secondary" data-testid="origin-line">
                {o.parts.map((p, i) => (
                    <span key={i}>
                        {i > 0 && <span className="dot-sep" aria-hidden />}
                        {p}
                    </span>
                ))}
            </p>
            {o.autoFix && (
                <p className="origin-line t-secondary" data-testid="origin-autofix">
                    <Wrench size={14} aria-hidden /> <Term word="auto-fix">Auto-fixed</Term> during creation: it passed on attempt {o.autoFix.attempts}.
                </p>
            )}
            {o.autoFix && o.autoFix.failed.length > 0 && (
                <Disclosure label={`What happened before it passed (${o.autoFix.failed.length})`}>
                    <ul className="bullets" data-testid="origin-attempts">
                        {o.autoFix.failed.map((f) => (
                            <li key={f.attempt}>
                                Attempt {f.attempt} did not pass{f.reason ? `: ${cleanReason(f.reason)}` : "."}
                            </li>
                        ))}
                    </ul>
                    <p className="t-meta">The platform keeps the result of each attempt, not the earlier version of the steps, so there is no step-by-step difference to show.</p>
                </Disclosure>
            )}
            {o.why.length > 0 && (
                <Disclosure label="Why this test?">
                    <dl className="kv" data-testid="origin-why">
                        {o.why.map((w) => (
                            <div key={w.label} style={{ display: "contents" }}>
                                <dt>{w.label}</dt>
                                <dd>{w.text}</dd>
                            </div>
                        ))}
                    </dl>
                </Disclosure>
            )}
        </section>
    );
}
