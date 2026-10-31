import { ChevronRight, CircleAlert, ClipboardCopy, Download, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { LazyEditor, type EditorHandle } from "../code/LazyEditor";
import { asMarker, bytesOf, downloadText, parseText, TEXT_MAX_BYTES, type DslDiagnostic, type ParseAnswer, type Reference } from "./dsl";
import "../code/code.css";
import "./dsl.css";

interface Props {
    text: string;
    onChange: (text: string) => void;
    readOnly?: boolean;
    /** Why it is read-only, in a sentence (shown above the editor). */
    readOnlyWhy?: ReactNode;
    /** Buttons that go first in the toolbar (Save and run, Create test, Discard). */
    actions?: ReactNode;
    /** Badges at the end of the toolbar. */
    badges?: ReactNode;
    /** Problems the platform found when it tried to save this exact text (shown with the live ones until the text changes). */
    saveProblems?: { forText: string; items: DslDiagnostic[] };
    /** Tells the parent what the platform made of the text, for the text it was asked about. */
    onParsed?: (answer: ParseAnswer | null, forText: string) => void;
    filename: string;
    /** The editor's name for screen readers. */
    label?: string;
    idPrefix?: string;
}

const CHECK_DELAY_MS = 500;

/**
 * A test as text: the editor (the same one the code feature uses, set to plain text), the live check against the platform's parser,
 * the problems list with a jump to each line, copy and download, and the list of phrases made from the platform's own grammar.
 */
export function TextView({ text, onChange, readOnly, readOnlyWhy, actions, badges, saveProblems, onParsed, filename, label = "Test text", idPrefix = "dsl" }: Props) {
    const [wrap, setWrap] = useState(true);
    const [answer, setAnswer] = useState<{ forText: string; data: ParseAnswer } | null>(null);
    const [state, setState] = useState<"idle" | "checking" | "done" | "failed">("idle");
    const [copied, setCopied] = useState<"" | "yes" | "no">("");
    const editor = useRef<EditorHandle>(null);
    const seq = useRef(0);
    const onParsedRef = useRef(onParsed);
    onParsedRef.current = onParsed;

    const size = bytesOf(text);
    const tooBig = size > TEXT_MAX_BYTES;

    // The live check: after a pause in typing, one call at a time, and an older answer never replaces a newer one.
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        if (readOnly) return;
        if (answer?.forText === text) return;
        const timer = window.setTimeout(async () => {
            const n = ++seq.current;
            setState("checking");
            try {
                const data = await parseText(text);
                if (n !== seq.current) return;
                setAnswer({ forText: text, data });
                setState("done");
                onParsedRef.current?.(data, text);
            } catch (e) {
                if (n !== seq.current) return;
                // A busy answer (429) is not worth a message: it asks again a moment later.
                const busy = (e as { status?: number }).status === 429;
                setState(busy ? "idle" : "failed");
                window.setTimeout(() => setRetry((r) => r + 1), busy ? 1100 : 4000);
                if (!busy) onParsedRef.current?.(null, text);
            }
        }, CHECK_DELAY_MS);
        return () => clearTimeout(timer);
    }, [text, readOnly, retry, answer?.forText]);

    const problems: DslDiagnostic[] = useMemo(() => {
        const live = answer && answer.forText === text ? answer.data.diagnostics : [];
        const saved = saveProblems && saveProblems.forText === text ? saveProblems.items : [];
        const seen = new Set<string>();
        const out: DslDiagnostic[] = [];
        for (const d of [...live, ...saved]) {
            const key = `${d.line}|${d.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(d);
        }
        return out.sort((a, b) => a.line - b.line || a.column - b.column);
    }, [answer, saveProblems, text]);

    const errors = problems.filter((d) => d.severity === "error");
    const markers = useMemo(() => problems.map(asMarker), [problems]);
    const checkedNow = !!answer && answer.forText === text;
    const hintId = `${idPrefix}-hint`;

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied("yes");
        } catch {
            setCopied("no");
        }
        window.setTimeout(() => setCopied(""), 2500);
    }, [text]);

    return (
        <div className="stack">
            {readOnly && readOnlyWhy && <Callout tone="info">{readOnlyWhy}</Callout>}

            <section className="card code-bench" aria-label="Test as text">
                <div className="code-toolbar" role="toolbar" aria-label="Text actions">
                    {actions}
                    <Button icon={ClipboardCopy} onClick={() => void copy()}>
                        Copy text
                    </Button>
                    <Button icon={Download} onClick={() => downloadText(filename, text)}>
                        Download as .txt
                    </Button>
                    <span className="spacer" />
                    {readOnly && <Badge tone="neutral">Read-only</Badge>}
                    {badges}
                </div>
                <LazyEditor ref={editor} value={text} onChange={onChange} readOnly={readOnly} wrap={wrap} diagnostics={markers} describedBy={hintId} label={label} language="text" />
                <p className="t-meta code-hint" id={hintId}>
                    One line per step. To leave the editor with the keyboard, press Escape, then Tab. Ctrl+F searches, Ctrl+Z undoes.{" "}
                    <span className={tooBig ? "code-over" : ""}>
                        {Math.ceil(size / 1024)} KB of {TEXT_MAX_BYTES / 1024} KB.
                    </span>{" "}
                    <button type="button" className="dsl-linkbtn" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
                        {wrap ? "Stop wrapping long lines" : "Wrap long lines"}
                    </button>
                    <span className="sr-only" role="status">
                        {copied === "yes" ? "Copied to the clipboard." : copied === "no" ? "Copying failed. Select the text and copy it yourself." : ""}
                    </span>
                    {copied && (
                        <span className="dsl-copied" aria-hidden="true">
                            {copied === "yes" ? "Copied." : "Copying failed. Select the text and copy it."}
                        </span>
                    )}
                </p>
            </section>

            {tooBig && (
                <Callout tone="danger" title="This text is too long">
                    The limit is {TEXT_MAX_BYTES / 1024} KB. Split it into smaller tests.
                </Callout>
            )}

            {!readOnly && (
                <section className="card" aria-label="Problems">
                    <div className="card-head wrap">
                        <h2 className="t-section">Problems</h2>
                        <span className="t-meta" role="status" data-testid="dsl-check-state">
                            {state === "checking" && !checkedNow
                                ? "Checking…"
                                : state === "failed" && !checkedNow
                                  ? "The check could not run just now. It tries again when you stop typing."
                                  : checkedNow || problems.length
                                    ? problems.length
                                        ? `${errors.length} ${errors.length === 1 ? "problem" : "problems"} to fix`
                                        : "No problems found."
                                    : "Checked when you pause typing."}
                        </span>
                    </div>
                    {problems.length > 0 ? (
                        <ul className="code-diags divided" aria-label="Problems in the text">
                            {problems.map((d, i) => (
                                <li key={i}>
                                    <button type="button" className="code-diag" onClick={() => editor.current?.jumpTo(d.line, d.column)}>
                                        {d.severity === "error" ? <CircleAlert size={16} aria-hidden className="is-error" /> : <TriangleAlert size={16} aria-hidden className="is-warning" />}
                                        <span className="sev">{d.severity === "error" ? "Error" : "Warning"}</span>
                                        <span className="pos">
                                            Line {d.line}, column {d.column}
                                        </span>
                                        <span className="msg">
                                            {d.message}
                                            {d.suggestion && <span className="dsl-suggest"> {d.suggestion}</span>}
                                        </span>
                                    </button>
                                </li>
                            ))}
                            {answer?.data.truncated && answer.forText === text && <li className="code-ok t-secondary">There are more problems than are listed here. Fix these first.</li>}
                        </ul>
                    ) : (
                        <p className="code-ok t-secondary">{checkedNow ? "Nothing to fix." : "Problems appear here, with a link to the line."}</p>
                    )}
                </section>
            )}

            <PhrasesCard idPrefix={idPrefix} />
        </div>
    );
}

/** "Phrases you can use": made on the platform from the same table the parser reads, so it is never out of date. */
function PhrasesCard({ idPrefix }: { idPrefix: string }) {
    const [opened, setOpened] = useState(false);
    const ref = useFetch<Reference>(opened ? "/dsl/phrases" : null);
    const groups = useMemo(() => {
        const m = new Map<string, Reference["phrases"]>();
        for (const p of ref.data?.phrases ?? []) m.set(p.group, [...(m.get(p.group) ?? []), p]);
        return [...m.entries()];
    }, [ref.data]);
    return (
        <div className="card" style={{ padding: "0 var(--space-card-padding)" }}>
            <details className="disclosure" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open || opened)}>
                <summary>
                    <ChevronRight size={16} className="chev" aria-hidden />
                    Phrases you can use
                </summary>
                <div className="inner">
                    {ref.loading && (
                        <div aria-busy="true" aria-label="Loading the phrases">
                            <Skeleton w="60%" h={14} />
                            <Skeleton w="45%" h={14} style={{ marginTop: 10 }} />
                        </div>
                    )}
                    {ref.error && (
                        <Callout tone="warning" title="The phrases could not be loaded" actions={<Button size="sm" onClick={() => void ref.reload()}>Try again</Button>}>
                            {ref.error.message}
                        </Callout>
                    )}
                    {ref.data && (
                        <div className="stack-sm dsl-phrases" id={`${idPrefix}-phrases`}>
                            <p className="t-secondary">Each line of the text is one step. Words can be in any case. Texts go in double quotes.</p>
                            <h3 className="t-card">Lines at the top</h3>
                            <dl className="dsl-list">
                                {ref.data.headers.map((h) => (
                                    <div key={h.key}>
                                        <dt>
                                            <code>{h.line}</code>
                                        </dt>
                                        <dd>{h.about}</dd>
                                    </div>
                                ))}
                            </dl>
                            {groups.map(([group, list]) => (
                                <div key={group} className="stack-sm">
                                    <h3 className="t-card">{group}</h3>
                                    <dl className="dsl-list">
                                        {list.map((p) => (
                                            <div key={p.id}>
                                                <dt>
                                                    <code>{p.example}</code>
                                                </dt>
                                                <dd>
                                                    {p.about} <span className="t-meta">Form: {p.template}</span>
                                                </dd>
                                            </div>
                                        ))}
                                    </dl>
                                </div>
                            ))}
                            <h3 className="t-card">Good to know</h3>
                            <ul className="bullets">
                                {ref.data.notes.map((n, i) => (
                                    <li key={i}>{n}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </details>
        </div>
    );
}
