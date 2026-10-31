import { Shuffle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { QuarantineDialog } from "../quarantine/QuarantineDialog";
import type { ProjectQuarantine, Suggestion } from "../quarantine/quarantine";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import type { FlakyTest } from "./schedules";
import { BadgeKey } from "../../components/Tooltip";
import "./schedules.css";

const UNSTABLE = "How often a result differed from the one before it, over the test’s last 20 results with its current script.";

/** Tests whose result keeps flipping between pass and fail although nothing about them changed. */
export function FlakyPanel({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
    const flaky = useFetch<{ tests: FlakyTest[] }>(`/projects/${projectId}/flaky`);
    // Which of them are in quarantine, and which may be (the platform never decides this by itself).
    const quarantine = useFetch<ProjectQuarantine>(`/projects/${projectId}/quarantine`);
    const [picked, setPicked] = useState<Suggestion | null>(null);
    useEffect(() => {
        if (reloadKey > 0) {
            void flaky.reload();
            void quarantine.reload();
        }
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const held = new Map((quarantine.data?.active ?? []).filter((e) => e.gating).map((e) => [e.testId, e]));
    const offer = new Map((quarantine.data?.suggestions ?? []).map((x) => [x.testId, x]));

    return (
        <section className="card" aria-labelledby="flaky-title">
            <div className="card-head wrap">
                <Shuffle size={18} aria-hidden />
                <h2 className="t-section" id="flaky-title">Unreliable tests</h2>
                {flaky.data && flaky.data.tests.length > 0 && <span className="t-meta">Most unstable first</span>}
                {flaky.data && flaky.data.tests.length > 0 && <BadgeKey label="how unstable is measured" entries={[{ word: "Unstable", text: UNSTABLE }]} />}
            </div>
            {flaky.loading ? (
                <ListSkeleton rows={2} />
            ) : flaky.error || !flaky.data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(flaky.error?.message)} onRetry={flaky.reload} />
                </div>
            ) : flaky.data.tests.length === 0 ? (
                <EmptyState icon={Shuffle} title="No unreliable tests found">
                    A test shows up here when it passes and fails on different runs without being changed. That usually means a timing problem or unstable data, not a bug in your application.
                </EmptyState>
            ) : (
                <ul className="list divided no-lead">
                    {flaky.data.tests.map((t) => (
                        <li key={t.id} data-testid={`flaky-${t.testKey}`}>
                            <a className="list-row" href={routes.test(t.id)}>
                                <span className="main">
                                    <span className="title">{t.title}</span>
                                    <span className="meta">
                                        Passed {t.passes} of the last {plural(t.executions, "run")} and changed result {plural(t.flips, "time")}
                                        {t.flakyPasses > 0 && ` · passed on an immediate re-run ${plural(t.flakyPasses, "time")}`} · last run {relativeTime(t.lastRunAt)}
                                    </span>
                                </span>
                                <span className="tail">
                                    <Badge tone={t.flipRate >= 0.5 ? "danger" : "warning"} title={UNSTABLE}>
                                        {Math.round(t.flipRate * 100)}% unstable
                                    </Badge>
                                </span>
                            </a>
                            {(held.has(t.id) || offer.has(t.id)) && (
                                <div className="q-row-actions">
                                    {held.has(t.id) ? (
                                        <>
                                            <Badge tone="info">Quarantined</Badge>
                                            <span className="t-meta">It still runs but does not count. {held.get(t.id)!.reason}</span>
                                        </>
                                    ) : (
                                        <>
                                            <Button size="sm" onClick={() => setPicked(offer.get(t.id)!)}>
                                                Quarantine
                                            </Button>
                                            <span className="t-meta">{offer.get(t.id)!.evidence}.</span>
                                        </>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {picked && (
                <QuarantineDialog
                    projectId={projectId}
                    testId={picked.testId}
                    title={picked.title}
                    mode="quarantine"
                    suggestedReason={picked.suggestedReason}
                    onClose={() => setPicked(null)}
                    onDone={() => {
                        setPicked(null);
                        void quarantine.reload();
                    }}
                />
            )}
        </section>
    );
}
