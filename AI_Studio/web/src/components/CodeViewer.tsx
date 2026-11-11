import { Check, Copy, Download } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { downloadBlob } from "../lib/format";
import { Button } from "./ui";

/** Syntax-highlighted, scrollable code with copy/download. */
export function CodeViewer({ code, language = "typescript", filename, label, fullCode }: { code: string; language?: "typescript" | "json"; filename?: string; label?: string; /** What Copy and Download give when only part of the script is shown (the test body, with the setup code folded away). */ fullCode?: string }) {
    // Plain text first; the colours arrive with the parser (a lazy chunk, like the editor).
    const [highlighted, setHighlighted] = useState<ReactNode[] | null>(null);
    useEffect(() => {
        let live = true;
        setHighlighted(null);
        void import("./code-spans").then((m) => live && setHighlighted(m.codeSpans(code, language)));
        return () => {
            live = false;
        };
    }, [code, language]);
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
                <code>{highlighted ?? code}</code>
            </pre>
        </div>
    );
}
