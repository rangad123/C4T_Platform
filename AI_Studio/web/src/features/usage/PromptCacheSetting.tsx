import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

/** GET /api/llm/prompt-cache (src/platform/prompt-cache-settings.ts). */
interface PromptCacheAnswer {
    enabled: boolean;
    source: "app" | "environment" | "default";
    environment: boolean | null;
    provider: string;
    model: string;
    style: "anthropic" | "anthropic-passthrough" | "automatic" | "none";
    explanation: string;
}

/** Settings, inside "AI model": the prompt-caching switch (on by default), what it does for the model in use, and where the choice comes from. */
export function PromptCacheSetting() {
    const state = useFetch<PromptCacheAnswer>("/llm/prompt-cache");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The box follows the click at once; the saved answer replaces it (or the old value comes back with an error).
    const [pending, setPending] = useState<boolean | null>(null);

    if (state.loading) return <Skeleton h={44} />;
    if (state.error || !state.data) {
        return (
            <Callout tone="warning" title="Could not load the prompt caching setting" actions={<Button size="sm" onClick={() => void state.reload()}>Try again</Button>}>
                {describeApiError(state.error)}
            </Callout>
        );
    }
    const s = state.data;
    const save = async (enabled: boolean | null) => {
        setBusy(true);
        setError(null);
        setPending(enabled);
        try {
            await api("/llm/prompt-cache", { method: "PUT", body: { enabled } });
            await state.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setPending(null);
            setBusy(false);
        }
    };
    const serverWord = s.environment === null ? "on (nothing is set on the server)" : s.environment ? "on" : "off";

    return (
        <div className="stack-sm" data-testid="prompt-cache-setting">
            <label className="check">
                <input type="checkbox" checked={pending ?? s.enabled} disabled={busy} onChange={(e) => void save(e.target.checked)} />
                <span>
                    <span className="title">
                        Reuse repeated instructions (prompt caching){" "}
                        <HelpTip label="prompt caching" text="The model gets the same request either way: the instructions and tool descriptions that repeat on every call are only marked so the provider can read them from its cache at a lower price. Nothing about what is tested or judged changes." />
                    </span>
                    <span className="hint" data-testid="prompt-cache-explanation">
                        {s.explanation} Cached tokens are listed in AI usage and count less toward the limits.
                    </span>
                </span>
            </label>
            <div className="row">
                <span className="t-meta" data-testid="prompt-cache-source">
                    {s.source === "app" ? `Set here. The server’s own setting is ${serverWord}.` : s.source === "environment" ? `From the server’s settings (LLM_PROMPT_CACHE).` : "On by default."}
                </span>
                {s.source === "app" && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                        Use the server’s setting
                    </Button>
                )}
            </div>
            {!s.enabled && <p className="t-meta">Off: every request is read at the full input price.</p>}
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
