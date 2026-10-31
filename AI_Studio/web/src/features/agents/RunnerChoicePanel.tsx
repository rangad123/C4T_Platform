import { Check, Server, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { describeApiError, friendlyError } from "../../lib/labels";
import { usePolled, type Agent, type RunnerChoice } from "./agents";
import "./agents.css";

/** "Where this project's tests run": on the platform server, or on one of the connected agents. */
export function RunnerChoicePanel({ projectId, agents, jobRunning }: { projectId: string; agents: Agent[]; jobRunning: boolean }) {
    const runner = usePolled<RunnerChoice>(`/projects/${projectId}/runner`);
    const cur = runner.data;
    const [runOn, setRunOn] = useState<"platform" | "agent">("platform");
    const [agentId, setAgentId] = useState("");
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    // Follow the platform's answer until the person starts changing the form.
    useEffect(() => {
        if (!cur || dirty) return;
        setRunOn(cur.runOn);
        setAgentId(cur.agentId ?? "");
    }, [cur, dirty]);

    // Online agents first; the first online one is the natural default for "On a runner".
    const sorted = [...agents].sort((a, b) => Number(b.online) - Number(a.online));
    const firstOnline = sorted.find((a) => a.online);
    const chosen = agentId || firstOnline?.id || "";
    const canSave = !!cur && !jobRunning && !busy && dirty;

    async function save() {
        setBusy(true);
        setError("");
        setSaved(false);
        try {
            const next = await api<RunnerChoice>(`/projects/${projectId}/runner`, { method: "PUT", body: runOn === "agent" ? { runOn, agentId: chosen || null } : { runOn } });
            setDirty(false);
            setRunOn(next.runOn);
            setAgentId(next.agentId ?? "");
            setSaved(true);
            await runner.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

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
                    {cur.runOn === "agent" && (
                        <div className="row">
                            <Badge tone={cur.canRunWeb ? "success" : "warning"} icon={cur.canRunWeb ? Check : X}>
                                Web and API tests {cur.canRunWeb ? "can run" : "cannot run"}
                            </Badge>
                            <Badge tone={(cur.phones?.canRun ?? cur.canRunMobile) ? "success" : "neutral"} icon={(cur.phones?.canRun ?? cur.canRunMobile) ? Check : X}>
                                Phone tests {(cur.phones?.canRun ?? cur.canRunMobile) ? "can run" : "cannot run"}
                            </Badge>
                        </div>
                    )}
                    {cur.runOn === "agent" && cur.phones && (
                        <p className="t-secondary" data-testid="runner-phones">
                            {cur.phones.text}
                        </p>
                    )}
                    {cur.unavailableReason && <Callout tone="warning">{cur.unavailableReason}</Callout>}
                    {jobRunning && <Callout tone="info">A run is in progress for this project. You can change where tests run when it finishes.</Callout>}

                    <fieldset className="ag-choices" disabled={jobRunning}>
                        <legend className="sr-only">Run this project’s tests</legend>
                        <label className="check">
                            <input type="radio" name="ag-runon" value="platform" checked={runOn === "platform"} onChange={() => { setRunOn("platform"); setDirty(true); setSaved(false); }} />
                            <span>
                                <span className="title">On this server</span>
                                <span className="hint">The default. Tests run on the computer that hosts this platform.</span>
                            </span>
                        </label>
                        <label className="check">
                            <input type="radio" name="ag-runon" value="agent" checked={runOn === "agent"} onChange={() => { setRunOn("agent"); setDirty(true); setSaved(false); }} />
                            <span>
                                <span className="title">On a runner</span>
                                <span className="hint">Tests run on a computer you control, so they can reach your local app and your phones.</span>
                            </span>
                        </label>
                    </fieldset>

                    {runOn === "agent" && (
                        <div className="field">
                            <label htmlFor="ag-pick">Runner</label>
                            <select
                                id="ag-pick"
                                className="input"
                                value={chosen}
                                disabled={jobRunning || sorted.length === 0}
                                onChange={(e) => { setAgentId(e.target.value); setDirty(true); setSaved(false); }}
                            >
                                {sorted.length === 0 && <option value="">No runners yet</option>}
                                {sorted.map((a) => (
                                    <option key={a.id} value={a.id} disabled={!a.online}>
                                        {a.online ? a.name : `${a.name} (offline, last seen ${relativeTime(a.lastSeenAt)})`}
                                    </option>
                                ))}
                            </select>
                            {!firstOnline && <span className="hint">No runner is online right now. Start one with a token, or keep running on this server.</span>}
                        </div>
                    )}

                    {error && <Callout tone="danger">{error}</Callout>}
                    {saved && !error && <p className="t-secondary" role="status">Saved.</p>}
                    <div className="row">
                        <Button type="submit" variant="primary" loading={busy} disabled={!canSave}>
                            Save
                        </Button>
                        {dirty && !jobRunning && (
                            <Button type="button" variant="ghost" onClick={() => { setDirty(false); setError(""); }}>
                                Discard changes
                            </Button>
                        )}
                    </div>
                </form>
            )}
        </section>
    );
}
