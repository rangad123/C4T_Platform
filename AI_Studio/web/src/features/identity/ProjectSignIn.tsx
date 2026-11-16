import { useState, type ReactNode } from "react";
import { Save } from "lucide-react";
import { api } from "../../api";
import { Callout, Button, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { useHere } from "../auth/project-access";
import { FRESH, SecretField, type AgentInputs, type SecretState } from "../requirements/AgentInputs";
import { useApiAccessForm } from "./ApiAccess";

/** The project's one sign-in, as GET/PUT /api/projects/:id/sign-in answer it: secrets only as "saved" flags. */
export interface ProjectSignIn {
    username: string | null;
    hasPassword: boolean;
    hasTotp: boolean;
    /** The address it is saved for, when it is tied to one. */
    site: string | null;
}

export const signInPath = (projectId: string) => `/projects/${projectId}/sign-in`;
/** Saved only with both a user name and a password, as runs need (the server's rule too). */
export const hasSignIn = (s: ProjectSignIn): boolean => Boolean(s.username && s.hasPassword);
/**
 * True when a test types the project's own sign-in: {{credentials.username}}, {{credentials.password}} or {{credentials.totp}} in its
 * steps, or TEST_USERNAME / TEST_PASSWORD in a code test. A named test account ({{credentials.admin.password}}) is not this sign-in.
 */
export const usesCredentials = (text: string): boolean => /\{\{\s*credentials\.(username|password|totp)\s*\}\}|\bTEST_(USERNAME|PASSWORD)\b/.test(text);

/**
 * Settings → Sign-in: the project's main account. The user name, password and authenticator secret tests type where a step uses
 * {{credentials.username}} and {{credentials.password}}; for a project tested by the AI agent also its API access (bearer token or
 * OAuth2 client); and `byHand`, the account's "Signed in by hand" part. The one place all of it is edited ("What the agents need" on
 * Requirements links here). Secrets are write-only: a saved one says "Saved", with Replace and Remove. Only people who may change the
 * project's settings can edit.
 */
export function ProjectSignInPanel({ projectId, byHand }: { projectId: string; byHand?: ReactNode }) {
    const got = useFetch<ProjectSignIn>(signInPath(projectId));
    // API access is kept with the agents' inputs; `applies` says whether the project is tested by the AI agent.
    const inputs = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    const [stamp, setStamp] = useState(0);
    if (got.loading || inputs.loading)
        return (
            <section className="card card-pad stack-sm" aria-label="Sign-in" aria-busy="true">
                <Skeleton w={160} h={20} />
                <Skeleton h={36} />
            </section>
        );
    if (!got.data)
        return (
            <Callout tone="danger" title="We couldn’t load the sign-in" actions={<Button size="sm" onClick={() => void got.reload()}>Try again</Button>}>
                {got.error ? describeApiError(got.error) : ""}
            </Callout>
        );
    return (
        <SignInCard
            key={stamp}
            projectId={projectId}
            data={got.data}
            apiAccess={inputs.data?.applies ? inputs.data.apiAccess : null}
            byHand={byHand}
            justSaved={stamp > 0}
            onSaved={async () => {
                await Promise.all([got.reload(), inputs.reload()]);
                setStamp((n) => n + 1);
            }}
        />
    );
}

type Key = "password" | "totpSecret";

const NO_API_ACCESS: AgentInputs["apiAccess"] = { hasToken: false, oauth2: null };

function SignInCard({ projectId, data, apiAccess, byHand, justSaved, onSaved }: { projectId: string; data: ProjectSignIn; apiAccess: AgentInputs["apiAccess"] | null; byHand?: ReactNode; justSaved: boolean; onSaved: () => Promise<void> }) {
    const may = useHere(projectId).may("ai_studio.project.settings");
    // The sign-in is saved with the application's address: none yet, nothing to save it with.
    const canEdit = may && data.site !== null;
    const [username, setUsername] = useState(data.username ?? "");
    const [secrets, setSecrets] = useState<Record<Key, SecretState>>({ password: FRESH, totpSecret: FRESH });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const setSecret = (k: Key, s: Partial<SecretState>) => setSecrets((all) => ({ ...all, [k]: { ...all[k], ...s } }));
    const apiForm = useApiAccessForm(apiAccess ?? NO_API_ACCESS);

    async function save() {
        setError("");
        setBusy(true);
        const clear = (["password", "totpSecret"] as const).filter((k) => secrets[k].remove);
        try {
            await api(signInPath(projectId), {
                method: "PUT",
                body: {
                    username: username.trim(),
                    password: secrets.password.value || undefined,
                    totpSecret: secrets.totpSecret.value.trim() || undefined,
                    clear: clear.length ? clear : undefined,
                },
            });
            // The API part only when it changed: it is saved beside the agents' other inputs, which stay as they are.
            if (apiAccess && apiForm.changed) await api(`/projects/${projectId}/agent-inputs`, { method: "PUT", body: apiForm.body() });
            setBusy(false);
            await onSaved();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack" data-testid="project-sign-in" aria-labelledby="sign-in-title">
            <div className="stack-sm">
                <h2 className="t-section" id="sign-in-title">
                    Main account
                </h2>
                <p className="t-secondary">
                    The login your tests use. Tests type these where a step uses <span className="mono">{"{{credentials.username}}"}</span> and <span className="mono">{"{{credentials.password}}"}</span>. Use a test account, never a real one.
                    {data.site && (
                        <>
                            {" "}
                            Saved for <span className="mono">{data.site}</span>.
                        </>
                    )}
                </p>
            </div>

            {data.site === null && (
                <Callout tone="info" title="Add the application’s address first">
                    The sign-in is saved with the address your tests run against. Add it in <a href={routes.projectSettings(projectId)}>Settings → General</a>.
                </Callout>
            )}
            <div className="grid-2">
                <div className="field">
                    <label htmlFor="si-user">User name or email</label>
                    <input id="si-user" className="input" autoComplete="off" value={username} disabled={!canEdit} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <SecretField id="si-pass" label="Password" saved={data.hasPassword} state={secrets.password} onChange={(s) => setSecret("password", s)} canEdit={canEdit} />
            </div>
            <SecretField
                id="si-totp"
                label="Authenticator secret (optional)"
                saved={data.hasTotp}
                state={secrets.totpSecret}
                onChange={(s) => setSecret("totpSecret", s)}
                canEdit={canEdit}
                hint="Only if the login asks for a one-time code from an authenticator app. Paste the setup key (letters and digits) shown when the test account was set up. Tests type the current code where a step uses {{credentials.totp}}."
            />
            {apiAccess && apiForm.fields(canEdit)}

            {error && <Callout tone="danger" title="We couldn’t save the sign-in">{error}</Callout>}
            {justSaved && !error && <Callout tone="success">Saved. Tests use this sign-in from their next run.</Callout>}
            {canEdit ? (
                <div className="row">
                    <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
                        {busy ? "Saving…" : "Save sign-in"}
                    </Button>
                    <span className="hint">Passwords and secrets are saved encrypted and never shown again.</span>
                </div>
            ) : (
                !may && <p className="t-meta">Only people who may change this project’s settings can change the sign-in.</p>
            )}
            {byHand && <div className="stack-sm" style={{ borderTop: "1px solid var(--border-default)", paddingTop: 16 }}>{byHand}</div>}
        </section>
    );
}

/**
 * The hint in a test's editor when it types the project's sign-in and none is saved: where to add it. Renders nothing while loading,
 * when a sign-in is saved, or when the person may not read it.
 */
export function MissingSignInHint({ projectId }: { projectId: string }) {
    const got = useFetch<ProjectSignIn>(signInPath(projectId));
    if (!got.data || hasSignIn(got.data)) return null;
    return (
        <Callout tone="warning" title="No sign-in saved for this project">
            <span data-testid="missing-sign-in">
                This test types the project’s sign-in ({"{{credentials.username}}"}, {"{{credentials.password}}"}), but its user name and password are not both saved yet. Add them in{" "}
                <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a>.
            </span>
        </Callout>
    );
}
