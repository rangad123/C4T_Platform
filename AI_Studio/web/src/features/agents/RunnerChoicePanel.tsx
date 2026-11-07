import { Check, Server, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { useExecutionMode, useRunnerChoices } from "../runs/runs-here";
import { usePolled, type Agent, type RunnerChoice } from "./agents";
import "./agents.css";

/** The project switch "Allow people's own computers", in the words the person reads before changing it. */
export const ALLOW_PERSONAL_LABEL = "Allow people’s own computers";
export const ALLOW_PERSONAL_HINT =
    "People who may run tests in this project can run their own runs on their own computer. For those runs, this project’s test accounts (passwords, one-time code secrets, API tokens and saved sign-ins) are sent to that computer. Turn it off to run this project’s tests on team runners only.";

/**
 * "Where this project's tests run". On a platform that runs tests itself (local mode): on this server, or on one of the connected
 * runners. On the hosted platform (runners mode) every run goes to a runner, so it offers only the default runner. Both have the
 * project switch "Allow people's own computers". Only someone who may change the project's settings can save.
 */
export function RunnerChoicePanel({ projectId, agents, jobRunning }: { projectId: string; agents: Agent[]; jobRunning: boolean }) {
    const runner = usePolled<RunnerChoice>(`/projects/${projectId}/runner`);
    const mode = useExecutionMode();
    const runnersOnly = mode === "runners";
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    // The switch's state: the runner answer when the server puts it there, else the runner choices (contract: `allowPersonal`).
    const choices = useRunnerChoices(projectId, true, 0);
    const cur = runner.data as (RunnerChoice & { allowPersonal?: boolean }) | undefined;
    const serverAllow: boolean | undefined = cur?.allowPersonal ?? choices.data?.allowPersonal;
    const perms = project.data?.access?.permissions;
    const canChange = !perms || perms.includes("ai_studio.project.settings");
    const [runOn, setRunOn] = useState<"platform" | "agent">("platform");
    const [agentId, setAgentId] = useState("");
    const [allow, setAllow] = useState(true);
    const [dirty, setDirty] = useState(false);
    const [allowDirty, setAllowDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    // Follow the platform's answer until the person starts changing the form.
    useEffect(() => {
        if (!cur || dirty) return;
        setRunOn(runnersOnly ? "agent" : cur.runOn);
        setAgentId(cur.agentId ?? "");
    }, [cur, dirty, runnersOnly]);
    useEffect(() => {
        if (serverAllow !== undefined && !allowDirty) setAllow(serverAllow);
    }, [serverAllow, allowDirty]);

    // Online agents first; the first online one is the natural default for "On a runner" (local mode). Runners mode starts from "any".
    const sorted = [...agents].sort((a, b) => Number(b.online) - Number(a.online));
    const firstOnline = sorted.find((a) => a.online);
    const chosen = runnersOnly ? agentId : agentId || firstOnline?.id || "";
    const canSave = !!cur && canChange && !jobRunning && !busy && (dirty || allowDirty);
    const touched = () => {
        setDirty(true);
        setSaved(false);
    };

    async function save() {
        setBusy(true);
        setError("");
        setSaved(false);
        try {
            const where = runOn === "agent" || runnersOnly ? { runOn: "agent" as const, agentId: chosen || null } : { runOn: "platform" as const };
            const body = { ...(dirty ? where : {}), ...(allowDirty ? { allowPersonal: allow } : {}) };
            const next = await api<RunnerChoice & { allowPersonal?: boolean }>(`/projects/${projectId}/runner`, { method: "PUT", body });
            setDirty(false);
            setAllowDirty(false);
            setRunOn(runnersOnly ? "agent" : next.runOn);
            setAgentId(next.agentId ?? "");
            if (next.allowPersonal !== undefined) setAllow(next.allowPersonal);
            setSaved(true);
            await Promise.all([runner.reload(), choices.reload()]);
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    const showsAgent = runOn === "agent" || runnersOnly;

    return (
        <section className="card" aria-labelledby="ag-where-title">
            <div className="card-head wrap">
                <Server size={18} aria-hidden />
                <h2 className="t-section" id="ag-where-title">Where this project’s tests run</h2>
            </div>
            {runner.loading ? (
                <div className="ag-body">
                    <Skeleton w="50%" />
                    <Skeleton h={64} />
                    <Skeleton h={64} />
                </div>
            ) : runner.error || !cur ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(runner.error?.message)} onRetry={runner.reload} />
                </div>
            ) : (
                <form
                    className="ag-body"
                    aria-label="Where tests run"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    <p className="ag-status" role="status" data-testid="runner-status">
                        {cur.status}
                    </p>
                    {(cur.runOn === "agent" || runnersOnly) && (
                        <div className="row">
                            <Badge tone={cur.canRunWeb ? "success" : "warning"} icon={cur.canRunWeb ? Check : X}>
                                Web and API tests {cur.canRunWeb ? "can run" : "cannot run"}
                            </Badge>
                            <Badge tone={(cur.phones?.canRun ?? cur.canRunMobile) ? "success" : "neutral"} icon={(cur.phones?.canRun ?? cur.canRunMobile) ? Check : X}>
                                Phone tests {(cur.phones?.canRun ?? cur.canRunMobile) ? "can run" : "cannot run"}
                            </Badge>
                        </div>
                    )}
                    {(cur.runOn === "agent" || runnersOnly) && cur.phones && (
                        <p className="t-secondary" data-testid="runner-phones">
                            {cur.phones.text}
                        </p>
                    )}
                    {cur.unavailableReason && <Callout tone="warning">{cur.unavailableReason}</Callout>}
                    {jobRunning && <Callout tone="info">A run is in progress for this project. You can change where tests run when it finishes.</Callout>}
                    {!canChange && <p className="t-secondary" data-testid="runner-readonly">Only someone who may change this project’s settings can change this.</p>}

                    {runnersOnly ? (
                        <p className="t-secondary" data-testid="runners-only">
                            Tests run on runners only: team runners given to this project, and people’s own computers when allowed below. Anyone starting a run can choose another runner for that run.
                        </p>
                    ) : (
                        <fieldset className="ag-choices" disabled={jobRunning || !canChange}>
                            <legend className="sr-only">Run this project’s tests</legend>
                            <label className="check">
                                <input type="radio" name="ag-runon" value="platform" checked={runOn === "platform"} onChange={() => { setRunOn("platform"); touched(); }} />
                                <span>
                                    <span className="title">On this server</span>
                                    <span className="hint">Tests run on the computer that hosts this platform.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="radio" name="ag-runon" value="agent" checked={runOn === "agent"} onChange={() => { setRunOn("agent"); touched(); }} />
                                <span>
                                    <span className="title">On a runner</span>
                                    <span className="hint">Tests run on a computer you control, so they can reach your local app and your phones.</span>
                                </span>
                            </label>
                        </fieldset>
                    )}

                    {showsAgent && (
                        <div className="field">
                            <label htmlFor="ag-pick">{runnersOnly ? "Default runner" : "Runner"}</label>
                            <select id="ag-pick" className="input" value={chosen} disabled={jobRunning || !canChange || (!runnersOnly && sorted.length === 0)} onChange={(e) => { setAgentId(e.target.value); touched(); }}>
                                {runnersOnly && <option value="">Any runner that is online</option>}
                                {!runnersOnly && sorted.length === 0 && <option value="">No runners yet</option>}
                                {sorted.map((a) => (
                                    <option key={a.id} value={a.id} disabled={!a.online}>
                                        {a.online ? a.name : `${a.name} (offline, last seen ${relativeTime(a.lastSeenAt)})`}
                                    </option>
                                ))}
                            </select>
                            {runnersOnly ? (
                                <span className="hint">With a default runner, runs go to it unless the person starting a run chooses another. Without one, a run goes to any runner that may take it.</span>
                            ) : (
                                !firstOnline && <span className="hint">No runner is online right now. Start one, or keep running on this server.</span>
                            )}
                        </div>
                    )}

                    {serverAllow !== undefined && (
                        <label className="check" data-testid="allow-personal">
                            <input
                                type="checkbox"
                                checked={allow}
                                disabled={jobRunning || !canChange}
                                onChange={(e) => {
                                    setAllow(e.target.checked);
                                    setAllowDirty(e.target.checked !== serverAllow);
                                    setSaved(false);
                                }}
                            />
                            <span>
                                <span className="title">{ALLOW_PERSONAL_LABEL}</span>
                                <span className="hint">{ALLOW_PERSONAL_HINT}</span>
                            </span>
                        </label>
                    )}

                    {error && <Callout tone="danger">{error}</Callout>}
                    {saved && !error && <p className="t-secondary" role="status">Saved.</p>}
                    {canChange && (
                        <div className="row">
                            <Button type="submit" variant="primary" loading={busy} disabled={!canSave}>
                                Save
                            </Button>
                            {(dirty || allowDirty) && !jobRunning && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => {
                                        setDirty(false);
                                        setAllowDirty(false);
                                        if (serverAllow !== undefined) setAllow(serverAllow);
                                        setError("");
                                    }}
                                >
                                    Discard changes
                                </Button>
                            )}
                        </div>
                    )}
                </form>
            )}
        </section>
    );
}
