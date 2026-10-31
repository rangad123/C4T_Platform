import { Check, CircleAlert, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../api";
import { Button, Callout, ErrorState, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { availabilityLine, FRAMEWORK_NAME, type FrameworkId, type FrameworkSettings, type FrameworkSettingsAnswer } from "./frameworks";
import { PluginFrameworks } from "./PluginFrameworks";
import "./frameworks.css";

/** What the person is editing: numbers stay text until Save, so an empty or half-typed box is never silently turned into a value. */
interface Draft {
    enabled: Record<FrameworkId, boolean>;
    visible: boolean;
    workers: string;
    webTimeout: string;
    apiTimeout: string;
    keepEmulator: boolean;
    defaultAvd: string;
    androidTimeout: string;
    windowsTimeout: string;
    windowsStart: string;
    keepSimulator: boolean;
    defaultSimulator: string;
    iosTimeout: string;
}

const toDraft = (s: FrameworkSettings): Draft => ({
    enabled: { ...s.enabled },
    visible: !s.web.headless,
    workers: s.web.workers === null ? "" : String(s.web.workers),
    webTimeout: String(s.web.testTimeoutSeconds),
    apiTimeout: String(s.api.testTimeoutSeconds),
    keepEmulator: s.android.keepEmulator,
    defaultAvd: s.android.defaultAvd,
    androidTimeout: String(s.android.testTimeoutSeconds),
    windowsTimeout: String(s.windows.testTimeoutSeconds),
    windowsStart: String(s.windows.startTimeoutSeconds),
    keepSimulator: s.ios.keepSimulator,
    defaultSimulator: s.ios.defaultSimulator,
    iosTimeout: String(s.ios.testTimeoutSeconds),
});

/** The settings to send, or the first thing in the form that is not a number. */
function toSettings(d: Draft): { settings: FrameworkSettings } | { problem: string } {
    const seconds = (label: string, text: string): number | string => {
        const n = Number(text.trim());
        return text.trim() === "" || !Number.isFinite(n) ? `${label}: enter a number of seconds.` : n;
    };
    const web = seconds("Web time limit", d.webTimeout);
    const api = seconds("API time limit", d.apiTimeout);
    const android = seconds("Android time limit", d.androidTimeout);
    const windows = seconds("Windows time limit", d.windowsTimeout);
    const start = seconds("Windows start limit", d.windowsStart);
    const ios = seconds("iOS time limit", d.iosTimeout);
    for (const v of [web, api, android, windows, start, ios]) if (typeof v === "string") return { problem: v };
    const workers = d.workers.trim() === "" ? null : Number(d.workers.trim());
    if (workers !== null && !Number.isFinite(workers)) return { problem: "Parallel browsers: enter a whole number, or leave it empty." };
    return {
        settings: {
            enabled: { ...d.enabled },
            web: { headless: !d.visible, workers, testTimeoutSeconds: web as number },
            api: { testTimeoutSeconds: api as number },
            android: { keepEmulator: d.keepEmulator, defaultAvd: d.defaultAvd, testTimeoutSeconds: android as number },
            windows: { testTimeoutSeconds: windows as number, startTimeoutSeconds: start as number },
            ios: { keepSimulator: d.keepSimulator, defaultSimulator: d.defaultSimulator.trim(), testTimeoutSeconds: ios as number },
        },
    };
}

function Switch({ id, labelledBy, checked, onChange, disabled }: { id: string; labelledBy: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <button type="button" id={id} role="switch" aria-checked={checked} aria-labelledby={`${labelledBy} ${id}-state`} className="fw-switch" disabled={disabled} onClick={() => onChange(!checked)}>
            <span className="fw-knob" aria-hidden />
            <span id={`${id}-state`} className="fw-switch-text">
                {checked ? "On" : "Off"}
            </span>
        </button>
    );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
    return (
        <div className="field">
            <label htmlFor={id}>{label}</label>
            {children}
            {hint && (
                <span className="hint" id={`${id}-hint`}>
                    {hint}
                </span>
            )}
        </div>
    );
}

function Seconds({ id, label, value, onChange, min, max, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; min: number; max: number; hint: string }) {
    return (
        <Field id={id} label={label} hint={hint}>
            <input id={id} className="input" type="number" inputMode="numeric" min={min} max={max} step={1} value={value} aria-describedby={`${id}-hint`} onChange={(e) => onChange(e.target.value)} />
        </Field>
    );
}

/**
 * How each testing framework runs for this project: on or off, and the few settings that really change a run. Every value starts at
 * what the platform always did. Retries are deliberately not offered: they hide flaky tests.
 */
export function FrameworksSection({ projectId, jobRunning }: { projectId: string; jobRunning: boolean }) {
    const data = useFetch<FrameworkSettingsAnswer>(`/projects/${projectId}/framework-settings`);
    const [answer, setAnswer] = useState<FrameworkSettingsAnswer | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const [adjusted, setAdjusted] = useState<string[]>([]);

    // Follow the platform's answer until the person starts editing.
    // Only when a NEW answer arrives (not when "dirty" flips after a save, which would put the older answer back).
    const dirtyNow = useRef(false);
    dirtyNow.current = dirty;
    useEffect(() => {
        if (!data.data) return;
        setAnswer(data.data);
        if (!dirtyNow.current) setDraft(toDraft(data.data.settings));
    }, [data.data]);

    const cur = answer;
    const edit = (patch: Partial<Draft>) => {
        setDraft((d) => (d ? { ...d, ...patch } : d));
        setDirty(true);
        setSaved(false);
        setError("");
    };
    const unchanged = useMemo(() => !!cur && !!draft && JSON.stringify(toDraft(cur.settings)) === JSON.stringify(draft), [cur, draft]);

    async function save() {
        if (!draft) return;
        const next = toSettings(draft);
        if ("problem" in next) {
            setError(next.problem);
            return;
        }
        setBusy(true);
        setError("");
        setSaved(false);
        try {
            const r = await api<FrameworkSettingsAnswer>(`/projects/${projectId}/framework-settings`, { method: "PUT", body: { settings: next.settings } });
            setAnswer(r);
            setDraft(toDraft(r.settings));
            setAdjusted(r.adjusted ?? []);
            setDirty(false);
            setSaved(true);
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    const head = (
        <div className="card-head wrap">
            <SlidersHorizontal size={18} aria-hidden />
            <h2 className="t-section" id="fw-title">
                Frameworks
            </h2>
        </div>
    );

    if (data.loading && !cur) {
        return (
            <section className="card" aria-labelledby="fw-title" data-testid="frameworks">
                {head}
                <div className="fw-body">
                    <Skeleton w="60%" />
                    <Skeleton h={120} />
                    <Skeleton h={120} />
                </div>
            </section>
        );
    }
    if (!cur || !draft) {
        return (
            <section className="card" aria-labelledby="fw-title" data-testid="frameworks">
                {head}
                <div className="card-pad">
                    <ErrorState error={friendlyError(data.error?.message)} onRetry={data.reload} />
                </div>
            </section>
        );
    }

    const { limits, runner } = cur;
    const onAgent = runner.runOn === "agent";
    const info = (id: FrameworkId) => cur.adapters.find((a) => a.id === id)!;
    const avdOptions = [...new Set([...cur.avds, ...(draft.defaultAvd ? [draft.defaultAvd] : [])])];
    const lock = jobRunning;

    const card = (id: FrameworkId, fields: ReactNode) => {
        const line = availabilityLine(info(id), runner);
        const on = draft.enabled[id];
        return (
            <div className={`fw-card${on ? "" : " is-off"}`} data-testid={`fw-${id}`} role="group" aria-labelledby={`fw-${id}-name`}>
                <div className="fw-head">
                    <div className="fw-title">
                        <h3 className="t-card" id={`fw-${id}-name`}>
                            {FRAMEWORK_NAME[id]}
                        </h3>
                        <p className={`fw-avail ${line.ok ? "ok" : "no"}`}>
                            {line.ok ? <Check size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
                            <span>{line.text}</span>
                        </p>
                    </div>
                    <Switch id={`fw-${id}-on`} labelledBy={`fw-${id}-name`} checked={on} disabled={lock} onChange={(v) => edit({ enabled: { ...draft.enabled, [id]: v } })} />
                </div>
                {!on && <p className="hint">Off. New tests of this kind are not accepted and existing ones are left out of every run.</p>}
                <div className="fw-fields">{fields}</div>
            </div>
        );
    };

    return (
        <section className="card" aria-labelledby="fw-title" data-testid="frameworks">
            {head}
            <form
                className="fw-body"
                aria-label="Framework settings"
                noValidate
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <p className="t-secondary">
                    Each framework starts with the settings the platform always used. Changes apply to the next run. Retries are not offered on purpose: they hide tests that fail now and then.
                </p>
                {lock && <Callout tone="info">A run is in progress for this project. You can change these settings when it finishes.</Callout>}
                {cur.effective.notes.map((n) => (
                    <Callout key={n} tone="info">
                        {n}
                    </Callout>
                ))}

                <fieldset className="fw-set" disabled={lock}>
                    <legend className="sr-only">Settings for each framework</legend>
                    {card(
                        "playwright",
                        <>
                            <Field id="fw-window" label="Browser window" hint={onAgent ? "A visible window opens on the runner’s computer, so you can watch the run." : "A visible window only opens on a runner. Choose a runner above to use it."}>
                                <select id="fw-window" className="input" aria-describedby="fw-window-hint" value={draft.visible ? "visible" : "hidden"} disabled={!onAgent && !draft.visible} onChange={(e) => edit({ visible: e.target.value === "visible" })}>
                                    <option value="hidden">Hidden</option>
                                    <option value="visible" disabled={!onAgent && !draft.visible}>
                                        Visible, on a runner
                                    </option>
                                </select>
                            </Field>
                            <Field id="fw-workers" label="Parallel browsers" hint={`Leave empty to use this server’s ${limits.platformWorkers}. A lower number runs fewer tests at once.`}>
                                <input id="fw-workers" className="input" type="number" inputMode="numeric" min={limits.workers.min} max={limits.workers.max} step={1} placeholder={`${limits.platformWorkers}`} value={draft.workers} aria-describedby="fw-workers-hint" onChange={(e) => edit({ workers: e.target.value })} />
                            </Field>
                            <Seconds id="fw-web-timeout" label="Time limit per test (seconds)" value={draft.webTimeout} onChange={(v) => edit({ webTimeout: v })} min={limits.timeoutSeconds.min} max={limits.timeoutSeconds.max} hint={`Between ${limits.timeoutSeconds.min} and ${limits.timeoutSeconds.max}. Usually 60.`} />
                        </>,
                    )}
                    {card(
                        "playwright-api",
                        <Seconds id="fw-api-timeout" label="Time limit per test (seconds)" value={draft.apiTimeout} onChange={(v) => edit({ apiTimeout: v })} min={limits.timeoutSeconds.min} max={limits.timeoutSeconds.max} hint={`Between ${limits.timeoutSeconds.min} and ${limits.timeoutSeconds.max}. Usually 60.`} />,
                    )}
                    {card(
                        "taqwright",
                        <>
                            <Field id="fw-avd" label="Default emulator" hint={cur.avds.length ? "Used when the project’s app does not name one." : "No emulators are known yet, so the platform chooses."}>
                                <select id="fw-avd" className="input" aria-describedby="fw-avd-hint" value={draft.defaultAvd} onChange={(e) => edit({ defaultAvd: e.target.value })}>
                                    <option value="">Chosen automatically</option>
                                    {avdOptions.map((n) => (
                                        <option key={n} value={n}>
                                            {n}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            <Seconds id="fw-android-timeout" label="Time limit per test (seconds)" value={draft.androidTimeout} onChange={(v) => edit({ androidTimeout: v })} min={limits.timeoutSeconds.min} max={limits.timeoutSeconds.max} hint={`Between ${limits.timeoutSeconds.min} and ${limits.timeoutSeconds.max}. Usually 180.`} />
                            <label className="check fw-wide">
                                <input type="checkbox" checked={draft.keepEmulator} onChange={(e) => edit({ keepEmulator: e.target.checked })} />
                                <span>
                                    <span className="title">Keep the emulator running after a run</span>
                                    <span className="hint">Faster next time, but it keeps using memory.</span>
                                </span>
                            </label>
                        </>,
                    )}
                    {card(
                        "taqwright-ios",
                        <>
                            <Field id="fw-sim" label="Default simulator" hint="A simulator name such as iPhone 15. Leave empty to use a running one, or the newest available.">
                                <input id="fw-sim" className="input" type="text" aria-describedby="fw-sim-hint" maxLength={64} value={draft.defaultSimulator} onChange={(e) => edit({ defaultSimulator: e.target.value })} />
                            </Field>
                            <Seconds id="fw-ios-timeout" label="Time limit per test (seconds)" value={draft.iosTimeout} onChange={(v) => edit({ iosTimeout: v })} min={limits.timeoutSeconds.min} max={limits.timeoutSeconds.max} hint={`Between ${limits.timeoutSeconds.min} and ${limits.timeoutSeconds.max}. A simulator is slower than a browser.`} />
                            <label className="check fw-wide">
                                <input type="checkbox" checked={draft.keepSimulator} onChange={(e) => edit({ keepSimulator: e.target.checked })} />
                                <span>
                                    <span className="title">Keep the simulator running after a run</span>
                                    <span className="hint">Faster next time. A simulator that was already running is never shut down.</span>
                                </span>
                            </label>
                        </>,
                    )}
                    {card(
                        "windows-uia",
                        <>
                            <Seconds id="fw-win-timeout" label="Time limit per test (seconds)" value={draft.windowsTimeout} onChange={(v) => edit({ windowsTimeout: v })} min={limits.timeoutSeconds.min} max={limits.timeoutSeconds.max} hint={`Between ${limits.timeoutSeconds.min} and ${limits.timeoutSeconds.max}. Usually 120.`} />
                            <Seconds id="fw-win-start" label="Time to open the application (seconds)" value={draft.windowsStart} onChange={(v) => edit({ windowsStart: v })} min={limits.startTimeoutSeconds.min} max={limits.startTimeoutSeconds.max} hint={`Between ${limits.startTimeoutSeconds.min} and ${limits.startTimeoutSeconds.max}. Usually 15.`} />
                            <p className="hint fw-wide">Which applications a test may start is decided on the computer that runs it, not here.</p>
                        </>,
                    )}
                </fieldset>

                {error && (
                    <Callout tone="danger" title="These settings were not saved">
                        {error}
                    </Callout>
                )}
                {adjusted.length > 0 && !dirty && (
                    <Callout tone="info" title="Some values were adjusted">
                        {adjusted.join(" ")}
                    </Callout>
                )}
                <div className="row">
                    <Button type="submit" variant="primary" loading={busy} disabled={lock || unchanged}>
                        Save settings
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={lock || busy}
                        tip={lock ? "A run is in progress for this project. You can change these settings when it finishes." : "Fills the form with the platform’s standard settings. Nothing changes until you save."}
                        onClick={() => {
                            setDraft(toDraft(cur.defaults));
                            setDirty(true);
                            setSaved(false);
                            setError("");
                        }}
                    >
                        Use defaults
                    </Button>
                    {dirty && !lock && (
                        <span className="t-secondary" role="status">
                            You have unsaved changes.
                        </span>
                    )}
                    {saved && !dirty && !error && (
                        <span className="t-secondary" role="status">
                            Saved. The next run uses these settings.
                        </span>
                    )}
                </div>

                <PluginFrameworks />

                <div className="stack-sm" data-testid="fw-changes">
                    <h3 className="t-card">Recent changes</h3>
                    {cur.changes.length === 0 ? (
                        <p className="t-secondary">No changes yet. Everything runs as it always did.</p>
                    ) : (
                        <ul className="fw-log">
                            {cur.changes.map((c) => (
                                <li key={c.id}>
                                    <span>{c.summary}</span>
                                    <span className="t-meta">
                                        {relativeTime(c.at)}
                                        {c.by ? `, ${c.by}` : ""}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </form>
        </section>
    );
}
