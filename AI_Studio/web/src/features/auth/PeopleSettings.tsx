import { Copy, KeyRound, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, setKey } from "../../api";
import { Badge, Button, Callout, Disclosure, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { describeActivity, ROLE_HELP, ROLE_WORDS, useAuth, type ActivityRow, type Person, type Role, type TokenInfo } from "./auth";
import { BadgeKey, FieldHelp } from "../../components/Tooltip";
import { PROJECT_ACCESS } from "../../lib/help";
import type { ProjectRow } from "../../api";
import { AccessBadge, ProjectAccessEditor } from "./ProjectAccess";

/** What the badges on a person and on an Activity entry mean. */
const PERSON_BADGE = {
    off: "Can’t sign in until the account is turned on again.",
    invited: "An invite link was made and has not been used yet. Each link works for 7 days.",
    sso: "Signs in through your company’s sign-in provider.",
} as const;
const REFUSED = "The platform did not accept this request (it answered with status 400 or higher).";

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/** A one-time secret (invite link, API token) shown once with a copy button. */
function ShownOnce({ label, value, note }: { label: string; value: string; note: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <Callout tone="success" title={label}>
            <div className="stack-sm">
                <code className="mono" style={{ wordBreak: "break-all" }} data-testid="shown-once">
                    {value}
                </code>
                <div className="row">
                    <Button
                        size="sm"
                        icon={Copy}
                        onClick={() => {
                            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
                        }}
                    >
                        {copied ? "Copied" : "Copy"}
                    </Button>
                </div>
                <span className="t-meta">{note}</span>
            </div>
        </Callout>
    );
}

function RoleSelect({ id, value, onChange, max = "owner", label }: { id: string; value: Role; onChange: (r: Role) => void; max?: Role; label?: string }) {
    const order: Role[] = ["viewer", "editor", "owner"];
    return (
        <select id={id} className="input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Role)}>
            {order.slice(0, order.indexOf(max) + 1).map((r) => (
                <option key={r} value={r}>
                    {ROLE_WORDS[r]}
                </option>
            ))}
        </select>
    );
}

/** Settings: People, your account, Activity and single sign-on. What shows depends on who is looking. */
export function PeopleSettings() {
    const { state, refresh } = useAuth();
    const me = state?.me;
    if (!state || !me) return null;
    // People, Activity and single sign-on are platform-wide: an owner limited to some projects does not manage them.
    const owner = me.role === "owner" && state.projectAccess !== "only";
    return (
        <>
            {!state.hasPeople && (me.kind === "key" || me.kind === "open") && <FirstOwner onDone={refresh} open={me.kind === "open"} />}
            {owner && state.hasPeople && <PeopleList myId={me.id} />}
            {owner && state.hasPeople && <ActivityList />}
            {owner && state.hasPeople && <SsoSettings />}
        </>
    );
}

function FirstOwner({ onDone, open }: { onDone: () => void; open: boolean }) {
    const [f, setF] = useState({ name: "", email: "", password: "" });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await api("/auth/setup", { method: "POST", body: f });
            setKey(""); // from now on this browser is the new owner, not the access key
            onDone();
        } catch (e) {
            setError(msg(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="people-h">
            <h2 className="t-section" id="people-h">
                People
            </h2>
            <p className="t-secondary">
                Nobody has an account yet. Add yourself as the first owner; then invite others with the role each needs.
                {open ? " From then on everyone signs in before using the platform." : " The access key keeps working for scripts and runners."}
            </p>
            <form
                className="stack-sm"
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <div className="field">
                    <label htmlFor="fo-name">Your name</label>
                    <input id="fo-name" className="input" autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
                </div>
                <div className="field">
                    <label htmlFor="fo-email">Your email</label>
                    <input id="fo-email" className="input" type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
                </div>
                <div className="field">
                    <label htmlFor="fo-password">Password</label>
                    <input id="fo-password" className="input" type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
                    <span className="t-meta">At least 10 characters.</span>
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="row">
                    <Button type="submit" variant="primary" icon={UserPlus} loading={busy} disabled={!f.name || !f.email || !f.password}>
                        Create owner account
                    </Button>
                </div>
            </form>
        </section>
    );
}

function PeopleList({ myId }: { myId?: string }) {
    const [people, setPeople] = useState<Person[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "editor" });
    const [formError, setFormError] = useState<string | null>(null);
    const [shown, setShown] = useState<{ label: string; value: string; note: string } | null>(null);
    const [rowError, setRowError] = useState<string | null>(null);
    // Every project, for the "Only these projects" picker (an owner who sees all projects gets all of them).
    const [projects, setProjects] = useState<ProjectRow[] | null>(null);

    const load = useCallback(() => {
        setError(null);
        api<{ people: Person[] }>("/users")
            .then((r) => setPeople(r.people))
            .catch((e) => setError(msg(e)));
    }, []);
    useEffect(load, [load]);
    useEffect(() => {
        api<ProjectRow[]>("/projects").then(setProjects, () => setProjects([]));
    }, []);

    const act = async (fn: () => Promise<unknown>) => {
        setRowError(null);
        try {
            await fn();
            load();
        } catch (e) {
            setRowError(msg(e));
        }
    };

    const add = async () => {
        setFormError(null);
        try {
            const r = await api<{ inviteLink: string; note: string }>("/users", { method: "POST", body: form });
            setShown({ label: `Invite link for ${form.email}`, value: r.inviteLink, note: r.note });
            setForm({ email: "", name: "", role: "editor" });
            setAdding(false);
            load();
        } catch (e) {
            setFormError(msg(e));
        }
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="people-h">
            <div className="row">
                <h2 className="t-section" id="people-h">
                    People
                </h2>
                {people && (
                    <BadgeKey
                        label="the badges of people"
                        entries={[
                            people.some((u) => u.status === "disabled") && { word: "Turned off", text: PERSON_BADGE.off },
                            people.some((u) => u.invitePending) && { word: "Invited", text: PERSON_BADGE.invited },
                            people.some((u) => u.sso) && { word: "Single sign-on", text: PERSON_BADGE.sso },
                            people.some((u) => !u.access || u.access.mode === "all") && { word: "All projects", text: PROJECT_ACCESS.all },
                            people.some((u) => u.access && u.access.mode !== "all") && { word: "A number of projects", text: PROJECT_ACCESS.only },
                        ]}
                    />
                )}
                <span className="spacer" />
                {!adding && (
                    <Button size="sm" icon={UserPlus} onClick={() => setAdding(true)}>
                        Add a person
                    </Button>
                )}
            </div>
            <p className="t-secondary">Everyone who can sign in, and what their role lets them do. A role applies to every project the person can see: all projects, or only the ones you choose.</p>
            {shown && <ShownOnce {...shown} />}
            {adding && (
                <form
                    className="stack-sm"
                    style={{ border: "1px solid var(--border-default)", borderRadius: 10, padding: 14 }}
                    onSubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}
                >
                    <div className="field">
                        <label htmlFor="np-email">Email</label>
                        <input id="np-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="np-name">Name</label>
                        <input id="np-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="np-role">Role</label>
                        <RoleSelect id="np-role" value={form.role} onChange={(role) => setForm({ ...form, role })} />
                        <span className="t-meta">{ROLE_HELP[form.role]}</span>
                    </div>
                    <p className="t-meta">You get a link to send to the person. They choose their own password with it.</p>
                    {formError && <Callout tone="danger">{formError}</Callout>}
                    <div className="row">
                        <Button type="submit" variant="primary" disabled={!form.email}>
                            Add and make invite link
                        </Button>
                        <Button variant="ghost" onClick={() => setAdding(false)}>
                            Cancel
                        </Button>
                    </div>
                </form>
            )}
            {rowError && <Callout tone="danger">{rowError}</Callout>}
            {error ? (
                <ErrorState error={{ title: "People could not be loaded", body: error }} onRetry={load} />
            ) : !people ? (
                <ListSkeleton rows={2} />
            ) : (
                <ul className="list divided" style={{ border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
                    {people.map((u) => (
                        <li className="list-row" key={u.id} style={{ padding: "10px 14px", flexWrap: "wrap", gap: 8 }}>
                            <span className="main" style={{ minWidth: 180 }}>
                                <span className="title">
                                    {u.name || u.email}
                                    {u.id === myId && <span className="t-meta"> (you)</span>}
                                </span>
                                <span className="meta">
                                    {u.email}, last signed in {when(u.lastSignInAt)}
                                </span>
                            </span>
                            {u.status === "disabled" && <Badge tone="warning" tip={PERSON_BADGE.off}>Turned off</Badge>}
                            {u.invitePending && <Badge tone="neutral" tip={PERSON_BADGE.invited}>Invited</Badge>}
                            {u.sso && <Badge tone="neutral" tip={PERSON_BADGE.sso}>Single sign-on</Badge>}
                            <AccessBadge access={u.access} />
                            <RoleSelect id={`role-${u.id}`} label={`Role of ${u.name || u.email}`} value={u.role} onChange={(role) => void act(() => api(`/users/${u.id}`, { method: "PATCH", body: { role } }))} />
                            <Disclosure label="More">
                                <div className="row" style={{ flexWrap: "wrap" }}>
                                    <Button
                                        size="sm"
                                        tip={u.hasPassword ? "A link to choose a new password, shown once and valid for 24 hours. An earlier unused link stops working." : "A new invite link, shown once and valid for 7 days. An earlier unused link stops working."}
                                        onClick={() =>
                                            void act(async () => {
                                                const r = await api<{ link: string; note: string; purpose: string }>(`/users/${u.id}/reset-link`, { method: "POST" });
                                                setShown({ label: r.purpose === "reset" ? `Reset link for ${u.email}` : `Invite link for ${u.email}`, value: r.link, note: r.note });
                                            })
                                        }
                                    >
                                        {u.hasPassword ? "Make reset link" : "Make new invite link"}
                                    </Button>
                                    <Button size="sm" tip="Ends their sign-ins on every computer. They can sign in again." onClick={() => void act(() => api(`/users/${u.id}/sign-out`, { method: "POST" }))}>
                                        Sign out everywhere
                                    </Button>
                                    <Button size="sm" tip={u.status === "active" ? "Signs them out at once; they can’t sign in until it is turned on again. What they did stays in Activity." : "They can sign in again."} onClick={() => void act(() => api(`/users/${u.id}`, { method: "PATCH", body: { status: u.status === "active" ? "disabled" : "active" } }))}>
                                        {u.status === "active" ? "Turn off account" : "Turn on account"}
                                    </Button>
                                    {u.id !== myId && (
                                        <Button
                                            size="sm"
                                            variant="danger"
                                            onClick={() => {
                                                if (confirm(`Remove ${u.email}? They can no longer sign in. What they did stays in Activity.`)) void act(() => api(`/users/${u.id}`, { method: "DELETE" }));
                                            }}
                                        >
                                            Remove
                                        </Button>
                                    )}
                                </div>
                            </Disclosure>
                            {u.id !== myId && (
                                <div style={{ flexBasis: "100%" }}>
                                    <ProjectAccessEditor person={u} projects={projects} onSaved={load} />
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** The signed-in person's own account: password and personal API tokens. Shown on the Profile page (pages under #/profile). */
export function YourAccount() {
    const { state, refresh } = useAuth();
    const me = state!.me!;
    const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState<{ label: string; value: string; note: string } | null>(null);
    const [tok, setTok] = useState<{ name: string; role: Role; days: string }>({ name: "", role: me.role, days: "90" });
    const [pw, setPw] = useState({ current: "", next: "" });
    const [pwNote, setPwNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    /** Why "Sign out everywhere" did not work (shown beside it; on success the page signs out). */
    const [signOutError, setSignOutError] = useState<string | null>(null);

    const load = useCallback(() => {
        api<{ tokens: TokenInfo[] }>("/me/tokens")
            .then((r) => setTokens(r.tokens))
            .catch((e) => setError(msg(e)));
    }, []);
    useEffect(load, [load]);

    const makeToken = async () => {
        setError(null);
        try {
            const r = await api<{ token: string; note: string }>("/me/tokens", { method: "POST", body: { name: tok.name, role: tok.role, ...(tok.days ? { expiresInDays: Number(tok.days) } : {}) } });
            setShown({ label: `API token “${tok.name}”`, value: r.token, note: `${r.note} Send it as the x-api-key header (or Authorization: Bearer).` });
            setTok({ ...tok, name: "" });
            load();
        } catch (e) {
            setError(msg(e));
        }
    };

    const changePassword = async () => {
        setPwNote(null);
        try {
            const r = await api<{ otherSessionsEnded: number }>("/me/password", { method: "PUT", body: pw });
            setPw({ current: "", next: "" });
            setPwNote({ tone: "success", text: r.otherSessionsEnded ? `Password changed. ${r.otherSessionsEnded} other sign-in${r.otherSessionsEnded === 1 ? " was" : "s were"} ended.` : "Password changed." });
        } catch (e) {
            setPwNote({ tone: "danger", text: msg(e) });
        }
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="account-h">
            <div className="row">
                <h2 className="t-section" id="account-h">
                    Your account
                </h2>
                <span className="spacer" />
                <Badge tone="brand">{ROLE_WORDS[me.role]}</Badge>
            </div>
            <p className="t-secondary">
                Signed in as <strong>{me.name}</strong>
                {me.email ? ` (${me.email})` : ""}. {ROLE_HELP[me.role]}
            </p>
            {state?.projectAccess === "only" && <p className="t-meta">You see only the projects an owner chose for you, with the role chosen for each. Your API tokens see the same projects.</p>}

            <Disclosure label="Change your password">
                <form
                    className="stack-sm"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void changePassword();
                    }}
                >
                    <input type="email" autoComplete="username" value={me.email ?? ""} readOnly hidden />
                    <div className="field">
                        <label htmlFor="pw-current">Current password</label>
                        <input id="pw-current" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="pw-next">New password</label>
                        <input id="pw-next" className="input" type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
                    </div>
                    {pwNote && <Callout tone={pwNote.tone}>{pwNote.text}</Callout>}
                    <div className="row">
                        <Button type="submit" disabled={!pw.next}>
                            Change password
                        </Button>
                    </div>
                </form>
            </Disclosure>

            <Disclosure label="Your API tokens">
                <div className="stack-sm">
                    <p className="t-secondary">For scripts, the command line and the MCP server, acting as you with at most your role. Each is shown once.</p>
                    {shown && <ShownOnce {...shown} />}
                    {error && <Callout tone="danger">{error}</Callout>}
                    {!tokens ? (
                        <ListSkeleton rows={1} />
                    ) : tokens.length === 0 ? (
                        <p className="t-meta">No tokens yet.</p>
                    ) : (
                        <ul className="list divided" style={{ border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
                            {tokens.map((t) => (
                                <li className="list-row" key={t.id} style={{ padding: "8px 14px" }}>
                                    <span className="main">
                                        <span className="title">{t.name}</span>
                                        <span className="meta">
                                            ends in <span className="mono">…{t.hint}</span>, {ROLE_WORDS[t.role]}, last used {when(t.lastUsedAt)}
                                            {t.expiresAt ? `, expires ${new Date(t.expiresAt).toLocaleDateString()}` : ""}
                                        </span>
                                    </span>
                                    <Button size="sm" variant="ghost" onClick={() => void api(`/me/tokens/${t.id}`, { method: "DELETE" }).then(load, (e) => setError(msg(e)))}>
                                        Remove
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <form
                        className="row"
                        style={{ flexWrap: "wrap", alignItems: "flex-end" }}
                        onSubmit={(e) => {
                            e.preventDefault();
                            void makeToken();
                        }}
                    >
                        <div className="field" style={{ flex: "1 1 180px" }}>
                            <label htmlFor="tok-name">Token name</label>
                            <input id="tok-name" className="input" value={tok.name} onChange={(e) => setTok({ ...tok, name: e.target.value })} placeholder="CI pipeline" />
                        </div>
                        <div className="field">
                            <label htmlFor="tok-role">Role</label>
                            <RoleSelect id="tok-role" value={tok.role} max={me.role} onChange={(role) => setTok({ ...tok, role })} />
                        </div>
                        <div className="field">
                            <label htmlFor="tok-days">Expires after</label>
                            <select id="tok-days" className="input" value={tok.days} onChange={(e) => setTok({ ...tok, days: e.target.value })}>
                                <option value="30">30 days</option>
                                <option value="90">90 days</option>
                                <option value="365">1 year</option>
                                <option value="">Never</option>
                            </select>
                        </div>
                        <Button type="submit" icon={KeyRound} disabled={!tok.name.trim() || me.via !== "session"}>
                            Make token
                        </Button>
                    </form>
                </div>
            </Disclosure>

            <div className="row">
                <Button
                    size="sm"
                    onClick={() => {
                        if (!confirm("Sign out on every computer, including this one?")) return;
                        setSignOutError(null);
                        void api("/me/sign-out-everywhere", { method: "POST" }).then(refresh, (e) => setSignOutError(msg(e)));
                    }}
                >
                    Sign out everywhere
                </Button>
            </div>
            {signOutError && <Callout tone="danger" title="You are still signed in everywhere">{signOutError}</Callout>}
        </section>
    );
}

function ActivityList() {
    const [rows, setRows] = useState<ActivityRow[] | null>(null);
    const [next, setNext] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [q, setQ] = useState("");
    const [kind, setKind] = useState("");

    const load = useCallback(
        (before?: number) => {
            setError(null);
            const p = new URLSearchParams({ limit: "25" });
            if (q.trim()) p.set("q", q.trim());
            if (kind) p.set("kind", kind);
            if (before) p.set("before", String(before));
            api<{ activity: ActivityRow[]; next: number | null }>(`/activity?${p}`)
                .then((r) => {
                    setRows((cur) => (before ? [...(cur ?? []), ...r.activity] : r.activity));
                    setNext(r.next);
                })
                .catch((e) => setError(msg(e)));
        },
        [q, kind],
    );
    useEffect(() => load(), [load]);

    return (
        <section className="card card-pad stack-sm" aria-labelledby="activity-h">
            <div className="row" style={{ gap: 4 }}>
                <h2 className="t-section" id="activity-h">
                    Activity
                </h2>
                <BadgeKey label="Refused" entries={[(rows ?? []).some((a) => a.status !== null && a.status >= 400) && { word: "Refused", text: REFUSED }]} />
            </div>
            <p className="t-secondary">Who changed what, and when. Reading is not recorded. The newest 20,000 entries of the last 180 days are kept.</p>
            <div className="row" style={{ flexWrap: "wrap" }}>
                <div className="field" style={{ flex: "1 1 200px" }}>
                    <label htmlFor="act-q">Contains</label>
                    <input id="act-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="tests, sign-in, schedules" />
                </div>
                <div className="field">
                    <FieldHelp htmlFor="act-kind" label="Who" help="People: someone signed in, or their own token. Access key: the server’s shared key, used by scripts. Deploy triggers: a pipeline’s token. Open access: changes made while no sign-in was needed." />
                    <select id="act-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                        <option value="">Everyone</option>
                        <option value="user">People</option>
                        <option value="key">Access key</option>
                        <option value="trigger">Deploy triggers</option>
                        <option value="open">Open access</option>
                    </select>
                </div>
            </div>
            {error ? (
                <ErrorState error={{ title: "Activity could not be loaded", body: error }} onRetry={() => load()} />
            ) : !rows ? (
                <ListSkeleton rows={3} />
            ) : rows.length === 0 ? (
                <EmptyState icon={Users} title="Nothing recorded yet">
                    Changes made from now on appear here.
                </EmptyState>
            ) : (
                <>
                    <ul className="list divided" style={{ border: "1px solid var(--border-default)", borderRadius: 8, overflow: "hidden" }}>
                        {rows.map((a) => (
                            <li className="list-row" key={a.id} style={{ padding: "8px 14px" }}>
                                <span className="main">
                                    <span className="title">
                                        {a.actor.name}: {describeActivity(a)}
                                    </span>
                                    <span className="meta">
                                        <span className="mono">{new Date(a.at).toLocaleString()}</span>
                                        {a.path ? <>, <span className="mono">{a.path}</span></> : null}
                                        {a.detail ? `, ${a.detail}` : ""}
                                    </span>
                                </span>
                                {a.status !== null && a.status >= 400 && <Badge tone="warning" tip={REFUSED}>Refused</Badge>}
                            </li>
                        ))}
                    </ul>
                    {next && (
                        <div className="row">
                            <Button size="sm" onClick={() => load(next)}>
                                Show older
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

interface SsoView {
    configured: boolean;
    issuer?: string;
    clientId?: string;
    allowedDomain?: string;
    defaultRole?: "viewer" | "editor";
    label?: string;
    hasSecret?: boolean;
    redirectUri: string;
}

function SsoSettings() {
    const [view, setView] = useState<SsoView | null>(null);
    const [f, setF] = useState({ issuer: "", clientId: "", clientSecret: "", allowedDomain: "", defaultRole: "viewer" as "viewer" | "editor", label: "" });
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const fill = (v: SsoView) => {
        setView(v);
        setF({ issuer: v.issuer ?? "", clientId: v.clientId ?? "", clientSecret: "", allowedDomain: v.allowedDomain ?? "", defaultRole: v.defaultRole ?? "viewer", label: v.label ?? "" });
    };
    useEffect(() => {
        api<SsoView>("/sso-settings").then(fill, (e) => setNote({ tone: "danger", text: msg(e) }));
    }, []);

    const save = async () => {
        setBusy(true);
        setNote(null);
        try {
            const { clientSecret, ...rest } = f;
            fill(await api<SsoView>("/sso-settings", { method: "PUT", body: { ...rest, ...(clientSecret ? { clientSecret } : {}) } }));
            setNote({ tone: "success", text: "Saved. The sign-in page now offers single sign-on." });
        } catch (e) {
            setNote({ tone: "danger", text: msg(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card card-pad stack-sm" aria-labelledby="sso-h">
            <div className="row">
                <h2 className="t-section" id="sso-h">
                    Single sign-on
                </h2>
                <span className="spacer" />
                {view && <Badge tone={view.configured ? "success" : "neutral"}>{view.configured ? "On" : "Off"}</Badge>}
            </div>
            <p className="t-secondary">Let people sign in with your company’s OpenID Connect provider (Okta, Microsoft Entra ID, Google Workspace, Keycloak and others). New people get the role you choose here; change it in People.</p>
            <Disclosure label={view?.configured ? "Change single sign-on" : "Set up single sign-on"}>
                <form
                    className="stack-sm"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void save();
                    }}
                >
                    {view && (
                        <p className="t-meta">
                            Give the provider this sign-in redirect address: <code className="mono">{view.redirectUri}</code>
                        </p>
                    )}
                    <div className="field">
                        <label htmlFor="sso-issuer">Issuer address</label>
                        <input id="sso-issuer" className="input" value={f.issuer} placeholder="https://login.example.com" onChange={(e) => setF({ ...f, issuer: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="sso-client">Client ID</label>
                        <input id="sso-client" className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="sso-secret">Client secret</label>
                        <input id="sso-secret" className="input" type="password" autoComplete="off" value={f.clientSecret} placeholder={view?.hasSecret ? "Saved; leave empty to keep it" : ""} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="sso-domain">Allowed email domain</label>
                        <input id="sso-domain" className="input" value={f.allowedDomain} placeholder="example.com" onChange={(e) => setF({ ...f, allowedDomain: e.target.value })} />
                    </div>
                    <div className="field">
                        <label htmlFor="sso-role">Role for people who sign in for the first time</label>
                        <select id="sso-role" className="input" value={f.defaultRole} onChange={(e) => setF({ ...f, defaultRole: e.target.value as "viewer" | "editor" })}>
                            <option value="viewer">Viewer</option>
                            <option value="editor">Editor</option>
                        </select>
                    </div>
                    <div className="field">
                        <label htmlFor="sso-label">Button text</label>
                        <input id="sso-label" className="input" value={f.label} placeholder="Sign in with single sign-on" onChange={(e) => setF({ ...f, label: e.target.value })} />
                    </div>
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    <div className="row">
                        <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy} disabled={!f.issuer || !f.clientId || !f.allowedDomain}>
                            Check and save
                        </Button>
                        {view?.configured && (
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    if (confirm("Turn off single sign-on? People who only used it need a reset link to sign in with a password.")) void api<unknown>("/sso-settings", { method: "DELETE" }).then(() => api<SsoView>("/sso-settings").then(fill));
                                }}
                            >
                                Turn off
                            </Button>
                        )}
                    </div>
                </form>
            </Disclosure>
        </section>
    );
}
