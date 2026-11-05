import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { plural } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import type { ImportAnswer, MaestroFlowReport } from "./imports";
import "./imports.css";

interface Picked {
    name: string;
    content: string;
}

/**
 * Tests → ⋯ More actions → Import Maestro flows. Pick the flow files, see what each one becomes (and what is left out, and why)
 * before anything is stored, then import. Nothing in a flow is run by the import.
 */
export function MaestroImportPanel({ projectId, busy, onClose, onImported }: { projectId: string; busy: boolean; onClose: () => void; onImported: (jobStarted: boolean) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [files, setFiles] = useState<Picked[]>([]);
    const [preview, setPreview] = useState<ImportAnswer | null>(null);
    const [runNow, setRunNow] = useState(!busy);
    const [working, setWorking] = useState<"" | "preview" | "import">("");
    const [error, setError] = useState<{ text: string; files: Array<{ file: string; message: string }> } | null>(null);
    const [done, setDone] = useState<ImportAnswer | null>(null);

    const fail = (e: unknown) => {
        const details = (e as { details?: unknown }).details;
        const list = Array.isArray(details) ? details.filter((d): d is { file: string; message: string } => typeof d?.file === "string" && typeof d?.message === "string") : [];
        setError({ text: describeApiError(e), files: list });
    };

    async function choose(list: FileList | null) {
        if (!list || list.length === 0) return;
        setError(null);
        setDone(null);
        setPreview(null);
        setWorking("preview");
        try {
            const picked = await Promise.all([...list].map(async (f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() })));
            setFiles(picked);
            setPreview(await api<ImportAnswer>(`/projects/${projectId}/import/maestro`, { method: "POST", body: { files: picked, dryRun: true } }));
        } catch (e) {
            setFiles([]);
            fail(e);
        } finally {
            setWorking("");
        }
    }

    async function run() {
        setWorking("import");
        setError(null);
        try {
            const res = await api<ImportAnswer>(`/projects/${projectId}/import/maestro`, { method: "POST", body: { files, validate: runNow && !busy } });
            setDone(res);
            setPreview(null);
            setFiles([]);
            onImported(Boolean(res.jobId));
        } catch (e) {
            fail(e);
        } finally {
            setWorking("");
        }
    }

    const convertible = preview?.reports.filter((r) => r.status === "converted").length ?? 0;

    return (
        <section className="card card-pad stack-sm" aria-label="Import Maestro flows">
            <div className="row">
                <FileUp size={18} aria-hidden />
                <h2 className="t-section">Import Maestro flows</h2>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </div>
            <p className="t-secondary">
                Already have Maestro flows? Choose the .yaml files and each one becomes a test here. A flow for an app becomes a mobile test; a flow with a web address becomes a web test.
                Nothing is run while importing. Steps that can’t be converted are listed, with the reason, so you can see what is missing.
            </p>

            <div className="row">
                <input ref={input} type="file" accept=".yaml,.yml,text/yaml" multiple hidden aria-label="Maestro flow files" onChange={(e) => { void choose(e.target.files); e.target.value = ""; }} />
                <Button onClick={() => input.current?.click()} loading={working === "preview"}>
                    {files.length ? "Choose other files" : "Choose flow files"}
                </Button>
                {files.length > 0 && <span className="t-meta">{plural(files.length, "file")} chosen</span>}
            </div>

            {error && (
                <Callout tone="danger">
                    {error.text}
                    {error.files.length > 0 && (
                        <ul className="flow-problems">
                            {error.files.map((f) => (
                                <li key={f.file}>{f.message}</li>
                            ))}
                        </ul>
                    )}
                </Callout>
            )}

            {done && (
                <Callout tone={done.imported.length ? "success" : "info"}>
                    {done.imported.length
                        ? `Imported ${plural(done.imported.length, "test")}${done.skipped.length ? `; ${done.skipped.length} left out` : ""}.${done.jobId ? " We’re running them now." : done.notRun ? ` ${done.notRun}` : ""}`
                        : "Nothing was imported. None of the files could be converted."}
                </Callout>
            )}

            {preview && (
                <>
                    <ul className="flow-list" aria-label="What each file becomes">
                        {preview.reports.map((r) => (
                            <FlowRow key={r.file} r={r} />
                        ))}
                    </ul>
                    {convertible > 0 ? (
                        <>
                            <label className="check">
                                <input type="checkbox" checked={runNow && !busy} disabled={busy} onChange={(e) => setRunNow(e.target.checked)} />
                                <span>
                                    <span className="title">Run the tests right away</span>
                                    <span className="hint">{busy ? "Another run is in progress; run these when it finishes." : "Mobile tests need an emulator; without one they wait until you run them."}</span>
                                </span>
                            </label>
                            <div className="row">
                                <Button variant="primary" loading={working === "import"} onClick={() => void run()}>
                                    Import {plural(convertible, "test")}
                                </Button>
                            </div>
                        </>
                    ) : (
                        <Callout tone="warning">None of these files can be imported. The reasons are listed above.</Callout>
                    )}
                </>
            )}
        </section>
    );
}

function FlowRow({ r }: { r: MaestroFlowReport }) {
    const converted = r.status === "converted";
    const skippedSteps = r.notes.filter((n) => n.level === "skipped");
    const hasDetail = r.notes.length > 0 || r.variables.length > 0;
    return (
        <li data-flow={r.file} className={converted ? "" : "left-out"}>
            <div className="row">
                <Tooltip content={r.file}>
                    <strong className="truncate" tabIndex={0}>{r.file}</strong>
                </Tooltip>
                <Badge tone={converted ? "success" : "neutral"}>{converted ? (r.kind === "web" ? "Web test" : "Mobile test") : "Left out"}</Badge>
                <span className="spacer" />
                {converted && <span className="t-meta">{plural(r.convertedSteps, "step")}, {plural(r.checks, "check")}{skippedSteps.length ? `, ${skippedSteps.length} left out` : ""}</span>}
            </div>
            {converted ? <p className="t-secondary">{r.title}</p> : <p className="t-secondary">{r.reason}</p>}
            {hasDetail && (
                <details className="flow-detail">
                    <summary>Details for {r.file}</summary>
                    {r.notes.length > 0 && (
                        <ul>
                            {r.notes.map((n, i) => (
                                <li key={i}>
                                    {n.step > 0 ? `Step ${n.step}, ` : ""}
                                    <code>{n.command}</code>
                                    {n.level === "skipped" ? " left out: " : " changed: "}
                                    {n.reason}
                                </li>
                            ))}
                        </ul>
                    )}
                    {r.variables.length > 0 && (
                        <>
                            <p className="t-meta">Variables the test reads when it runs. Their values were not copied; set them on the project.</p>
                            <ul>
                                {r.variables.map((v) => (
                                    <li key={v.name}>
                                        <code>{v.name}</code> becomes <code>{v.placeholder}</code>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </details>
            )}
        </li>
    );
}
