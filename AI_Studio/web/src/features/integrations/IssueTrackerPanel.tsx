import { Bug, CircleCheck, CircleX, Plug, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout, Disclosure, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { SentryConnect } from "../sentry/SentryConnect";
import { TRACKER_LABEL, describeConnection, type Integration, type TrackerKind } from "./types";

/** Validation problems from the server, as sentences ("Project keys are letters and numbers, like SHOP"). */
function connectError(e: unknown): string {
    if (e instanceof ApiError && e.status === 400 && Array.isArray(e.details)) {
        const msgs = (e.details as Array<{ message?: string }>).map((d) => d.message).filter(Boolean);
        if (msgs.length) return msgs.join(" ");
    }
    return describeApiError(e);
}

/** "acme/shop", "https://github.com/acme/shop" or ".../shop.git" → owner and repository. */
function parseRepo(text: string): { owner: string; repo: string } | null {
    const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(text.trim());
    return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/**
 * Connect GitHub Issues or Jira to a project, check the connection, and remove it. Shown only on request
 * (Tests → More actions → Issue tracker), like the mobile app panel.
 */
export function IssueTrackerPanel({ projectId, onClose }: { projectId: string; onClose?: () => void }) {
    const list = useFetch<Integration[]>(`/projects/${projectId}/integrations`);
    const [adding, setAdding] = useState(false);
    const connections = list.data ?? [];

    return (
        <section className="card card-pad stack-sm" aria-label="Issue tracker">
            <div className="row">
                <Bug size={18} aria-hidden />
                <h2 className="t-section">Issue tracker</h2>
                <span className="spacer" />
                {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
            </div>
            <p className="t-secondary">Connect GitHub, Jira or Notion to create an issue straight from a problem a test found. Your access token is stored encrypted and is never shown again.</p>

            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error ? (
                <Callout tone="danger" title="We couldn’t load your connections" actions={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>{describeApiError(list.error)}</Callout>
            ) : (
                <>
                    {connections.length === 0 && !adding && <Callout tone="neutral" title="Nothing connected yet">Connect an issue tracker, then open a test that found a problem and choose “Create issue”.</Callout>}
                    {connections.length > 0 && (
                        <ul className="list divided" aria-label="Connected issue trackers">
                            {connections.map((c) => (
                                <li key={c.id}>
                                    <Connection c={c} onRemoved={() => void list.reload()} />
                                </li>
                            ))}
                        </ul>
                    )}
                    {adding ? (
                        <ConnectForm projectId={projectId} onDone={() => { setAdding(false); void list.reload(); }} onCancel={() => setAdding(false)} />
                    ) : (
                        <div className="row">
                            <Button variant="primary" icon={Plug} onClick={() => setAdding(true)}>{connections.length ? "Connect another" : "Connect an issue tracker"}</Button>
                        </div>
                    )}
                </>
            )}
            <SentryConnect projectId={projectId} />
        </section>
    );
}

function Connection({ c, onRemoved }: { c: Integration; onRemoved: () => void }) {
    const [state, setState] = useState<{ kind: "idle" } | { kind: "testing" } | { kind: "ok" | "bad"; text: string }>({ kind: "idle" });
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function test() {
        setState({ kind: "testing" });
        try {
            const r = await api<{ ok: boolean; message: string }>(`/integrations/${c.id}/test`, { method: "POST" });
            setState({ kind: r.ok ? "ok" : "bad", text: r.message });
        } catch (e) {
            setState({ kind: "bad", text: describeApiError(e) });
        }
    }
    async function remove() {
        setBusy(true);
        setError("");
        try {
            await api(`/integrations/${c.id}`, { method: "DELETE" });
            onRemoved();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <div className="list-row" style={{ alignItems: "flex-start" }}>
            <span className="main">
                <span className="title">{c.name}</span>
                <span className="meta">{TRACKER_LABEL[c.kind]} · {describeConnection(c)}</span>
                {state.kind === "ok" && <span className="meta" role="status" style={{ color: "var(--status-success-fg)" }}><CircleCheck size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> {state.text}</span>}
                {state.kind === "bad" && <span className="meta" role="alert" style={{ color: "var(--status-error-fg)" }}><CircleX size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> {state.text}</span>}
                {error && <span className="meta" role="alert" style={{ color: "var(--status-error-fg)" }}>{error}</span>}
                {confirm && <span className="meta">Remove this connection? Issues already created stay where they are.</span>}
            </span>
            <span className="tail">
                {confirm ? (
                    <>
                        <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>Yes, remove</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>Keep</Button>
                    </>
                ) : (
                    <>
                        <Button size="sm" loading={state.kind === "testing"} tip="Checks the saved address and token with a read-only request. No issue is created." onClick={() => void test()}>Test connection</Button>
                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${c.name}`} onClick={() => setConfirm(true)}>Remove</Button>
                    </>
                )}
            </span>
        </div>
    );
}

function ConnectForm({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
    const [kind, setKind] = useState<TrackerKind>("github");
    const [f, setF] = useState({ repo: "", token: "", apiUrl: "", baseUrl: "", projectKey: "", email: "", issueType: "Bug", databaseId: "", titleProperty: "Name", notionUrl: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
        setF((s) => ({ ...s, [k]: e.target.value }));
        setError("");
    };

    const ready = kind === "github" ? Boolean(f.repo.trim() && f.token.trim()) : kind === "notion" ? Boolean(f.databaseId.trim() && f.token.trim()) : Boolean(f.baseUrl.trim() && f.projectKey.trim() && f.email.trim() && f.token.trim());

    async function connect(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        let body: Record<string, unknown>;
        if (kind === "github") {
            const r = parseRepo(f.repo);
            if (!r) return setError("Enter the repository as owner/name, for example acme/shop.");
            body = { kind, ...r, token: f.token.trim(), ...(f.apiUrl.trim() ? { apiUrl: f.apiUrl.trim() } : {}) };
        } else if (kind === "notion") {
            // The server finds the database id in a pasted link.
            body = { kind, databaseId: f.databaseId.trim(), titleProperty: f.titleProperty.trim() || "Name", token: f.token.trim(), ...(f.notionUrl.trim() ? { apiUrl: f.notionUrl.trim() } : {}) };
        } else {
            body = { kind, baseUrl: f.baseUrl.trim(), projectKey: f.projectKey.trim(), email: f.email.trim(), token: f.token.trim(), issueType: f.issueType.trim() || "Bug" };
        }
        setBusy(true);
        try {
            // The server checks the address and token with a real call before saving anything.
            await api(`/projects/${projectId}/integrations`, { method: "POST", body });
            onDone();
        } catch (err) {
            setError(connectError(err));
            setBusy(false);
        }
    }

    return (
        <form className="stack-sm" onSubmit={connect} aria-label="Connect an issue tracker">
            <div className="chips" role="group" aria-label="Issue tracker">
                {(["github", "jira", "notion"] as const).map((k) => (
                    <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => { setKind(k); setError(""); }}>{TRACKER_LABEL[k]}</button>
                ))}
            </div>

            {kind === "github" ? (
                <>
                    <div className="field">
                        <label htmlFor="it-repo">Repository</label>
                        <input id="it-repo" className="input" value={f.repo} placeholder="acme/shop" autoComplete="off" onChange={set("repo")} />
                        <p className="t-meta">The GitHub repository that should receive the issues, as owner/name.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="it-token">Access token</label>
                        <input id="it-token" className="input" type="password" value={f.token} autoComplete="off" onChange={set("token")} />
                        <p className="t-meta">A GitHub token that can create issues in that repository (a fine-grained token with “Issues: read and write” is enough).</p>
                    </div>
                    <Disclosure label="GitHub Enterprise Server">
                        <div className="field">
                            <label htmlFor="it-api">API address</label>
                            <input id="it-api" className="input" value={f.apiUrl} placeholder="https://github.example.com/api/v3" autoComplete="off" onChange={set("apiUrl")} />
                            <p className="t-meta">Only if your company hosts its own GitHub. Leave empty for github.com.</p>
                        </div>
                    </Disclosure>
                </>
            ) : kind === "notion" ? (
                <>
                    <div className="field">
                        <label htmlFor="it-db">Notion database</label>
                        <input id="it-db" className="input" value={f.databaseId} placeholder="https://www.notion.so/yourteam/…" autoComplete="off" onChange={set("databaseId")} />
                        <p className="t-meta">Paste the link to the database (open it as a full page and copy the link), or its id. Each issue becomes a new page in it.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="it-notion-token">Notion integration token</label>
                        <input id="it-notion-token" className="input" type="password" value={f.token} autoComplete="off" onChange={set("token")} />
                        <p className="t-meta">Create an internal integration in Notion, copy its token, then open the database, choose Connections and add the integration to it.</p>
                    </div>
                    <div className="field">
                        <label htmlFor="it-title-col">Title column</label>
                        <input id="it-title-col" className="input" value={f.titleProperty} autoComplete="off" onChange={set("titleProperty")} />
                        <p className="t-meta">The name of the database’s title column. In most databases it is Name.</p>
                    </div>
                    <Disclosure label="Reaching Notion through a proxy">
                        <div className="field">
                            <label htmlFor="it-notion-url">Notion address</label>
                            <input id="it-notion-url" className="input" value={f.notionUrl} placeholder="https://notion-proxy.example.com" autoComplete="off" onChange={set("notionUrl")} />
                            <p className="t-meta">Only if your network needs one. Leave empty to use Notion directly.</p>
                        </div>
                    </Disclosure>
                </>
            ) : (
                <>
                    <div className="field">
                        <label htmlFor="it-base">Jira address</label>
                        <input id="it-base" className="input" value={f.baseUrl} placeholder="https://yourcompany.atlassian.net" autoComplete="off" onChange={set("baseUrl")} />
                    </div>
                    <div className="grid-2">
                        <div className="field">
                            <label htmlFor="it-key">Project key</label>
                            <input id="it-key" className="input" value={f.projectKey} placeholder="SHOP" autoComplete="off" onChange={set("projectKey")} />
                        </div>
                        <div className="field">
                            <label htmlFor="it-type">Issue type</label>
                            <input id="it-type" className="input" value={f.issueType} autoComplete="off" onChange={set("issueType")} />
                        </div>
                    </div>
                    <div className="field">
                        <label htmlFor="it-email">Your Atlassian account email</label>
                        <input id="it-email" className="input" type="email" value={f.email} autoComplete="off" onChange={set("email")} />
                    </div>
                    <div className="field">
                        <label htmlFor="it-token">API token</label>
                        <input id="it-token" className="input" type="password" value={f.token} autoComplete="off" onChange={set("token")} />
                        <p className="t-meta">Create one in your Atlassian account under Security → API tokens.</p>
                    </div>
                </>
            )}

            {error && <Callout tone="danger" title="We couldn’t connect">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>{busy ? "Checking…" : "Connect"}</Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
}
