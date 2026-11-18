import { Undo2 } from "lucide-react";
import { useState } from "react";
import { artifactUrl, type Severity } from "../../api";
import { Button, Callout, Term } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { duration, relativeTime } from "../../lib/format";
import { SEVERITY, VALIDATION, cleanReason } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import type { RanOn } from "../../api";
import { RunsOnLine } from "../agents/RunsOnLine";
import { TestCleanupLine } from "../cleanup/TestCleanupLine";
import { EnvironmentStrip } from "../environments/EnvironmentStrip";
import { EvidenceSection } from "../evidence/EvidenceSection";
import { FailureSummary } from "../evidence/FailureSummary";
import { HealingSuggestion } from "../healing/HealingSuggestion";
import { IssueSection } from "../integrations/IssueSection";
import { PageSpeedCard } from "../performance/PageSpeedCard";
import { TestQuarantine } from "../quarantine/TestQuarantine";
import type { TestQuarantine as QuarantineView } from "../quarantine/quarantine";
import { RelatedErrors } from "../sentry/RelatedErrors";
import { prunedNote } from "../storage/storage";
import { CompatibilityMatrix } from "../variants/CompatibilityMatrix";
import { Modal } from "../../components/Modal";
import "./workbench.css";
import type { Detail, Tab } from "./test-model";

/** What the last run found, in the decided words (Passing, Failing, Needs a look, Not run yet). */
function Verdict({ t, isMobile }: { t: Detail; isMobile: boolean }) {
    const last = t.executions[0];
    const reason = t.validationReason;
    const sev = t.severity;
    switch (t.validationStatus) {
        case "VALIDATED":
            return (
                <Callout tone="success" title="This test is passing">
                    {/* When it ran is in the header ("Last run … ago"); the verdict says only how long it took. */}
                    {last ? `Its last run took ${duration(last.durationMs)}.` : "It ran successfully."}
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
                    {/* Only a scored finding is about the application; a captcha that stopped the run has no severity and is neither. */}
                    <span style={{ display: "block", marginTop: 6 }}>
                        {sev ? (
                            <>
                                This is a <Term word="finding">finding</Term> about your application, not a broken test.
                            </>
                        ) : (
                            "The page stopped the run before the test could check anything, so this is neither a defect in your application nor a broken test."
                        )}
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
 * While the test is in quarantine (a status of the whole test): the callout with Release, above the tabs. The offer to quarantine an
 * unreliable test is the header menu's Quarantine, and past quarantines are entries on the History tab, so neither shows here.
 */
export function QuarantineStatus({ test: t, onChanged }: { test: Detail; onChanged: () => void }) {
    const q = useFetch<QuarantineView>(`/tests/${t.id}/quarantine`);
    if (!q.data?.entry) return null;
    return (
        <div id="quarantine-card" className="stack">
            <TestQuarantine
                testId={t.id}
                projectId={t.projectId}
                title={t.title}
                onChanged={() => {
                    // Released: the callout goes; the History tab keeps the entry, and the header menu offers Quarantine again.
                    void q.reload();
                    onChanged();
                }}
            />
        </div>
    );
}

/**
 * The right column of the DSL, Code and Steps tabs: how the last run went and what failed, with only the actions that belong to the
 * tab. Steps adds what is about the steps (the way back when the last edit is the likely cause, the repair, the strength of the
 * checks); the Code tab puts its editor's problems and rules below it. Run evidence in full is on the History tab.
 */
export function ResultsPane({
    tab,
    test: t,
    reload,
    ranOn,
    undo,
    onUndo,
    undoing,
}: {
    tab: Exclude<Tab, "history">;
    test: Detail;
    reload: () => Promise<void>;
    ranOn: RanOn | null;
    /** Set only when the newest edit was made after a run that passed and before the run that did not. */
    undo: { version: number; goBackTo: number; at: string } | null;
    onUndo: () => void;
    undoing: boolean;
}) {
    const [confirm, setConfirm] = useState(false);
    const last = t.executions[0];
    const isMobile = t.framework === "taqwright" || t.framework === "taqwright-ios";
    const failing = t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION";
    const steps = tab === "steps";
    // The steps are edited on Steps and as text on DSL: a way back to the steps before the failing run belongs to both.
    const offerUndo = undo && tab !== "code";

    return (
        <div className="stack wb-results" data-testid="results-pane">
            <section className="stack-sm" aria-labelledby="wb-last-title" data-tour="last-run">
                <h2 className="t-section" id="wb-last-title">
                    Last run
                </h2>
                <RunsOnLine projectId={t.projectId} ranOn={ranOn} />
                <Verdict t={t} isMobile={isMobile} />
            </section>

            {offerUndo && (
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

            {failing && <FailureSummary tab={tab} test={t} last={last ? { steps: last.steps, artifacts: last.artifacts.filter((a) => !a.pruned_at) } : undefined} />}

            {steps && (t.kind === "web" || t.kind === "mobile") && !t.custom && <HealingSuggestion testId={t.id} projectId={t.projectId} onChanged={() => void reload()} />}
            {steps && t.generationMeta?.strength ? (
                <p className="t-secondary" data-testid="test-strength">
                    Strength: catches {t.generationMeta.strength.caught} of {t.generationMeta.strength.total} deliberate faults
                    {t.generationMeta.strength.strengthened ? " (after a stronger check was added)" : ""}.
                    {t.generationMeta.strength.missed.length ? ` It still passes when ${t.generationMeta.strength.missed.join(", or when ")}.` : ""}
                </p>
            ) : null}
            {steps && t.generationMeta?.visionObservations?.length ? (
                <Callout tone="warning" title="The AI reviewer noticed something while this test was being created">
                    <ul className="bullets" data-testid="vision-observations">
                        {t.generationMeta.visionObservations.map((o, i) => (
                            <li key={i}>{o}</li>
                        ))}
                    </ul>
                    This is a judgement from looking at screenshots, so it may be wrong. Open the page and decide for yourself.
                </Callout>
            ) : null}

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

/**
 * The top of the History tab: everything the latest run left behind (screenshots, the recording, the trace, what the page did,
 * related errors, the issue tracker, page speed, test data it created), then the other browsers and environments. The edit tabs
 * show only what failed, with links to these files.
 */
export function LatestRun({ test: t, reload }: { test: Detail; reload: () => Promise<void> }) {
    const last = t.executions[0];
    const failing = t.validationStatus === "NEEDS_REVIEW" || t.validationStatus === "FAILED_VALIDATION";
    const evidence = last && last.status !== "passed" ? last.artifacts.filter((a) => !a.pruned_at) : [];
    const removedFiles = last && last.status !== "passed" ? last.artifacts.filter((a) => a.pruned_at) : [];
    // For a visual change the generic failure screenshot is the same picture as the "new screenshot".
    const hasVisual = evidence.some((a) => a.kind === "visual-diff");
    const shots = evidence.filter((a) => a.kind === "visual-diff" || a.kind === "visual-actual" || a.kind === "vision-shot" || (a.kind === "screenshot" && !hasVisual));
    const video = evidence.find((a) => a.kind === "video");
    const trace = evidence.find((a) => a.kind === "trace");

    return (
        <section className="stack" aria-labelledby="wb-latest-title" data-testid="latest-run">
            <h2 className="t-section" id="wb-latest-title">
                Latest run
            </h2>
            {!last && <p className="t-secondary">This test has not run yet. Choose Run above.</p>}
            {(shots.length > 0 || video || trace || removedFiles.length > 0) && (
                <div className="stack-sm" role="group" aria-label="Evidence">
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
                            {prunedNote(a.kind, a.pruned_at!, a.pruned_reason)}
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
                </div>
            )}
            {t.kind === "web" && last && last.status !== "passed" && <EvidenceSection key={last.id} testId={t.id} />}
            {failing && <RelatedErrors testId={t.id} />}
            {failing && <IssueSection testId={t.id} projectId={t.projectId} />}
            {t.type === "performance" && (t.kind === "web" || t.kind === "api") && <PageSpeedCard testId={t.id} kind={t.kind} />}
            {t.kind === "api" && <TestCleanupLine testId={t.id} />}
            <CompatibilityMatrix test={t} onChanged={() => void reload()} />
            <EnvironmentStrip projectId={t.projectId} results={t.environmentResults} />
        </section>
    );
}
