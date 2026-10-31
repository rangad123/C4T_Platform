import { splitScript } from "../lib/script";
import { CodeViewer } from "./CodeViewer";
import { Disclosure } from "./ui";

/**
 * A generated script as a tester wants to read it: the test first, the platform's setup code folded behind one line.
 * Copy and Download still give the whole script, so what is saved is what runs. (Where the test starts: lib/script.ts.)
 */
export function ScriptPreview({ code, filename, label }: { code: string; filename?: string; label?: string }) {
    const parts = splitScript(code);
    if (!parts) return <CodeViewer code={code} filename={filename} label={label} />;
    return (
        <div className="script-preview stack-sm" data-testid="script-preview">
            <CodeViewer code={parts.body} fullCode={code} filename={filename} label={label} />
            <Disclosure label={`Show setup code (${parts.setupLines} lines)`}>
                <p className="t-meta" style={{ marginBottom: 8 }}>
                    The platform adds this before your test: its evidence recorder, your test values and, when the test signs in, the check that keeps stored sign-in details on your own site. You do not need to read it.
                </p>
                <CodeViewer code={parts.setup} label="Setup code" />
            </Disclosure>
        </div>
    );
}
