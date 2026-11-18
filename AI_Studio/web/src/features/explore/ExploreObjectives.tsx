import { useEffect, useState } from "react";
import { api, projectShape, type ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useHere } from "../auth/project-access";
import type { AgentInputs } from "../requirements/AgentInputs";

/**
 * Project Settings → General, beside "How much to explore": the project's "Explore by objectives" switch (owner, 2026-11-21). On by
 * default for a project tested by the AI agent (never saved means on); kept with what the agents need (GET/PUT /agent-inputs).
 * Only people who may change the project's settings can change it; a refused save shows the server's sentence. Not shown for a project
 * not tested by the AI agent, or one that tests only a phone app (objectives are explored on websites).
 */
export function ExploreObjectivesSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const inputs = useFetch<AgentInputs>(`/projects/${id}/agent-inputs`);
    const can = useHere(id, project).may;
    const saved = inputs.data?.exploreByObjectives !== false;
    const [on, setOn] = useState(saved);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    useEffect(() => setOn(saved), [saved]);
    if (!project.data || !inputs.data?.applies) return null;
    if (!projectShape(project.data).platforms.includes("web")) return null;
    const canEdit = can("ai_studio.project.settings");
    const hasApp = inputs.data.application !== null;
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api(`/projects/${id}/agent-inputs`, { method: "PUT", body: { exploreByObjectives: on } });
            setMsg({ ok: true, text: on ? "Later explorations explore by objectives." : "Later explorations no longer explore by objectives." });
            await inputs.reload();
        } catch (e) {
            setMsg({ ok: false, text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="card card-pad stack-sm" data-testid="explore-objectives-setting">
            <label className="check">
                <input type="checkbox" checked={on} disabled={!canEdit || !hasApp} aria-describedby="explore-objectives-hint" onChange={(e) => (setOn(e.target.checked), setMsg(null))} />
                <span>
                    <span className="title">Explore by objectives</span>
                    <span className="hint" id="explore-objectives-hint">
                        After the planned tests, the AI checks each rule, workflow and field limit it knows about the application, one at a time; this takes longer and uses more AI. Checks that submit forms need “Include API tests that change data”, in{" "}
                        <a href={routes.requirements(id)}>Requirements → What the agents need</a>.
                    </span>
                </span>
            </label>
            {!hasApp && <p className="t-meta">Saved once the application has an address.</p>}
            {msg && <Callout tone={msg.ok ? "success" : "danger"}>{msg.text}</Callout>}
            {canEdit ? (
                <div>
                    <Button variant="primary" loading={busy} disabled={!hasApp || on === saved} onClick={() => void save()}>
                        Save
                    </Button>
                </div>
            ) : (
                <p className="t-meta">Only people who may change this project’s settings can change this.</p>
            )}
        </div>
    );
}
