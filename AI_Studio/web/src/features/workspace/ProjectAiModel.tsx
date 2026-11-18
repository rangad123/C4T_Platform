import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api, type ProjectDetail } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";

interface AiModelPick {
    provider: string;
    model: string;
}
interface AiModelAnswer {
    selected: AiModelPick | null;
    selectedYours: boolean;
    choices: Array<AiModelPick & { providerWords: string }>;
}

const valueOf = (m: AiModelPick | null) => (m ? `${m.provider}\n${m.model}` : "");
const pickOf = (v: string): AiModelPick | null => {
    const i = v.indexOf("\n");
    return i < 0 ? null : { provider: v.slice(0, i), model: v.slice(i + 1) };
};

/**
 * Project Settings → General: the AI model this project's AI work uses. The list holds only the models of the AI keys the person looking may
 * use (their own, and the organisational keys assigned to them); empty is each person's default AI key. The server checks again when the
 * work runs. Changing it needs "Change project settings".
 */
export function ProjectAiModelSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const answer = useFetch<AiModelAnswer>(`/projects/${id}/ai-model`);
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const saved = valueOf(answer.data?.selected ?? null);
    useEffect(() => setValue(saved), [saved]);

    const p = project.data;
    const canEdit = !!p && (!p.access || p.access.permissions.includes("ai_studio.project.settings")) && !p.archived_at;
    const a = answer.data;

    const save = async () => {
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${id}/ai-model`, { method: "PUT", body: { model: pickOf(value) } });
            await answer.reload();
            setNote({ tone: "success", text: "Saved." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "The AI model was not saved. Try again." });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="ai-model-title" data-testid="project-ai-model">
            <h2 className="t-section" id="ai-model-title">
                AI model
            </h2>
            <p className="t-secondary">The AI model this project’s AI work uses, from the AI keys you may use. A person who may not use it gets their default AI key, and their work says so.</p>
            {answer.loading || project.loading ? (
                <Skeleton h={40} />
            ) : answer.error || !a ? (
                <Callout tone="warning">{answer.error?.message ?? "The AI model could not be loaded."}</Callout>
            ) : (
                <>
                    <select className="input" aria-label="AI model" disabled={!canEdit || busy} value={value} onChange={(e) => (setValue(e.target.value), setNote(null))} style={{ maxWidth: 420 }}>
                        <option value="">Each person’s default AI key</option>
                        {a.selected && !a.selectedYours && (
                            <option value={saved} disabled>
                                {a.selected.model} (not one of your AI keys)
                            </option>
                        )}
                        {a.choices.map((c) => (
                            <option key={valueOf(c)} value={valueOf(c)}>
                                {c.providerWords}, {c.model}
                            </option>
                        ))}
                    </select>
                    {a.choices.length === 0 && <p className="t-meta">You have no AI keys with a model to choose. Add one in Settings, AI keys.</p>}
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    {canEdit ? (
                        <div>
                            <Button variant="primary" icon={Save} loading={busy} disabled={busy || value === saved} onClick={() => void save()}>
                                Save
                            </Button>
                        </div>
                    ) : (
                        <p className="t-meta">{p?.archived_at ? "This project is archived, so its settings are read-only." : "Changing this needs “Change project settings”."}</p>
                    )}
                </>
            )}
        </section>
    );
}
