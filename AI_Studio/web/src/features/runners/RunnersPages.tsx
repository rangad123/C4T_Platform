import { ChevronRight, Laptop, Pencil, Plus, Smartphone } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, Metric, PageHeader, Skeleton } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { useDocumentTitle } from "../../lib/hooks";
import { duration, relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { capabilitySummary, deviceState, OS_LABEL, usePolled } from "../agents/agents";
import { FreshToken } from "../agents/TokensPanel";
import { STATUS_WORDS, type Runner, type RunnerStatus, type RunnerSummary, type RunnersAnswer } from "./runners";
import "../agents/agents.css";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seen = (r: Runner) => (r.lastSeenAt ? `Last seen ${relativeTime(r.lastSeenAt)}` : "Never connected");

function StatusBadge({ status }: { status: RunnerStatus }) {
    const w = STATUS_WORDS[status];
    return <Badge tone={w.tone} tip={w.tip}>{w.label}</Badge>;
}

/** What to do when there is no runner: the same words wherever the question comes up. */
export function HowToAddRunner({ canRegister }: { canRegister: boolean }) {
    return (
        <>
            A runner is a small program on a computer of yours that runs the tests. Nothing runs until one connects. To add one, open a project, then Settings, Runners, and choose Add a runner: it downloads an installer for Windows, macOS or Linux.
            {canRegister ? " You can also register a computer here and start it with its token. Then give it to any of your projects." : " Ask someone who manages runners to give this project one."}
        </>
    );
}

/** Runners (AD-08): every machine the person may see, with filters; opening one shows its details. */
export function RunnersList() {
    const list = usePolled<RunnersAnswer>("/runners");
    const [status, setStatus] = useState<"all" | RunnerStatus>("all");
    const [owner, setOwner] = useState("all");
    const [project, setProject] = useState("all");
    const [text, setText] = useState("");
    const [adding, setAdding] = useState(false);
    const [fresh, setFresh] = useState<{ secret: string; label: string } | null>(null);
    const data = list.data;
    if (list.loading && !data) return <ListSkeleton rows={3} />;
    if (list.error || !data) return <ErrorState error={friendlyError(list.error?.message ?? "")} onRetry={list.reload} />;
    const owners = [...new Set(data.runners.map((r) => r.ownerName))].sort();
    const projects = [...new Map(data.runners.flatMap((r) => r.projects).map((p) => [p.id, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const needle = text.trim().toLowerCase();
    const shown = data.runners.filter(
        (r) => (status === "all" ? r.status !== "retired" : r.status === status) && (owner === "all" || r.ownerName === owner) && (project === "all" || r.projects.some((p) => p.id === project)) && (!needle || `${r.name} ${r.machineName ?? ""}`.toLowerCase().includes(needle)),
    );
    return (
        <>
            {fresh && <FreshToken secret={fresh.secret} label={fresh.label} who="this runner" onDone={() => setFresh(null)} />}
            {data.canRegister && !adding && !fresh && (
                <div>
                    <Button icon={Plus} onClick={() => setAdding(true)}>
                        Register a runner
                    </Button>
                </div>
            )}
            {adding && (
                <RegisterRunner
                    answer={data}
                    onClose={() => setAdding(false)}
                    onDone={(secret, label) => {
                        setAdding(false);
                        setFresh({ secret, label });
                        void list.reload();
                    }}
                />
            )}
            {data.runners.length === 0 ? (
                <section className="stack-sm" aria-labelledby="runner-list-title">
                    <h2 className="t-section" id="runner-list-title">
                        Machines
                    </h2>
                    <div className="card">
                        <EmptyState icon={Laptop} title="No runners yet" actions={<LinkButton href={routes.home}>Open your projects</LinkButton>}>
                            <HowToAddRunner canRegister={data.canRegister} />
                        </EmptyState>
                    </div>
                </section>
            ) : (
                <section className="stack-sm" aria-labelledby="runner-list-title">
                    <div className="row">
                        <h2 className="t-section" id="runner-list-title">
                            Machines
                        </h2>
                        <BadgeKey label="the runner states" entries={(Object.keys(STATUS_WORDS) as RunnerStatus[]).map((s) => ({ word: STATUS_WORDS[s].label, text: STATUS_WORDS[s].tip }))} />
                    </div>
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }} data-testid="runner-filters">
                        <div className="field" style={{ flex: "1 1 200px" }}>
                            <label htmlFor="runner-search">Find a runner</label>
                            <input id="runner-search" className="input" value={text} onChange={(e) => setText(e.target.value)} />
                        </div>
                        <div className="field">
                            <label htmlFor="runner-status">Status</label>
                            <select id="runner-status" className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                                <option value="all">All in use</option>
                                {(Object.keys(STATUS_WORDS) as RunnerStatus[]).map((s) => (
                                    <option key={s} value={s}>
                                        {STATUS_WORDS[s].label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {owners.length > 1 && (
                            <div className="field">
                                <label htmlFor="runner-owner">Owner</label>
                                <select id="runner-owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
                                    <option value="all">All owners</option>
                                    {owners.map((o) => (
                                        <option key={o}>{o}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {projects.length > 0 && (
                            <div className="field">
                                <label htmlFor="runner-project">Project</label>
                                <select id="runner-project" className="input" value={project} onChange={(e) => setProject(e.target.value)}>
                                    <option value="all">All projects</option>
                                    {projects.map(([id, name]) => (
                                        <option key={id} value={id}>
                                            {name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                    {shown.length === 0 ? (
                        <p className="t-secondary">No runner matches these filters.</p>
                    ) : (
                        <ul className="card list divided" aria-label="Runners">
                            {shown.map((r) => (
                                <li key={r.id}>
                                    <a className="list-row" href={routes.runner(r.id)}>
                                        <span className="main">
                                            <span className="title truncate">{r.name}</span>
                                            <span className="meta">
                                                {r.ownerName} · {plural(r.projects.length + r.otherProjects, "project")} · {seen(r)}
                                                {r.queue.waiting > 0 ? ` · ${r.queue.waiting} waiting` : ""}
                                            </span>
                                        </span>
                                        <StatusBadge status={r.status} />
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}
        </>
    );
}

function RegisterRunner({ answer, onClose, onDone }: { answer: RunnersAnswer; onClose: () => void; onDone: (secret: string, label: string) => void }) {
    const [name, setName] = useState("");
    const choices = [...answer.owners.map((o) => ({ id: o.id as string | null, label: o.name ?? o.id })), ...(answer.canRegisterShared ? [{ id: null, label: "Crowd4Test (shared)" }] : [])];
    const [owner, setOwner] = useState(choices[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const save = async () => {
        if (!name.trim()) return setError("Give the runner a name.");
        setBusy(true);
        setError("");
        try {
            const out = await api<{ secret: string }>("/runners", { method: "POST", body: { name: name.trim(), organizationId: owner || null } });
            onDone(out.secret, name.trim());
        } catch (e) {
            setError(message(e, "The runner was not registered. Try again."));
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="register-runner-title">
            <h2 className="t-section" id="register-runner-title">
                Register a runner
            </h2>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div className="field" style={{ flex: "1 1 220px" }}>
                    <label htmlFor="runner-name">Runner name</label>
                    <input id="runner-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                {choices.length > 1 && (
                    <div className="field" style={{ flex: "1 1 200px" }}>
                        <label htmlFor="runner-new-owner">Owner</label>
                        <select id="runner-new-owner" className="input" value={owner ?? ""} onChange={(e) => setOwner(e.target.value)}>
                            {choices.map((o) => (
                                <option key={o.id ?? ""} value={o.id ?? ""}>
                                    {o.label}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                <Button variant="primary" loading={busy} disabled={busy} onClick={() => void save()}>
                    Register
                </Button>
                <Button variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
            </div>
        </section>
    );
}

/** One runner (AD-09): its details, health, the projects that use it, and what a person with the permission can do. */
export function RunnerPage({ id }: { id: string }) {
    const f = usePolled<Runner>(`/runners/${id}`);
    const r = f.data;
    useDocumentTitle(r?.name ?? "Runner");
    usePage({ crumbs: [{ label: "Runners", href: routes.allRunners }, { label: r?.name ?? "Runner" }], nav: "runners" });
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [name, setName] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    if (f.loading && !r) return <ListSkeleton rows={4} />;
    if (f.error || !r) return <ErrorState error={friendlyError(f.error?.message ?? "")} onRetry={f.reload} />;
    const run = async (fn: () => Promise<unknown>, done: string, failed: string) => {
        setBusy(true);
        setNote(null);
        try {
            await fn();
            setNote({ tone: "success", text: done });
            setRenaming(false);
            setConfirming(false);
            await f.reload();
        } catch (e) {
            setNote({ tone: "danger", text: message(e, failed) });
        } finally {
            setBusy(false);
        }
    };
    const active = r.status !== "retired";
    return (
        <>
            <PageHeader title={r.name} subtitle={`${r.ownerName} · ${seen(r)}`} actions={<StatusBadge status={r.status} />} />
            <div className="stack">
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                {r.status === "not-connected" && (
                    <Callout tone="info" title="Waiting for this computer">
                        Start the runner on the computer with the token you copied when you registered it. If the token is lost, retire this runner and register it again.
                    </Callout>
                )}
                <section className="card card-pad stack-sm" aria-labelledby="runner-health-title">
                    <h2 className="t-section" id="runner-health-title">
                        Health
                    </h2>
                    <div className="ag-facts">
                        <span>
                            Machine <b>{r.machineName ?? "Unknown until it connects"}</b>
                        </span>
                        {r.agent && (
                            <span>
                                System <b>{OS_LABEL[r.agent.os]}</b>
                            </span>
                        )}
                        <span>
                            Version <b>{r.version ?? "Unknown"}</b>
                        </span>
                        {r.agent?.update && <span>{r.agent.update.outOfDate ? <b>Update available: {r.agent.update.latest}</b> : "Up to date"}</span>}
                        <span>
                            Waiting now <b>{r.queue.waiting}</b>
                            {r.queue.waiting > 0 ? ` (longest ${duration(r.queue.oldestWaitMs)})` : ""}
                        </span>
                        <span>
                            Average wait <b>{r.queue.averageWaitMs === null ? "No runs yet" : duration(r.queue.averageWaitMs)}</b>
                        </span>
                    </div>
                    {r.agent && <p className="t-secondary">{capabilitySummary(r.agent.capabilities)}</p>}
                    {r.currentTasks.length > 0 ? (
                        <ul className="list" aria-label="Current work">
                            {r.currentTasks.map((t, i) => (
                                <li key={i} className="t-secondary">
                                    {t.kind} for {t.projectName ?? "another project"}
                                    {t.total ? ` (${t.done ?? 0} of ${t.total})` : ""}
                                    {t.startedAt ? `, started ${relativeTime(t.startedAt)}` : ""}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="t-secondary">No work in progress.</p>
                    )}
                </section>
                <section className="card card-pad stack-sm" aria-labelledby="runner-devices-title">
                    <h2 className="t-section" id="runner-devices-title">
                        Phones and simulators
                    </h2>
                    {r.devices.length === 0 ? (
                        <p className="t-secondary">This runner has reported no phones, emulators or simulators.</p>
                    ) : (
                        <ul className="list divided" aria-label="Phones and simulators">
                            {r.devices.map((d) => (
                                <li key={`${d.family}:${d.key}`} className="list-row">
                                    <Smartphone size={18} aria-hidden />
                                    <span className="main">
                                        <span className="title truncate">{d.name}</span>
                                        <span className="meta">{d.heldBy ? `In use by ${d.heldBy.projectName ?? "another project"}` : d.state === "available" ? "Available" : deviceState(d.state)}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <section className="card card-pad stack-sm" aria-labelledby="runner-failures-title">
                    <h2 className="t-section" id="runner-failures-title">
                        Recent failures
                    </h2>
                    {r.recentFailures.count === 0 ? (
                        <p className="t-secondary">No failures in the last 24 hours.</p>
                    ) : (
                        <ul className="list divided" aria-label="Recent failures">
                            {r.recentFailures.items.map((x, i) => (
                                <li key={i} className="list-row">
                                    <span className="main">
                                        <span className="title">{x.projectName ?? "Another project"}</span>
                                        <span className="meta">
                                            {x.kind}, {relativeTime(x.at)}
                                            {x.error ? `: ${x.error}` : ""}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <section className="card card-pad stack-sm" aria-labelledby="runner-projects-title">
                    <h2 className="t-section" id="runner-projects-title">
                        Projects that use it
                    </h2>
                    {r.projects.length === 0 && r.otherProjects === 0 ? (
                        <p className="t-secondary">No project uses this runner yet. Give it to a project in that project's Settings, Runners.</p>
                    ) : (
                        <ul className="list divided" aria-label="Projects that use this runner">
                            {r.projects.map((p) => (
                                <li key={p.id}>
                                    <a className="list-row" href={routes.runners(p.id)}>
                                        <span className="main">
                                            <span className="title truncate">{p.name}</span>
                                            <span className="meta">Since {relativeTime(p.grantedAt)}</span>
                                        </span>
                                        <ChevronRight size={18} className="chev" aria-hidden />
                                    </a>
                                </li>
                            ))}
                            {r.otherProjects > 0 && <li className="list-row t-secondary">{plural(r.otherProjects, "other project")} you can't open</li>}
                        </ul>
                    )}
                </section>
                {r.canManage && active && (
                    <section className="card card-pad stack-sm" aria-labelledby="runner-actions-title">
                        <h2 className="t-section" id="runner-actions-title">
                            Actions
                        </h2>
                        {renaming ? (
                            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <label className="sr-only" htmlFor="runner-rename">
                                    New name for {r.name}
                                </label>
                                <input id="runner-rename" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 320 }} />
                                <Button size="sm" variant="primary" loading={busy} onClick={() => void run(() => api(`/runners/${r.id}`, { method: "PATCH", body: { name: name.trim() } }), `Runner renamed to “${name.trim()}”.`, "The runner was not renamed. Try again.")}>
                                    Save name
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                                    Cancel
                                </Button>
                            </div>
                        ) : confirming ? (
                            <Callout tone="warning" title={`Retire ${r.name}?`} actions={
                                <>
                                    <Button size="sm" onClick={() => setConfirming(false)}>
                                        Keep runner
                                    </Button>
                                    <Button size="sm" variant="danger" loading={busy} onClick={() => void run(() => api(`/runners/${r.id}/retire`, { method: "POST" }), "Runner retired. Its token no longer works.", "The runner was not retired. Try again.")}>
                                        Retire runner
                                    </Button>
                                </>
                            }>
                                Its token stops working at once, for every project. Work it is running goes back to the queue. This cannot be undone.
                            </Callout>
                        ) : (
                            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                <Button size="sm" icon={Pencil} onClick={() => (setName(r.name), setRenaming(true))}>
                                    Rename
                                </Button>
                                <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
                                    Retire
                                </Button>
                            </div>
                        )}
                    </section>
                )}
            </div>
        </>
    );
}

/** The Dashboard's summary of the runners the person may see. */
export function RunnerHealthCard() {
    const f = usePolled<RunnerSummary>("/runners/summary", 15_000);
    const s = f.data;
    return (
        <section className="card card-pad stack-sm" data-testid="dashboard-runners" aria-labelledby="dashboard-runners-title">
            <div className="row">
                <h2 className="t-section" id="dashboard-runners-title">
                    Runner health
                </h2>
                <span className="spacer" />
                <a href={routes.allRunners}>Open runners</a>
            </div>
            {!s ? (
                f.error ? (
                    <ErrorState error={friendlyError(f.error.message)} onRetry={f.reload} />
                ) : (
                    <Skeleton h={40} />
                )
            ) : s.total === 0 ? (
                <p className="t-secondary">
                    <HowToAddRunner canRegister={false} />
                </p>
            ) : (
                <>
                    <div className="metrics">
                        <Metric value={s.online} label="Online" tone="ok" />
                        <Metric value={s.busy} label="Busy" />
                        <Metric value={s.offline} label="Offline" tone={s.offline > 0 ? "warn" : undefined} />
                        <Metric value={s.waiting} label="Waiting in the queue" tone={s.waiting > 0 ? "warn" : undefined} />
                    </div>
                    <p className="t-secondary">
                        {s.browsers.length ? `Browsers: ${s.browsers.join(", ")}.` : "No browsers online."} {plural(s.phones, "phone")} and {plural(s.simulators, "simulator")} online.
                        {s.averageWaitMs !== null ? ` Runs wait ${duration(s.averageWaitMs)} on average.` : ""}
                        {s.waiting > 0 ? ` The longest wait now is ${duration(s.oldestWaitMs)}.` : ""}
                        {s.recentFailures > 0 ? ` ${plural(s.recentFailures, "runner failure")} in the last 24 hours.` : ""}
                    </p>
                </>
            )}
        </section>
    );
}
