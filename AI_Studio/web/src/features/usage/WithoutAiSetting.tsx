import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

/** One switch of GET /api/llm/without-ai (src/platform/without-ai-settings.ts). */
interface SwitchAnswer {
    enabled: boolean;
    source: "app" | "environment" | "default";
    environment: boolean | null;
    variable: string;
}
interface WithoutAiAnswer {
    deterministicRepair: SwitchAnswer;
    explorationReuse: SwitchAnswer;
}
type Key = keyof WithoutAiAnswer;

const TEXT: Record<Key, { title: string; help: string; hint: string; off: string }> = {
    deterministicRepair: {
        title: "Repair without AI first",
        help: "When a test cannot find an element, the platform first tries plain fixes: another way to find a shared element, the same role and name, the same text, or the element's own attributes. A fix is kept only if the test then passes. The AI is asked only when none does.",
        hint: "Fixes that work without AI are listed in the job's activity and in AI usage.",
        off: "Off: every repair is done by the AI.",
    },
    explorationReuse: {
        title: "Reuse what was understood about unchanged pages",
        help: "When a site is explored again, pages that have not changed since the last exploration are not sent to the AI again. What it understood about them then is used. The crawl itself always visits every page. You can still ask for a full exploration when you start one.",
        hint: "Needs “Start from what we learned last time” on the exploration.",
        off: "Off: every page is sent to the AI on every exploration.",
    },
};

/** Settings, inside "How the AI works here": the two "no AI where it is not needed" switches (on by default), and where each choice comes from. */
export function WithoutAiSetting() {
    const state = useFetch<WithoutAiAnswer>("/llm/without-ai");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The box follows the click at once; the saved answer replaces it (or the old value comes back with an error).
    const [pending, setPending] = useState<{ key: Key; enabled: boolean | null } | null>(null);

    if (state.loading) return <Skeleton h={88} />;
    if (state.error || !state.data) {
        return (
            <Callout tone="warning" title="Could not load the settings for using less AI" actions={<Button size="sm" onClick={() => void state.reload()}>Try again</Button>}>
                {describeApiError(state.error)}
            </Callout>
        );
    }
    const save = async (key: Key, enabled: boolean | null) => {
        setBusy(true);
        setError(null);
        setPending({ key, enabled });
        try {
            await api("/llm/without-ai", { method: "PUT", body: { [key]: enabled } });
            await state.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setPending(null);
            setBusy(false);
        }
    };

    return (
        <div className="stack-sm" data-testid="without-ai-setting">
            {(Object.keys(TEXT) as Key[]).map((key) => {
                const s = state.data![key];
                const t = TEXT[key];
                const serverWord = s.environment === null ? "on (nothing is set on the server)" : s.environment ? "on" : "off";
                return (
                    <div className="stack-sm" key={key} data-testid={`without-ai-${key}`}>
                        <label className="check">
                            <input type="checkbox" checked={pending?.key === key ? (pending.enabled ?? s.enabled) : s.enabled} disabled={busy} onChange={(e) => void save(key, e.target.checked)} />
                            <span>
                                <span className="title">
                                    {t.title} <HelpTip label={t.title.toLowerCase()} text={t.help} />
                                </span>
                                <span className="hint">{t.hint}</span>
                            </span>
                        </label>
                        <div className="row">
                            <span className="t-meta">{s.source === "app" ? `Set here. The server’s own setting is ${serverWord}.` : s.source === "environment" ? `From the server’s settings (${s.variable}).` : "On by default."}</span>
                            {s.source === "app" && (
                                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(key, null)}>
                                    Use the server’s setting
                                </Button>
                            )}
                        </div>
                        {!s.enabled && <p className="t-meta">{t.off}</p>}
                    </div>
                );
            })}
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}
