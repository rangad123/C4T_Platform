import { useState } from "react";
import { ApiError, downloadFrom } from "../../api";
import { Button, Callout } from "../../components/ui";

/** Which setup script to offer first, from the browser's platform (just the default; both buttons are always shown). */
function guessOs(): "windows" | "unix" {
    const s = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
    return /win/.test(s) && !/darwin|mac/.test(s) ? "windows" : "unix";
}

/**
 * Settings → Mobile testing, when no emulator is set up: download a small setup script for the computer that runs the platform, and the
 * steps to run it. The script downloads the Android tools and creates an emulator (platform/emulator-setup.ts).
 */
export function EmulatorSetup() {
    const [busy, setBusy] = useState<"windows" | "unix" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const first = guessOs();

    const download = async (os: "windows" | "unix") => {
        setBusy(os);
        setError(null);
        try {
            await downloadFrom(`/mobile/emulator-setup?os=${os}`, os === "windows" ? "setup-emulator.cmd" : "setup-emulator.sh");
        } catch (e) {
            setError(e instanceof ApiError && (e.status === 401 || e.status === 403) ? "You do not have access to download this." : "The setup script could not be downloaded.");
        } finally {
            setBusy(null);
        }
    };

    const btn = (os: "windows" | "unix", label: string) => (
        <Button variant={os === first ? "primary" : "secondary"} disabled={busy !== null} loading={busy === os} onClick={() => void download(os)}>
            {busy === os ? "Preparing…" : `Download for ${label}`}
        </Button>
    );

    return (
        <div className="stack-sm" data-testid="emulator-setup">
            <p className="t-secondary">Download a one-step setup for the computer that runs the platform. It sets up an Android emulator so mobile tests can run here.</p>
            <div className="row">
                {btn("windows", "Windows")}
                {btn("unix", "Mac or Linux")}
            </div>
            <ol className="t-secondary" style={{ margin: 0, paddingLeft: "1.25rem" }}>
                <li>Download the file for this computer and open it (on Mac or Linux, run <code>sh setup-emulator.sh</code> in a terminal).</li>
                <li>It needs <strong>Node.js 24 or newer</strong>; it downloads the Android tools and a system image (about 2–3&nbsp;GB, usually 15–30 minutes) and creates an emulator. If a download is cut off, run it again: it continues where it stopped.</li>
                <li>Give it about <strong>15&nbsp;GB</strong> of free disk and <strong>3&nbsp;GB</strong> of free memory; the emulator needs hardware virtualization turned on.</li>
                <li>When it finishes, reload this page — Mobile testing should say <strong>Ready</strong>.</li>
            </ol>
            <p className="t-meta">
                Prefer the command line? Run <code>npx @taqwright/taqwright install --with-avd</code> on this computer instead.
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
