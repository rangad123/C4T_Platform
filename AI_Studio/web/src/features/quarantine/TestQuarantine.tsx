import { ShieldOff } from "lucide-react";
import { useState } from "react";
import { Button, Callout, Disclosure } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { QuarantineDialog } from "./QuarantineDialog";
import { HISTORY_WORDS, type TestQuarantine as View } from "./quarantine";
import "./quarantine.css";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * What quarantine means for one test, on its page: the callout while it is in quarantine (reason, since, expiry, release),
 * the line when it ended, the offer when the test is unreliable and may be quarantined, and the history.
 * It renders nothing for an ordinary test, so pages of tests that never had a quarantine look exactly as before.
 */
export function TestQuarantine({ testId, projectId, title, onChanged }: { testId: string; projectId: string; title: string; onChanged?: () => void }) {
    const q = useFetch<View>(`/tests/${testId}/quarantine`);
    const [dialog, setDialog] = useState<"quarantine" | "release" | null>(null);
    const v = q.data;
    if (!v) return null; // loading or unavailable: the page works without it

    const done = () => {
        setDialog(null);
        void q.reload();
        onChanged?.();
    };
    const entry = v.entry;
    return (
        <>
            {entry && entry.gating && (
                <div data-testid="quarantine-callout">
                    <Callout
                        tone="info"
                        title="In quarantine: this test runs but does not count"
                        actions={
                            <Button size="sm" onClick={() => setDialog("release")}>
                                Release from quarantine
                            </Button>
                        }
                    >
                        {entry.reason}
                        <span className="q-facts">
                            Put there by {entry.by} {relativeTime(entry.since)}. Ends {day(entry.expiresAt)} ({plural(entry.daysLeft, "day")} left).
                        </span>
                        {entry.release.text && (
                            <span className="q-facts" data-testid="quarantine-release-hint">
                                {entry.release.text}
                            </span>
                        )}
                    </Callout>
                </div>
            )}
            {entry && !entry.gating && (
                <Callout
                    tone="warning"
                    title="This test counts again"
                    actions={
                        <Button size="sm" onClick={() => setDialog("release")}>
                            Release from quarantine
                        </Button>
                    }
                >
                    {entry.note ?? "It is no longer eligible for quarantine."}
                </Callout>
            )}
            {!entry && v.lastEnded && (
                <Callout tone="neutral" title="Quarantine ended; this test counts again">
                    {v.lastEnded.status === "expired" ? "The time was up" : `${v.lastEnded.endedBy ?? "Someone"} released it`} {v.lastEnded.endedAt ? relativeTime(v.lastEnded.endedAt) : ""}. Reason it was in quarantine: {v.lastEnded.reason}
                </Callout>
            )}
            {!entry && v.eligible && (
                <Callout
                    tone="neutral"
                    title="This test is unreliable"
                    actions={
                        <Button size="sm" icon={ShieldOff} onClick={() => setDialog("quarantine")}>
                            Quarantine
                        </Button>
                    }
                >
                    {v.evidence ?? "It passes and fails on identical runs."} In quarantine it keeps running, but it stops counting against pass rates, alerts, readiness and sign-off.
                </Callout>
            )}
            {v.history.length > 0 && (
                <Disclosure label={`Quarantine history (${v.history.length})`}>
                    <ul className="q-history" data-testid="quarantine-history">
                        {v.history.map((h) => (
                            <li key={h.id}>
                                <strong>{h.by}</strong> {HISTORY_WORDS[h.kind]} {relativeTime(h.at)}
                                {h.reason ? `: ${h.reason}` : "."}
                            </li>
                        ))}
                    </ul>
                </Disclosure>
            )}
            {dialog && <QuarantineDialog projectId={projectId} testId={testId} title={title} mode={dialog} entryId={entry?.id} suggestedReason={v.suggestedReason} onClose={() => setDialog(null)} onDone={done} />}
        </>
    );
}
