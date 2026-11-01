import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { agentCommand, type AgentToken } from "./agents";
import "./agents.css";
import { BadgeKey, Tooltip } from "../../components/Tooltip";

// A runner token's state (agent-store.ts: revoking sets revoked_at, and a revoked token is no longer accepted).
const TOKEN_ACTIVE = "A runner started with this token can connect to this project.";
const TOKEN_REVOKED = "This token no longer lets a runner connect; a runner that used it must get a new one.";

/**
 * Tokens let a runner agent connect to this project. The secret is shown once, straight after it is made, and lives only in
 * this component's state: it is never written to storage, the address bar or the console, and it is dropped when the notice is closed.
 */
export function TokensPanel({ projectId, maxRunners = 1, onChanged }: { projectId: string; maxRunners?: number; onChanged?: () => void }) {
    const list = useFetch<AgentToken[]>(`/projects/${projectId}/agent-tokens`);
    const [fresh, setFresh] = useState<{ secret: string; label: string | null } | null>(null);
    const [revoking, setRevoking] = useState<AgentToken | null>(null);
    const tokens = list.data ?? [];
    // One runner per project by default: once an active token exists, making another is refused, so offer removal instead of a second form.
    const atLimit = tokens.filter((t) => !t.revokedAt).length >= maxRunners;

    return (
        <section className="card" aria-labelledby="ag-tokens-title">
            <div className="card-head wrap">
                <KeyRound size={18} aria-hidden />
                <h2 className="t-section" id="ag-tokens-title">Create a token</h2>
            </div>
            <div className="ag-body">
                <p className="t-secondary">A token lets one runner connect to this project.{maxRunners === 1 ? " A project uses a single runner." : ` This project can have up to ${maxRunners} runners.`}</p>
                {atLimit ? (
                    <p className="t-meta" data-testid="token-limit-note">{maxRunners === 1 ? "This project already has a runner. Remove it below to create a token for a different one." : `This project already has ${maxRunners} runners. Remove one below to create another token.`}</p>
                ) : (
                    <NewTokenForm
                        projectId={projectId}
                        onCreated={(secret, label) => {
                            setFresh({ secret, label });
                            void list.reload();
                        }}
                    />
                )}
                {fresh && <FreshToken secret={fresh.secret} label={fresh.label} onDone={() => setFresh(null)} />}
                {!fresh && !atLimit && <CommandBlock />}
                <p className="hint">
                    The computer needs Node, a checkout of the platform (or the packaged runner) and, to test Android phones, Android’s <code>adb</code>. The runner connects out to this address; nothing connects in.
                </p>
            </div>
            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error || !list.data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                </div>
            ) : tokens.length > 0 ? (
                <>
                <p className="t-meta ag-pad">
                    Tokens of this project{" "}
                    <BadgeKey label="the token states"entries={tokens.map((t) => (t.revokedAt ? { word: "Revoked", text: TOKEN_REVOKED } : { word: "Active", text: TOKEN_ACTIVE }))} />
                </p>
                <ul className="list divided ag-tokens" aria-label="Tokens">
                    {tokens.map((t) => (
                        <li key={t.id}>
                            <TokenRow t={t} onRevoke={() => setRevoking(t)} />
                        </li>
                    ))}
                </ul>
                </>
            ) : (
                <p className="t-meta ag-pad">No tokens yet. The first one you make appears here.</p>
            )}
            {revoking && (
                <RevokeDialog
                    projectId={projectId}
                    token={revoking}
                    onClose={() => setRevoking(null)}
                    onDone={() => {
                        setRevoking(null);
                        void list.reload();
                        onChanged?.();
                    }}
                />
            )}
        </section>
    );
}

function NewTokenForm({ projectId, onCreated }: { projectId: string; onCreated: (secret: string, label: string | null) => void }) {
    const [label, setLabel] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function create() {
        setBusy(true);
        setError("");
        try {
            const out = await api<{ token: AgentToken; secret: string }>(`/projects/${projectId}/agent-tokens`, { method: "POST", body: label.trim() ? { label: label.trim() } : {} });
            onCreated(out.secret, out.token.label);
            setLabel("");
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            className="ag-form"
            aria-label="New runner token"
            onSubmit={(e) => {
                e.preventDefault();
                void create();
            }}
        >
            <div className="field ag-grow">
                <label htmlFor="ag-label">Name (optional)</label>
                <input id="ag-label" className="input" value={label} maxLength={60} autoComplete="off" placeholder="For example: Maya’s laptop" onChange={(e) => setLabel(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" icon={Plus} loading={busy}>
                Create token
            </Button>
            {error && (
                <div className="ag-full">
                    <Callout tone="danger">{error}</Callout>
                </div>
            )}
        </form>
    );
}

function useCopy(text: string) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<number>();
    useEffect(() => () => clearTimeout(timer.current), []);
    async function copy() {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 2500);
        } catch {
            setCopied(false); // clipboard blocked: the text is selectable on screen
        }
    }
    return { copied, copy };
}

/** The command with `<your token>`, for before a token exists or after the notice was closed. */
function CommandBlock({ token }: { token?: string }) {
    const command = agentCommand(window.location.origin, token);
    const { copied, copy } = useCopy(command);
    return (
        <div className="stack-sm">
            <p className="t-secondary">Run this on the computer, in the platform folder{token ? "" : ", with your token in place of the placeholder"}.</p>
            <div className="code-wrap">
                <div className="code-bar">
                    <span>Command</span>
                    <span className="spacer" />
                    <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy}>
                        {copied ? "Copied" : "Copy command"}
                    </Button>
                </div>
                <pre className="code ag-command" tabIndex={0} aria-label="Command to start a runner">
                    <code data-testid="agent-command">{command}</code>
                </pre>
            </div>
        </div>
    );
}

export function FreshToken({ secret, label, onDone, who = "this project" }: { secret: string; label: string | null; onDone: () => void; who?: string }) {
    const { copied, copy } = useCopy(secret);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // Keyboard users land on the notice, so the one-time secret is not missed.
        box.current?.focus();
    }, []);
    return (
        <div className="ag-fresh" role="region" aria-label="Your new token" ref={box} tabIndex={-1}>
            <Callout tone="warning" title={`Copy the token${label ? ` for “${label}”` : ""} now`}>
                We show this only once. Anyone with it can run tests as {who}. Revoke it if it leaks.
            </Callout>
            <div className="ag-secret">
                <textarea className="input ag-mono" readOnly rows={2} value={secret} aria-label="New token" data-testid="new-token" onFocus={(e) => e.currentTarget.select()} />
                <Button icon={copied ? Check : Copy} onClick={copy}>
                    {copied ? "Copied" : "Copy token"}
                </Button>
            </div>
            <CommandBlock token={secret} />
            <div className="row">
                <Button variant="primary" onClick={onDone}>
                    I have copied it
                </Button>
            </div>
        </div>
    );
}

function TokenRow({ t, onRevoke }: { t: AgentToken; onRevoke: () => void }) {
    const name = t.label ?? "Unnamed token";
    const revoked = !!t.revokedAt;
    return (
        <div className={`ag-token ${revoked ? "is-revoked" : ""}`} data-token={t.id}>
            <div className="row">
                <h3 className="t-card">{name}</h3>
                <Tooltip content="The last 4 characters of the token, to tell them apart. The whole token was shown only once.">
                                            <code className="ag-hint" tabIndex={0}>{t.hint}</code>
                                        </Tooltip>
                <Badge tone={revoked ? "neutral" : "success"} tip={revoked ? TOKEN_REVOKED : TOKEN_ACTIVE}>{revoked ? "Revoked" : "Active"}</Badge>
            </div>
            <div className="ag-facts">
                <span>
                    Created <b>{relativeTime(t.createdAt)}</b>
                </span>
                <span>
                    Last used <b>{t.lastUsedAt ? relativeTime(t.lastUsedAt) : "never"}</b>
                </span>
                {revoked && (
                    <span>
                        Revoked <b>{relativeTime(t.revokedAt)}</b>
                    </span>
                )}
            </div>
            {!revoked && (
                <div>
                    <Button size="sm" variant="danger" onClick={onRevoke} aria-label={`Revoke token: ${name}`}>
                        Revoke
                    </Button>
                </div>
            )}
        </div>
    );
}

/** A real modal dialog: keyboard stays inside, Escape closes it. */
function RevokeDialog({ projectId, token, onClose, onDone }: { projectId: string; token: AgentToken; onClose: () => void; onDone: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        d?.querySelector<HTMLButtonElement>("button")?.focus(); // the safe choice (keep) comes first
    }, []);

    async function revoke() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/agent-tokens/${token.id}`, { method: "DELETE" });
            onDone();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <dialog ref={ref} className="ag-dialog" aria-labelledby="ag-revoke-title" onClose={onClose} onCancel={onClose}>
            <div className="inner">
                <div className="stack-sm">
                    <h2 className="t-section" id="ag-revoke-title">
                        Revoke this token?
                    </h2>
                    <p className="t-secondary">
                        {token.label ?? "Unnamed token"} <code className="ag-hint">{token.hint}</code>
                    </p>
                </div>
                <p className="t-secondary">Any runner using it is turned away at its next request and stops taking tests. This cannot be undone. You can make a new token at any time.</p>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button onClick={onClose}>
                        Keep token
                    </Button>
                    <Button variant="danger" loading={busy} onClick={revoke}>
                        Revoke token
                    </Button>
                </div>
            </div>
        </dialog>
    );
}
