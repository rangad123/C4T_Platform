import { ArrowRight, RotateCcw, Sparkles, X } from "lucide-react";
import { AiModelNote } from "../../components/AiModelNote";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api";
import { Button, Callout, LinkButton } from "../../components/ui";
import { plural } from "../../lib/format";
import { routes } from "../../lib/router";
import { useAiBlock } from "../aiconfig/aiconfig";
import "../manual/manual.css";
import "../authoring/authoring.css";
import type { GenerateCasesResult } from "./requirements";
import { describeApiError } from "../../lib/labels";

/** Requirements sent in one request (the server's limit). */
export const MAX_GENERATE = 50;
/** Requirements sent per request, so the page can say how far it got (the server's batch, engine/manual/generate.ts). */
const CHUNK = 5;

/** A requirement that got no test case, and why (the server's words, or the refusal of its request). */
export interface NotWritten {
    id: string;
    ref: string;
    why: string;
}

export type GenerateState =
    | { step: "idle" }
    | { step: "busy"; count: number; done: number }
    | { step: "done"; result: GenerateCasesResult; notWritten: NotWritten[] }
    | { step: "error"; text: string; modelMissing?: boolean };

/** The answers of the requests of one click, as one answer. */
function together(parts: GenerateCasesResult[]): GenerateCasesResult {
    const notes = [...new Set(parts.map((r) => r.note).filter(Boolean))];
    return {
        created: parts.reduce((n, r) => n + r.created, 0),
        cases: parts.flatMap((r) => r.cases),
        perRequirement: parts.flatMap((r) => r.perRequirement),
        duplicates: parts.reduce((n, r) => n + r.duplicates, 0),
        limited: parts.some((r) => r.limited),
        failed: parts.flatMap((r) => r.failed),
        note: notes.join(" ") || null,
        total: parts.at(-1)?.total ?? 0,
        ...(parts.find((r) => r.aiNote) ? { aiNote: parts.find((r) => r.aiNote)!.aiNote } : {}),
    };
}

/** The generate-cases flow of the Requirements list: choose requirements, send them, and the outcome. */
export function useGenerateCases(projectId: string, initiallyChoosing: boolean, onDone: () => Promise<void> | void, refOf: (id: string) => string = (id) => id) {
    const [state, setState] = useState<GenerateState>({ step: "idle" });
    const [choosing, setChoosing] = useState(initiallyChoosing);
    const [chosen, setChosen] = useState<Set<string>>(new Set());

    /**
     * Every chosen requirement in one click: sent a few at a time (the progress says how many are done), on to the end. A request the
     * AI could not answer names its requirements and the rest go on; a refusal that holds for the rest too (the AI limit, no AI key, the
     * project full) stops there and names every requirement left, with its sentence.
     */
    async function run(ids: string[]) {
        if (ids.length === 0) return setState({ step: "error", text: "Choose at least one requirement to write test cases for." });
        setState({ step: "busy", count: ids.length, done: 0 });
        const parts: GenerateCasesResult[] = [];
        const notWritten: NotWritten[] = [];
        let firstError: { text: string; modelMissing: boolean } | null = null;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const part = ids.slice(i, i + CHUNK);
            try {
                const r = await api<GenerateCasesResult>(`/projects/${projectId}/requirements/generate-cases`, { method: "POST", body: { requirementIds: part } });
                parts.push(r);
                for (const q of r.perRequirement) if (q.failed) notWritten.push({ id: q.id, ref: q.ref, why: q.why ?? "The AI wrote no test case for it." });
            } catch (e) {
                const text = describeApiError(e);
                const modelMissing = e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing === true;
                firstError ??= { text, modelMissing };
                // The AI could not answer for these (502): the next ones may work. Anything else holds for the rest as well.
                const rest = e instanceof ApiError && e.status === 502 ? part : ids.slice(i);
                for (const id of rest) notWritten.push({ id, ref: refOf(id), why: text });
                if (rest !== part) break;
            }
            setState({ step: "busy", count: ids.length, done: Math.min(i + CHUNK, ids.length) });
        }
        if (parts.length === 0) return setState({ step: "error", text: firstError?.text ?? "No test cases were written.", ...(firstError?.modelMissing ? { modelMissing: true } : {}) });
        setChosen(new Set());
        setChoosing(false);
        setState({ step: "done", result: together(parts), notWritten });
        await onDone();
    }

    async function generate() {
        if (chosen.size > MAX_GENERATE) return setState({ step: "error", text: `Choose at most ${MAX_GENERATE} requirements at a time. ${chosen.size} are chosen.` });
        await run([...chosen]);
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
        /** Only the requirements that got no test case, again. */
        retry: (ids: string[]) => run(ids),
    };
}

/**
 * The outcome, shown in the card where the person clicked: the progress, the success banner with View test cases, or the plain
 * reason it did not work. Progress and success are a status (read out politely), a failure an alert; the outcome takes the focus.
 */
export function GenerateOutcome({ projectId, state, onClose, onRetry }: { projectId: string; state: GenerateState; onClose: () => void; /** Try only the requirements that got no test case. */ onRetry?: (ids: string[]) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (state.step === "done" || state.step === "error") ref.current?.focus({ preventScroll: true });
        if (state.step !== "idle") ref.current?.scrollIntoView({ block: "nearest" });
    }, [state.step]);
    // A danger callout is an alert by itself; the warning one (no AI key) is made one here.
    const role = state.step === "error" ? (state.modelMissing ? "alert" : undefined) : "status";
    return (
        <div ref={ref} tabIndex={-1} role={role} aria-live={role === "status" ? "polite" : undefined} className="gen-outcome" data-testid="generate-cases-outcome">
            <OutcomeBody projectId={projectId} state={state} onClose={onClose} onRetry={onRetry} />
        </div>
    );
}

function OutcomeBody({ projectId, state, onClose, onRetry }: { projectId: string; state: GenerateState; onClose: () => void; onRetry?: (ids: string[]) => void }) {
    if (state.step === "busy")
        return (
            <Callout tone="info" title="Writing test cases">
                <span data-testid="generate-cases-progress">
                    Writing test cases: {state.done} of {plural(state.count, "requirement")} done.
                </span>{" "}
                The AI goes on until every chosen requirement has its test cases. This can take a few minutes; stay on this page.
                <progress className="gen-progress" max={state.count} value={state.done} aria-label="Requirements done" />
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
            {state.notWritten.length > 0 && (
                <Callout
                    tone="warning"
                    title={`${plural(state.notWritten.length, "requirement")} got no test cases`}
                    actions={
                        onRetry && (
                            <Button size="sm" icon={RotateCcw} onClick={() => onRetry(state.notWritten.map((n) => n.id))}>
                                Try {state.notWritten.length === 1 ? "it" : `these ${state.notWritten.length}`} again
                            </Button>
                        )
                    }
                >
                    <ul className="gen-fails" data-testid="cases-not-written">
                        {state.notWritten.map((n) => (
                            <li key={n.id}>
                                {n.ref}: {n.why}
                            </li>
                        ))}
                    </ul>
                </Callout>
            )}
            <AiModelNote note={r.aiNote} />
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
 * has no usable AI key, and shows the outcome (`outcome`) in itself, where the person clicked.
 */
export function GenerateCasesCard({ projectId, state, choosing, chosenCount, hasRequirements, onStart, onGenerate, onCancel, outcome }: { projectId: string; state: GenerateState; choosing: boolean; chosenCount: number; hasRequirements: boolean; onStart: () => void; onGenerate: () => void; onCancel: () => void; outcome?: ReactNode }) {
    const noAi = useAiBlock();
    const aiReady = !noAi;
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
                        {noAi} You can still add test cases by hand in <a href={routes.cases(projectId)}>Test cases</a>.
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
