import { CircleCheck, CircleX, Undo2 } from "lucide-react";
import { useState } from "react";
import { artifactUrl, type Severity } from "../../api";
import { Button, Callout, Term } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { duration, relativeTime } from "../../lib/format";
import { SEVERITY, VALIDATION, cleanReason } from "../../lib/labels";
import type { RanOn } from "../agents/agents";
import { RunsOnLine } from "../agents/RunsOnLine";
import { TestCleanupLine } from "../cleanup/TestCleanupLine";
import { EnvironmentStrip } from "../environments/EnvironmentStrip";
import { EvidenceSection } from "../evidence/EvidenceSection";
import { FailureSummary } from "../evidence/FailureSummary";
import { HealingSuggestion } from "../healing/HealingSuggestion";
import { IssueSection } from "../integrations/IssueSection";
import { PageSpeedCard } from "../performance/PageSpeedCard";
import { TestQuarantine } from "../quarantine/TestQuarantine";
import { RelatedErrors } from "../sentry/RelatedErrors";
import { RunStrip } from "../runs/RunStrip";
import { prunedNote } from "../storage/storage";
import { CompatibilityMatrix } from "../variants/CompatibilityMatrix";
import { Modal } from "../../components/Modal";
import "./workbench.css";
import type { Detail } from "./test-model";

/** Runs shown as a strip; the History tab has all of them. */
const STRIP = 8;

/** What the last run found, in the decided words (Passing, Failing, Needs a look, Not run yet). */
function Verdict({ t, isMobile }: { t: Detail; isMobile: boolean }) {
    const last = t.executions[0];
    const reason = t.validationReason;
    const sev = t.severity;
    switch (t.validationStatus) {
        case "VALIDATED":
            return (
                <Callout tone="success" title="This test is passing">
                    {last ? `It last ran ${relativeTime(last.startedAt)} and took ${duration(last.durationMs)}.` : "It ran successfully."}
                    {reason?.startsWith("AI judgement note") && <span style={{ display: "block", marginTop: 6 }}>{cleanReason(reason)}</span>}
                </Callout>
            );
        case "NEEDS_REVIEW":
            return (
                <Callout tone="warning" title="This test found something that needs a look">
                    {cleanReason(reason) || VALIDATION.NEEDS_REVIEW.help}
                    {sev && (
                        <span style={{ display: "block", marginTop: 6, fontWeight: 500 }}>
                            {SEVERITY[sev.severity as Severity].label} severity: {sev.basis}.
                        </span>
                    )}
                    <span style={{ display: "block", marginTop: 6 }}>
                        This is a <Term word="finding">finding</Term> about your application, not a broken test.
                    </span>
                </Callout>
            );
        case "FAILED_VALIDATION":
            return (
                <Callout tone="danger" title="This test is failing">
                    {cleanReason(reason) || VALIDATION.FAILED_VALIDATION.help}
                </Callout>
            );
        case "VALIDATING":
            // The run strip above says it (what is running, for how long, with a way to stop it).
            return null;
        default:
            return (
                <Callout tone="neutral" title="Not run yet">
                    {isMobile
                        ? t.framework === "taqwright-ios"
                            ? "This iOS test hasn’t been run yet. It runs on an iOS simulator on a runner that is a Mac with Xcode, against the app set under Settings, Mobile app."
                            : t.kind === "mobile"
                              ? "This mobile test hasn’t been run yet. It runs on an Android emulator against the app chosen under Settings, Mobile app."
                              : "Mobile scripts created from a web test can’t be run here — run them with Taqwright on a device or emulator."
                        : "This test hasn’t been run yet. Choose Run above."}
                </Callout>
            );
    }
}

/**
 * The right column of the workbench, always in view whichever tab is open: the live run, the verdict, what failed (expected and got,
 * the screenshot), the runs of this test as a strip, and a way back when the last edit is the likely cause. Things that belong to
 * a result (repairs, issues, other browsers, the speed check, test data it created) sit here too.
 */
export function ResultsPane({
    test: t,
    reload,
    running,
    onRun,
    ranOn,
    undo,
    onUndo,
    undoing,
    quarantineKey,
}: {
    test: Detail;
    reload: () => Promise<void>;
    running: boolean;
    onRun: () => void;
    ranOn: RanOn | null;
    /** Set only when the newest edit was made after a run that passed and before the run that did not. */
    undo: { version: number; goBackTo: number; at: string } | null;
    onUndo: () => void;
    undoing: boolean;
    /** Changes when the quarantine was changed from the header: the card asks the platform again. */
    quarantineKey: number;
}) {
    const [confirm, setConfirm] = useState(false);
    const last = t.executions[0];
    const isMobile = t.framework === "taqwright" || t.framework === "taqwright-ios";
    const failing = t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION";

    const evidence = last && last.status !== "passed" ? last.artifacts.filter((a) => !a.pruned_at) : [];
    const removedFiles = last && last.status !== "passed" ? last.artifacts.filter((a) => a.pruned_at) : [];
    // For a visual change the generic failure screenshot is the same picture as the "new screenshot".
    const hasVisual = evidence.some((a) => a.kind === "visual-diff");
    const shots = evidence.filter((a) => a.kind === "visual-diff" || a.kind === "visual-actual" || a.kind === "vision-shot" || (a.kind === "screenshot" && !hasVisual));
    const video = evidence.find((a) => a.kind === "video");
    const trace = evidence.find((a) => a.kind === "trace");
    const strip = t.executions.slice(0, STRIP);

    return (
        <div className="stack wb-results" data-testid="results-pane">
            <RunStrip projectId={t.projectId} testId={t.id} />
            <section className="stack-sm" aria-labelledby="wb-last-title" data-tour="last-run">
                <h2 className="t-section" id="wb-last-title">
                    Last run
                </h2>
                <RunsOnLine projectId={t.projectId} ranOn={ranOn} />
                <Verdict t={t} isMobile={isMobile} />
            </section>

            {undo && (
                <Callout
                    tone="info"
                    title="You changed the steps before this run"
                    actions={
                        <Button size="sm" icon={Undo2} onClick={() => setConfirm(true)}>
                            Undo my last edit
                        </Button>
                    }
                >
                    The steps were last saved {relativeTime(undo.at)} (version {undo.version}), after a run that passed. Going back to version {undo.goBackTo} puts the steps as they were then.
                </Callout>
            )}

            {failing && (
                <FailureSummary
                    test={t}
                    last={last ? { steps: last.steps, artifacts: last.artifacts.filter((a) => !a.pruned_at) } : undefined}
                    running={running}
                    onRun={onRun}
                />
            )}

            {strip.length > 0 && (
                <section className="stack-sm" aria-labelledby="wb-runs-title">
                    <h3 className="t-card" id="wb-runs-title">
                        Runs of this test
                    </h3>
                    <ul className="wb-runstrip" aria-label="Recent runs, newest first">
                        {strip.map((e) => (
                            <Tooltip key={e.id} content={`${e.status === "passed" ? "Passed" : "Did not pass"}, ${new Date(e.startedAt).toLocaleString()}. Attempt ${e.attempt}, took ${duration(e.durationMs)}.`}>
                                <li className={`wb-runchip is-${e.status === "passed" ? "passed" : "failed"}`} tabIndex={0}>
                                    {e.status === "passed" ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
                                    <span className="sr-only">{e.status === "passed" ? "Passed" : "Did not pass"}, </span>
                                    {relativeTime(e.startedAt)}
                                </li>
                            </Tooltip>
                        ))}
                    </ul>
                    {t.executions.length > STRIP && <p className="t-meta">The History tab has all {t.executions.length} runs.</p>}
                </section>
            )}

            {(shots.length > 0 || video || trace || removedFiles.length > 0) && (
                <section className="stack-sm" aria-label="Evidence">
                    {(shots.length > 0 || video) && (
                        <div className="evidence">
                            {shots.map((a) => (
                                <figure key={a.id}>
                                    <Tooltip content="Opens the full-size picture in a new tab.">
                                        <a href={artifactUrl(a.id)} target="_blank" rel="noreferrer">
                                            <img src={artifactUrl(a.id)} alt={a.kind === "vision-shot" ? "Screenshot the AI reviewer looked at" : a.kind === "visual-diff" ? "Differences highlighted in red" : a.kind === "visual-actual" ? "New screenshot" : "Screenshot at the moment of failure"} loading="lazy" />
                                        </a>
                                    </Tooltip>
                                    <figcaption>{a.kind === "vision-shot" ? "What the AI reviewer looked at" : a.kind === "visual-diff" ? "Differences (in red)" : a.kind === "visual-actual" ? "New screenshot" : "When it failed"}</figcaption>
                                </figure>
                            ))}
                            {video && (
                                <figure>
                                    <video src={artifactUrl(video.id)} controls preload="metadata" aria-label="Recording of the failed run" />
                                    <figcaption>Recording of the run</figcaption>
                                </figure>
                            )}
                        </div>
                    )}
                    {removedFiles.map((a) => (
                        <p key={a.id} className="t-meta" data-testid="removed-file">
                            {prunedNote(a.kind, a.pruned_at!)}
                        </p>
                    ))}
                    {trace && (
                        <p className="t-meta">
                            <a href={artifactUrl(trace.id)} download>
                                Download detailed trace
                            </a>{" "}
                            (<Term word="trace">what is a trace?</Term> {t.kind === "mobile" ? "A self-contained page: open it in a browser." : <>Open it with <code>npx playwright show-trace</code>.</>})
                        </p>
                    )}
                </section>
            )}

            {t.generationMeta?.visionObservations?.length ? (
                <Callout tone="warning" title="The AI reviewer noticed something while this test was being created">
                    <ul className="bullets" data-testid="vision-observations">
                        {t.generationMeta.visionObservations.map((o, i) => (
                            <li key={i}>{o}</li>
                        ))}
                    </ul>
                    This is a judgement from looking at screenshots, so it may be wrong. Open the page and decide for yourself.
                </Callout>
            ) : null}

            <div id="quarantine-card" className="stack">
                <TestQuarantine key={quarantineKey} testId={t.id} projectId={t.projectId} title={t.title} onChanged={() => void reload()} />
            </div>
            {(t.kind === "web" || t.kind === "mobile") && !t.custom && <HealingSuggestion testId={t.id} projectId={t.projectId} onChanged={() => void reload()} />}
            {failing && <IssueSection testId={t.id} projectId={t.projectId} />}
            {failing && <RelatedErrors testId={t.id} />}
            {t.kind === "web" && last && last.status !== "passed" && <EvidenceSection key={last.id} testId={t.id} />}
            {t.type === "performance" && (t.kind === "web" || t.kind === "api") && <PageSpeedCard testId={t.id} kind={t.kind} />}
            <CompatibilityMatrix test={t} onChanged={() => void reload()} />
            <EnvironmentStrip projectId={t.projectId} results={t.environmentResults} />
            {t.kind === "api" && <TestCleanupLine testId={t.id} />}

            {confirm && undo && (
                <Modal
                    title={`Go back to version ${undo.goBackTo}?`}
                    titleId="wb-undo-title"
                    onClose={() => setConfirm(false)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirm(false)}>
                                Cancel
                            </Button>
                            <Button
                                variant="primary"
                                loading={undoing}
                                onClick={() => {
                                    setConfirm(false);
                                    onUndo();
                                }}
                            >
                                Undo my last edit
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">This saves the steps of version {undo.goBackTo} again as the newest version and runs the test. Nothing is deleted: version {undo.version} stays in the History tab.</p>
                </Modal>
            )}
        </div>
    );
}
