import { CalendarClock, ListOrdered, Pause, Play, Plus, Trash2, Workflow, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api, projectKind, type ProjectDetail } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, ListSkeleton } from "../../components/ui";
import { BadgeKey } from "../../components/Tooltip";
import { SCHEDULE_HELP } from "../../lib/help";
import { relativeTime } from "../../lib/format";
import { useHere } from "../auth/project-access";
import { useConfig, useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { DISPATCH_OFF, SCHEDULED_EXPLORE_ON, RUNS_OFF_TIP, executionModeOf, useExecutionMode } from "../runs/runs-here";
import { WEEKDAYS, utcOffsetText, whenText, type Cadence, type Schedule, type ScheduleKind, type ScheduleList } from "./schedules";
import "./schedules.css";

type Frequency = "minutes" | "hours" | "daily" | "weekly";

/** Schedules of one project: what runs when, the next and last run, and the form that creates a new one. */
export function SchedulesPanel({ projectId, reloadKey, onRunStarted }: { projectId: string; reloadKey: number; onRunStarted: () => void }) {
    const list = useFetch<ScheduleList>(`/projects/${projectId}/schedules`);
    const [adding, setAdding] = useState(false);
    useEffect(() => {
        if (reloadKey > 0) void list.reload();
    }, [reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const data = list.data;
    // Making, changing and starting schedules all need ai_studio.tests.run in this project: without it they are shown to read, with
    // New schedule and Run now switched off with the reason, and Pause and Delete left out.
    const noRun = useHere(projectId).why("ai_studio.tests.run");
    // Do schedules really start their runs? Only while scheduling is on AND runs can start (a worker, or in runners mode the dispatch
    // that hands runs to runners): the scheduler runs only next to one, so without it a schedule shows a next time that never comes.
    const config = useConfig();
    const runnersOnly = executionModeOf(config) === "runners";
    const runsStart = config?.runsHere !== false;
    const zone = data ? `server time, ${data.timezone.name.replace(/_/g, " ")} (${utcOffsetText(data.timezone.utcOffsetMinutes)})` : "server time";

    return (
        <section className="card" aria-labelledby="schedules-title">
            <div className="card-head wrap">
                <CalendarClock size={18} aria-hidden />
                <h2 className="t-section" id="schedules-title">Scheduled runs</h2>
                {data && <BadgeKey label="the schedule states"entries={data.schedules.map((s) => (s.enabled ? { word: "Active", text: SCHEDULE_HELP.on } : { word: "Paused", text: SCHEDULE_HELP.off }))} />}
                <span className="spacer" />
                {data && data.schedules.length > 0 && !adding && (
                    <Button size="sm" icon={Plus} disabled={Boolean(noRun)} tip={noRun} onClick={() => setAdding(true)}>
                        New schedule
                    </Button>
                )}
            </div>
            {list.loading ? (
                <ListSkeleton rows={2} />
            ) : list.error || !data ? (
                <div className="card-pad">
                    <ErrorState error={friendlyError(list.error?.message)} onRetry={list.reload} />
                </div>
            ) : (
                <>
                    {!data.schedulerEnabled ? (
                        <div className="card-pad" style={{ paddingBottom: 0 }} data-testid="schedules-fire">
                            <Callout tone="warning" title="Scheduling is switched off on this server">
                                Schedules are saved but won’t start on their own.{runsStart ? " “Run now” still works." : ""}
                            </Callout>
                        </div>
                    ) : !runsStart ? (
                        <div className="card-pad" style={{ paddingBottom: 0 }} data-testid="schedules-fire">
                            <Callout tone="warning" title="Scheduled runs don’t start right now">
                                {runnersOnly ? DISPATCH_OFF : "Tests are switched off on this server, so a schedule’s run would never start, and “Run now” would not either. Schedules are saved and start again once runs can start here."}
                            </Callout>
                        </div>
                    ) : runnersOnly && data.schedules.length > 0 ? (
                        <p className="t-meta" style={{ padding: "12px 20px 0" }} data-testid="schedules-fire">
                            Schedules start their runs on time. Each run goes to the runner of the person who made the schedule, so that computer needs to be on then.
                        </p>
                    ) : null}
                    {data.schedules.length === 0 && !adding ? (
                        <EmptyState icon={CalendarClock} title="Nothing is scheduled yet" actions={<Button variant="primary" icon={Plus} disabled={Boolean(noRun)} tip={noRun} onClick={() => setAdding(true)}>New schedule</Button>}>
                            Run your tests automatically — for example every night — and get told when something starts failing.
                        </EmptyState>
                    ) : (
                        <ul className="list divided">
                            {data.schedules.map((s) => (
                                <li key={s.id}>
                                    <ScheduleRow s={s} projectId={projectId} onChanged={list.reload} onRunStarted={onRunStarted} runBlock={noRun ?? (runsStart ? null : runnersOnly ? DISPATCH_OFF : RUNS_OFF_TIP)} mayChange={!noRun} />
                                </li>
                            ))}
                        </ul>
                    )}
                    {adding && !noRun && (
                        <NewScheduleForm
                            projectId={projectId}
                            zone={zone}
                            onCancel={() => setAdding(false)}
                            onCreated={() => {
                                setAdding(false);
                                void list.reload();
                            }}
                        />
                    )}
                    {data.schedules.length > 0 && <p className="t-meta" style={{ padding: "0 20px 14px" }}>Times are {zone}.</p>}
                </>
            )}
        </section>
    );
}

function ScheduleRow({ s, projectId, onChanged, onRunStarted, runBlock, mayChange }: { s: Schedule; projectId: string; onChanged: () => Promise<void>; onRunStarted: () => void; runBlock: string | null; /** False: Pause and Delete are left out (the person may not change schedules here). */ mayChange: boolean }) {
    const [busy, setBusy] = useState<"run" | "toggle" | "delete" | null>(null);
    const [error, setError] = useState("");
    const [started, setStarted] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const runnersOnly = useExecutionMode() === "runners";

    async function act(kind: "run" | "toggle" | "delete") {
        setBusy(kind);
        setError("");
        setStarted(false);
        try {
            const base = `/projects/${projectId}/schedules/${s.id}`;
            if (kind === "run") {
                await api(`${base}/run`, { method: "POST" });
                setStarted(true);
                onRunStarted();
            } else if (kind === "toggle") await api(base, { method: "PATCH", body: { enabled: !s.enabled } });
            else await api(base, { method: "DELETE" });
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(null);
            setConfirm(false);
        }
    }

    return (
        <div className="sched-row" data-schedule={s.id}>
            <div className="row">
                <h3 className="t-card">{s.name}</h3>
                <Badge tone={s.enabled ? "success" : "neutral"} tip={s.enabled ? SCHEDULE_HELP.on : SCHEDULE_HELP.off}>{s.enabled ? "Active" : "Paused"}</Badge>
                {s.suiteName ? <Badge tone="info" icon={ListOrdered}>Runs the suite “{s.suiteName}”</Badge> : s.runbookName ? <Badge tone="info" icon={Workflow}>Runs the run sequence “{s.runbookName}”</Badge> : s.kind === "generate" && <Badge tone="info" tip="Each run explores the app again with the AI model, which uses AI tokens.">Uses AI</Badge>}
            </div>
            <div className="facts">
                <span>Next run: <b>{s.enabled ? whenText(s.nextRunAt) : "paused"}</b></span>
                <span>
                    Last run: <b>{s.lastRunAt ? relativeTime(s.lastRunAt) : "never"}</b>
                    {s.lastJobId && <> · <a href={routes.runs(projectId)}>View runs</a></>}
                </span>
                {!s.runbookName && !s.suiteName && s.kind === "validate" && s.retryFailures > 0 && <span>A failing test is run again once to spot unreliable tests</span>}
                {runnersOnly && s.ownerName && <span data-testid="schedule-owner">Runs on {s.ownerName}’s runner</span>}
            </div>
            {runnersOnly && s.kind === "generate" && <p className="t-secondary">{SCHEDULED_EXPLORE_ON}</p>}
            {s.lastOutcome === "skipped" && s.lastNote && <Callout tone="warning">Skipped {relativeTime(s.lastOutcomeAt)}: {s.lastNote}.</Callout>}
            {s.lastOutcome === "error" && s.lastNote && <Callout tone="danger" title="The last run couldn’t start">{s.lastNote}</Callout>}
            {started && <Callout tone="success">Run started. Follow it in <a href={routes.runs(projectId)}>Runs</a>; the results appear below when it finishes.</Callout>}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="acts">
                <Button size="sm" icon={Zap} loading={busy === "run"} disabled={Boolean(runBlock)} onClick={() => act("run")} aria-label={`Run now: ${s.name}`} tip={runBlock ?? "Starts this schedule’s run now. Its next time does not change."}>
                    Run now
                </Button>
                {mayChange && <Button size="sm" variant="ghost" icon={s.enabled ? Pause : Play} loading={busy === "toggle"} onClick={() => act("toggle")} aria-label={`${s.enabled ? "Pause" : "Resume"}: ${s.name}`} tip={s.enabled ? "It starts nothing on its own until you resume it. Run now still works." : "It starts again at its next time from now. Times missed while paused are not made up."}>
                    {s.enabled ? "Pause" : "Resume"}
                </Button>}
                {!mayChange ? null : confirm ? (
                    <>
                        <span className="t-secondary">Delete this schedule?</span>
                        <Button size="sm" variant="danger" loading={busy === "delete"} onClick={() => act("delete")}>Yes, delete</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button>
                    </>
                ) : (
                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)} aria-label={`Delete: ${s.name}`}>
                        Delete
                    </Button>
                )}
            </div>
        </div>
    );
}

const KIND_TEXT: Record<ScheduleKind, string> = { validate: "Re-run all tests", generate: "Explore again" };

function cadenceOf(freq: Frequency, every: number, time: string, weekday: number): Cadence {
    if (freq === "minutes" || freq === "hours") return { type: "interval", every, unit: freq };
    return freq === "daily" ? { type: "daily", time } : { type: "weekly", weekday, time };
}

function sentence(kind: ScheduleKind, c: Cadence, suiteName?: string): string {
    const when = c.type === "interval" ? `every ${c.every === 1 ? (c.unit === "hours" ? "hour" : "minute") : `${c.every} ${c.unit}`}` : c.type === "daily" ? `every day at ${c.time}` : `every ${WEEKDAYS[c.weekday]} at ${c.time}`;
    return `${suiteName ? `Run the suite “${suiteName}”` : KIND_TEXT[kind]} ${when}`;
}

function NewScheduleForm({ projectId, zone, onCancel, onCreated }: { projectId: string; zone: string; onCancel: () => void; onCreated: () => void }) {
    const [kind, setKind] = useState<ScheduleKind>("validate");
    // The suites people built in this project: a schedule can run one of them (its tests, order and settings) instead of every test.
    const suites = useFetch<{ suites: Array<{ id: string; name: string; testCount: number }> }>(`/projects/${projectId}/test-suites`);
    // Exploring is for agent and mixed projects only: a code project is never offered it (its schedules made earlier stay listed).
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    // Runners mode: exploring is not offered (the platform refuses it there, at create and at every fire).
    const runnersOnly = useExecutionMode() === "runners";
    const explores = project.data ? projectKind(project.data) !== "code" && !runnersOnly : false;
    const [suiteId, setSuiteId] = useState("");
    const suite = suites.data?.suites.find((x) => x.id === suiteId);
    const [freq, setFreq] = useState<Frequency>("daily");
    const [every, setEvery] = useState(1);
    const [time, setTime] = useState("02:00");
    const [weekday, setWeekday] = useState(1);
    const [retry, setRetry] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const cadence = cadenceOf(freq, Math.max(1, Math.floor(every) || 1), time || "02:00", weekday);

    async function create() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/schedules`, { method: "POST", body: suiteId ? { kind: "validate", cadence, suiteId } : { kind, cadence, retryFailures: kind === "validate" && retry ? 1 : 0 } });
            onCreated();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <form
            className="sched-form"
            aria-label="New schedule"
            onSubmit={(e) => {
                e.preventDefault();
                void create();
            }}
        >
            <div className="field">
                <label htmlFor="sched-kind">What should run</label>
                <select
                    id="sched-kind"
                    className="input"
                    value={suiteId ? `suite:${suiteId}` : kind}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith("suite:")) {
                            setSuiteId(v.slice(6));
                            setKind("validate");
                        } else {
                            setSuiteId("");
                            setKind(v as ScheduleKind);
                        }
                    }}
                >
                    <option value="validate">Re-run all tests</option>
                    {explores && <option value="generate">Explore again (looks for new things to test; needs the AI model)</option>}
                    {(suites.data?.suites ?? []).map((x) => (
                        <option key={x.id} value={`suite:${x.id}`} disabled={x.testCount === 0}>
                            Run the suite “{x.name}”{x.testCount === 0 ? " (no tests yet)" : ""}
                        </option>
                    ))}
                </select>
                {suite && <p className="hint">The suite runs its own tests, in its order, with the settings saved on the suite.</p>}
            </div>
            <div className="field">
                <label htmlFor="sched-freq">How often</label>
                <div className="inline">
                    <select id="sched-freq" className="input" value={freq} onChange={(e) => setFreq(e.target.value as Frequency)}>
                        <option value="minutes">Every few minutes</option>
                        <option value="hours">Every few hours</option>
                        <option value="daily">Every day</option>
                        <option value="weekly">Every week</option>
                    </select>
                    {(freq === "minutes" || freq === "hours") && (
                        <>
                            <input aria-label={`Number of ${freq}`} className="input num" type="number" min={freq === "minutes" ? 5 : 1} max={freq === "minutes" ? 1440 : 168} value={every} onChange={(e) => setEvery(Number(e.target.value))} />
                            <span>{freq}</span>
                        </>
                    )}
                    {freq === "weekly" && (
                        <select aria-label="Day of the week" className="input" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                                <option key={d} value={d}>{WEEKDAYS[d]}</option>
                            ))}
                        </select>
                    )}
                    {(freq === "daily" || freq === "weekly") && (
                        <>
                            <span>at</span>
                            <input aria-label="Time of day" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
                        </>
                    )}
                </div>
                <p className="hint">Times use {zone}. Runs at most every 5 minutes.</p>
            </div>
            {kind === "validate" && !suiteId && (
                <label className="check">
                    <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />
                    <span>
                        <span className="title">Run a failing test again straight away</span>
                        <span className="hint">If it passes the second time it’s marked unreliable instead of counted as a new failure.</span>
                    </span>
                </label>
            )}
            <p className="sched-preview" aria-live="polite">{sentence(kind, cadence, suite?.name)}</p>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>Create schedule</Button>
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
}
