import { ClipboardList, RotateCcw, Sparkles, X } from "lucide-react";
import { AiModelNote } from "../../components/AiModelNote";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, projectShape, type Job, type ProjectDetail, type TestSummary } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError, friendlyError, isActive } from "../../lib/labels";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { NO_AI_KEY, useAiBlock } from "../aiconfig/aiconfig";
import { type Permission } from "../auth/permissions";
import { useHere } from "../auth/project-access";
import { Modal } from "../../components/Modal";
import { AUTOMATION_HINT, AUTOMATION_WORDS, type CaseList, type ManualCase } from "../manual/manual";
import type { RequirementList } from "../requirements/requirements";
import { BUILDS_ON_RUNNER, useRunsHere } from "../runs/runs-here";
import { useReadiness } from "../runners/my-runner";
import "../manual/manual.css";
import "./authoring.css";

/** POST /api/projects/:id/manual-cases/generate-scripts (src/platform/routes/generate-scripts.ts). */
type SkipReason = "manual" | "has-script" | "not-found" | "later" | "ai-failed" | "refused";
interface GenerateAnswer {
    /** What the AI writes: text steps (web and API) or phone tests (Android). Absent from older servers. */
    form?: "text" | "phone";
    created: Array<{ caseId: string; testId: string; key: string }>;
    skipped: Array<{ caseId: string; reason: SkipReason; detail: string }>;
    eligible?: string[];
    /** Web: the scripts are built one case after the other in a real browser, from this job on (src/platform/case-scripts.ts). */
    started?: { jobId: string; caseIds: string[] };
    /** Set when the project's AI model is not one of this person's own and their default AI was used (components/AiModelNote.tsx). */
    aiNote?: string;
}
/** What the endpoint answers for an iOS-only project and an Android one without its app (src/platform/routes/generate-scripts.ts), said before the click. */
export const IOS_PROJECT = "The AI writes phone test scripts for Android apps only for now. This project tests an iOS app: write its scripts by hand or import them.";
export const NO_APP_FOR_SCRIPTS = "This project has no Android app yet, and a phone test script is saved for the app it tests. Add the app under Settings, Mobile app, then generate the test scripts.";
export const NO_ADDRESS_FOR_SCRIPTS = "This project has no application address yet, and a test script is saved for the address it tests. Add the address in Settings → General, then generate the test scripts.";
/** How a web script is made from a test case: as Test scripts, Describe it makes one (src/platform/case-scripts.ts). */
const BUILT_LIVE = "The AI does each test case's steps in a real browser on the application, signed in with the project's sign-in, keeps the steps that worked and checks what the page really shows, then runs the script.";
const ON_DEVICE = "The AI has not seen the app: it finds each button and field by its visible text or accessibility label, so check each script on the device before approving it.";

/** Phone cases sent per request, so the page can say how far it got (the server takes at most 20; it sends back the rest as "later"). */
const CHUNK = 5;

type Form = "text" | "phone" | "ios";
/** What the AI writes for this project, as the server decides it: web first (also an older project with web and a phone app), then Android. */
export function scriptFormOf(p: ProjectDetail | null | undefined): Form | null {
    if (!p) return null;
    const platforms = projectShape(p).platforms;
    return platforms.includes("web") ? "text" : platforms.includes("android") ? "phone" : "ios";
}

/**
 * Whether the person may have the AI write and save scripts in THIS project: the permissions that count here (the project's
 * `access`, as the server checks them), or the platform-wide ones from a server that does not say.
 */
export function mayGenerateScripts(p: ProjectDetail | null | undefined, can: (permission: Permission) => boolean): boolean {
    const here = p?.access?.permissions;
    const holds = (k: Permission) => (here ? here.includes(k) : can(k));
    return holds("ai_studio.tests.write") && holds("ai_studio.tests.generate");
}

/** Why the AI cannot write test scripts from test cases here, said before the click (in the server's order); null when it can, as far as the page knows. */
export function generateScriptsBlock(p: ProjectDetail | null | undefined, noAi: string | undefined): string | null {
    const form = scriptFormOf(p);
    if (!p || !form) return null;
    if (!projectShape(p).testingModes.includes("code")) return "Test scripts are made from test cases in code-based projects. In an AI agent project the agents decide what to check.";
    if (form === "text" && !/^https?:/i.test(p.application?.url ?? "")) return NO_ADDRESS_FOR_SCRIPTS;
    if (form === "ios") return IOS_PROJECT;
    if (form === "phone" && !(p.mobile?.appPackage || p.mobile?.apk)) return NO_APP_FOR_SCRIPTS;
    if (noAi) return noAi;
    return null;
}

type State =
    | { step: "idle" }
    | { step: "checking" }
    | { step: "confirm"; eligible: string[]; manual: number; scripted: number }
    | { step: "writing"; done: number; total: number }
    | { step: "building"; caseIds: string[]; done: number }
    | { step: "done"; made: number; failed: Array<{ caseId: string; detail: string }>; aiNote?: string };

/** The dry run, then the writing in chunks: one flow for the card under Test cases and the dialog on Test scripts. */
function useGenerateScripts(projectId: string, onDone?: () => void) {
    const [state, setState] = useState<State>({ step: "idle" });
    const [error, setError] = useState<string | null>(null);
    const send = (body: { caseIds?: string[]; dryRun?: boolean }) => api<GenerateAnswer>(`/projects/${projectId}/manual-cases/generate-scripts`, { method: "POST", body });
    const fail = (e: unknown) => {
        setError(e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing ? `${describeApiError(e) || NO_AI_KEY} Then try again.` : describeApiError(e));
        setState({ step: "idle" });
    };

    /** Which of the chosen cases (none = all) would get a script; nothing is written and the AI is not asked. */
    async function check(chosen?: string[]): Promise<Extract<State, { step: "confirm" }> | null> {
        setError(null);
        setState({ step: "checking" });
        try {
            const r = await send({ ...(chosen?.length ? { caseIds: chosen } : {}), dryRun: true });
            const count = (k: SkipReason) => r.skipped.filter((s) => s.reason === k).length;
            const next = { step: "confirm" as const, eligible: r.eligible ?? [], manual: count("manual"), scripted: count("has-script") };
            setState(next);
            return next;
        } catch (e) {
            fail(e);
            return null;
        }
    }

    // Web: the server builds the scripts one after the other; the page follows each case's job until every case has its script or no job
    // of the chain is going on any more. A case whose job ended without a script is named with the job's own reason; a case no job was
    // started for is named with why the chain stopped before it.
    const building = state.step === "building" ? state.caseIds : null;
    useEffect(() => {
        if (!building) return;
        let stop = false;
        let timer: number | undefined;
        let idle = 0;
        const tick = async () => {
            try {
                const [list, jobs] = await Promise.all([api<CaseList>(`/projects/${projectId}/manual-cases`), api<Job[]>(`/projects/${projectId}/jobs`)]);
                if (stop) return;
                const linked = new Set(list.cases.filter((c) => c.linkedTestIds.length > 0).map((c) => c.id));
                const done = building.filter((id) => linked.has(id)).length;
                // Newest first (the server's order): each case's latest job.
                const jobOf = (id: string) => jobs.find((j) => j.caseId === id);
                const going = jobs.some((j) => isActive(j.status) && !!j.caseId && building.includes(j.caseId));
                // Ended twice in a row: the next case's job starts right after one ends, so one look between them is not the end.
                idle = going ? 0 : idle + 1;
                if (done === building.length || idle >= 2) {
                    const refOf = (id: string) => list.cases.find((c) => c.id === id)?.ref ?? "A test case";
                    const last = jobs.find((j) => j.caseId && building.includes(j.caseId));
                    const stoppedWhy = !last
                        ? "it was not started."
                        : last.error === "Cancelled"
                          ? "the building was stopped."
                          : jobs[0] && jobs[0].jobId !== last.jobId && !jobs[0].caseId
                            ? "another run of this project started, and it went first."
                            : last.caseId && !linked.has(last.caseId)
                              ? `the test cases before it got no script for the same reason (${last.error ?? "no test was made"}), so the AI stopped there.`
                              : "it changed while the others were built (it is Manual now, has a script, or asks for something a script is not built for).";
                    const failed = building
                        .filter((id) => !linked.has(id))
                        .map((id) => {
                            const j = jobOf(id);
                            return { caseId: id, detail: j ? `${refOf(id)} got no script: ${j.error ?? "the AI made no test from it"}. Its run on the Runs tab says more.` : `${refOf(id)} was not tried: ${stoppedWhy}` };
                        });
                    setState({ step: "done", made: done, failed });
                    announceProjectChanged(projectId);
                    onDone?.();
                    return;
                }
                setState({ step: "building", caseIds: building, done });
            } catch {
                // A missed look: the next one tries again.
            }
            if (!stop) timer = window.setTimeout(() => void tick(), 3000);
        };
        timer = window.setTimeout(() => void tick(), 3000);
        return () => {
            stop = true;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [building?.join(",")]);

    /**
     * Phone scripts: every case in one click, a few per request so the page can say how far it got. A case the AI could not write is
     * named with why and the others go on; a refusal of a whole request (the AI limit, another call writing, no AI key) holds for the
     * rest as well, so it stops there and names every case left with that sentence. Web: one request queues them all.
     */
    async function write(eligible: string[], form: Form | null) {
        setError(null);
        const failed: Array<{ caseId: string; detail: string }> = [];
        let made = 0;
        let aiNote: string | undefined;
        const refs = new Map<string, string>();
        const refOf = (id: string) => refs.get(id) ?? "A test case";
        try {
            for (const c of (await api<CaseList>(`/projects/${projectId}/manual-cases`)).cases) refs.set(c.id, c.ref);
        } catch {
            // The names are only for the sentences: "A test case" then.
        }
        const queue = [...eligible];
        setState({ step: "writing", done: 0, total: eligible.length });
        while (queue.length) {
            const part = form === "text" ? queue.splice(0) : queue.splice(0, CHUNK);
            let r: GenerateAnswer;
            try {
                r = await send({ caseIds: part });
            } catch (e) {
                if (made === 0 && failed.length === 0 && queue.length === 0 && part.length === eligible.length) return fail(e);
                const why = describeApiError(e);
                for (const id of [...part, ...queue.splice(0)]) failed.push({ caseId: id, detail: `${refOf(id)} got no script: ${why}` });
                break;
            }
            if (r.started) {
                // Web: one call starts them all (the server builds them one after the other); the page follows from here.
                const refused = r.skipped.filter((s) => s.reason === "refused");
                if (refused.length) setError(refused.map((s) => `${refOf(s.caseId)}: ${s.detail}`).join(" "));
                return setState({ step: "building", caseIds: r.started.caseIds, done: 0 });
            }
            made += r.created.length;
            aiNote ??= r.aiNote;
            for (const s of r.skipped) {
                if (s.reason === "ai-failed" || s.reason === "refused") failed.push({ caseId: s.caseId, detail: `${refOf(s.caseId)} got no script: ${s.detail}` });
                // More than one call takes: sent again in the next one.
                else if (s.reason === "later") queue.push(s.caseId);
            }
            setState({ step: "writing", done: eligible.length - queue.length, total: eligible.length });
        }
        setState({ step: "done", made, failed, ...(aiNote ? { aiNote } : {}) });
        if (made > 0) {
            // The Test scripts tab's count follows at once.
            announceProjectChanged(projectId);
            onDone?.();
        }
    }

    return { state, setState, error, check, write };
}

/** "Writing test scripts: 2 of 5", with a progress bar. */
function Writing({ state }: { state: Extract<State, { step: "writing" }> }) {
    return (
        <div className="stack-sm" role="status" aria-live="polite">
            <p className="t-card">
                Writing test scripts: {state.done} of {state.total}
            </p>
            <progress className="gen-progress" max={state.total} value={state.done} aria-label="Test scripts written" />
        </div>
    );
}

/** "Building test scripts: 1 of 3", while the server builds them one after the other in a real browser. */
function Building({ state }: { state: Extract<State, { step: "building" }> }) {
    const total = state.caseIds.length;
    return (
        <div className="stack-sm" role="status" aria-live="polite" data-testid="generate-scripts-building">
            <p className="t-card">
                Building test scripts: {state.done} of {total}
            </p>
            <progress className="gen-progress" max={total} value={state.done} aria-label="Test scripts built" />
            <p className="t-meta">{BUILT_LIVE} One test case at a time; you can leave this page, and each script shows on its test case when it is ready.</p>
        </div>
    );
}

/** How many were made (and that phone scripts need the device), and the cases that got none, with why. */
function Outcome({ state, form, projectId, onClose, onRetry }: { state: Extract<State, { step: "done" }>; form: Form | null; projectId: string; /** Closes the banner. */ onClose?: () => void; /** Tries only the cases that got no script. */ onRetry?: (caseIds: string[]) => void }) {
    const retry = [...new Set(state.failed.map((f) => f.caseId).filter(Boolean))];
    const them = state.made === 1 ? "it" : "them";
    return (
        <div className="stack-sm">
            {state.made > 0 && (
                <div className="gen-banner" role="status">
                    <div className="gen-text">
                        <p className="t-card">Test scripts generated</p>
                        <p className="t-secondary">
                            {plural(state.made, form === "phone" ? "phone test script" : "test script")} {state.made === 1 ? "has" : "have"} been created from your test cases.{" "}
                            {form === "phone" ? `The AI wrote ${them} without seeing the app: check ${them} on the device, then approve ${them} to run ${them}.` : `${state.made === 1 ? "It was" : "Each was"} built on the application and run once: open ${them} to see whether ${state.made === 1 ? "it" : "they"} passed.`}
                        </p>
                    </div>
                    <LinkButton size="sm" variant="primary" href={routes.tests(projectId)}>
                        View test scripts
                    </LinkButton>
                    {onClose && (
                        <Button size="sm" variant="ghost" icon={X} iconOnly aria-label="Close" onClick={onClose}>
                            Close
                        </Button>
                    )}
                </div>
            )}
            <AiModelNote note={state.aiNote} />
            {state.failed.length > 0 && (
                <Callout
                    tone="warning"
                    title={`${plural(state.failed.length, "test case")} got no script`}
                    actions={
                        onRetry &&
                        retry.length > 0 && (
                            <Button size="sm" icon={RotateCcw} onClick={() => onRetry(retry)}>
                                Try {retry.length === 1 ? "it" : `these ${retry.length}`} again
                            </Button>
                        )
                    }
                >
                    <ul className="gen-fails" data-testid="scripts-not-written">
                        {state.failed.map((f, i) => (
                            <li key={`${f.caseId}-${i}`}>{f.detail}</li>
                        ))}
                    </ul>
                </Callout>
            )}
        </div>
    );
}

/**
 * "Generate test scripts using AI", under the Test cases list: the AI writes a test script for each chosen test case of type
 * Automated that has none yet (none chosen = every test case): text steps in a web project, a phone test in an Android one. It says
 * how many first and that Manual cases are skipped, shows how far it got, then how many were made. The scripts are the AI's drafts:
 * they run once approved.
 */
export function GenerateScriptsCard({ projectId, caseIds, onDone }: { projectId: string; /** The cases chosen in the list; none = all. */ caseIds?: string[]; /** After scripts were made (the list shows its new links). */ onDone?: () => void }) {
    const noAi = useAiBlock();
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const can = useHere(projectId, project).may;
    const form = scriptFormOf(project.data);
    const block0 = generateScriptsBlock(project.data, noAi);
    const { state, setState, error, check, write } = useGenerateScripts(projectId, onDone);
    // Web scripts are built in a real browser in a run, as Describe it builds a test (NewTestMenu.tsx): the same reasons it cannot here.
    const runsHere = useRunsHere();
    const ready = useReadiness({ can: ["web", "plain"] });
    const buildWhy = form !== "text" ? null : ready.mode === "runners" ? (ready.ready ? null : (ready.reason ?? BUILDS_ON_RUNNER)) : runsHere ? null : "Tests are switched off on this server, and test scripts are built in a real browser in a run.";
    const block = block0 ?? buildWhy;
    // The AI writes and saves the scripts: both permissions in this project, as the server asks.
    if (!project.data || !mayGenerateScripts(project.data, can)) return null;
    const chosen = caseIds?.length ? caseIds : undefined;

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
                    <Button icon={Sparkles} loading={state.step === "checking"} disabled={!!block} tip={block ?? undefined} onClick={() => void check(chosen)}>
                        Generate test scripts
                    </Button>
                )}
            </div>
            {block && block !== noAi && state.step === "idle" && (
                <p className="t-meta" data-testid="generate-scripts-why">
                    {block}
                </p>
            )}
            {noAi && block === noAi && state.step === "idle" && <p className="t-meta">Test scripts cannot be generated with AI: {noAi} You can still write them by hand in Test scripts.</p>}
            {!block && form === "phone" && state.step === "idle" && <p className="t-meta">This project tests an Android app, so the AI writes phone test scripts. {ON_DEVICE}</p>}
            {error && <Callout tone="danger" title="No test scripts were made">{error}</Callout>}

            {state.step === "confirm" &&
                (state.eligible.length === 0 ? (
                    <Callout tone="info" title="Nothing to generate" actions={<Button size="sm" onClick={() => setState({ step: "idle" })}>Close</Button>}>
                        {skipLine(state.manual, state.scripted) || "There are no test cases to make scripts from yet."} Only Automated test cases without a script get one.
                    </Callout>
                ) : (
                    <Callout
                        tone="info"
                        title={`Generate ${plural(state.eligible.length, form === "phone" ? "phone test script" : "test script")}?`}
                        actions={
                            <>
                                <Button size="sm" variant="primary" icon={Sparkles} onClick={() => void write(state.eligible, form)}>
                                    Generate {plural(state.eligible.length, "script")}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setState({ step: "idle" })}>
                                    Cancel
                                </Button>
                            </>
                        }
                    >
                        The AI writes one script for each {chosen ? "chosen " : ""}Automated test case that has none yet. {skipLine(state.manual, state.scripted)} {form === "phone" ? `The scripts are drafts: they run once they are approved. ${ON_DEVICE} ` : `${BUILT_LIVE} `}Uses the AI model.
                    </Callout>
                ))}

            {state.step === "writing" && <Writing state={state} />}
            {state.step === "building" && <Building state={state} />}
            {state.step === "done" && <Outcome state={state} form={form} projectId={projectId} onClose={() => setState({ step: "idle" })} onRetry={(ids) => void write(ids, form)} />}
        </section>
    );
}

/** "2 Manual test cases are skipped, 1 already has its script." */
function skipLine(manual: number, scripted: number): string {
    const parts = [manual ? `${plural(manual, "Manual test case")} ${manual === 1 ? "is" : "are"} skipped` : "", scripted ? `${plural(scripted, "test case")} already ${scripted === 1 ? "has its" : "have their"} script` : ""].filter(Boolean);
    return parts.length ? `${parts.join(", ")}.` : "";
}
