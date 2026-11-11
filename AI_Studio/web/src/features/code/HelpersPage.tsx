import { Check, Copy, Eye, FilePlus2, Pencil, Puzzle, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { usePage } from "../../components/Shell";
import { Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, PageHeader } from "../../components/ui";
import { formatBytes, relativeTime } from "../../lib/format";
import { useConfig, useDocumentTitle, useFetch } from "../../lib/hooks";
import { friendlyError, describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useHere } from "../auth/project-access";
import { helperNameProblem, helperStarter, type ConfigWithCode, type SaveResult } from "./code";
import { Modal } from "../../components/Modal";
import { Workbench } from "./Workbench";
import "./code.css";
import { api, ApiError } from "../../api";

interface Helper {
    name: string;
    bytes: number;
    updatedAt: string;
    usedBy: number;
}
const MAX_HELPERS = 20;
const importLine = (name: string) => `import { x } from "./helpers/${name}";`;

/** Tests that block a delete, in whatever shape the platform lists them. */
function blockingTests(body: Record<string, unknown>): string[] {
    const raw = (body.tests ?? (body.details as { tests?: unknown } | undefined)?.tests ?? body.usedBy) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? String((t as { title?: string; testId?: string; id?: string }).title ?? (t as { testId?: string }).testId ?? (t as { id?: string }).id ?? "") : "")).filter(Boolean);
}

/** `#/projects/:id/helpers`: shared modules that code tests import. */
export function HelpersPage({ id }: { id: string }) {
    const project = useFetch<{ name: string }>(`/projects/${id}`);
    const helpers = useFetch<Helper[]>(`/projects/${id}/helpers`);
    const cfg = useConfig() as ConfigWithCode | undefined;
    useDocumentTitle(project.data ? `Shared helpers · ${project.data.name}` : "Shared helpers");
    usePage({ crumbs: [{ label: "Projects", href: routes.home }, { label: project.data?.name ?? "…", href: routes.project(id) }, { label: "Test scripts", href: routes.scripts(id) }, { label: "Shared helpers" }], nav: "projects" });

    const [newName, setNewName] = useState("");
    const [nameTouched, setNameTouched] = useState(false);
    const [editing, setEditing] = useState<{ name: string; initial: string; key: number; fresh: boolean } | null>(null);
    const [opening, setOpening] = useState("");
    const [openError, setOpenError] = useState("");
    const [dirty, setDirty] = useState(false);
    const [closeAsk, setCloseAsk] = useState(false);
    const [deleting, setDeleting] = useState<Helper | null>(null);
    const [delBusy, setDelBusy] = useState(false);
    const [delError, setDelError] = useState<{ text: string; tests: string[] } | null>(null);
    const [notice, setNotice] = useState("");
    const [copied, setCopied] = useState("");
    /** The clipboard refused (a page not served over https, or the browser said no): the button says so instead of "Copied". */
    const [copyFailed, setCopyFailed] = useState(false);
    // Adding and changing helpers needs tests.write in this project, deleting one tests.delete: otherwise they are listed to read.
    const here = useHere(id);
    const noWrite = here.why("ai_studio.tests.write");
    const mayDelete = here.may("ai_studio.tests.delete");

    const list = helpers.data ?? [];
    const nameProblem = newName ? helperNameProblem(newName) || (list.some((h) => h.name === newName) ? "A helper with this name already exists." : "") : "Enter a name for the helper.";

    async function open(name: string) {
        setOpening(name);
        setOpenError("");
        setNotice("");
        try {
            const r = await api<string | { content: string }>(`/projects/${id}/helpers/${name}`);
            setEditing({ name, initial: typeof r === "string" ? r : r.content, key: Date.now(), fresh: false });
        } catch (e) {
            setOpenError(describeApiError(e));
        } finally {
            setOpening("");
        }
    }

    const save = useCallback(
        async (content: string): Promise<SaveResult> => {
            const name = editing!.name;
            const res = await api<{ diagnostics?: SaveResult["diagnostics"] }>(`/projects/${id}/helpers/${name}`, { method: "PUT", body: { content } });
            void helpers.reload();
            return { diagnostics: res?.diagnostics ?? [] };
        },
        [id, editing?.name], // eslint-disable-line react-hooks/exhaustive-deps
    );

    async function remove() {
        if (!deleting) return;
        setDelBusy(true);
        setDelError(null);
        try {
            await api(`/projects/${id}/helpers/${deleting.name}`, { method: "DELETE" });
            if (editing?.name === deleting.name) setEditing(null);
            setNotice(`The helper “${deleting.name}” is deleted.`);
            setDeleting(null);
            void helpers.reload();
        } catch (e) {
            setDelError({ text: describeApiError(e), tests: e instanceof ApiError ? blockingTests(e.body) : [] });
        } finally {
            setDelBusy(false);
        }
    }

    return (
        <>
            <PageHeader title="Shared helpers" subtitle="Code that several code tests import. Change it once and every test that uses it runs again." actions={<LinkButton href={routes.tests(id)}>Back to the tests</LinkButton>} />
            <div className="stack">
                {notice && <Callout tone="success">{notice}</Callout>}

                <section className="card" aria-labelledby="helpers-how-title">
                    <div className="card-head wrap">
                        <Puzzle size={18} aria-hidden />
                        <h2 className="t-section" id="helpers-how-title">How to use a helper</h2>
                    </div>
                    <div className="code-body">
                        <p className="t-secondary">In a code test, import it by its name. A helper is code too, so it passes the same checks and runs only where code tests are allowed.</p>
                        <div className="code-import">
                            <code data-testid="import-example">{importLine(list[0]?.name ?? "my-helper")}</code>
                            <Button
                                size="sm"
                                icon={copied ? Check : Copy}
                                tip="Copies this import line, to paste at the top of a code test."
                                onClick={async () => {
                                    const line = importLine(list[0]?.name ?? "my-helper");
                                    const ok = await Promise.resolve()
                                        .then(() => navigator.clipboard.writeText(line))
                                        .then(() => true, () => false);
                                    setCopied(ok ? line : "");
                                    setCopyFailed(!ok);
                                    setTimeout(() => (setCopied(""), setCopyFailed(false)), ok ? 1500 : 4000);
                                }}
                            >
                                {copied ? "Copied" : "Copy"}
                            </Button>
                            {copyFailed && (
                                <span className="error-text" role="status">
                                    Could not copy. Select the line and copy it yourself.
                                </span>
                            )}
                        </div>
                        <p className="t-meta">Up to {MAX_HELPERS} helpers per project, 100 KB each. Names use lowercase letters, numbers and dashes.</p>
                    </div>
                </section>

                <section className="card" aria-labelledby="helpers-list-title">
                    <div className="card-head wrap">
                        <h2 className="t-section" id="helpers-list-title">Helpers in this project</h2>
                        <span className="t-meta">{list.length} of {MAX_HELPERS}</span>
                    </div>
                    {helpers.loading ? (
                        <ListSkeleton rows={2} />
                    ) : helpers.error ? (
                        <ErrorState error={friendlyError(helpers.error.message)} onRetry={helpers.reload} />
                    ) : list.length === 0 ? (
                        <EmptyState icon={Puzzle} title="No shared helpers yet" seeHow={{ topic: "write-code", query: "shared helpers" }}>Add one below when two tests need the same code, such as signing in.</EmptyState>
                    ) : (
                        <ul className="divided" data-testid="helpers">
                            {list.map((h) => (
                                <li className="code-helper" key={h.name} data-helper={h.name}>
                                    <span className="code-helper-main">
                                        <span className="t-card">{h.name}</span>
                                        <span className="t-meta">
                                            {formatBytes(h.bytes)}, used by {h.usedBy} {h.usedBy === 1 ? "test" : "tests"}, changed {relativeTime(h.updatedAt)}
                                        </span>
                                    </span>
                                    {/* Reading a helper needs only access: someone who may not change it opens it to read (View). */}
                                    <Button size="sm" icon={noWrite ? Eye : Pencil} loading={opening === h.name} onClick={() => void open(h.name)} aria-label={`${noWrite ? "View" : "Edit"} ${h.name}`}>
                                        {noWrite ? "View" : "Edit"}
                                    </Button>
                                    {mayDelete && (
                                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { setDelError(null); setDeleting(h); }} aria-label={`Delete ${h.name}`}>
                                            Delete
                                        </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {openError && (
                        <div className="code-body">
                            <Callout tone="danger" title="We couldn’t open that helper">{openError}</Callout>
                        </div>
                    )}
                    {noWrite ? (
                        <p className="t-meta code-body">{noWrite}</p>
                    ) : (
                    <form
                        className="code-add"
                        onSubmit={(e) => {
                            e.preventDefault();
                            setNameTouched(true);
                            if (nameProblem || list.length >= MAX_HELPERS) return;
                            setEditing({ name: newName, initial: helperStarter(newName), key: Date.now(), fresh: true });
                            setNewName("");
                            setNameTouched(false);
                            setNotice("");
                        }}
                    >
                        <div className="field">
                            <label htmlFor="helper-name">Name of a new helper</label>
                            <input id="helper-name" className="input" value={newName} onChange={(e) => setNewName(e.target.value.toLowerCase())} placeholder="sign-in" aria-invalid={nameTouched && !!nameProblem} aria-describedby={nameTouched && nameProblem ? "helper-name-err" : undefined} autoComplete="off" />
                            {nameTouched && nameProblem && (
                                <span className="error-text" id="helper-name-err">
                                    {nameProblem}
                                </span>
                            )}
                        </div>
                        <Button type="submit" icon={FilePlus2} disabled={list.length >= MAX_HELPERS}>
                            Add a helper
                        </Button>
                    </form>
                    )}
                </section>

                {editing && (!noWrite || !editing.fresh) && (
                    <section aria-labelledby="helper-edit-title" className="stack-sm">
                        <div className="row">
                            <h2 className="t-section" id="helper-edit-title">
                                {editing.fresh ? "New helper" : noWrite ? "Viewing" : "Editing"}: {editing.name}
                            </h2>
                            <span className="spacer" />
                            <Button onClick={() => (dirty && !noWrite ? setCloseAsk(true) : setEditing(null))}>{noWrite ? "Close" : "Close the editor"}</Button>
                        </div>
                        <Workbench
                            key={editing.name + editing.key}
                            initial={editing.initial}
                            baselineKey={editing.key}
                            saveLabel="Save helper"
                            onSave={save}
                            onDirty={setDirty}
                            guard={cfg?.customScripts?.guard}
                            maxBytes={100 * 1024}
                            savedNotice={() => "Saved. Tests that import this helper run again."}
                            readOnly={Boolean(noWrite)}
                            readOnlyWhy={noWrite}
                        />
                    </section>
                )}
            </div>

            {deleting && (
                <Modal
                    title={`Delete “${deleting.name}”?`}
                    titleId="helper-delete-title"
                    onClose={() => setDeleting(null)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setDeleting(null)}>
                                Keep it
                            </Button>
                            <Button variant="danger" loading={delBusy} onClick={() => void remove()}>
                                Delete helper
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">
                        {deleting.usedBy > 0 ? `${deleting.usedBy} ${deleting.usedBy === 1 ? "test imports" : "tests import"} this helper, so the platform refuses to delete it while they do. ` : "No test imports this helper. "}
                        Deleting cannot be undone.
                    </p>
                    {delError && (
                        <Callout tone="danger" title="It wasn’t deleted">
                            {delError.text}
                            {delError.tests.length > 0 && (
                                <ul className="bullets" data-testid="blocking-tests" style={{ marginTop: 6 }}>
                                    {delError.tests.map((t, i) => (
                                        <li key={i}>{t}</li>
                                    ))}
                                </ul>
                            )}
                        </Callout>
                    )}
                </Modal>
            )}
            {closeAsk && (
                <Modal
                    title="Close without saving?"
                    titleId="helper-close-title"
                    onClose={() => setCloseAsk(false)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setCloseAsk(false)}>
                                Keep editing
                            </Button>
                            <Button variant="danger" onClick={() => { setCloseAsk(false); setEditing(null); setDirty(false); }}>
                                Close and lose changes
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">You have changes that are not saved. If you close the editor now they are lost.</p>
                </Modal>
            )}
        </>
    );
}
