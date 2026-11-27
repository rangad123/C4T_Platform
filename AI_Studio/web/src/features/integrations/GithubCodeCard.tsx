import { CircleCheck, CircleX, GitPullRequest, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Badge, Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";

/** GET /api/projects/:id/code-host (routes/code-host.ts): never the token, the webhook secret or the webhook address. */
interface CodeHost {
    connected: boolean;
    connection?: { owner: string; repo: string; feedback: boolean; webhookSecretSet: boolean };
}
type ProjectRef = { id: string; name: string };

/** A webhook secret for GitHub to sign its deliveries with: the webhook refuses unsigned ones, so the first connect makes one. */
const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Connect GitHub: one project's repository for change-aware testing (docs/features/change-aware-testing.md). Three inputs: the
 * repository, the token and whether pull requests get a comment and a check. The webhook address (and the secret this page made for it)
 * is shown once, by the save that made it, as the API returns it. Changing it needs the permission to manage keys and connections.
 */
export function GithubCodeCard({ canManage }: { canManage: boolean }) {
    const projects = useFetch<ProjectRef[] | { projects: ProjectRef[] }>("/projects");
    const list = Array.isArray(projects.data) ? projects.data : (projects.data?.projects ?? []);
    const [projectId, setProjectId] = useState("");
    const id = projectId || list[0]?.id || "";
    const host = useFetch<CodeHost>(id ? `/projects/${id}/code-host` : null);
    const [editing, setEditing] = useState(false);
    const [repository, setRepository] = useState("");
    const [token, setToken] = useState("");
    const [feedback, setFeedback] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const [hook, setHook] = useState<{ url: string; secret?: string } | null>(null);
    const c = host.data?.connected ? host.data.connection : undefined;

    // Another project: start from what it has.
    useEffect(() => {
        setEditing(false);
        setError("");
        setResult(null);
        setHook(null);
    }, [id]);
    useEffect(() => {
        setRepository(c ? `${c.owner}/${c.repo}` : "");
        setFeedback(c?.feedback ?? false);
        setToken("");
    }, [c?.owner, c?.repo, c?.feedback]); // eslint-disable-line react-hooks/exhaustive-deps

    async function act(what: string, go: () => Promise<void>) {
        setBusy(what);
        setError("");
        setResult(null);
        try {
            await go();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(null);
        }
    }

    function save(e: FormEvent) {
        e.preventDefault();
        const [owner, repo, extra] = repository.trim().split("/");
        if (!owner || !repo || extra !== undefined) return setError("Enter the repository as owner/name, for example acme/shop.");
        if (!c && !token.trim()) return setError("Enter the access token.");
        const secret = c ? undefined : newSecret();
        void act("save", async () => {
            const r = await api<{ webhookUrl?: string }>(`/projects/${id}/code-host`, { method: "PUT", body: { owner, repo, feedback, ...(token.trim() ? { token: token.trim() } : {}), ...(secret ? { webhookSecret: secret } : {}) } });
            if (r.webhookUrl) setHook({ url: r.webhookUrl.startsWith("/") ? `${location.origin}${r.webhookUrl}` : r.webhookUrl, secret });
            setEditing(false);
            await host.reload();
        });
    }

    const form = (
        <form className="stack-sm int-form" onSubmit={save} aria-label="Connect GitHub">
            <div className="field">
                <label htmlFor="gh-code-repo">Repository</label>
                <input id="gh-code-repo" className="input" autoComplete="off" spellCheck={false} placeholder="acme/shop" value={repository} onChange={(e) => setRepository(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="gh-code-token">
                    Access token{c && <span className="t-meta"> (optional)</span>}
                </label>
                <input id="gh-code-token" className="input" type="password" autoComplete="new-password" placeholder={c ? "Leave empty to keep the stored one" : ""} value={token} onChange={(e) => setToken(e.target.value)} aria-describedby="gh-code-token-hint" />
                <span className="hint" id="gh-code-token-hint">
                    Stored encrypted and never shown again. It needs to read the repository’s pull requests{feedback ? ", and to write pull request comments and checks" : ""}.
                </span>
            </div>
            <label className="check">
                <input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} />
                <span>
                    <span className="title">Pull request feedback</span>
                    <span className="hint">Post one comment and a check on each pull request: the tests its change calls for, and how they went.</span>
                </span>
            </label>
            <p className="t-meta">We check the repository with the token before saving.</p>
            <div className="row" style={{ gap: 8 }}>
                <Button type="submit" variant="primary" loading={busy === "save"}>
                    {c ? "Save changes" : "Connect GitHub"}
                </Button>
                {c && (
                    <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                        Cancel
                    </Button>
                )}
            </div>
        </form>
    );

    return (
        <article className="card card-pad stack-sm int-card" data-testid="integration-code-host" aria-labelledby="int-card-code-host">
            <div className="row">
                <GitPullRequest size={20} aria-hidden />
                <h3 className="t-card" id="int-card-code-host">
                    Connect GitHub
                </h3>
                <span className="spacer" />
                {id && host.data && <Badge tone={c ? "success" : "neutral"}>{c ? "Connected" : "Not connected"}</Badge>}
            </div>
            <p className="t-secondary">Connect a project’s repository. Each pull request then gets the tests its change calls for; the results show on the project’s After a deploy page.</p>
            {list.length === 0 ? (
                <p className="t-meta">{projects.loading ? "Loading projects…" : "Create a project first."}</p>
            ) : (
                <>
                    {list.length > 1 && (
                        <div className="field">
                            <label htmlFor="gh-code-project">Project</label>
                            <select id="gh-code-project" className="input" value={id} onChange={(e) => setProjectId(e.target.value)}>
                                {list.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
                    {c && !editing && (
                        <div className="int-conn stack-sm" data-testid="code-host-connection">
                            <p>
                                <b>
                                    {c.owner}/{c.repo}
                                </b>{" "}
                                <span className="t-meta">· pull request feedback {c.feedback ? "on" : "off"}</span>
                            </p>
                            <p className="t-meta">
                                Pull request lines show on the project’s <a href={routes.runs(id, "deploys")}>After a deploy</a> page.
                            </p>
                            {canManage && (
                                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                    <Button size="sm" loading={busy === "test"} onClick={() => void act("test", async () => setResult(await api<{ ok: boolean; message: string }>(`/projects/${id}/code-host/test`, { method: "POST" }).then((r) => ({ ok: r.ok, text: r.message }))))}>
                                        Test the connection
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                                        Change
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        icon={Trash2}
                                        loading={busy === "remove"}
                                        onClick={() => {
                                            if (confirm(`Disconnect ${c.owner}/${c.repo}? Pull requests are no longer checked.`))
                                                void act("remove", async () => {
                                                    await api(`/projects/${id}/code-host`, { method: "DELETE" });
                                                    setHook(null);
                                                    await host.reload();
                                                });
                                        }}
                                    >
                                        Disconnect
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                    {hook && (
                        <Callout tone="info" title="Add this webhook in GitHub">
                            <span className="stack-sm" style={{ display: "grid" }} data-testid="code-host-webhook">
                                <span>
                                    In the repository’s Settings, Webhooks, add one with this payload URL, content type application/json, and the events Pull requests and Deployment statuses. It is shown only now.
                                </span>
                                <span>
                                    Payload URL: <code className="mono">{hook.url}</code>
                                </span>
                                {hook.secret && (
                                    <span>
                                        Secret: <code className="mono">{hook.secret}</code>
                                    </span>
                                )}
                            </span>
                        </Callout>
                    )}
                    {host.data && !c && canManage && form}
                    {c && editing && canManage && form}
                    {host.data && !c && !canManage && <p className="t-meta">Connecting a repository needs the permission to manage keys and connections.</p>}
                </>
            )}
            {host.error && <Callout tone="warning">{describeApiError(host.error)}</Callout>}
            {error && <Callout tone="danger">{error}</Callout>}
            {result && (
                <p className={result.ok ? "row t-meta" : "row t-meta error-text"} role="status">
                    {result.ok ? <CircleCheck size={16} aria-hidden /> : <CircleX size={16} aria-hidden />}
                    <span>{result.text}</span>
                </p>
            )}
        </article>
    );
}
