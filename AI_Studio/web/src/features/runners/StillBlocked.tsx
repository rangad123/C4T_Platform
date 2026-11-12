import { ChevronRight } from "lucide-react";
import { boldScripts } from "./bold";
import { checkComputerHelp, type RunnerOs } from "./my-runner";

/**
 * "Still blocked?" under the start steps. The downloads are not code-signed yet: the steps already say how to get past the first warning
 * of the installer, so this keeps only the other cases (a browser that holds the download, the plain files, a blocked zip) and the check.
 */
export function StillBlocked({ os, kind }: { os: RunnerOs; kind: "installer" | "files" }) {
    return (
        <details className="disclosure" data-testid="still-blocked">
            <summary>
                <ChevronRight size={16} className="chev" aria-hidden />
                Still blocked?
            </summary>
            <div className="inner">
                <ul className="ag-steps">
                    {os === "windows" && (
                        <>
                            <li>
                                If your browser says the file <b>is not commonly downloaded</b>, choose Keep (in Edge: the three dots, Keep, then Keep anyway).
                            </li>
                            {kind === "files" && (
                                <li>
                                    When you start <code>start-runner.cmd</code>, SmartScreen shows <b>Windows protected your PC</b>: the files are not signed yet. Choose <b>More info</b>, then <b>Run anyway</b>.
                                </li>
                            )}
                            <li>If nothing happens or Windows still blocks it: right-click the zip before you unzip it, choose Properties, tick Unblock, choose OK, then unzip it again.</li>
                        </>
                    )}
                    <li>{boldScripts(checkComputerHelp(os))}</li>
                </ul>
            </div>
        </details>
    );
}
