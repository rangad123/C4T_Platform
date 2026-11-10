import { CircleCheck, CircleX, Plug, Radar, Trash2 } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { Button, Callout, Disclosure, Skeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { useHere } from "../auth/project-access";
import { describeApiError } from "../../lib/labels";
import type { SentryConnectionAnswer } from "./sentry";
import "./sentry.css";

/** Validation problems from the server, as sentences. */
function connectError(e: unknown): string {
    if (e instanceof ApiError && e.status === 400 && Array.isArray(e.details)) {
        const msgs = (e.details as Array<{ message?: string }>).map((d) => d.message).filter(Boolean);
        if (msgs.length) return msgs.join(" ");
    }
    return describeApiError(e);
}

const host = (url: string) => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

/**
 * Connect Sentry to a project (read-only): shown inside the issue tracker panel, because it is set up in the same place,
 * but it is not a tracker and never offers to create issues.
 */
export function SentryConnect({ projectId }: { projectId: string }) {
    const conn = useFetch<SentryConnectionAnswer>(`/projects/${projectId}/sentry`);
    const [adding, setAdding] = useState(false);
    const current = conn.data?.connected ? conn.data.connection : undefined;
    // The Sentry token is another system's credential: connecting, testing and disconnecting need ai_studio.ai_keys.manage here.
    const noManage = useHere(projectId).why("ai_studio.ai_keys.manage");

    return (
        <section className="stack-sm sentry-connect" aria-label="Sentry">
            <div className="row">
                <Radar size={17} aria-hidden />
                <h3 className="t-section">Sentry</h3>
            </div>
            <p className="t-secondary">Show errors that Sentry saw around the time a test failed, on that test’s page. Sentry is only read, never changed, and it is not used to create issues.</p>
            {conn.loading ? (
                <Skeleton h={40} />
            ) : conn.error ? (
                <Callout tone="danger" title="We couldn’t load the Sentry connection" actions={<Button size="sm" onClick={() => void conn.reload()}>Try again</Button>}>
                    {describeApiError(conn.error)}
                </Callout>
            ) : adding && !noManage ? (
                <SentryForm
                    projectId={projectId}
                    current={current}
                    onDone={() => {
                        setAdding(false);
                        void conn.reload();
                    }}
                    onCancel={() => setAdding(false)}
                />
            ) : current ? (
                <Connected projectId={projectId} name={current.name} where={`${current.organization}/${current.project} on ${host(current.baseUrl)}`} onChange={() => setAdding(true)} onRemoved={() => void conn.reload()} mayManage={!noManage} />
            ) : (
                <div className="row">
                    <Button icon={Plug} disabled={Boolean(noManage)} tip={noManage} onClick={() => setAdding(true)}>
                        Connect Sentry
                    </Button>
                </div>
            )}
        </section>
    );
}

function Connected({ projectId, name, where, onChange, onRemoved, mayManage }: { projectId: string; name: string; where: string; onChange: () => void; onRemoved: () => void; mayManage: boolean }) {
    const [state, setState] = useState<{ kind: "idle" } | { kind: "testing" } | { kind: "ok" | "bad"; text: string }>({ kind: "idle" });
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function test() {
        setState({ kind: "testing" });
        try {
            const r = await api<{ ok: boolean; message: string }>(`/projects/${projectId}/sentry/test`, { method: "POST" });
            setState({ kind: r.ok ? "ok" : "bad", text: r.message });
        } catch (e) {
            setState({ kind: "bad", text: describeApiError(e) });
        }
    }
    async function remove() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/sentry`, { method: "DELETE" });
            onRemoved();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <div className="list-row" style={{ alignItems: "flex-start", padding: 0 }}>
            <span className="main">
                <span className="title">{name}</span>
                <span className="meta">{where}</span>
                {state.kind === "ok" && (
                    <span className="meta" role="status" style={{ color: "var(--status-success-fg)" }}>
                        <CircleCheck size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> {state.text}
                    </span>
                )}
                {state.kind === "bad" && (
                    <span className="meta" role="alert" style={{ color: "var(--status-error-fg)" }}>
                        <CircleX size={13} aria-hidden style={{ verticalAlign: "-2px" }} /> {state.text}
                    </span>
                )}
                {error && (
                    <span className="meta" role="alert" style={{ color: "var(--status-error-fg)" }}>
                        {error}
                    </span>
                )}
                {confirm && <span className="meta">Disconnect Sentry from this project? Your tests are not affected.</span>}
            </span>
            {mayManage && <span className="tail">
                {confirm ? (
                    <>
                        <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>
                            Yes, disconnect
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                            Keep
                        </Button>
                    </>
                ) : (
                    <>
                        <Button size="sm" loading={state.kind === "testing"} onClick={() => void test()}>
                            Test Sentry connection
                        </Button>
                        <Button size="sm" variant="ghost" onClick={onChange}>
                            Change
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Disconnect ${name}`} onClick={() => setConfirm(true)}>
                            Disconnect
                        </Button>
                    </>
                )}
            </span>}
        </div>
    );
}

function SentryForm({ projectId, current, onDone, onCancel }: { projectId: string; current?: { organization: string; project: string; baseUrl: string }; onDone: () => void; onCancel: () => void }) {
    const [f, setF] = useState({ organization: current?.organization ?? "", project: current?.project ?? "", token: "", baseUrl: current && host(current.baseUrl) !== "sentry.io" ? current.baseUrl : "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
        setF((s) => ({ ...s, [k]: e.target.value }));
        setError("");
    };
    // Changing an existing connection may leave the token empty: the stored one is kept.
    const ready = Boolean(f.organization.trim() && f.project.trim() && (f.token.trim() || current));

    async function connect(e: React.FormEvent) {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
            // The server checks the names and the token with a real call before saving anything.
            await api(`/projects/${projectId}/sentry`, {
                method: "PUT",
                body: { organization: f.organization.trim(), project: f.project.trim(), ...(f.token.trim() ? { token: f.token.trim() } : {}), ...(f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim() } : {}) },
            });
            onDone();
        } catch (err) {
            setError(connectError(err));
            setBusy(false);
        }
    }

    return (
        <form className="stack-sm" onSubmit={connect} aria-label="Connect Sentry">
            <div className="grid-2">
                <div className="field">
                    <label htmlFor="sentry-org">Sentry organisation</label>
                    <input id="sentry-org" className="input" value={f.organization} placeholder="acme" autoComplete="off" onChange={set("organization")} />
                </div>
                <div className="field">
                    <label htmlFor="sentry-project">Sentry project</label>
                    <input id="sentry-project" className="input" value={f.project} placeholder="shop-web" autoComplete="off" onChange={set("project")} />
                </div>
            </div>
            <p className="t-meta">Both are the short names in your Sentry address, for example sentry.io/organizations/acme/projects/shop-web.</p>
            <div className="field">
                <label htmlFor="sentry-token">Sentry auth token</label>
                <input id="sentry-token" className="input" type="password" value={f.token} autoComplete="off" placeholder={current ? "Leave empty to keep the current token" : ""} onChange={set("token")} />
                <p className="t-meta">A token that can only read issues is enough. It is stored encrypted and is never shown again.</p>
            </div>
            <Disclosure label="Self-hosted Sentry">
                <div className="field">
                    <label htmlFor="sentry-base">Sentry address</label>
                    <input id="sentry-base" className="input" value={f.baseUrl} placeholder="https://sentry.example.com" autoComplete="off" onChange={set("baseUrl")} />
                    <p className="t-meta">Only if your company hosts its own Sentry. Leave empty for sentry.io.</p>
                </div>
            </Disclosure>
            {error && (
                <Callout tone="danger" title="We couldn’t connect Sentry">
                    {error}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={busy || !ready}>
                    {busy ? "Checking…" : "Save Sentry connection"}
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
