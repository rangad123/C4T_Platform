import { KeyRound, LogIn } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, crowd4testSignIn, getKey, renewCrowd4Test, setKey } from "../../api";
import { Button, Callout, Disclosure, EmptyState, LinkButton } from "../../components/ui";
import { useRoute } from "../../lib/router";
import { AuthContext, getAuthState, type AuthState } from "./auth";

/**
 * Before anything else: who is using the platform. An open platform (no access key, nobody has an account) goes straight in.
 * A protected one asks for a sign-in with email and password (or single sign-on); "Use an access key" stays as a second way in.
 * While nobody has an account yet, the access key is the only way in, so its form is the first thing shown.
 */
export function AuthGate({ children }: { children: ReactNode }) {
    const { parts, query } = useRoute();
    const [state, setState] = useState<AuthState | null>(null);
    const [problem, setProblem] = useState<"unreachable" | null>(null);
    const [keyRefused, setKeyRefused] = useState(false);

    const check = useCallback(async (fromKeyForm = false) => {
        try {
            let s = await getAuthState();
            // Signed in with Crowd4Test but its 15-minute cookie has run out: renew it there, then ask again.
            if (!s.me && s.crowd4test?.status === "expired") {
                await renewCrowd4Test(s.crowd4test.refreshUrl);
                s = await getAuthState();
            }
            setProblem(null);
            setState(s);
            // A key was entered but the server did not take it (a public route ignores a wrong key, so "me" stays empty).
            setKeyRefused(fromKeyForm && !s.me);
        } catch {
            // Not reachable, or an answer the page cannot use: either way it cannot go on, and Try again asks once more.
            setProblem("unreachable");
        }
    }, []);
    useEffect(() => void check(), [check]);

    // An invite or reset link works without being signed in.
    if (parts[0] === "invite" && parts[1]) return <InvitePage token={parts[1]} onDone={() => { location.hash = "#/"; void check(); }} />;

    if (problem === "unreachable") {
        return (
            <main className="content" style={{ maxWidth: 560 }}>
                <div className="card">
                    <EmptyState icon={KeyRound} title="We can’t reach the platform server" actions={<Button variant="primary" onClick={() => void check()}>Try again</Button>}>
                        Check that the server is running, then try again.
                    </EmptyState>
                </div>
            </main>
        );
    }
    if (!state) return null;
    if (!state.me && state.crowd4test) return <Crowd4TestGate links={state.crowd4test} onRetry={() => void check()} />;
    if (!state.me) return <SignInPage state={state} keyRefused={keyRefused} ssoError={query.get("ssoError")} onKey={() => void check(true)} onSignedIn={() => void check()} />;
    return <AuthContext.Provider value={{ state, refresh: () => void check() }}>{children}</AuthContext.Provider>;
}

function KeyForm({ refused, onKey, primary }: { refused: boolean; onKey: () => void; primary: boolean }) {
    const [val, setVal] = useState(getKey());
    return (
        <form
            className="stack"
            onSubmit={(e) => {
                e.preventDefault();
                setKey(val);
                onKey();
            }}
        >
            <div className="field">
                <label htmlFor="key">Access key</label>
                <input id="key" className="input" type="password" autoFocus={primary} autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} />
            </div>
            {refused && <Callout tone="danger">That access key wasn’t accepted. Check it and try again.</Callout>}
            <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={!val}>
                Continue
            </Button>
        </form>
    );
}

function SignInPage({ state, keyRefused, ssoError, onKey, onSignedIn }: { state: AuthState; keyRefused: boolean; ssoError: string | null; onKey: () => void; onSignedIn: () => void }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Nobody has an account yet: only the access key gets in (its holder then adds the first owner in Settings, People).
    if (!state.hasPeople) {
        return (
            <main className="content" style={{ maxWidth: 460, paddingTop: 80 }}>
                <div className="card card-pad stack">
                    <div className="stack-sm">
                        <h1 className="t-page">Enter the access key</h1>
                        <p className="t-secondary">This platform is protected. Enter the access key the owner gave you. It is not an AI provider key, and you never need one.</p>
                    </div>
                    <KeyForm refused={keyRefused} onKey={onKey} primary />
                </div>
            </main>
        );
    }

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await api("/auth/sign-in", { method: "POST", body: { email, password } });
            setPassword("");
            setKey(""); // a stored access key would otherwise speak for this browser instead of the new session
            onSignedIn();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "Signing in did not work. Try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="content" style={{ maxWidth: 460, paddingTop: 64 }}>
            <div className="card card-pad stack">
                <div className="stack-sm">
                    <h1 className="t-page">Sign in</h1>
                    <p className="t-secondary">Use the email and password of your account on this platform.</p>
                </div>
                {ssoError && <Callout tone="danger" title="Single sign-on did not work">{ssoError}</Callout>}
                <form
                    className="stack"
                    onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                    }}
                >
                    <div className="field">
                        <label htmlFor="signin-email">Email</label>
                        <input id="signin-email" className="input" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="signin-password">Password</label>
                        <input id="signin-password" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    {error && <Callout tone="danger">{error}</Callout>}
                    <Button type="submit" variant="primary" icon={LogIn} loading={busy} disabled={!email || !password}>
                        Sign in
                    </Button>
                </form>
                {state.sso?.enabled && (
                    <LinkButton href="/api/auth/sso/start">{state.sso.label}</LinkButton>
                )}
                <p className="t-meta">Forgot your password? Ask an owner of this platform for a reset link.</p>
                <Disclosure label="Use an access key instead" defaultOpen={keyRefused}>
                    <div className="stack-sm">
                        <p className="t-secondary">For scripts and the owner of the server. The key gives full access.</p>
                        <KeyForm refused={keyRefused} onKey={onKey} primary={false} />
                    </div>
                </Disclosure>
            </div>
        </main>
    );
}

function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
    const [who, setWho] = useState<{ email: string; name: string; purpose: "invite" | "reset" } | null>(null);
    const [gone, setGone] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [again, setAgain] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<{ email: string; name: string; purpose: "invite" | "reset" }>("/auth/invite/check", { method: "POST", body: { token } })
            .then((w) => {
                setWho(w);
                setName(w.name);
            })
            .catch((e) => setGone(e instanceof ApiError ? e.message : "This link could not be checked. Try again."));
    }, [token]);

    const submit = async () => {
        if (password !== again) return setError("The two passwords are not the same.");
        setBusy(true);
        setError(null);
        try {
            await api("/auth/invite/accept", { method: "POST", body: { token, password, ...(name.trim() ? { name: name.trim() } : {}) } });
            setKey("");
            onDone();
        } catch (e) {
            setError(e instanceof ApiError ? e.message : "Setting the password did not work. Try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="content" style={{ maxWidth: 460, paddingTop: 64 }}>
            <div className="card card-pad stack">
                {gone ? (
                    <>
                        <h1 className="t-page">This link does not work</h1>
                        <Callout tone="warning">{gone}</Callout>
                        <a href="#/">Go to sign in</a>
                    </>
                ) : !who ? (
                    <p className="t-secondary" role="status">Checking the link…</p>
                ) : (
                    <>
                        <div className="stack-sm">
                            <h1 className="t-page">{who.purpose === "invite" ? "Set up your account" : "Choose a new password"}</h1>
                            <p className="t-secondary">
                                For <strong>{who.email}</strong>. Use at least 10 characters.
                            </p>
                        </div>
                        <form
                            className="stack"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void submit();
                            }}
                        >
                            {who.purpose === "invite" && !who.name && (
                                <div className="field">
                                    <label htmlFor="invite-name">Your name</label>
                                    <input id="invite-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                                </div>
                            )}
                            <input type="email" autoComplete="username" value={who.email} readOnly hidden />
                            <div className="field">
                                <label htmlFor="invite-password">New password</label>
                                <input id="invite-password" className="input" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
                            </div>
                            <div className="field">
                                <label htmlFor="invite-again">New password again</label>
                                <input id="invite-again" className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
                            </div>
                            {error && <Callout tone="danger">{error}</Callout>}
                            <Button type="submit" variant="primary" loading={busy} disabled={!password || !again}>
                                Save password and sign in
                            </Button>
                        </form>
                    </>
                )}
            </div>
        </main>
    );
}

/** Signing in happens on crowd4test.com: go there (and come back to this page), or say why this account cannot come in. */
function Crowd4TestGate({ links, onRetry }: { links: NonNullable<AuthState["crowd4test"]>; onRetry: () => void }) {
    const leave = links.status === "none" || links.status === "expired";
    useEffect(() => {
        if (leave) crowd4testSignIn(links.signInUrl);
    }, [leave, links.signInUrl]);
    if (leave) return null;
    return (
        <main className="content" style={{ maxWidth: 560, paddingTop: 64 }}>
            <div className="card">
                {links.status === "unreachable" ? (
                    <EmptyState icon={KeyRound} title="We can’t reach Crowd4Test sign-in" actions={<Button variant="primary" onClick={onRetry}>Try again</Button>}>
                        AI Studio uses your Crowd4Test sign-in, and it is not answering right now.
                    </EmptyState>
                ) : (
                    <EmptyState icon={KeyRound} title="You can’t open AI Studio yet" actions={<LinkButton href={links.portalUrl}>Go to your Crowd4Test portal</LinkButton>}>
                        {links.message ?? "Crowd4Test did not let this account in."}
                    </EmptyState>
                )}
            </div>
        </main>
    );
}
