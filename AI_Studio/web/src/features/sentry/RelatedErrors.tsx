import { ExternalLink, Radar } from "lucide-react";
import { useState } from "react";
import { Button, Callout } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { LEVEL_WORD, eventsText, type RelatedAnswer } from "./sentry";
import "./sentry.css";

/**
 * "Related errors in Sentry" on the page of a test that did not pass: issues Sentry saw around the failed run, with the
 * reason each one might be related. Hidden when Sentry is not connected. Never says an error caused the failure.
 */
export function RelatedErrors({ testId }: { testId: string }) {
    const [again, setAgain] = useState(false);
    const data = useFetch<RelatedAnswer>(`/tests/${testId}/sentry${again ? "?refresh=1" : ""}`);
    const a = data.data;

    // Nothing to show for people who do not use Sentry (and nothing while it is still unknown whether they do).
    if (data.loading || data.error || !a || !a.connected) return null;

    return (
        <section className="card card-pad stack-sm" aria-label="Related errors in Sentry">
            <div className="row">
                <Radar size={17} aria-hidden />
                <h2 className="t-section">Related errors in Sentry</h2>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={() => (again ? void data.reload() : setAgain(true))} tip="Asks Sentry again now, instead of showing the answer kept from the last look.">
                    Check again
                </Button>
            </div>

            {a.state === "unavailable" ? (
                <Callout tone="neutral" title="We couldn’t check Sentry">
                    {a.message}
                </Callout>
            ) : a.issues.length === 0 ? (
                <p className="t-secondary">Nothing in Sentry looks related</p>
            ) : (
                <>
                    <ul className="sentry-list" aria-label="Errors that might be related">
                        {a.issues.map((i) => (
                            <li key={i.id} className="sentry-item">
                                <a className="sentry-title" href={i.url} target="_blank" rel="noreferrer">
                                    {i.title}
                                    <ExternalLink size={13} aria-hidden />
                                    <span className="sr-only"> (opens in a new tab)</span>
                                </a>
                                <span className="t-secondary">{i.reason}</span>
                                <span className="t-meta">
                                    {LEVEL_WORD[i.level]}, {eventsText(i.count)}
                                    {i.firstSeen ? `, first seen ${relativeTime(i.firstSeen)}` : ""}
                                    {i.lastSeen ? `, last seen ${relativeTime(i.lastSeen)}` : ""}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="t-meta">{a.note}</p>
                </>
            )}
        </section>
    );
}
