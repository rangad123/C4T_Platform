import { ChevronRight, Laptop, Pencil, Server, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, Metric, PageHeader, Skeleton } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { useDocumentTitle } from "../../lib/hooks";
import { duration, relativeTime } from "../../lib/format";
import { friendlyError } from "../../lib/labels";
import { go, routes, useRoute } from "../../lib/router";
import { useCan } from "../auth/permissions";
import { capabilitySummary, deviceState, NEEDS_MANUAL_UPDATE, usePolled } from "../agents/agents";
import { AddRunner } from "../agents/AddRunner";
import { RunnerCheckDetails, RunnerCheckNote } from "../agents/check";
import { networkSentence, RunnerNetworkProblem } from "../agents/network";
import { RunnerProjects } from "./ProjectRunnersSection";
import { RunnerSwitches } from "./RunnerSwitches";
import { kindOf, machineFacts, mayAdd, offlineSteps, STATUS_WORDS, whose, type Runner, type RunnerStatus, type RunnerSummary, type RunnersAnswer } from "./runners";
import "../agents/agents.css";

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const seen = (r: Runner) => (r.lastSeenAt ? `Last seen ${relativeTime(r.lastSeenAt)}` : "Never connected");

function StatusBadge({ status }: { status: RunnerStatus }) {
    const w = STATUS_WORDS[status];
    return <Badge tone={w.tone} tip={w.tip}>{w.label}</Badge>;
}

function WhoseBadge({ r }: { r: Runner }) {
    const w = whose(r);
    return (
        <Badge tone={w.label === "Team" ? "neutral" : "brand"} tip={w.tip}>
            {w.label}
        </Badge>
    );
}

/** What to do when there is no runner: the same words wherever the question comes up. `here`: said on the Runners page itself. */
export function HowToAddRunner({ canAddPersonal = false, canAddTeam = false, here = false }: { canAddPersonal?: boolean; canAddTeam?: boolean; here?: boolean }) {
    const where = here ? "choose" : "open Runners and choose";
    return (
        <>
            A runner is a small program on a Windows computer or a Mac that runs the tests. Nothing runs until one connects.
            {canAddPersonal ? ` To run tests on your own computer, ${where} Add this computer.` : ""}
            {canAddTeam ? ` To add a computer that runs tests for a team, ${where} Add a team runner.` : ""}
            {!canAddPersonal && !canAddTeam ? " Ask someone who manages runners to give this project one." : ""}
        </>
    );
}

/** Runners (AD-08): every machine the person may see, with filters; opening one shows its details. `?add=computer` (or `team`) opens Add with it. */
export function RunnersList() {
    const list = usePolled<RunnersAnswer>("/runners");
    const route = useRoute();
    const asked = route.query.get("add");
    const [status, setStatus] = useState<"all" | RunnerStatus>("all");
    const [owner, setOwner] = useState("all");
    const [kind, setKind] = useState<"all" | "mine" | "team">("all");
    const [project, setProject] = useState("all");
    const [text, setText] = useState("");
    const [adding, setAdding] = useState<"personal" | "team" | null>(asked === "computer" ? "personal" : asked === "team" ? "team" : null);
    // A link to ?add=computer from this same page (the project's runners say "add this computer") opens the panel too.
    useEffect(() => {
        if (asked === "computer" || asked === "team") setAdding(asked === "computer" ? "personal" : "team");
    }, [asked]);
    const data = list.data;
    if (list.loading && !data) return <ListSkeleton rows={3} />;
    if (list.error || !data) return <ErrorState error={friendlyError(list.error?.message ?? "")} onRetry={list.reload} />;
    const may = mayAdd(data);
    const open = adding === "personal" ? may.personal : adding === "team" ? may.team : false;
    const close = () => {
        setAdding(null);
        // Leave ?add= behind, so a reload does not open the panel again.
        if (asked) go(routes.allRunners);
    };
    const ownerChoices = [...data.owners.map((o) => ({ id: o.id as string | null, label: o.name ?? o.id })), ...(data.canRegisterShared ? [{ id: null, label: "Crowd4Test (shared)" }] : [])];
    const owners = [...new Set(data.runners.map((r) => r.ownerName))].sort();
    const projects = [...new Map(data.runners.flatMap((r) => r.projects).map((p) => [p.id, p.name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const anyPersonal = data.runners.some((r) => kindOf(r) === "personal");
    const needle = text.trim().toLowerCase();
    const shown = data.runners.filter(
        (r) =>
            (status === "all" ? r.status !== "retired" : r.status === status) &&
            (owner === "all" || r.ownerName === owner) &&
            (kind === "all" || (kind === "mine" ? kindOf(r) === "personal" && r.mine : kindOf(r) === "team")) &&
            (project === "all" || r.projects.some((p) => p.id === project)) &&
            (!needle || `${r.name} ${r.machineName ?? ""}`.toLowerCase().includes(needle)),
    );
    return (
        <>
            {(may.personal || may.team) && !open && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }} data-testid="runner-add-actions">
                    {may.personal && (
                        <Button variant="primary" icon={Laptop} onClick={() => setAdding("personal")}>
                            Add this computer
                        </Button>
                    )}
                    {may.team && (
                        <Button icon={Server} onClick={() => setAdding("team")}>
                            Add a team runner
                        </Button>
                    )}
                </div>
            )}
            {!may.personal && data.personal && data.personal.count >= data.personal.max && data.personal.reason && <p className="t-meta" data-testid="personal-cap">{data.personal.reason}</p>}
            {open && adding && <AddRunner key={adding} scope={adding} owners={ownerChoices} onClose={close} onChanged={() => void list.reload()} />}
            {data.runners.length === 0 ? (
                <section className="stack-sm" aria-labelledby="runner-list-title">
                    <h2 className="t-section" id="runner-list-title">
                        Machines
                    </h2>
                    <div className="card">
                        <EmptyState icon={Laptop} title="No runners yet" actions={may.personal || may.team ? undefined : <LinkButton href={routes.home}>Open your projects</LinkButton>}>
                            <HowToAddRunner canAddPersonal={may.personal} canAddTeam={may.team} here />
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
                        {anyPersonal && (
                            <div className="field">
                                <label htmlFor="runner-kind">Kind</label>
                                <select id="runner-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                                    <option value="all">All runners</option>
                                    <option value="mine">Your computers</option>
                                    <option value="team">Team runners</option>
                                </select>
                            </div>
                        )}
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
                                                {kindOf(r) === "personal" ? (r.mine ? "Runs the tests you start" : `${r.ownerName}'s computer`) : `${r.ownerName} · ${plural(r.projects.length + r.otherProjects, "project")}`} · {seen(r)}
                                                {r.queue.waiting > 0 ? ` · ${r.queue.waiting} waiting` : ""}
                                            </span>
                                            {r.agent?.update?.state === "needs-manual" && <span className="meta" data-testid="runner-needs-manual">{NEEDS_MANUAL_UPDATE}</span>}
                                        </span>
                                        <WhoseBadge r={r} />
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
    const personal = kindOf(r) === "personal";
    const facts = machineFacts(r.agent, r.machine);
    const c = r.agent?.capabilities;
    const w = whose(r);
    return (
        <>
            <PageHeader
                title={r.name}
                subtitle={`${personal ? (r.mine ? "Your computer" : `${r.ownerName}'s computer`) : `Team runner · ${r.ownerName}`} · ${seen(r)}`}
                actions={
                    <>
                        <Badge tone={personal ? "brand" : "neutral"} tip={w.tip}>
                            {w.label}
                        </Badge>
                        <StatusBadge status={r.status} />
                    </>
                }
            />
            <div className="stack">
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                {r.status === "not-connected" && (
                    <Callout tone="info" title="Waiting for this computer">
                        Start the runner on its computer. If it was added with a code that has expired, or with a token that is lost, retire this runner and add the computer again.
                    </Callout>
                )}
                {r.status === "offline" && (
                    <Callout tone="warning" title="This runner is offline">
                        <div className="stack-sm" data-testid="runner-offline-help">
                            <p>Nothing has been heard from it {r.lastSeenAt ? `since ${relativeTime(r.lastSeenAt)}` : "yet"}. It runs only while its computer is on, signed in and online.</p>
                            <ul className="ag-steps">
                                {offlineSteps(r.agent?.os).map((step) => (
                                    <li key={step}>{step}</li>
                                ))}
                            </ul>
                        </div>
                    </Callout>
                )}
                <section className="card card-pad stack-sm" aria-labelledby="runner-health-title">
                    <h2 className="t-section" id="runner-health-title">
                        This computer
                    </h2>
                    <div className="ag-facts" data-testid="runner-facts">
                        <span>
                            Machine <b>{r.machineName ?? "Unknown until it connects"}</b>
                        </span>
                        {facts.system && (
                            <span>
                                System <b>{facts.system}</b>
                            </span>
                        )}
                        {facts.arch && (
                            <span>
                                Processor <b>{facts.arch}</b>
                            </span>
                        )}
                        {facts.memory && (
                            <span>
                                Memory <b>{facts.memory}</b>
                            </span>
                        )}
                        {facts.cpus && (
                            <span>
                                Cores <b>{facts.cpus}</b>
                            </span>
                        )}
                        <span>
                            Runner version <b>{r.version ?? "Unknown"}</b>
                        </span>
                        {facts.playwright && (
                            <span>
                                Playwright <b>{facts.playwright}</b>
                            </span>
                        )}
                        {r.agent?.update && <span>{r.agent.update.outOfDate ? <b>Update available: {r.agent.update.latest}</b> : "Up to date"}</span>}
                        <span>
                            Last heard from <b>{r.lastSeenAt ? relativeTime(r.lastSeenAt) : "Never"}</b>
                        </span>
                        {r.agent && (
                            <span>
                                Runs at once <b>{r.agent.concurrency}</b>
                            </span>
                        )}
                    </div>
                    {r.agent?.update?.state === "needs-manual" && (
                        <Callout tone="warning">
                            <span data-testid="runner-needs-manual">{NEEDS_MANUAL_UPDATE}</span>
                        </Callout>
                    )}
                    {r.agent?.update?.published === false && r.agent.update.unpublished && <p className="t-secondary">This platform offers no automatic update: {r.agent.update.unpublished}</p>}
                    {c && <p className="t-secondary" data-testid="runner-capabilities">{capabilitySummary(c)}</p>}
                    {c?.network && <p className="t-secondary" data-testid="runner-network">{networkSentence(c.network)}</p>}
                    <RunnerNetworkProblem network={c?.network} />
                    <RunnerCheckNote check={c?.check} name={r.name} />
                    {c?.check && (
                        <details className="disclosure">
                            <summary>
                                <ChevronRight size={16} className="chev" aria-hidden />
                                Computer check
                            </summary>
                            <div className="inner">
                                <RunnerCheckDetails check={c.check} />
                            </div>
                        </details>
                    )}
                </section>
                <section className="card card-pad stack-sm" aria-labelledby="runner-work-title">
                    <h2 className="t-section" id="runner-work-title">
                        Work
                    </h2>
                    {r.currentTasks.length > 0 ? (
                        <ul className="list" aria-label="Current work">
                            {r.currentTasks.map((t, i) => (
                                <li key={i} className="t-secondary">
                                    {t.jobId && t.projectId ? <a href={routes.run(t.projectId, t.jobId)}>{t.kind}</a> : t.kind} for {t.projectName ?? "another project"}
                                    {t.total ? ` (${t.done ?? 0} of ${t.total})` : ""}
                                    {t.startedAt ? `, started ${relativeTime(t.startedAt)}` : ""}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="t-secondary">No work in progress.</p>
                    )}
                    <div className="ag-facts">
                        <span>
                            Waiting now <b>{r.queue.waiting}</b>
                            {r.queue.waiting > 0 ? ` (longest ${duration(r.queue.oldestWaitMs)})` : ""}
                        </span>
                        <span>
                            Average wait <b>{r.queue.averageWaitMs === null ? "No runs yet" : duration(r.queue.averageWaitMs)}</b>
                        </span>
                    </div>
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
                <RunnerSwitches runner={r} onChanged={f.reload} />
                {/* Which projects use it, and (for someone who manages it) giving it to a project or taking it away: round 37 moved this out of the projects.
                    A personal runner is given to no project: it follows its owner. */}
                {personal ? (
                    <section className="card card-pad stack-sm" aria-labelledby="runner-takes-title" data-testid="runner-takes">
                        <h2 className="t-section" id="runner-takes-title">
                            Which runs it takes
                        </h2>
                        <p className="t-secondary">
                            Only the runs {r.mine ? "you start" : `${r.ownerName} starts`}, and {r.mine ? "your" : "their"} own schedules, in projects {r.mine ? "you" : "they"} can run tests in and that allow people’s own computers. Nobody else’s run ever goes to it.
                        </p>
                    </section>
                ) : (
                    <RunnerProjects runner={r} onChanged={f.reload} />
                )}
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
                                    <Button size="sm" variant="danger" loading={busy} onClick={() => void run(() => api(`/runners/${r.id}/retire`, { method: "POST" }), "Runner retired. It can no longer connect.", "The runner was not retired. Try again.")}>
                                        Retire runner
                                    </Button>
                                </>
                            }>
                                It can no longer connect, at once and for every project. Work it is running goes back to the queue. This cannot be undone.
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
    const can = useCan();
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
                    <HowToAddRunner canAddPersonal={can("ai_studio.tests.run")} canAddTeam={can("ai_studio.runners.manage")} />
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
