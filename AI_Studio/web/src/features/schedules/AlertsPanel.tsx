import { BellRing, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { EVENT_LABEL, EVENT_ORDER, type AlertChannel, type AlertEvent, type AlertLogEntry, type AlertOptions, type ChannelKind } from "./schedules";
import { BadgeKey } from "../../components/Tooltip";
import "./schedules.css";

// What the channel and delivery badges mean (platform/alerts.ts: a delivery is retried before it counts as not delivered).
const CHANNEL_ON = "Alerts go to this channel when one of its events happens.";
const CHANNEL_OFF = "Switched off: nothing is sent to this channel until it is turned on again.";
const DELIVERED = "The channel accepted the message.";
const NOT_DELIVERED = "The channel did not take the message; the reason is shown beside it.";

const KIND_NAME: Record<ChannelKind, string> = { slack: "Slack", webhook: "Webhook", teams: "Teams", email: "Email" };

/** Where to send alerts, and a log of what was sent. */
export function AlertsPanel({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
    const channels = useFetch<AlertChannel[]>(`/projects/${projectId}/alert-channels`);
    const log = useFetch<AlertLogEntry[]>(`/projects/${projectId}/alert-log?limit=15`);
    const [adding, setAdding] = useState(false);
    useEffect(() => {
        if (reloadKey > 0) {
            void channels.reload();
            void log.reload();
        }
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const reloadAll = async () => {
        await Promise.all([channels.reload(), log.reload()]);
    };

    return (
        <>
            <section className="card" aria-labelledby="alerts-title">
                <div className="card-head wrap">
                    <BellRing size={18} aria-hidden />
                    <h2 className="t-section" id="alerts-title">Alerts</h2>
                    {channels.data && <BadgeKey label="the channel states"entries={channels.data.map((c) => (c.enabled ? { word: "On", text: CHANNEL_ON } : { word: "Off", text: CHANNEL_OFF }))} />}
                    <span className="spacer" />
                    {channels.data && channels.data.length > 0 && !adding && (
                        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
                            Add a channel
                        </Button>
                    )}
                </div>
                {channels.loading ? (
                    <ListSkeleton rows={2} />
                ) : channels.error || !channels.data ? (
                    <div className="card-pad">
                        <ErrorState error={friendlyError(channels.error?.message)} onRetry={channels.reload} />
                    </div>
                ) : (
                    <>
                        {channels.data.length === 0 && !adding ? (
                            <EmptyState icon={BellRing} title="No alerts set up" actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add a channel</Button>}>
                                Get a message in Slack or Microsoft Teams, an email, or a call to any web address, when a run has failures, a test starts failing, or a failure is fixed.
                            </EmptyState>
                        ) : (
                            <ul className="list divided">
                                {channels.data.map((c) => (
                                    <li key={c.id}>
                                        <ChannelRow c={c} projectId={projectId} onChanged={reloadAll} />
                                    </li>
                                ))}
                            </ul>
                        )}
                        {adding && (
                            <NewChannelForm
                                projectId={projectId}
                                onCancel={() => setAdding(false)}
                                onCreated={() => {
                                    setAdding(false);
                                    void reloadAll();
                                }}
                            />
                        )}
                    </>
                )}
            </section>

            <section className="card" aria-labelledby="alert-log-title">
                <div className="card-head wrap">
                    <h2 className="t-section" id="alert-log-title">Recent alerts</h2>
                    {log.data && <BadgeKey label="the delivery results" entries={log.data.map((l) => (l.status === "sent" ? { word: "Delivered", text: DELIVERED } : { word: "Not delivered", text: NOT_DELIVERED }))} />}
                </div>
                {log.loading ? (
                    <ListSkeleton rows={2} />
                ) : log.error || !log.data ? (
                    <div className="card-pad">
                        <ErrorState error={friendlyError(log.error?.message)} onRetry={log.reload} />
                    </div>
                ) : log.data.length === 0 ? (
                    <p className="t-secondary" style={{ padding: "16px 20px" }}>Nothing has been sent yet.</p>
                ) : (
                    <ul className="list divided">
                        {log.data.map((l) => (
                            <li className="log-row" key={l.id}>
                                <span className="what">
                                    <strong>{l.event === "test" ? "Test message" : l.event.split(",").map((e) => EVENT_LABEL[e as AlertEvent]?.label ?? e).join(" · ")}</strong>
                                    <span className="muted"> → {l.channelName}</span>
                                    {l.summary && l.event !== "test" && <span className="t-meta" style={{ display: "block" }}>{l.summary}</span>}
                                    {l.status === "failed" && <span className="error-text" style={{ display: "block" }}>{l.error ?? "Not delivered"}{l.attempts > 1 ? ` (tried ${l.attempts} times)` : ""}</span>}
                                </span>
                                <span className="row" style={{ gap: 8 }}>
                                    <Badge tone={l.status === "sent" ? "success" : "danger"} tip={l.status === "sent" ? DELIVERED : NOT_DELIVERED}>{l.status === "sent" ? "Delivered" : "Not delivered"}</Badge>
                                    <span className="t-meta">{relativeTime(l.createdAt)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
}

function ChannelRow({ c, projectId, onChanged }: { c: AlertChannel; projectId: string; onChanged: () => Promise<void> }) {
    const [busy, setBusy] = useState<"test" | "toggle" | "delete" | null>(null);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const [confirm, setConfirm] = useState(false);

    async function act(kind: "test" | "toggle" | "delete") {
        setBusy(kind);
        setResult(null);
        try {
            const base = `/projects/${projectId}/alert-channels/${c.id}`;
            if (kind === "test") {
                const r = await api<{ ok: boolean; httpStatus: number | null; error: string | null }>(`${base}/test`, { method: "POST" });
                setResult(r.ok ? { ok: true, text: c.kind === "email" ? "Test email sent. Check the inbox of the people listed." : `Test message delivered (the receiver answered ${r.httpStatus}).` } : { ok: false, text: `Not delivered: ${(r.error ?? "unknown problem").replace(/\.$/, "")}.` });
            } else if (kind === "toggle") await api(base, { method: "PATCH", body: { enabled: !c.enabled } });
            else await api(base, { method: "DELETE" });
            await onChanged();
        } catch (e) {
            setResult({ ok: false, text: describeApiError(e) });
        } finally {
            setBusy(null);
            setConfirm(false);
        }
    }

    return (
        <div className="sched-row" data-channel={c.id}>
            <div className="row">
                <h3 className="t-card">{c.name}</h3>
                <Badge tone="neutral">{KIND_NAME[c.kind]}</Badge>
                <Badge tone={c.enabled ? "success" : "neutral"} tip={c.enabled ? CHANNEL_ON : CHANNEL_OFF}>{c.enabled ? "On" : "Off"}</Badge>
            </div>
            <div className="facts">
                <span>{c.kind === "email" ? "Emails" : "Sends to"} <b>{c.host}</b></span>
                {c.kind === "email" && (c.smtp ? <span>Mail server: <b>{c.smtp.host}</b>{c.smtp.source === "server" ? " (set up on the server)" : c.smtp.hasLogin ? " (own sign-in saved)" : ""}</span> : <span className="error-text">No mail server is set up for this channel</span>)}
                <span>When: <b>{EVENT_ORDER.filter((e) => c.events.includes(e)).map((e) => EVENT_LABEL[e].label.toLowerCase()).join(", ")}</b></span>
                {c.minSeverity && <span>Problems of <b>{c.minSeverity}</b> severity or higher</span>}
            </div>
            {result && <Callout tone={result.ok ? "success" : "danger"}>{result.text}</Callout>}
            <div className="acts">
                <Button size="sm" icon={Send} loading={busy === "test"} onClick={() => act("test")} aria-label={`Send a test message to ${c.name}`} tip={c.kind === "email" ? "Sends a sample email to the people listed, now." : "Sends a sample message to this channel now, so you can see how alerts look."}>
                    Send test
                </Button>
                <Button size="sm" variant="ghost" loading={busy === "toggle"} onClick={() => act("toggle")} aria-label={`${c.enabled ? "Turn off" : "Turn on"} ${c.name}`} tip={c.enabled ? "Stops sending alerts to it. The channel and its settings are kept." : "Alerts are sent to it again from the next run."}>
                    {c.enabled ? "Turn off" : "Turn on"}
                </Button>
                {confirm ? (
                    <>
                        <span className="t-secondary">Remove this channel?</span>
                        <Button size="sm" variant="danger" loading={busy === "delete"} onClick={() => act("delete")}>Yes, remove</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
                    </>
                ) : (
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)} aria-label={`Remove ${c.name}`}>
                        Remove
                    </Button>
                )}
            </div>
        </div>
    );
}

function NewChannelForm({ projectId, onCancel, onCreated }: { projectId: string; onCancel: () => void; onCreated: () => void }) {
    const [kind, setKind] = useState<ChannelKind>("slack");
    const [url, setUrl] = useState("");
    const options = useFetch<AlertOptions>(`/projects/${projectId}/alert-options`);
    const serverMail = options.data?.email.serverMail ?? null;
    const [recipients, setRecipients] = useState("");
    const [ownMail, setOwnMail] = useState(false);
    const [mail, setMail] = useState({ host: "", port: "587", secure: false, from: "", username: "", password: "" });
    const setMailField = (patch: Partial<typeof mail>) => setMail((m) => ({ ...m, ...patch }));
    // Without mail settings on the server the channel needs its own.
    const useOwnMail = ownMail || (options.data !== undefined && !serverMail);
    const [name, setName] = useState("");
    const [events, setEvents] = useState<AlertEvent[]>(["regression", "run_failed", "flaky", "recovered"]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function create() {
        setBusy(true);
        setError("");
        try {
            const named = name.trim() ? { name: name.trim() } : {};
            if (kind === "email") {
                const list = recipients.split(/[\s,;]+/).filter(Boolean);
                const smtp = useOwnMail ? { host: mail.host.trim(), port: Number(mail.port) || 587, secure: mail.secure, from: mail.from.trim(), ...(mail.username ? { username: mail.username } : {}), ...(mail.password ? { password: mail.password } : {}) } : undefined;
                await api(`/projects/${projectId}/alert-channels`, { method: "POST", body: { kind, recipients: list, ...(smtp ? { smtp } : {}), events, ...named } });
            } else {
                await api(`/projects/${projectId}/alert-channels`, { method: "POST", body: { kind, url: url.trim(), events, ...named } });
            }
            onCreated();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <form
            className="sched-form"
            aria-label="Add an alert channel"
            onSubmit={(e) => {
                e.preventDefault();
                void create();
            }}
        >
            <div className="field">
                <label htmlFor="ch-kind">Send alerts to</label>
                <select id="ch-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)}>
                    <option value="slack">Slack (incoming webhook)</option>
                    <option value="teams">Microsoft Teams (workflow webhook)</option>
                    <option value="email">Email</option>
                    <option value="webhook">Any web address (JSON webhook)</option>
                </select>
            </div>
            {kind === "email" ? (
                <>
                    <div className="field">
                        <label htmlFor="ch-to">Email addresses</label>
                        <input id="ch-to" className="input" type="text" required autoComplete="off" placeholder="qa@example.com, lead@example.com" value={recipients} onChange={(e) => setRecipients(e.target.value)} />
                        <p className="hint">Up to 10, separated by commas.</p>
                    </div>
                    {serverMail && (
                        <label className="check">
                            <input type="checkbox" checked={ownMail} onChange={(e) => setOwnMail(e.target.checked)} />
                            <span>
                                <span className="title">Use a different mail server for this channel</span>
                                <span className="hint">Otherwise mail is sent through {serverMail.host}, which is set up on the server.</span>
                            </span>
                        </label>
                    )}
                    {useOwnMail && (
                        <fieldset className="events-pick">
                            <legend>Mail server</legend>
                            <div className="inline">
                                <div className="field">
                                    <label htmlFor="ch-host">Server</label>
                                    <input id="ch-host" className="input" required autoComplete="off" placeholder="smtp.example.com" value={mail.host} onChange={(e) => setMailField({ host: e.target.value })} />
                                </div>
                                <div className="field">
                                    <label htmlFor="ch-port">Port</label>
                                    <input id="ch-port" className="input num" type="number" min={1} max={65535} required value={mail.port} onChange={(e) => setMailField({ port: e.target.value })} />
                                </div>
                            </div>
                            <label className="check">
                                <input type="checkbox" checked={mail.secure} onChange={(e) => setMailField({ secure: e.target.checked })} />
                                <span>
                                    <span className="title">Secure connection from the start</span>
                                    <span className="hint">Usually for port 465. Otherwise the connection is upgraded when the server offers it.</span>
                                </span>
                            </label>
                            <div className="field">
                                <label htmlFor="ch-from">Send from</label>
                                <input id="ch-from" className="input" type="email" required autoComplete="off" placeholder="alerts@example.com" value={mail.from} onChange={(e) => setMailField({ from: e.target.value })} />
                            </div>
                            <div className="field">
                                <label htmlFor="ch-user">User name (optional)</label>
                                <input id="ch-user" className="input" autoComplete="off" value={mail.username} onChange={(e) => setMailField({ username: e.target.value })} />
                            </div>
                            <div className="field">
                                <label htmlFor="ch-pass">Password (optional)</label>
                                <input id="ch-pass" className="input" type="password" autoComplete="new-password" value={mail.password} onChange={(e) => setMailField({ password: e.target.value })} />
                                <p className="hint">The user name and password are stored encrypted and are never shown again.</p>
                            </div>
                        </fieldset>
                    )}
                    {options.data && !serverMail && <p className="hint">This server has no mail settings of its own, so the channel needs its own.</p>}
                </>
            ) : (
                <div className="field">
                    <label htmlFor="ch-url">{kind === "slack" ? "Slack webhook URL" : kind === "teams" ? "Teams workflow URL" : "Webhook URL"}</label>
                    <input id="ch-url" className="input" type="url" required autoComplete="off" placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : kind === "teams" ? "https://prod-00.westus.logic.azure.com/workflows/…" : "https://example.com/hooks/tests"} value={url} onChange={(e) => setUrl(e.target.value)} />
                    <p className="hint">{kind === "teams" ? "Create a workflow in Teams that posts to a channel when a webhook request arrives, and paste its URL. " : ""}The address is stored encrypted and is never shown again, only its host name is.</p>
                </div>
            )}
            <div className="field">
                <label htmlFor="ch-name">Name (optional)</label>
                <input id="ch-name" className="input" maxLength={80} placeholder="e.g. #qa-alerts" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <fieldset className="events-pick">
                <legend>Tell me when</legend>
                {EVENT_ORDER.map((e) => (
                    <label className="check" key={e}>
                        <input
                            type="checkbox"
                            checked={events.includes(e)}
                            onChange={(ev) => setEvents((cur) => (ev.target.checked ? [...cur, e] : cur.filter((x) => x !== e)))}
                        />
                        <span>
                            <span className="title">{EVENT_LABEL[e].label}</span>
                            <span className="hint">{EVENT_LABEL[e].help}</span>
                        </span>
                    </label>
                ))}
            </fieldset>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={(kind === "email" ? !recipients.trim() || (useOwnMail && (!mail.host.trim() || !mail.from.trim())) : !url.trim()) || events.length === 0}>Add channel</Button>
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
}
