import { ArrowRight, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api";
import { Button, Callout, LinkButton } from "../../components/ui";
import { plural } from "../../lib/format";
import { routes } from "../../lib/router";
import { useProjectAiReady } from "../aiconfig/aiconfig";
import "../manual/manual.css";
import type { GenerateCasesResult } from "./requirements";
import { describeApiError } from "../../lib/labels";

/** Requirements sent in one request (the server's limit). */
export const MAX_GENERATE = 50;

export type GenerateState =
    | { step: "idle" }
    | { step: "busy"; count: number }
    | { step: "done"; result: GenerateCasesResult }
    | { step: "error"; text: string; modelMissing?: boolean };

/** The generate-cases flow of the Requirements list: choose requirements, send them, and the outcome. */
export function useGenerateCases(projectId: string, initiallyChoosing: boolean, onDone: () => Promise<void> | void) {
    const [state, setState] = useState<GenerateState>({ step: "idle" });
    const [choosing, setChoosing] = useState(initiallyChoosing);
    const [chosen, setChosen] = useState<Set<string>>(new Set());

    async function generate() {
        if (chosen.size === 0) return setState({ step: "error", text: "Choose at least one requirement to write test cases for." });
        if (chosen.size > MAX_GENERATE) return setState({ step: "error", text: `Choose at most ${MAX_GENERATE} requirements at a time. ${chosen.size} are chosen.` });
        setState({ step: "busy", count: chosen.size });
        try {
            const result = await api<GenerateCasesResult>(`/projects/${projectId}/requirements/generate-cases`, { method: "POST", body: { requirementIds: [...chosen] } });
            setChosen(new Set());
            setChoosing(false);
            setState({ step: "done", result });
            await onDone();
        } catch (e) {
            const modelMissing = e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing === true;
            setState({ step: "error", text: describeApiError(e), modelMissing });
        }
    }

    return {
        state,
        choosing,
        chosen,
        start: () => (setChoosing(true), setState({ step: "idle" })),
        cancel: () => (setChosen(new Set()), setChoosing(false), setState({ step: "idle" })),
        dismiss: () => setState({ step: "idle" }),
        toggle: (id: string, on: boolean) => setChosen((s) => (on ? new Set([...s, id]) : new Set([...s].filter((x) => x !== id)))),
        setAll: (ids: string[], on: boolean) => setChosen((s) => (on ? new Set([...s, ...ids]) : new Set([...s].filter((x) => !ids.includes(x))))),
        generate,
    };
}

/**
 * The outcome, shown in the card where the person clicked: the progress, the success banner with View test cases, or the plain
 * reason it did not work. Progress and success are a status (read out politely), a failure an alert; the outcome takes the focus.
 */
export function GenerateOutcome({ projectId, state, onClose }: { projectId: string; state: GenerateState; onClose: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (state.step === "done" || state.step === "error") ref.current?.focus({ preventScroll: true });
        if (state.step !== "idle") ref.current?.scrollIntoView({ block: "nearest" });
    }, [state.step]);
    // A danger callout is an alert by itself; the warning one (no AI model) is made one here.
    const role = state.step === "error" ? (state.modelMissing ? "alert" : undefined) : "status";
    return (
        <div ref={ref} tabIndex={-1} role={role} aria-live={role === "status" ? "polite" : undefined} className="gen-outcome" data-testid="generate-cases-outcome">
            <OutcomeBody projectId={projectId} state={state} onClose={onClose} />
        </div>
    );
}

function OutcomeBody({ projectId, state, onClose }: { projectId: string; state: GenerateState; onClose: () => void }) {
    if (state.step === "busy")
        return (
            <Callout tone="info" title="Writing test cases">
                The AI is writing test cases for {plural(state.count, "requirement")}. This can take a minute; stay on this page.
            </Callout>
        );
    if (state.step === "error")
        return (
            <Callout tone={state.modelMissing ? "warning" : "danger"} title={state.modelMissing ? "AI not set up" : "No test cases were written"} actions={<CloseButton onClose={onClose} />}>
                {state.text}
            </Callout>
        );
    if (state.step !== "done") return null;
    const r = state.result;
    return (
        <div data-testid="cases-generated">
            <Callout
                tone={r.created > 0 ? "success" : "warning"}
                title={r.created > 0 ? "Test cases generated" : "No new test cases"}
                actions={
                    <>
                        <LinkButton href={routes.cases(projectId)} icon={ArrowRight}>
                            View test cases
                        </LinkButton>
                        <CloseButton onClose={onClose} />
                    </>
                }
            >
                {r.created > 0 ? `${plural(r.created, "test case")} ${r.created === 1 ? "has" : "have"} been created from your requirements.` : "The AI wrote nothing new for these requirements."}
                {r.note && ` ${r.note}`}
            </Callout>
        </div>
    );
}

function CloseButton({ onClose }: { onClose: () => void }) {
    return (
        <Button variant="ghost" size="sm" icon={X} iconOnly aria-label="Close this message" onClick={onClose} />
    );
}

/**
 * The card under the requirements of a code-based project: Generate test cases using AI. It says before the click when the project
 * has no AI model, and shows the outcome (`outcome`) in itself, where the person clicked.
 */
export function GenerateCasesCard({ projectId, state, choosing, chosenCount, hasRequirements, onStart, onGenerate, onCancel, outcome }: { projectId: string; state: GenerateState; choosing: boolean; chosenCount: number; hasRequirements: boolean; onStart: () => void; onGenerate: () => void; onCancel: () => void; outcome?: ReactNode }) {
    const aiReady = useProjectAiReady(projectId);
    const noAi = aiReady ? undefined : "Needs an AI model. A project admin can set one up in Settings, AI configuration.";
    return (
        <section className="card card-pad ai-card" aria-labelledby="gen-cases-title" data-testid="generate-cases">
            <span className="ai-tile" aria-hidden>
                <Sparkles size={32} />
            </span>
            <div className="ai-body">
                <h2 className="t-section" id="gen-cases-title">
                    Generate test cases using AI
                </h2>
                <p className="t-secondary">Automatically create test cases from your added requirements using AI.</p>
                {!aiReady && (
                    <p className="t-meta" data-testid="generate-cases-no-ai">
                        The AI model isn’t set up for this project, so test cases cannot be generated here. You can still add them by hand in <a href={routes.cases(projectId)}>Test cases</a>.
                    </p>
                )}
                {!hasRequirements ? (
                    <p className="t-meta">Add a requirement first, or import them from a document: the AI writes test cases from them.</p>
                ) : choosing ? (
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        <Button variant="primary" icon={Sparkles} loading={state.step === "busy"} disabled={!aiReady} tip={noAi} onClick={onGenerate}>
                            {chosenCount > 0 ? `Generate test cases for ${plural(chosenCount, "requirement")}` : "Generate test cases"}
                        </Button>
                        <Button onClick={onCancel} disabled={state.step === "busy"}>
                            Cancel
                        </Button>
                    </div>
                ) : (
                    <Button icon={Sparkles} disabled={!aiReady} tip={noAi} onClick={onStart}>
                        Generate test cases
                    </Button>
                )}
                {choosing && hasRequirements && <p className="t-meta">Choose the requirements above: all of them, or only the new ones.</p>}
                {outcome}
            </div>
        </section>
    );
}
