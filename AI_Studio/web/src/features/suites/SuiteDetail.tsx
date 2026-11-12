import { ArrowDown, ArrowLeft, ArrowUp, CalendarClock, Copy, GripVertical, ListOrdered, Pencil, Play, Plus, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type ProjectDetail, type TestSummary } from "../../api";
import { BadgeKey } from "../../components/Tooltip";
import { Badge, Button, Callout, EmptyState, ErrorState, JobBadge, jobKey, ListSkeleton, StatusBadge, statusKey } from "../../components/ui";
import { plural, relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import type { Environment } from "../environments/environments";
import { PRODUCTION_WARNING } from "../environments/environments";
import { isRunnerRefusal, refusalLink, useReadiness } from "../runners/my-runner";
import { RunnerNotReady } from "../runs/RunnerNotReady";
import { RunStartError } from "../runners/RunnerRefusal";
import { VARIANT_UI, variantLabel, type VariantId } from "../variants/variants";
import { moved, runResult, settingsSentence, type Suite, type SuiteDetailData, type SuiteSettings, type SuiteTest } from "./suites";

/** One suite a person built: its tests in run order, how it runs, its last runs, and Run. */
export function SuiteDetail({ projectId, suiteId }: { projectId: string; suiteId: string }) {
    const detail = useFetch<SuiteDetailData>(`/projects/${projectId}/test-suites/${suiteId}`, (d) => (d?.runs.some((r) => !["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(r.job.status)) ? 4000 : null));
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const perms = project.data?.access?.permissions;
    const canWrite = !perms || perms.includes("ai_studio.tests.write");
    const canRunPerm = !perms || perms.includes("ai_studio.tests.run");

    const back = (
        <a href={routes.suites(projectId)} className="suite-back">
            <ArrowLeft size={16} aria-hidden /> All suites
        </a>
    );
    if (detail.loading) return <>{back}<ListSkeleton rows={4} /></>;
    if (detail.error || !detail.data) {
        const missing = detail.error?.message === "Suite not found";
        return (
            <>
                {back}
                {missing ? (
                    <div className="card">
                        <EmptyState icon={ListOrdered} title="This suite does not exist">
                            It may have been deleted. Open all suites to see the ones there are.
                        </EmptyState>
                    </div>
                ) : (
                    <ErrorState error={friendlyError(detail.error?.message)} onRetry={detail.reload} />
                )}
            </>
        );
    }
    const d = detail.data;
    return (
        <>
            {back}
            <SuiteHeader projectId={projectId} d={d} canWrite={canWrite} canRunPerm={canRunPerm} onChanged={detail.reload} />
            <TestsCard projectId={projectId} d={d} canWrite={canWrite} onChanged={detail.reload} />
            <SettingsCard projectId={projectId} d={d} canWrite={canWrite} onChanged={detail.reload} />
            <RunsCard projectId={projectId} d={d} />
        </>
    );
}

// ── the name, description and the suite's actions ───────────────────────────

function SuiteHeader({ projectId, d, canWrite, canRunPerm, onChanged }: { projectId: string; d: SuiteDetailData; canWrite: boolean; canRunPerm: boolean; onChanged: () => Promise<void> }) {
    const s = d.suite;
    const base = `/projects/${projectId}/test-suites/${s.id}`;
    const [editing, setEditing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [busy, setBusy] = useState<"run" | "copy" | "delete" | null>(null);
    const [error, setError] = useState("");
    // A run refused because of the person's runner: the server's sentence, with a link to Settings.
    const [runError, setRunError] = useState<unknown>(null);
    const [started, setStarted] = useState<{ jobId: string; testCount: number; skipped: Array<{ testId: string; reason: string }> } | null>(null);

    // Runners mode: a suite's run goes to the person's own runner, so Run waits until it is set up and online (the server checks again).
    const ready = useReadiness();
    const runnersOnly = ready.mode === "runners";
    const noRunner = runnersOnly && d.canRun.ok && !ready.loading && !ready.ready;
    const runBlock = !d.canRun.ok ? (runnersOnly ? d.canRun.reason ?? "Runs can’t start right now." : "Tests do not run on this server.") : !canRunPerm ? "Running tests needs permission to run tests in this project." : d.tests.length === 0 ? "Add tests to the suite first." : noRunner ? ready.reason : runnersOnly && ready.loading ? "Looking for your runner…" : null;

    async function run() {
        setBusy("run");
        setError("");
        setRunError(null);
        setStarted(null);
        try {
            const r = await api<{ jobId: string; testCount: number; skipped: Array<{ testId: string; reason: string }> }>(`${base}/run`, { method: "POST", body: {} });
            setStarted(r);
            await onChanged();
        } catch (e) {
            if (refusalLink(e)) setRunError(e);
            else setError(describeApiError(e));
            // The server knew better than the page: read the runner again so Run says the same.
            if (isRunnerRefusal(e)) void ready.reload();
        } finally {
            setBusy(null);
        }
    }
    async function duplicate() {
        setBusy("copy");
        setError("");
        try {
            const copy = await api<Suite>(`${base}/duplicate`, { method: "POST", body: {} });
            go(routes.suite(projectId, copy.id));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(null);
        }
    }
    async function remove() {
        setBusy("delete");
        setError("");
        try {
            await api(base, { method: "DELETE" });
            go(routes.suites(projectId));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(null);
            setConfirmDelete(false);
        }
    }

    return (
        <section className="card" aria-labelledby="suite-title">
            <div className="card-pad stack-sm">
                {editing ? (
                    <EditNameForm projectId={projectId} suite={s} onDone={async (saved) => { setEditing(false); if (saved) await onChanged(); }} />
                ) : (
                    <>
                        <div className="row wrap">
                            <h2 className="t-section" id="suite-title">{s.name}</h2>
                            <Badge tone="info">Built by people</Badge>
                            <span className="spacer" />
                            <Button variant="primary" icon={Play} loading={busy === "run"} disabled={Boolean(runBlock)} onClick={() => void run()} tip={runBlock ?? `Runs the ${plural(d.tests.length, "test")} of this suite in this order, with its settings.`}>
                                Run suite
                            </Button>
                        </div>
                        {s.description && <p className="t-secondary suite-description">{s.description}</p>}
                        <p className="t-meta">
                            {plural(d.tests.length, "test")}. {settingsSentence(s.settings, variantLabel)}
                        </p>
                        {canWrite && (
                            <div className="row wrap">
                                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>Rename or describe</Button>
                                <Button size="sm" variant="ghost" icon={Copy} loading={busy === "copy"} onClick={() => void duplicate()} tip="Makes a copy with the same tests, order and settings. Runs and schedules stay with this suite.">Duplicate</Button>
                                {confirmDelete ? (
                                    <>
                                        <span className="t-secondary">Delete this suite? Its tests stay in the project.</span>
                                        <Button size="sm" variant="danger" loading={busy === "delete"} onClick={() => void remove()}>Yes, delete</Button>
                                        <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button>
                                    </>
                                ) : (
                                    <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete</Button>
                                )}
                            </div>
                        )}
                    </>
                )}
                {!d.canRun.ok && (
                    <Callout tone="warning" title={runnersOnly ? "Runs can’t start right now" : "Tests do not run on this server"}>
                        {d.canRun.reason}
                    </Callout>
                )}
                {canRunPerm && d.tests.length > 0 && <RunnerNotReady reason={noRunner ? ready.reason : null} testId="suite-no-runner" />}
                {started && (
                    <Callout tone="success" title="Run started">
                        {plural(started.testCount, "test")} queued in this suite’s order. <a href={routes.run(projectId, started.jobId)}>Follow the run</a>.
                        {started.skipped.length > 0 && (
                            <ul className="suite-skipped">
                                {started.skipped.map((k) => (
                                    <li key={k.testId}>Not run: {k.reason}</li>
                                ))}
                            </ul>
                        )}
                    </Callout>
                )}
                {error && <Callout tone="danger">{error}</Callout>}
                {runError !== null && <RunStartError error={runError} />}
            </div>
        </section>
    );
}

function EditNameForm({ projectId, suite, onDone }: { projectId: string; suite: Suite; onDone: (saved: boolean) => void }) {
    const [name, setName] = useState(suite.name);
    const [description, setDescription] = useState(suite.description);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function save() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/test-suites/${suite.id}`, { method: "PATCH", body: { name, description } });
            onDone(true);
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    return (
        <form
            className="stack-sm suite-form"
            aria-label="Rename or describe the suite"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <div className="field">
                <label htmlFor="suite-rename">Name</label>
                <input id="suite-rename" className="input" value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
                <label htmlFor="suite-redescribe">What it is for</label>
                <textarea id="suite-redescribe" className="input" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>Save</Button>
                <Button type="button" variant="ghost" onClick={() => onDone(false)}>Cancel</Button>
            </div>
        </form>
    );
}

// ── the tests, in run order ─────────────────────────────────────────────────

function TestsCard({ projectId, d, canWrite, onChanged }: { projectId: string; d: SuiteDetailData; canWrite: boolean; onChanged: () => Promise<void> }) {
    const base = `/projects/${projectId}/test-suites/${d.suite.id}`;
    const [order, setOrder] = useState<SuiteTest[]>(d.tests);
    const [picking, setPicking] = useState(false);
    const [error, setError] = useState("");
    const [said, setSaid] = useState("");
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    useEffect(() => setOrder(d.tests), [d.tests]);

    async function saveOrder(next: SuiteTest[], movedTest: SuiteTest) {
        const before = order;
        setOrder(next);
        setError("");
        try {
            await api(`${base}/order`, { method: "PUT", body: { testIds: next.map((t) => t.id) } });
            setSaid(`Moved “${movedTest.title}” to position ${next.indexOf(movedTest) + 1} of ${next.length}.`);
        } catch (e) {
            setOrder(before);
            setError(describeApiError(e));
        }
    }
    const move = (from: number, to: number) => {
        if (to < 0 || to >= order.length || from === to) return;
        void saveOrder(moved(order, from, to), order[from]!);
    };
    async function remove(t: SuiteTest) {
        setError("");
        try {
            await api(`${base}/tests/${t.id}`, { method: "DELETE" });
            setSaid(`Removed “${t.title}” from the suite.`);
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        }
    }

    return (
        <section className="card" aria-labelledby="suite-tests-title">
            <div className="card-head wrap">
                <ListOrdered size={18} aria-hidden />
                <h2 className="t-section" id="suite-tests-title">Tests, in the order they run</h2>
                {order.length > 0 && <BadgeKey label="the test badges" entries={statusKey(order.map((t) => t.validationStatus))} />}
                <span className="spacer" />
                {canWrite && !picking && (
                    <Button size="sm" icon={Plus} onClick={() => setPicking(true)}>Add tests</Button>
                )}
            </div>
            {picking && (
                <TestPicker
                    projectId={projectId}
                    base={base}
                    inSuite={new Set(order.map((t) => t.id))}
                    onClose={async (added) => {
                        setPicking(false);
                        if (added) {
                            setSaid(`Added ${plural(added, "test")} at the end of the suite.`);
                            await onChanged();
                        }
                    }}
                />
            )}
            {order.length === 0 ? (
                !picking && (
                    <EmptyState icon={ListOrdered} title="No tests in this suite yet" actions={canWrite ? <Button variant="primary" icon={Plus} onClick={() => setPicking(true)}>Add tests</Button> : undefined}>
                        Add test cases of this project. They run in the order you put them in.
                    </EmptyState>
                )
            ) : (
                <ol className="list divided suite-tests" aria-label="Tests in this suite">
                    {order.map((t, i) => (
                        <li
                            key={t.id}
                            className={`suite-test${dragFrom === i ? " dragging" : ""}`}
                            data-test={t.testId}
                            draggable={canWrite}
                            onDragStart={(e) => {
                                setDragFrom(i);
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", t.id);
                            }}
                            onDragEnd={() => setDragFrom(null)}
                            onDragOver={(e) => {
                                if (dragFrom !== null) e.preventDefault();
                            }}
                            onDrop={(e) => {
                                e.preventDefault();
                                if (dragFrom !== null) move(dragFrom, i);
                                setDragFrom(null);
                            }}
                        >
                            {canWrite && <GripVertical size={16} className="suite-grip" aria-hidden />}
                            <span className="suite-pos t-mono" aria-hidden>{i + 1}</span>
                            <span className="main">
                                <a className="title" href={routes.test(t.id)}>{t.title}</a>
                                <span className="meta">
                                    {t.testId} · {t.area}
                                </span>
                            </span>
                            <StatusBadge status={t.validationStatus} />
                            {canWrite && (
                                <span className="suite-acts">
                                    <Button size="sm" variant="ghost" iconOnly icon={ArrowUp} disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${t.title} up`} />
                                    <Button size="sm" variant="ghost" iconOnly icon={ArrowDown} disabled={i === order.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move ${t.title} down`} />
                                    <Button size="sm" variant="ghost" iconOnly icon={X} onClick={() => void remove(t)} aria-label={`Remove ${t.title} from the suite`} />
                                </span>
                            )}
                        </li>
                    ))}
                </ol>
            )}
            <p className="sr-only" aria-live="polite">{said}</p>
            {error && (
                <div className="card-pad">
                    <Callout tone="danger">{error}</Callout>
                </div>
            )}
        </section>
    );
}

/** Choose test cases of the project that are not in the suite yet; they are added at the end, in the order of the list. */
function TestPicker({ projectId, base, inSuite, onClose }: { projectId: string; base: string; inSuite: Set<string>; onClose: (added: number) => void }) {
    const tests = useFetch<TestSummary[]>(`/projects/${projectId}/tests`);
    const [q, setQ] = useState("");
    const [chosen, setChosen] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const free = useMemo(() => (tests.data ?? []).filter((t) => !inSuite.has(t.id)), [tests.data, inSuite]);
    const shown = useMemo(() => {
        const words = q.trim().toLowerCase();
        return words ? free.filter((t) => `${t.title} ${t.testId} ${t.suite}`.toLowerCase().includes(words)) : free;
    }, [free, q]);
    const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

    async function add() {
        setBusy(true);
        setError("");
        try {
            // In the order of the list, so the suite reads the way the picker did.
            const ids = free.filter((t) => chosen.includes(t.id)).map((t) => t.id);
            const r = await api<{ added: number }>(`${base}/tests`, { method: "POST", body: { testIds: ids } });
            onClose(r.added);
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <div className="card-pad stack-sm suite-picker" role="group" aria-label="Add tests to the suite">
            <div className="field">
                <label htmlFor="suite-pick-search">Find test cases</label>
                <input id="suite-pick-search" className="input" type="search" value={q} placeholder="Title, ID or area" onChange={(e) => setQ(e.target.value)} />
            </div>
            {tests.loading ? (
                <ListSkeleton rows={3} />
            ) : tests.error ? (
                <ErrorState error={friendlyError(tests.error.message)} onRetry={tests.reload} />
            ) : free.length === 0 ? (
                <p className="t-secondary">{(tests.data ?? []).length === 0 ? "This project has no test cases yet." : "Every test case of this project is already in the suite."}</p>
            ) : (
                <ul className="suite-pick-list" aria-label="Test cases you can add">
                    {shown.map((t) => (
                        <li key={t.id}>
                            <label className="suite-pick">
                                <input type="checkbox" checked={chosen.includes(t.id)} onChange={() => toggle(t.id)} />
                                <span className="main">
                                    <span className="title">{t.title}</span>
                                    <span className="meta">{t.testId} · {t.suite}</span>
                                </span>
                            </label>
                        </li>
                    ))}
                    {shown.length === 0 && <li className="t-secondary">No test case matches “{q}”.</li>}
                </ul>
            )}
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="row">
                <Button variant="primary" loading={busy} disabled={chosen.length === 0} onClick={() => void add()}>
                    {chosen.length ? `Add ${plural(chosen.length, "test")}` : "Add tests"}
                </Button>
                <Button variant="ghost" onClick={() => onClose(0)}>Cancel</Button>
            </div>
        </div>
    );
}

// ── how the suite runs ──────────────────────────────────────────────────────

function SettingsCard({ projectId, d, canWrite, onChanged }: { projectId: string; d: SuiteDetailData; canWrite: boolean; onChanged: () => Promise<void> }) {
    const envs = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const [draft, setDraft] = useState<SuiteSettings>(d.suite.settings);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    useEffect(() => setDraft(d.suite.settings), [d.suite.settings]);
    const env = envs.data?.environments.find((e) => e.name === draft.environment);
    const onEnv = Boolean(draft.environment);
    const changed = JSON.stringify(draft) !== JSON.stringify(d.suite.settings);
    const set = (patch: Partial<SuiteSettings>) => {
        setSaved(false);
        setDraft((cur) => ({ ...cur, ...patch }));
    };

    async function save() {
        setBusy(true);
        setError("");
        try {
            await api(`/projects/${projectId}/test-suites/${d.suite.id}`, { method: "PATCH", body: { settings: draft } });
            setSaved(true);
            await onChanged();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card" aria-labelledby="suite-settings-title">
            <div className="card-head wrap">
                <Settings2 size={18} aria-hidden />
                <h2 className="t-section" id="suite-settings-title">How it runs</h2>
            </div>
            <form
                className="card-pad stack suite-settings"
                aria-label="How the suite runs"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <fieldset disabled={!canWrite} className="stack-sm">
                    <div className="field">
                        <label htmlFor="suite-env">Where the tests run</label>
                        <select
                            id="suite-env"
                            className="input"
                            value={draft.environment ?? ""}
                            onChange={(e) => {
                                const v = e.target.value || null;
                                // An environment run checks desktop Chrome once per test and runs them all: the other options do not apply there.
                                set(v ? { environment: v, confirmProduction: false, browsers: [], retries: 0, stopOnFirstFailure: false } : { environment: null, confirmProduction: false });
                            }}
                        >
                            <option value="">The project’s own address</option>
                            {(envs.data?.environments ?? []).map((e) => (
                                <option key={e.id} value={e.name}>
                                    {e.name}
                                    {e.production ? " (production)" : ""}
                                </option>
                            ))}
                            {draft.environment && !env && !envs.loading && <option value={draft.environment}>{draft.environment} (no longer exists)</option>}
                        </select>
                        <p className="hint">Environments are set up in Settings, Environments.</p>
                    </div>
                    {env?.production && (
                        <label className="check">
                            <input type="checkbox" checked={draft.confirmProduction} onChange={(e) => set({ confirmProduction: e.target.checked })} />
                            <span>
                                <span className="title">Yes, run this suite on production</span>
                                <span className="hint">{PRODUCTION_WARNING}</span>
                            </span>
                        </label>
                    )}
                    {onEnv && <p className="t-secondary">A run against an environment checks desktop Chrome only, runs each test once and runs every test. The options below apply to runs against the project’s own address.</p>}
                    <fieldset className="stack-sm" disabled={onEnv || !canWrite}>
                        <legend className="label">Also check on</legend>
                        <div className="suite-browsers">
                            {VARIANT_UI.map((v) => (
                                <label key={v.id} className="check">
                                    <input type="checkbox" checked={draft.browsers.includes(v.id)} onChange={(e) => set({ browsers: e.target.checked ? [...draft.browsers, v.id] : draft.browsers.filter((b: VariantId) => b !== v.id) })} />
                                    <span>
                                        <span className="title">{v.label}</span>
                                        <span className="hint">{v.hint}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                        <p className="hint">Desktop Chrome always runs. Tests that pass there are also checked on the ones you choose.</p>
                        <div className="field">
                            <label htmlFor="suite-retries">When a test fails</label>
                            <select id="suite-retries" className="input" value={draft.retries} onChange={(e) => set({ retries: Number(e.target.value) })}>
                                <option value={0}>Report the failure</option>
                                <option value={1}>Run it again once</option>
                                <option value={2}>Run it again up to twice</option>
                            </select>
                            <p className="hint">A test that passes when run again is marked unreliable instead of failed.</p>
                        </div>
                        <label className="check">
                            <input type="checkbox" checked={draft.stopOnFirstFailure} onChange={(e) => set({ stopOnFirstFailure: e.target.checked })} />
                            <span>
                                <span className="title">Stop at the first failure</span>
                                <span className="hint">Tests run one at a time in the suite’s order. The tests after a failure are not run.</span>
                            </span>
                        </label>
                    </fieldset>
                </fieldset>
                <p className="t-meta">
                    {d.where ? `Where tests run: ${d.where} ` : ""}
                    Every run goes to the runner of the person who starts it: <a href={routes.yourRunner}>Your runner in Settings</a>.
                </p>
                {error && <Callout tone="danger">{error}</Callout>}
                {saved && !changed && <Callout tone="success">Saved. The next run uses these settings.</Callout>}
                {canWrite && (
                    <div className="row">
                        <Button type="submit" variant="primary" loading={busy} disabled={!changed}>Save settings</Button>
                        {changed && <Button type="button" variant="ghost" onClick={() => setDraft(d.suite.settings)}>Discard changes</Button>}
                    </div>
                )}
            </form>
        </section>
    );
}

// ── runs and schedules ──────────────────────────────────────────────────────

function RunsCard({ projectId, d }: { projectId: string; d: SuiteDetailData }) {
    return (
        <section className="card" aria-labelledby="suite-runs-title">
            <div className="card-head wrap">
                <Play size={18} aria-hidden />
                <h2 className="t-section" id="suite-runs-title">Last runs</h2>
                {d.runs.length > 0 && <BadgeKey label="the run badges" entries={jobKey(d.runs.map((r) => r.job))} />}
            </div>
            {d.runs.length === 0 ? (
                <div className="card-pad">
                    <p className="t-secondary">This suite has not run yet.</p>
                </div>
            ) : (
                <ul className="list divided" aria-label="Last runs of this suite">
                    {d.runs.map((r) => (
                        <li key={r.jobId}>
                            <a className="list-row" href={routes.run(projectId, r.jobId)} data-run={r.jobId}>
                                <span className="main">
                                    <span className="title">{runResult(r)}</span>
                                    <span className="meta">
                                        {r.trigger === "schedule" ? "Started by a schedule" : "Started by a person"} {relativeTime(r.createdAt)}
                                        {r.job.environment ? `, against “${r.job.environment}”` : ""}
                                    </span>
                                </span>
                                <span className="tail">
                                    <JobBadge job={r.job} />
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            )}
            <div className="card-pad suite-schedules">
                <div className="row wrap">
                    <CalendarClock size={16} aria-hidden />
                    <span className="t-secondary">
                        {d.schedules.length === 0 ? "No schedule runs this suite." : `Run on a schedule by ${d.schedules.map((s) => `“${s.name}”${s.enabled ? "" : " (paused)"}`).join(", ")}.`}
                    </span>
                    <a href={routes.runs(projectId, "schedules")}>Open schedules</a>
                </div>
            </div>
        </section>
    );
}
