import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Callout } from "../../components/ui";
import { kindOf, type Runner } from "./runners";

/** The PATCH /api/runners/:id fields (src/platform/routes/runners.ts). */
type Field = "codeScripts" | "privateAddresses" | "realPhone";

/**
 * What a runner may run, beyond tests made of steps (docs/features/runner-personal.md). On a person's own computer the owner decides
 * whether code scripts run there (on by default) and whether tests may reach private and local addresses (off by default); on a team runner,
 * someone who manages it decides about code scripts. The server enforces both when it offers work, and runners from this version on check
 * again (an older team runner relies on the server's check). Shown only when the server reports the switches; changing one needs `canManage`,
 * which the server sets, and on a person's own computer being its owner (an admin may rename or retire it, not change its switches).
 */
export function RunnerSwitches({ runner: r, onChanged }: { runner: Runner; onChanged: () => Promise<void> | void }) {
    const [busy, setBusy] = useState<Field | null>(null);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    // The box shows the new state at once; it goes back if the server refuses.
    const [pending, setPending] = useState<Partial<Record<Field, boolean>>>({});
    const personal = kindOf(r) === "personal";
    const s = r.settings;
    if (r.status === "retired" || !s) return null;
    // Crowd4Test's shared runners serve many customers, so they never run anyone's own code: the server sends no switch for them.
    const shared = !personal && !s.codeScriptsSwitch && r.organizationId === null;
    const edit = r.canManage && (!personal || r.mine === true);
    const change = async (field: Field, value: boolean, said: string) => {
        setBusy(field);
        setNote(null);
        setPending((p) => ({ ...p, [field]: value }));
        try {
            await api(`/runners/${r.id}`, { method: "PATCH", body: { [field]: value } });
            await onChanged();
            setNote({ tone: "success", text: said });
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
    const code = pending.codeScripts ?? s.codeScripts;
    const priv = pending.privateAddresses ?? s.privateAddresses;
    const phone = pending.realPhone ?? s.realPhone === true;
    // The connected phone is a switch of a person's own computer, and only its owner changes it.
    const phoneSwitch = s.realPhoneSwitch ?? personal;
    return (
        <section className="card card-pad stack-sm" aria-labelledby="runner-switches-title" data-testid="runner-switches">
            <div className="row" style={{ gap: 8 }}>
                <ShieldCheck size={18} aria-hidden />
                <h2 className="t-section" id="runner-switches-title">
                    What it may run
                </h2>
            </div>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {shared ? (
                    <p className="t-secondary">Crowd4Test’s shared runners never run code scripts, so only tests made of steps run here.</p>
                ) : edit && s.codeScriptsSwitch ? (
                    <label className="check">
                        <input type="checkbox" checked={code} disabled={busy !== null} onChange={(e) => void change("codeScripts", e.target.checked, e.target.checked ? "Code scripts now run on this runner." : "Code scripts no longer run on this runner.")} />
                        <span>
                            <span className="title">Run code scripts</span>
                            <span className="hint">
                                {personal
                                    ? "Hand-written, imported and Git scripts. They run on this computer as you, and can read what you can. Switch this off to run only tests made of steps."
                                    : "Hand-written, imported and Git scripts. On lets this runner take them without changing how it was started; they can read what the runner’s user can."}
                            </span>
                        </span>
                    </label>
                ) : (
                    <p className="t-secondary">{code ? "Code scripts run on this runner." : "Code scripts do not run on this runner: only tests made of steps."}</p>
                )}
            {s.privateAddressesSwitch &&
                (edit ? (
                    <label className="check">
                        <input type="checkbox" checked={priv} disabled={busy !== null} onChange={(e) => void change("privateAddresses", e.target.checked, e.target.checked ? "Tests on this computer may now reach private and local addresses." : "Tests on this computer no longer reach private and local addresses.")} />
                        <span>
                            <span className="title">Test private and local addresses</span>
                            <span className="hint">localhost, addresses on your own network (such as 192.168.x.x or 10.x.x.x) and 169.254.x.x. Off by default, so a test can’t reach things on your network by mistake.</span>
                        </span>
                    </label>
                ) : (
                    <p className="t-secondary">{priv ? "Tests on this computer may reach private and local addresses." : "Tests on this computer do not reach private and local addresses."}</p>
                ))}
            {phoneSwitch &&
                (edit && r.mine ? (
                    <label className="check">
                        <input type="checkbox" checked={phone} disabled={busy !== null} onChange={(e) => void change("realPhone", e.target.checked, e.target.checked ? "Your phone tests and sessions may now use the phone connected to this computer." : "Only emulators are used on this computer now.")} />
                        <span>
                            <span className="title">Use my connected phone</span>
                            <span className="hint">Phone tests and sessions you start may use the phone connected to this computer. The app under test is installed on it and removed afterwards if it wasn’t there before. When this is off, only emulators are used.</span>
                        </span>
                    </label>
                ) : (
                    <p className="t-secondary">{phone ? "Phone tests may use the phone connected to this computer." : "Phone tests on this computer use only emulators."}</p>
                ))}
        </section>
    );
}
