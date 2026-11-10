import { Check, Copy, KeyRound, Plus, Rocket } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError, friendlyError } from "../../lib/labels";
import { curlExample, type TriggerList, type TriggerToken } from "./triggers";
import "./triggers.css";

/**
 * Deploy triggers: a way for a pipeline to run this project's tests the moment a deploy finishes, without a schedule.
 * A token is shown once when it is made; only a fingerprint is kept, and it can be revoked at any time.
 */
export function TriggersPanel({ projectId, reloadKey = 0 }: { projectId: string; reloadKey?: number }) {
    const list = useFetch<TriggerList>(`/projects/${projectId}/triggers`);
    useEffect(() => {
        if (reloadKey > 0) void list.reload();
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
    // Deploy tokens are credentials: making and revoking them needs ai_studio.ai_keys.manage in this project.
    const noManage = useHere(projectId).why("ai_studio.ai_keys.manage");
    const [adding, setAdding] = useState(false);
    const [fresh, setFresh] = useState<{ token: string; label: string | null } | null>(null);
    const active = list.data?.tokens.filter((t) => !t.revokedAt) ?? [];
    const revoked = list.data?.tokens.filter((t) => t.revokedAt) ?? [];

    return (
        <section className="card" aria-labelledby="triggers-title">
            <div className="card-head wrap">
                <Rocket size={18} aria-hidden />
                <h2 className="t-section" id="triggers-title">Run after a deploy</h2>
                <span className="spacer" />
                {active.length > 0 && !adding && (
                    <Button size="sm" icon={Plus} disabled={Boolean(noManage)} tip={noManage} onClick={() => setAdding(true)}>
                        New token
                    </Button>
                )}
            </div>
            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error || !list.data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                </div>
            ) : (
                <>
                    {active.length === 0 && !adding && !fresh && (
                        <EmptyState icon={KeyRound} title="No deploy tokens yet" actions={<Button variant="primary" icon={Plus} disabled={Boolean(noManage)} tip={noManage} onClick={() => setAdding(true)}>Create a token</Button>}>
                            Give your deploy pipeline a token and it can start a re-run of all tests as soon as a release is live, then ask for the result.
                        </EmptyState>
                    )}
                    {fresh && <NewTokenNotice token={fresh.token} label={fresh.label} onDone={() => setFresh(null)} />}
                    {active.length > 0 && (
                        <ul className="list divided">
                            {active.map((t) => (
                                <li key={t.id}>
                                    <TokenRow t={t} projectId={projectId} onChanged={list.reload} mayRevoke={!noManage} />
                                </li>
                            ))}
                        </ul>
                    )}
                    {adding && !noManage && (
                        <NewTokenForm
                            projectId={projectId}
                            onCancel={() => setAdding(false)}
                            onCreated={(token, label) => {
                                setAdding(false);
                                setFresh({ token, label });
                                void list.reload();
                            }}
                        />
                    )}
                    {revoked.length > 0 && <p className="t-meta" style={{ padding: "0 20px 14px" }}>{revoked.length} revoked {revoked.length === 1 ? "token no longer works" : "tokens no longer work"}.</p>}
                    {active.length > 0 && <p className="t-meta" style={{ padding: "0 20px 14px" }}>A token can start one run every {list.data.minSecondsBetweenRuns} seconds. Runs it starts are marked “After a deploy” in Runs.</p>}
                </>
            )}
        </section>
    );
}

function TokenRow({ t, projectId, onChanged, mayRevoke }: { t: TriggerToken; projectId: string; onChanged: () => Promise<void>; mayRevoke: boolean }) {
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const name = t.label ?? "Unnamed token";

    async function revoke() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/triggers/${t.id}`, { method: "DELETE" });
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
            setConfirm(false);
        }
    }

    return (
        <div className="trig-row" data-token={t.id}>
            <div className="row">
                <h3 className="t-card">{name}</h3>
                <Badge tone="neutral" tip="The token’s last 4 characters, to tell tokens apart. The whole token was shown only once, when it was made.">ends in {t.hint}</Badge>
                {t.allowUrl && <Badge tone="warning" tip="The pipeline may send another address, such as a preview deploy. The run then tests that address with the project’s sign-in details.">May change the address</Badge>}
                {t.runbookName && <Badge tone="info" title="A deploy starts this run sequence instead of a plain re-run">Runs the run sequence “{t.runbookName}”</Badge>}
            </div>
            <div className="facts">
                <span>Created <b>{relativeTime(t.createdAt)}</b></span>
                <span>Last used <b>{t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}</b></span>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            {mayRevoke && <div className="acts">
                {confirm ? (
                    <>
                        <span className="t-secondary">Stop this token from working?</span>
                        <Button size="sm" variant="danger" loading={busy} onClick={revoke}>Yes, revoke it</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
                    </>
                ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Revoke: ${name}`}>
                        Revoke
                    </Button>
                )}
            </div>}
        </div>
    );
}

function NewTokenForm({ projectId, onCancel, onCreated }: { projectId: string; onCancel: () => void; onCreated: (token: string, label: string | null) => void }) {
    const [label, setLabel] = useState("");
    const [allowUrl, setAllowUrl] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function create() {
        setBusy(true);
        setError("");
        try {
            const out = await api<{ token: string; label: string | null }>(`/projects/${projectId}/triggers`, { method: "POST", body: { ...(label.trim() ? { label: label.trim() } : {}), allowUrl } });
            onCreated(out.token, out.label);
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <form
            className="trig-form"
            aria-label="New deploy token"
            onSubmit={(e) => {
                e.preventDefault();
                void create();
            }}
        >
            <div className="field">
                <label htmlFor="trig-label">Name (optional)</label>
                <input id="trig-label" className="input" value={label} maxLength={60} placeholder="For example: GitHub Actions" onChange={(e) => setLabel(e.target.value)} />
                <p className="hint">Helps you tell tokens apart. It also appears next to the runs this token starts.</p>
            </div>
            <label className="check">
                <input type="checkbox" checked={allowUrl} onChange={(e) => setAllowUrl(e.target.checked)} />
                <span>
                    <span className="title">Let the pipeline send a different address</span>
                    <span className="hint">For preview deployments. The project’s address and sign-in details then move to the address the pipeline sends, so only turn this on for addresses you control.</span>
                </span>
            </label>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>Create token</Button>
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
}

function NewTokenNotice({ token, label, onDone }: { token: string; label: string | null; onDone: () => void }) {
    const [copied, setCopied] = useState(false);
    const example = curlExample(window.location.origin, token);

    async function copy() {
        try {
            await navigator.clipboard.writeText(token);
            setCopied(true);
        } catch {
            setCopied(false); // clipboard blocked: the token is selectable on screen
        }
    }

    return (
        <div className="trig-new" role="region" aria-label="Your new token">
            <Callout tone="warning" title={`Copy the token${label ? ` for “${label}”` : ""} now`}>
                This is the only time it is shown. We keep just a fingerprint, so if you lose it you will need to make a new one.
            </Callout>
            <div className="trig-secret">
                <code data-testid="new-token">{token}</code>
                <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>
                    {copied ? "Copied" : "Copy token"}
                </Button>
            </div>
            <div>
                <p className="t-secondary" style={{ marginBottom: 6 }}>
                    Add a step to your deploy pipeline that calls this address after the release. Ask for the result with <code>GET /api/triggers/&lt;token&gt;/status/&lt;jobId&gt;</code>; add <code>callbackUrl</code> to be told when it finishes.
                </p>
                <pre className="code"><code>{example}</code></pre>
            </div>
            <div className="row">
                <Button variant="primary" onClick={onDone}>I have copied it</Button>
            </div>
        </div>
    );
}
