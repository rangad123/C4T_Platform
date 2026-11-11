import { useCallback, useEffect, useState } from "react";
import { CodeViewer } from "../../components/CodeViewer";
import { ScriptPreview } from "../../components/ScriptPreview";
import { Callout, Disclosure, ErrorState, Skeleton } from "../../components/ui";
import { friendlyError, describeApiError } from "../../lib/labels";
import { useRoute } from "../../lib/router";
import { fetchScriptText, type Diagnostic, type SaveResult } from "../code/code";
import { CustomCallout } from "../code/CustomParts";
import { EditScriptButton } from "../code/TakeOver";
import { VersionHistory } from "../code/VersionHistory";
import { Workbench as CodeEditor } from "../code/Workbench";
import { useRunPolicy } from "../code/policy";
import "../code/code.css";
import { RunnableDownload } from "../portable/RunnableDownload";
import type { Detail } from "./test-model";
import { api } from "../../api";

/**
 * The Code tab. A generated test shows its script read-only (the test first, the platform's setup folded) and the one-way door:
 * Switch to code, with what stops said plainly before anything happens. A code test shows the editor, its checks and its versions.
 */
export function CodeTab({ test, reload, fwName, framework, onFramework }: { test: Detail; reload: () => Promise<void>; fwName: (f: string) => string; framework: string; onFramework: (f: string) => void }) {
    const t = test;
    const scripts = t.scripts;
    const script = scripts.find((s) => s.framework === (framework || t.framework)) ?? scripts[0];
    return (
        <div className="stack">
            {t.custom ? (
                <CustomCode test={t} reload={reload} />
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

            {scripts.length > 0 && <RunnableDownload testId={t.id} testKey={t.testId} phone={t.kind === "mobile"} />}

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
                    {t.spec ? (
                        <>
                            <div className="t-card" style={{ marginBottom: 6 }}>
                                {t.custom ? "The steps this test had before it was switched to code (JSON, no longer used)" : "This test as JSON"}
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

/** The editor of a code test: live checks, versions, and the run a save starts (the same editor the code feature always had). */
function CustomCode({ test: t, reload }: { test: Detail; reload: () => Promise<void> }) {
    const id = t.id;
    const { query } = useRoute();
    const policy = useRunPolicy(t.projectId);
    const [script, setScript] = useState<{ text: string; key: number } | null>(null);
    const [loadError, setLoadError] = useState("");
    const [again, setAgain] = useState(0);
    const [historyKey, setHistoryKey] = useState(0);
    const [showHistory, setShowHistory] = useState(query.get("history") === "1");
    const [dirty, setDirty] = useState(false);
    // A link to the version history (the callout's) opens it even when the editor was already showing.
    const wantsHistory = query.get("history") === "1";
    useEffect(() => {
        if (wantsHistory) setShowHistory(true);
    }, [wantsHistory]);

    useEffect(() => {
        let gone = false;
        setLoadError("");
        fetchScriptText(id)
            .then((text) => !gone && setScript({ text, key: again }))
            .catch((e) => !gone && setLoadError(describeApiError(e)));
        return () => {
            gone = true;
        };
    }, [id, again]);

    const save = useCallback(
        async (content: string, note: string) => {
            const res = await api<SaveResult>(`/tests/${id}/script`, { method: "PUT", body: { content, ...(note ? { note } : {}) } });
            setHistoryKey((k) => k + 1);
            void reload();
            return res;
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
                withNote
                testId={id}
                onSave={save}
                onCheck={check}
                onHistory={() => setShowHistory((s) => !s)}
                historyOpen={showHistory}
                runPolicy={policy}
                guard={policy.config?.guard}
                maxBytes={policy.config?.maxBytes}
                startSaved={startSaved}
                onDirty={setDirty}
            >
                {showHistory && (
                    <VersionHistory
                        testId={id}
                        refreshKey={historyKey}
                        dirty={dirty}
                        onRestored={() => {
                            setAgain((n) => n + 1);
                            setHistoryKey((k) => k + 1);
                            void reload();
                        }}
                    />
                )}
            </CodeEditor>
        </>
    );
}
