/** A runner's updates in Settings (docs/features/runner-updates.md): its version, what it is doing about an update, and Update now. */
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import type { RunnerUpdateView } from "./runners";

/** What a runner whose update could not be checked shows. */
const NEEDS_MANUAL_UPDATE = "An update is available but couldn't be checked on this computer. Download the runner again from Settings, Your runner.";

/** "1.4.0 (3f2a9c81d0)" from a kit version "1.4.0+3f2a9c81d0". */
export function versionWords(v: string | undefined): string {
    if (!v) return "an unknown version";
    const [base, hash] = v.split("+");
    return hash ? `${base} (${hash})` : v;
}

/** "in 5 min", "in about 2 hours", "in a moment" for a time to come. */
export function inWords(iso: string, now = Date.now()): string {
    const m = Math.round((new Date(iso).getTime() - now) / 60_000);
    if (!Number.isFinite(m) || m < 1) return "in a moment";
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    return `in about ${h} hour${h === 1 ? "" : "s"}`;
}

/** One sentence about the runner's update state, or nothing when there is nothing to say. Also used by the tests. */
export function updateSentence(u: RunnerUpdateView, current: string | undefined, online: boolean): { tone: "info" | "warning" | "success"; text: string } | undefined {
    const now = versionWords(current);
    if (u.state === "needs-manual") return { tone: "warning", text: NEEDS_MANUAL_UPDATE };
    if (u.state === "failed" && u.outOfDate) return { tone: "warning", text: `Could not update: ${u.error ?? "no reason given."} Still on version ${now}.${u.retryAt ? ` It tries again ${inWords(u.retryAt)}.` : ""}` };
    if (u.state === "rolled-back" && u.outOfDate) return { tone: "warning", text: `Went back to version ${now}${u.to ? ` from ${versionWords(u.to)}` : ""}: ${u.error ?? "no reason given."} It does not install that version again by itself; choose Update now to try again.` };
    if (!u.outOfDate) {
        if (u.state === "updated" && u.at && u.from) return { tone: "success", text: `Updated itself from version ${versionWords(u.from)} ${relativeTime(u.at)}.` };
        return undefined;
    }
    const latest = versionWords(u.latest);
    // Nothing published to update from (an unsigned download, for one): only a new download brings the newer version.
    if (u.published === false) return { tone: "info", text: `Download the runner again from Settings to get version ${latest}.` };
    if (!u.can) return { tone: "warning", text: `This platform runs runner version ${latest}. This runner cannot update itself (it was started from the project folder or from an older download). Set up this computer again from Settings to get updates.` };
    if (u.state === "preparing") return { tone: "info", text: `Updating to version ${latest}: downloading and checking. It takes no new tests until it has restarted.` };
    if (u.state === "ready") return { tone: "info", text: `Updating to version ${latest}: waiting for its running tests to finish, then it restarts.` };
    // Updates are always on (the server sets every runner to update itself); Update now only brings it forward.
    return { tone: "info", text: `Version ${latest} is available. ${online ? "It updates between tests." : "It updates when it is next online."}` };
}

/** The person's runner's updates in Settings: one sentence, and Update now while a newer version waits (POST /api/me/runner/update). */
export function RunnerUpdates({ name, update: u, version, online, onChanged }: { name: string; update: RunnerUpdateView; version: string | undefined; online: boolean; onChanged: () => Promise<void> | void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const sentence = updateSentence(u, version, online);
    async function now() {
        setBusy(true);
        setError("");
        try {
            await api("/me/runner/update", { method: "POST" });
            await onChanged();
        } catch (e) {
            // A 409 (for example: this platform's runner download is not signed, so no update is offered) is the server's own sentence.
            setError(e instanceof ApiError && e.status === 409 ? e.message : describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    const working = u.state === "preparing" || u.state === "ready";
    return (
        <div className="ag-update stack-sm" data-testid="agent-update">
            {sentence && (
                <p className={`t-secondary ag-update-line is-${sentence.tone}`} data-testid="agent-update-status">
                    {sentence.text}
                </p>
            )}
            {u.published === false && u.unpublished && (
                <p className="t-secondary" data-testid="agent-update-unpublished">
                    This platform offers no automatic update: {u.unpublished}
                </p>
            )}
            {u.can && u.published !== false && u.outOfDate && !working && u.state !== "needs-manual" && (
                <div>
                    <Button size="sm" icon={RefreshCw} loading={busy} disabled={u.requested} onClick={() => void now()} tip="It downloads that version, checks it, and restarts between tests." aria-label={u.requested ? `Update asked for ${name}` : `Update ${name} to version ${versionWords(u.latest)}`}>
                        {u.requested ? "Update asked for" : "Update now"}
                    </Button>
                </div>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
