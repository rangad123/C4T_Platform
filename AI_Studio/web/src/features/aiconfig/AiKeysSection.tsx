import { CircleCheck, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { friendlyError } from "../../lib/labels";
import { FALLBACK_PROVIDERS, KIND_WORDS, NO_AI_KEY, OPEN_SERVER_NO_KEY, reloadMyAi, useMyAi, type AiProviderChoice, type KeyView } from "./aiconfig";
import { ConfigurationForm } from "./ConfigurationForm";
import { KeyStatus } from "./KeyStatus";

const fail = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** One key in the person's list: its state, "Use this key", and for their own keys Change and Remove. */
function KeyRow({ k, providers }: { k: KeyView; providers: AiProviderChoice[] }) {
    const own = k.kind === "personal";
    const [editing, setEditing] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const choose = async () => {
        setBusy(true);
        setError("");
        try {
            await api("/me/ai/chosen", { method: "PUT", body: { keyId: k.id } });
            await reloadMyAi();
        } catch (e) {
            setError(fail(e, "That key was not chosen. Try again."));
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        setBusy(true);
        setError("");
        try {
            await api(`/me/ai/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
            setConfirming(false);
            await reloadMyAi();
        } catch (e) {
            setError(fail(e, "The key was not removed. Try again."));
            setBusy(false);
        }
    };
    return (
        <li className="stack-sm ai-key-row" data-testid="ai-key" data-key={k.id} data-kind={k.kind} data-chosen={k.chosen ? "true" : "false"}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <strong>{k.label}</strong>
                <Badge tone={own ? "neutral" : "brand"} tip={KIND_WORDS[k.kind].tip}>
                    {KIND_WORDS[k.kind].label}
                </Badge>
                {k.chosen && (
                    <Badge tone="success" icon={CircleCheck} tip="All the AI work you start, in any project, uses this key.">
                        In use
                    </Badge>
                )}
                <span className="spacer" />
                {!k.chosen && (
                    <Button size="sm" variant="secondary" loading={busy && !confirming} onClick={() => void choose()} aria-label={`Use ${k.label} for my AI work`}>
                        Use this key
                    </Button>
                )}
                {own && (
                    <>
                        <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(!editing)} aria-label={`Change ${k.label}`}>
                            Change
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirming(true)} aria-label={`Remove ${k.label}…`}>
                            Remove
                        </Button>
                    </>
                )}
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            {confirming && (
                <Callout
                    tone="warning"
                    title={`Remove ${k.label}?`}
                    actions={
                        <>
                            <Button size="sm" onClick={() => setConfirming(false)} disabled={busy}>
                                Keep it
                            </Button>
                            <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()} aria-label={`Remove ${k.label}`}>
                                Remove
                            </Button>
                        </>
                    }
                >
                    The key is deleted and cannot be read back.{k.chosen ? " Your AI work stops until you choose another key." : ""}
                </Callout>
            )}
            <KeyStatus keyView={k} testPath={`/me/ai/keys/${encodeURIComponent(k.id)}/test`} onTested={reloadMyAi} />
            {editing && own && (
                <ConfigurationForm
                    idPrefix={`ai-key-${k.id}`}
                    providers={providers}
                    current={k}
                    path={`/me/ai/keys/${encodeURIComponent(k.id)}`}
                    onCancel={() => setEditing(false)}
                    onSaved={async () => {
                        setEditing(false);
                        await reloadMyAi();
                    }}
                />
            )}
        </li>
    );
}

/**
 * Settings, "AI keys": the key all of this person's AI work uses, their own keys and the organisational keys an admin assigned to them.
 * Nobody else's personal key is ever here, and an organisational key appears only when it is assigned to this person.
 */
export function AiKeysSection() {
    const me = useMyAi();
    const [adding, setAdding] = useState(false);
    const data = me.data;
    const scrolled = useRef(false);
    // `#/settings#ai-keys` (where every "no AI key" notice links): bring the section into view once it has content.
    useEffect(() => {
        if (scrolled.current || !data) return;
        if (/#ai-keys\b/.test(location.hash)) {
            scrolled.current = true;
            document.getElementById("ai-keys")?.scrollIntoView({ block: "start" });
        }
    }, [data]);
    const providers = data?.providers?.length ? data.providers : FALLBACK_PROVIDERS;
    const keys = data ? [...data.personal, ...data.organisational] : [];
    const ready = data ? (data.openServer ? data.openServer.configured : Boolean(data.chosen) && !data.problem) : undefined;
    // The server does not answer for this account (it may not use AI here): nothing to show, and nothing to set up.
    if (!data && me.error instanceof ApiError && me.error.status === 403) return null;
    return (
        <section className="card card-pad stack-sm" id="ai-keys" data-testid="ai-keys" aria-labelledby="ai-keys-title" data-state={!data ? "loading" : ready ? "ready" : "no-key"}>
            <div className="row">
                <KeyRound size={18} aria-hidden />
                <h2 className="t-section" id="ai-keys-title">
                    AI keys
                </h2>
                <span className="spacer" />
                {data && (
                    <Badge tone={ready ? "success" : "warning"} tip={ready ? "Your AI work can start." : "Your AI work cannot start until you have a key."}>
                        {ready ? "Connected" : "Not set up"}
                    </Badge>
                )}
            </div>
            <p className="t-secondary">All the AI work you start, in any project, uses the one key you choose here. Your own keys are only yours; organisational keys are assigned by an admin.</p>
            {me.loading && !data ? (
                <ListSkeleton rows={2} />
            ) : me.error && !data ? (
                <ErrorState error={friendlyError(me.error.message)} onRetry={() => void me.reload()} />
            ) : data ? (
                <>
                    {data.openServer ? (
                        <p className="t-secondary" data-testid="ai-open-server">
                            {data.openServer.configured ? (
                                <>
                                    This server uses its own key: <span className="mono">{data.openServer.model}</span>.
                                </>
                            ) : (
                                OPEN_SERVER_NO_KEY
                            )}
                        </p>
                    ) : data.chosen && !data.problem ? (
                        <>
                            <p className="t-secondary" data-testid="ai-chosen">
                                Your AI work uses <strong>{data.chosen.label}</strong> ({data.chosen.providerWords}, <span className="mono">{data.chosen.model}</span>).
                            </p>
                            {/* A failed last test warns; the work still starts, as the server lets it (the provider may have been busy). */}
                            {data.chosen.status === "failed" && (
                                <Callout tone="warning" title="Your key failed its last test">
                                    <span data-testid="ai-chosen-warning">AI work still starts with it. Test it again below, or choose another key.</span>
                                </Callout>
                            )}
                        </>
                    ) : (
                        <Callout tone="warning" title="Your AI work can’t start">
                            <span data-testid="ai-problem">{data.problem ?? NO_AI_KEY}</span>
                        </Callout>
                    )}
                    {keys.length > 0 ? (
                        <ul className="ai-key-list" aria-label="Your AI keys">
                            {keys.map((k) => (
                                <KeyRow key={k.id} k={k} providers={providers} />
                            ))}
                        </ul>
                    ) : (
                        !data.openServer && <p className="t-secondary">You have no keys yet.</p>
                    )}
                    {adding ? (
                        <ConfigurationForm
                            idPrefix="ai-key-new"
                            providers={providers}
                            path="/me/ai/keys"
                            onCancel={() => setAdding(false)}
                            onSaved={async () => {
                                setAdding(false);
                                // The server makes a person's first key their chosen one.
                                await reloadMyAi();
                            }}
                        />
                    ) : (
                        <div>
                            <Button icon={Plus} onClick={() => setAdding(true)}>
                                Add your own key
                            </Button>
                        </div>
                    )}
                </>
            ) : null}
        </section>
    );
}
