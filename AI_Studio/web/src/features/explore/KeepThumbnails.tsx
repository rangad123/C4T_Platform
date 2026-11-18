import { useEffect, useState } from "react";
import { api, projectShape, type ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";
import type { AgentInputs } from "../requirements/AgentInputs";

/**
 * Project Settings → General: the project's "Keep page thumbnails" switch (sheet #8, owner 2026-11-21). On by default (never saved means on);
 * kept with what the agents need (GET/PUT /agent-inputs). Only people who may change the project's settings can change it; a refused save
 * shows the server's sentence. Not shown for a project not tested by the AI agent, or one that tests only a phone app.
 */
export function KeepThumbnailsSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const inputs = useFetch<AgentInputs>(`/projects/${id}/agent-inputs`);
    const can = useHere(id, project).may;
    const saved = inputs.data?.keepThumbnails !== false;
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
            await api(`/projects/${id}/agent-inputs`, { method: "PUT", body: { keepThumbnails: on } });
            setMsg({ ok: true, text: on ? "Later explorations keep a small picture of each page." : "Later explorations keep no page pictures. Pictures kept before stay until they expire." });
            await inputs.reload();
        } catch (e) {
            setMsg({ ok: false, text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="card card-pad stack-sm" data-testid="keep-thumbnails-setting">
            <label className="check">
                <input type="checkbox" checked={on} disabled={!canEdit || !hasApp} aria-describedby="keep-thumbnails-hint" onChange={(e) => (setOn(e.target.checked), setMsg(null))} />
                <span>
                    <span className="title">Keep page thumbnails</span>
                    <span className="hint" id="keep-thumbnails-hint">
                        Each exploration keeps a small picture of every page it opens, shown on its site map. Password, one-time code and card fields, and fields holding a saved password, are covered; a page that cannot be covered gets no picture. Pictures expire with the project’s screenshots.
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
