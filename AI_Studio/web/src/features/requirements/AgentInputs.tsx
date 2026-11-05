import { useEffect, useRef, useState } from "react";
import { ChevronRight, KeyRound, RotateCcw, Save, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Badge, Button, Callout, Disclosure } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { plural } from "../../lib/format";
import { routes, useRoute } from "../../lib/router";
import { useCan } from "../auth/permissions";

/** One input a chosen agent cannot work without and that is not saved yet (GET /api/projects/:id/agent-inputs). */
export interface MissingInput {
    agent: string;
    agentName: string;
    input: "signIn" | "apiAccess" | "openApiUrl" | "requirements";
    inputName: string;
    text: string;
}

/** What the project's testing agents use when they explore, as the server answers it: secrets only as "saved" flags. */
export interface AgentInputs {
    applies: boolean;
    application: { url: string } | null;
    signIn: { username: string | null; hasPassword: boolean; hasTotpSecret: boolean };
    apiAccess: { hasToken: boolean; oauth2: { tokenUrl: string; clientId: string; scope: string | null; hasClientSecret: boolean } | null };
    openApiUrl: string | null;
    allowMutatingApiTests: boolean;
    cleanupAfter: boolean;
    requirements: { active: number };
    agents: { ids: string[]; names: string[]; source: "chosen" | "matched" } | null;
    missing: MissingInput[];
}

/** The Requirements tab with this card open and in view: where the pop-up before exploring and a failed API test's advice lead. */
export const agentInputsHref = (projectId: string): string => `${routes.requirements(projectId)}?inputs=open`;

/** The card's one line while it is closed: what is saved and what is missing (the inputs a chosen agent cannot work without). */
export function inputsSummary(data: AgentInputs): string {
    const saved = [
        data.signIn.username ? `sign-in as ${data.signIn.username}` : data.signIn.hasPassword ? "sign-in" : null,
        data.apiAccess.hasToken ? "API token" : data.apiAccess.oauth2 ? "OAuth2 client credentials" : null,
        data.openApiUrl ? "OpenAPI document" : null,
        data.requirements.active > 0 ? plural(data.requirements.active, "active requirement") : null,
    ].filter(Boolean);
    const missing = [...new Set(data.missing.map((m) => m.inputName))];
    const savedText = saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing saved yet.";
    return missing.length ? `${savedText} Missing: ${missing.join(", ")}.` : `${savedText} Nothing the chosen agents need is missing.`;
}

type SecretKey = "password" | "totpSecret" | "apiToken" | "clientSecret";
interface SecretState {
    value: string;
    replacing: boolean;
    remove: boolean;
}
const FRESH: SecretState = { value: "", replacing: false, remove: false };

/**
 * "What the agents need", on the Requirements tab of a project tested by the AI agent: the sign-in, API access, the OpenAPI document
 * and the data-changing choice that exploring uses, kept once here instead of typed on every exploration. Secrets are never shown:
 * a saved one says "Saved", with Replace and Remove. Only people who may change the project's settings can edit; others see what is
 * set. Renders nothing for a project not tested by the AI agent.
 */
export function AgentInputs({ projectId }: { projectId: string }) {
    const got = useFetch<AgentInputs>(`/projects/${projectId}/agent-inputs`);
    const [stamp, setStamp] = useState(0);
    if (!got.data?.applies) return null;
    return (
        <InputsCard
            key={stamp}
            projectId={projectId}
            data={got.data}
            justSaved={stamp > 0}
            onSaved={async () => {
                await got.reload();
                setStamp((n) => n + 1);
            }}
        />
    );
}

function InputsCard({ projectId, data, justSaved, onSaved }: { projectId: string; data: AgentInputs; justSaved: boolean; onSaved: () => Promise<void> }) {
    const can = useCan();
    const canEdit = can("ai_studio.project.settings") && data.application !== null;
    const [username, setUsername] = useState(data.signIn.username ?? "");
    const [secrets, setSecrets] = useState<Record<SecretKey, SecretState>>({ password: FRESH, totpSecret: FRESH, apiToken: FRESH, clientSecret: FRESH });
    const o = data.apiAccess.oauth2;
    const [oauth, setOauth] = useState({ tokenUrl: o?.tokenUrl ?? "", clientId: o?.clientId ?? "", scope: o?.scope ?? "" });
    const [removeOauth, setRemoveOauth] = useState(false);
    const [openApiUrl, setOpenApiUrl] = useState(data.openApiUrl ?? "");
    const [allowMutating, setAllowMutating] = useState(data.allowMutatingApiTests);
    const [cleanupAfter, setCleanupAfter] = useState(data.cleanupAfter);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const setSecret = (k: SecretKey, s: Partial<SecretState>) => setSecrets((all) => ({ ...all, [k]: { ...all[k], ...s } }));
    // Closed to one line, unless something the agents cannot work without is missing, the person came here to add it, or just saved.
    const route = useRoute();
    const cameFor = route.query.get("inputs") === "open";
    const [open, setOpen] = useState(justSaved || cameFor || data.missing.length > 0);
    const toggle = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!cameFor || justSaved) return;
        toggle.current?.scrollIntoView({ block: "start" });
        toggle.current?.focus({ preventScroll: true });
        // Once, on arrival: the card's own save remounts it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const needs = (input: MissingInput["input"]) => data.missing.filter((m) => m.input === input);

    async function save() {
        setError("");
        setBusy(true);
        const clear = [secrets.password.remove && "password", secrets.totpSecret.remove && "totpSecret", secrets.apiToken.remove && "apiToken", removeOauth && "oauth2"].filter(Boolean);
        const oauthTyped = oauth.tokenUrl.trim() || oauth.clientId.trim();
        try {
            await api(`/projects/${projectId}/agent-inputs`, {
                method: "PUT",
                body: {
                    username,
                    password: secrets.password.value || undefined,
                    totpSecret: secrets.totpSecret.value.trim() || undefined,
                    apiToken: secrets.apiToken.value || undefined,
                    oauth2: !removeOauth && (oauthTyped || o) ? { tokenUrl: oauth.tokenUrl, clientId: oauth.clientId, scope: oauth.scope || undefined, clientSecret: secrets.clientSecret.value || undefined } : undefined,
                    openApiUrl,
                    allowMutatingApiTests: allowMutating,
                    cleanupAfter,
                    clear: clear.length ? clear : undefined,
                },
            });
            setBusy(false);
            await onSaved();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack" data-testid="agent-inputs" aria-labelledby="agent-inputs-title">
            <div className="stack-sm">
                <h2 className="t-section" id="agent-inputs-title">
                    <button ref={toggle} type="button" className="inputs-toggle" aria-expanded={open} aria-controls="agent-inputs-body" onClick={() => setOpen((o) => !o)}>
                        <ChevronRight size={18} className="chev" aria-hidden />
                        What the agents need
                    </button>
                </h2>
                {!open && (
                    <p className="t-secondary" data-testid="agent-inputs-summary">
                        {inputsSummary(data)}
                    </p>
                )}
            </div>
            {open && (
                <div className="stack" id="agent-inputs-body">
                    <div className="stack-sm">
                        <p className="t-secondary">
                            The sign-in, API access and documents this project’s testing agents use when they explore. Exploring uses what is saved here; nothing needs typing again on the Explore page.
                            {data.application && (
                                <>
                                    {" "}
                                    Saved for <span className="mono">{data.application.url}</span>; exploring another site starts without them.
                                </>
                            )}
                        </p>
                    </div>
                    {!data.application && (
                        <Callout tone="info" title="Add the application’s address first">
                            These are saved with the address the agents explore. Add it in <a href={routes.projectSettings(projectId)}>Settings → General</a>, or explore the application once.
                        </Callout>
                    )}
                    {data.missing.length > 0 && (
                        <Callout tone="warning" title="Needed before exploring">
                            <span data-testid="agent-inputs-missing">{data.missing.map((m) => m.text).join(" ")}</span>
                        </Callout>
                    )}

                    <div className="stack" style={{ gap: 0 }}>
                        <div className="stack-sm opt-group first" style={{ paddingTop: 0 }}>
                            <div>
                                <div className="t-card">Sign in</div>
                                <p className="hint">Optional. Lets the agents test pages behind a login. Use a dedicated test account, never a real one.</p>
                            </div>
                            <div className="grid-2">
                                <div className="field">
                                    <label htmlFor="ai-user">Username or email</label>
                                    <input id="ai-user" className="input" autoComplete="off" value={username} disabled={!canEdit} onChange={(e) => setUsername(e.target.value)} />
                                </div>
                                <SecretField id="ai-pass" label="Password" saved={data.signIn.hasPassword} state={secrets.password} onChange={(s) => setSecret("password", s)} canEdit={canEdit} />
                            </div>
                            <SecretField
                                id="ai-totp"
                                label="Authenticator secret (optional)"
                                saved={data.signIn.hasTotpSecret}
                                state={secrets.totpSecret}
                                onChange={(s) => setSecret("totpSecret", s)}
                                canEdit={canEdit}
                                hint="Only if the login asks for a one-time code from an authenticator app. Paste the setup key (letters and digits) shown when the test account was enrolled. Codes sent by email or text message can’t be used."
                            />
                        </div>

                        <div className="stack-sm opt-group">
                            <div>
                                <div className="t-card">API access</div>
                                <p className="hint">Optional. Needed to test endpoints that require authorization. Use a token or OAuth2 client credentials.</p>
                            </div>
                            <SecretField id="ai-token" label="Bearer token" saved={data.apiAccess.hasToken} state={secrets.apiToken} onChange={(s) => setSecret("apiToken", s)} canEdit={canEdit} />
                            <Disclosure label="Use OAuth2 client credentials instead" defaultOpen={Boolean(o)}>
                                {removeOauth ? (
                                    <div className="row">
                                        <span className="t-secondary">The OAuth2 client credentials are removed when you save.</span>
                                        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setRemoveOauth(false)}>
                                            Undo
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="stack-sm">
                                        <div className="grid-2">
                                            <div className="field">
                                                <label htmlFor="ai-o-url">OAuth2 token URL</label>
                                                <input id="ai-o-url" className="input" type="url" value={oauth.tokenUrl} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, tokenUrl: e.target.value })} />
                                            </div>
                                            <div className="field">
                                                <label htmlFor="ai-o-scope">OAuth2 scope</label>
                                                <input id="ai-o-scope" className="input" value={oauth.scope} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, scope: e.target.value })} />
                                            </div>
                                            <div className="field">
                                                <label htmlFor="ai-o-id">OAuth2 client ID</label>
                                                <input id="ai-o-id" className="input" autoComplete="off" value={oauth.clientId} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, clientId: e.target.value })} />
                                            </div>
                                            <SecretField id="ai-o-secret" label="OAuth2 client secret" saved={Boolean(o?.hasClientSecret)} state={secrets.clientSecret} onChange={(s) => setSecret("clientSecret", s)} canEdit={canEdit} removable={false} />
                                        </div>
                                        {o && canEdit && (
                                            <div>
                                                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemoveOauth(true)}>
                                                    Remove the OAuth2 client credentials
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </Disclosure>
                        </div>

                        <div className="stack-sm opt-group">
                            <div className="field">
                                <label htmlFor="ai-oas">
                                    OpenAPI document URL {needs("openApiUrl").length > 0 && <Badge tone="warning">Needed</Badge>}
                                </label>
                                <p className="hint" id="ai-oas-hint">
                                    {needs("openApiUrl").length > 0 ? `The API documentation. The ${needs("openApiUrl").map((m) => m.agentName).join(" and the ")} cannot explore without it.` : "The API documentation. Found automatically if left empty."}
                                </p>
                                <input id="ai-oas" className="input" type="url" value={openApiUrl} disabled={!canEdit} aria-describedby="ai-oas-hint" placeholder="https://example.com/openapi.json" onChange={(e) => setOpenApiUrl(e.target.value)} />
                            </div>
                            <label className="check">
                                <input type="checkbox" checked={allowMutating} disabled={!canEdit} onChange={(e) => setAllowMutating(e.target.checked)} />
                                <span>
                                    <span className="title">Include API tests that change data</span>
                                    <span className="hint">Creates, updates and deletes records in the real application. Off by default; only enable on a test environment.</span>
                                </span>
                            </label>
                            {allowMutating && (
                                <label className="check">
                                    <input type="checkbox" checked={cleanupAfter} disabled={!canEdit} onChange={(e) => setCleanupAfter(e.target.checked)} />
                                    <span>
                                        <span className="title">Remove the records these tests create afterwards</span>
                                        <span className="hint">
                                            Only records a test created in that run are removed, and only where the application describes how to remove them.
                                            {!cleanupAfter && " Cleanup is off: the records the tests create will stay in the application."}
                                        </span>
                                    </span>
                                </label>
                            )}
                        </div>

                        <div className="stack-sm opt-group">
                            <div className="t-card">Requirements</div>
                            <p className="hint" data-testid="agent-inputs-requirements">
                                {data.requirements.active > 0
                                    ? `Exploring plans tests for the ${plural(data.requirements.active, "active requirement")} listed below.`
                                    : "Exploring plans tests for the active requirements listed below, when there are some."}{" "}
                                Add them one at a time, or use Import to bring them from a requirements document (.txt, .md, .pdf or .docx).
                            </p>
                        </div>
                    </div>

                    {error && <Callout tone="danger" title="We couldn’t save these">{error}</Callout>}
                    {justSaved && !error && <Callout tone="success">Saved. The next exploration uses these.</Callout>}
                    {canEdit ? (
                        <div className="row">
                            <Button variant="primary" icon={Save} loading={busy} onClick={() => void save()}>
                                {busy ? "Saving…" : "Save"}
                            </Button>
                            <span className="hint">Passwords, tokens and secrets are saved encrypted and never shown again.</span>
                        </div>
                    ) : (
                        data.application && <p className="t-meta">Only people who may change this project’s settings can change these.</p>
                    )}
                </div>
            )}
        </section>
    );
}

/** A write-only field: empty when nothing is saved; "Saved" with Replace and Remove when something is. */
function SecretField({ id, label, saved, state, onChange, canEdit, hint, removable = true }: { id: string; label: string; saved: boolean; state: SecretState; onChange: (s: Partial<SecretState>) => void; canEdit: boolean; hint?: string; removable?: boolean }) {
    const hintId = hint ? `${id}-hint` : undefined;
    const showInput = canEdit && (!saved || state.replacing) && !state.remove;
    return (
        <div className="field">
            <label htmlFor={showInput ? id : undefined} id={`${id}-label`}>
                {label}
            </label>
            {showInput ? (
                <div className="row" style={{ gap: 8 }}>
                    <input id={id} className="input" type="password" autoComplete="new-password" spellCheck={false} value={state.value} aria-describedby={hintId} onChange={(e) => onChange({ value: e.target.value })} style={{ flex: 1 }} />
                    {saved && (
                        <Button size="sm" variant="ghost" onClick={() => onChange({ replacing: false, value: "" })}>
                            Keep saved
                        </Button>
                    )}
                </div>
            ) : (
                <div className="row" style={{ gap: 8, minHeight: 36 }} role="group" aria-labelledby={`${id}-label`}>
                    {state.remove ? (
                        <>
                            <span className="t-secondary">Removed when you save</span>
                            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onChange({ remove: false })}>
                                Undo
                            </Button>
                        </>
                    ) : saved ? (
                        <>
                            <Badge tone="success" icon={KeyRound}>
                                Saved
                            </Badge>
                            {canEdit && (
                                <>
                                    <Button size="sm" onClick={() => onChange({ replacing: true })} aria-label={`Replace the ${label.replace(/ \(optional\)$/, "").toLowerCase()}`}>
                                        Replace
                                    </Button>
                                    {removable && (
                                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => onChange({ remove: true, value: "" })} aria-label={`Remove the ${label.replace(/ \(optional\)$/, "").toLowerCase()}`}>
                                            Remove
                                        </Button>
                                    )}
                                </>
                            )}
                        </>
                    ) : (
                        <span className="t-secondary">Not set</span>
                    )}
                </div>
            )}
            {hint && (
                <p id={hintId} className="hint">
                    {hint}
                </p>
            )}
        </div>
    );
}
