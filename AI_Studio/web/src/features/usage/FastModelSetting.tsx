import { useEffect, useState } from "react";
import { api } from "../../api";
import { Button, Callout, Skeleton } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

/** GET /api/llm/fast-model (src/platform/llm-routing.ts). */
interface FastModelAnswer {
    provider: string | null;
    model: string | null;
    images: boolean;
    source: "app" | "environment" | "none";
    ready: boolean;
    reason?: string;
    environment: string;
    configured: boolean;
    mainModel: string;
    /** The fast model as written in the field: `provider:model` when it is not the main model's provider. */
    entry: string;
    active: boolean;
    fastFor: string[];
    mainFor: string[];
    limits: { sameActionFails: number; sameActionRepeats: number; stepsWithoutProgress: number };
}

/** Settings, inside "AI model": the fast model for routine steps (empty = the main model does everything), and what goes to which model. */
export function FastModelSetting() {
    const state = useFetch<FastModelAnswer>("/llm/fast-model");
    const [text, setText] = useState("");
    const [images, setImages] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const loaded = state.data;
    useEffect(() => {
        if (!loaded) return;
        setText(loaded.entry);
        setImages(loaded.images);
    }, [loaded]);

    if (state.loading) return <Skeleton h={60} />;
    if (state.error || !state.data) {
        return (
            <Callout tone="warning" title="Could not load the fast model setting" actions={<Button size="sm" onClick={() => void state.reload()}>Try again</Button>}>
                {describeApiError(state.error)}
            </Callout>
        );
    }
    const s = state.data;
    if (!s.configured) return null;

    const save = async (model: string | null) => {
        setBusy(true);
        setMessage(null);
        try {
            await api("/llm/fast-model", { method: "PUT", body: model === null ? { model: null } : { model, images } });
            setMessage({ tone: "success", text: model === null ? "The server’s own setting is used again." : model ? "Saved. New jobs use it." : "Saved. New jobs use the main model for everything." });
            await state.reload();
        } catch (e) {
            setMessage({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="stack-sm"
            data-testid="fast-model-setting"
            onSubmit={(e) => {
                e.preventDefault();
                void save(text.trim());
            }}
        >
            <div className="field">
                <label htmlFor="llm-fast-model">
                    Fast model for routine steps{" "}
                    <HelpTip
                        label="the fast model"
                        text={`Routine steps go to a cheaper, faster model; understanding the application, planning and repairs stay on ${s.mainModel}. When the fast model gives an answer that cannot be used, fails the same action ${s.limits.sameActionFails} times, repeats itself or makes no progress, the main model takes over for the rest of that test. Each hand-over is listed in the job’s activity and counted in AI usage.`}
                    />
                </label>
                <input id="llm-fast-model" className="input" value={text} placeholder="Empty: the main model does everything" autoComplete="off" spellCheck={false} aria-describedby="llm-fast-model-hint" onChange={(e) => setText(e.target.value)} />
                <span className="hint" id="llm-fast-model-hint">
                    For example claude-haiku-4-5. Another provider is written like openai:gpt-5.4-mini and needs its key on the server.
                    {s.source === "environment" ? " Now taken from the server’s settings (LLM_MODEL_FAST)." : ""}
                </span>
            </div>
            <label className="check">
                <input type="checkbox" checked={images} disabled={busy} onChange={(e) => setImages(e.target.checked)} />
                <span>
                    <span className="title">The fast model can look at screenshots</span>
                    <span className="hint">Off: anything with a picture goes to the main model.</span>
                </span>
            </label>
            {s.model && !s.ready && s.reason && (
                <Callout tone="warning" title="The fast model is not used">
                    {s.model}: {s.reason} Every AI call uses the main model.
                </Callout>
            )}
            <p className="t-meta" data-testid="fast-model-state">
                {s.active ? `On: routine steps use ${s.model}, the rest uses ${s.mainModel}.` : `Off: ${s.mainModel} does everything.`}
            </p>
            <details>
                <summary>What goes to which model</summary>
                <div className="stack-sm" style={{ paddingTop: 8 }}>
                    <p className="t-meta" style={{ margin: 0 }}>Fast model:</p>
                    <ul className="t-meta" style={{ margin: 0, paddingLeft: 18 }}>
                        {s.fastFor.map((w) => (
                            <li key={w}>{w}</li>
                        ))}
                    </ul>
                    <p className="t-meta" style={{ margin: 0 }}>Main model:</p>
                    <ul className="t-meta" style={{ margin: 0, paddingLeft: 18 }}>
                        {s.mainFor.map((w) => (
                            <li key={w}>{w}</li>
                        ))}
                    </ul>
                </div>
            </details>
            <div className="row">
                <Button type="submit" size="sm" variant="primary" loading={busy} disabled={busy}>
                    Save fast model
                </Button>
                {s.source === "app" && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                        Use the server’s setting
                    </Button>
                )}
            </div>
            {message && (
                <p className="t-meta" role="status">
                    {message.text}
                </p>
            )}
        </form>
    );
}
