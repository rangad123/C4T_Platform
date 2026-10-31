import { Check, Copy, Crosshair, ScanSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Callout } from "../../components/ui";
import { CHECKS, candidateWords, errorText, pickedCandidates, recApi, type AssertCheck, type Recording } from "./recorder";

/** The toolbar for picking elements and adding checks, and the panel that describes the element just picked. */
export function Inspector({ rec, onChanged }: { rec: Recording; onChanged: (r: Recording) => void }) {
    const [check, setCheck] = useState<Exclude<AssertCheck, "count">>("visible");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const live = rec.status === "recording";
    // On an agent a switch takes a moment to arrive: the buttons show what the server says, never what was clicked, and rest until it does.
    const applying = live && (rec.pendingCommands ?? 0) > 0;
    const picking = live && rec.inspect.on && rec.inspect.mode === "locator";
    const checking = live && rec.inspect.on && rec.inspect.mode === "assertion";

    async function set(body: { on: boolean; mode?: "locator" | "assertion"; check?: Exclude<AssertCheck, "count"> }) {
        setBusy(true);
        setError("");
        try {
            onChanged(await recApi<Recording>(`/recordings/${rec.id}/inspect`, { method: "POST", body }));
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card rec-inspector" aria-labelledby="rec-insp-title">
            <div className="card-head wrap">
                <ScanSearch size={18} aria-hidden />
                <h2 className="t-section" id="rec-insp-title">
                    Inspector
                </h2>
            </div>
            <div className="rec-insp-body">
                <div className="rec-toolbar" role="group" aria-label="Inspector tools">
                    <Button icon={Crosshair} aria-pressed={picking} disabled={!live || busy || applying} tip={picking ? undefined : "Your next click in the browser window shows the ways to find that element. The click does not act on the page."} onClick={() => void set({ on: !picking, mode: "locator" })}>
                        Pick an element
                    </Button>
                    <div className="rec-check-pick">
                        <label htmlFor="rec-check">Check</label>
                        <select
                            id="rec-check"
                            className="input"
                            value={check}
                            disabled={!live || busy || applying}
                            onChange={(e) => {
                                const next = e.target.value as typeof check;
                                setCheck(next);
                                if (checking) void set({ on: true, mode: "assertion", check: next });
                            }}
                        >
                            {CHECKS.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.label}
                                </option>
                            ))}
                        </select>
                        <Button icon={Check} aria-pressed={checking} disabled={!live || busy || applying} tip={checking ? undefined : "Your clicks in the browser window then add the chosen check on the element you click, instead of acting on the page."} onClick={() => void set({ on: !checking, mode: "assertion", check })}>
                            Add a check
                        </Button>
                    </div>
                </div>
                {!live && <p className="hint">The inspector works while a recording is running.</p>}
                {applying && (
                    <p className="hint rec-applying" role="status" data-testid="rec-applying">
                        Applying…
                    </p>
                )}

                {(picking || checking) && (
                    <Callout
                        tone="info"
                        title={checking ? `Adding a check: ${CHECKS.find((c) => c.id === check)?.label.toLowerCase()}` : "Picking an element"}
                        actions={
                            <Button size="sm" onClick={() => void set({ on: false, mode: picking ? "locator" : "assertion" })}>
                                {checking ? "Stop adding checks" : "Stop picking"}
                            </Button>
                        }
                    >
                        Click an element in the browser window. Your click won’t act on the page.
                    </Callout>
                )}
                {error && <Callout tone="danger">{error}</Callout>}

                {rec.picked && live && <PickedPanel rec={rec} check={check} busy={busy} onUse={() => void set({ on: true, mode: "assertion", check })} />}
            </div>
        </section>
    );
}

function PickedPanel({ rec, check, busy, onUse }: { rec: Recording; check: Exclude<AssertCheck, "count">; busy: boolean; onUse: () => void }) {
    const p = rec.picked!;
    const candidates = pickedCandidates(p);
    const [copied, setCopied] = useState<number | null>(null);
    const timer = useRef<number>();
    useEffect(() => () => clearTimeout(timer.current), []);

    async function copy(i: number, text: string) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            /* clipboard blocked: the text is still on screen to select */
        }
        setCopied(i);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(null), 1600);
    }

    return (
        <section className="rec-picked" aria-labelledby="rec-picked-title">
            <div className="rec-picked-head">
                <h3 className="t-card" id="rec-picked-title">
                    Picked element
                </h3>
                <Badge tone="neutral">{p.tag}</Badge>
            </div>
            {p.text && <p className="t-secondary rec-picked-text">“{p.text}”</p>}
            <ul className="rec-cands" aria-label="Ways to find this element">
                {candidates.map((c, i) => {
                    const words = candidateWords(c.locator, c.matches);
                    return (
                        <li key={`${c.locator.strategy}:${c.locator.value}:${c.locator.name ?? ""}`}>
                            <span className="rec-cand-text">
                                {words}
                                {i === 0 && <span className="hint"> (best)</span>}
                            </span>
                            <Button size="sm" variant="ghost" icon={copied === i ? Check : Copy} aria-label={`Copy: ${words}`} onClick={() => void copy(i, words)}>
                                {copied === i ? "Copied" : "Copy"}
                            </Button>
                        </li>
                    );
                })}
            </ul>
            <div className="rec-row">
                <Button size="sm" variant="primary" icon={Check} disabled={busy} onClick={onUse}>
                    Use for a check
                </Button>
                <span className="hint">Then click it in the browser window. The check is “{CHECKS.find((c) => c.id === check)?.label.toLowerCase()}”.</span>
            </div>
        </section>
    );
}
