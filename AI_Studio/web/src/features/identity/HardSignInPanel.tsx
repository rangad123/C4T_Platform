import { KeyRound, LogIn, Mail, RefreshCw, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
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

/** The project's saved signed-in sessions, the capture in progress and the mailbox, with the actions on them: one per Sign-in tab. */
export interface SavedSignIns {
    projectId: string;
    data: Overview | undefined;
    loading: boolean;
    error: unknown;
    reload: () => void;
    busy: string;
    /** The account the last action was for: its error or note is shown there. */
    last: string;
    error2: string;
    note: string;
    noSettings: string | undefined;
    act: (account: string, key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
    fail: (account: string, message: string) => void;
}

/**
 * Hard sign-ins: a saved signed-in session per account (sign in once yourself, or upload a saved sign-in file), the "Still signed in?"
 * check, and the test mailbox for emailed codes and links. Read once for the whole Sign-in tab; each account shows its own part
 * (SavedSignInControls) under its user name and password. Sessions and the mailbox password are never shown again.
 */
export function useSavedSignIns(projectId: string): SavedSignIns {
    const live = (d?: Overview) => (d?.capture && (d.capture.status === "starting" || d.capture.status === "open") ? 1500 : null);
    const o = useFetch<Overview>(`/projects/${projectId}/hard-sign-in`, live);
    const [busy, setBusy] = useState("");
    const [last, setLast] = useState("");
    const [error, setError] = useState("");
    const [note, setNote] = useState("");
    // Saving, checking and forgetting a sign-in are project settings (as the server asks): otherwise each account is shown to read.
    const noSettings = useHere(projectId).why("ai_studio.project.settings");

    async function act(account: string, key: string, fn: () => Promise<unknown>, done?: string) {
        setBusy(key);
        setLast(account);
        setError("");
        setNote("");
        try {
            const r = await fn();
            if (typeof r === "string") setNote(r);
            else if (done) setNote(done);
            await o.reload();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }
    return {
        projectId,
        data: o.data,
        loading: o.loading,
        error: o.error,
        reload: () => void o.reload(),
        busy,
        last,
        error2: error,
        note,
        noSettings: noSettings || undefined,
        act,
        fail: (account, message) => {
            setLast(account);
            setNote("");
            setError(message);
        },
    };
}

/**
 * One account's "Signed in by hand" part, under its user name and password: for sign-ins tests can't type (single sign-on, Google or
 * Microsoft sign-in, a captcha). Sign in once yourself in a browser we open, or upload a saved sign-in file; runs then start signed in.
 */
export function SavedSignInControls({ hs, account }: { hs: SavedSignIns; account: string }) {
    const { projectId, data: d, busy, act, noSettings } = hs;
    const title = <div className="t-card">Signed in by hand</div>;
    if (hs.loading && !d) return <div className="stack-sm" aria-label={`Signed in by hand: ${accountWords(account)}`}>{title}<ListSkeleton rows={1} /></div>;
    if (!d) return (
        <div className="stack-sm">
            {title}
            <p className="t-meta">We couldn’t load the saved sign-ins: {describeApiError(hs.error)} <Button size="sm" variant="ghost" onClick={hs.reload}>Try again</Button></p>
        </div>
    );
    const s = d.sessions.find((x) => x.account === account);
    const capturing = d.capture && (d.capture.status === "starting" || d.capture.status === "open") ? d.capture : null;
    const mine = capturing?.account === account ? capturing : null;
    const a = encodeURIComponent(account);
    return (
        <div className="stack-sm" role="group" aria-label={`Signed in by hand: ${accountWords(account)}`} data-testid={`signed-in-by-hand-${account}`}>
            <div className="row">
                {title}
                {s ? s.state === "expired" ? <Badge tone="danger" tip="Its cookies have run out, or the last check found it signed out. Runs stop until you sign in again." tipFocusable>Signed out</Badge> : s.state === "ok" ? <Badge tone="success" tip="Its cookies have not run out and the last check, if any, found it signed in. Each run checks again before it starts." tipFocusable>Signed in</Badge> : <Badge tip="Its cookies have no end date and it has not been checked yet. The next run checks it before it starts." tipFocusable>Saved, not checked yet</Badge> : <Badge tip="Tests and explorations type the user name and password above, or start signed out." tipFocusable>Not used</Badge>}
            </div>
            <p className="hint">
                Only for sign-ins tests can’t type: single sign-on, Google or Microsoft sign-in, a captcha. Sign in once yourself and tests and explorations start signed in; each run first checks you still are, and stops if not. Tests that type the password themselves still start signed out.
            </p>
            {s && (
                <p className="t-meta">
                    Saved {when(s.savedAt)} ({s.how === "file" ? "uploaded file" : "signed in by hand"}), {s.cookies} cookie{s.cookies === 1 ? "" : "s"}
                    {s.expiresAt ? `, runs out ${when(s.expiresAt)}` : ", no end date in its cookies"}.
                    {s.checkedAt ? ` Last check ${when(s.checkedAt)}: ${s.checkNote ?? ""}` : ""}
                </p>
            )}
            {s?.state === "expired" && <Callout tone="warning">This sign-in no longer works. Sign in again so runs can start signed in.</Callout>}
            {mine && (
                <Callout
                    tone="info"
                    title={`Sign in as ${accountWords(account).toLowerCase()} in the browser window`}
                    actions={
                        <>
                            <Button variant="primary" size="sm" loading={busy === "save"} disabled={mine.status !== "open" || Boolean(busy)} onClick={() => act(account, "save", () => api(`/projects/${projectId}/sessions/capture/save`, { method: "POST" }), "Saved. The next run checks it, then starts signed in.")}>
                                I’m signed in, save it
                            </Button>
                            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => act(account, "cancel", () => api(`/projects/${projectId}/sessions/capture`, { method: "DELETE" }))}>
                                Cancel
                            </Button>
                        </>
                    }
                >
                    {mine.status === "starting" ? "Opening the browser…" : `Now on ${mine.currentUrl ?? "the sign-in page"}.`}
                    {mine.popupOpen ? " A sign-in window is open: finish there, it closes by itself." : ""}
                    {mine.captcha ? ` The page shows a captcha (${mine.captcha}): solve it yourself; we never touch it.` : ""} We only keep the cookies the site sets, never what you type.
                </Callout>
            )}
            {d.capture?.account === account && (d.capture.status === "failed" || d.capture.status === "cancelled") && d.capture.error && <Callout tone="warning">{d.capture.error}</Callout>}
            {!d.appUrl && <p className="t-meta">Add the application’s address (or run an exploration) first: a saved sign-in belongs to that site.</p>}
            {!noSettings && (
                <div className="row wrap">
                    <Button
                        size="sm"
                        variant={s?.state === "expired" ? "primary" : "secondary"}
                        icon={LogIn}
                        disabled={!d.appUrl || Boolean(capturing) || Boolean(busy) || !d.browser.installed}
                        loading={busy === `cap-${account}`}
                        onClick={() => act(account, `cap-${account}`, () => api(`/projects/${projectId}/sessions/${a}/capture`, { method: "POST", body: { headed: d.browser.display } }))}
                    >
                        {s ? "Sign in again" : "Sign in once yourself"}
                    </Button>
                    <UploadState projectId={projectId} account={account} disabled={!d.appUrl || Boolean(busy)} onDone={(msg) => act(account, `up-${account}`, async () => undefined, msg)} onError={(m) => hs.fail(account, m)} />
                    {s && (
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={RefreshCw}
                            loading={busy === `chk-${account}`}
                            disabled={Boolean(busy)}
                            tip="Opens the application with this saved sign-in to see whether it is still signed in."
                            onClick={() =>
                                act(account, `chk-${account}`, async () => {
                                    const r = await api<{ signedIn: boolean; reason: string; unreachable?: boolean }>(`/projects/${projectId}/sessions/${a}/check`, { method: "POST" });
                                    return r.unreachable ? `We couldn’t open the app to check: ${r.reason}` : r.signedIn ? `Still signed in. ${r.reason}` : `Signed out. ${r.reason}`;
                                })
                            }
                        >
                            Check now
                        </Button>
                    )}
                    {s && (
                        <Button size="sm" variant="ghost" icon={Trash2} disabled={Boolean(busy)} tip="Deletes this saved sign-in. Runs start signed out again." onClick={() => act(account, `del-${account}`, () => api(`/projects/${projectId}/sessions/${a}`, { method: "DELETE" }), "Forgotten. Runs start signed out again.")}>
                            Forget
                        </Button>
                    )}
                </div>
            )}
            {!d.browser.installed && <p className="t-meta">No browser is installed where the platform runs, so signing in by hand isn’t possible here. Upload a saved sign-in file instead.</p>}
            {d.browser.installed && !d.browser.display && <p className="t-meta">The platform’s computer has no screen, so the browser opens without a window. Upload a saved sign-in file instead (made with npx playwright codegen --save-storage).</p>}
            {hs.last === account && hs.error2 && <Callout tone="danger">{hs.error2}</Callout>}
            {hs.last === account && hs.note && <Callout tone="success">{hs.note}</Callout>}
        </div>
    );
}

/** Settings → Sign-in: the test mailbox for emailed codes and links, one per project. */
export function TestMailboxPanel({ hs }: { hs: SavedSignIns }) {
    if (hs.loading && !hs.data) return <section className="card card-pad" aria-label="Test mailbox"><ListSkeleton rows={2} /></section>;
    if (!hs.data) return <ErrorState error={{ title: "We couldn’t load the test mailbox", body: describeApiError(hs.error) }} onRetry={hs.reload} />;
    return <MailboxCard projectId={hs.projectId} mailbox={hs.data.mailbox} reload={hs.reload} />;
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
    // The mailbox reaches another system with its password: changing and testing it needs ai_studio.ai_keys.manage here.
    const noManage = useHere(projectId).why("ai_studio.ai_keys.manage");

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
            <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }} disabled={Boolean(noManage)}>
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
                    tip={noManage ?? (kind === "inbound" && mailbox?.kind === "inbound" ? "Makes a new private address and shows it once. The old address stops working." : undefined)}
                    loading={busy}
                    disabled={busy || Boolean(noManage) || (kind === "imap" && (!host.trim() || !user.trim() || (!password && !keepsPassword)))}
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
                {mailbox && !noManage && (
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
                {mailbox && !noManage && (
                    <Button variant="ghost" icon={Trash2} disabled={busy} onClick={() => run(async () => { await api(`/projects/${projectId}/mailbox`, { method: "DELETE" }); setAddress(""); setMsg({ tone: "success", text: "Removed. Email steps will say there is no test mailbox." }); })}>
                        Remove
                    </Button>
                )}
            </div>
        </section>
    );
}
