import { BellRing, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, Skeleton, toneIcon } from "../../components/ui";
import { BadgeKey, HelpTip, keyEntries } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { NOTIFY_REASON } from "../../lib/help";
import { friendlyError, describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { SecurityLayout, canRun, useRole } from "./SecurityChrome";
import { SEC, when } from "./security";

/**
 * Messages when an assessment ends (OPS: src/security/notify.ts, routes/notifications.ts). They go through the project's own alert
 * channels (email, Slack, Microsoft Teams, webhooks), which are set up under Settings, Alerts; this page only says when and to which.
 *   GET /api/v1/security/projects/:id/notifications   { settings, saved, defaults, channels, recent }
 *   PUT  same, body { newCriticalHigh?, failed?, everyFinish?, channelIds? }
 */
export interface NotifySettings {
    newCriticalHigh: boolean;
    failed: boolean;
    everyFinish: boolean;
    /** null = every enabled alert channel of the project. */
    channelIds: string[] | null;
}
interface NotifyAnswer {
    settings: NotifySettings;
    saved?: boolean;
    defaults?: NotifySettings;
    channels?: Array<{ id: string; name: string; kind: string; enabled: boolean; selected?: boolean }>;
    recent?: Array<{ at: string; channelName: string; channelKind: string; status: string; reasons?: string[]; error?: string | null; summary?: string | null }>;
}

const SWITCHES: Array<{ key: "newCriticalHigh" | "failed" | "everyFinish"; title: string; hint: string }> = [
    { key: "newCriticalHigh", title: "New critical or high findings", hint: "When an assessment finds critical or high findings that were not known before, or sees again one that was marked fixed (it came back)." },
    { key: "failed", title: "An assessment fails", hint: "When an assessment stops with a problem (Did not finish). A stopped assessment or one finished with gaps does not send this." },
    { key: "everyFinish", title: "Every assessment that ends", hint: "Whenever one ends: finished, finished with gaps, did not finish, or stopped." },
];
const REASON_WORDS: Record<keyof typeof NOTIFY_REASON, string> & Record<string, string | undefined> = { "new-critical-high": "new critical or high findings", "reopened-critical-high": "critical or high findings came back", failed: "it failed", finished: "it ended" };
const KIND_WORDS: Record<string, string> = { email: "Email", slack: "Slack", teams: "Microsoft Teams", webhook: "Webhook" };

export function NotificationsPage({ id }: { id: string }) {
    const role = useRole();
    const editable = canRun(role);
    const f = useFetch<NotifyAnswer>(`${SEC}/projects/${id}/notifications`);
    const [draft, setDraft] = useState<NotifySettings>();
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [saved, setSaved] = useState("");
    useEffect(() => {
        if (f.data?.settings) setDraft({ ...f.data.settings });
    }, [f.data]);

    const channels = f.data?.channels ?? [];
    const enabledChannels = channels.filter((c) => c.enabled);
    const changed = !!draft && !!f.data && JSON.stringify(draft) !== JSON.stringify(f.data.settings);
    const picked = (cid: string) => draft?.channelIds === null || !!draft?.channelIds?.includes(cid);
    const nothingSelected = !!draft && (draft.newCriticalHigh || draft.failed || draft.everyFinish) && (draft.channelIds === null ? enabledChannels.length === 0 : !draft.channelIds.some((c) => enabledChannels.some((e) => e.id === c)));

    async function save() {
        if (!draft) return;
        setBusy(true);
        setProblem("");
        setSaved("");
        try {
            await api<NotifyAnswer>(`${SEC}/projects/${id}/notifications`, { method: "PUT", body: draft });
            await f.reload();
            setSaved("Saved. The next assessment that ends uses these settings.");
        } catch (e) {
            setProblem(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    const content = () => {
        if (f.loading && !f.data) return <Skeleton h={260} style={{ borderRadius: 12 }} />;
        if (f.error || !f.data || !draft) return <ErrorState error={friendlyError(f.error?.message ?? "The notification settings could not be read")} onRetry={f.reload} />;
        return (
            <div className="stack" style={{ maxWidth: 820 }}>
                <section className="card card-pad stack-sm" aria-labelledby="sn-when">
                    <div className="field-label-row">
                        <h2 className="t-section" id="sn-when">
                            When to send a message
                        </h2>
                        <HelpTip label="When to send a message" text="At most one message per assessment and channel: when several reasons apply they are combined. Nothing is sent while an assessment runs." />
                    </div>
                    <div className="stack-sm" role="group" aria-labelledby="sn-when">
                        {SWITCHES.map((s) => (
                            <label key={s.key} className="check">
                                <input type="checkbox" checked={draft[s.key]} disabled={!editable} onChange={(e) => (setSaved(""), setDraft({ ...draft, [s.key]: e.target.checked }))} />
                                <span>
                                    <span className="title">
                                        {s.title}
                                        {f.data?.defaults && f.data.defaults[s.key] ? <span className="t-meta"> (on unless changed)</span> : null}
                                    </span>
                                    <span className="hint">{s.hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                    <p className="hint">A message names the project and the application, says how the assessment ended, counts its findings by severity and links to it. It never carries evidence, finding titles, addresses or secrets.</p>
                </section>

                <section className="card card-pad stack-sm" aria-labelledby="sn-where">
                    <div className="field-label-row">
                        <h2 className="t-section" id="sn-where">
                            Where messages go
                        </h2>
                        <HelpTip label="Where messages go" text="The project’s alert channels, the same ones that tell people about failing runs. Owners add and change them under Settings, Alerts." />
                    </div>
                    {channels.length === 0 ? (
                        <Callout tone="warning" title="No alert channels yet" actions={<LinkButton href={routes.setup(id, "alerts")}>Open Settings, Alerts</LinkButton>}>
                            Messages go nowhere until someone adds an alert channel to this project: email, Slack, Microsoft Teams or a webhook.
                        </Callout>
                    ) : (
                        <fieldset className="stack-sm sec-workflows">
                            <legend className="sr-only">Which alert channels</legend>
                            <label className="check">
                                <input type="radio" name="sn-which" checked={draft.channelIds === null} disabled={!editable} onChange={() => (setSaved(""), setDraft({ ...draft, channelIds: null }))} />
                                <span>
                                    <span className="title">Every alert channel of the project</span>
                                    <span className="hint">Channels added later are included too.</span>
                                </span>
                            </label>
                            <label className="check">
                                <input type="radio" name="sn-which" checked={draft.channelIds !== null} disabled={!editable} onChange={() => (setSaved(""), setDraft({ ...draft, channelIds: enabledChannels.map((c) => c.id) }))} />
                                <span>
                                    <span className="title">Only the channels chosen here</span>
                                </span>
                            </label>
                            {draft.channelIds !== null && (
                                <ul className="sec-channel-list" aria-label="Alert channels">
                                    {channels.map((c) => (
                                        <li key={c.id}>
                                            <label className="check">
                                                <input
                                                    type="checkbox"
                                                    checked={c.enabled && picked(c.id)}
                                                    disabled={!editable || !c.enabled}
                                                    onChange={(e) => {
                                                        setSaved("");
                                                        const now = draft.channelIds ?? [];
                                                        setDraft({ ...draft, channelIds: e.target.checked ? [...now, c.id] : now.filter((x) => x !== c.id) });
                                                    }}
                                                />
                                                <span>
                                                    <span className="title">{c.name}</span>
                                                    <span className="hint">
                                                        {KIND_WORDS[c.kind] ?? c.kind}
                                                        {c.enabled ? "" : ", turned off under Settings, Alerts"}
                                                    </span>
                                                </span>
                                            </label>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </fieldset>
                    )}
                    {nothingSelected && channels.length > 0 && (
                        <Callout tone="warning" title="No channel would receive these messages">
                            {draft.channelIds === null ? "Every alert channel of this project is turned off." : "Choose at least one channel that is turned on."}
                        </Callout>
                    )}
                </section>

                {problem && (
                    <Callout tone="danger" title="We couldn’t save the notification settings">
                        {problem}
                    </Callout>
                )}
                <div className="row">
                    <Button variant="primary" icon={Save} loading={busy} disabled={!editable || !changed} onClick={() => void save()}>
                        Save notification settings
                    </Button>
                    {changed && editable && (
                        <Button variant="ghost" onClick={() => (setDraft({ ...f.data!.settings }), setSaved(""))}>
                            Discard changes
                        </Button>
                    )}
                    {!editable && <span className="hint">Editors and owners can change these settings.</span>}
                    {saved && (
                        <span className="t-meta" role="status">
                            {saved}
                        </span>
                    )}
                </div>

                <section className="card" aria-labelledby="sn-recent">
                    <div className="card-head">
                        <h2 className="t-section" id="sn-recent">
                            Recent messages
                        </h2>
                        <BadgeKey
                            label="the delivery results and reasons"
                            entries={[
                                ...(f.data.recent ?? []).map((r) => (r.status === "sent" ? { word: "Sent", text: "The channel accepted the message." } : { word: "Not delivered", text: "The channel did not take the message; the reason is shown beside it." })),
                                // The reasons after "Because:", in the order of NOTIFY_REASON, each with its definition (src/security/notify.ts).
                                ...keyEntries(Object.keys(NOTIFY_REASON) as Array<keyof typeof NOTIFY_REASON>, (f.data.recent ?? []).flatMap((r) => (r.reasons ?? []) as Array<keyof typeof NOTIFY_REASON>), (k) => `Because ${REASON_WORDS[k]}`, (k) => NOTIFY_REASON[k]),
                            ]}
                        />
                    </div>
                    {(f.data.recent ?? []).length === 0 ? (
                        <EmptyState icon={BellRing} title="No messages sent yet">
                            The last 20 messages about assessments appear here, with the channel and whether it took the message.
                        </EmptyState>
                    ) : (
                        <ul className="list divided" data-testid="sn-recent">
                            {(f.data.recent ?? []).map((r, i) => (
                                <li key={`${r.at}-${i}`}>
                                    <div className="list-row" style={{ cursor: "default" }}>
                                        <span className="main">
                                            <span className="title" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                                                {r.summary || `To ${r.channelName}`}
                                            </span>
                                            <span className="meta sec-list-cols">
                                                <span>
                                                    {r.channelName}, {KIND_WORDS[r.channelKind] ?? r.channelKind}
                                                </span>
                                                <span>{when(r.at)}</span>
                                                {r.reasons?.length ? <span>Because: {r.reasons.map((x) => REASON_WORDS[x] ?? x).join(", ")}</span> : null}
                                                {r.error && <span>{r.error}</span>}
                                            </span>
                                        </span>
                                        <span className="tail">
                                            <Badge tone={r.status === "sent" ? "success" : "danger"} icon={toneIcon(r.status === "sent" ? "success" : "danger")} tip={r.status === "sent" ? "The channel accepted the message." : "The channel did not take the message; the reason is shown beside it."}>
                                                {r.status === "sent" ? "Sent" : "Not delivered"}
                                            </Badge>
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        );
    };

    return (
        <SecurityLayout id={id} active="notifications" title="Notifications" subtitle="Who is told when an assessment ends, and when.">
            {content()}
        </SecurityLayout>
    );
}
