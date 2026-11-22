import { useState, type FormEvent } from "react";
import { ChevronRight, Save, Trash2, Upload } from "lucide-react";
import { api } from "../../api";
import { Badge, Button, Callout, FilePicker } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useHere } from "../auth/project-access";
import { STATUS_TONE, STATUS_WORDS, uploadSchema, useLatestModel, type SourcesAnswer } from "./understanding";
import "./understanding.css";

/**
 * More for application understanding of the application, on the Requirements tab of a project tested by the AI agent: database schema files
 * (SQL or Prisma, read as text, never run) and, once something was read, the version label of the build the latest analysis describes.
 * Closed to one line until opened. People who may only look see what is there without the controls.
 */
export function SourceInputs({ projectId }: { projectId: string }) {
    const sources = useFetch<SourcesAnswer>(`/projects/${projectId}/intel/sources`);
    const latest = useLatestModel(projectId);
    const canWrite = useHere(projectId).may("ai_studio.tests.write");
    const [file, setFile] = useState<File | null>(null);
    const [label, setLabel] = useState<string | null>(null);
    const [busy, setBusy] = useState<"upload" | "label" | string | null>(null);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    // Closed to one line: optional and advanced, on the page people use to add requirements.
    const [open, setOpen] = useState(false);
    const schemas = (sources.data?.sources ?? []).filter((s) => s.kind === "db_schema");
    const noAnalysis = latest.none;
    const shownLabel = label ?? latest.data?.appVersion.label ?? "";

    async function run(what: string, work: () => Promise<string>) {
        setError("");
        setNotice("");
        setBusy(what);
        try {
            setNotice(await work());
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(null);
        }
    }

    const upload = () =>
        run("upload", async () => {
            await uploadSchema(projectId, file!);
            setFile(null);
            await sources.reload();
            return noAnalysis ? "Schema file added. The next exploration reads it." : "Schema file added. Choose Read again on the Dashboard to use it.";
        });
    const remove = (id: string, name: string) =>
        run(id, async () => {
            await api(`/projects/${projectId}/intel/sources/schema/${encodeURIComponent(id)}`, { method: "DELETE" });
            await sources.reload();
            return `${name} removed. The next reading no longer uses it.`;
        });
    const saveLabel = (e: FormEvent) => {
        e.preventDefault();
        void run("label", async () => {
            await api(`/projects/${projectId}/intel/app-version`, { method: "PUT", body: { label: shownLabel } });
            await latest.reload();
            setLabel(null);
            return "Version label saved.";
        });
    };

    return (
        <section aria-labelledby="source-inputs-title" className="card card-pad stack-sm" data-testid="source-inputs">
            <div>
                <h2 className="t-section" id="source-inputs-title">
                    <button type="button" className="inputs-toggle" aria-expanded={open} aria-controls="source-inputs-body" onClick={() => setOpen((o) => !o)}>
                        <ChevronRight size={18} className="chev" aria-hidden />
                        More for application understanding
                    </button>
                </h2>
                <p className="t-secondary">
                    Optional. A database schema file describes the application’s data{noAnalysis ? "" : "; a version label says which build was read"}.
                    {open && !noAnalysis && (
                        <>
                            {" "}
                            After a change, choose Read again on the <a href={routes.project(projectId)}>Dashboard</a>.
                        </>
                    )}
                </p>
            </div>
            {open && (
            <div className="stack-sm" id="source-inputs-body">
            {notice && <Callout tone="success">{notice}</Callout>}
            {error && (
                <Callout tone="warning">
                    <span data-testid="source-inputs-error">{error}</span>
                </Callout>
            )}
            {sources.error && <Callout tone="warning" title="The schema files could not be loaded">{describeApiError(sources.error)}</Callout>}

            <div className="understanding-group">
                <h3 className="t-card">Database schema files</h3>
                {schemas.length === 0 ? (
                    <p className="t-secondary">None yet. SQL (CREATE TABLE) or Prisma files, at most 1 MB each.</p>
                ) : (
                    <ul className="understanding-list" aria-label="Database schema files">
                        {schemas.map((s) => (
                            <li key={s.id}>
                                <span className="understanding-source">
                                    <span className="truncate">{s.ref}</span>
                                    <Badge tone={STATUS_TONE[s.status]}>{STATUS_WORDS[s.status]}</Badge>
                                    <span className="spacer" />
                                    {canWrite && (
                                        <Button size="sm" variant="ghost" icon={Trash2} loading={busy === s.id} onClick={() => void remove(s.id, s.ref)} aria-label={`Remove ${s.ref}`}>
                                            Remove
                                        </Button>
                                    )}
                                </span>
                                {s.status === "failed" && s.error && <span className="t-secondary understanding-why">{s.error}</span>}
                            </li>
                        ))}
                    </ul>
                )}
                {canWrite && (
                    <div className="understanding-form">
                        <div className="field">
                            <FilePicker id="schema-file" accept=".sql,.prisma,.txt,text/plain" file={file} onChange={setFile} label="Choose a schema file" />
                        </div>
                        <Button size="sm" icon={Upload} disabled={!file} loading={busy === "upload"} onClick={() => void upload()}>
                            Add schema file
                        </Button>
                    </div>
                )}
            </div>

            {!noAnalysis && (
            <form className="understanding-group" onSubmit={saveLabel} aria-label="Application version">
                <h3 className="t-card">Application version</h3>
                {canWrite ? (
                    <div className="understanding-form">
                        <div className="field">
                            <label htmlFor="app-version-label">Version label</label>
                            <input id="app-version-label" className="input" placeholder="e.g. 2.4.1 or release-42" value={shownLabel} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
                        </div>
                        <Button size="sm" type="submit" icon={Save} loading={busy === "label"}>
                            Save label
                        </Button>
                    </div>
                ) : (
                    <p className="t-secondary">{shownLabel ? `The latest reading describes version ${shownLabel}.` : "The latest reading has no version label."}</p>
                )}
            </form>
            )}
            </div>
            )}
        </section>
    );
}
