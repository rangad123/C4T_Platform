import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import type { Fetched } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import type { Agent, AgentToken } from "./agents";
import "./agents.css";
import { Tooltip } from "../../components/Tooltip";

/** What is being removed: the name to show and the access (token) behind it. */
export interface AccessTarget {
    tokenId: string;
    name: string;
}

/**
 * The honest confirmation before a runner's access is taken away. It is a real modal dialog, so the keyboard stays inside and Escape
 * closes it; "Keep access" comes first and has the focus, because removing cannot be undone.
 */
export function RemoveAccessDialog({ projectId, target, onClose, onDone }: { projectId: string; target: AccessTarget; onClose: () => void; onDone: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        d?.querySelector<HTMLButtonElement>("button")?.focus();
    }, []);

    async function remove() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/agent-tokens/${target.tokenId}`, { method: "DELETE" });
            onDone();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <dialog ref={ref} className="ag-dialog" aria-labelledby="ag-remove-title" onClose={onClose} onCancel={onClose}>
            <div className="inner">
                <h2 className="t-section" id="ag-remove-title">Remove access for {target.name}?</h2>
                <p className="t-secondary">This runner will stop and can’t connect again. Tests keep their results. You can add a runner again at any time.</p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button onClick={onClose}>Keep access</Button>
                    <Button variant="danger" loading={busy} onClick={remove}>
                        Remove access
                    </Button>
                </div>
            </div>
        </dialog>
    );
}

/**
 * Every access that exists for this project, whether or not a runner has used it yet. A download that nobody started still has an access
 * here, so it can be removed without opening the old token screen.
 */
export function AccessPanel({ projectId, agents, tokens: list, onChanged }: { projectId: string; agents: Agent[]; tokens: Fetched<AgentToken[]>; onChanged: () => void }) {
    const [removing, setRemoving] = useState<AccessTarget | null>(null);
    const active = (list.data ?? []).filter((t) => !t.revokedAt);
    // Nothing to list yet is not worth a card; the empty state of the runner list already invites the one action.
    if (!list.loading && !list.error && active.length === 0) return <span id="ark-access" />;

    return (
        <section className="card" aria-labelledby="ag-access-title" id="ark-access">
            <div className="card-head wrap">
                <KeyRound size={18} aria-hidden />
                <h2 className="t-section" id="ag-access-title">Access for runners</h2>
            </div>
            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error || !list.data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                </div>
            ) : (
                <>
                    <p className="t-secondary ag-pad">Each runner connects with its own access. Remove the ones you no longer use.</p>
                    <ul className="list divided" aria-label="Access for runners">
                        {active.map((t) => {
                            const used = agents.find((a) => a.tokenId === t.id);
                            const name = t.label ?? used?.name ?? "Unnamed runner";
                            return (
                                <li key={t.id} className="ag-token" data-access={t.id}>
                                    <div className="row">
                                        <h3 className="t-card">{name}</h3>
                                        <Tooltip content="The last 4 characters of the token, to tell them apart. The whole token was shown only once.">
                                            <code className="ag-hint" tabIndex={0}>{t.hint}</code>
                                        </Tooltip>
                                    </div>
                                    <div className="ag-facts">
                                        <span>
                                            Created <b>{relativeTime(t.createdAt)}</b>
                                        </span>
                                        <span>{used ? <>Used by <b>{used.name}</b></> : t.lastUsedAt ? <>Last used <b>{relativeTime(t.lastUsedAt)}</b></> : <>Not used yet</>}</span>
                                    </div>
                                    <div>
                                        <Button size="sm" variant="danger" onClick={() => setRemoving({ tokenId: t.id, name })} aria-label={`Remove access for ${name}`}>
                                            Remove access
                                        </Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
            {removing && (
                <RemoveAccessDialog
                    projectId={projectId}
                    target={removing}
                    onClose={() => setRemoving(null)}
                    onDone={() => {
                        setRemoving(null);
                        void list.reload();
                        onChanged();
                    }}
                />
            )}
        </section>
    );
}
