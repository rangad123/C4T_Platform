import { Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectDetail } from "../../api";
import { Button, Callout, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import type { WorkspaceAnswer } from "./workspace";
import "./workspace.css";
import { LevelChoice, projectLevel, ScreenReviewChoice } from "../explore/ExploreLevel";
import type { ExploreLevel } from "../../../../src/engine/levels";
import { SIZE_DEFAULT, SizePicker } from "./agents/responsive-ui";

interface ModelPick {
    provider: string;
    model: string;
}
/** GET /api/projects/:id/workspace/:agentId/settings (testing-agents.ts AgentSettings): the defaults this agent has, and the ones saved. */
export interface AgentSettingsAnswer {
    keys: Array<"level" | "model" | "variants" | "visionChecks">;
    settings: { level?: ExploreLevel; model?: ModelPick; variants?: string[]; visionChecks?: boolean };
}
interface AiModelAnswer {
    selected: ModelPick | null;
    choices: Array<ModelPick & { providerWords: string }>;
}

export const agentSettingsPath = (projectId: string, agentId: string) => `/projects/${projectId}/workspace/${agentId}/settings`;
const valueOf = (m: ModelPick | null | undefined) => (m ? `${m.provider}\n${m.model}` : "");
const pickOf = (v: string): ModelPick | undefined => {
    const i = v.indexOf("\n");
    return i < 0 ? undefined : { provider: v.slice(0, i), model: v.slice(i + 1) };
};

/**
 * An agent's own saved defaults (its Settings tab): only the options its run uses. Every run of this agent starts from them (the Run form,
 * its schedules); the Run form can still change them for one run. What is shared by the whole project stays in the project's Settings.
 */
export function AgentDefaults({ projectId, agentId }: { projectId: string; agentId: string }) {
    const answer = useFetch<AgentSettingsAnswer>(agentSettingsPath(projectId, agentId));
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const keys = answer.data?.keys ?? [];
    const models = useFetch<AiModelAnswer>(keys.includes("model") ? `/projects/${projectId}/ai-model` : null);
    const saved = answer.data?.settings;
    const [level, setLevel] = useState<ExploreLevel>("thorough");
    const [model, setModel] = useState("");
    const [sizes, setSizes] = useState<string[]>(SIZE_DEFAULT);
    const [review, setReview] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        if (!saved || !project.data) return;
        setLevel(saved.level ?? projectLevel(project.data));
        setModel(valueOf(saved.model));
        setSizes(saved.variants ?? SIZE_DEFAULT);
        setReview(saved.visionChecks ?? null);
    }, [saved, project.data]);

    if (answer.loading || project.loading) return <ListSkeleton rows={3} />;
    if (answer.error || !saved) return <Callout tone="warning">{answer.error?.message ?? "This agent’s settings could not be loaded."}</Callout>;
    if (!keys.length) return null;
    const p = project.data;
    const canEdit = !!p && (!p.access || p.access.permissions.includes("ai_studio.project.settings")) && !p.archived_at;
    const edited = () => setNote(null);
    const projectModel = models.data?.selected;
    const savedNotMine = saved.model && !models.data?.choices.some((c) => valueOf(c) === valueOf(saved.model));

    async function save() {
        setBusy(true);
        setNote(null);
        try {
            const m = pickOf(model);
            await api(agentSettingsPath(projectId, agentId), {
                method: "PUT",
                body: { level, ...(m ? { model: m } : {}), ...(keys.includes("variants") ? { variants: sizes } : {}), ...(keys.includes("visionChecks") && review !== null ? { visionChecks: review } : {}) },
            });
            await answer.reload();
            setNote({ tone: "success", text: "Saved. This agent’s next runs start from these." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "The settings were not saved. Try again." });
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack" data-testid="agent-defaults">
            <div>
                <h3 className="t-card">How this agent runs</h3>
                <p className="t-secondary">Every run of this agent starts from these, its schedules too.</p>
            </div>
            <fieldset className="stack" disabled={!canEdit || busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                {keys.includes("level") && <LevelChoice value={level} onChange={(l) => (setLevel(l), edited())} name={`agent-level-${agentId}`} caseAgent={agentId === "test-generation"} />}
                {keys.includes("model") && (
                    <div className="field">
                        <label htmlFor="agent-model" className="t-section">
                            AI model
                        </label>
                        <select id="agent-model" className="input" data-testid="agent-model" value={model} onChange={(e) => (setModel(e.target.value), edited())} style={{ maxWidth: 420 }}>
                            <option value="">{projectModel ? `The project’s model (${projectModel.model})` : "The project’s model (each person’s default AI key)"}</option>
                            {savedNotMine && (
                                <option value={valueOf(saved.model)} disabled>
                                    {saved.model!.model} (not one of your AI keys)
                                </option>
                            )}
                            {(models.data?.choices ?? []).map((c) => (
                                <option key={valueOf(c)} value={valueOf(c)}>
                                    {c.providerWords}, {c.model}
                                </option>
                            ))}
                        </select>
                        <p className="hint">A person who may not use this model gets their default AI key, and the run says so.</p>
                    </div>
                )}
                {keys.includes("variants") && <SizePicker value={sizes} onChange={(v) => (setSizes(v), edited())} />}
                {keys.includes("visionChecks") && <ScreenReviewChoice level={level} canReadImages value={review} onChange={(v) => (setReview(v), edited())} />}
            </fieldset>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {canEdit ? (
                <div>
                    <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
                        Save
                    </Button>
                </div>
            ) : (
                <p className="t-meta">{p?.archived_at ? "This project is archived, so its settings are read-only." : "Changing these needs “Change project settings”."}</p>
            )}
        </section>
    );
}

/** Project Settings → General in a project with the Agent Workspace: each agent's own Settings tab, so both levels are found from one place. */
export function AgentSettingsList({ projectId }: { projectId: string }) {
    const ws = useFetch<WorkspaceAnswer>(`/projects/${projectId}/workspace`);
    if (!ws.data?.workspace || !ws.data.agents.length) return null;
    return (
        <section className="card card-pad stack-sm" data-testid="agent-settings-list">
            <h2 className="t-section">Agent settings</h2>
            <p className="t-secondary">What is set here is shared by the whole project. How each agent runs is on its own Settings tab.</p>
            <ul className="ws-needs" style={{ listStyle: "none", paddingLeft: 0 }}>
                {ws.data.agents.map((a) => (
                    <li key={a.id}>
                        <SlidersHorizontal size={14} aria-hidden style={{ verticalAlign: "-2px", marginRight: 6 }} />
                        <a href={routes.projectAgent(projectId, a.id, "settings")}>{a.name}</a>
                    </li>
                ))}
            </ul>
        </section>
    );
}
