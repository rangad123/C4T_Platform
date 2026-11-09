import { KeyRound, LogIn, Mail, RefreshCw, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";

interface Session {
    account: string;
    checkUrl: string;
    expiresAt: string | null;
    savedAt: string;
    how: "browser" | "file";
    checkedAt: string | null;
    checkOk: boolean | null;
    checkNote: string | null;
    cookies: number;
    sites: string[];
    state: "ok" | "expired" | "unknown";
}
interface Capture {
    id: string;
    account: string;
    status: "starting" | "open" | "saved" | "cancelled" | "failed";
    currentUrl?: string;
    popupOpen: boolean;
    popups: number;
    captcha?: string;
    error?: string;
}
interface Mailbox {
    kind: "imap" | "inbound";
    imap?: { host: string; port: number; tls: boolean; user: string; mailbox: string; hasPassword: boolean };
    messages?: number;
}
interface Overview {
    appUrl: string | null;
    accounts: string[];
    sessions: Session[];
    capture: Capture | null;
    mailbox: Mailbox | null;
    browser: { installed: boolean; display: boolean };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");
const accountWords = (a: string) => (a === "main" ? "Project sign-in" : `Account “${a}”`);

/**
 * Hard sign-ins: a saved signed-in session per account (sign in once yourself, or upload a saved sign-in file), the "Still signed in?"
 * check, and the test mailbox for emailed codes and links. Sessions and the mailbox password are never shown again.
 */
export function HardSignInPanel({ projectId }: { projectId: string }) {
    const live = (d?: Overview) => (d?.capture && (d.capture.status === "starting" || d.capture.status === "open") ? 1500 : null);
    const o = useFetch<Overview>(`/projects/${projectId}/hard-sign-in`, live);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [note, setNote] = useState("");

    async function act(key: string, fn: () => Promise<unknown>, done?: string) {
        setBusy(key);
        setError("");
        setNote("");
        try {
            await fn();
            if (done) setNote(done);
            await o.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    if (o.loading) return <section className="card card-pad" aria-label="Saved sign-ins"><ListSkeleton rows={2} /></section>;
    if (o.error || !o.data) return <ErrorState error={{ title: "We couldn’t load the saved sign-ins", body: describeApiError(o.error) }} onRetry={() => void o.reload()} />;
    const d = o.data;
    const capturing = d.capture && (d.capture.status === "starting" || d.capture.status === "open") ? d.capture : null;
    const byAccount = new Map(d.sessions.map((s) => [s.account, s]));

    return (
        <div className="stack">
            <section className="card card-pad stack-sm" aria-label="Saved sign-ins">
                <div className="row">
                    <LogIn size={18} aria-hidden />
                    <h2 className="t-section">Saved sign-ins</h2>
                </div>
                <p className="t-secondary">
                    For sign-ins we can’t fill in ourselves (single sign-on, Google or Microsoft sign-in, a captcha): sign in once yourself in a browser we open, and tests and
                    explorations start signed in. Before each run we check you’re still signed in; when you aren’t, the run stops and asks you to sign in again. Tests that type
                    the password themselves still start signed out.
                </p>
                {!d.appUrl && <Callout tone="info">Add the application’s address (or run an exploration) first: a saved sign-in belongs to that site.</Callout>}
                {capturing && (
                    <Callout
                        tone="info"
                        title={`Sign in as ${accountWords(capturing.account).toLowerCase()} in the browser window`}
                        actions={
                            <>
                                <Button variant="primary" size="sm" loading={busy === "save"} disabled={capturing.status !== "open" || Boolean(busy)} onClick={() => act("save", () => api(`/projects/${projectId}/sessions/capture/save`, { method: "POST" }), "Saved. The next run checks it, then starts signed in.")}>
                                    I’m signed in, save it
                                </Button>
                                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act("cancel", () => api(`/projects/${projectId}/sessions/capture`, { method: "DELETE" }))}>
                                    Cancel
                                </Button>
                            </>
                        }
                    >
                        {capturing.status === "starting" ? "Opening the browser…" : `Now on ${capturing.currentUrl ?? "the sign-in page"}.`}
                        {capturing.popupOpen ? " A sign-in window is open: finish there, it closes by itself." : ""}
                        {capturing.captcha ? ` The page shows a captcha (${capturing.captcha}): solve it yourself; we never touch it.` : ""} We only keep the cookies the site sets, never what you type.
                    </Callout>
                )}
                {d.capture && (d.capture.status === "failed" || d.capture.status === "cancelled") && d.capture.error && <Callout tone="warning">{d.capture.error}</Callout>}
                <ul className="stack-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {d.accounts.map((a) => {
                        const s = byAccount.get(a);
                        return (
                            <li key={a} className="card card-pad stack-sm" aria-label={accountWords(a)}>
                                <div className="row">
                                    <strong>{accountWords(a)}</strong>
                                    {s ? s.state === "expired" ? <Badge tone="danger" tip="Its cookies have run out, or the last check found it signed out. Runs stop until you sign in again." tipFocusable>Signed out</Badge> : s.state === "ok" ? <Badge tone="success" tip="Its cookies have not run out and the last check, if any, found it signed in. Each run checks again before it starts." tipFocusable>Signed in</Badge> : <Badge tip="Its cookies have no end date and it has not been checked yet. The next run checks it before it starts." tipFocusable>Saved, not checked yet</Badge> : <Badge tip="Tests and explorations start signed out for this account." tipFocusable>Not saved</Badge>}
                                </div>
                                {s && (
                                    <p className="t-meta">
                                        Saved {when(s.savedAt)} ({s.how === "file" ? "uploaded file" : "signed in by hand"}), {s.cookies} cookie{s.cookies === 1 ? "" : "s"}
                                        {s.expiresAt ? `, runs out ${when(s.expiresAt)}` : ", no end date in its cookies"}.
                                        {s.checkedAt ? ` Last check ${when(s.checkedAt)}: ${s.checkNote ?? ""}` : ""}
                                    </p>
                                )}
                                {s?.state === "expired" && <Callout tone="warning">This sign-in no longer works. Sign in again so runs can start signed in.</Callout>}
                                <div className="row wrap">
                                    <Button
                                        size="sm"
                                        variant={s?.state === "expired" ? "primary" : "secondary"}
                                        icon={LogIn}
                                        disabled={!d.appUrl || Boolean(capturing) || Boolean(busy) || !d.browser.installed}
                                        loading={busy === `cap-${a}`}
                                        onClick={() => act(`cap-${a}`, () => api(`/projects/${projectId}/sessions/${a}/capture`, { method: "POST", body: { headed: d.browser.display } }))}
                                    >
                                        {s ? "Sign in again" : "Sign in once yourself"}
                                    </Button>
                                    <UploadState projectId={projectId} account={a} disabled={!d.appUrl || Boolean(busy)} onDone={(msg) => act(`up-${a}`, async () => undefined, msg)} onError={setError} />
                                    {s && (
                                        <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy === `chk-${a}`} disabled={Boolean(busy)} tip="Opens the application with this saved sign-in to see whether it is still signed in." onClick={() => act(`chk-${a}`, async () => {
                                            const r = await api<{ signedIn: boolean; reason: string; unreachable?: boolean }>(`/projects/${projectId}/sessions/${a}/check`, { method: "POST" });
                                            setTimeout(() => setNote(r.unreachable ? `We couldn’t open the app to check: ${r.reason}` : r.signedIn ? `Still signed in. ${r.reason}` : `Signed out. ${r.reason}`), 0);
                                        })}>
                                            Check now
                                        </Button>
                                    )}
                                    {s && (
                                        <Button size="sm" variant="ghost" icon={Trash2} disabled={Boolean(busy)} tip="Deletes this saved sign-in. Runs start signed out again." onClick={() => act(`del-${a}`, () => api(`/projects/${projectId}/sessions/${a}`, { method: "DELETE" }), "Forgotten. Runs start signed out again.")}>
                                            Forget
                                        </Button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
                {!d.browser.installed && <p className="t-meta">No browser is installed where the platform runs, so signing in by hand isn’t possible here. Upload a saved sign-in file instead.</p>}
                {d.browser.installed && !d.browser.display && <p className="t-meta">The platform’s computer has no screen, so the browser opens without a window. Upload a saved sign-in file instead (made with npx playwright codegen --save-storage).</p>}
            </section>
            <MailboxCard projectId={projectId} mailbox={d.mailbox} reload={() => void o.reload()} />
            {error && <Callout tone="danger">{error}</Callout>}
            {note && <Callout tone="success">{note}</Callout>}
        </div>
    );
}

function UploadState({ projectId, account, disabled, onDone, onError }: { projectId: string; account: string; disabled: boolean; onDone: (msg: string) => void; onError: (m: string) => void }) {
    const id = `state-file-${account}`;
    return (
        <label htmlFor={id} className="btn btn-ghost btn-sm" style={{ cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}>
            <Upload size={14} aria-hidden /> Upload a saved sign-in file
            <input
                id={id}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={disabled}
                onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    try {
                        if (f.size > 1_000_000) throw new Error("That file is larger than 1 MB, which is more than a saved sign-in needs.");
                        await api(`/projects/${projectId}/sessions/${account}`, { method: "PUT", body: { storageState: await f.text() } });
                        onDone("Saved from the file. The next run checks it, then starts signed in.");
                    } catch (err) {
                        onError(describeApiError(err));
                    }
                }}
            />
        </label>
    );
}

function MailboxCard({ projectId, mailbox, reload }: { projectId: string; mailbox: Mailbox | null; reload: () => void }) {
    const [kind, setKind] = useState<"inbound" | "imap">(mailbox?.kind ?? "inbound");
    const [host, setHost] = useState(mailbox?.imap?.host ?? "");
    const [port, setPort] = useState(String(mailbox?.imap?.port ?? 993));
    const [tls, setTls] = useState(mailbox?.imap?.tls ?? true);
    const [user, setUser] = useState(mailbox?.imap?.user ?? "");
    const [password, setPassword] = useState("");
    const [address, setAddress] = useState("");
    const [busy, setBusy] = useState(false);
    // The saved password is only sent to the server it was entered for (routes/hard-signin.ts): another host or port, or TLS turned
    // off, needs it again, so the form says so by the field instead of offering to keep it.
    const saved = mailbox?.kind === "imap" ? mailbox.imap : undefined;
    const keepsPassword = Boolean(saved?.hasPassword) && saved!.host.toLowerCase() === host.trim().replace(/^\[|\]$/g, "").toLowerCase() && saved!.port === (Number(port) || 993) && (tls || !saved!.tls);
    const [msg, setMsg] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);

    async function run(fn: () => Promise<void>) {
        setBusy(true);
        setMsg(null);
        try {
            await fn();
            reload();
        } catch (e) {
            setMsg({ tone: "danger", text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Test mailbox">
            <div className="row">
                <Mail size={18} aria-hidden />
                <h2 className="t-section">Test mailbox</h2>
                {mailbox && <Badge tone="success">{mailbox.kind === "imap" ? "IMAP mailbox" : "Forwarded mail"}</Badge>}
            </div>
            <p className="t-secondary">
                For codes and sign-in links sent by email. Add the step “Use an emailed code or link”: while the test runs, we wait for the newest email to that address and type its
                code or open its link. Use a mailbox only for testing.
            </p>
            <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="t-meta">Where emails arrive</legend>
                <label className="row" style={{ minHeight: 44 }}>
                    <input type="radio" name="mailbox-kind" checked={kind === "inbound"} onChange={() => setKind("inbound")} /> Forward them to the platform (simplest)
                </label>
                <label className="row" style={{ minHeight: 44 }}>
                    <input type="radio" name="mailbox-kind" checked={kind === "imap"} onChange={() => setKind("imap")} /> Read an IMAP mailbox
                </label>
            </fieldset>
            {kind === "imap" ? (
                <div className="grid-2">
                    <div className="field">
                        <label htmlFor="imap-host">Server</label>
                        <input id="imap-host" className="input" value={host} placeholder="imap.example.com" autoComplete="off" onChange={(e) => setHost(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="imap-port">Port</label>
                        <input id="imap-port" className="input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="imap-user">User name</label>
                        <input id="imap-user" className="input" value={user} autoComplete="off" onChange={(e) => setUser(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="imap-pass">Password</label>
                        <input id="imap-pass" className="input" type="password" autoComplete="new-password" value={password} placeholder={keepsPassword ? "Saved — leave empty to keep" : ""} aria-describedby={saved?.hasPassword && !keepsPassword ? "imap-pass-again" : undefined} onChange={(e) => setPassword(e.target.value)} />
                        {saved?.hasPassword && !keepsPassword && (
                            <span className="t-meta" id="imap-pass-again">
                                Enter the password again: the saved one is only sent to the server it was entered for.
                            </span>
                        )}
                    </div>
                    <label className="row" style={{ minHeight: 44 }}>
                        <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} /> Use TLS (port 993)
                    </label>
                </div>
            ) : (
                <p className="t-meta">We make a private address. Set your test mailbox (or mail service) to forward or post each email there, as JSON or as the raw message. Mail is kept for a day.</p>
            )}
            {address && (
                <Callout tone="info" title="Your forwarding address (shown once)">
                    <code style={{ wordBreak: "break-all" }}>{address}</code>
                </Callout>
            )}
            {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
            <div className="row wrap">
                <Button
                    variant="primary"
                    icon={KeyRound}
                    tip={kind === "inbound" && mailbox?.kind === "inbound" ? "Makes a new private address and shows it once. The old address stops working." : undefined}
                    loading={busy}
                    disabled={busy || (kind === "imap" && (!host.trim() || !user.trim() || (!password && !keepsPassword)))}
                    onClick={() =>
                        run(async () => {
                            const r = await api<{ inboundPath?: string }>(`/projects/${projectId}/mailbox`, {
                                method: "PUT",
                                body: kind === "inbound" ? { kind } : { kind, imap: { host: host.trim(), port: Number(port) || 993, tls, user: user.trim(), ...(password ? { password } : {}) } },
                            });
                            setPassword("");
                            if (r.inboundPath) setAddress(`${window.location.origin}${r.inboundPath}`);
                            setMsg({ tone: "success", text: kind === "inbound" ? "Saved. Copy the address now: it isn’t shown again (make a new one any time)." : "Saved." });
                        })
                    }
                >
                    {kind === "inbound" ? (mailbox?.kind === "inbound" ? "Make a new address" : "Make a forwarding address") : "Save the mailbox"}
                </Button>
                {mailbox && (
                    <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                            run(async () => {
                                const r = await api<{ ok: boolean; note?: string; problem?: string }>(`/projects/${projectId}/mailbox/test`, { method: "POST" });
                                setMsg(r.ok ? { tone: "success", text: r.note ?? "It works." } : { tone: "warning", text: r.problem ?? "It didn’t work." });
                            })
                        }
                    >
                        Test the mailbox
                    </Button>
                )}
                {mailbox && (
                    <Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => run(async () => { await api(`/projects/${projectId}/mailbox`, { method: "DELETE" }); setAddress(""); setMsg({ tone: "success", text: "Removed. Email steps will say there is no test mailbox." }); })}>
                        Remove
                    </Button>
                )}
            </div>
        </section>
    );
}
