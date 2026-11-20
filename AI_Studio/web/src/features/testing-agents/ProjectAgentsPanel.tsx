import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { AgentPicker, type AgentId, type AgentList, type ProjectAgents } from "./testing-agents";

/**
 * Project Settings → General: the testing agents of a project tested by the AI agent. They decide what an exploration does: in a Test
 * Case Generation project it builds a tree and writes test cases (other agents chosen with it wait, owner decision Q6); otherwise the
 * agents' checks run.
 * A project with no saved choice shows the agents its latest exploration settings match, and runs as before until one is saved.
 */
export function ProjectAgentsPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
    const mine = useFetch<ProjectAgents>(`/projects/${id}/testing-agents`);
    const all = useFetch<AgentList>("/testing-agents");
    const [value, setValue] = useState<AgentId[]>([]);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        if (mine.data) setValue(mine.data.agents);
    }, [mine.data]);

    if (mine.loading || all.loading) return <Skeleton h={160} />;
    if (mine.error || all.error || !mine.data || !all.data) return <ErrorState error={friendlyError(mine.error?.message ?? all.error?.message ?? "The agents could not be loaded.")} onRetry={() => void Promise.all([mine.reload(), all.reload()])} />;
    // Agents belong to projects tested by the AI agent; a code project keeps any saved choice, unused.
    if (!mine.data.applies) return null;

    const saved = mine.data.agents;
    const changed = mine.data.source === "matched" || value.join() !== saved.join();
    const save = async () => {
        if (value.length === 0) return setNote({ tone: "danger", text: "Choose at least one testing agent." });
        setBusy(true);
        setNote(null);
        try {
            const now = await api<ProjectAgents>(`/projects/${id}/testing-agents`, { method: "PUT", body: { agents: value } });
            await mine.reload();
            setNote({ tone: "success", text: now.caseAgent ? "Saved. The next exploration builds the tree and writes test cases." : "Saved. The next exploration runs the checks of these agents." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "The agents were not saved. Try again." });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card card-pad stack" aria-labelledby="agents-title" data-testid="project-agents">
            <div className="stack-sm">
                <h2 className="t-section" id="agents-title">
                    Testing agents
                </h2>
                <p className="t-secondary" data-testid="project-agents-about">
                    {mine.data.caseAgent ? CASE_AGENT_ABOUT : "The agents decide which checks run when the AI explores this project’s application."} <a href={routes.agents}>What each agent does</a>
                </p>
                {mine.data.source === "matched" && (
                    <Callout tone="info" title="No agents saved yet">
                        These are the agents that match this project’s earlier exploration settings. Its explorations run as before until you save a choice.
                    </Callout>
                )}
            </div>
            <AgentPicker agents={all.data.agents} platforms={mine.data.platforms} value={value} onChange={setValue} disabled={!canEdit || busy} />
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {canEdit ? (
                <div>
                    <Button variant="primary" icon={Save} loading={busy} disabled={busy || !changed || value.length === 0} onClick={() => void save()}>
                        Save agents
                    </Button>
                </div>
            ) : (
                <p className="t-meta">Changing the agents needs “Change project settings”.</p>
            )}
        </section>
    );
}

/** What the agents do in a Test Case Generation project (founder 2026-11-19; owner decision Q6 for the agents chosen with it). */
const CASE_AGENT_ABOUT = "The Test Case Generation Agent explores this project’s application or reads its requirements, builds a tree and writes test cases. Other agents chosen with it come back in a later update.";
