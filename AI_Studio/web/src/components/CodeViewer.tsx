import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import { Check, Copy, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { downloadBlob } from "../lib/format";
import { Button } from "./ui";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);

/** Syntax-highlighted, scrollable code with copy/download. Renders escaped text — highlight.js output is safe HTML. */
export function CodeViewer({ code, language = "typescript", filename, label, fullCode }: { code: string; language?: "typescript" | "json"; filename?: string; label?: string; /** What Copy and Download give when only part of the script is shown (the test body, with the setup code folded away). */ fullCode?: string }) {
    const html = useMemo(() => hljs.highlight(code, { language }).value, [code, language]);
    const [copied, setCopied] = useState(false);
    return (
        <div className="code-wrap">
            <div className="code-bar">
                <span>{label ?? filename}</span>
                <span className="spacer" />
                <Button
                    size="sm"
                    variant="ghost"
                    icon={copied ? Check : Copy}
                    tip={fullCode !== undefined && fullCode !== code ? "Copies the whole script, including the setup code folded below." : undefined}
                    onClick={async () => {
                        await navigator.clipboard.writeText(fullCode ?? code).catch(() => undefined);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    }}
                >
                    {copied ? "Copied" : "Copy"}
                </Button>
                {filename && (
                    <Button size="sm" variant="ghost" icon={Download} tip={fullCode !== undefined && fullCode !== code ? `Saves the whole script as ${filename}, including the setup code folded below.` : `Saves it as ${filename}.`} onClick={() => downloadBlob(new Blob([fullCode ?? code], { type: "text/plain" }), filename)}>
                        Download
                    </Button>
                )}
            </div>
            <pre className="code" tabIndex={0}>
                <code dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
        </div>
    );
}
