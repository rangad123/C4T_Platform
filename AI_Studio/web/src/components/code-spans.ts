/** Syntax colours for CodeViewer, loaded on demand. Only the parser, never @codemirror/view, so the editor stays in its own chunk. */
// shortcut: @lezer/javascript comes with @codemirror/lang-javascript and is not listed in package.json; list it when packages may change.
import { parser } from "@lezer/javascript";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { createElement, type ReactNode } from "react";

// The editor's own TypeScript parser; JSON is read as one JavaScript expression.
const PARSERS = { typescript: parser.configure({ dialect: "ts" }), json: parser.configure({ top: "SingleExpression" }) };

/** The code as text nodes in spans with tok-* classes: React escapes it, so no HTML is ever built from the code. */
export function codeSpans(code: string, language: keyof typeof PARSERS): ReactNode[] {
    const out: ReactNode[] = [];
    let at = 0;
    highlightTree(PARSERS[language].parse(code), classHighlighter, (from, to, classes) => {
        if (from > at) out.push(code.slice(at, from));
        out.push(createElement("span", { key: from, className: classes }, code.slice(from, to)));
        at = to;
    });
    if (at < code.length) out.push(code.slice(at));
    return out;
}
