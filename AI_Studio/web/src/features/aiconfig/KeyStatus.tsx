import { CircleCheck, KeyRound } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout } from "../../components/ui";
import { STATUS_WORDS, type AiConfiguration, type KeyTestAnswer } from "./aiconfig";

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** What is known about a key, and "Test this key": one minimal call, and the plain answer. Nothing here says it worked unless the call did. */
export function KeyStatus({ configuration: c, onTested }: { configuration: AiConfiguration; onTested: () => Promise<unknown> }) {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
    const status = STATUS_WORDS[c.status];
    const test = async () => {
        setBusy(true);
        setResult(null);
        try {
            const r = await api<KeyTestAnswer>(`/ai-configurations/${c.id}/test`, { method: "POST" });
            setResult({ ok: r.ok, message: r.message });
            await onTested();
        } catch (e) {
            setResult({ ok: false, message: e instanceof ApiError ? e.message : "The test could not be sent. Try again." });
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="stack-sm" data-testid="key-status">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <Badge tone={status.tone} tip={status.tip}>
                    {status.label}
                </Badge>
                <span className="t-secondary">
                    {c.providerName}, <span className="mono">{c.model}</span>
                    {c.fastModel ? (
                        <>
                            {" "}
                            and <span className="mono">{c.fastModel}</span>
                        </>
                    ) : null}
                    , key ending in <span className="mono">{c.keyEnding}</span>
                </span>
            </div>
            <p className="t-meta">{c.lastValidatedAt ? `Last tested ${when(c.lastValidatedAt)}.` : "Not tested since it was saved."}</p>
            {c.status === "failed" && c.statusNote && !result && <Callout tone="danger">{c.statusNote}</Callout>}
            {result && (
                <Callout tone={result.ok ? "success" : "danger"} title={result.ok ? "The key works" : "The key did not work"}>
                    {result.message}
                </Callout>
            )}
            <div>
                <Button size="sm" icon={result?.ok ? CircleCheck : KeyRound} loading={busy} onClick={() => void test()} aria-label={`Test this key: ${c.label}`}>
                    Test this key
                </Button>
            </div>
        </div>
    );
}
