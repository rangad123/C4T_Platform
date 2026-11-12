import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Callout } from "../../components/ui";
import type { RunnerMine, RunnerSwitchValues } from "./my-runner";

type Field = keyof RunnerSwitchValues;

const SAID: Record<Field, [on: string, off: string]> = {
    codeScripts: ["Code scripts now run on your runner.", "Code scripts no longer run on your runner."],
    privateTargets: ["Tests on your computer may now reach private and local addresses.", "Tests on your computer no longer reach private and local addresses."],
    realPhone: ["Your phone tests and sessions may now use the phone connected to your computer.", "Only emulators are used on your computer now."],
};

/**
 * What the person's runner may run beyond tests made of steps (PATCH /api/me/runner { switches }): code scripts (on by default), private
 * and local addresses (off by default) and the connected phone (off by default). The server enforces each when it hands out work, and
 * the runner checks again. Only the owner changes them.
 */
export function RunnerSwitches({ runner: r, onChanged }: { runner: RunnerMine; onChanged: () => Promise<void> | void }) {
    const [busy, setBusy] = useState<Field | null>(null);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    // The box shows the new state at once; it goes back if the server refuses.
    const [pending, setPending] = useState<Partial<RunnerSwitchValues>>({});
    const s = r.switches;
    if (!s) return null;
    const change = async (field: Field, value: boolean) => {
        setBusy(field);
        setNote(null);
        setPending((p) => ({ ...p, [field]: value }));
        try {
            await api("/me/runner", { method: "PATCH", body: { switches: { [field]: value } } });
            await onChanged();
            setNote({ tone: "success", text: SAID[field][value ? 0 : 1] });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "That did not change. Try again." });
        } finally {
            setPending((p) => {
                const { [field]: _gone, ...rest } = p;
                return rest;
            });
            setBusy(null);
        }
    };
    const value = (f: Field) => pending[f] ?? s[f] === true;
    const box = (f: Field, title: string, hint: string) => (
        <label className="check">
            <input type="checkbox" checked={value(f)} disabled={busy !== null} onChange={(e) => void change(f, e.target.checked)} data-switch={f} />
            <span>
                <span className="title">{title}</span>
                <span className="hint">{hint}</span>
            </span>
        </label>
    );
    return (
        <div className="stack-sm" data-testid="runner-switches" role="group" aria-labelledby="runner-switches-title">
            <div className="row" style={{ gap: 8 }}>
                <ShieldCheck size={16} aria-hidden />
                <h3 className="t-card" id="runner-switches-title">
                    What it may run
                </h3>
            </div>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {box("codeScripts", "Run code scripts", "Hand-written, imported and Git scripts, which run on your computer as you and can read what you can.")}
            {box("privateTargets", "Test private and local addresses", "localhost and addresses on your own network, such as 192.168.x.x; off by default, so a test can’t reach them by mistake.")}
            {box("realPhone", "Use my connected phone", "Phone tests may install the app on the phone plugged into your computer and remove it afterwards; when this is off, only emulators are used.")}
        </div>
    );
}
