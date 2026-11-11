import { ClipboardList, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, api, projectShape, type ProjectDetail, type TestSummary } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError, friendlyError } from "../../lib/labels";
import { announceProjectChanged, useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { useProjectAiReady } from "../aiconfig/aiconfig";
import { type Permission } from "../auth/permissions";
import { useHere } from "../auth/project-access";
import { Modal } from "../../components/Modal";
import { AUTOMATION_HINT, AUTOMATION_WORDS, type CaseList, type ManualCase } from "../manual/manual";
import type { RequirementList } from "../requirements/requirements";
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
}
/** What the endpoint answers for an iOS-only project and an Android one without its app (src/platform/routes/generate-scripts.ts), said before the click. */
export const IOS_PROJECT = "The AI writes phone test scripts for Android apps only for now. This project tests an iOS app: write its scripts by hand or import them.";
export const NO_APP_FOR_SCRIPTS = "This project has no Android app yet, and a phone test script is saved for the app it tests. Add the app under Settings, Mobile app, then generate the test scripts.";
export const NO_ADDRESS_FOR_SCRIPTS = "This project has no application address yet, and a test script is saved for the address it tests. Add the address in Settings → General, then generate the test scripts.";
export const NO_PERMISSION_FOR_SCRIPTS = "Needs permission to use the AI to write tests.";
const NO_AI = "The AI model isn’t set up for this project, so test scripts cannot be generated here.";
const NO_AI_TIP = "Needs an AI model. A project admin can set one up in Settings, AI configuration.";
const ON_DEVICE = "The AI has not seen the app: it finds each button and field by its visible text or accessibility label, so check each script on the device before approving it.";

/** Cases sent per request, so the page can say how far it got (the server takes at most 20). */
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
export function generateScriptsBlock(p: ProjectDetail | null | undefined, aiReady: boolean): string | null {
    const form = scriptFormOf(p);
    if (!p || !form) return null;
    if (!projectShape(p).testingModes.includes("code")) return "Test scripts are made from test cases in code-based projects. In an AI agent project the agents decide what to check.";
    if (form === "text" && !/^https?:/i.test(p.application?.url ?? "")) return NO_ADDRESS_FOR_SCRIPTS;
    if (form === "ios") return IOS_PROJECT;
    if (form === "phone" && !(p.mobile?.appPackage || p.mobile?.apk)) return NO_APP_FOR_SCRIPTS;
    if (!aiReady) return NO_AI_TIP;
    return null;
}

type State =
    | { step: "idle" }
    | { step: "checking" }
    | { step: "confirm"; eligible: string[]; manual: number; scripted: number }
    | { step: "writing"; done: number; total: number }
    | { step: "done"; made: number; failed: Array<{ caseId: string; detail: string }> };

/** The dry run, then the writing in chunks: one flow for the card under Test cases and the dialog on Test scripts. */
function useGenerateScripts(projectId: string, onDone?: () => void) {
    const [state, setState] = useState<State>({ step: "idle" });
    const [error, setError] = useState<string | null>(null);
    const send = (body: { caseIds?: string[]; dryRun?: boolean }) => api<GenerateAnswer>(`/projects/${projectId}/manual-cases/generate-scripts`, { method: "POST", body });
    const fail = (e: unknown) => {
        setError(e instanceof ApiError && (e.details as { modelMissing?: boolean } | undefined)?.modelMissing ? "The AI model isn’t set up yet. A project admin can set one up in Settings, AI configuration, then try again." : describeApiError(e));
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

/** How many were made (and that phone scripts need the device), and the cases that got none, with why. */
function Outcome({ state, form, projectId, onClose, inList }: { state: Extract<State, { step: "done" }>; form: Form | null; projectId: string; /** Closes the banner (the card); absent in the dialog, whose own button closes it. */ onClose?: () => void; /** Shown on Test scripts already: no link to it. */ inList?: boolean }) {
    const them = state.made === 1 ? "it" : "them";
    return (
        <div className="stack-sm">
            {state.made > 0 && (
                <div className="gen-banner" role="status">
                    <div className="gen-text">
                        <p className="t-card">Test scripts generated</p>
                        <p className="t-secondary">
                            {plural(state.made, form === "phone" ? "phone test script" : "test script")} {state.made === 1 ? "has" : "have"} been created from your test cases.{" "}
                            {form === "phone" ? `The AI wrote ${them} without seeing the app: check ${them} on the device, then approve ${them} to run ${them}.` : `Review and approve ${them} to run ${them}.`}
                        </p>
                    </div>
                    {!inList && (
                        <LinkButton size="sm" variant="primary" href={routes.tests(projectId)}>
                            View test scripts
                        </LinkButton>
                    )}
                    {onClose && (
                        <Button size="sm" variant="ghost" icon={X} iconOnly aria-label="Close" onClick={onClose}>
                            Close
                        </Button>
                    )}
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
    );
}

/**
 * "Generate test scripts using AI", under the Test cases list: the AI writes a test script for each chosen test case of type
 * Automated that has none yet (none chosen = every test case): text steps in a web project, a phone test in an Android one. It says
 * how many first and that Manual cases are skipped, shows how far it got, then how many were made. The scripts are the AI's drafts:
 * they run once approved.
 */
export function GenerateScriptsCard({ projectId, caseIds, onDone }: { projectId: string; /** The cases chosen in the list; none = all. */ caseIds?: string[]; /** After scripts were made (the list shows its new links). */ onDone?: () => void }) {
    const aiReady = useProjectAiReady(projectId);
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const can = useHere(projectId, project).may;
    const form = scriptFormOf(project.data);
    const block = generateScriptsBlock(project.data, aiReady);
    const { state, setState, error, check, write } = useGenerateScripts(projectId, onDone);
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
            {block && block !== NO_AI_TIP && state.step === "idle" && (
                <p className="t-meta" data-testid="generate-scripts-why">
                    {block}
                </p>
            )}
            {block === NO_AI_TIP && state.step === "idle" && <p className="t-meta">{NO_AI} You can still write them by hand in Test scripts.</p>}
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
                                <Button size="sm" variant="primary" icon={Sparkles} onClick={() => void write(state.eligible)}>
                                    Generate {plural(state.eligible.length, "script")}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setState({ step: "idle" })}>
                                    Cancel
                                </Button>
                            </>
                        }
                    >
                        The AI writes one script for each {chosen ? "chosen " : ""}Automated test case that has none yet. {skipLine(state.manual, state.scripted)} The scripts are drafts: they run once they are approved. {form === "phone" ? `${ON_DEVICE} ` : ""}Uses the AI model.
                    </Callout>
                ))}

            {state.step === "writing" && <Writing state={state} />}
            {state.step === "done" && <Outcome state={state} form={form} projectId={projectId} onClose={() => setState({ step: "idle" })} />}
        </section>
    );
}

/**
 * "Generate from test cases" on Test scripts (New test script menu): the project's written test cases with checkboxes, the same
 * choice the Test cases list gives, then the same flow as the card. Manual cases and cases that already have their script cannot be
 * chosen, and say why. The scripts are the AI's drafts; the list behind the dialog shows them once they are made.
 */
export function GenerateFromCasesDialog({ projectId, onClose, onMade }: { projectId: string; onClose: () => void; /** After scripts were made. */ onMade?: () => void }) {
    const aiReady = useProjectAiReady(projectId);
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const list = useFetch<CaseList>(`/projects/${projectId}/manual-cases`);
    const reqs = useFetch<RequirementList>(`/projects/${projectId}/requirements`);
    const tests = useFetch<TestSummary[]>(`/projects/${projectId}/tests`);
    const form = scriptFormOf(project.data);
    const block = generateScriptsBlock(project.data, aiReady);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const { state, error, check, write } = useGenerateScripts(projectId, () => {
        setPicked(new Set());
        void Promise.all([list.reload(), tests.reload()]);
        onMade?.();
    });
    const cases = list.data?.cases ?? [];
    const reqRef = useMemo(() => new Map((reqs.data?.requirements ?? []).map((r) => [r.id, r.ref])), [reqs.data]);
    const testIds = useMemo(() => new Set((tests.data ?? []).map((t) => t.id)), [tests.data]);
    /** Why a case cannot be chosen, or null. One script per case: a linked test that still exists is its script. */
    const why = (c: ManualCase): string | null => (c.automation === "manual" ? "Manual: a person does it" : c.linkedTestIds.some((t) => testIds.has(t)) ? "Has its script" : null);
    const open = cases.filter((c) => !why(c));
    const allChosen = open.length > 0 && open.every((c) => picked.has(c.id));
    const busy = state.step === "checking" || state.step === "writing";
    const toggle = (id: string, on: boolean) => setPicked((s) => (on ? new Set([...s, id]) : new Set([...s].filter((x) => x !== id))));

    async function start() {
        const r = await check([...picked]);
        if (r && r.eligible.length > 0) await write(r.eligible);
    }

    const loading = (list.loading && !list.data) || (tests.loading && !tests.data);
    return (
        <Modal
            title="Generate test scripts from test cases"
            titleId="gen-cases-title"
            wide
            onClose={onClose}
            foot={
                <>
                    <Button type="button" onClick={onClose} disabled={state.step === "writing"}>
                        {state.step === "done" ? "Close" : "Cancel"}
                    </Button>
                    {state.step !== "done" && (
                        <Button variant="primary" icon={Sparkles} loading={busy} disabled={!!block || picked.size === 0 || busy} tip={block ?? (picked.size === 0 ? "Choose at least one test case." : undefined)} onClick={() => void start()}>
                            {picked.size > 0 ? `Generate ${plural(picked.size, "test script")}` : "Generate test scripts"}
                        </Button>
                    )}
                </>
            }
        >
            <div className="stack-sm" data-testid="generate-from-cases">
                <p className="t-secondary">
                    Choose the test cases. The AI writes one test script for each Automated test case that has none yet, linked to the test case and its requirement. The scripts are drafts: they run once they are approved. Uses the AI model.
                </p>
                {form === "phone" && !block && <p className="t-meta">This project tests an Android app, so the AI writes phone test scripts. {ON_DEVICE}</p>}
                {block && (
                    <Callout tone="info" title="Test scripts cannot be generated here">
                        <span data-testid="generate-from-cases-why">{block === NO_AI_TIP ? `${NO_AI} A project admin can set one up in Settings, AI configuration. You can still write test scripts by hand.` : block}</span>
                    </Callout>
                )}
                {error && <Callout tone="danger" title="No test scripts were made">{error}</Callout>}
                {list.error ? (
                    <ErrorState error={friendlyError(list.error.message)} onRetry={() => void list.reload()} />
                ) : loading ? (
                    <ListSkeleton rows={3} />
                ) : cases.length === 0 ? (
                    <EmptyState icon={ClipboardList} title="No test cases yet" actions={<LinkButton href={routes.cases(projectId)}>Open Test cases</LinkButton>}>
                        Test scripts are made from written test cases. Write them on Test cases, or have the AI write them from your requirements.
                    </EmptyState>
                ) : (
                    <div className="tc-table-wrap gen-pick" role="region" aria-label="Test cases to make scripts from" tabIndex={0}>
                        <table className="tc-table">
                            <thead>
                                <tr>
                                    <th scope="col" className="tc-check">
                                        <input type="checkbox" aria-label="Choose every test case that can get a script" checked={allChosen} disabled={open.length === 0 || busy} onChange={(e) => setPicked(e.target.checked ? new Set(open.map((c) => c.id)) : new Set())} />
                                    </th>
                                    <th scope="col">ID</th>
                                    <th scope="col">Test case</th>
                                    <th scope="col">Requirement</th>
                                    <th scope="col">Type</th>
                                    <th scope="col">Script</th>
                                </tr>
                            </thead>
                            <tbody>
                                {cases.map((c) => {
                                    const no = why(c);
                                    const ref = c.requirementId ? reqRef.get(c.requirementId) : undefined;
                                    return (
                                        <tr key={c.id} data-testid="gen-case-row">
                                            <td className="tc-check">
                                                <input type="checkbox" aria-label={`Choose ${c.ref}`} checked={picked.has(c.id)} disabled={!!no || busy} onChange={(e) => toggle(c.id, e.target.checked)} />
                                            </td>
                                            <td className="mono tc-ref">{c.ref}</td>
                                            <td className="tc-title">{c.title}</td>
                                            <td>{ref ? <span className="mono">{ref}</span> : c.requirement ? <span className="t-secondary">{c.requirement}</span> : <span className="t-meta">None</span>}</td>
                                            <td>
                                                <Badge tone={c.automation === "automated" ? "brand" : "neutral"} tip={AUTOMATION_HINT[c.automation]}>
                                                    {AUTOMATION_WORDS[c.automation]}
                                                </Badge>
                                            </td>
                                            <td>{no ? <span className="t-meta">{no}</span> : <Badge tone="neutral">No script yet</Badge>}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {cases.length > 0 && state.step !== "done" && (
                    <p className="t-meta" role="status">
                        {picked.size > 0 ? `${plural(picked.size, "test case")} chosen.` : open.length > 0 ? `${plural(open.length, "test case")} can get a script.` : "Every Automated test case has its script already."}
                    </p>
                )}
                {state.step === "confirm" && state.eligible.length === 0 && (
                    <Callout tone="info" title="Nothing to generate">
                        {skipLine(state.manual, state.scripted) || "There are no test cases to make scripts from yet."} Only Automated test cases without a script get one.
                    </Callout>
                )}
                {state.step === "writing" && <Writing state={state} />}
                {state.step === "done" && <Outcome state={state} form={form} projectId={projectId} inList />}
            </div>
        </Modal>
    );
}

/** "2 Manual test cases are skipped, 1 already has its script." */
function skipLine(manual: number, scripted: number): string {
    const parts = [manual ? `${plural(manual, "Manual test case")} ${manual === 1 ? "is" : "are"} skipped` : "", scripted ? `${plural(scripted, "test case")} already ${scripted === 1 ? "has its" : "have their"} script` : ""].filter(Boolean);
    return parts.length ? `${parts.join(", ")}.` : "";
}
