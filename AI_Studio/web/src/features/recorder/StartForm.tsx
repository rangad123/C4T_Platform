import { Circle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { normalizeUrl } from "../../lib/url";
import { viewerIsRemote } from "../../lib/viewer";
import { usePolled, type RunnerChoice } from "../agents/agents";
import type { Environment } from "../environments/environments";
import { RUNNER_SETTINGS_HREF } from "../runners/my-runner";
import { RecError, activeSessionId, agentRecordProblem, errorText, recApi, rememberSession, rememberedSession, type RecorderAgent, type Recording } from "./recorder";

/** The first screen: where to start, whether to show the window, and a warning about typing real data. */
export function StartForm({ projectId, initialUrl, onStarted, onResume }: { projectId: string; initialUrl?: string; onStarted: (r: Recording) => void; onResume: (rid: string) => void }) {
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const envs = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const environments = envs.data?.environments ?? [];

    const [url, setUrl] = useState(initialUrl ?? "");
    const [touched, setTouched] = useState(!!initialUrl);
    const [headed, setHeaded] = useState(true);
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

    // Recording on a runner agent: offered only when some agent of the project can record, so a project without one sees today's form.
    const agentsFetch = usePolled<RecorderAgent[]>(`/projects/${projectId}/agents`);
    const agents = Array.isArray(agentsFetch.data) ? agentsFetch.data : [];
    const offered = agents.some((a) => a.capabilities?.record === true);
    const runner = useFetch<RunnerChoice>(offered ? `/projects/${projectId}/runner` : null);
    const [picked, setPicked] = useState<"platform" | "agent" | null>(null); // null until the person chooses: then the project's setting decides
    const [agentPick, setAgentPick] = useState("");
    const runOn = offered ? (picked ?? (runner.data?.runOn === "agent" ? "agent" : "platform")) : "platform";
    // Selectable agents first (online ones before the rest), each with the reason when it cannot be used now.
    const listed = [...agents]
        .map((a) => ({ a, why: agentRecordProblem(a, headed) }))
        .sort((x, y) => Number(!!x.why) - Number(!!y.why) || Number(y.a.online) - Number(x.a.online));
    const usable = listed.filter((x) => !x.why).map((x) => x.a);
    const agent =
        runOn === "agent"
            ? (usable.find((a) => a.id === agentPick) ?? usable.find((a) => a.id === runner.data?.agentId) ?? usable[0])
            : undefined;
    // An agent without a display cannot show the window: the box is shown unchecked and locked, with the reason.
    const noDisplay = !!agent && agent.capabilities.recordHeaded === false;
    const headedNow = noDisplay ? false : headed;

    async function start(e: React.FormEvent) {
        e.preventDefault();
        setProblem(null);
        setActive(null);
        if (runOn === "agent" && !agent) return setProblem({ tone: "warning", title: "No runner can record right now", text: "Pick a runner that is online and can record, or choose This server." });
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
            const rec = await recApi<Recording>(`/projects/${projectId}/recordings`, { method: "POST", body: { url: address, headed: headedNow, ...(environment ? { environment, ...(chosen?.production ? { confirmProduction: true } : {}) } : {}), ...(runOn === "agent" && agent ? { on: "agent", agentId: agent.id } : {}) } });
            rememberSession(projectId, rec.id);
            onStarted(rec);
        } catch (err) {
            const details = err instanceof RecError ? (err.body?.details as { code?: unknown; link?: unknown } | undefined) : undefined;
            if (err instanceof RecError && err.status === 409 && typeof details?.code === "string" && details.code.startsWith("RUNNER_")) {
                // The person's runner is not set up, is offline, or may not record this: the server's sentence, with a link to Settings.
                setProblem({ tone: "warning", text: err.message, link: typeof details.link === "string" && details.link.startsWith("#/") ? details.link : RUNNER_SETTINGS_HREF });
            } else if (err instanceof RecError && err.status === 409) {
                const id = activeSessionId(err) ?? rememberedSession(projectId);
                setActive({ id, text: id ? err.message : `${err.message} It was not started from this browser tab, so we can’t open it from here. Stop it on the computer that runs the platform, then start again.` });
            } else if (err instanceof RecError && err.status === 422) {
                setProblem({ tone: "warning", title: "We can’t open the browser window", text: err.message });
            } else {
                setProblem({ tone: "danger", text: errorText(err) });
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
                    {agent ? "We open a browser window on the runner’s computer." : "We open a browser window on the computer that runs this platform."} Click through your application as a user would. We write down each step.
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

            {runOn === "platform" && viewerIsRemote() && (
                <Callout
                    tone="warning"
                    title="This opens the browser on the platform’s computer, not on yours"
                    actions={
                        <Button type="button" size="sm" onClick={() => (location.hash = routes.allRunners)}>
                            Set up your runner
                        </Button>
                    }
                >
                    You are using the platform from another computer. A recording window would appear on the computer that runs the platform, where you cannot click in it.
                    {offered ? " Choose A runner under Record on, to record on a computer that has one." : " To record on your own computer, set up your runner in Settings, then come back and choose it here."}
                </Callout>
            )}

            {offered && !runner.loading && (
                <div className="field rec-on" role="radiogroup" aria-labelledby="rec-on-label" aria-describedby="rec-on-hint">
                    <span className="label" id="rec-on-label">
                        Record on
                    </span>
                    <label className="check rec-check">
                        <input type="radio" name="rec-on" value="platform" checked={runOn === "platform"} onChange={() => setPicked("platform")} />
                        <span>
                            <span className="title">This server</span>
                        </span>
                    </label>
                    <label className="check rec-check">
                        <input type="radio" name="rec-on" value="agent" checked={runOn === "agent"} onChange={() => setPicked("agent")} />
                        <span>
                            <span className="title">A runner</span>
                        </span>
                    </label>
                    {runOn === "agent" && (
                        <div className="field">
                            <label htmlFor="rec-agent">Runner</label>
                            <select id="rec-agent" className="input" value={agent?.id ?? ""} onChange={(e) => setAgentPick(e.target.value)}>
                                {!agent && <option value="">No runner can record right now</option>}
                                {listed.map(({ a, why }) => (
                                    <option key={a.id} value={a.id} disabled={!!why}>
                                        {why ? `${a.name} (${why})` : a.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    <p className="hint" id="rec-on-hint" data-testid="rec-on-hint">
                        {agent
                            ? headedNow
                                ? `The browser window opens on ${agent.name}, not on this computer.`
                                : `The browser runs on ${agent.name} without showing a window.`
                            : runOn === "agent"
                              ? "Start a runner that can record, or choose This server."
                              : headedNow
                                ? "The browser window opens on the computer that runs this platform."
                                : "The browser runs on this server without showing a window."}
                    </p>
                </div>
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
                        {agent ? "We open this address from the runner’s computer, so it can be a private address." : "The page the browser opens first."}
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

            <label className="check rec-check">
                <input type="checkbox" checked={headedNow} disabled={noDisplay} onChange={(e) => setHeaded(e.target.checked)} />
                <span>
                    <span className="title">Show the browser window</span>
                    <span className="hint">{noDisplay ? `${agent!.name} has no display, so it can’t show the window.` : "Turn this off only for scripted runs. You need the window to click in."}</span>
                </span>
            </label>

            <p className="rec-warn">
                <TriangleAlert size={16} aria-hidden />
                <span>Don’t type real personal data or secrets while recording. Password fields are never recorded.</span>
            </p>

            <div>
                <Button type="submit" variant="primary" icon={Circle} loading={busy}>
                    Start recording
                </Button>
            </div>
        </form>
    );
}
