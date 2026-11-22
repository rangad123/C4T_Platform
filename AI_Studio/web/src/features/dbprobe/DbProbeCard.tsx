import { Database, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { useHere } from "../auth/project-access";

/** GET /api/projects/:id/db-probe (routes/db-probe.ts): the token itself is never sent back. */
export interface DbProbeSetting {
    enabled: boolean;
    url: string;
    tokenSaved: boolean;
}

/**
 * Settings, Test data: database checks through the customer's own database probe (docs/features/database-checks.md). Off by default.
 * Three fields: the switch, the probe's address and its token. The token is write-only: once saved, the field stays empty and says so.
 */
export function DbProbeCard({ projectId }: { projectId: string }) {
    const data = useFetch<DbProbeSetting>(`/projects/${projectId}/db-probe`);
    const [enabled, setEnabled] = useState(false);
    const [url, setUrl] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const here = useHere(projectId);
    const ro = Boolean(here.why("ai_studio.project.settings"));
    const saved = data.data;
    useEffect(() => {
        setEnabled(saved?.enabled ?? false);
        setUrl(saved?.url ?? "");
        setToken("");
    }, [saved?.enabled, saved?.url, saved?.tokenSaved]);

    async function save() {
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${projectId}/db-probe`, { method: "PUT", body: { enabled, url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) } });
            await data.reload();
            setNote({ tone: "success", text: !url.trim() ? "Removed. Runs make no database checks." : enabled ? "Saved. Runs check the stored data through your probe." : "Saved, switched off. Runs make no database checks." });
        } catch (e) {
            setNote({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }

    const head = (
        <div className="row">
            <Database size={18} aria-hidden />
            <h2 className="t-section" id="db-probe-title">
                Database checks
            </h2>
        </div>
    );
    if (data.loading)
        return (
            <section className="card card-pad stack-sm" aria-label="Database checks">
                <Skeleton h={18} w={180} />
                <Skeleton h={64} />
            </section>
        );
    if (data.error || !saved)
        return (
            <section className="card card-pad stack-sm" aria-labelledby="db-probe-title">
                {head}
                <Callout tone="warning">{data.error ? describeApiError(data.error) : "The database checks setting could not be loaded."}</Callout>
            </section>
        );
    const changed = enabled !== saved.enabled || url.trim() !== saved.url || token.trim() !== "";
    return (
        <section className="card card-pad stack-sm" aria-labelledby="db-probe-title" data-testid="db-probe">
            {head}
            <p className="t-secondary">
                Optional: after a test changes data, check what your database stored, through a small read-only probe you run. Only counts are kept.
            </p>
            <label className="check">
                <input type="checkbox" disabled={ro || busy} checked={enabled} onChange={(e) => (setEnabled(e.target.checked), setNote(null))} />
                <span>
                    <span className="title">Check the database after tests that change data</span>
                    <span className="hint">Needs “Include API tests that change data” on the Requirements tab.</span>
                </span>
            </label>
            <div className="field">
                <label htmlFor="db-probe-url">Probe address</label>
                <input id="db-probe-url" className="input mono" disabled={ro || busy} value={url} placeholder="https://db-probe.example.com" autoComplete="off" spellCheck={false} aria-describedby="db-probe-url-hint" onChange={(e) => (setUrl(e.target.value), setNote(null))} />
                <p className="hint" id="db-probe-url-hint">
                    Starts with https://; http:// only for a probe on this computer. Leave it empty and save to remove the setting.
                </p>
            </div>
            <div className="field">
                <label htmlFor="db-probe-token">Probe token</label>
                <input id="db-probe-token" className="input mono" type="password" disabled={ro || busy} value={token} placeholder={saved.tokenSaved ? "•••••••• saved" : ""} autoComplete="new-password" spellCheck={false} aria-describedby="db-probe-token-hint" onChange={(e) => (setToken(e.target.value), setNote(null))} />
                <p className="hint" id="db-probe-token-hint" data-testid="db-probe-token-state">
                    {saved.tokenSaved ? "A token is saved, stored encrypted and never shown again. Type a new one to replace it." : "The token you gave the probe, at least 24 characters. Stored encrypted and never shown again."}
                </p>
            </div>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {ro ? (
                <p className="t-meta">{here.why("ai_studio.project.settings")}</p>
            ) : (
                <div>
                    <Button variant="primary" icon={Save} loading={busy} disabled={busy || !changed} onClick={() => void save()}>
                        Save
                    </Button>
                </div>
            )}
        </section>
    );
}
