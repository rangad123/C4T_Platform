import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type ProjectDetail, type TestSummary } from "../../api";
import { Button, Callout, Disclosure, LinkButton } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { help } from "../../lib/help";
import { useConfig, useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import type { RunnerChoice } from "../agents/agents";
import { PRODUCTION_WARNING, type Environment } from "../environments/environments";
import { announceRunsChanged, planSentence, useActiveRun } from "./runs";
import { ADD_THIS_COMPUTER_HREF, DISPATCH_OFF, NO_NEEDS, NO_RUN_PERMISSION, NO_RUNNER_ONLINE, NO_RUNNER_PERSONAL_HINT, NO_RUNNER_TEAM_HINT, NO_RUNNER_TIP, NO_RUNNER_TITLE, PROJECT_ON_SERVER, RUNS_OFF_HERE, RUNS_OFF_TIP, defaultChoice, executionModeOf, codeScriptsNotice, kindWord, sortChoices, useRunnerChoices, whyNotRunner, type RunNeeds } from "./runs-here";
import { resetSentence, type ResetAnswer } from "../webpages/webpages";
import "./runs.css";

type What = "failing" | "group" | "selected" | "all" | "notrun" | "test" | "fixed";
/**
 * "platform" = this server (local mode only), "any" = whichever runner may take it, "project" = wherever the project's setting says
 * (when the runners cannot be listed), otherwise a runner's id, sent as `runnerId` for this run only.
 */
type Place = string;
const NOT_A_RUNNER = new Set(["platform", "any", "project"]);

export interface RunMenuProps {
    projectId: string;
    /** "project": choose among the project's tests. "test": this one test. "fixed": exactly the tests given (for example the failing ones of a run). */
    scope?: "project" | "test" | "fixed";
    /** scope "project": the tests the choices count. */
    tests?: Array<Pick<TestSummary, "id" | "suite" | "validationStatus" | "kind"> & { custom?: unknown }>;
    /** scope "project": the tests ticked in the list. */
    selectedIds?: string[];
    /** scope "test". */
    test?: { id: string; kind: string; custom?: unknown };
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
    // What this person may do in this project: without ai_studio.tests.run, Run is shown switched off with the reason, not as a
    // button that only answers with a refusal. An older server sends no `access`: then nothing is assumed.
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const perms = project.data?.access?.permissions;
    const noPermission = Boolean(perms) && !perms!.includes("ai_studio.tests.run");

    const config = useConfig();
    // Runners mode (the hosted platform): every run goes to a runner, so "This server" is never offered, and Run waits for a runner
    // this person may use here. The runners are read while the button is shown (slowly polled) so the button can say so before a click.
    const runnersOnly = executionModeOf(config) === "runners";
    // The panel looks things up only while it is open, so a closed one costs nothing and an open one shows who is online now.
    const choicesF = useRunnerChoices(projectId, runnersOnly || open, runnersOnly ? 15_000 : 0);
    const runner = useFetch<RunnerChoice>(open ? `/projects/${projectId}/runner` : null);
    const envs = useFetch<{ environments: Environment[] }>(open ? `/projects/${projectId}/environments` : null);
    // The test data reset that runs first, if one is switched on (said in the sentence below).
    const resets = useFetch<ResetAnswer>(open ? `/projects/${projectId}/test-data-reset` : null);
    // Tests switched off on this server: said on the button and in the panel, and nothing is started (the server refuses too).
    // In runners mode the same answer means the platform's dispatch is not running, so no runner gets a run either.
    const off = config?.runsHere === false;
    const offText = runnersOnly ? DISPATCH_OFF : RUNS_OFF_TIP;
    useEffect(() => {
        if (open && runnersOnly) void choicesF.reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

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

    // What this run needs from the runner that takes it, from the tests it covers (a "fixed" run knows only ids: the server checks).
    const needs: RunNeeds = useMemo(() => {
        if (scope === "fixed") return NO_NEEDS;
        const picked = scope === "test" ? (test ? [test] : []) : tests.filter((t) => runnable.includes(t.id));
        return { web: picked.some((t) => t.kind === "web" || t.kind === "api"), mobile: picked.some((t) => t.kind === "mobile"), code: picked.some((t) => Boolean(t.custom)) };
    }, [scope, test, tests, runnable]);

    // Where it can run. The runners this person may use here (their own computers first), each with the reason it cannot take this
    // run, if any; "This server" only on a platform that runs tests itself and only while the project runs there (a run cannot be
    // sent to the server alone: choosing it would change the project's setting, which belongs on the Runners page).
    const choices = choicesF.data;
    const rows = choices ? sortChoices(choices.runners) : [];
    const projectOnServer = !runnersOnly && runner.data?.runOn !== "agent";
    const why = (id: string) => {
        const r = rows.find((x) => x.id === id);
        if (!r) return "Not available.";
        return whyNotRunner(r, needs, choices?.allowPersonal) ?? (projectOnServer ? PROJECT_ON_SERVER : null);
    };
    const usable = rows.filter((r) => !why(r.id));
    // "Any runner that is online": only while several can take it and the project has no default runner (the platform then gives it to whichever is free).
    const offerAny = !!choices && !choices.defaultRunnerId && usable.length > 1;
    const fallbackPlace: Place | null = choices ? (projectOnServer ? "platform" : defaultChoice(choices, needs)) : choicesF.error ? (projectOnServer ? "platform" : "project") : null;
    const pickable = (p: Place) => (p === "platform" ? projectOnServer : p === "any" ? offerAny : p === "project" ? !choices : !why(p));
    const chosenPlace: Place | null = place && pickable(place) ? place : fallbackPlace;
    // Runners mode, none online that this person may use (whatever the tests): the main button waits, the panel says what to do.
    const noRunner = runnersOnly && !!choices && !choices.runners.some((r) => !whyNotRunner(r, NO_NEEDS, choices.allowPersonal));
    const choicesPending = (runnersOnly || open) && choicesF.loading && !choices;
    const placeName = (p: Place | null): string | null => {
        if (p === "platform") return null;
        if (p === "any") return usable.length === 1 ? usable[0]!.name : "a runner that is online";
        if (p === "project" || p === null) return runner.data?.runOn === "agent" || runnersOnly ? "the project’s runner" : null;
        return rows.find((r) => r.id === p)?.name ?? "a runner";
    };
    const runnerId = chosenPlace && !NOT_A_RUNNER.has(chosenPlace) ? chosenPlace : undefined;
    // Code scripts going to the person's own computer: said before Start, with who wrote them when the platform says so (a test's
    // script versions carry who saved each; the list of tests does not, so a project run names nobody), and where to switch them off.
    const ownRunner = runnerId ? rows.find((r) => r.id === runnerId && r.mine) : undefined;
    const codeToOwn = Boolean(ownRunner) && needs.code;
    const versions = useFetch<Array<{ by: string | null }>>(open && codeToOwn && scope === "test" && test ? `/tests/${test.id}/script-versions` : null);
    const authors = [...new Set((versions.data ?? []).map((v) => v.by?.trim()).filter((b): b is string => Boolean(b)))];

    const variantList = (config?.variants ?? []).filter((v) => v.available);
    // Runners are listed, and none of them can take this run: each says why, and nothing claims where it would run.
    const sentence = chosenPlace === null && choices ? (noRunner ? NO_RUNNER_ONLINE : "None of the runners you can use can take this run. Each one says why.") : planSentence({
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
            // The runner picked here is for this run only (`runnerId`): the project's setting does not change. The main button of a
            // split control sends none, so the platform uses the project's default runner, or any runner that may take it.
            const where = !direct && runnerId ? { runnerId } : {};
            let out: Started;
            if (direct || (scope === "test" && !environment && !retry && variantsPicked.length === 0)) {
                // One test, nothing special: the test's own run route (it also explains in words why a test cannot run here).
                out = await api<Started>(`/tests/${test!.id}/validate`, { method: "POST", ...(where.runnerId ? { body: where } : {}) });
            } else if (scope === "test" && environment) {
                out = await api<Started>(`/tests/${test!.id}/validate`, { method: "POST", body: { environment, ...(needsConfirm ? { confirmProduction: true } : {}), ...where } });
            } else if (environment) {
                out = await api<Started>(`/projects/${projectId}/environments/${encodeURIComponent(environment)}/runs`, { method: "POST", body: { testIds: runnable, ...(needsConfirm ? { confirmProduction: true } : {}), ...where } });
            } else {
                const all = scope === "project" && what === "all" && !variantsPicked.length && !retry;
                out = await api<Started>(`/projects/${projectId}/runs`, { method: "POST", body: { ...(all ? {} : { testIds: ids }), ...(retry ? { retryFailures: 1 } : {}), ...(variantsPicked.length ? { variants: variantsPicked } : {}), ...where } });
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
                <Button variant={variant} size={size} disabled={noPermission || busyRun || starting || off || noRunner || (runnersOnly && choicesPending)} loading={starting && !open} onClick={() => void start(true)} tip={noPermission ? NO_RUN_PERMISSION : off ? offText : busyRun ? BUSY : noRunner ? NO_RUNNER_TIP : runnersOnly ? "Runs it now on the project’s default runner, or on a runner of yours or the team’s that is online." : "Runs it now where this project runs its tests."} className="run-main">
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
                disabled={noPermission || (busyRun && !open)}
                tip={noPermission ? NO_RUN_PERMISSION : off && !open ? offText : busyRun && !open ? BUSY : noRunner && !open ? NO_RUNNER_TIP : split ? "Choose which tests, where they run and how." : undefined}
                onClick={() => setOpen((o) => !o)}
            >
                {split ? null : main}
                <ChevronDown size={size === "sm" ? 16 : 18} aria-hidden />
            </Button>
            {open && (
                <div className={`run-pop${flip ? " is-flipped" : ""}`} id={panelId} role="group" aria-label="Run settings">
                    {off && !runnersOnly && (
                        <Callout tone="warning" title="Tests do not run here">
                            <span data-testid="runs-off">{RUNS_OFF_HERE} Run them where tests run, or once tests are switched on here.</span>
                        </Callout>
                    )}
                    {off && runnersOnly && (
                        <Callout tone="warning" title="Runs can’t start right now">
                            <span data-testid="runs-off">{DISPATCH_OFF}</span>
                        </Callout>
                    )}
                    {!off && noRunner && (
                        <div data-testid="no-runner">
                            <Callout
                                tone="warning"
                                title={NO_RUNNER_TITLE}
                                actions={
                                    <>
                                        {choices?.allowPersonal && <LinkButton size="sm" variant="primary" href={ADD_THIS_COMPUTER_HREF}>Add this computer</LinkButton>}
                                        <LinkButton size="sm" href={routes.runners(projectId)}>See this project’s runners</LinkButton>
                                    </>
                                }
                            >
                                {choices?.allowPersonal ? NO_RUNNER_PERSONAL_HINT : NO_RUNNER_TEAM_HINT}
                            </Callout>
                        </div>
                    )}
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
                                {radio("selected", "Selected tests", choice.picked.length, choice.picked.length === 0 ? <span className="t-meta">Choose Select scripts in the list</span> : undefined, choice.picked.length === 0)}
                                {radio("all", "All tests", tests.length, undefined, tests.length === 0)}
                                {radio("notrun", "Not run yet", choice.notrun.length, undefined, choice.notrun.length === 0)}
                            </>
                        )}
                    </fieldset>

                    <fieldset className="run-sec">
                        <legend>
                            Where{" "}
                            {/* Only once runners are listed: the panel's first focus (set when it opens) stays where it was. */}
                            {rows.length ? <HelpTip label="online and offline runners" text={`Online: ${help("runner", "online")} Offline: nothing heard from it in the last 45 seconds, so it cannot be picked here.`} /> : null}
                        </legend>
                        {choicesPending || (!choices && !choicesF.error) || (!runnersOnly && runner.loading && !runner.data) ? (
                            <p className="t-meta" role="status">Looking for runners…</p>
                        ) : !choices ? (
                            // The runners cannot be listed (an older server, or no answer): the project's setting decides, as the platform says it.
                            <p className="t-secondary">{runner.data?.status ?? (runnersOnly ? "Runs on a runner of this project." : "Runs on this server.")}</p>
                        ) : (
                            <>
                                {projectOnServer && (
                                    <label className="run-opt">
                                        <input type="radio" name={`${panelId}-where`} checked={chosenPlace === "platform"} onChange={() => setPlace("platform")} />
                                        <span className="text">This server</span>
                                    </label>
                                )}
                                {offerAny && !projectOnServer && (
                                    <label className="run-opt">
                                        <input type="radio" name={`${panelId}-where`} checked={chosenPlace === "any"} onChange={() => setPlace("any")} />
                                        <span className="text">
                                            Any runner that is online
                                            <span className="t-meta">Whichever of the {usable.length} below is free first.</span>
                                        </span>
                                    </label>
                                )}
                                {rows.map((r) => {
                                    const no = why(r.id);
                                    return (
                                        <label key={r.id} className={`run-opt${no ? " is-off" : ""}`} data-runner={r.id}>
                                            <input type="radio" name={`${panelId}-where`} checked={chosenPlace === r.id} disabled={Boolean(no)} onChange={() => setPlace(r.id)} />
                                            <span className="text">
                                                {r.name}
                                                {no && no !== PROJECT_ON_SERVER ? <span className="t-meta">{no}</span> : !no && r.busy ? <span className="t-meta">Busy with another run: this one waits until it is free.</span> : null}
                                            </span>
                                            <span className={`run-online ${r.online ? "is-on" : ""}`}>
                                                {kindWord(r)} · {r.online ? (r.busy ? "busy" : "online") : "offline"}
                                            </span>
                                        </label>
                                    );
                                })}
                                {rows.length === 0 && <p className="t-meta">{runnersOnly ? "No runner is connected." : "No runner is connected. Tests run on this server."}</p>}
                                {projectOnServer && rows.length > 0 && <p className="t-meta" data-testid="project-on-server">{PROJECT_ON_SERVER}</p>}
                                {runnerId && <p className="t-meta">Only this run goes there. Where the project runs its tests does not change.</p>}
                                {codeToOwn && ownRunner && (
                                    <div data-testid="code-on-own">
                                        <Callout tone="warning" actions={<a href={routes.runner(ownRunner.id)}>Open {ownRunner.name}’s page to switch code scripts off</a>}>
                                            {codeScriptsNotice(authors)}
                                        </Callout>
                                    </div>
                                )}
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
                        <Button variant="primary" icon={Play} loading={starting} disabled={noPermission || off || count === 0 || (needsConfirm && !confirmProduction) || busyRun || envsPending || choicesPending || chosenPlace === null} onClick={() => void start()}>
                            Start run
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
