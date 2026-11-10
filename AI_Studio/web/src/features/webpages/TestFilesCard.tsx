import { FileUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, FilePicker, Skeleton } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError } from "../../lib/labels";
import { formatSize, uploadTestFile, type TestFilesAnswer } from "./webpages";
import "./webpages.css";

/** Settings, Test data: the small files that "Upload a test file" steps put into file fields. Add, see which tests use each, remove. */
export function TestFilesCard({ projectId }: { projectId: string }) {
    const data = useFetch<TestFilesAnswer>(`/projects/${projectId}/test-files`);
    const [file, setFile] = useState<File | null>(null);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    // Adding a file needs tests.write in this project, removing one tests.delete.
    const here = useHere(projectId);
    const noWrite = here.why("ai_studio.tests.write");
    const mayDelete = here.may("ai_studio.tests.delete");

    async function add() {
        if (!file) return;
        setBusy("add");
        setError("");
        setNotice("");
        try {
            const saved = await uploadTestFile(projectId, file);
            setNotice(`Added ${saved.name}. Steps use it by that name.`);
            setFile(null);
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    async function remove(name: string) {
        setBusy(`rm:${name}`);
        setError("");
        setNotice("");
        try {
            await api(`/projects/${projectId}/test-files/${encodeURIComponent(name)}`, { method: "DELETE" });
            setNotice(`Removed ${name}.`);
            await data.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    const head = (
        <div className="row">
            <FileUp size={18} aria-hidden />
            <h2 className="t-section">Test files</h2>
        </div>
    );
    if (data.loading) {
        return (
            <section className="card card-pad stack-sm" aria-label="Test files">
                <Skeleton h={18} w={140} />
                <Skeleton h={48} />
            </section>
        );
    }
    if (data.error || !data.data) {
        return (
            <section className="card card-pad stack-sm" aria-label="Test files">
                {head}
                <Callout tone="warning" title="Could not load the test files" actions={<Button size="sm" onClick={() => void data.reload()}>Try again</Button>}>
                    Your tests are not affected. Try again in a moment.
                </Callout>
            </section>
        );
    }
    const d = data.data;
    return (
        <section className="card card-pad stack-sm" data-testid="test-files" aria-label="Test files">
            {head}
            <p className="t-secondary">
                Files that steps such as <em>Upload "photo.png" to the "Avatar" field</em> put into a file field. Each run gets a fresh copy. At most {plural(d.limits.files, "file")} of {formatSize(d.limits.fileBytes)} each.
            </p>
            {d.files.length === 0 ? (
                <p className="t-secondary" data-testid="test-files-empty">
                    No test files yet. Add one to use it in an upload step.
                </p>
            ) : (
                <ul className="wp-list" aria-label="The project's test files">
                    {d.files.map((f) => (
                        <li key={f.name} className="wp-item">
                            <span className="wp-main">
                                <code>{f.name}</code>
                                <span className="t-meta">
                                    {formatSize(f.size)}, {f.usedBy.length ? `used by ${f.usedBy.join(", ")}` : "not used by a test yet"}
                                </span>
                            </span>
                            {mayDelete && <Button size="sm" variant="ghost" icon={Trash2} loading={busy === `rm:${f.name}`} disabled={busy !== "" || f.usedBy.length > 0} onClick={() => void remove(f.name)} aria-label={`Remove ${f.name}`} tip={f.usedBy.length ? "Used by a test: change its steps first." : undefined}>
                                Remove
                            </Button>}
                        </li>
                    ))}
                </ul>
            )}
            {d.missing.length > 0 && (
                <Callout tone="warning" title="Some steps name files that are not here">
                    {d.missing.map((m) => `${m.name} (${m.usedBy.join(", ")})`).join("; ")}. Add files with these names, or those steps fail.
                </Callout>
            )}
            {noWrite ? <p className="t-meta">{noWrite}</p> : <div className="field">
                <label htmlFor="wp-file">Add a file</label>
                <div className="row wrap">
                    <FilePicker id="wp-file" accept={d.limits.types.map((t) => `.${t}`).join(",")} file={file} onChange={setFile} label="Choose a file" />
                    <Button variant="primary" icon={FileUp} disabled={!file || busy !== ""} loading={busy === "add"} onClick={() => void add()}>
                        Add file
                    </Button>
                </div>
                <p className="hint">Spaces in the name become dashes. A file with the same name is replaced. Never use real personal data.</p>
            </div>}
            {error && <Callout tone="danger">{error}</Callout>}
            {notice && (
                <Callout tone="success">
                    <span role="status">{notice}</span>
                </Callout>
            )}
        </section>
    );
}
