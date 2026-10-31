import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

/** GET/PUT /api/llm/compact-snapshots (platform/snapshot-settings.ts). */
interface CompactSnapshotsAnswer {
    enabled: boolean;
    source: "app" | "environment" | "default";
    environment: boolean | null;
}

/** Settings, inside "AI model": the switch for smaller page snapshots (docs/features/smaller-snapshots.md). */
export function CompactSnapshotsSetting() {
    const answer = useFetch<CompactSnapshotsAnswer>("/llm/compact-snapshots");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The box follows the click at once; the saved answer replaces it (or the old value comes back with an error).
    const [pending, setPending] = useState<boolean | null>(null);

    if (answer.loading) return <Skeleton h={44} />;
    if (answer.error || !answer.data) {
        return (
            <Callout tone="warning" title="Could not load the page snapshot setting" actions={<Button size="sm" onClick={() => void answer.reload()}>Try again</Button>}>
                {describeApiError(answer.error)}
            </Callout>
        );
    }
    const s = answer.data;
    const save = async (enabled: boolean | null) => {
        setBusy(true);
        setError(null);
        setPending(enabled);
        try {
            await api("/llm/compact-snapshots", { method: "PUT", body: { enabled } });
            await answer.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setPending(null);
            setBusy(false);
        }
    };
    const serverDefault = s.environment === null ? "on" : s.environment ? "on" : "off";
    return (
        <div className="stack-sm" data-testid="compact-snapshots-setting">
            <label className="check">
                <input type="checkbox" checked={pending ?? s.enabled} disabled={busy} onChange={(e) => void save(e.target.checked)} />
                <span>
                    <span className="title">Send smaller page snapshots to the AI</span>
                    <span className="hint">
                        After each step the AI reads the page. With this on it gets a shorter version (decorations left out, long lists shortened) and, on the same page, only what changed. It can still ask for the whole page. Names it copies into tests are never changed. Applies from the next test the AI writes.
                    </span>
                </span>
            </label>
            {s.source === "app" ? (
                <p className="t-meta" data-testid="compact-snapshots-source">
                    Saved here.{" "}
                    <Button variant="link" disabled={busy} onClick={() => void save(null)}>
                        Use the server’s setting ({serverDefault})
                    </Button>
                </p>
            ) : (
                <p className="t-meta" data-testid="compact-snapshots-source">{s.source === "environment" ? "Taken from the server’s settings (LLM_COMPACT_SNAPSHOTS)." : "On by default."}</p>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
