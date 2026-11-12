import { Bot } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Disclosure } from "../../components/ui";
import type { AgentRun, AgentRunList } from "./agent-runs";
import { describeApiError } from "../../lib/labels";
import { RunStartError } from "../runners/RunnerRefusal";
import { isRunnerRefusal, useReadiness } from "../runners/my-runner";
import { RunnerNotReady } from "../runs/RunnerNotReady";

/** Start an agent run: the objective in plain words, where it starts, and the limits. The token limit shows only to people who may see AI usage. */
export function AgentRunForm({ projectId, list, seesUsage, onStarted }: { projectId: string; list: AgentRunList; seesUsage: boolean; onStarted: (r: AgentRun) => void }) {
    const [objective, setObjective] = useState("");
    const [criteria, setCriteria] = useState("");
    const [environment, setEnvironment] = useState("");
    const [start, setStart] = useState("");
    const [maxSteps, setMaxSteps] = useState(list.limits.steps.default);
    const [maxMinutes, setMaxMinutes] = useState(list.limits.minutes.default);
    const [budgetTokens, setBudgetTokens] = useState(list.limits.budgetTokens?.default ?? 0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [refusal, setRefusal] = useState<unknown>(null);
    // Runners mode (round 52): the run works in a browser on the person's runner, so it needs one that is set up, online and new enough.
    const ready = useReadiness({ can: ["web", "agent"] });
    const runnerWhy = ready.mode === "runners" ? ready.reason : null;
    const blocked = list.canStart.ok ? (list.agentModeOn ? (runnerWhy ?? undefined) : "Agent mode is off for this project.") : list.canStart.reason;

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (objective.trim().length < 10) return setError("Say in a few words what the agent should achieve.");
        setBusy(true);
        setError("");
        setRefusal(null);
        try {
            const run = await api<AgentRun>(`/projects/${projectId}/agent-runs`, {
                method: "POST",
                body: {
                    objective: objective.trim(),
                    ...(criteria.trim() ? { successCriteria: criteria.trim() } : {}),
                    ...(environment ? { environment } : {}),
                    ...(start.trim() ? { startAddress: start.trim() } : {}),
                    limits: { maxSteps, maxMinutes, ...(seesUsage && list.limits.budgetTokens ? { budgetTokens } : {}) },
                },
            });
            onStarted(run);
        } catch (err) {
            if (isRunnerRefusal(err)) setRefusal(err);
            else setError(describeApiError(err));
            setBusy(false);
        }
    }

    return (
        <form className="card card-pad stack-sm" onSubmit={submit} aria-label="Start an agent run" noValidate>
            <h2 className="t-section">Start an agent run</h2>
            <div className="field">
                <label htmlFor="agent-objective">Objective</label>
                <textarea id="agent-objective" className="input" rows={3} maxLength={2000} value={objective} placeholder="A new customer can add a gift card to the cart and see the total" onChange={(e) => setObjective(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="agent-criteria">Success criteria (optional)</label>
                <textarea id="agent-criteria" className="input" rows={2} maxLength={2000} value={criteria} placeholder="One per line, for example: The cart shows one item" onChange={(e) => setCriteria(e.target.value)} />
            </div>
            <div className="agent-form-row">
                {list.environments.length > 0 && (
                    <div className="field">
                        <label htmlFor="agent-environment">Where</label>
                        <select id="agent-environment" className="input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                            <option value="">The project's address</option>
                            {list.environments.map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <div className="field">
                    <label htmlFor="agent-start">Start address (optional)</label>
                    <input id="agent-start" className="input mono" maxLength={2000} value={start} placeholder={list.address ? "/products" : "https://shop.example.com"} onChange={(e) => setStart(e.target.value)} />
                </div>
            </div>
            <Disclosure label="Limits">
                <div className="agent-form-row">
                    <div className="field">
                        <label htmlFor="agent-steps">Steps</label>
                        <input id="agent-steps" className="input" type="number" min={list.limits.steps.min} max={list.limits.steps.max} value={maxSteps} onChange={(e) => setMaxSteps(Number(e.target.value))} />
                    </div>
                    <div className="field">
                        <label htmlFor="agent-minutes">Minutes</label>
                        <input id="agent-minutes" className="input" type="number" min={list.limits.minutes.min} max={list.limits.minutes.max} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
                    </div>
                    {seesUsage && list.limits.budgetTokens && (
                        <div className="field">
                            <label htmlFor="agent-tokens">Tokens</label>
                            <input id="agent-tokens" className="input" type="number" min={list.limits.budgetTokens.min} max={list.limits.budgetTokens.max} value={budgetTokens} onChange={(e) => setBudgetTokens(Number(e.target.value))} />
                        </div>
                    )}
                </div>
            </Disclosure>
            {list.canStart.ok && <RunnerNotReady reason={runnerWhy} testId="agent-runner-problem" />}
            {Boolean(refusal) && <RunStartError error={refusal} />}
            {error && (
                <Callout tone="danger" title="The run did not start">
                    {error}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" icon={Bot} loading={busy} disabled={Boolean(blocked)} tip={blocked ?? "The agent works in a real browser. Deleting, paying, sending and submitting forms wait for a person."}>
                    Start agent run
                </Button>
            </div>
        </form>
    );
}
