import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { NOTHING_RUNS_HERE, SERVER_HAS_NO_KEY, type AiConfiguration, type AiConfigurationsAnswer } from "./aiconfig";
import { ConfigurationForm } from "./ConfigurationForm";
import { KeyStatus } from "./KeyStatus";

function Row({ c, data, onChanged }: { c: AiConfiguration; data: AiConfigurationsAnswer; onChanged: () => Promise<unknown> }) {
    const [editing, setEditing] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const remove = async () => {
        if (!window.confirm(`Remove “${c.label}”? Its key is deleted and cannot be read back.`)) return;
        setBusy(true);
        setError("");
        try {
            await api(`/ai-configurations/${c.id}`, { method: "DELETE" });
            await onChanged();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "That did not work. Try again.");
            setBusy(false);
        }
    };
    return (
        <li className="stack-sm" style={{ padding: "12px 0", borderTop: "1px solid var(--border-default)" }} data-testid="ai-configuration">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{c.label}</strong>
                <Badge tone="neutral">{c.ownerName}</Badge>
                <span className="t-meta">{c.usedBy === 0 ? "No project uses it" : c.usedBy === 1 ? "1 project uses it" : `${c.usedBy} projects use it`}</span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(!editing)} aria-label={`Change ${c.label}`}>
                    Change
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={() => void remove()} aria-label={`Remove ${c.label}`}>
                    Remove
                </Button>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <KeyStatus configuration={c} onTested={onChanged} />
            {editing && (
                <ConfigurationForm
                    idPrefix={`ai-config-${c.id}`}
                    providers={data.providers}
                    current={c}
                    path={`/ai-configurations/${c.id}`}
                    onCancel={() => setEditing(false)}
                    onSaved={async () => {
                        setEditing(false);
                        await onChanged();
                    }}
                />
            )}
        </li>
    );
}

/** Global Settings: the organisation's or the platform's AI configurations. A customer sees their organisation's, Crowd4Test staff all of them. */
export function AiConfigurationsCard() {
    const f = useFetch<AiConfigurationsAnswer>("/ai-configurations");
    const data = f.data;
    const [adding, setAdding] = useState(false);
    const [owner, setOwner] = useState("");
    const owners = data ? [...data.organizations.map((o) => ({ value: `organization:${o.id}`, label: o.name ?? o.id })), ...(data.canAddPlatform ? [{ value: "platform", label: "Crowd4Test (the platform)" }] : [])] : [];
    const picked = owners.some((o) => o.value === owner) ? owner : (owners[0]?.value ?? "");
    const extra = picked === "platform" ? { owner: "platform" } : { owner: "organization", organizationId: picked.slice("organization:".length) };
    return (
        <section className="card card-pad stack-sm" data-testid="ai-configurations" aria-labelledby="ai-configurations-title">
            <h2 className="t-section" id="ai-configurations-title">
                AI configurations
            </h2>
            <p className="t-secondary">Keys that projects can use. A project chooses who pays in its own settings, under AI configuration.</p>
            {f.loading && !data ? (
                <ListSkeleton rows={2} />
            ) : f.error || !data ? (
                <ErrorState error={friendlyError(f.error?.message ?? "")} onRetry={f.reload} />
            ) : (
                <>
                    {!data.server.hasKey && <Callout tone="warning" title="No key on this server">{SERVER_HAS_NO_KEY}</Callout>}
                    {!data.server.runsHere && <Callout tone="warning" title="AI work does not run here">{NOTHING_RUNS_HERE}</Callout>}
                    {data.configurations.length === 0 ? (
                        <p className="t-secondary">No configurations yet.</p>
                    ) : (
                        <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="AI configurations">
                            {data.configurations.map((c) => (
                                <Row key={c.id} c={c} data={data} onChanged={f.reload} />
                            ))}
                        </ul>
                    )}
                    {owners.length === 0 ? (
                        <p className="t-meta">A project’s own key is added in that project’s settings.</p>
                    ) : adding ? (
                        <div className="stack-sm">
                            {owners.length > 1 && (
                                <div className="field">
                                    <label htmlFor="ai-config-owner">Belongs to</label>
                                    <select id="ai-config-owner" className="input" value={picked} onChange={(e) => setOwner(e.target.value)}>
                                        {owners.map((o) => (
                                            <option key={o.value} value={o.value}>
                                                {o.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <ConfigurationForm
                                idPrefix="ai-config-new"
                                providers={data.providers}
                                path="/ai-configurations"
                                extra={extra}
                                onCancel={() => setAdding(false)}
                                onSaved={async () => {
                                    setAdding(false);
                                    await f.reload();
                                }}
                            />
                        </div>
                    ) : (
                        <div>
                            <Button icon={Plus} onClick={() => setAdding(true)}>
                                Add a configuration
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
