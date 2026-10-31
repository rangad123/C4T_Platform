import { PencilLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type Job, type TestSummary } from "../../api";
import { JobProgress } from "../../components/JobProgress";
import { Button, Callout, LinkButton } from "../../components/ui";
import { useConfig, useFetch } from "../../lib/hooks";
import { cleanReason, describeApiError, isActive } from "../../lib/labels";
import { routes } from "../../lib/router";
import type { Environment } from "../environments/environments";
import { EXAMPLES, MAX_LENGTH, MIN_LENGTH, rewritePlainTest, startPlainTest } from "./authoring";
import "./authoring.css";

interface Props {
    projectId: string;
    /** Set when an existing plain-English test is being rebuilt from a changed description. */
    rewrite?: { testId: string; description: string };
    /** Another job of the project is running: only one at a time. */
    busy?: boolean;
    onClose: () => void;
    /** Called when the job has been queued, so the page starts following it. */
    onStarted?: () => void;
    /** Called once the job has ended, so the page can refresh its lists. */
    onDone?: () => void;
}

/**
 * "Write a test": one text box, a button, live progress, then a link to the test. A real modal dialog, so the keyboard stays inside
 * it and Escape closes it. The work goes on in the background if it is closed; the finished test shows up in the list.
 */
export function WriteTestDialog({ projectId, rewrite, busy, onClose, onStarted, onDone }: Props) {
    const ref = useRef<HTMLDialogElement>(null);
    const area = useRef<HTMLTextAreaElement>(null);
    const config = useConfig();
    const environments = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const [text, setText] = useState(rewrite?.description ?? "");
    const [environment, setEnvironment] = useState("");
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState("");
    const [jobId, setJobId] = useState<string | null>(null);
    const [job, setJob] = useState<Job | null>(null);
    const [built, setBuilt] = useState<TestSummary[] | null>(null);

    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        area.current?.focus();
    }, []);

    // Follow the job until it ends, then look up the test it made.
    useEffect(() => {
        if (!jobId) return;
        let stop = false;
        let timer: number | undefined;
        const tick = async () => {
            try {
                const j = await api<Job>(`/test-generation/${jobId}`);
                if (stop) return;
                setJob(j);
                if (isActive(j.status)) {
                    timer = window.setTimeout(() => void tick(), 1200);
                    return;
                }
                const made = rewrite ? [] : await api<TestSummary[]>(`/projects/${projectId}/tests?jobId=${jobId}`).catch(() => []);
                if (stop) return;
                setBuilt(made);
                onDone?.();
            } catch {
                if (!stop) timer = window.setTimeout(() => void tick(), 2500);
            }
        };
        void tick();
        return () => {
            stop = true;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobId]);

    const trimmed = text.trim();
    const modelMissing = config !== undefined && !config.llm.configured;
    const canSubmit = trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH && !starting && !busy && !modelMissing;
    const buildable = (environments.data?.environments ?? []).filter((e) => !e.production);

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (!canSubmit) return;
        setStarting(true);
        setError("");
        try {
            const body = { description: trimmed, ...(environment ? { environment } : {}) };
            const res = rewrite ? await rewritePlainTest(rewrite.testId, body) : await startPlainTest(projectId, body);
            setJob(null);
            setBuilt(null);
            setJobId(res.jobId);
            onStarted?.();
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setStarting(false);
        }
    }

    function again() {
        setJobId(null);
        setJob(null);
        setBuilt(null);
        setText("");
        setError("");
        window.setTimeout(() => area.current?.focus(), 0);
    }

    const finished = job && !isActive(job.status) && built !== null;
    const test = built?.[0];
    const title = rewrite ? "Change the description" : "Write a test";

    return (
        <dialog ref={ref} className="write-test" aria-labelledby="write-test-title" onClose={onClose}>
            <div className="inner">
                <div className="row">
                    <PencilLine size={18} aria-hidden />
                    <h2 className="t-section" id="write-test-title">{title}</h2>
                </div>

                {!jobId && (
                    <form className="stack-sm" onSubmit={submit}>
                        <p className="t-secondary">
                            {rewrite
                                ? "Change the words and we’ll build the same test again, keep its history, and run it."
                                : "Describe what the test should do, in your own words. We open the application in a real browser, do it step by step, keep the steps that work, and run the finished test."}
                        </p>
                        <p className="t-meta" data-testid="ai-note">
                            Uses the AI model. It decides each step from what it sees on the page, then saves the test and runs it. You can edit or delete the test afterwards.
                        </p>
                        {modelMissing && (
                            <Callout tone="warning" title="The AI model isn’t set up yet" actions={<LinkButton size="sm" href={routes.settings}>Open settings</LinkButton>}>
                                Writing a test from a sentence needs access to an AI model. Add your API key in the server settings, then come back.
                            </Callout>
                        )}
                        {busy && !modelMissing && <Callout tone="info" title="Another job is running for this project">You can write a test when it has finished.</Callout>}
                        <div className="field">
                            <label htmlFor="plain-description">Describe what the test should do</label>
                            <textarea
                                id="plain-description"
                                ref={area}
                                className="input"
                                value={text}
                                maxLength={MAX_LENGTH}
                                placeholder={EXAMPLES.join("\n")}
                                aria-describedby="plain-help plain-count"
                                aria-invalid={error ? true : undefined}
                                onChange={(e) => setText(e.target.value)}
                            />
                            <div className="row">
                                <span id="plain-help" className="t-meta" style={{ flex: 1 }}>Say what to check at the end, for example “check that the total shows $20”. We never enter payment details.</span>
                                <span id="plain-count" className="t-meta counter">{text.length} of {MAX_LENGTH}</span>
                            </div>
                        </div>
                        {!rewrite && !text && (
                            <div className="examples">
                                <span className="t-meta" id="plain-examples">Or start from an example</span>
                                <div className="chips" role="group" aria-labelledby="plain-examples">
                                    {EXAMPLES.map((ex) => (
                                        <button type="button" className="chip" key={ex} onClick={() => { setText(ex); area.current?.focus(); }}>{ex}</button>
                                    ))}
                                </div>
                            </div>
                        )}
                        {buildable.length > 0 && (
                            <div className="field">
                                <label htmlFor="plain-environment">Build it on</label>
                                <select id="plain-environment" className="input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                                    <option value="">The project’s address</option>
                                    {buildable.map((e) => (
                                        <option key={e.id} value={e.name}>{e.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {error && <Callout tone="danger" title="We couldn’t start the test">{error}</Callout>}
                        <div className="foot">
                            <Button type="button" variant="ghost" onClick={() => ref.current?.close()}>Cancel</Button>
                            <Button type="submit" variant="primary" loading={starting} disabled={!canSubmit}>{rewrite ? "Rebuild and run test" : "Create and run test"}</Button>
                        </div>
                    </form>
                )}

                {jobId && !finished && (
                    <div className="stack-sm">
                        {job ? <JobProgress job={job} onChanged={() => undefined} /> : <p className="t-secondary" role="status">Starting…</p>}
                        <p className="t-meta">You can close this window. The test appears in the list when it’s ready.</p>
                        <div className="foot"><Button type="button" variant="ghost" onClick={() => ref.current?.close()}>Close</Button></div>
                    </div>
                )}

                {finished && job && (
                    <div className="stack-sm" aria-live="polite">
                        <Outcome job={job} test={test} rewrite={rewrite?.testId} />
                        <div className="foot">
                            {!rewrite && <Button type="button" onClick={again}>Write another test</Button>}
                            <Button type="button" variant={test || rewrite ? "ghost" : "primary"} onClick={() => ref.current?.close()}>Close</Button>
                        </div>
                    </div>
                )}
            </div>
        </dialog>
    );
}

/** What came of the job, in plain words, with the way to the test. */
export function Outcome({ job, test, rewrite }: { job: Pick<Job, "status" | "error">; test?: TestSummary; rewrite?: string }) {
    const href = rewrite ? routes.test(rewrite) : test ? routes.test(test.id) : undefined;
    const open = href ? <LinkButton size="sm" href={href}>Open the test</LinkButton> : undefined;
    if (job.status === "COMPLETED") {
        return (
            <Callout tone="success" title={rewrite ? "Your test was rebuilt and passed" : "Your test is ready and it passed"} actions={open}>
                It ran in a real browser from the start, and it is saved with your description.
            </Callout>
        );
    }
    if (job.status === "PARTIALLY_COMPLETED") {
        const why = test?.validationReason ? cleanReason(test.validationReason) : job.error;
        return (
            <Callout tone="warning" title="We kept your test, but it needs a look" actions={open}>
                {why || "It didn’t pass cleanly. Open it to see what happened."}
            </Callout>
        );
    }
    if (job.error === "Cancelled") return <Callout tone="neutral" title="Cancelled">Nothing was changed. You can describe the test again at any time.</Callout>;
    return (
        <Callout tone="danger" title="We couldn’t build this test" actions={open}>
            {job.error || "Something went wrong. Try again."}
        </Callout>
    );
}
