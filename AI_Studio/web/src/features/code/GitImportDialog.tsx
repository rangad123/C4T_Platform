import { GitBranch, RefreshCw, Search, Unlink } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { FieldHelp } from "../../components/Tooltip";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { capi, errorText, gitUrlProblem, shortCommit } from "./code";
import { Modal } from "./Modal";
import "./code.css";

interface PreviewFile { path: string; title: string; bytes: number; tests: number; problems: string[] }
interface Skipped { path: string; reason: string; editedHere?: boolean }
interface Preview { commit: string; files: PreviewFile[]; skipped: Skipped[] }
interface Imported { commit: string; imported: Array<{ testId: string; path: string; created: boolean }>; skipped: Skipped[]; jobId: string | null; note?: string }
interface Repo { id: string; host: string; path: string; ref: string; commit: string; importedAt: string; tests: number }

const kb = (n: number) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Import code tests from a Git repository. The access token is write-only: it lives in this component's state while the
 * dialog is open, goes out with the request that needs it, and is never put in storage, the address bar or the page. Closing drops it.
 */
export function GitImportDialog({ projectId, onClose, onImported }: { projectId: string; onClose: () => void; onImported: () => void }) {
    const [url, setUrl] = useState("");
    const [ref, setRef] = useState("");
    const [folder, setFolder] = useState("");
    const [token, setToken] = useState("");
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState<"" | "preview" | "import">("");
    const [error, setError] = useState("");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [result, setResult] = useState<Imported | null>(null);
    const repos = useFetch<Repo[]>(`/projects/${projectId}/git-imports`);

    const urlProblem = gitUrlProblem(url);
    const body = (dryRun: boolean) => ({
        url: url.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(folder.trim() ? { path: folder.trim() } : {}),
        ...(token ? { token } : {}),
        ...(dryRun ? { dryRun: true } : {}),
    });
    const importable = preview?.files.filter((f) => f.problems.length === 0) ?? [];
    const changed = () => {
        setPreview(null);
        setResult(null);
        setError("");
    };

    async function runPreview() {
        setTouched(true);
        if (urlProblem) return;
        setBusy("preview");
        setError("");
        setResult(null);
        try {
            setPreview(await capi<Preview>(`/projects/${projectId}/git-imports`, { method: "POST", body: body(true) }));
        } catch (e) {
            setPreview(null);
            setError(errorText(e));
        } finally {
            setBusy("");
        }
    }

    async function runImport() {
        setBusy("import");
        setError("");
        try {
            const r = await capi<Imported>(`/projects/${projectId}/git-imports`, { method: "POST", body: body(false) });
            setResult(r);
            setPreview(null);
            setToken(""); // used once; nothing keeps it
            onImported();
            void repos.reload();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy("");
        }
    }

    const created = result?.imported.filter((i) => i.created).length ?? 0;
    const updated = (result?.imported.length ?? 0) - created;

    return (
        <Modal title="Import from Git" titleId="git-import-title" wide onClose={onClose} foot={<Button onClick={onClose}>Close</Button>}>
            <form
                className="stack-sm"
                onSubmit={(e) => {
                    e.preventDefault();
                    void runPreview();
                }}
                autoComplete="off"
                noValidate
            >
                <p className="t-secondary">Bring in Playwright test files from a repository. They become code tests, and you can refresh them when the repository changes.</p>
                <div className="field">
                    <label htmlFor="git-url">Repository address</label>
                    <input
                        id="git-url"
                        className="input"
                        type="url"
                        inputMode="url"
                        value={url}
                        placeholder="https://github.com/your-team/your-tests"
                        aria-invalid={touched && !!urlProblem}
                        aria-describedby={touched && urlProblem ? "git-url-err" : undefined}
                        onChange={(e) => { setUrl(e.target.value); changed(); }}
                    />
                    {touched && urlProblem && (
                        <span className="error-text" id="git-url-err">
                            {urlProblem}
                        </span>
                    )}
                </div>
                <div className="code-git-grid">
                    <div className="field">
                        <FieldHelp htmlFor="git-ref" label="Branch or tag (optional)" help="Empty means the repository's default branch. A commit id works too." />
                        <input id="git-ref" className="input" value={ref} placeholder="main" onChange={(e) => { setRef(e.target.value); changed(); }} />
                    </div>
                    <div className="field">
                        <label htmlFor="git-folder">Subfolder (optional)</label>
                        <input id="git-folder" className="input" value={folder} placeholder="tests/e2e" onChange={(e) => { setFolder(e.target.value); changed(); }} />
                    </div>
                </div>
                <div className="field">
                    <label htmlFor="git-token">Access token (optional)</label>
                    <input id="git-token" className="input" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} aria-describedby="git-token-hint" />
                    <span className="hint" id="git-token-hint">
                        Only for private repositories. It is used for this one request and is never stored, here or on the server.
                    </span>
                </div>
                <div className="row">
                    <Button type="submit" variant={preview ? "secondary" : "primary"} icon={Search} loading={busy === "preview"} disabled={!!busy}>
                        Preview
                    </Button>
                    {preview && (
                        <Button variant="primary" icon={GitBranch} loading={busy === "import"} disabled={!!busy || importable.length === 0} onClick={() => void runImport()}>
                            Import {plural(importable.length, "file", "files")}
                        </Button>
                    )}
                </div>
            </form>

            {error && <Callout tone="danger" title="That didn’t work">{error}</Callout>}

            {preview && (
                <div className="stack-sm" data-testid="git-preview">
                    <h3 className="t-card">
                        Found {plural(preview.files.length, "file", "files")} at commit <code>{shortCommit(preview.commit)}</code>
                    </h3>
                    {preview.files.length === 0 && <p className="muted">No Playwright test files were found here. Check the branch and the subfolder.</p>}
                    {preview.files.length > 0 && (
                        <ul className="divided code-git-files card">
                            {preview.files.map((f) => (
                                <li key={f.path} className="code-git-file">
                                    <span className="code-git-name">
                                        <span className="t-card">{f.title}</span>
                                        <span className="t-meta code-path">{f.path}</span>
                                    </span>
                                    <span className="t-meta">
                                        {plural(f.tests, "test", "tests")}, {kb(f.bytes)}
                                    </span>
                                    {f.problems.length > 0 ? (
                                        <span className="code-git-problems">
                                            <Badge tone="warning">Has problems</Badge>
                                            <ul className="bullets">
                                                {f.problems.map((p, i) => (
                                                    <li key={i}>{p}</li>
                                                ))}
                                            </ul>
                                        </span>
                                    ) : (
                                        <Badge tone="success">Ready</Badge>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {preview.files.some((f) => f.problems.length > 0) && <p className="t-meta">Files with problems are not imported. Fix them in the repository, then preview again.</p>}
                    {preview.skipped.length > 0 && (
                        <div>
                            <h4 className="t-card">Skipped</h4>
                            <ul className="bullets" data-testid="git-skipped">
                                {preview.skipped.map((s) => (
                                    <li key={s.path}>
                                        <span className="code-path">{s.path}</span>: {s.reason}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {result && (
                <div data-testid="git-result">
                    <Callout
                        tone="success"
                        title="Import finished"
                        actions={<a className="btn btn-sm" href={routes.tests(projectId)} onClick={onClose}>See the tests</a>}
                    >
                        {plural(created, "test", "tests")} created, {plural(updated, "test", "tests")} updated, {plural(result.skipped.length, "file", "files")} skipped.{" "}
                        {result.jobId ? "We are running them now." : `Not run yet: ${result.note ?? "no run was started."}`}
                    </Callout>
                    {result.skipped.length > 0 && (
                        <ul className="bullets" style={{ marginTop: 10 }}>
                            {result.skipped.map((s) => (
                                <li key={s.path}>
                                    <span className="code-path">{s.path}</span>: {s.reason}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <section aria-labelledby="git-repos-title" className="stack-sm">
                <h3 className="t-section" id="git-repos-title">Repositories</h3>
                {repos.loading ? (
                    <ListSkeleton rows={2} />
                ) : repos.error ? (
                    <ErrorState error={friendlyError(repos.error.message)} onRetry={repos.reload} />
                ) : (repos.data ?? []).length === 0 ? (
                    <p className="muted">No repository is linked yet. Preview and import one above.</p>
                ) : (
                    <ul className="divided card code-repos" data-testid="repos">
                        {repos.data!.map((r) => (
                            <RepoItem key={r.id} projectId={projectId} repo={r} onChanged={() => { void repos.reload(); onImported(); }} />
                        ))}
                    </ul>
                )}
            </section>
        </Modal>
    );
}

function RepoItem({ projectId, repo, onChanged }: { projectId: string; repo: Repo; onChanged: () => void }) {
    const [state, setState] = useState<"" | "check" | "refresh" | "remove">("");
    const [asking, setAsking] = useState<"" | "refresh" | "remove">("");
    const [token, setToken] = useState("");
    const [note, setNote] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);
    const base = `/projects/${projectId}/git-imports/${repo.id}`;

    async function check() {
        setState("check");
        setNote(null);
        try {
            const r = await capi<{ upToDate: boolean; newCommit?: string; changed: Array<{ testId: string; path: string; editedHere?: boolean }> }>(`${base}/check`, { method: "POST" });
            const edited = r.changed.filter((c) => c.editedHere).length;
            // A script edited here since the last import is kept by a refresh: say so before anyone presses it.
            const keep = edited ? ` ${plural(edited, "test was", "tests were")} edited here, so a refresh leaves ${edited === 1 ? "it" : "them"} as ${edited === 1 ? "it is" : "they are"}.` : "";
            setNote(r.upToDate ? { tone: "success", text: "Up to date with the repository." } : { tone: "warning", text: `${r.newCommit ? `A newer commit ${shortCommit(r.newCommit)} exists. ` : ""}${plural(r.changed.length, "test differs", "tests differ")}${r.changed.length ? `: ${r.changed.map((c) => c.path).join(", ")}` : ""}. Refresh to update them.${keep}` });
        } catch (e) {
            setNote({ tone: "danger", text: errorText(e) });
        } finally {
            setState("");
        }
    }
    async function refresh() {
        setState("refresh");
        setNote(null);
        try {
            const r = await capi<Imported>(`${base}/refresh`, { method: "POST", body: token ? { token } : {} });
            setToken("");
            setAsking("");
            const kept = r.skipped.filter((s) => s.editedHere).length;
            setNote({ tone: "success", text: `Refreshed: ${plural(r.imported.filter((i) => !i.created).length, "test", "tests")} updated, ${plural(r.imported.filter((i) => i.created).length, "test", "tests")} created. ${kept ? `${plural(kept, "test", "tests")} edited here ${kept === 1 ? "was" : "were"} left as ${kept === 1 ? "it is" : "they are"}. ` : ""}${r.jobId ? "We are running them now." : ""}` });
            onChanged();
        } catch (e) {
            setNote({ tone: "danger", text: errorText(e) });
        } finally {
            setState("");
        }
    }
    async function remove() {
        setState("remove");
        setNote(null);
        try {
            await capi(base, { method: "DELETE" });
            onChanged();
        } catch (e) {
            setNote({ tone: "danger", text: errorText(e) });
            setState("");
        }
    }

    return (
        <li className="code-repo" data-repo={repo.id}>
            <div className="code-repo-main">
                <span className="t-card code-path">
                    {repo.host}/{repo.path}
                </span>
                <span className="t-meta">
                    {repo.ref}, commit {shortCommit(repo.commit)}, imported {relativeTime(repo.importedAt)}, {plural(repo.tests, "test", "tests")}
                </span>
            </div>
            <div className="code-repo-acts">
                <Button size="sm" icon={Search} loading={state === "check"} disabled={!!state} onClick={() => void check()} aria-label={`Check ${repo.path} for updates`} tip="Compares the imported tests with the newest commit. Nothing is changed.">
                    Check for updates
                </Button>
                <Button size="sm" icon={RefreshCw} disabled={!!state} onClick={() => setAsking(asking === "refresh" ? "" : "refresh")} aria-expanded={asking === "refresh"} aria-label={`Refresh ${repo.path}`}>
                    Refresh
                </Button>
                <Button size="sm" variant="ghost" icon={Unlink} disabled={!!state} onClick={() => setAsking(asking === "remove" ? "" : "remove")} aria-expanded={asking === "remove"} aria-label={`Remove the link to ${repo.path}`}>
                    Remove link
                </Button>
            </div>
            {asking === "refresh" && (
                <div className="code-repo-ask">
                    <div className="field">
                        <label htmlFor={`tok-${repo.id}`}>Access token (only if the repository is private)</label>
                        <input id={`tok-${repo.id}`} className="input" type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} />
                        <span className="hint">Used for this refresh only. It is never stored.</span>
                    </div>
                    <Button variant="primary" size="sm" loading={state === "refresh"} onClick={() => void refresh()}>
                        Refresh from the repository
                    </Button>
                </div>
            )}
            {asking === "remove" && (
                <div className="code-repo-ask">
                    <p className="t-secondary">The tests stay as code tests. Only the link to the repository is removed.</p>
                    <Button variant="danger" size="sm" loading={state === "remove"} onClick={() => void remove()}>
                        Remove the link
                    </Button>
                </div>
            )}
            {note && (
                <div className="code-repo-note" role="status">
                    <Callout tone={note.tone}>{note.text}</Callout>
                </div>
            )}
        </li>
    );
}
