import { ChevronRight, Cable } from "lucide-react";
import { useState } from "react";
import type { Job } from "../../api";
import { PageHeader } from "../../components/ui";
import { isActive } from "../../lib/labels";
import { AddRunner } from "./AddRunner";
import { AgentsList } from "./AgentsList";
import { AccessPanel, RemoveAccessDialog, type AccessTarget } from "./RemoveAccess";
import { RunnerChoicePanel } from "./RunnerChoicePanel";
import { TokensPanel } from "./TokensPanel";
import { usePolled, type Agent, type AgentToken } from "./agents";
import { RunnerAccessPanel } from "../runners/RunnerAccessPanel";
import "./agents.css";

/**
 * A project's runners, on the Runners page (round 37: no longer inside the project's Settings): the runners that are connected first, a guided "Add a runner" (choose the computer, download, start it),
 * where tests run, and, tucked away, the older way of starting a runner from the project folder.
 * `embedded`: the page around it owns the title.
 */
export function ProjectRunners({ id, embedded = false }: { id: string; embedded?: boolean }) {
    // Polled with the agents, so a run that starts elsewhere locks the form within a few seconds.
    const jobs = usePolled<Job[]>(`/projects/${id}/jobs`);
    const agents = usePolled<Agent[]>(`/projects/${id}/agents`);
    const tokens = usePolled<AgentToken[]>(`/projects/${id}/agent-tokens`);
    const info = usePolled<{ maxRunners?: number; activeRunners?: number }>(`/projects/${id}/runner-kits/info`);
    const running = !!jobs.data?.some((j) => isActive(j.status));
    // One runner per project (server default; AGENT_MAX_TOKENS can raise it). Count the active tokens here, falling back to the info answer.
    const maxRunners = info.data?.maxRunners ?? 1;
    const activeRunners = tokens.data ? tokens.data.filter((t) => !t.revokedAt && !t.shared).length : (info.data?.activeRunners ?? 0);
    const atLimit = activeRunners >= maxRunners;
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState<AccessTarget | null>(null);
    // The advanced token list is fetched by its own panel; a new key makes it read again after the guided path changed something.
    const [tick, setTick] = useState(0);
    const [advanced, setAdvanced] = useState(false);
    const changed = () => {
        void agents.reload();
        void tokens.reload();
        setTick((n) => n + 1);
    };

    return (
        <>
            {embedded ? <p className="t-secondary">Runners run your tests on another computer. Most people do not need one.</p> : <PageHeader title="Runners" subtitle="Runners run your tests on another computer. Most people do not need one." />}
            <div className="stack">
                <AgentsList projectId={id} agents={agents} addOpen={adding} atLimit={atLimit} maxRunners={maxRunners} onAdd={() => setAdding(true)} onRemove={setRemoving} />
                {adding && <AddRunner projectId={id} agents={agents.data ?? []} onClose={() => setAdding(false)} onChanged={changed} />}
                <RunnerAccessPanel projectId={id} onChanged={changed} />
                <AccessPanel projectId={id} agents={agents.data ?? []} tokens={tokens} onChanged={changed} />
                <RunnerChoicePanel projectId={id} agents={agents.data ?? []} jobRunning={running} />
                <details className="card ag-add" open={advanced} onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
                    <summary className="ag-add-sum">
                        <ChevronRight size={16} className="chev" aria-hidden />
                        <Cable size={18} aria-hidden />
                        <span className="t-section">Advanced: start a runner from the project folder</span>
                    </summary>
                    <div className="ag-add-body stack">
                        <section aria-labelledby="ag-what-title">
                            <h2 className="t-card" id="ag-what-title">What a runner is</h2>
                            <p className="t-secondary">
                                A runner is a small program you start on your own computer (or a Mac, or a server inside your network). It lets us run your tests where your app and your devices are. The runner connects out to this platform, so you do not open any ports.
                            </p>
                            <p className="t-secondary">Use this if you have the project folder on that computer. Most people use Add a runner above instead.</p>
                            <ol className="ag-steps">
                                <li>
                                    <b>Create a token.</b> It identifies the runner to this project.
                                </li>
                                <li>
                                    <b>Run the command</b> on the machine, with the token.
                                </li>
                                <li>
                                    <b>Choose where tests run.</b> Pick the runner above.
                                </li>
                            </ol>
                        </section>
                        <TokensPanel key={tick} projectId={id} maxRunners={maxRunners} onChanged={changed} />
                    </div>
                </details>
            </div>
            {removing && (
                <RemoveAccessDialog
                    projectId={id}
                    target={removing}
                    onClose={() => setRemoving(null)}
                    onDone={() => {
                        setRemoving(null);
                        changed();
                    }}
                />
            )}
        </>
    );
}
