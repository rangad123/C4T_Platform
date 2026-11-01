import { ExternalLink, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { usePage } from "../../components/Shell";
import { Button, Callout, LinkButton, PageHeader, Skeleton } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { useAuth } from "../auth/auth";
import { YourAccount } from "../auth/PeopleSettings";
import { PERMISSION_WORDS, SIDE_WORDS, permissionsOf, sideOf, type Permission } from "../auth/permissions";

export interface Preferences {
    runAlertEmails: boolean;
    securityEmails: boolean;
    projectsView: "dashboard" | "list";
}
export interface PreferencesAnswer {
    preferences: Preferences;
    /** False for the access key and open access: there is no person to save them for. */
    saved: boolean;
}

/** Profile (NAV-02): who is signed in, what they can do, their personal API tokens, and their own preferences. */
export function ProfilePage() {
    useDocumentTitle("Profile");
    usePage({ crumbs: [{ label: "Profile" }], nav: "profile" });
    const { state } = useAuth();
    const me = state?.me;
    const perms = permissionsOf(me);
    const side = sideOf(me);
    const fromCrowd4Test = me?.via === "crowd4test";
    const granted = (Object.keys(PERMISSION_WORDS) as Permission[]).filter((p) => perms.has(p));
    return (
        <>
            <PageHeader title="Profile" subtitle="Your account, what you can do in AI Studio, and your own settings." />
            <div className="stack">
                <section className="card card-pad stack-sm" data-testid="profile-account" aria-labelledby="profile-account-title">
                    <h2 className="t-section" id="profile-account-title">
                        {fromCrowd4Test ? "Your Crowd4Test account" : "Account"}
                    </h2>
                    <dl className="kv">
                        <dt>Name</dt>
                        <dd>{me?.name ?? "—"}</dd>
                        {me?.email && (
                            <>
                                <dt>Email</dt>
                                <dd>{me.email}</dd>
                            </>
                        )}
                        {side !== "local" && (
                            <>
                                <dt>Side</dt>
                                <dd>{SIDE_WORDS[side]}</dd>
                            </>
                        )}
                    </dl>
                    {fromCrowd4Test && state?.crowd4test && (
                        <>
                            <p className="t-secondary">Crowd4Test keeps your account, so it is read-only here. Change your name, email or password on crowd4test.com.</p>
                            <div>
                                <LinkButton size="sm" icon={ExternalLink} href={state.crowd4test.portalUrl} external>
                                    Edit your account on crowd4test.com
                                </LinkButton>
                            </div>
                        </>
                    )}
                </section>
                <section className="card card-pad stack-sm" data-testid="profile-permissions" aria-labelledby="profile-permissions-title">
                    <h2 className="t-section" id="profile-permissions-title">
                        What you can do
                    </h2>
                    {granted.length === 0 ? (
                        <p className="t-secondary">Nothing yet. Ask your Crowd4Test administrator.</p>
                    ) : (
                        <ul className="planned-list">
                            {granted.map((p) => (
                                <li key={p}>{PERMISSION_WORDS[p]}</li>
                            ))}
                        </ul>
                    )}
                    <p className="t-meta">{fromCrowd4Test ? "A Crowd4Test administrator chooses these. Projects open to you are the ones you were added to." : "These follow your role on this platform."}</p>
                </section>
                {/* Password and personal API tokens: only for accounts of this platform itself. A Crowd4Test sign-in has neither here. */}
                {me?.kind === "user" && !fromCrowd4Test && <YourAccount />}
                {fromCrowd4Test && (
                    <section className="card card-pad stack-sm" data-testid="profile-tokens" aria-labelledby="profile-tokens-title">
                        <h2 className="t-section" id="profile-tokens-title">
                            Personal API tokens
                        </h2>
                        <p className="t-secondary">Personal API tokens are not available when you sign in with Crowd4Test: a token would keep working after your Crowd4Test account changed. Ask an owner of this platform for an access key if a script needs one.</p>
                    </section>
                )}
                <PreferencesCard />
            </div>
        </>
    );
}

function PreferencesCard() {
    const got = useFetch<PreferencesAnswer>("/me/preferences");
    const [prefs, setPrefs] = useState<Preferences | null>(null);
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    useEffect(() => {
        if (got.data) setPrefs(got.data.preferences);
    }, [got.data]);

    const save = async () => {
        if (!prefs) return;
        setBusy(true);
        setNote(null);
        try {
            const r = await api<PreferencesAnswer>("/me/preferences", { method: "PUT", body: prefs });
            setPrefs(r.preferences);
            await got.reload();
            setNote({ tone: "success", text: "Preferences saved." });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "Your preferences were not saved. Try again." });
        } finally {
            setBusy(false);
        }
    };
    const saved = got.data?.saved ?? false;
    const changed = Boolean(prefs && got.data && JSON.stringify(prefs) !== JSON.stringify(got.data.preferences));
    return (
        <section className="card card-pad stack" data-testid="profile-preferences" aria-labelledby="profile-preferences-title">
            <h2 className="t-section" id="profile-preferences-title">
                Preferences
            </h2>
            {got.loading || !prefs ? (
                got.error ? <Callout tone="danger">{got.error.message}</Callout> : <Skeleton h={160} />
            ) : (
                <>
                    <fieldset className="choice-group stack-sm">
                        <legend className="t-card">Emails</legend>
                        <p className="t-meta">AI Studio emails you only when a project's email alert channel lists your address. Turn a kind off to be left out of it; everyone else listed still gets it.</p>
                        <label className="check">
                            <input type="checkbox" disabled={!saved} checked={prefs.runAlertEmails} onChange={(e) => setPrefs({ ...prefs, runAlertEmails: e.target.checked })} />
                            <span>
                                <span className="title">Run alert emails</span>
                                <span className="hint t-meta">Failed runs, new failures, recoveries, flaky tests and API changes, from the channels in a project's Schedule → Alerts.</span>
                            </span>
                        </label>
                        <label className="check">
                            <input type="checkbox" disabled={!saved} checked={prefs.securityEmails} onChange={(e) => setPrefs({ ...prefs, securityEmails: e.target.checked })} />
                            <span>
                                <span className="title">Security assessment emails</span>
                                <span className="hint t-meta">When a security assessment ends, from the channels its project chose.</span>
                            </span>
                        </label>
                    </fieldset>
                    <fieldset className="choice-group stack-sm">
                        <legend className="t-card">Projects page</legend>
                        <p className="t-meta">How the Projects page opens when you have two or more projects.</p>
                        <label className="check">
                            <input type="radio" name="projects-view" disabled={!saved} checked={prefs.projectsView === "dashboard"} onChange={() => setPrefs({ ...prefs, projectsView: "dashboard" })} />
                            <span>
                                <span className="title">Dashboard</span>
                                <span className="hint t-meta">How ready each project is, with filters.</span>
                            </span>
                        </label>
                        <label className="check">
                            <input type="radio" name="projects-view" disabled={!saved} checked={prefs.projectsView === "list"} onChange={() => setPrefs({ ...prefs, projectsView: "list" })} />
                            <span>
                                <span className="title">List</span>
                                <span className="hint t-meta">A plain list you can group or filter by folder.</span>
                            </span>
                        </label>
                    </fieldset>
                    {note && <Callout tone={note.tone}>{note.text}</Callout>}
                    {saved ? (
                        <div>
                            <Button variant="primary" icon={Save} loading={busy} disabled={busy || !changed} onClick={() => void save()}>
                                Save preferences
                            </Button>
                        </div>
                    ) : (
                        <p className="t-meta">Preferences belong to a person's account. Sign in as yourself to choose them.</p>
                    )}
                </>
            )}
        </section>
    );
}
