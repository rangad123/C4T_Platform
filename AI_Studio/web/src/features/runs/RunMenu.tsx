import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type TestSummary } from "../../api";
import { Button, Callout, Disclosure } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { help } from "../../lib/help";
import { useConfig, useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import type { Agent, RunnerChoice } from "../agents/agents";
import { PRODUCTION_WARNING, type Environment } from "../environments/environments";
import { announceRunsChanged, planSentence, useActiveRun } from "./runs";
import { resetSentence, type ResetAnswer } from "../webpages/webpages";
import "./runs.css";

type What = "failing" | "group" | "selected" | "all" | "notrun" | "test" | "fixed";
/** "platform" = this server, "any" = whichever runner is online, otherwise a runner's id. */
type Place = string;

export interface RunMenuProps {
    projectId: string;
    /** "project": choose among the project's tests. "test": this one test. "fixed": exactly the tests given (for example the failing ones of a run). */
    scope?: "project" | "test" | "fixed";
    /** scope "project": the tests the choices count. */
    tests?: Array<Pick<TestSummary, "id" | "suite" | "validationStatus" | "kind">>;
    /** scope "project": the tests ticked in the list. */
    selectedIds?: string[];
    /** scope "test". */
    test?: { id: string; kind: string };
    /** scope "fixed": what is run, said in words ("the 4 failing tests of this run"), and which tests. */
    fixed?: { ids: string[]; description: string; environment?: string };
    label?: string;
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
    /** Test scope: the main button runs at once with the project's settings; the arrow opens the choices. */
    split?: boolean;
    onStarted?: (jobId: string) => void;
    /** Where to say why a run could not start when the panel is closed (the split button starts without opening it). Without it the error is kept for the panel. */
    onError?: (message: string) => void;
}

interface Started {
    jobId: string;
    testCount?: number;
    skipped?: Array<{ reason: string }>;
}

/** Why the Run controls wait while another run of the project is going (the run strip above shows that run and its Stop button). */
const BUSY = "A run is going. Stop it or wait for it to finish.";

/** Environment runs leave out phone and desktop tests (they run only against a web address). */
const runsOnEnvironment = (t: { kind: string }) => t.kind === "web" || t.kind === "api";

export function RunMenu({ projectId, scope = "project", tests = [], selectedIds = [], test, fixed, label, variant = "secondary", size = "md", split, onStarted, onError }: RunMenuProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const panelId = useId();
    /** The panel opens under the button, from its left edge; when that would run off the right of the screen it opens from the right edge instead. */
    const [flip, setFlip] = useState(false);
    useLayoutEffect(() => {
        if (!open) return setFlip(false);
        const pop = root.current?.querySelector<HTMLElement>(".run-pop");
        const anchor = root.current;
        if (!pop || !anchor) return;
        const w = pop.getBoundingClientRect().width;
        setFlip(anchor.getBoundingClientRect().left + w > window.innerWidth - 16);
    }, [open]);
    const active = useActiveRun(projectId);
    const busyRun = Boolean(active.job);

    // The panel looks things up only while it is open, so a closed one costs nothing and an open one shows who is online now.
    const agents = useFetch<Agent[]>(open ? `/projects/${projectId}/agents` : null);
    const runner = useFetch<RunnerChoice>(open ? `/projects/${projectId}/runner` : null);
    const envs = useFetch<{ environments: Environment[] }>(open ? `/projects/${projectId}/environments` : null);
    // The test data reset that runs first, if one is switched on (said in the sentence below).
    const resets = useFetch<ResetAnswer>(open ? `/projects/${projectId}/test-data-reset` : null);
    const config = useConfig();

    const [what, setWhat] = useState<What>(scope === "test" ? "test" : scope === "fixed" ? "fixed" : "failing");
    const [group, setGroup] = useState("");
    const [place, setPlace] = useState<Place | null>(null);
    const [environment, setEnvironment] = useState("");
    const [confirmProduction, setConfirmProduction] = useState(false);
    const [variantsPicked, setVariantsPicked] = useState<string[]>([]);
    const [retry, setRetry] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState("");

    // The choices and how many tests each holds, from the project's tests as they are now.
    const choice = useMemo(() => {
        const failing = tests.filter((t) => t.validationStatus === "FAILED_VALIDATION");
        const notrun = tests.filter((t) => t.validationStatus === "PENDING");
        const groups = [...new Set(tests.map((t) => t.suite))].sort().map((name) => ({ name, count: tests.filter((t) => t.suite === name).length }));
        const picked = tests.filter((t) => selectedIds.includes(t.id));
        return { failing, notrun, picked, groups };
    }, [tests, selectedIds]);

    // When the panel opens: start from the most useful choice (ticked tests, else the failing ones, else all) and forget an old error.
    useEffect(() => {
        if (!open) return;
        setError("");
        if (scope !== "project") return;
        setWhat(choice.picked.length ? "selected" : choice.failing.length ? "failing" : "all");
        setGroup((g) => g || choice.groups[0]?.name || "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Where it runs now: what the project already uses, until the person picks something else.
    const current: Place = runner.data ? (runner.data.runOn === "agent" ? (runner.data.agentId ?? "any") : "platform") : "platform";
    const chosenPlace = place ?? current;
    useEffect(() => {
        if (!open) setPlace(null);
    }, [open]);
    useEffect(() => {
        if (fixed?.environment) setEnvironment(fixed.environment);
    }, [fixed?.environment]);
    // The environment marked Default is preselected (environments-store.ts: never a production one), until the person picks a
    // place themselves; that choice then stays while this page is open, as before. A test that cannot run on an environment (phone,
    // desktop) keeps the project address. "Fixed" runs keep the place of the run they repeat.
    const pickedEnvironment = useRef(false);
    const defaultEnv = (envs.data?.environments ?? []).find((e) => e.isDefault && !e.production)?.name ?? "";
    useEffect(() => {
        if (!open || scope === "fixed" || pickedEnvironment.current || !envs.data) return;
        setEnvironment(scope === "test" && test && !runsOnEnvironment(test) ? "" : defaultEnv);
        setConfirmProduction(false);
    }, [open, scope, defaultEnv, envs.data, test?.kind]);
    const pickEnvironment = (name: string) => {
        pickedEnvironment.current = true;
        setEnvironment(name);
        setConfirmProduction(false);
    };
    // Until the environments are known, a run could start at the wrong place.
    const envsPending = scope !== "fixed" && open && envs.loading && !envs.data;

    // Escape closes and gives the focus back; so does a press outside.
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            root.current?.querySelector<HTMLElement>(".run-toggle")?.focus();
        };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLElement>(".run-pop input:not(:disabled), .run-pop button")?.focus();
    }, [open]);

    const onlineAgents = (agents.data ?? []).filter((a) => a.online);
    const placeName = (p: Place): string | null => (p === "platform" ? null : p === "any" ? (onlineAgents.length === 1 ? onlineAgents[0]!.name : "a runner") : ((agents.data ?? []).find((a) => a.id === p)?.name ?? "a runner"));
    const env = (envs.data?.environments ?? []).find((e) => e.name === environment);
    const hasEnvs = (envs.data?.environments ?? []).length > 0;

    // Which tests this run covers.
    const ids: string[] = useMemo(() => {
        if (scope === "test") return test ? [test.id] : [];
        if (scope === "fixed") return fixed?.ids ?? [];
        switch (what) {
            case "failing":
                return choice.failing.map((t) => t.id);
            case "group":
                return tests.filter((t) => t.suite === group).map((t) => t.id);
            case "selected":
                return choice.picked.map((t) => t.id);
            case "notrun":
                return choice.notrun.map((t) => t.id);
            default:
                return tests.map((t) => t.id);
        }
    }, [scope, what, group, test, fixed, tests, choice]);
    const kindOf = (id: string) => (scope === "test" ? test?.kind : tests.find((t) => t.id === id)?.kind) ?? "web";
    const runnable = environment && scope !== "fixed" ? ids.filter((id) => runsOnEnvironment({ kind: kindOf(id) })) : ids;
    const leftOut = environment && scope !== "fixed" ? ids.length - runnable.length : 0;
    const count = scope === "fixed" ? ids.length : runnable.length;

    const variantList = (config?.variants ?? []).filter((v) => v.available);
    const sentence = planSentence({
        count,
        runner: placeName(chosenPlace),
        ...(environment ? { environment } : {}),
        variants: variantList.filter((v) => variantsPicked.includes(v.id)).map((v) => v.label),
        retry,
        leftOut,
        before: resetSentence(resets.data?.hooks, environment),
    });
    const needsConfirm = Boolean(env?.production);

    async function start(direct = false) {
        setStarting(true);
        setError("");
        try {
            // A different place is the project's setting: it is changed first, and the sentence above says so.
            if (!direct && place && place !== current) {
                await api(`/projects/${projectId}/runner`, { method: "PUT", body: place === "platform" ? { runOn: "platform" } : { runOn: "agent", agentId: place === "any" ? null : place } });
            }
            let out: Started;
            if (direct || (scope === "test" && !environment && !retry && variantsPicked.length === 0)) {
                // One test, nothing special: the test's own run route (it also explains in words why a test cannot run here).
                out = await api<Started>(`/tests/${test!.id}/validate`, { method: "POST" });
            } else if (scope === "test" && environment) {
                out = await api<Started>(`/tests/${test!.id}/validate`, { method: "POST", body: { environment, ...(needsConfirm ? { confirmProduction: true } : {}) } });
            } else if (environment) {
                out = await api<Started>(`/projects/${projectId}/environments/${encodeURIComponent(environment)}/runs`, { method: "POST", body: { testIds: runnable, ...(needsConfirm ? { confirmProduction: true } : {}) } });
            } else {
                const all = scope === "project" && what === "all" && !variantsPicked.length && !retry;
                out = await api<Started>(`/projects/${projectId}/runs`, { method: "POST", body: { ...(all ? {} : { testIds: ids }), ...(retry ? { retryFailures: 1 } : {}), ...(variantsPicked.length ? { variants: variantsPicked } : {}) } });
            }
            setOpen(false);
            announceRunsChanged();
            onStarted?.(out.jobId);
        } catch (e) {
            const text = describeApiError(e);
            if (direct && onError) onError(text);
            else setError(text);
        } finally {
            setStarting(false);
        }
    }

    const main = label ?? (scope === "test" ? "Run again" : "Run");
    const radio = (key: What, text: string, n: number | null, extra?: React.ReactNode, disabled?: boolean) => (
        <label className={`run-opt${disabled ? " is-off" : ""}`}>
            <input type="radio" name={`${panelId}-what`} checked={what === key} disabled={disabled} onChange={() => setWhat(key)} />
            <span className="text">
                {text}
                {n !== null ? ` (${n})` : ""}
            </span>
            {extra}
        </label>
    );

    return (
        <div className={`run-menu${split ? " is-split" : ""}`} ref={root} data-tour="run">
            {split && (
                <Button variant={variant} size={size} disabled={busyRun || starting} loading={starting && !open} onClick={() => void start(true)} tip={busyRun ? BUSY : "Runs it now where this project runs its tests."} className="run-main">
                    {main}
                </Button>
            )}
            <Button
                variant={variant}
                size={size}
                className={split ? "run-toggle run-arrow" : "run-toggle"}
                icon={split ? undefined : Play}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-label={split ? "More ways to run" : undefined}
                disabled={busyRun && !open}
                tip={busyRun && !open ? BUSY : split ? "Choose which tests, where they run and how." : undefined}
                onClick={() => setOpen((o) => !o)}
            >
                {split ? null : main}
                <ChevronDown size={size === "sm" ? 16 : 18} aria-hidden />
            </Button>
            {open && (
                <div className={`run-pop${flip ? " is-flipped" : ""}`} id={panelId} role="group" aria-label="Run settings">
                    <fieldset className="run-sec">
                        <legend>What</legend>
                        {scope === "test" && <p className="t-secondary">This test.</p>}
                        {scope === "fixed" && <p className="t-secondary">{fixed?.description}</p>}
                        {scope === "project" && (
                            <>
                                {radio("failing", "Failing now", choice.failing.length, undefined, choice.failing.length === 0)}
                                <label className={`run-opt${tests.length === 0 ? " is-off" : ""}`}>
                                    <input type="radio" name={`${panelId}-what`} checked={what === "group"} disabled={tests.length === 0} onChange={() => setWhat("group")} />
                                    <span className="text">This group</span>
                                    <select
                                        className="input run-group"
                                        aria-label="Group"
                                        value={group}
                                        onChange={(e) => {
                                            setGroup(e.target.value);
                                            setWhat("group");
                                        }}
                                    >
                                        {choice.groups.map((g) => (
                                            <option key={g.name} value={g.name}>
                                                {g.name} ({g.count})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                {radio("selected", "Selected tests", choice.picked.length, choice.picked.length === 0 ? <span className="t-meta">Choose Select tests in the list</span> : undefined, choice.picked.length === 0)}
                                {radio("all", "All tests", tests.length, undefined, tests.length === 0)}
                                {radio("notrun", "Not run yet", choice.notrun.length, undefined, choice.notrun.length === 0)}
                            </>
                        )}
                    </fieldset>

                    <fieldset className="run-sec">
                        <legend>
                            Where{" "}
                            {/* Only once runners are listed: the panel's first focus (set when it opens) stays where it was. */}
                            {agents.data?.length ? <HelpTip label="online and offline runners" text={`Online: ${help("runner", "online")} Offline: nothing heard from it in the last 45 seconds, so it cannot be picked here.`} /> : null}
                        </legend>
                        {runner.error || agents.error ? (
                            <p className="t-secondary">Runs on this server.</p>
                        ) : !agents.data || !runner.data ? (
                            <p className="t-meta" role="status">Looking for runners…</p>
                        ) : (
                            <>
                                <label className="run-opt">
                                    <input type="radio" name={`${panelId}-where`} checked={chosenPlace === "platform"} onChange={() => setPlace("platform")} />
                                    <span className="text">This server</span>
                                </label>
                                {current === "any" && (
                                    <label className="run-opt">
                                        <input type="radio" name={`${panelId}-where`} checked={chosenPlace === "any"} onChange={() => setPlace("any")} />
                                        <span className="text">Any runner that is online</span>
                                    </label>
                                )}
                                {agents.data.map((a) => (
                                    <label key={a.id} className={`run-opt${a.online ? "" : " is-off"}`}>
                                        <input type="radio" name={`${panelId}-where`} checked={chosenPlace === a.id} disabled={!a.online} onChange={() => setPlace(a.id)} />
                                        <span className="text">{a.name}</span>
                                        <span className={`run-online ${a.online ? "is-on" : ""}`}>{a.online ? "online" : "offline"}</span>
                                    </label>
                                ))}
                                {agents.data.length === 0 && <p className="t-meta">No runner is connected. Tests run on this server.</p>}
                                {place && place !== current && <p className="t-meta">This also becomes where this project runs its tests, until you change it.</p>}
                            </>
                        )}
                        {hasEnvs && scope !== "fixed" && (
                            <div className="run-against">
                                <label className="run-opt">
                                    <input type="radio" name={`${panelId}-against`} checked={environment === ""} onChange={() => pickEnvironment("")} />
                                    <span className="text">Project address</span>
                                </label>
                                {(envs.data?.environments ?? []).map((e) => (
                                    <label key={e.id} className="run-opt">
                                        <input type="radio" name={`${panelId}-against`} checked={environment === e.name} onChange={() => pickEnvironment(e.name)} />
                                        <span className="text">{e.name}{e.production ? " (production)" : ""}</span>                                    </label>
                                ))}
                            </div>
                        )}
                        {needsConfirm && (
                            <label className="run-opt run-production">
                                <input type="checkbox" checked={confirmProduction} onChange={(e) => setConfirmProduction(e.target.checked)} />
                                <span className="text">Yes, run on production</span>
                                <span className="t-meta">{PRODUCTION_WARNING}</span>
                            </label>
                        )}
                    </fieldset>

                    {!environment && (
                        <Disclosure label="How">
                            <div className="run-how">
                                {variantList.map((v) => (
                                    <label key={v.id} className="run-opt">
                                        <input type="checkbox" checked={variantsPicked.includes(v.id)} onChange={(e) => setVariantsPicked((p) => (e.target.checked ? [...p, v.id] : p.filter((x) => x !== v.id)))} />
                                        <span className="text">
                                            Also check on {v.label}
                                            <span className="t-meta"> {v.description}</span>
                                        </span>
                                    </label>
                                ))}
                                <label className="run-opt">
                                    <input type="checkbox" checked={retry} onChange={(e) => setRetry(e.target.checked)} />
                                    <span className="text">
                                        Run failing tests once more straight away
                                        <span className="t-meta"> If it passes the second time, the test is marked unreliable, not failing.</span>
                                    </span>
                                </label>
                            </div>
                        </Disclosure>
                    )}

                    <p className="run-sentence" data-testid="run-sentence" role="status">
                        {sentence}
                    </p>
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div className="run-foot">
                        <Button onClick={() => setOpen(false)}>Close</Button>
                        <Button variant="primary" icon={Play} loading={starting} disabled={count === 0 || (needsConfirm && !confirmProduction) || busyRun || envsPending} onClick={() => void start()}>
                            Start run
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
