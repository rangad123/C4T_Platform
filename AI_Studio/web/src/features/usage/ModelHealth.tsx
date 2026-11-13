import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

/** GET /api/llm/health (platform/llm-health.ts). */
interface FallbackModel {
    provider: string;
    model: string;
    ready: boolean;
    reason?: string;
}
interface ModelHealthRow {
    model: string;
    provider: string;
    calls: number;
    failures: number;
    successRate: number | null;
    avgLatencyMs: number | null;
    lastOkAt: string | null;
    lastError: { cls: string; label: string; message: string; at: string } | null;
}
interface HealthAnswer {
    configured: boolean;
    provider: string;
    model: string;
    fallbacks: FallbackModel[];
    fallbackSource: "app" | "environment" | "none";
    environmentFallbacks: string[];
    windowHours: number;
    models: ModelHealthRow[];
    paused: Array<{ provider: string; until: string; lastError: string | null }>;
}
interface CheckAnswer {
    ok: boolean;
    model: string;
    latencyMs: number;
    error?: { cls: string; label: string; message: string };
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const timeOf = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
const entryText = (f: FallbackModel, primary: string) => (f.provider === primary ? f.model : `${f.provider}:${f.model}`);

/** Settings, inside "How the AI works here": recent health of each model, the connection check, and the fallback models. */
export function ModelHealth() {
    const health = useFetch<HealthAnswer>("/llm/health");
    const [checking, setChecking] = useState(false);
    const [check, setCheck] = useState<CheckAnswer | null>(null);
    const [checkError, setCheckError] = useState<string | null>(null);

    if (health.loading) return <Skeleton h={60} />;
    if (health.error || !health.data) {
        return (
            <Callout tone="warning" title="Could not load the AI model’s health" actions={<Button size="sm" onClick={() => void health.reload()}>Try again</Button>}>
                {describeApiError(health.error)}
            </Callout>
        );
    }
    const h = health.data;
    if (!h.configured) return null;

    const runCheck = async () => {
        setChecking(true);
        setCheckError(null);
        try {
            setCheck(await api<CheckAnswer>("/llm/check", { method: "POST" }));
            await health.reload();
        } catch (e) {
            setCheckError(describeApiError(e));
        } finally {
            setChecking(false);
        }
    };

    return (
        <div className="stack-sm" data-testid="model-health">
            {h.paused.map((p) => (
                <Callout key={p.provider + p.until} tone="warning" title="Calls to the AI provider are paused">
                    After repeated failures{p.lastError ? ` (${p.lastError.toLowerCase()})` : ""}, the platform stopped calling it until {timeOf(p.until)}. Fallback models are used in the meantime, if any are set.
                </Callout>
            ))}

            <h3 className="t-secondary" style={{ fontWeight: 600, margin: 0 }}>Recent health (last {h.windowHours} hours)</h3>
            {h.models.length === 0 ? (
                <p className="t-meta">No AI requests yet in this period. Check the connection to try one.</p>
            ) : (
                <ul className="list divided" style={{ border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
                    {h.models.map((m) => (
                        <li className="list-row" key={m.model} style={{ padding: "10px 14px" }}>
                            <span className="main">
                                <span className="title">{m.model}</span>
                                <span className="meta">
                                    {m.calls} {m.calls === 1 ? "request" : "requests"}
                                    {m.avgLatencyMs !== null ? `, answers in ${seconds(m.avgLatencyMs)} on average` : ""}
                                    {m.lastError ? `. Last problem ${timeOf(m.lastError.at)}: ${m.lastError.message}` : ""}
                                </span>
                            </span>
                            <Badge tone={m.successRate === null ? "neutral" : m.successRate >= 95 ? "success" : m.successRate >= 70 ? "warning" : "danger"} tip={`Requests to this model in the last ${h.windowHours} hours that succeeded. Green from 95%, amber from 70%, red below.`}>{m.successRate === null ? "No requests" : `${m.successRate}% worked`}</Badge>
                        </li>
                    ))}
                </ul>
            )}

            <div className="row">
                <Button size="sm" onClick={() => void runCheck()} loading={checking} disabled={checking}>
                    Check the connection
                </Button>
                <span className="t-meta">Sends one tiny request to {h.model}. It counts as AI usage.</span>
            </div>
            <div aria-live="polite">
                {check &&
                    (check.ok ? (
                        <Callout tone="success" title="The AI model answered">
                            {check.model} answered in {seconds(check.latencyMs)}.
                        </Callout>
                    ) : (
                        <Callout tone="danger" title={`The check failed: ${check.error?.label.toLowerCase() ?? "no answer"}`}>
                            {check.error?.message}
                        </Callout>
                    ))}
                {checkError && <Callout tone="warning" title="The check did not run">{checkError}</Callout>}
            </div>

            <FallbackForm h={h} onSaved={() => void health.reload()} />
        </div>
    );
}

function FallbackForm({ h, onSaved }: { h: HealthAnswer; onSaved: () => void }) {
    const current = h.fallbacks.map((f) => entryText(f, h.provider)).join("\n");
    const [text, setText] = useState(current);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ tone: "success" | "warning"; text: string } | null>(null);
    useEffect(() => setText(current), [current]);

    const save = async (models: string[] | null) => {
        setSaving(true);
        setMessage(null);
        try {
            await api("/llm/fallbacks", { method: "PUT", body: { models } });
            setMessage({ tone: "success", text: models === null ? "The server’s own list is used again." : "Saved. New jobs use this list." });
            onSaved();
        } catch (e) {
            setMessage({ tone: "warning", text: describeApiError(e) });
        } finally {
            setSaving(false);
        }
    };
    const entries = text
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

    return (
        <form
            className="stack-sm"
            onSubmit={(e) => {
                e.preventDefault();
                void save(entries);
            }}
        >
            <div className="field">
                <label htmlFor="llm-fallbacks">Fallback models</label>
                <textarea id="llm-fallbacks" className="input" rows={3} value={text} aria-describedby="llm-fallbacks-hint" onChange={(e) => setText(e.target.value)} spellCheck={false} />
                <span className="hint" id="llm-fallbacks-hint">
                    Asked in order when {h.model} is unavailable or out of credit. One per line, up to 5. Another provider is written like openai:gpt-5.4 and needs its key on the server.
                    {h.fallbackSource === "environment" ? " Now taken from the server’s settings (LLM_FALLBACK_MODELS)." : ""}
                </span>
            </div>
            {h.fallbacks.some((f) => !f.ready) && (
                <ul className="t-meta" style={{ margin: 0, paddingLeft: 18 }}>
                    {h.fallbacks
                        .filter((f) => !f.ready)
                        .map((f) => (
                            <li key={f.provider + f.model}>
                                {entryText(f, h.provider)} is skipped: {f.reason}
                            </li>
                        ))}
                </ul>
            )}
            <div className="row">
                <Button type="submit" size="sm" variant="primary" loading={saving} disabled={saving}>
                    Save fallback models
                </Button>
                {h.fallbackSource === "app" && (
                    <Button type="button" size="sm" disabled={saving} onClick={() => void save(null)}>
                        Use the server’s list
                    </Button>
                )}
            </div>
            {message && <p className="t-meta" role="status">{message.text}</p>}
        </form>
    );
}
