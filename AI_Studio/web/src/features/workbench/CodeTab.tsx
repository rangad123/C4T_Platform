import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CodeViewer } from "../../components/CodeViewer";
import { ScriptPreview } from "../../components/ScriptPreview";
import { Callout, Disclosure, ErrorState, Skeleton } from "../../components/ui";
import { friendlyError, describeApiError } from "../../lib/labels";
import { useRoute } from "../../lib/router";
import { fetchScriptText, type Diagnostic, type SaveResult } from "../code/code";
import { CustomCallout } from "../code/CustomParts";
import { EditScriptButton } from "../code/TakeOver";
import { Workbench as CodeEditor } from "../code/Workbench";
import { useRunPolicy } from "../code/policy";
import "../code/code.css";
import { RunnableDownload } from "../portable/RunnableDownload";
import type { Detail } from "./test-model";
import { api } from "../../api";

/**
 * The Code tab. A generated test shows its script read-only (the test first, the platform's setup folded) and the one-way door:
 * Switch to code, with what stops said plainly before anything happens. A code test shows the editor and its checks; its versions
 * are on the History tab. The tab's own column (`aside`, below the last run) holds the editor's problems and rules and the download
 * that runs the test on another computer.
 */
export function CodeTab({ test, reload, fwName, framework, onFramework, aside, onDirty, scriptKey }: { test: Detail; reload: () => Promise<void>; fwName: (f: string) => string; framework: string; onFramework: (f: string) => void; aside: HTMLElement | null; onDirty: (dirty: boolean) => void; /** Changes when a version of the code was restored elsewhere (the History tab): the editor loads the script again. */ scriptKey: number }) {
    const t = test;
    const scripts = t.scripts;
    const script = scripts.find((s) => s.framework === (framework || t.framework)) ?? scripts[0];
    const [editorAside, setEditorAside] = useState<HTMLElement | null>(null);
    const column = (
        <>
            <div className="stack" ref={setEditorAside} hidden={!t.custom} />
            {scripts.length > 0 && <RunnableDownload testId={t.id} testKey={t.testId} phone={t.kind === "mobile"} />}
        </>
    );
    return (
        <div className="stack">
            {aside ? createPortal(column, aside) : column}
            {t.custom ? (
                <CustomCode test={t} reload={reload} aside={editorAside} onDirty={onDirty} scriptKey={scriptKey} />
            ) : (
                <section className="stack-sm" aria-labelledby="wb-code-title">
                    <div className="row">
                        <h2 className="t-section" id="wb-code-title">
                            Script
                        </h2>
                        <span className="t-meta">{script ? fwName(script.framework) : ""}</span>
                    </div>
                    <p className="t-secondary">The test as runnable code, made from its steps. It is read-only here: change the steps and it follows. Copy it or download it to run in your own pipeline.</p>
                    {scripts.length > 1 && (
                        <div className="chips" role="group" aria-label="Script version">
                            {scripts.map((s) => (
                                <button key={s.id} className="chip" aria-pressed={s.id === script?.id} onClick={() => onFramework(s.framework)}>
                                    {fwName(s.framework)}
                                    {!s.executable && " (not run)"}
                                </button>
                            ))}
                        </div>
                    )}
                    {script ? <ScriptPreview code={script.content} filename={script.filename} label={script.filename} /> : <p className="muted">No script has been generated for this test.</p>}
                    {(t.kind === "web" || t.kind === "api" || t.kind === "desktop" || t.kind === "mobile") && (
                        <Callout tone="info" title="Want to change the code itself?" actions={<EditScriptButton testId={t.id} />}>
                            Switching to code makes the script the test. The steps then stop driving it: it is no longer made again from them, and repair suggestions and shared-element updates no longer reach it. You can go back to the generated version at any time.
                        </Callout>
                    )}
                </section>
            )}

            <div className="card" style={{ padding: "0 20px" }}>
                <Disclosure label="View technical details">
                    <dl className="kv" style={{ marginBottom: 12 }}>
                        <dt>Test ID</dt>
                        <dd>{t.testId}</dd>
                        <dt>Suite</dt>
                        <dd>{t.suite}</dd>
                        <dt>Runs with</dt>
                        <dd>{fwName(t.framework)}</dd>
                        <dt>Run attempts</dt>
                        <dd>{t.attempts}</dd>
                        {t.generationMeta?.model && (
                            <>
                                <dt>Created with</dt>
                                <dd>{t.generationMeta.model}</dd>
                            </>
                        )}
                    </dl>
                    {/* A code test's old steps are not shown: they no longer run, and the script is in the editor above. */}
                    {t.spec && !t.custom ? (
                        <>
                            <div className="t-card" style={{ marginBottom: 6 }}>
                                This test as JSON
                            </div>
                            <CodeViewer code={JSON.stringify(t.spec, null, 2)} language="json" filename={`${t.testId}.json`} label="The test, independent of any framework" />
                        </>
                    ) : (
                        <p className="muted">This test has no steps: its code is the test.</p>
                    )}
                </Disclosure>
            </div>
        </div>
    );
}

/** The editor of a code test: live checks, Save or Save and run, and the run a save starts. A restore on the History tab reloads it. */
function CustomCode({ test: t, reload, aside, onDirty, scriptKey }: { test: Detail; reload: () => Promise<void>; aside: HTMLElement | null; onDirty: (dirty: boolean) => void; scriptKey: number }) {
    const id = t.id;
    const { query } = useRoute();
    const policy = useRunPolicy(t.projectId);
    const [script, setScript] = useState<{ text: string; key: string } | null>(null);
    const [loadError, setLoadError] = useState("");
    const [again, setAgain] = useState(0);

    useEffect(() => {
        let gone = false;
        setLoadError("");
        fetchScriptText(id)
            .then((text) => !gone && setScript({ text, key: `${again}:${scriptKey}` }))
            .catch((e) => !gone && setLoadError(describeApiError(e)));
        return () => {
            gone = true;
        };
    }, [id, again, scriptKey]);

    const save = useCallback(
        async (content: string, note: string, o: { run: boolean }) => {
            const res = await api<SaveResult>(`/tests/${id}/script`, { method: "PUT", body: { content, ...(note ? { note } : {}), ...(o.run ? {} : { run: false }) } });
            void reload();
            // A plain save starts nothing: the line under the editor says so, and where to run it.
            return !o.run && !res.jobId && !res.note ? { ...res, note: "the script is saved. Use Run at the top when you want to run it." } : res;
        },
        [id], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const check = useCallback(async (content: string): Promise<Diagnostic[]> => (await api<{ diagnostics: Diagnostic[] }>(`/tests/${id}/script/check`, { method: "POST", body: { content } })).diagnostics ?? [], [id]);

    if (loadError) return <ErrorState error={friendlyError(loadError)} onRetry={() => setAgain((n) => n + 1)} />;
    if (!script) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading the code">
                <Skeleton h={420} style={{ borderRadius: 12 }} />
            </div>
        );
    }
    const job = query.get("job");
    const startSaved = query.get("saved") === "1" ? { jobId: job, note: query.get("note") ?? undefined, version: query.get("version") ? Number(query.get("version")) : undefined } : undefined;

    return (
        <>
            {t.custom && <CustomCallout testId={t.id} projectId={t.projectId} custom={t.custom} onChanged={() => void reload()} />}
            <CodeEditor
                initial={script.text}
                baselineKey={script.key}
                saveLabel="Save and run"
                savingLabel="Saving…"
                saveOnlyLabel="Save"
                withNote
                testId={id}
                onSave={save}
                onCheck={check}
                aside={aside}
                runPolicy={policy}
                guard={policy.config?.guard}
                maxBytes={policy.config?.maxBytes}
                startSaved={startSaved}
                onDirty={onDirty}
            />
        </>
    );
}
