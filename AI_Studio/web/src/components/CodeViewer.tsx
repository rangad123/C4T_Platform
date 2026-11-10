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
    /** "done" after a copy; "failed" when the clipboard refused (said on the button, never "Copied"). */
    const [copied, setCopied] = useState<"done" | "failed" | null>(null);
    return (
        <div className="code-wrap">
            <div className="code-bar">
                <span>{label ?? filename}</span>
                <span className="spacer" />
                <Button
                    size="sm"
                    variant="ghost"
                    icon={copied === "done" ? Check : Copy}
                    tip={copied === "failed" ? "The browser did not allow copying here. Select the code and copy it yourself." : fullCode !== undefined && fullCode !== code ? "Copies the whole script, including the setup code folded below." : undefined}
                    onClick={async () => {
                        const ok = await Promise.resolve()
                            .then(() => navigator.clipboard.writeText(fullCode ?? code))
                            .then(() => true, () => false);
                        setCopied(ok ? "done" : "failed");
                        setTimeout(() => setCopied(null), ok ? 1500 : 4000);
                    }}
                >
                    <span aria-live="polite">{copied === "done" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy"}</span>
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
