import { Plus, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { useCan } from "../auth/permissions";
import { costText, exact, limitText, parseLimit, tokensText } from "../usage/usage";
import { NOTHING_RUNS_HERE, OWNER_WORDS, SERVER_HAS_NO_KEY, type AiMode, type ProjectAi } from "./aiconfig";
import { ConfigurationForm } from "./ConfigurationForm";
import { KeyStatus } from "./KeyStatus";

function Availability({ ai }: { ai: ProjectAi }) {
    return (
        <section className="card card-pad stack-sm" data-testid="project-ai-available">
            <div className="row">
                <h2 className="t-section">AI for this project</h2>
                <span className="spacer" />
                <Badge tone={ai.available ? "success" : "warning"}>{ai.available ? "Available" : "Not available"}</Badge>
            </div>
            <p className="t-secondary">{ai.available ? "AI is available for this project." : ai.ready ? "AI work does not run on this server." : "AI is not available for this project right now. A project admin can tell you more."}</p>
        </section>
    );
}

function Choice({ id, ai, onChanged }: { id: string; ai: ProjectAi; onChanged: () => Promise<unknown> }) {
    const options = ai.ownOptions ?? [];
    const [mode, setMode] = useState<AiMode>(ai.mode ?? "managed");
    const [configId, setConfigId] = useState(ai.configurationId ?? "");
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        setMode(ai.mode ?? "managed");
        setConfigId(ai.configurationId ?? "");
    }, [ai.mode, ai.configurationId]);

    const list = mode === "own" ? options.map((c) => ({ id: c.id, text: `${c.label} (${c.providerName}, ending in ${c.keyEnding})` })) : (ai.managedOptions ?? []).map((c) => ({ id: c.id, text: `${c.label} (${c.providerName}, ${c.model})` }));
    const chosen = list.some((o) => o.id === configId) ? configId : mode === "own" ? (list[0]?.id ?? "") : "";
    const changed = mode !== ai.mode || (chosen || null) !== (ai.configurationId ?? null);
    const shown = ai.configuration?.id === chosen ? ai.configuration : undefined;

    const save = async (configurationId = chosen, nextMode = mode) => {
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${id}/ai`, { method: "PUT", body: { mode: nextMode, configurationId: configurationId || null } });
            await onChanged();
            setNote({ tone: "success", text: nextMode === "own" ? "Saved. This project now uses its own key." : "Saved. This project now uses Crowd4Test’s managed AI." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "That did not save. Try again." });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card card-pad stack-sm" data-testid="project-ai-choice" aria-labelledby="project-ai-pays">
            <h2 className="t-section" id="project-ai-pays">
                Who pays for this project’s AI
            </h2>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            <fieldset className="choice-group" aria-labelledby="project-ai-pays">
                <div className="stack-sm">
                    <label className="check">
                        <input type="radio" name="project-ai-mode" checked={mode === "managed"} onChange={() => setMode("managed")} />
                        <span>
                            <span className="title">Crowd4Test’s managed AI</span>
                            <span className="hint">Crowd4Test pays the provider.</span>
                        </span>
                    </label>
                    <label className="check">
                        <input type="radio" name="project-ai-mode" checked={mode === "own"} onChange={() => setMode("own")} />
                        <span>
                            <span className="title">Our own key</span>
                            <span className="hint">{ai.organizationName ?? "Your organisation"} pays the provider. If the key fails, the AI work stops; it never moves to Crowd4Test’s key.</span>
                        </span>
                    </label>
                </div>
            </fieldset>

            {mode === "managed" && (ai.managedOptions ?? []).length > 0 && (
                <div className="field">
                    <label htmlFor="project-ai-managed">Configuration</label>
                    <select id="project-ai-managed" className="input" value={chosen} onChange={(e) => setConfigId(e.target.value)}>
                        <option value="">The server’s key</option>
                        {list.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.text}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {mode === "own" && list.length > 0 && (
                <div className="field">
                    <label htmlFor="project-ai-own">Configuration</label>
                    <select id="project-ai-own" className="input" value={chosen} onChange={(e) => setConfigId(e.target.value)}>
                        {list.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.text}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {mode === "own" && list.length === 0 && !adding && <p className="t-secondary">No key has been added for this project or its organisation yet.</p>}
            {ai.problem && !changed && <Callout tone="danger" title="This project’s AI is stopped">{ai.problem}</Callout>}

            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {changed && (
                    <Button variant="primary" icon={Save} loading={busy} disabled={mode === "own" && !chosen} onClick={() => void save()}>
                        Save
                    </Button>
                )}
                {mode === "own" && !adding && (
                    <Button icon={Plus} onClick={() => setAdding(true)}>
                        Add a key for this project
                    </Button>
                )}
            </div>
            {mode === "own" && adding && (
                <ConfigurationForm
                    idPrefix="project-ai-new"
                    providers={ai.providers ?? []}
                    path={`/projects/${id}/ai/configurations`}
                    onCancel={() => setAdding(false)}
                    onSaved={async (c) => {
                        setAdding(false);
                        await save(c.id, "own");
                    }}
                />
            )}
            {shown && !changed && <KeyStatus configuration={shown} onTested={onChanged} />}
        </section>
    );
}

/** Read-only for someone who may see usage but not manage keys. */
function WhoPays({ ai }: { ai: ProjectAi }) {
    return (
        <section className="card card-pad stack-sm" data-testid="project-ai-who-pays">
            <h2 className="t-section">Who pays for this project’s AI</h2>
            <p className="t-secondary">{ai.mode === "own" ? `This project uses its own key. ${ai.organizationName ?? "Its organisation"} pays the provider.` : "This project uses Crowd4Test’s managed AI. Crowd4Test pays the provider."}</p>
        </section>
    );
}

function Budget({ id, ai, onChanged }: { id: string; ai: ProjectAi; onChanged: () => Promise<unknown> }) {
    const can = useCan();
    const b = ai.budget!;
    const [month, setMonth] = useState(limitText(b.monthlyTokens));
    const [job, setJob] = useState(limitText(b.jobTokens));
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        setMonth(limitText(b.monthlyTokens));
        setJob(limitText(b.jobTokens));
    }, [b.monthlyTokens, b.jobTokens]);
    const monthParsed = parseLimit(month);
    const jobParsed = parseLimit(job);
    const save = async () => {
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${id}/usage-budget`, { method: "PUT", body: { monthlyTokens: monthParsed, jobTokens: jobParsed } });
            await onChanged();
            setNote({ tone: "success", text: "Saved." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "That did not save. Try again." });
        } finally {
            setBusy(false);
        }
    };
    const usage = ai.usageByOwner ?? [];
    return (
        <section className="card card-pad stack-sm" data-testid="project-ai-budget">
            <h2 className="t-section">Usage and budget</h2>
            <p className="t-secondary">
                This month: {tokensText(b.usedTokens)} tokens{b.monthlyTokens !== null ? ` of ${tokensText(b.monthlyTokens)}` : ", no monthly limit"}.
                {b.jobTokens !== null ? ` Each job stops at ${tokensText(b.jobTokens)}.` : ""}
            </p>
            {usage.length > 0 && (
                <ul className="list divided" aria-label="Usage this month by who pays">
                    {usage.map((u) => (
                        <li className="list-row" key={u.owner}>
                            <span className="main">
                                <span className="title">{OWNER_WORDS[u.owner] ?? u.owner}</span>
                                <span className="meta">
                                    {exact(u.calls)} {u.calls === 1 ? "call" : "calls"}, {tokensText(u.totalTokens)} tokens{u.cost !== null ? `, about ${costText(u.cost, ai.currency ?? "")}` : ""}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <p className="t-meta">{ai.mode === "own" ? "Only this project’s limits apply on its own key." : "The platform’s limits apply as well."} AI Studio records who pays; it charges nothing.</p>
            {can("ai_studio.platform.settings") && (
                <div className="stack-sm">
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    <div className="row" style={{ gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div className="field" style={{ flex: "1 1 180px" }}>
                            <label htmlFor="project-ai-month">Tokens per month</label>
                            <input id="project-ai-month" className="input" inputMode="numeric" autoComplete="off" placeholder="No limit" value={month} aria-invalid={monthParsed === undefined || undefined} onChange={(e) => setMonth(e.target.value)} />
                        </div>
                        <div className="field" style={{ flex: "1 1 180px" }}>
                            <label htmlFor="project-ai-job">Tokens per job</label>
                            <input id="project-ai-job" className="input" inputMode="numeric" autoComplete="off" placeholder="No limit" value={job} aria-invalid={jobParsed === undefined || undefined} onChange={(e) => setJob(e.target.value)} />
                        </div>
                    </div>
                    <div>
                        <Button loading={busy} disabled={monthParsed === undefined || jobParsed === undefined} onClick={() => void save()}>
                            Save limits
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/**
 * Project settings → AI configuration: who pays, which configuration, its status and test button, and the budget. What shows follows the
 * answer of GET /projects/:id/ai, which leaves out what the person may not see: a tester gets only the first card's words.
 */
export function ProjectAiSettings({ id }: { id: string }) {
    const f = useFetch<ProjectAi>(`/projects/${id}/ai`);
    const ai = f.data;
    if (f.loading && !ai) return <Skeleton h={220} />;
    if (f.error || !ai) return <ErrorState error={friendlyError(f.error?.message ?? "")} onRetry={f.reload} />;
    const seesMore = ai.mode !== undefined;
    return (
        <div className="stack" data-testid="project-ai">
            <Availability ai={ai} />
            {seesMore && ai.serverHasKey === false && ai.mode === "managed" && <Callout tone="warning" title="No key on this server">{SERVER_HAS_NO_KEY}</Callout>}
            {seesMore && !ai.runsHere && <Callout tone="warning" title="AI work does not run here">{NOTHING_RUNS_HERE}</Callout>}
            {seesMore && (ai.canManage ? <Choice id={id} ai={ai} onChanged={f.reload} /> : <WhoPays ai={ai} />)}
            {ai.budget && <Budget id={id} ai={ai} onChanged={f.reload} />}
        </div>
    );
}
