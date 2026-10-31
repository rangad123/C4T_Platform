/**
 * The script editor (CodeMirror 6). This module is the only place that imports CodeMirror and it is loaded lazily
 * (see LazyEditor.tsx), so no other page pays for it. Colours come from the design tokens.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, insertTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, lintKeymap, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap, closeSearchPanel } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Diagnostic } from "./code";

export interface EditorHandle {
    jumpTo: (line: number, column: number) => void;
    focus: () => void;
}
interface Props {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    wrap?: boolean;
    diagnostics?: Diagnostic[];
    describedBy?: string;
    onSave?: () => void;
    label?: string;
    /** "text" is for plain text such as a test written as text: no script colours, no code completion, no automatic brackets. Default: a script. */
    language?: "script" | "text";
}

const theme = EditorView.theme({
    "&": { color: "var(--text-primary)", backgroundColor: "var(--surface-canvas)", fontSize: "13.5px", minHeight: "300px", maxHeight: "70vh" },
    "&.cm-focused": { outline: "2px solid var(--focus-outline)", outlineOffset: "-2px" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
    ".cm-content": { caretColor: "var(--text-primary)", padding: "10px 0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
    ".cm-gutters": { backgroundColor: "var(--surface-sunken)", color: "var(--text-muted)", border: "none", borderRight: "1px solid var(--border-default)" },
    ".cm-activeLine": { backgroundColor: "var(--surface-hover)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--surface-hover)", color: "var(--text-primary)" },
    ".cm-selectionBackground": { backgroundColor: "var(--surface-muted)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: "var(--surface-brand-subtle)" },
    ".cm-selectionMatch": { backgroundColor: "var(--surface-muted)" },
    "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--surface-brand-subtle)", outline: "1px solid var(--border-brand)" },
    "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "var(--status-error-bg)" },
    ".cm-panels": { backgroundColor: "var(--surface-sunken)", color: "var(--text-primary)", borderColor: "var(--border-default)" },
    ".cm-panels-bottom": { borderTop: "1px solid var(--border-default)" },
    ".cm-panels-top": { borderBottom: "1px solid var(--border-default)" },
    ".cm-textfield": { backgroundColor: "var(--surface-canvas)", color: "var(--text-primary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-input)", padding: "6px 8px", fontFamily: "var(--font-sans)", fontSize: "14px" },
    ".cm-button": { backgroundImage: "none", backgroundColor: "var(--action-secondary-bg)", color: "var(--text-primary)", border: "1px solid var(--action-secondary-border)", borderRadius: "var(--radius-button)", padding: "6px 10px", fontFamily: "var(--font-sans)", fontSize: "14px", minHeight: "32px" },
    ".cm-panel.cm-search label": { fontFamily: "var(--font-sans)", fontSize: "14px" },
    ".cm-panel.cm-search [name=close]": { color: "var(--text-primary)", fontSize: "18px" },
    ".cm-searchMatch": { backgroundColor: "var(--status-warning-bg)", outline: "1px solid var(--status-warning-line)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--status-warning-line)" },
    ".cm-tooltip": { backgroundColor: "var(--surface-raised)", color: "var(--text-primary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--surface-brand-subtle)", color: "var(--text-primary)" },
    ".cm-tooltip-lint": { fontFamily: "var(--font-sans)", fontSize: "13px" },
    ".cm-diagnostic": { borderLeftWidth: "4px" },
    ".cm-diagnostic-error": { borderLeftColor: "var(--status-error-fg)" },
    ".cm-diagnostic-warning": { borderLeftColor: "var(--status-warning-fg)" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--status-error-fg)", textUnderlineOffset: "3px" },
    ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--status-warning-fg)", textUnderlineOffset: "3px" },
});

// Token colours: each is a status or text token that already meets 4.5:1 on the canvas.
const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--text-brand)", fontWeight: "500" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--status-success-fg)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--status-warning-fg)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--text-muted)", fontStyle: "italic" },
    { tag: [t.typeName, t.className, t.namespace], color: "var(--status-info-fg)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--text-primary)", fontWeight: "600" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--text-secondary)" },
    { tag: t.invalid, color: "var(--status-error-fg)" },
]);

/** Positions for the problem markers: the word at the reported place, or the line when the place is at its end. */
function toCm(view: EditorView, list: Diagnostic[]): CmDiagnostic[] {
    const doc = view.state.doc;
    const out: CmDiagnostic[] = [];
    for (const d of list) {
        const ln = Math.min(Math.max(1, d.line), doc.lines);
        const line = doc.line(ln);
        const pos = Math.min(line.from + Math.max(0, d.column - 1), line.to);
        let from = pos;
        let to = pos;
        const word = pos < line.to ? view.state.wordAt(pos) : null;
        if (word && word.from <= pos) ((from = word.from), (to = word.to));
        else if (pos < line.to) to = pos + 1;
        else ((from = line.from), (to = line.to));
        out.push({ from, to, severity: d.severity, message: d.rule ? `${d.message} (${d.rule})` : d.message, source: "check" });
    }
    return out;
}

const CodeEditor = forwardRef<EditorHandle, Props>(function CodeEditor({ value, onChange, readOnly, wrap, diagnostics, describedBy, onSave, label = "Script editor", language = "script" }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const cb = useRef({ onChange, onSave });
    cb.current = { onChange, onSave };
    const wrapC = useRef(new Compartment());
    const roC = useRef(new Compartment());
    const attrC = useRef(new Compartment());

    useEffect(() => {
        // Escape then Tab leaves the editor: Tab is otherwise used for indentation.
        let escaped = false;
        const tab = (back: boolean) => (v: EditorView) => {
            if (escaped) {
                escaped = false;
                return false; // let the browser move focus
            }
            if (back) return indentLess(v);
            return v.state.selection.ranges.some((r) => !r.empty) ? indentMore(v) : insertTab(v);
        };
        const v = new EditorView({
            parent: host.current!,
            state: EditorState.create({
                doc: value,
                extensions: [
                    lineNumbers(),
                    highlightActiveLineGutter(),
                    history(),
                    drawSelection(),
                    indentOnInput(),
                    bracketMatching(),
                    ...(language === "text" ? [] : [closeBrackets(), autocompletion()]),
                    highlightActiveLine(),
                    highlightSelectionMatches(),
                    lintGutter(),
                    ...(language === "text" ? [] : [javascript({ typescript: true }), syntaxHighlighting(highlight)]),
                    theme,
                    keymap.of([
                        { key: "Escape", run: (view) => (closeSearchPanel(view) ? true : ((escaped = true), false)) },
                        { key: "Tab", run: tab(false) },
                        { key: "Shift-Tab", run: tab(true) },
                        { key: "Mod-s", run: () => (cb.current.onSave?.(), true) },
                        ...closeBracketsKeymap,
                        ...defaultKeymap,
                        ...searchKeymap,
                        ...historyKeymap,
                        ...completionKeymap,
                        ...lintKeymap,
                    ]),
                    EditorView.domEventHandlers({
                        keydown: (e) => {
                            if (e.key !== "Escape" && e.key !== "Tab" && e.key !== "Shift") escaped = false;
                            return false;
                        },
                        blur: () => {
                            escaped = false;
                            return false;
                        },
                    }),
                    wrapC.current.of(wrap ? EditorView.lineWrapping : []),
                    roC.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(true)]),
                    attrC.current.of(EditorView.contentAttributes.of({ "aria-label": label, ...(describedBy ? { "aria-describedby": describedBy } : {}) })),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) cb.current.onChange?.(u.state.doc.toString());
                    }),
                ],
            }),
        });
        view.current = v;
        return () => {
            v.destroy();
            view.current = null;
        };
        // The view is created once; everything that changes later goes through the effects below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // A new value from outside (a restored version, a discard): replace the text only when it really differs.
    useEffect(() => {
        const v = view.current;
        if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }, [value]);
    useEffect(() => {
        view.current?.dispatch({ effects: wrapC.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
    }, [wrap]);
    useEffect(() => {
        view.current?.dispatch({ effects: roC.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(true)]) });
    }, [readOnly]);
    useEffect(() => {
        view.current?.dispatch({ effects: attrC.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": label, ...(describedBy ? { "aria-describedby": describedBy } : {}) })) });
    }, [label, describedBy]);
    useEffect(() => {
        const v = view.current;
        if (v) v.dispatch(setDiagnostics(v.state, toCm(v, diagnostics ?? [])));
    }, [diagnostics]);

    useImperativeHandle(ref, () => ({
        focus: () => view.current?.focus(),
        jumpTo: (line, column) => {
            const v = view.current;
            if (!v) return;
            const l = v.state.doc.line(Math.min(Math.max(1, line), v.state.doc.lines));
            const pos = Math.min(l.from + Math.max(0, column - 1), l.to);
            v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
            v.focus();
        },
    }));

    return <div ref={host} className="code-cm" data-testid="script-editor" />;
});

export default CodeEditor;
