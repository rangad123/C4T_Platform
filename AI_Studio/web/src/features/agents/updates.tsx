/** A runner's updates on its row (docs/features/runner-updates.md): its version, what it is doing about an update, the switch and the button. */
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import type { Agent, RunnerUpdateView } from "./agents";

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
    if (u.state === "failed" && u.outOfDate) return { tone: "warning", text: `Could not update: ${u.error ?? "no reason given."} Still on version ${now}.${u.retryAt ? ` It tries again ${inWords(u.retryAt)}.` : ""}` };
    if (u.state === "rolled-back" && u.outOfDate) return { tone: "warning", text: `Went back to version ${now}${u.to ? ` from ${versionWords(u.to)}` : ""}: ${u.error ?? "no reason given."} It does not install that version again by itself; use Update this runner to try again.` };
    if (!u.outOfDate) {
        if (u.state === "updated" && u.at && u.from) return { tone: "success", text: `Updated itself from version ${versionWords(u.from)} ${relativeTime(u.at)}.` };
        return undefined;
    }
    const latest = versionWords(u.latest);
    if (!u.can) return { tone: "warning", text: `This platform runs runner version ${latest}. This runner cannot update itself (it was started from the project folder or from an older download). Download a new runner to get updates.` };
    if (u.state === "preparing") return { tone: "info", text: `Updating to version ${latest}: downloading and checking. It takes no new tests until it has restarted.` };
    if (u.state === "ready") return { tone: "info", text: `Updating to version ${latest}: waiting for its running tests to finish, then it restarts.` };
    if (!online) return { tone: "info", text: `Version ${latest} is available. ${u.auto || u.requested ? "It updates when it is next online." : "Automatic updates are off for this runner."}` };
    if (u.requested || u.auto) return { tone: "info", text: `Version ${latest} is available. It updates between tests.` };
    return { tone: "info", text: `Version ${latest} is available. Automatic updates are off for this runner.` };
}

export function RunnerUpdates({ projectId, a, onChanged }: { projectId: string; a: Agent; onChanged: () => void }) {
    const u = a.update!;
    const [busy, setBusy] = useState<"" | "auto" | "now">("");
    const [error, setError] = useState("");
    const sentence = updateSentence(u, a.capabilities.kitVersion, a.online);

    async function call(kind: "auto" | "now", path: string, method: "PUT" | "POST", body?: unknown) {
        setBusy(kind);
        setError("");
        try {
            await api(path, { method, ...(body !== undefined ? { body } : {}) });
            onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
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
            {u.can && (
                <div className="ag-update-controls">
                    <label className="check">
                        <input type="checkbox" checked={u.auto} disabled={busy !== ""} onChange={(e) => void call("auto", `/projects/${projectId}/agents/${a.id}/updates`, "PUT", { auto: e.target.checked })} />
                        <span>
                            <span className="title">Update automatically</span>
                            <span className="hint">When this platform is updated, the runner downloads the same version, checks it and restarts between tests.</span>
                        </span>
                    </label>
                    {u.outOfDate && !u.auto && !working && (
                        <div>
                            <Button size="sm" icon={RefreshCw} loading={busy === "now"} disabled={u.requested} onClick={() => void call("now", `/projects/${projectId}/agents/${a.id}/update`, "POST")} tip="It downloads that version, checks it, and restarts between tests." aria-label={u.requested ? `Update asked for ${a.name}` : `Update ${a.name} to version ${versionWords(u.latest)}`}>
                                {u.requested ? "Update asked for" : "Update this runner"}
                            </Button>
                        </div>
                    )}
                </div>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
