import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, ApiError, type TestSummary } from "../../api";
import { Tooltip } from "../../components/Tooltip";
import { Button, Callout } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import type { Environment } from "../environments/environments";
import {
    CHECK_LABEL,
    PLACEHOLDERS,
    STEP_TYPE_LABEL,
    describeDraftStep,
    emptyDraft,
    newStep,
    sanitizeRoutes,
    toDefinition,
    type CheckKind,
    type Draft,
    type DraftStep,
    type RunbookList,
    type ScopeKind,
    type StepType,
} from "./runbooks";

interface Channel {
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
}

/**
 * The form for one runbook: a name and an ordered list of step cards. Each step says what it does and where the run goes next
 * when it passes or fails (only to a later step, so a runbook can never loop). Nothing is saved until "Save runbook".
 */
export function RunbookEditor({
    projectId,
    limits,
    initial,
    runbookId,
    onCancel,
    onSaved,
}: {
    projectId: string;
    limits: RunbookList["limits"];
    initial?: Draft;
    /** Present when editing an existing runbook. */
    runbookId?: string;
    onCancel: () => void;
    onSaved: (id: string) => void;
}) {
    const [draft, setDraft] = useState<Draft>(initial ?? emptyDraft());
    const [adding, setAdding] = useState<StepType>("run");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const uid = useId();

    const tests = useFetch<TestSummary[]>(`/projects/${projectId}/tests`);
    const suites = useFetch<Array<{ name: string }>>(`/projects/${projectId}/suites`);
    const envs = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const channels = useFetch<Channel[]>(`/projects/${projectId}/alert-channels`);

    const setStep = (i: number, patch: Partial<DraftStep>) => setDraft((d) => ({ ...d, steps: d.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
    const setSteps = (steps: DraftStep[]) => setDraft((d) => ({ ...d, steps: sanitizeRoutes(steps) }));
    const move = (i: number, by: -1 | 1) => {
        const steps = [...draft.steps];
        const j = i + by;
        if (j < 0 || j >= steps.length) return;
        [steps[i], steps[j]] = [steps[j]!, steps[i]!];
        setSteps(steps);
    };
    const remove = (i: number) => setSteps(draft.steps.filter((_, k) => k !== i));
    // A new run step starts at the environment marked Default (never a production one), as the Run panel does; saved steps keep theirs.
    const defaultEnv = (envs.data?.environments ?? []).find((e) => e.isDefault && !e.production)?.name ?? "";
    const add = () => {
        if (draft.steps.length >= limits.maxSteps) return;
        const step = newStep(adding, draft.steps);
        if (step.type === "run") step.environment = defaultEnv;
        setSteps([...draft.steps, step]);
    };
    // A new run sequence (blank or from a template): its run steps start at the default too, once the environments are known. A saved
    // run sequence keeps the places it was saved with.
    const seeded = useRef(Boolean(runbookId));
    useEffect(() => {
        if (seeded.current || !envs.data) return;
        seeded.current = true;
        if (defaultEnv) setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.type === "run" && s.environment === "" ? { ...s, environment: defaultEnv } : s)) }));
    }, [envs.data, defaultEnv]);

    async function save() {
        setBusy(true);
        setError("");
        try {
            const body = toDefinition(draft);
            const saved = await api<{ id: string }>(runbookId ? `/projects/${projectId}/runbooks/${runbookId}` : `/projects/${projectId}/runbooks`, { method: runbookId ? "PUT" : "POST", body });
            onSaved(saved.id);
        } catch (e) {
            setError(e instanceof ApiError ? describeApiError(e) : "The run sequence could not be saved. Check your connection and try again.");
            setBusy(false);
        }
    }

    return (
        <form
            className="rb-form"
            aria-label={runbookId ? "Edit run sequence" : "New run sequence"}
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
        >
            <div className="field">
                <label htmlFor={`${uid}-name`}>Name</label>
                <input id={`${uid}-name`} className="input" value={draft.name} maxLength={limits.maxNameLength} placeholder="For example: Release gate" onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
            </div>

            <ol className="rb-steplist">
                {draft.steps.map((s, i) => (
                    <li key={s.id}>
                        <StepCard
                            uid={`${uid}-${s.id}`}
                            index={i}
                            step={s}
                            all={draft.steps}
                            limits={limits}
                            tests={tests.data ?? []}
                            suites={suites.data?.map((x) => x.name) ?? []}
                            environments={envs.data?.environments ?? []}
                            channels={channels.data ?? []}
                            onChange={(patch) => setStep(i, patch)}
                            onUp={i > 0 ? () => move(i, -1) : undefined}
                            onDown={i < draft.steps.length - 1 ? () => move(i, 1) : undefined}
                            onRemove={draft.steps.length > 1 ? () => remove(i) : undefined}
                        />
                    </li>
                ))}
            </ol>

            <div className="rb-add">
                <label htmlFor={`${uid}-add`} className="t-secondary">Add a step</label>
                <select id={`${uid}-add`} className="input" value={adding} onChange={(e) => setAdding(e.target.value as StepType)}>
                    {(Object.keys(STEP_TYPE_LABEL) as StepType[]).map((t) => (
                        <option key={t} value={t}>{STEP_TYPE_LABEL[t]}</option>
                    ))}
                </select>
                <Button type="button" icon={Plus} onClick={add} disabled={draft.steps.length >= limits.maxSteps}>
                    Add step
                </Button>
                <span className="t-meta">{draft.steps.length} of {limits.maxSteps} steps. A run can take up to {limits.totalMinutes} minutes in all.</span>
            </div>

            {error && <Callout tone="danger" title="The run sequence was not saved">{error}</Callout>}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>Save run sequence</Button>
                <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
}

const SCOPE_LABEL: Record<ScopeKind, string> = { all: "All tests", suite: "One suite", tag: "Tests with a tag", type: "One kind of test", tests: "Specific tests" };
const KINDS_OF_TEST = ["smoke", "functional", "negative", "boundary", "security", "validation", "navigation", "accessibility", "workflow"];

function StepCard({
    uid,
    index,
    step: s,
    all,
    limits,
    tests,
    suites,
    environments,
    channels,
    onChange,
    onUp,
    onDown,
    onRemove,
}: {
    uid: string;
    index: number;
    step: DraftStep;
    all: DraftStep[];
    limits: RunbookList["limits"];
    tests: TestSummary[];
    suites: string[];
    environments: Environment[];
    channels: Channel[];
    onChange: (patch: Partial<DraftStep>) => void;
    onUp?: () => void;
    onDown?: () => void;
    onRemove?: () => void;
}) {
    const env = environments.find((e) => e.name === s.environment);
    const later = all.slice(index + 1);
    const [filter, setFilter] = useState("");
    const shown = useMemo(() => tests.filter((t) => !filter.trim() || `${t.title} ${t.testId}`.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 200), [tests, filter]);

    const routeSelect = (id: string, label: string, value: string, onPick: (v: string) => void, failure: boolean) => (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            <select id={id} className="input" value={value} onChange={(e) => onPick(e.target.value)}>
                <option value="next">Go to the next step</option>
                <option value="stop">{failure ? "Stop here" : "Stop here, finished"}</option>
                {later.map((t, k) => (
                    <option key={t.id} value={t.id}>Skip ahead to step {index + 2 + k}: {describeDraftStep(t)}</option>
                ))}
            </select>
        </div>
    );

    return (
        <fieldset className="rb-step" data-step={s.id}>
            <legend>Step {index + 1}</legend>
            <div className="rb-step-head">
                <div className="field grow">
                    <label htmlFor={`${uid}-type`}>What this step does</label>
                    <select id={`${uid}-type`} className="input" value={s.type} onChange={(e) => onChange({ type: e.target.value as StepType })}>
                        {(Object.keys(STEP_TYPE_LABEL) as StepType[]).map((t) => (
                            <option key={t} value={t}>{STEP_TYPE_LABEL[t]}</option>
                        ))}
                    </select>
                </div>
                <div className="rb-step-acts">
                    <Button type="button" size="sm" variant="ghost" iconOnly icon={ArrowUp} disabled={!onUp} onClick={onUp} aria-label={`Move step ${index + 1} up`} />
                    <Button type="button" size="sm" variant="ghost" iconOnly icon={ArrowDown} disabled={!onDown} onClick={onDown} aria-label={`Move step ${index + 1} down`} />
                    <Button type="button" size="sm" variant="ghost" iconOnly icon={Trash2} disabled={!onRemove} onClick={onRemove} aria-label={`Remove step ${index + 1}`} />
                </div>
            </div>

            {s.type === "run" && (
                <div className="rb-fields">
                    <div className="field">
                        <label htmlFor={`${uid}-scope`}>Which tests</label>
                        <select id={`${uid}-scope`} className="input" value={s.scopeKind} onChange={(e) => onChange({ scopeKind: e.target.value as ScopeKind })}>
                            {(Object.keys(SCOPE_LABEL) as ScopeKind[]).map((k) => (
                                <option key={k} value={k}>{SCOPE_LABEL[k]}</option>
                            ))}
                        </select>
                    </div>
                    {s.scopeKind === "suite" && (
                        <div className="field">
                            <label htmlFor={`${uid}-suite`}>Suite</label>
                            {suites.length ? (
                                <select id={`${uid}-suite`} className="input" value={s.suite} onChange={(e) => onChange({ suite: e.target.value })} required>
                                    <option value="">Choose a suite</option>
                                    {suites.map((n) => <option key={n} value={n}>{n}</option>)}
                                </select>
                            ) : (
                                <input id={`${uid}-suite`} className="input" value={s.suite} onChange={(e) => onChange({ suite: e.target.value })} required />
                            )}
                        </div>
                    )}
                    {s.scopeKind === "tag" && (
                        <div className="field">
                            <label htmlFor={`${uid}-tag`}>Tag</label>
                            <input id={`${uid}-tag`} className="input" value={s.tag} placeholder="smoke" onChange={(e) => onChange({ tag: e.target.value })} required />
                        </div>
                    )}
                    {s.scopeKind === "type" && (
                        <div className="field">
                            <label htmlFor={`${uid}-kind`}>Kind of test</label>
                            <select id={`${uid}-kind`} className="input" value={s.testType} onChange={(e) => onChange({ testType: e.target.value })} required>
                                <option value="">Choose a kind</option>
                                {KINDS_OF_TEST.map((k) => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>)}
                            </select>
                        </div>
                    )}
                    {s.scopeKind === "tests" && (
                        <div className="field span">
                            <label htmlFor={`${uid}-filter`}>Tests ({s.testIds.length} chosen)</label>
                            <input id={`${uid}-filter`} className="input" type="search" placeholder="Search by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
                            <ul className="rb-tests" aria-label="Tests to run">
                                {shown.map((t) => (
                                    <li key={t.id}>
                                        <label className="check">
                                            <input type="checkbox" checked={s.testIds.includes(t.id)} onChange={(e) => onChange({ testIds: e.target.checked ? [...s.testIds, t.id] : s.testIds.filter((x) => x !== t.id) })} />
                                            <span className="title">{t.title}</span>
                                        </label>
                                    </li>
                                ))}
                                {shown.length === 0 && <li className="t-secondary">No tests match.</li>}
                            </ul>
                        </div>
                    )}
                    <div className="field">
                        <label htmlFor={`${uid}-env`}>Where</label>
                        <select id={`${uid}-env`} className="input" value={s.environment} onChange={(e) => onChange({ environment: e.target.value, confirmProduction: false })}>
                            <option value="">The project’s own address</option>
                            {environments.map((e) => <option key={e.name} value={e.name}>{e.name}{e.production ? " (production, read-only)" : ""}</option>)}
                        </select>
                    </div>
                    <div className="field">
                        <label htmlFor={`${uid}-retries`}>Run a failing test again</label>
                        <select id={`${uid}-retries`} className="input" value={s.retries} onChange={(e) => onChange({ retries: Number(e.target.value) as 0 | 1 | 2 })} disabled={Boolean(s.environment)}>
                            <option value={0}>Never</option>
                            <option value={1}>Once</option>
                            <option value={2}>Twice</option>
                        </select>
                        {s.environment && <p className="hint">Runs on an environment are not repeated.</p>}
                    </div>
                    {env?.production && (
                        <label className="check span">
                            <input type="checkbox" checked={s.confirmProduction} onChange={(e) => onChange({ confirmProduction: e.target.checked })} />
                            <span>
                                <span className="title">This step may run on production</span>
                                <span className="hint">Production is read-only: tests that change data are skipped. You still have to confirm it.</span>
                            </span>
                        </label>
                    )}
                    <label className="check span">
                        <input type="checkbox" checked={s.includeMobile} onChange={(e) => onChange({ includeMobile: e.target.checked })} />
                        <span>
                            <span className="title">Include mobile tests</span>
                            <span className="hint">Only when this machine can run them. Off unless you turn it on.</span>
                        </span>
                    </label>
                </div>
            )}

            {s.type === "analyze" && (
                <div className="rb-fields">
                    <p className="t-secondary span">Looks at the application again with the settings of the last exploration. It uses the AI key of the person who starts it (for a schedule or a deploy trigger, its maker). These two stay off unless you turn them on here.</p>
                    <label className="check span">
                        <input type="checkbox" checked={s.allowMutating} onChange={(e) => onChange({ allowMutating: e.target.checked })} />
                        <span>
                            <span className="title">Allow tests that change data</span>
                            <span className="hint">Creates tests that add, change or delete records in the application.</span>
                        </span>
                    </label>
                    <label className="check span">
                        <input type="checkbox" checked={s.loadChecks} onChange={(e) => onChange({ loadChecks: e.target.checked })} />
                        <span>
                            <span className="title">Include the load check</span>
                            <span className="hint">Sends a burst of requests. Never to production.</span>
                        </span>
                    </label>
                </div>
            )}

            {s.type === "condition" && (
                <div className="rb-fields">
                    <div className="field">
                        <label htmlFor={`${uid}-check`}>Continue only if</label>
                        <select id={`${uid}-check`} className="input" value={s.check} onChange={(e) => onChange({ check: e.target.value as CheckKind })}>
                            {(Object.keys(CHECK_LABEL) as CheckKind[]).map((k) => <option key={k} value={k}>{CHECK_LABEL[k]}</option>)}
                        </select>
                    </div>
                    {s.check === "passRate" && (
                        <div className="field">
                            <label htmlFor={`${uid}-rate`}>Percent of tests that passed</label>
                            <input id={`${uid}-rate`} className="input num" type="number" min={0} max={100} value={s.atLeast} onChange={(e) => onChange({ atLeast: Math.min(100, Math.max(0, Number(e.target.value))) })} />
                        </div>
                    )}
                    <p className="t-secondary span">{s.check === "readiness" ? "Uses the project’s readiness, the same answer as the dashboard." : "Looks at the run in the step before it."}</p>
                </div>
            )}

            {s.type === "notify" && (
                <div className="rb-fields">
                    <div className="field">
                        <label htmlFor={`${uid}-channel`}>Send to</label>
                        <select id={`${uid}-channel`} className="input" value={s.channelId} onChange={(e) => onChange({ channelId: e.target.value })} required>
                            <option value="">Choose an alert channel</option>
                            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? "" : " (paused)"}</option>)}
                        </select>
                        {channels.length === 0 && <p className="hint">This project has no alert channels yet. Add one under Alerts first.</p>}
                    </div>
                    <div className="field span">
                        <label htmlFor={`${uid}-message`}>Message</label>
                        <textarea id={`${uid}-message`} className="input" rows={3} maxLength={500} value={s.message} onChange={(e) => onChange({ message: e.target.value })} required />
                        <p className="hint">
                            Placeholders you can use: {PLACEHOLDERS.map((p, k) => (
                                <span key={p.name}>
                                    {k > 0 && ", "}
                                    <Tooltip content={`${p.help.charAt(0).toUpperCase()}${p.help.slice(1)}.`}>
                                        <code tabIndex={0}>{`{{${p.name}}}`}</code>
                                    </Tooltip>
                                </span>
                            ))}. A message that cannot be sent never fails the run.
                        </p>
                    </div>
                </div>
            )}

            {s.type === "wait" && (
                <div className="rb-fields">
                    <div className="field">
                        <label htmlFor={`${uid}-seconds`}>Seconds to wait</label>
                        <input id={`${uid}-seconds`} className="input num" type="number" min={1} max={limits.maxWaitSeconds} value={s.seconds} onChange={(e) => onChange({ seconds: Math.min(limits.maxWaitSeconds, Math.max(1, Math.floor(Number(e.target.value)) || 1)) })} />
                        <p className="hint">Up to {limits.maxWaitSeconds} seconds.</p>
                    </div>
                </div>
            )}

            <div className="rb-routes">
                {routeSelect(`${uid}-pass`, s.type === "condition" ? "If the check holds" : "If it passes", s.onPass, (v) => onChange({ onPass: v }), false)}
                {s.type !== "wait" && s.type !== "notify" ? routeSelect(`${uid}-fail`, s.type === "condition" ? "If the check does not hold" : "If it fails", s.onFail, (v) => onChange({ onFail: v }), true) : <p className="t-secondary rb-always">This step always moves on.</p>}
            </div>
        </fieldset>
    );
}
