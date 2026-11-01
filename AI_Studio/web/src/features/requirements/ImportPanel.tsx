import { useProjectAiReady } from "../aiconfig/aiconfig";
import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { api } from "../../api";
import { Badge, Button, Callout, FilePicker } from "../../components/ui";
import { plural, toBase64 } from "../../lib/format";
import { useConfig } from "../../lib/hooks";
import { useCan } from "../auth/permissions";
import { apiMessage } from "../manual/manual";
import { IMPORT_ACCEPT, type ImportPreview } from "./requirements";

/**
 * Import requirements from pasted text or a document (.txt, .md, .docx, .pdf). The platform reads them first and shows what it
 * found; nothing is saved until the person chooses which to keep. Reading uses rules, no AI. With an AI model set up, the person
 * may ask the AI to split and tidy them instead.
 */
export function ImportPanel({ projectId, onCancel, onImported }: { projectId: string; onCancel: () => void; onImported: (summary: string) => void | Promise<void> }) {
    const config = useConfig();
    const can = useCan();
    const aiReady = useProjectAiReady(projectId);
    const [mode, setMode] = useState<"paste" | "file">("paste");
    const [text, setText] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<"read" | "ai" | "save" | null>(null);
    const [error, setError] = useState("");

    const ready = mode === "paste" ? text.trim().length > 0 : file !== null;

    async function read(ai: boolean) {
        setError("");
        setBusy(ai ? "ai" : "read");
        try {
            const body = mode === "paste" ? { text } : { file: { filename: file!.name, contentBase64: await toBase64(file!) } };
            const r = await api<ImportPreview>(`/projects/${projectId}/requirements/import/${ai ? "refine" : "preview"}`, { method: "POST", body });
            setPreview(r);
            setPicked(new Set(r.candidates.filter((c) => !c.exists).map((c) => c.ref)));
        } catch (e) {
            setError(apiMessage(e));
        } finally {
            setBusy(null);
        }
    }

    async function save() {
        if (!preview) return;
        setError("");
        setBusy("save");
        try {
            const requirements = preview.candidates.filter((c) => picked.has(c.ref)).map((c) => ({ ref: c.ref, title: c.title, description: c.description }));
            const r = await api<{ created: number; duplicates: string[] }>(`/projects/${projectId}/requirements/import`, { method: "POST", body: { requirements, source: preview.usedAi ? "ai" : "imported" } });
            await onImported(`Imported ${plural(r.created, "requirement")}.${r.duplicates.length ? ` ${plural(r.duplicates.length, "reference")} already existed and ${r.duplicates.length === 1 ? "was" : "were"} left out: ${r.duplicates.slice(0, 5).join(", ")}${r.duplicates.length > 5 ? "…" : ""}.` : ""}`);
        } catch (e) {
            setError(`Nothing was imported. ${apiMessage(e)}`);
            setBusy(null);
        }
    }

    const toggle = (ref: string, on: boolean) => setPicked((s) => {
        const n = new Set(s);
        if (on) n.add(ref);
        else n.delete(ref);
        return n;
    });

    return (
        <section className="card card-pad stack-sm" aria-label="Import requirements">
            <div className="row">
                <h2 className="t-section">Import requirements</h2>
                <span className="spacer" />
                <Button type="button" size="sm" variant="ghost" icon={X} onClick={onCancel} aria-label="Close the import">
                    Close
                </Button>
            </div>
            {!preview ? (
                <>
                    <p className="t-secondary">Paste a requirements document or choose its file. You see what was found before anything is saved. Requirement ids in the document (REQ-1, FR-2.3) become the references; the others are numbered.</p>
                    <div className="chips" role="group" aria-label="Where the requirements come from">
                        <button type="button" className="chip" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
                            Paste text
                        </button>
                        <button type="button" className="chip" aria-pressed={mode === "file"} onClick={() => setMode("file")}>
                            Choose a file
                        </button>
                    </div>
                    {mode === "paste" ? (
                        <div className="field">
                            <label htmlFor="req-import-text">Requirements text</label>
                            <textarea id="req-import-text" className="input mono" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"REQ-1: A shopper can pay by card.\nREQ-2: The basket keeps its items after signing in."} />
                        </div>
                    ) : (
                        <div className="field">
                            <label htmlFor="req-import-file">Document (.txt, .md, .docx or .pdf, up to 5 MB)</label>
                            <FilePicker id="req-import-file" accept={IMPORT_ACCEPT} file={file} onChange={setFile} />
                        </div>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        <Button variant="primary" disabled={!ready} loading={busy === "read"} onClick={() => void read(false)}>
                            Read requirements
                        </Button>
                        {aiReady && can("ai_studio.tests.generate") && (
                            <Button icon={Sparkles} disabled={!ready || busy !== null} loading={busy === "ai"} onClick={() => void read(true)} tip="The AI splits the requirements into single, testable ones and tidies their wording. It uses AI tokens.">
                                Read with AI
                            </Button>
                        )}
                        <Button onClick={onCancel}>Cancel</Button>
                    </div>
                    {!aiReady && config && <p className="hint">Reading with AI needs an AI model, and none is set up here. Reading without AI finds requirements by their ids, lists and “must” sentences.</p>}
                </>
            ) : (
                <>
                    {preview.note && <Callout tone="warning">{preview.note}</Callout>}
                    <p className="t-secondary" data-testid="import-preview-summary">
                        Found {plural(preview.total, "requirement")}
                        {preview.usedAi ? " with the AI" : ""}.{preview.existing > 0 && ` ${plural(preview.existing, "reference")} already ${preview.existing === 1 ? "exists" : "exist"} in this project and ${preview.existing === 1 ? "is" : "are"} left out.`}
                        {preview.total > preview.candidates.length && ` Only the first ${preview.candidates.length} are shown.`} Choose the ones to keep.
                    </p>
                    {preview.candidates.length === 0 ? (
                        <Callout tone="warning">No requirements were found. A requirements document lists them as numbered or bulleted items, with ids like REQ-1, or as sentences with “must” or “shall”.</Callout>
                    ) : (
                        <>
                            <div className="row">
                                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(preview.candidates.filter((c) => !c.exists).map((c) => c.ref)))}>
                                    Choose all
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                                    Choose none
                                </Button>
                            </div>
                            <fieldset className="req-preview">
                                <legend className="sr-only">Requirements found</legend>
                                {preview.candidates.map((c) => (
                                    <label className="check" key={c.ref}>
                                        <input type="checkbox" disabled={c.exists} checked={picked.has(c.ref)} onChange={(e) => toggle(c.ref, e.target.checked)} />
                                        <span>
                                            <span className="title">
                                                <span className="req-ref mono">{c.ref}</span> {c.title}
                                            </span>
                                            <span className="hint">
                                                {c.section ? `Under “${c.section}”` : "No heading"}
                                                {c.exists && (
                                                    <>
                                                        {" "}
                                                        <Badge tone="neutral">Already here</Badge>
                                                    </>
                                                )}
                                            </span>
                                        </span>
                                    </label>
                                ))}
                            </fieldset>
                        </>
                    )}
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        <Button variant="primary" disabled={picked.size === 0} loading={busy === "save"} onClick={() => void save()}>
                            Save {plural(picked.size, "requirement")}
                        </Button>
                        <Button onClick={() => setPreview(null)} disabled={busy !== null}>
                            Back
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
