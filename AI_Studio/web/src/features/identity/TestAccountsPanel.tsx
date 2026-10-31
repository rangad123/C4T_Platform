import { KeyRound, Plus, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { SeeHow } from "../guide/SeeHow";
import { FieldHelp } from "../../components/Tooltip";
import { Button, Callout, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

interface SavedRole {
    name: string;
    username: string;
    hasPassword: boolean;
    hasTotp: boolean;
    hasApiToken: boolean;
}
interface Row extends SavedRole {
    /** Typed this session; empty = keep what is saved. */
    password: string;
    totpSecret: string;
    /** Remove the saved authenticator secret on save. */
    clearTotp: boolean;
    apiToken: string;
    clearApiToken: boolean;
    key: number;
}

const MAX_ACCOUNTS = 6;
const NAME_OK = /^[a-z][a-z0-9_-]{0,23}$/;

function saveError(e: unknown): string {
    if (e instanceof ApiError && e.status === 400 && Array.isArray(e.details)) {
        const msgs = (e.details as Array<{ message?: string }>).map((d) => d.message).filter(Boolean);
        if (msgs.length) return msgs.join(" ");
    }
    return describeApiError(e);
}

/**
 * Named test accounts (user, admin...) for access-control checks. Shown only on request (Tests → More actions → Test accounts).
 * Passwords and authenticator secrets are write-only: the server never sends them back, only whether one is saved.
 */
export function TestAccountsPanel({ projectId, onClose }: { projectId: string; onClose?: () => void }) {
    const saved = useFetch<{ roles: SavedRole[] }>(`/projects/${projectId}/roles`);
    const [rows, setRows] = useState<Row[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);
    const [next, setNext] = useState(1);

    useEffect(() => {
        if (!saved.data || loaded) return;
        setRows(saved.data.roles.map((r, i) => ({ ...r, password: "", totpSecret: "", clearTotp: false, apiToken: "", clearApiToken: false, key: i })));
        setNext(saved.data.roles.length);
        setLoaded(true);
    }, [saved.data, loaded]);

    const patch = (key: number, p: Partial<Row>) => {
        setDone(false);
        setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
    };

    async function save() {
        setBusy(true);
        setError("");
        setDone(false);
        try {
            const res = await api<{ roles: SavedRole[] }>(`/projects/${projectId}/roles`, {
                method: "PUT",
                body: {
                    roles: rows.map((r) => ({
                        name: r.name.trim(),
                        username: r.username.trim(),
                        ...(r.password ? { password: r.password } : {}),
                        ...(r.clearTotp ? { totpSecret: "" } : r.totpSecret.trim() ? { totpSecret: r.totpSecret.trim() } : {}),
                        ...(r.clearApiToken ? { apiToken: "" } : r.apiToken.trim() ? { apiToken: r.apiToken.trim() } : {}),
                    })),
                },
            });
            setRows(res.roles.map((r, i) => ({ ...r, password: "", totpSecret: "", clearTotp: false, apiToken: "", clearApiToken: false, key: i })));
            setNext(res.roles.length);
            setDone(true);
        } catch (e) {
            setError(saveError(e));
        } finally {
            setBusy(false);
        }
    }

    const problems = rows.flatMap((r) => [!NAME_OK.test(r.name.trim()) && "A name uses lower-case letters, digits, - or _, and starts with a letter.", !r.username.trim() && "Every account needs a username.", !r.hasPassword && !r.password && `“${r.name || "new account"}” needs a password.`].filter(Boolean) as string[]);
    const unique = [...new Set(problems)];

    return (
        <section className="card card-pad stack-sm" aria-label="Test accounts">
            <div className="row">
                <UsersRound size={18} aria-hidden />
                <h2 className="t-section">Test accounts</h2>
                <span className="spacer" />
                {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
            </div>
            <p className="t-secondary">
                Add accounts with different permissions, such as “user” and “admin”. We sign in as each of them (and as a visitor), note which pages each one can open, and then check that pages only a more
                privileged account reached can’t be opened by the others. Use dedicated test accounts, never real ones.
            </p>
            {saved.loading ? (
                <ListSkeleton rows={2} />
            ) : saved.error ? (
                <Callout tone="danger">We couldn’t load the saved accounts. Close this panel and try again.</Callout>
            ) : (
                <>
                    {rows.length === 0 && (
                        <>
                            <p className="t-meta">No test accounts yet.</p>
                            <SeeHow topic="test-accounts" />
                        </>
                    )}
                    <div className="stack-sm">
                        {rows.map((r) => (
                            <fieldset key={r.key} className="card card-pad stack-sm" style={{ margin: 0 }}>
                                <legend className="sr-only">Account {r.name || "new"}</legend>
                                <div className="grid-2">
                                    <div className="field">
                                        <label htmlFor={`acct-name-${r.key}`}>Name</label>
                                        <input id={`acct-name-${r.key}`} className="input" value={r.name} placeholder="admin" autoComplete="off" onChange={(e) => patch(r.key, { name: e.target.value.toLowerCase() })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor={`acct-user-${r.key}`}>Username or email</label>
                                        <input id={`acct-user-${r.key}`} className="input" value={r.username} autoComplete="off" onChange={(e) => patch(r.key, { username: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <label htmlFor={`acct-pass-${r.key}`}>Password</label>
                                        <input id={`acct-pass-${r.key}`} className="input" type="password" autoComplete="new-password" value={r.password} placeholder={r.hasPassword ? "Saved — leave empty to keep" : ""} onChange={(e) => patch(r.key, { password: e.target.value })} />
                                    </div>
                                    <div className="field">
                                        <FieldHelp htmlFor={`acct-totp-${r.key}`} label="Authenticator secret (optional)" helpLabel="Authenticator secret" help="The secret key behind this account’s authenticator app (the text version of its QR code). With it we make the current code and type it when the sign-in asks for one." />
                                        <input
                                            id={`acct-totp-${r.key}`}
                                            className="input"
                                            type="password"
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={r.totpSecret}
                                            disabled={r.clearTotp}
                                            placeholder={r.hasTotp && !r.clearTotp ? "Saved — leave empty to keep" : ""}
                                            onChange={(e) => patch(r.key, { totpSecret: e.target.value })}
                                        />
                                    </div>
                                    <div className="field">
                                        <label htmlFor={`acct-api-${r.key}`}>API token (optional)</label>
                                        <input
                                            id={`acct-api-${r.key}`}
                                            className="input"
                                            type="password"
                                            autoComplete="off"
                                            spellCheck={false}
                                            value={r.apiToken}
                                            disabled={r.clearApiToken}
                                            placeholder={r.hasApiToken && !r.clearApiToken ? "Saved — leave empty to keep" : ""}
                                            onChange={(e) => patch(r.key, { apiToken: e.target.value })}
                                        />
                                        <p className="hint">A bearer token for this account, so we can also check that the API refuses it where it should.</p>
                                    </div>
                                </div>
                                <div className="row">
                                    {r.hasApiToken && (
                                        <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => patch(r.key, { clearApiToken: !r.clearApiToken, apiToken: "" })}>
                                            {r.clearApiToken ? "Keep the API token" : "Remove the API token"}
                                        </Button>
                                    )}
                                    {r.hasTotp && (
                                        <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => patch(r.key, { clearTotp: !r.clearTotp, totpSecret: "" })}>
                                            {r.clearTotp ? "Keep the authenticator secret" : "Remove the authenticator secret"}
                                        </Button>
                                    )}
                                    <span className="spacer" />
                                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => { setDone(false); setRows((rs) => rs.filter((x) => x.key !== r.key)); }} aria-label={`Remove account ${r.name || "new"}`}>
                                        Remove
                                    </Button>
                                </div>
                            </fieldset>
                        ))}
                    </div>
                    <div className="row">
                        <Button icon={Plus} disabled={rows.length >= MAX_ACCOUNTS} onClick={() => { setDone(false); setRows((rs) => [...rs, { name: "", username: "", hasPassword: false, hasTotp: false, hasApiToken: false, password: "", totpSecret: "", clearTotp: false, apiToken: "", clearApiToken: false, key: next }]); setNext((n) => n + 1); }}>
                            Add an account
                        </Button>
                        {rows.length >= MAX_ACCOUNTS && <span className="t-meta">That’s the most we can keep ({MAX_ACCOUNTS}).</span>}
                    </div>
                    {unique.length > 0 && rows.length > 0 && <Callout tone="warning">{unique.join(" ")}</Callout>}
                    {error && <Callout tone="danger">{error}</Callout>}
                    {done && <Callout tone="success">Saved. The next exploration uses these accounts for access-control checks.</Callout>}
                    <div className="row">
                        <Button variant="primary" loading={busy} disabled={busy || unique.length > 0} onClick={save}>
                            Save accounts
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
