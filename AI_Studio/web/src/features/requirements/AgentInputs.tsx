import { useEffect, useRef, useState } from "react";
import { ChevronRight, KeyRound, RotateCcw, Save, Trash2 } from "lucide-react";
import { api } from "../../api";
import { Badge, Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { plural } from "../../lib/format";
import { routes, useRoute } from "../../lib/router";
import { useHere } from "../auth/project-access";

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
    /** "Keep page thumbnails" (Settings → General): never saved means on. */
    keepThumbnails?: boolean;
    cleanupAfter: boolean;
    requirements: { active: number };
    agents: { ids: string[]; names: string[]; source: "chosen" | "matched" } | null;
    missing: MissingInput[];
}

/** The Requirements tab with this card open and in view: where the pop-up before exploring and a failed API test's advice lead. */
export const agentInputsHref = (projectId: string): string => `${routes.requirements(projectId)}?inputs=open`;

/** What is saved for the main account, in one sentence (the card links to Settings → Sign-in to change it). */
export function signInLine(data: AgentInputs): string {
    const who = data.signIn.username ? `Signs in as ${data.signIn.username}${data.signIn.hasPassword ? "" : " (no password saved yet)"}.` : data.signIn.hasPassword ? "A sign-in is saved." : "No sign-in saved: the agents explore signed out.";
    const apiWords = data.apiAccess.hasToken ? " An API token is saved." : data.apiAccess.oauth2 ? " OAuth2 client credentials are saved." : "";
    return who + apiWords;
}

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

export interface SecretState {
    value: string;
    replacing: boolean;
    remove: boolean;
}
export const FRESH: SecretState = { value: "", replacing: false, remove: false };

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
    const can = useHere(projectId).may;
    const canEdit = can("ai_studio.project.settings") && data.application !== null;
    const [openApiUrl, setOpenApiUrl] = useState(data.openApiUrl ?? "");
    const [allowMutating, setAllowMutating] = useState(data.allowMutatingApiTests);
    const [cleanupAfter, setCleanupAfter] = useState(data.cleanupAfter);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
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
        try {
            await api(`/projects/${projectId}/agent-inputs`, {
                method: "PUT",
                // The sign-in and API access are edited in Settings → Sign-in: left out here, so they stay as they are.
                body: {
                    openApiUrl,
                    allowMutatingApiTests: allowMutating,
                    cleanupAfter,
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
                            What this project’s testing agents use when they explore: the API document and whether tests may change data, with the main account from Settings → Sign-in. Exploring uses what is saved here; nothing needs typing again on the Explore page.
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
                        <div className="stack-sm opt-group first" style={{ paddingTop: 0 }} data-testid="agent-inputs-sign-in">
                            <div className="t-card">Sign-in and API access</div>
                            <p className="hint">
                                {signInLine(data)} The agents use the project’s main account; change it, its API access and the other test accounts in{" "}
                                <a href={routes.projectSettings(projectId, "signin")}>Settings → Sign-in</a>.
                            </p>
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
                                    <span className="hint">API tests and browser tests then create, edit and delete records in the real application, filled with made-up data (names, emails on example.com, phone numbers) tagged with the run, so you can find them. Off by default; only enable on a test environment.</span>
                                </span>
                            </label>
                            {allowMutating && (
                                <label className="check">
                                    <input type="checkbox" checked={cleanupAfter} disabled={!canEdit} onChange={(e) => setCleanupAfter(e.target.checked)} />
                                    <span>
                                        <span className="title">Remove the records these tests create afterwards</span>
                                        <span className="hint">
                                            Only records a test created in that run are removed, and only where the application describes how to remove them. Anything left behind is listed with its tag.
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

/** A write-only field: empty when nothing is saved; "Saved" with Replace and Remove when something is (also the Settings → Sign-in card). */
export function SecretField({ id, label, saved, state, onChange, canEdit, hint, removable = true }: { id: string; label: string; saved: boolean; state: SecretState; onChange: (s: Partial<SecretState>) => void; canEdit: boolean; hint?: string; removable?: boolean }) {
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
