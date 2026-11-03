import { Callout } from "../../components/ui";

/**
 * The runner downloads are not signed with a code-signing certificate yet, so Windows SmartScreen and macOS Gatekeeper warn before the
 * first start. What they show, and how to get past it, in the words the person will see on screen.
 */
export function UnsignedNotice({ platform }: { platform: "windows" | "unix" }) {
    if (platform === "windows") {
        return (
            <Callout tone="info" title="Windows will warn you the first time">
                <div className="stack-sm" data-testid="unsigned-windows">
                    <p>These downloads are not signed yet, so Windows does not know who made them.</p>
                    <ul className="ag-steps">
                        <li>
                            If your browser says the file <b>is not commonly downloaded</b>, choose Keep (in Edge: the three dots, Keep, then Keep anyway).
                        </li>
                        <li>
                            When you start <code>start-runner.cmd</code> or <code>AITestingRunnerSetup.exe</code>, SmartScreen shows <b>Windows protected your PC</b>. Choose <b>More info</b>, then <b>Run anyway</b>.
                        </li>
                        <li>If nothing happens or Windows still blocks it: right-click the zip before you unzip it, choose Properties, tick Unblock, choose OK, then unzip it again.</li>
                    </ul>
                </div>
            </Callout>
        );
    }
    return (
        <Callout tone="info" title="macOS will warn you the first time">
            <div className="stack-sm" data-testid="unsigned-mac">
                <p>These downloads are not signed or notarised by Apple yet, so Gatekeeper stops the first start.</p>
                <ul className="ag-steps">
                    <li>
                        macOS says <b>Apple could not verify “start-runner.command” is free of malware</b> (older versions: <b>cannot be opened because it is from an unidentified developer</b>). Choose Done.
                    </li>
                    <li>
                        Open System Settings, Privacy &amp; Security, scroll down to Security and choose <b>Open Anyway</b>, then confirm with your Mac password. On macOS 14 or older you can instead right-click (Control-click) the file and choose Open.
                    </li>
                    <li>
                        Starting it from Terminal with <code>sh start-runner.sh</code> avoids the question. On Linux there is no such warning.
                    </li>
                </ul>
            </div>
        </Callout>
    );
}
