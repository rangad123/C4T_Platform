import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { FALLBACK_PROVIDERS, reloadMyAi, type AdminKeysAnswer, type AiProviderChoice } from "./aiconfig";
import { ConfigurationForm } from "./ConfigurationForm";
import { KeyStatus } from "./KeyStatus";

type AdminKey = AdminKeysAnswer["keys"][number];
const fail = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const whoWords = (n: number) => (n === 0 ? "Assigned to nobody" : n === 1 ? "Assigned to 1 person" : `Assigned to ${n} people`);

/** Who may use one organisational key: a filter and a checkbox per admin or sub-admin, saved together. */
function Assign({ k, people, onSaved, onCancel }: { k: AdminKey; people: AdminKeysAnswer["people"]; onSaved: () => Promise<void>; onCancel: () => void }) {
    const [picked, setPicked] = useState<Set<string>>(() => new Set(k.assignees.map((a) => a.id)));
    const [filter, setFilter] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q ? people.filter((p) => `${p.name} ${p.email ?? ""}`.toLowerCase().includes(q)) : people;
    }, [people, filter]);
    const save = async () => {
        setBusy(true);
        setError("");
        try {
            await api(`/admin/ai-keys/${encodeURIComponent(k.id)}/assignees`, { method: "PUT", body: { personIds: [...picked] } });
            await onSaved();
        } catch (e) {
            setError(fail(e, "The assignment was not saved. Try again."));
            setBusy(false);
        }
    };
    const id = `assign-${k.id}`;
    return (
        <div className="stack-sm ai-assign" data-testid="ai-assign">
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="field">
                <label htmlFor={`${id}-filter`}>Find an admin or sub-admin</label>
                <input id={`${id}-filter`} className="input" type="search" autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name or email" />
            </div>
            {people.length === 0 ? (
                <p className="t-secondary">There are no admins or sub-admins to assign yet. People appear here after they first open AI Studio.</p>
            ) : (
                <fieldset className="ai-assign-list">
                    <legend className="t-meta">
                        Who may use {k.label} ({picked.size} chosen)
                    </legend>
                    {shown.length === 0 && <p className="t-secondary">Nobody matches “{filter.trim()}”.</p>}
                    {shown.map((p) => (
                        <label className="check" key={p.id}>
                            <input
                                type="checkbox"
                                checked={picked.has(p.id)}
                                onChange={(e) => {
                                    const next = new Set(picked);
                                    if (e.target.checked) next.add(p.id);
                                    else next.delete(p.id);
                                    setPicked(next);
                                }}
                            />
                            <span>
                                <span className="title">{p.name}</span>
                                <span className="hint">{[p.email, p.role].filter(Boolean).join(" · ")}</span>
                            </span>
                        </label>
                    ))}
                </fieldset>
            )}
            <div className="row" style={{ gap: 8 }}>
                <Button variant="primary" loading={busy} onClick={() => void save()}>
                    Save who may use it
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

function AdminKeyRow({ k, people, providers, onChanged }: { k: AdminKey; people: AdminKeysAnswer["people"]; providers: AiProviderChoice[]; onChanged: () => Promise<void> }) {
    const [mode, setMode] = useState<"none" | "edit" | "assign" | "remove">("none");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const remove = async () => {
        setBusy(true);
        setError("");
        try {
            await api(`/admin/ai-keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
            setMode("none");
            await onChanged();
        } catch (e) {
            setError(fail(e, "The key was not removed. Try again."));
            setBusy(false);
        }
    };
    return (
        <li className="stack-sm ai-key-row" data-testid="org-key" data-key={k.id}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{k.label}</strong>
                <span className="t-meta" data-testid="org-key-assignees">
                    {whoWords(k.assignees.length)}
                    {k.assignees.length > 0 && `: ${k.assignees.map((a) => a.name).join(", ")}`}
                </span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={Users} onClick={() => setMode(mode === "assign" ? "none" : "assign")} aria-label={`Choose who may use ${k.label}`}>
                    Assign
                </Button>
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setMode(mode === "edit" ? "none" : "edit")} aria-label={`Change ${k.label}`}>
                    Change
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setMode("remove")} aria-label={`Remove ${k.label}…`}>
                    Remove
                </Button>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            {mode === "remove" && (
                <Callout
                    tone="warning"
                    title={`Remove ${k.label}?`}
                    actions={
                        <>
                            <Button size="sm" disabled={busy} onClick={() => setMode("none")}>
                                Keep it
                            </Button>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()} aria-label={`Remove ${k.label}`}>
                                Remove
                            </Button>
                        </>
                    }
                >
                    The key is deleted and cannot be read back. People who use it can’t start AI work until they choose another key.
                </Callout>
            )}
            <KeyStatus keyView={k} testPath={`/admin/ai-keys/${encodeURIComponent(k.id)}/test`} onTested={onChanged} />
            {mode === "assign" && (
                <Assign
                    k={k}
                    people={people}
                    onCancel={() => setMode("none")}
                    onSaved={async () => {
                        setMode("none");
                        await onChanged();
                    }}
                />
            )}
            {mode === "edit" && (
                <ConfigurationForm
                    idPrefix={`org-key-${k.id}`}
                    providers={providers}
                    current={k}
                    path={`/admin/ai-keys/${encodeURIComponent(k.id)}`}
                    onCancel={() => setMode("none")}
                    onSaved={async () => {
                        setMode("none");
                        await onChanged();
                    }}
                />
            )}
        </li>
    );
}

/** Settings, for Crowd4Test admins only: Crowd4Test's organisational keys, and which admins and sub-admins may use each one. */
export function OrganisationalKeysCard() {
    const f = useFetch<AdminKeysAnswer>("/admin/ai-keys");
    const [adding, setAdding] = useState(false);
    const data = f.data;
    const providers = data?.providers?.length ? data.providers : FALLBACK_PROVIDERS;
    // A change here can change this admin's own keys too (an assignment, a removed key).
    const changed = async () => {
        await f.reload();
        await reloadMyAi();
    };
    return (
        <section className="card card-pad stack-sm" data-testid="org-keys" aria-labelledby="org-keys-title">
            <h2 className="t-section" id="org-keys-title">
                Organisational keys
            </h2>
            <p className="t-secondary">Crowd4Test’s keys. Only the admins and sub-admins you assign a key to see it and may use it. Nobody’s personal keys are shown here.</p>
            {f.loading && !data ? (
                <ListSkeleton rows={2} />
            ) : f.error || !data ? (
                <ErrorState error={friendlyError(f.error?.message ?? "")} onRetry={f.reload} />
            ) : (
                <>
                    {data.keys.length === 0 ? (
                        <p className="t-secondary">No organisational keys yet.</p>
                    ) : (
                        <ul className="ai-key-list" aria-label="Organisational keys">
                            {data.keys.map((k) => (
                                <AdminKeyRow key={k.id} k={k} people={data.people} providers={providers} onChanged={changed} />
                            ))}
                        </ul>
                    )}
                    {adding ? (
                        <ConfigurationForm
                            idPrefix="org-key-new"
                            providers={providers}
                            path="/admin/ai-keys"
                            onCancel={() => setAdding(false)}
                            onSaved={async () => {
                                setAdding(false);
                                await changed();
                            }}
                        />
                    ) : (
                        <div>
                            <Button icon={Plus} onClick={() => setAdding(true)}>
                                Add an organisational key
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
