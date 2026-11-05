import { Code2, Image, ListPlus, RefreshCw, Video, Wrench } from "lucide-react";
import { artifactUrl, projectKind, type ProjectDetail } from "../../api";
import { Button, LinkButton, Term } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { cleanReason, stepSentence } from "../../lib/labels";
import { routes } from "../../lib/router";
import { EditScriptButton } from "../code/TakeOver";
import type { CustomInfo } from "../code/code";
import type { TestQuarantine } from "../quarantine/quarantine";
import { agentInputsHref } from "../requirements/AgentInputs";
import "./evidence.css";

/** The fields of the test answer this block reads (the platform adds `failure` and each failed step's `expected` / `actual`). */
export interface FailureInput {
    id: string;
    projectId: string;
    kind: string;
    validationStatus: string;
    validationReason: string | null;
    custom?: CustomInfo;
    failure?: { kind: "mismatch" | "missing-api-token"; step?: { index: number; title: string }; expected?: string; actual?: string };
    spec: { steps: any[] };
    /** Only for a test that uses reusable steps: the steps that really run, each with the step of the test it belongs to. */
    runSteps?: Array<{ index: number; from: number; block?: string; step: any }>;
}
export interface FailureRun {
    steps: Array<{ index: number; title: string; status: "passed" | "failed"; error: string | null; expected?: string; actual?: string }>;
    /** Files of that run that still exist (the retention policy may have removed the others). */
    artifacts: Array<{ id: string; kind: string }>;
}

const firstLine = (s: string | null | undefined, n = 200) => (s ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, n) ?? "";

/**
 * What a failing test comes down to: which step, what it expected and what it got, the files that show it, the cause when the platform
 * names one, and the things the tester can do next. Every action listed exists on this page. Where the platform gave no expected and
 * actual values, the stored message is shown as it is (cleaned), never a guess.
 */
export function FailureSummary({ test, last, onRun, running }: { test: FailureInput; last?: FailureRun; onRun: () => void; running: boolean }) {
    const finding = test.validationStatus === "NEEDS_REVIEW";
    const healing = useFetch<{ proposals: Array<{ status: string; canApply: boolean }> }>((test.kind === "web" || test.kind === "mobile") && !test.custom ? `/tests/${test.id}/healing` : null);
    const quarantine = useFetch<TestQuarantine>(`/tests/${test.id}/quarantine`);
    const canRepair = !!healing.data?.proposals.some((p) => p.status === "proposed" && p.canApply);
    const canQuarantine = !!quarantine.data && !quarantine.data.entry && quarantine.data.eligible;

    const missingToken = test.failure?.kind === "missing-api-token";
    // Where the token goes depends on the project: agent and mixed projects keep it with what the agents need (Requirements); a code
    // project's run sends the token of the environment it runs against (Settings, Environments). Asked only when it matters.
    const project = useFetch<ProjectDetail>(missingToken ? `/projects/${test.projectId}` : null);
    const tokenPlace = project.data ? (projectKind(project.data) === "code" ? "environment" : "requirements") : null;
    const failed = last?.steps.find((s) => s.status === "failed");
    // The visible step (a use of reusable steps is one step of the test; the one that failed is inside it).
    const run = failed ? test.runSteps?.find((r) => r.index === failed.index) : undefined;
    const shownIndex = run ? run.from : failed?.index ?? test.failure?.step?.index;
    const stepObj = run ? test.spec.steps[run.from] : shownIndex !== undefined ? test.spec.steps[shownIndex] : undefined;
    const sentence = stepObj ? stepSentence(stepObj) : failed?.title ?? test.failure?.step?.title;
    const inside = run && run.block ? stepSentence(run.step) : "";
    const expected = failed?.expected ?? test.failure?.expected;
    const actual = failed?.actual ?? test.failure?.actual;
    const said = cleanReason(firstLine(failed?.error));
    // The status callout above already shows the stored reason; the step's own line is added only when it says something more.
    const reasonText = cleanReason(test.validationReason);
    const extraSaid = said && !reasonText.includes(said) ? said : "";

    const files = (last?.artifacts ?? []).filter((a) => ["screenshot", "visual-diff", "visual-actual", "vision-shot", "video", "trace"].includes(a.kind));
    const shot = files.find((a) => a.kind === "screenshot" || a.kind === "visual-diff") ?? files.find((a) => a.kind === "visual-actual" || a.kind === "vision-shot");
    const video = files.find((a) => a.kind === "video");
    const trace = files.find((a) => a.kind === "trace");

    const jump = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        el?.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
    };

    return (
        <section className="card card-pad stack-sm fail" aria-labelledby="fail-title" data-testid="failure-summary">
            <h2 className="t-section" id="fail-title">
                {finding ? "What was found" : "What failed"}
            </h2>

            {missingToken ? (
                <p data-testid="failure-cause">
                    <strong>No API token is saved for this project.</strong> The test sends the project’s API token and the application answered that it was not signed in, so the test is probably fine.{" "}
                    {tokenPlace === "environment"
                        ? "A run sends the API token of the environment it runs against: add the token to an environment under Settings, Environments, then run the test against that environment."
                        : tokenPlace === "requirements"
                          ? "Add the token under “API access” in What the agents need, on the Requirements tab, then run the test again."
                          : "Add the token where this project keeps it, then run the test again."}
                </p>
            ) : (
                <>
                    {sentence && (
                        <p data-testid="failure-step">
                            <strong>Step {(shownIndex ?? 0) + 1}</strong>
                            {inside ? ` (${inside}, inside the reusable steps “${run?.block}”)` : ""}: {sentence}
                            {finding ? "" : ", did not pass."}
                        </p>
                    )}
                    {expected !== undefined || actual !== undefined ? (
                        <dl className="fail-facts" data-testid="failure-facts">
                            {expected !== undefined && (
                                <div>
                                    <dt>Expected</dt>
                                    <dd>{expected}</dd>
                                </div>
                            )}
                            {actual !== undefined && (
                                <div>
                                    <dt>Got</dt>
                                    <dd>{actual}</dd>
                                </div>
                            )}
                        </dl>
                    ) : (
                        extraSaid && (
                            <p className="t-secondary" data-testid="failure-said">
                                The run said: {extraSaid}
                            </p>
                        )
                    )}
                </>
            )}

            {(shot || video || trace) && (
                <p className="fail-files" data-testid="failure-files">
                    <span className="t-meta">See what happened:</span>
                    {shot && (
                        <Tooltip content="Opens the screenshot in a new tab.">
                            <a className="chip" href={artifactUrl(shot.id)} target="_blank" rel="noreferrer">
                                <Image size={14} aria-hidden /> Screenshot<span className="sr-only"> (opens in a new tab)</span>
                            </a>
                        </Tooltip>
                    )}
                    {video && (
                        <Tooltip content="Opens a video of the test as it ran, in a new tab.">
                            <a className="chip" href={artifactUrl(video.id)} target="_blank" rel="noreferrer">
                                <Video size={14} aria-hidden /> Recording<span className="sr-only"> (opens in a new tab)</span>
                            </a>
                        </Tooltip>
                    )}
                    {trace && (
                        <span>
                            <a className="chip" href={artifactUrl(trace.id)} download>
                                Detailed <Term word="trace">trace</Term> <span className="sr-only">(download)</span>
                            </a>
                        </span>
                    )}
                </p>
            )}

            <div>
                <h3 className="t-card" style={{ margin: "4px 0 8px" }}>What you can do</h3>
                <div className="fail-acts">
                    {missingToken && tokenPlace && (
                        <LinkButton size="sm" variant="primary" href={tokenPlace === "environment" ? routes.projectSettings(test.projectId, "environments") : agentInputsHref(test.projectId)}>
                            Add an API token
                        </LinkButton>
                    )}
                    {canRepair && (
                        <Button size="sm" variant="primary" icon={Wrench} onClick={() => jump("#heal-card")}>
                            Apply the repair
                        </Button>
                    )}
                    {(test.kind === "web" || test.kind === "api") && !test.custom && (
                        <LinkButton size="sm" icon={ListPlus} href={routes.builder(test.id)}>
                            Edit steps
                        </LinkButton>
                    )}
                    {(test.kind === "web" || test.kind === "api" || test.kind === "desktop" || test.kind === "mobile") && (test.custom ? <LinkButton size="sm" icon={Code2} href={routes.code(test.id)}>Edit the code</LinkButton> : <EditScriptButton testId={test.id} />)}
                    {canQuarantine && (
                        <Button size="sm" onClick={() => jump("#quarantine-card")}>
                            See the quarantine option
                        </Button>
                    )}
                    <Button size="sm" icon={RefreshCw} loading={running} disabled={running} onClick={onRun}>
                        Run this test again
                    </Button>
                </div>
            </div>
        </section>
    );
}
