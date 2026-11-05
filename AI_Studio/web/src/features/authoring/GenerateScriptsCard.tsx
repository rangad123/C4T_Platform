import { Sparkles, X } from "lucide-react";
import { useState } from "react";
import { ApiError, api, projectShape, type ProjectDetail } from "../../api";
import { Button, Callout, LinkButton } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { useProjectAiReady } from "../aiconfig/aiconfig";
import { useCan } from "../auth/permissions";
import "./authoring.css";

/** POST /api/projects/:id/manual-cases/generate-scripts (src/platform/routes/generate-scripts.ts). */
type SkipReason = "manual" | "has-script" | "not-found" | "later" | "ai-failed" | "refused";
interface GenerateAnswer {
    created: Array<{ caseId: string; testId: string; key: string }>;
    skipped: Array<{ caseId: string; reason: SkipReason; detail: string }>;
    eligible?: string[];
}
/** What the endpoint answers for a project without the web platform (src/platform/routes/generate-scripts.ts), said before the click. */
export const PHONE_PROJECT = "The AI writes test scripts as text steps, and text steps cover web and API tests only for now. This project tests a phone app: write its scripts by hand or import them.";

/** Cases sent per request, so the page can say how far it got (the server takes at most 20). */
const CHUNK = 5;

type State =
    | { step: "idle" }
    | { step: "checking" }
    | { step: "confirm"; eligible: string[]; manual: number; scripted: number }
    | { step: "writing"; done: number; total: number }
    | { step: "done"; made: number; failed: Array<{ caseId: string; detail: string }> };

/**
 * "Generate test scripts using AI", under the Test cases list: the AI writes a test script for each chosen test case of type
 * Automated that has none yet (none chosen = every test case). It says how many first and that Manual cases are skipped, shows how
 * far it got, then how many were made. The scripts are the AI's drafts: they run once approved.
 */
export function GenerateScriptsCard({ projectId, caseIds, onDone }: { projectId: string; /** The cases chosen in the list; none = all. */ caseIds?: string[]; /** After scripts were made (the list shows its new links). */ onDone?: () => void }) {
    const can = useCan();
    const aiReady = useProjectAiReady(projectId);
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const phone = project.data ? !projectShape(project.data).platforms.includes("web") : false;
    const [state, setState] = useState<State>({ step: "idle" });
    const [error, setError] = useState<string | null>(null);
    // The AI writes and saves the scripts: both permissions, as the server asks.
    if (!can("ai_studio.tests.write") || !can("ai_studio.tests.generate")) return null;
    const chosen = caseIds?.length ? caseIds : undefined;
    const send = (body: { caseIds?: string[]; dryRun?: boolean }) => api<GenerateAnswer>(`/projects/${projectId}/manual-cases/generate-scripts`, { method: "POST", body });
    const fail = (e: unknown) => {
        setError(e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing ? "The AI model isn’t set up yet. A project admin can set one up in Settings, AI configuration, then try again." : describeApiError(e));
        setState({ step: "idle" });
    };

    async function check() {
        setError(null);
        setState({ step: "checking" });
        try {
            const r = await send({ ...(chosen ? { caseIds: chosen } : {}), dryRun: true });
            const count = (k: SkipReason) => r.skipped.filter((s) => s.reason === k).length;
            setState({ step: "confirm", eligible: r.eligible ?? [], manual: count("manual"), scripted: count("has-script") });
        } catch (e) {
            fail(e);
        }
    }

    async function write(eligible: string[]) {
        setError(null);
        const failed: Array<{ caseId: string; detail: string }> = [];
        let made = 0;
        setState({ step: "writing", done: 0, total: eligible.length });
        try {
            for (let i = 0; i < eligible.length; i += CHUNK) {
                const r = await send({ caseIds: eligible.slice(i, i + CHUNK) });
                made += r.created.length;
                failed.push(...r.skipped.filter((s) => s.reason === "ai-failed" || s.reason === "refused"));
                setState({ step: "writing", done: Math.min(i + CHUNK, eligible.length), total: eligible.length });
            }
        } catch (e) {
            if (made === 0) return fail(e);
            failed.push({ caseId: "", detail: describeApiError(e) });
        }
        setState({ step: "done", made, failed });
        if (made > 0) {
            // The Test scripts tab's count follows at once.
            announceProjectChanged(projectId);
            onDone?.();
        }
    }

    return (
        <section className="card card-pad gen-card" data-testid="generate-scripts">
            <div className="gen-row">
                <span className="gen-tile" aria-hidden>
                    <Sparkles size={24} />
                </span>
                <div className="gen-text">
                    <h2 className="t-card">Generate test scripts using AI</h2>
                    <p className="t-secondary">Automatically create test scripts for the selected or all test cases using AI.</p>
                </div>
                {(state.step === "idle" || state.step === "checking" || state.step === "done") && (
                    <Button icon={Sparkles} loading={state.step === "checking"} disabled={!aiReady || phone} tip={phone ? "Web and API projects only for now." : aiReady ? undefined : "Needs an AI model. A project admin can set one up in Settings, AI configuration."} onClick={() => void check()}>
                        Generate test scripts
                    </Button>
                )}
            </div>
            {phone && state.step === "idle" && (
                <p className="t-meta" data-testid="generate-scripts-phone">
                    {PHONE_PROJECT}
                </p>
            )}
            {!phone && !aiReady && state.step === "idle" && <p className="t-meta">The AI model isn’t set up for this project, so test scripts cannot be generated here. You can still write them by hand in Test scripts.</p>}
            {error && <Callout tone="danger" title="No test scripts were made">{error}</Callout>}

            {state.step === "confirm" &&
                (state.eligible.length === 0 ? (
                    <Callout tone="info" title="Nothing to generate" actions={<Button size="sm" onClick={() => setState({ step: "idle" })}>Close</Button>}>
                        {skipLine(state.manual, state.scripted) || "There are no test cases to make scripts from yet."} Only Automated test cases without a script get one.
                    </Callout>
                ) : (
                    <Callout
                        tone="info"
                        title={`Generate ${plural(state.eligible.length, "test script")}?`}
                        actions={
                            <>
                                <Button size="sm" variant="primary" icon={Sparkles} onClick={() => void write(state.eligible)}>
                                    Generate {plural(state.eligible.length, "script")}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setState({ step: "idle" })}>
                                    Cancel
                                </Button>
                            </>
                        }
                    >
                        The AI writes one script for each {chosen ? "chosen " : ""}Automated test case that has none yet. {skipLine(state.manual, state.scripted)} The scripts are drafts: they run once they are approved. Uses the AI model.
                    </Callout>
                ))}

            {state.step === "writing" && (
                <div className="stack-sm" role="status" aria-live="polite">
                    <p className="t-card">
                        Writing test scripts: {state.done} of {state.total}
                    </p>
                    <progress className="gen-progress" max={state.total} value={state.done} aria-label="Test scripts written" />
                </div>
            )}

            {state.step === "done" && (
                <div className="stack-sm">
                    {state.made > 0 && (
                        <div className="gen-banner" role="status">
                            <div className="gen-text">
                                <p className="t-card">Test scripts generated</p>
                                <p className="t-secondary">{plural(state.made, "test script")} {state.made === 1 ? "has" : "have"} been created from your test cases. Review and approve them to run them.</p>
                            </div>
                            <LinkButton size="sm" variant="primary" href={routes.tests(projectId)}>
                                View test scripts
                            </LinkButton>
                            <Button size="sm" variant="ghost" icon={X} iconOnly aria-label="Close" onClick={() => setState({ step: "idle" })}>
                                Close
                            </Button>
                        </div>
                    )}
                    {state.failed.length > 0 && (
                        <Callout tone="warning" title={`${plural(state.failed.length, "test case")} got no script`}>
                            <ul className="gen-fails">
                                {state.failed.map((f, i) => (
                                    <li key={`${f.caseId}-${i}`}>{f.detail}</li>
                                ))}
                            </ul>
                        </Callout>
                    )}
                </div>
            )}
        </section>
    );
}

/** "2 Manual test cases are skipped, 1 already has its script." */
function skipLine(manual: number, scripted: number): string {
    const parts = [manual ? `${plural(manual, "Manual test case")} ${manual === 1 ? "is" : "are"} skipped` : "", scripted ? `${plural(scripted, "test case")} already ${scripted === 1 ? "has its" : "have their"} script` : ""].filter(Boolean);
    return parts.length ? `${parts.join(", ")}.` : "";
}
