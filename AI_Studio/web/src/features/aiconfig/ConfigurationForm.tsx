import { useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout } from "../../components/ui";
import type { AiConfiguration, AiProviderChoice } from "./aiconfig";

/**
 * Add a configuration, or change one. The key field is write-only: it starts empty, a saved key is never shown, and leaving it empty when
 * changing keeps the saved key. A new provider or address needs the key again, because a stored key only goes where it was entered for.
 */
export function ConfigurationForm({ idPrefix, providers, current, path, extra, onSaved, onCancel }: { idPrefix: string; providers: AiProviderChoice[]; current?: AiConfiguration; path: string; extra?: Record<string, unknown>; onSaved: (c: AiConfiguration) => void | Promise<void>; onCancel: () => void }) {
    const [label, setLabel] = useState(current?.label ?? "");
    const [provider, setProvider] = useState(current?.provider ?? providers[0]?.id ?? "anthropic");
    const chosen = providers.find((p) => p.id === provider);
    const [model, setModel] = useState(current?.model ?? providers[0]?.defaultModel ?? "");
    const [fastModel, setFastModel] = useState(current?.fastModel ?? "");
    const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const pick = (id: string) => {
        const next = providers.find((p) => p.id === id);
        // A model name that was only the old provider's starting value follows the new provider.
        if (!model.trim() || providers.some((p) => p.defaultModel === model.trim())) setModel(next?.defaultModel ?? "");
        setProvider(id);
    };
    const save = async () => {
        setBusy(true);
        setError("");
        try {
            const fields = { label: label.trim(), provider, model: model.trim(), fastModel: fastModel.trim() || null, baseUrl: chosen?.needsAddress ? baseUrl.trim() : null, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
            const saved = await api<AiConfiguration>(path, { method: current ? "PATCH" : "POST", body: { ...fields, ...extra } });
            setApiKey("");
            await onSaved(saved);
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "That did not save. Try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <form
            className="stack-sm"
            data-testid={`${idPrefix}-form`}
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="field">
                <label htmlFor={`${idPrefix}-label`}>Name</label>
                <input id={`${idPrefix}-label`} className="input" autoComplete="off" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor={`${idPrefix}-provider`}>Provider</label>
                <select id={`${idPrefix}-provider`} className="input" value={provider} onChange={(e) => pick(e.target.value)}>
                    {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </div>
            {chosen?.needsAddress && (
                <div className="field">
                    <label htmlFor={`${idPrefix}-address`}>Address</label>
                    <input id={`${idPrefix}-address`} className="input" autoComplete="off" placeholder="https://llm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </div>
            )}
            <div className="field">
                <label htmlFor={`${idPrefix}-model`}>Model</label>
                <input id={`${idPrefix}-model`} className="input mono" autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor={`${idPrefix}-fast`}>Fast model (optional)</label>
                <input id={`${idPrefix}-fast`} className="input mono" autoComplete="off" aria-describedby={`${idPrefix}-fast-hint`} value={fastModel} onChange={(e) => setFastModel(e.target.value)} />
                <span className="hint" id={`${idPrefix}-fast-hint`}>
                    Routine steps go to it, and hard ones to the main model. Both use this key.
                </span>
            </div>
            <div className="field">
                <label htmlFor={`${idPrefix}-key`}>{current ? "New key" : "Key"}</label>
                <input id={`${idPrefix}-key`} className="input mono" type="password" autoComplete="new-password" aria-describedby={`${idPrefix}-key-hint`} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                <span className="hint" id={`${idPrefix}-key-hint`}>
                    {current ? `Leave empty to keep the key ending in ${current.keyEnding}.` : "Stored encrypted and never shown again. Only its last four characters appear here."}
                </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
                <Button type="submit" variant="primary" loading={busy}>
                    {current ? "Save changes" : "Save configuration"}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
