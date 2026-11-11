import { CircleAlert, History, RotateCcw, ShieldCheck, TriangleAlert, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Callout, Disclosure } from "../../components/ui";
import { NOT_ENABLED_TEXT, NOT_ENABLED_TITLE, asDiagnostics, type CodeConfig, type Diagnostic, type SaveResult } from "./code";
import { LazyEditor, type EditorHandle } from "./LazyEditor";
import { Modal } from "../../components/Modal";
import "./code.css";
import { RunStatus } from "./RunStatus";
import { ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";


interface Props {
    /** The text the server has now. A change of `baselineKey` replaces the editor's text with it (after a restore or a reload). */
    initial: string;
    baselineKey: string | number;
    readOnly?: boolean;
    readOnlyWhy?: string;
    saveLabel: string;
    savingLabel?: string;
    onSave: (text: string, note: string) => Promise<SaveResult>;
    /** Without it there is no live check and no Check button: the problems show when the script is saved. */
    onCheck?: (text: string) => Promise<Diagnostic[]>;
    withNote?: boolean;
    onHistory?: () => void;
    historyOpen?: boolean;
    /** Set for a test: shows the run status after a save. */
    testId?: string;
    /** The save that led to this page (right after a test was written): its run is shown straight away. */
    startSaved?: { jobId: string | null; note?: string; version?: number };
    runPolicy?: { known: boolean; enabled: boolean; config: CodeConfig | undefined };
    onSaved?: (res: SaveResult, text: string) => void;
    onDirty?: (dirty: boolean) => void;
    /** After a save that cannot show a run (helpers). */
    savedNotice?: (res: SaveResult) => string;
    guard?: string[];
    maxBytes?: number;
    children?: ReactNode;
}

const bytesOf = (s: string) => new TextEncoder().encode(s).length;
const CHECK_DELAY_MS = 600;

/** The editor with its toolbar, problems list, run status and unsaved-changes protection. Shared by tests, new tests and helpers. */
export function Workbench(p: Props) {
    const [text, setText] = useState(p.initial);
    const [baseline, setBaseline] = useState(p.initial);
    const [diags, setDiags] = useState<Diagnostic[]>([]);
    const [checkState, setCheckState] = useState<"idle" | "checking" | "done" | "failed">("idle");
    const [wrap, setWrap] = useState(false);
    const [note, setNote] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    const [saved, setSaved] = useState<{ res: SaveResult; at: number } | null>(p.startSaved ? { res: { diagnostics: [], ...p.startSaved }, at: 0 } : null);
    const [confirm, setConfirm] = useState<null | { kind: "discard" } | { kind: "leave"; href: string }>(null);
    const editor = useRef<EditorHandle>(null);

    // A new baseline from the server replaces the text.
    useEffect(() => {
        setText(p.initial);
        setBaseline(p.initial);
        setDiags([]);
        setCheckState("idle");
        lastChecked.current = undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.baselineKey]);

    const dirty = text !== baseline;
    useEffect(() => p.onDirty?.(dirty), [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
    const size = bytesOf(text);
    const tooBig = p.maxBytes !== undefined && size > p.maxBytes;
    const errors = diags.filter((d) => d.severity === "error");

    // ── the live check: after 600 ms of quiet, one call at a time ──
    const lastChecked = useRef<string | undefined>(undefined);
    const inflight = useRef(false);
    const runCheck = useCallback(
        async (t: string) => {
            if (!p.onCheck) return;
            if (inflight.current) return;
            inflight.current = true;
            lastChecked.current = t;
            setCheckState("checking");
            try {
                const d = await p.onCheck(t);
                setDiags(d);
                setCheckState("done");
            } catch (e) {
                // A busy answer (429) is not worth a message: the next pause in typing checks again.
                setCheckState(e instanceof ApiError && e.status === 429 ? "idle" : "failed");
                if (e instanceof ApiError && e.status === 429) lastChecked.current = undefined;
            } finally {
                inflight.current = false;
            }
        },
        [p.onCheck],
    );
    useEffect(() => {
        if (!p.onCheck || p.readOnly || tooBig || text === lastChecked.current) return;
        const h = window.setTimeout(() => void runCheck(text), CHECK_DELAY_MS);
        return () => clearTimeout(h);
    }, [text, runCheck, p.onCheck, p.readOnly, tooBig, checkState]);

    // ── leaving with unsaved changes ──
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    useEffect(() => {
        const before = (e: BeforeUnloadEvent) => {
            if (!dirtyRef.current) return;
            e.preventDefault();
            e.returnValue = "";
        };
        const click = (e: MouseEvent) => {
            if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = (e.target as Element | null)?.closest?.("a[href]");
            const href = a?.getAttribute("href");
            if (!href || !href.startsWith("#/") || href === location.hash) return;
            e.preventDefault();
            e.stopPropagation();
            setConfirm({ kind: "leave", href });
        };
        window.addEventListener("beforeunload", before);
        document.addEventListener("click", click, true);
        return () => {
            window.removeEventListener("beforeunload", before);
            document.removeEventListener("click", click, true);
        };
    }, []);

    async function save() {
        if (saving || p.readOnly || tooBig) return;
        setSaving(true);
        setSaveError("");
        try {
            const res = await p.onSave(text, note.trim());
            setBaseline(text);
            setDiags(res.diagnostics ?? []);
            setCheckState("done");
            lastChecked.current = text;
            setNote("");
            setSaved({ res, at: Date.now() });
            p.onSaved?.(res, text);
        } catch (e) {
            if (e instanceof ApiError && e.status === 422) {
                const d = asDiagnostics(e.body.diagnostics ?? e.details);
                setDiags(d);
                setCheckState("done");
                setSaveError(d.length ? "Not saved. Fix the problems listed below and save again. Your text is still here." : `Not saved. ${e.message}`);
            } else setSaveError(describeApiError(e));
        } finally {
            setSaving(false);
        }
    }

    const policy = p.runPolicy;
    const showNotEnabled = !!p.testId && !!policy?.known && !policy.enabled;
    const hintId = "code-editor-hint";

    return (
        <div className="stack">
            {showNotEnabled && (
                <Callout tone="warning" title={NOT_ENABLED_TITLE}>
                    {NOT_ENABLED_TEXT}
                </Callout>
            )}
            {p.readOnly && p.readOnlyWhy && <Callout tone="info">{p.readOnlyWhy}</Callout>}

            <section className="card code-bench" aria-label="Script">
                <div className="code-toolbar" role="toolbar" aria-label="Editor actions">
                    <Button variant="primary" loading={saving} disabled={p.readOnly || tooBig} onClick={() => void save()}>
                        {saving ? (p.savingLabel ?? "Saving…") : p.saveLabel}
                    </Button>
                    {p.onCheck && (
                        <Button icon={ShieldCheck} disabled={checkState === "checking" || tooBig} tip={tooBig ? "This script is too long to check. Shorten it first." : "Checks the script now, without saving it. It is also checked by itself when you pause typing."} onClick={() => void runCheck(text)}>
                            Check
                        </Button>
                    )}
                    {p.onHistory && (
                        <Button icon={History} aria-expanded={!!p.historyOpen} onClick={p.onHistory}>
                            Version history
                        </Button>
                    )}
                    <Button icon={RotateCcw} disabled={!dirty} onClick={() => setConfirm({ kind: "discard" })}>
                        Discard changes
                    </Button>
                    <Button variant="ghost" icon={WrapText} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
                        Wrap lines
                    </Button>
                    <span className="spacer" />
                    {p.readOnly && <Badge tone="neutral">Read-only</Badge>}
                    {dirty && <Badge tone="warning">Unsaved changes</Badge>}
                </div>

                {p.withNote && (
                    <div className="field code-note">
                        <label htmlFor="code-note">Note for this version (optional)</label>
                        <input id="code-note" className="input" maxLength={200} value={note} disabled={p.readOnly} onChange={(e) => setNote(e.target.value)} placeholder="What changed, in a few words" />
                    </div>
                )}

                <LazyEditor ref={editor} value={text} onChange={setText} readOnly={p.readOnly} wrap={wrap} diagnostics={diags} describedBy={hintId} onSave={() => void save()} />
                <p className="t-meta code-hint" id={hintId}>
                    Press Tab to indent. To leave the editor with the keyboard, press Escape, then Tab. Ctrl+F searches, Ctrl+Z undoes.
                    {p.maxBytes !== undefined && <span className={tooBig ? "code-over" : ""}> {Math.ceil(size / 1024)} KB of {Math.round(p.maxBytes / 1024)} KB.</span>}
                </p>
            </section>

            {saveError && (
                <Callout tone="danger" title="That didn’t save">
                    {saveError}
                </Callout>
            )}
            {tooBig && (
                <Callout tone="danger" title="This script is too long">
                    The limit is {Math.round((p.maxBytes ?? 0) / 1024)} KB. Move shared code into a helper or shorten the script.
                </Callout>
            )}

            <section className="card" aria-label="Problems">
                <div className="card-head wrap">
                    <h2 className="t-section">Problems</h2>
                    <span className="t-meta" role="status" data-testid="check-state">
                        {!p.onCheck
                            ? "Problems are found when you save."
                            : checkState === "checking"
                              ? "Checking…"
                              : checkState === "failed"
                                ? "The check could not run just now. It tries again when you stop typing."
                                : checkState === "done"
                                  ? diags.length
                                      ? `${errors.length} ${errors.length === 1 ? "error" : "errors"}, ${diags.length - errors.length} ${diags.length - errors.length === 1 ? "warning" : "warnings"}`
                                      : "No problems found."
                                  : "Checked when you pause typing."}
                    </span>
                </div>
                {diags.length > 0 ? (
                    <ul className="code-diags divided">
                        {[...diags]
                            .sort((a, b) => a.line - b.line || a.column - b.column)
                            .map((d, i) => (
                                <li key={i}>
                                    <button className="code-diag" onClick={() => editor.current?.jumpTo(d.line, d.column)}>
                                        {d.severity === "error" ? <CircleAlert size={16} aria-hidden className="is-error" /> : <TriangleAlert size={16} aria-hidden className="is-warning" />}
                                        <span className="sev">{d.severity === "error" ? "Error" : "Warning"}</span>
                                        <span className="pos">
                                            Line {d.line}, column {d.column}
                                        </span>
                                        <span className="msg">{d.message}</span>
                                        {d.rule && <span className="rule">{d.rule}</span>}
                                    </button>
                                </li>
                            ))}
                    </ul>
                ) : (
                    <p className="code-ok t-secondary">{checkState === "done" ? "Nothing to fix." : "Problems appear here, with a link to the line."}</p>
                )}
            </section>

            {saved && p.testId && <RunStatus testId={p.testId} jobId={saved.res.jobId ?? null} note={saved.res.note} key={saved.at} />}
            {saved && !p.testId && p.savedNotice && (
                <p className="code-run" role="status" data-testid="saved-notice">
                    <Badge tone="success">Saved</Badge>
                    <span>{p.savedNotice(saved.res)}</span>
                </p>
            )}
            {saved?.res.version !== undefined && p.testId && (
                <p className="t-meta" data-testid="saved-version">
                    Saved as version {saved.res.version}.
                </p>
            )}

            <div className="card" style={{ padding: "0 var(--space-card-padding)" }}>
                <Disclosure label="What’s allowed in a script">
                    <div className="stack-sm">
                        {p.guard?.length ? <ul className="bullets">{p.guard.map((g, i) => <li key={i}>{g}</li>)}</ul> : <p className="muted">The rules could not be loaded. They are shown with any problem the check finds.</p>}
                        <p className="t-secondary">
                            These rules are a guard against mistakes. They are not a security boundary: a script is code, so it only runs on a runner or a server whose owner has allowed code tests.
                        </p>
                    </div>
                </Disclosure>
            </div>

            {p.children}

            {confirm?.kind === "discard" && (
                <Modal
                    title="Discard your changes?"
                    titleId="code-discard-title"
                    onClose={() => setConfirm(null)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirm(null)}>
                                Keep editing
                            </Button>
                            <Button
                                variant="danger"
                                onClick={() => {
                                    setText(baseline);
                                    setDiags([]);
                                    setSaveError("");
                                    lastChecked.current = undefined;
                                    setConfirm(null);
                                }}
                            >
                                Discard changes
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">The text goes back to the last saved version. This cannot be undone.</p>
                </Modal>
            )}
            {confirm?.kind === "leave" && (
                <Modal
                    title="Leave without saving?"
                    titleId="code-leave-title"
                    onClose={() => setConfirm(null)}
                    foot={
                        <>
                            <Button data-autofocus onClick={() => setConfirm(null)}>
                                Stay and keep editing
                            </Button>
                            <Button
                                variant="danger"
                                onClick={() => {
                                    const href = confirm.href;
                                    dirtyRef.current = false;
                                    setConfirm(null);
                                    location.hash = href.replace(/^#/, "");
                                }}
                            >
                                Leave and lose changes
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">You have changes that are not saved. If you leave now they are lost.</p>
                </Modal>
            )}
        </div>
    );
}
