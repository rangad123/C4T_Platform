import { History, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton, Menu, MenuItem } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { BadgeKey } from "../../components/Tooltip";
import { RunbookEditor } from "./RunbookEditor";
import { RunView, StepTicks, ticksText } from "./RunView";
import { RUN_STATUS, TRIGGER_TEXT, emptyDraft, toDraft, type Draft, type Runbook, type RunbookList, type RunSummary, type Template } from "./runbooks";
import "./runbooks.css";

type Editing = { kind: "new"; draft: Draft } | { kind: "edit"; runbook: Runbook } | null;

/**
 * Runbooks: chain runs together and branch on the result. "Run the smoke tests; if they pass, run everything; otherwise tell the
 * team and stop." Each runbook shows how its last run went as a row of ticks, one per step.
 */
export function RunbooksPanel({ projectId, focusRunId, reloadKey, onLinked }: { projectId: string; focusRunId?: string; reloadKey: number; onLinked?: () => void }) {
    const list = useFetch<RunbookList>(`/projects/${projectId}/runbooks`, (d) => (d?.runbooks.some((r) => r.running) ? 2500 : null));
    const [editing, setEditing] = useState<Editing>(null);
    const [open, setOpen] = useState<{ runbookId: string; runId: string } | null>(null);
    const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const [channelFor, setChannelFor] = useState<Template | null>(null);

    useEffect(() => {
        if (reloadKey > 0) void list.reload();
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

    // A link to one run (from a message) opens that run under its runbook.
    useEffect(() => {
        if (!focusRunId) return;
        let cancelled = false;
        api<RunSummary>(`/projects/${projectId}/runbook-runs/${focusRunId}`)
            .then((run) => !cancelled && setOpen({ runbookId: run.runbookId, runId: run.runId }))
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [focusRunId, projectId]);

    const data = list.data;
    const channels = useFetch<Array<{ id: string; name: string }>>(channelFor ? `/projects/${projectId}/alert-channels` : null);

    async function fromTemplate(t: Template, channelId?: string) {
        setMessage(null);
        try {
            const made = await api<Runbook>(`/projects/${projectId}/runbooks/from-template`, { method: "POST", body: { template: t.id, ...(channelId ? { channelId } : {}) } });
            setChannelFor(null);
            setMessage({ tone: "success", text: made.note ?? `“${made.name}” is ready. Press Run now to try it.` });
            await list.reload();
        } catch (e) {
            setMessage({ tone: "danger", text: describeApiError(e) });
        }
    }
    const pickTemplate = (t: Template) => {
        // A template that tells the team needs a channel to tell; ask once, and allow going without.
        if (t.usesChannel) setChannelFor(t);
        else void fromTemplate(t);
    };

    return (
        <section className="card" aria-labelledby="runbooks-title" id="runbooks">
            <div className="card-head wrap">
                <Workflow size={18} aria-hidden />
                <h2 className="t-section" id="runbooks-title">Run sequences</h2>
                {data && <BadgeKey label="how the last runs ended" entries={data.runbooks.map((r) => (r.lastRun ? { word: RUN_STATUS[r.lastRun.status].label, text: RUN_STATUS[r.lastRun.status].help } : r.running ? { word: "Running", text: RUN_STATUS.running.help } : null))} />}
                <span className="spacer" />
                {data && data.runbooks.length > 0 && !editing && (
                    <>
                        <Menu label="From a template" icon={Plus}>
                            {(close) => data.templates.map((t) => (
                                <MenuItem key={t.id} hint={t.summary} onClick={() => { close(); pickTemplate(t); }}>{t.name}</MenuItem>
                            ))}
                        </Menu>
                        <Button size="sm" icon={Plus} onClick={() => setEditing({ kind: "new", draft: emptyDraft() })}>New run sequence</Button>
                    </>
                )}
            </div>

            {message && (
                <div className="card-pad" style={{ paddingBottom: 0 }}>
                    <Callout tone={message.tone}>{message.text}</Callout>
                </div>
            )}

            {channelFor && data && (
                <form
                    className="rb-form"
                    aria-label={`Create “${channelFor.name}”`}
                    onSubmit={(e) => {
                        e.preventDefault();
                        const id = new FormData(e.currentTarget).get("channel");
                        void fromTemplate(channelFor, typeof id === "string" && id ? id : undefined);
                    }}
                >
                    <p><b>{channelFor.name}.</b> {channelFor.summary}</p>
                    <div className="field">
                        <label htmlFor="rb-template-channel">Who to tell</label>
                        <select id="rb-template-channel" name="channel" className="input" defaultValue="">
                            <option value="">Nobody yet, leave out the message step</option>
                            {(channels.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                        {channels.data && channels.data.length === 0 && <p className="hint">This project has no alert channels. You can add one under Alerts and add a message step later.</p>}
                    </div>
                    <div className="row">
                        <Button type="submit" variant="primary">Create run sequence</Button>
                        <Button type="button" variant="ghost" onClick={() => setChannelFor(null)}>Cancel</Button>
                    </div>
                </form>
            )}

            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error || !data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                </div>
            ) : (
                <>
                    {data.runbooks.length === 0 && !editing && !channelFor && (
                        <EmptyState
                            icon={Workflow}
                            title="No run sequences yet"
                            actions={
                                <>
                                    {data.templates.map((t) => (
                                        <Button key={t.id} onClick={() => pickTemplate(t)} tip={t.summary}>{t.name}</Button>
                                    ))}
                                    <Button variant="primary" icon={Plus} onClick={() => setEditing({ kind: "new", draft: emptyDraft() })}>Write your own</Button>
                                </>
                            }
                        >
                            Chain runs together, for example run the smoke tests, then everything, then tell the team. Start from a template or write your own.
                        </EmptyState>
                    )}

                    {data.runbooks.length > 0 && (
                        <ul className="list divided">
                            {data.runbooks.map((r) => (
                                <li key={r.id}>
                                    {editing?.kind === "edit" && editing.runbook.id === r.id ? (
                                        <RunbookEditor
                                            projectId={projectId}
                                            limits={data.limits}
                                            runbookId={r.id}
                                            initial={toDraft(r.definition)}
                                            onCancel={() => setEditing(null)}
                                            onSaved={() => {
                                                setEditing(null);
                                                setMessage({ tone: "success", text: "Run sequence saved." });
                                                void list.reload();
                                            }}
                                        />
                                    ) : (
                                        <RunbookRow
                                            r={r}
                                            projectId={projectId}
                                            open={open?.runbookId === r.id ? open.runId : null}
                                            onOpen={(runId) => setOpen(runId ? { runbookId: r.id, runId } : null)}
                                            onEdit={() => { setMessage(null); setEditing({ kind: "edit", runbook: r }); }}
                                            onChanged={list.reload}
                                            onLinked={onLinked}
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {editing?.kind === "new" && (
                        <RunbookEditor
                            projectId={projectId}
                            limits={data.limits}
                            initial={editing.draft}
                            onCancel={() => setEditing(null)}
                            onSaved={() => {
                                setEditing(null);
                                setMessage({ tone: "success", text: "Run sequence saved. Press Run now to try it." });
                                void list.reload();
                            }}
                        />
                    )}
                    {data.runbooks.length > 0 && <p className="t-meta" style={{ padding: "0 20px 14px" }}>A project runs one run sequence at a time, and never two jobs at once. A run can take up to {data.limits.totalMinutes} minutes.</p>}
                </>
            )}
        </section>
    );
}

function RunbookRow({ r, projectId, open, onOpen, onEdit, onChanged, onLinked }: { r: Runbook; projectId: string; open: string | null; onOpen: (runId: string | null) => void; onEdit: () => void; onChanged: () => Promise<void>; onLinked?: () => void }) {
    const [busy, setBusy] = useState<"run" | "delete" | null>(null);
    const [error, setError] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [history, setHistory] = useState(false);
    const last = r.lastRun;

    async function startRun() {
        setBusy("run");
        setError("");
        try {
            const out = await api<{ runId: string }>(`/projects/${projectId}/runbooks/${r.id}/run`, { method: "POST" });
            onOpen(out.runId);
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(null);
        }
    }
    async function remove() {
        setBusy("delete");
        setError("");
        try {
            await api(`/projects/${projectId}/runbooks/${r.id}`, { method: "DELETE" });
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
            setConfirm(false);
        } finally {
            setBusy(null);
        }
    }

    const by = [...r.usedBy.schedules.map((s) => `schedule “${s.name}”`), ...r.usedBy.tokens.map((t) => `deploy token ${t.label ? `“${t.label}”` : `ending in ${t.hint}`}`)];
    const status = last ? RUN_STATUS[last.status] : null;

    return (
        <div className="rb-row" data-runbook={r.id}>
            <div className="row">
                <h3 className="t-card">{r.name}</h3>
                {status && <Badge tone={status.tone} tip={status.help}>{status.label}</Badge>}
                {r.running && !status && <Badge tone="info">Running</Badge>}
            </div>
            <p className="rb-summary">{r.titles.map((t, i) => (i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1))).join(", then ")}.</p>
            <div className="facts">
                {last ? (
                    <>
                        <span className="rb-last">
                            <StepTicks ticks={last.ticks} label={`Last run, ${ticksText(last.ticks)}`} />
                        </span>
                        <span>Last run: <b>{relativeTime(last.createdAt)}</b>, {TRIGGER_TEXT[last.trigger].toLowerCase()}</span>
                    </>
                ) : (
                    <span>Not run yet</span>
                )}
                {by.length > 0 && <span>Started by {by.join(", ")}</span>}
            </div>
            {r.warnings.map((w) => (
                <Callout key={w} tone="warning">{w}</Callout>
            ))}
            {error && <Callout tone="danger">{error}</Callout>}

            {open && <RunView key={open} projectId={projectId} runId={open} onChanged={() => void onChanged()} onClose={() => onOpen(null)} />}

            <div className="acts">
                <Button size="sm" variant="primary" icon={Play} loading={busy === "run"} disabled={r.running} onClick={startRun} aria-label={`Run now: ${r.name}`} tip={r.running ? "This run sequence is running now. Wait for it to finish, or cancel it." : "Starts the steps in order now. A project runs one sequence at a time."}>
                    Run now
                </Button>
                <Button size="sm" icon={Pencil} onClick={onEdit} aria-label={`Edit: ${r.name}`}>
                    Edit
                </Button>
                <Button size="sm" variant="ghost" icon={History} aria-expanded={history} onClick={() => setHistory((h) => !h)} aria-label={`Earlier runs: ${r.name}`}>
                    Earlier runs
                </Button>
                {confirm ? (
                    <>
                        <span className="t-secondary">Delete this run sequence and its history?</span>
                        <Button size="sm" variant="danger" loading={busy === "delete"} onClick={remove}>Yes, delete</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
                    </>
                ) : (
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)} aria-label={`Delete: ${r.name}`}>
                        Delete
                    </Button>
                )}
            </div>
            {history && <EarlierRuns projectId={projectId} runbookId={r.id} onShow={(id) => onOpen(id)} />}
            <Starters r={r} projectId={projectId} onChanged={onChanged} onLinked={onLinked} />
        </div>
    );
}

function EarlierRuns({ projectId, runbookId, onShow }: { projectId: string; runbookId: string; onShow: (runId: string) => void }) {
    const runs = useFetch<{ runs: RunSummary[] }>(`/projects/${projectId}/runbooks/${runbookId}/runs?limit=10`);
    if (runs.loading) return <ListSkeleton rows={2} />;
    if (runs.error || !runs.data) return <ErrorState error={friendlyError(runs.error?.message)} onRetry={runs.reload} />;
    if (runs.data.runs.length === 0) return <p className="t-secondary">This run sequence has not run yet.</p>;
    return (
        <>
            <p className="t-meta">
                The last {runs.data.runs.length === 1 ? "run" : `${runs.data.runs.length} runs`}, newest first <BadgeKey label="how the earlier runs ended" entries={runs.data.runs.map((x) => ({ word: RUN_STATUS[x.status].label, text: RUN_STATUS[x.status].help }))} />
            </p>
            <ul className="rb-history" aria-label="Earlier runs">
            {runs.data.runs.map((x) => (
                <li key={x.runId}>
                    <Badge tone={RUN_STATUS[x.status].tone} tip={RUN_STATUS[x.status].help}>{RUN_STATUS[x.status].label}</Badge>
                    <StepTicks ticks={x.ticks} label={ticksText(x.ticks)} />
                    <span className="t-secondary">{relativeTime(x.createdAt)}, {TRIGGER_TEXT[x.trigger].toLowerCase()}</span>
                    <Button size="sm" variant="ghost" onClick={() => onShow(x.runId)} aria-label={`Show the run from ${relativeTime(x.createdAt)}`}>
                        Show
                    </Button>
                </li>
            ))}
            </ul>
        </>
    );
}

/** Which schedules and deploy tokens start this runbook. Each can start one runbook. */
function Starters({ r, projectId, onChanged, onLinked }: { r: Runbook; projectId: string; onChanged: () => Promise<void>; onLinked?: () => void }) {
    const [openIt, setOpenIt] = useState(false);
    return (
        <details className="rb-starters" open={openIt} onToggle={(e) => setOpenIt((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Start automatically</summary>
            {openIt && <StartersBody r={r} projectId={projectId} onChanged={onChanged} onLinked={onLinked} />}
        </details>
    );
}

interface Scheduled { id: string; name: string; runbookId?: string | null; runbookName?: string | null }
interface Token { id: string; label: string | null; hint: string; revokedAt: string | null; runbookId?: string | null; runbookName?: string | null }

function StartersBody({ r, projectId, onChanged, onLinked }: { r: Runbook; projectId: string; onChanged: () => Promise<void>; onLinked?: () => void }) {
    const schedules = useFetch<{ schedules: Scheduled[] }>(`/projects/${projectId}/schedules`);
    const tokens = useFetch<{ tokens: Token[] }>(`/projects/${projectId}/triggers`);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState("");

    async function link(kind: "schedules" | "triggers", id: string, runbookId: string | null) {
        setBusy(`${kind}${id}`);
        setError("");
        try {
            await api(`/projects/${projectId}/${kind}/${id}/runbook`, { method: "PUT", body: { runbookId } });
            await Promise.all([schedules.reload(), tokens.reload(), onChanged()]);
            // The Scheduled runs and Deploy token panels show which runbook they start.
            onLinked?.();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }

    if (schedules.loading || tokens.loading) return <ListSkeleton rows={1} />;
    const sched = schedules.data?.schedules ?? [];
    const toks = (tokens.data?.tokens ?? []).filter((t) => !t.revokedAt);
    if (sched.length === 0 && toks.length === 0) return <p className="t-secondary">There are no schedules or deploy tokens yet. Make one below, then choose this run sequence for it here.</p>;

    return (
        <div className="rb-starters-body">
            {error && <Callout tone="danger">{error}</Callout>}
            <ul className="rb-links">
                {sched.map((s) => {
                    const mine = s.runbookId === r.id;
                    return (
                        <li key={s.id}>
                            <label className="check">
                                <input type="checkbox" checked={mine} disabled={busy === `schedules${s.id}`} onChange={() => link("schedules", s.id, mine ? null : r.id)} />
                                <span>
                                    <span className="title">Schedule: {s.name}</span>
                                    {s.runbookId && !mine && <span className="hint">Now starts “{s.runbookName}”. Choosing this replaces it.</span>}
                                </span>
                            </label>
                        </li>
                    );
                })}
                {toks.map((t) => {
                    const mine = t.runbookId === r.id;
                    return (
                        <li key={t.id}>
                            <label className="check">
                                <input type="checkbox" checked={mine} disabled={busy === `triggers${t.id}`} onChange={() => link("triggers", t.id, mine ? null : r.id)} />
                                <span>
                                    <span className="title">Deploy token: {t.label ?? "Unnamed"} (ends in {t.hint})</span>
                                    {t.runbookId && !mine && <span className="hint">Now starts “{t.runbookName}”. Choosing this replaces it.</span>}
                                </span>
                            </label>
                        </li>
                    );
                })}
            </ul>
            <p className="t-meta">A schedule or token linked to a run sequence starts the run sequence instead of a plain re-run.</p>
        </div>
    );
}
