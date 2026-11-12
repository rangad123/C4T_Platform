import { Circle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { normalizeUrl } from "../../lib/url";
import { viewerIsRemote } from "../../lib/viewer";
import type { RunnerChoice } from "../runners/runners";
import { reloadMyRunner, useReadiness } from "../runners/my-runner";
import { RunnerNotReady } from "../runs/RunnerNotReady";
import type { Environment } from "../environments/environments";
import { activeSessionId, rememberSession, rememberedSession, type Recording } from "./recorder";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";

/** The first screen: where to start, where the window opens, and a warning about typing real data. */
export function StartForm({ projectId, initialUrl, onStarted, onResume }: { projectId: string; initialUrl?: string; onStarted: (r: Recording) => void; onResume: (rid: string) => void }) {
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const envs = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const environments = envs.data?.environments ?? [];

    const [url, setUrl] = useState(initialUrl ?? "");
    const [touched, setTouched] = useState(!!initialUrl);
    const [environment, setEnvironment] = useState("");
    const [confirmProduction, setConfirmProduction] = useState(false);
    const [urlError, setUrlError] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<{ tone: "warning" | "danger"; title?: string; text: string; link?: string } | null>(null);
    const [active, setActive] = useState<{ id?: string; text: string } | null>(null);

    // Prefill with the project's own address, unless the person already typed or came back with one.
    const known = project.data?.application?.url;
    useEffect(() => {
        if (known && !touched) setUrl(known);
    }, [known, touched]);

    const chosen = environments.find((e) => e.name === environment);

    // Runners mode: always the person's own runner (the server picks it). Local mode: where the project runs its tests.
    const ready = useReadiness({ can: ["recordHeaded"] });
    const runnersOnly = ready.mode === "runners";
    const projectRunner = useFetch<RunnerChoice>(runnersOnly ? null : `/projects/${projectId}/runner`);
    const onRunner = runnersOnly || projectRunner.data?.runOn === "agent";
    const blocked = runnersOnly && (ready.loading || !ready.ready);

    async function start(e: React.FormEvent) {
        e.preventDefault();
        setProblem(null);
        setActive(null);
        const typed = url.trim();
        let address: string | undefined;
        // An environment supplies the address unless the person typed a different page of it.
        if (chosen && (!typed || !touched)) address = chosen.baseUrl;
        else {
            const n = normalizeUrl(url);
            if (!n.url) return setUrlError(n.error!);
            address = n.url;
        }
        setUrlError("");
        if (chosen?.production && !confirmProduction) return setProblem({ tone: "warning", title: "Confirm before recording on a live site", text: "Tick the box under the environment to say you know what you click is really done there." });
        setBusy(true);
        try {
            const rec = await api<Recording>(`/projects/${projectId}/recordings`, { method: "POST", body: { url: address, headed: true, ...(environment ? { environment, ...(chosen?.production ? { confirmProduction: true } : {}) } : {}) } });
            rememberSession(projectId, rec.id);
            onStarted(rec);
        } catch (err) {
            const details = err instanceof ApiError ? (err.body?.details as { code?: unknown; link?: unknown } | undefined) : undefined;
            if (err instanceof ApiError && err.status === 409 && typeof details?.code === "string" && details.code.startsWith("RUNNER_")) {
                // The person's runner is not set up, is offline, or may not record this: the server's sentence, with a link to Settings.
                setProblem({ tone: "warning", text: err.message, link: typeof details.link === "string" && details.link.startsWith("#/") ? details.link : routes.yourRunner });
                void reloadMyRunner();
            } else if (err instanceof ApiError && err.status === 409) {
                const id = activeSessionId(err) ?? rememberedSession(projectId);
                setActive({ id, text: id ? err.message : `${err.message} It was not started from this browser tab, so we can’t open it from here. Stop it on ${onRunner ? "your runner’s computer" : "the computer that runs the platform"}, then start again.` });
            } else if (err instanceof ApiError && err.status === 422) {
                setProblem({ tone: "warning", title: "We can’t open the browser window", text: err.message });
            } else {
                setProblem({ tone: "danger", text: describeApiError(err) });
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack rec-start" onSubmit={start} noValidate aria-label="Start recording">
            <div className="stack-sm">
                <h2 className="t-section">Record by clicking through your application</h2>
                <p className="t-secondary">
                    {onRunner ? "We open a browser window on your runner’s computer." : "We open a browser window on the computer that runs this platform."} Click through your application as a user would. We write down each step.
                </p>
            </div>

            {active && (
                <Callout
                    tone="warning"
                    title="A recording is already running for this project"
                    actions={
                        active.id ? (
                            <Button size="sm" onClick={() => onResume(active.id!)}>
                                Resume watching
                            </Button>
                        ) : undefined
                    }
                >
                    {active.text}
                </Callout>
            )}
            {problem && (
                <Callout tone={problem.tone} title={problem.title} actions={problem.link ? <a href={problem.link}>Open Your runner in Settings</a> : undefined}>
                    {problem.text}
                </Callout>
            )}

            {runnersOnly && !problem && <RunnerNotReady reason={ready.reason} testId="rec-runner-problem" />}
            {runnersOnly && ready.ready && ready.runner && (
                <p className="t-secondary" data-testid="rec-on-hint">
                    The window opens on your runner, {ready.runner.name}, not on this computer.
                </p>
            )}

            {!onRunner && !projectRunner.loading && viewerIsRemote() && (
                <Callout
                    tone="warning"
                    title="This opens the browser on the platform’s computer, not on yours"
                    actions={
                        <Button type="button" size="sm" onClick={() => (location.hash = routes.yourRunner)}>
                            Set up your runner
                        </Button>
                    }
                >
                    You are using the platform from another computer. A recording window would appear on the computer that runs the platform, where you cannot click in it.
                </Callout>
            )}

            <div className="field">
                <label htmlFor="rec-url">Address to start from</label>
                <input
                    id="rec-url"
                    className="input"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="https://your-app.example.com"
                    value={url}
                    aria-describedby={urlError ? "rec-url-error" : "rec-url-hint"}
                    aria-invalid={!!urlError}
                    onChange={(e) => {
                        setUrl(e.target.value);
                        setTouched(true);
                        if (urlError) setUrlError("");
                    }}
                />
                {urlError ? (
                    <p className="error-text" id="rec-url-error">
                        {urlError}
                    </p>
                ) : (
                    <p className="hint" id="rec-url-hint">
                        {onRunner ? "We open this address from your runner’s computer, so it can be a private address." : "The page the browser opens first."}
                    </p>
                )}
            </div>

            {environments.length > 0 && (
                <div className="field">
                    <label htmlFor="rec-env">Environment (optional)</label>
                    <select id="rec-env" className="input" value={environment} onChange={(e) => { setEnvironment(e.target.value); setConfirmProduction(false); }}>
                        <option value="">None, use the address above</option>
                        {environments.map((e) => (
                            <option key={e.id} value={e.name}>
                                {e.name}
                                {e.production ? " (production)" : ""}
                            </option>
                        ))}
                    </select>
                    <p className="hint">The environment’s address is used unless you type a page of it above. Its sign-in details are not used while recording.</p>
                </div>
            )}

            {chosen?.production && (
                <label className="check rec-check">
                    <input type="checkbox" checked={confirmProduction} onChange={(e) => setConfirmProduction(e.target.checked)} />
                    <span>
                        <span className="title">This is a live site</span>
                        <span className="hint">I understand that what I click while recording is really done there.</span>
                    </span>
                </label>
            )}

            <p className="rec-warn">
                <TriangleAlert size={16} aria-hidden />
                <span>Don’t type real personal data or secrets while recording. Password fields are never recorded.</span>
            </p>

            <div>
                <Button type="submit" variant="primary" icon={Circle} loading={busy} disabled={blocked}>
                    Start recording
                </Button>
            </div>
        </form>
    );
}
