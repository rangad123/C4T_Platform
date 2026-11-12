import { RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, Disclosure, EmptyState, Skeleton } from "../../components/ui";
import { help } from "../../lib/help";
import { useConfig, useFetch } from "../../lib/hooks";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import { runnerProblem, useMyRunner } from "../runners/my-runner";
import { ACTION_WORDS, CHECK_TONE, KEEP_SIGNED_IN, READY_TONE, READY_WORD, choiceKey, currentChoiceKey, phoneLine, phoneName, whereChoices, type Depth, type Phone, type PhonesAnswer, type PhoneSettingsAnswer, type ReadyAction, type ReadyCheck } from "./phonedevice";
import "./phonedevice.css";

const CHECK_WORD: Record<ReadyCheck["status"], string> = { ok: "Fine", attention: "Check", problem: "Fix", info: "Note" };

/** One check: what was found, why it matters, the exact steps, and the button that does it (reversible). */
function CheckRow({ c, busy, onAction }: { c: ReadyCheck; busy: string; onAction: (a: ReadyAction) => void }) {
    return (
        <li className="pd-check" data-status={c.status} data-testid={`check-${c.id}`}>
            <Badge tone={CHECK_TONE[c.status]} tip={help("phoneCheck", c.status)}>
                {CHECK_WORD[c.status]}
            </Badge>
            <div className="pd-check-text">
                <p className="pd-check-title">{c.title}</p>
                {c.detail && <p className="hint">{c.detail}</p>}
                {c.steps?.length ? (
                    <ol className="pd-steps">
                        {c.steps.map((s) => (
                            <li key={s}>{s}</li>
                        ))}
                    </ol>
                ) : null}
                {c.action && (
                    <div className="row">
                        <Button size="sm" loading={busy === c.action} disabled={busy !== ""} onClick={() => onAction(c.action!)} tip={ACTION_WORDS[c.action].tip}>
                            {ACTION_WORDS[c.action].label}
                        </Button>
                    </div>
                )}
            </div>
        </li>
    );
}

function PhoneCard({ projectId, phone, onChanged }: { projectId: string; phone: Phone; onChanged: (p: Phone) => void }) {
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const [done, setDone] = useState("");
    async function act(a: ReadyAction) {
        setBusy(a);
        setError("");
        setDone("");
        try {
            const path = a.startsWith("animations") ? "animations" : "stay-awake";
            const body = a === "animations-off" ? { off: true } : a === "animations-restore" ? { off: false } : { on: a === "stay-awake-on" };
            const r = await api<{ phone: Phone }>(`/projects/${projectId}/phones/${encodeURIComponent(phone.serial)}/${path}`, { method: "POST", body });
            onChanged(r.phone);
            setDone(a === "animations-off" ? "Animations are off on this phone. Restore animations puts them back." : a === "animations-restore" ? "Animations are back as they were." : a === "stay-awake-on" ? "The screen now stays on while the phone charges." : "The screen setting is back as it was.");
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy("");
        }
    }
    const issues = phone.checks.filter((c) => c.status === "problem" || c.status === "attention");
    return (
        <article className="pd-phone" aria-labelledby={`pd-${phone.serial}`} data-testid="phone-card">
            <div className="pd-phone-head">
                <Smartphone size={18} aria-hidden />
                <div className="pd-phone-name">
                    <h3 className="t-card" id={`pd-${phone.serial}`}>
                        {phoneName(phone)}
                    </h3>
                    <p className="t-meta">{phoneLine(phone)}</p>
                </div>
                <Badge tone={READY_TONE[phone.state]} tip={help("phoneReady", phone.state)}>
                    {READY_WORD[phone.state]}
                </Badge>
            </div>
            <p className="t-secondary" data-testid="phone-summary">
                {phone.summary}.
            </p>
            {error && <Callout tone="danger">{error}</Callout>}
            {done && <Callout tone="success">{done}</Callout>}
            {issues.length > 0 && (
                <ul className="pd-checks" aria-label={`What needs doing on ${phoneName(phone)}`}>
                    {issues.map((c) => (
                        <CheckRow key={c.id} c={c} busy={busy} onAction={act} />
                    ))}
                </ul>
            )}
            <Disclosure label={`Everything that was checked (${phone.checks.length})`}>
                <ul className="pd-checks">
                    {phone.checks.map((c) => (
                        <CheckRow key={c.id} c={{ ...c, steps: c.status === "ok" || c.status === "info" ? c.steps : undefined }} busy={busy} onAction={act} />
                    ))}
                </ul>
            </Disclosure>
            {phone.tips.length > 0 && (
                <Disclosure label={`Settings ${phone.manufacturer ?? "this maker"} phones need (${phone.tips.length})`}>
                    <div className="stack-sm" data-testid="phone-tips">
                        {phone.tips.map((t) => (
                            <div key={t.title} className="stack-sm">
                                <p className="pd-check-title">{t.title}</p>
                                <p className="hint">{t.why}</p>
                                <ol className="pd-steps">
                                    {t.steps.map((s) => (
                                        <li key={s}>{s}</li>
                                    ))}
                                </ol>
                            </div>
                        ))}
                    </div>
                </Disclosure>
            )}
        </article>
    );
}

/**
 * Phones on the person's runner, in the server's own words (GET /api/me/runner `can.phone`). The runner checks its own phones; its
 * "Use my connected phone" switch in Settings is the only thing that lets a plugged-in phone be used. `card`: its own section (runners mode).
 */
function YourRunnerPhones({ card }: { card?: boolean }) {
    const me = useMyRunner(30_000);
    const r = me.data?.runner;
    if (!me.data || (!r && !card)) return null;
    const why = runnerProblem(me.data, { can: ["phone"] });
    const Title = card ? "h2" : "h3";
    return (
        <div className={card ? "card card-pad stack-sm" : "stack-sm"} data-testid="runner-phones">
            <Title className={card ? "t-section" : "t-card"}>Phones on your runner</Title>
            <p className="t-secondary" data-testid="runner-phones-text">
                {why ?? `Phone tests can run on ${r!.name}.`}
            </p>
            <p className="hint">
                {r && `${r.switches.realPhone ? "Use my connected phone is on: a phone plugged into it with USB debugging on is used, else an emulator." : "Use my connected phone is off: only an emulator on it is used."} `}
                <a href={routes.yourRunner}>Open Your runner in Settings</a>
            </p>
        </div>
    );
}

/** Settings, Mobile app: the phones found, each with "Is this phone ready?". Read-only unless a button is pressed; every change can be undone. */
export function PhonesPanel({ projectId, onPhones }: { projectId: string; onPhones?: (p: Phone[]) => void }) {
    const list = useFetch<PhonesAnswer>(`/projects/${projectId}/phones`);
    const [phones, setPhones] = useState<Phone[] | undefined>();
    useEffect(() => {
        setPhones(list.data?.phones);
        if (list.data) onPhones?.(list.data.phones);
    }, [list.data, onPhones]);
    return (
        <section className="card card-pad stack-sm" aria-labelledby="pd-phones-title" data-tour="phone-ready" data-testid="phones-panel">
            <div className="row pd-head">
                <h2 className="t-section" id="pd-phones-title">
                    Is this phone ready?
                </h2>
                <span className="spacer" />
                <Button size="sm" icon={RefreshCw} loading={list.loading} disabled={list.loading} onClick={() => void list.reload()} tip="Reads every phone and emulator connected to the platform’s computer again. Nothing on the phones changes.">
                    Check again
                </Button>
            </div>
            <p className="t-secondary">Phones and emulators connected to the computer that runs the platform. Each is checked before a test runs on it: USB debugging, the screen, animations, the app and its user, and what the phone’s maker needs.</p>
            {list.loading && !phones ? (
                <div className="stack-sm" aria-busy="true" aria-label="Checking the phones">
                    <Skeleton h={22} w="60%" />
                    <Skeleton h={16} w="80%" />
                    <Skeleton h={16} w="40%" />
                </div>
            ) : list.error ? (
                <Callout tone="danger" title="We couldn’t check the phones" actions={<Button size="sm" onClick={() => void list.reload()}>Try again</Button>}>
                    {describeApiError(list.error)}
                </Callout>
            ) : !phones?.length ? (
                <EmptyState icon={Smartphone} title={list.data?.available === false ? "Phones can’t be checked on this computer" : "No phone is connected here"}>
                    {list.data?.reason ?? "Plug in a phone with USB debugging on, then choose Check again."}
                </EmptyState>
            ) : (
                <div className="stack">
                    {phones.map((p) => (
                        <PhoneCard key={p.serial} projectId={projectId} phone={p} onChanged={(np) => setPhones((cur) => cur?.map((x) => (x.serial === np.serial ? np : x)))} />
                    ))}
                    {list.data?.more ? <p className="t-meta">and {list.data.more} more, not checked.</p> : null}
                </div>
            )}
            <YourRunnerPhones />
        </section>
    );
}

/** Settings, Mobile app: where phone tests run, how thorough an exploration is, and "Already signed in on this phone". */
export function PhoneSettingsPanel({ projectId, phones, cleanStart, onSaved, runnersOnly = false }: { projectId: string; phones: Phone[]; cleanStart: boolean; onSaved?: () => void; runnersOnly?: boolean }) {
    const settings = useFetch<PhoneSettingsAnswer>(`/projects/${projectId}/phone-settings`);
    const s = settings.data;
    const [where, setWhere] = useState<string>("");
    const [depth, setDepth] = useState<Depth>("standard");
    const [keep, setKeep] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    useEffect(() => {
        if (!s) return;
        setWhere(currentChoiceKey(s));
        setDepth(s.depth);
        setKeep(s.keepSignedIn);
    }, [s]);

    if (settings.loading && !s)
        return (
            <section className="card card-pad stack-sm" aria-busy="true" aria-label="Loading the phone test settings">
                <Skeleton h={22} w="40%" />
                <Skeleton h={44} />
                <Skeleton h={44} />
            </section>
        );
    if (settings.error || !s)
        return (
            <section className="card card-pad">
                <Callout tone="danger" title="We couldn’t load the phone test settings" actions={<Button size="sm" onClick={() => void settings.reload()}>Try again</Button>}>
                    {settings.error ? describeApiError(settings.error) : "No answer."}
                </Callout>
            </section>
        );

    const choices = whereChoices(s, phones, runnersOnly);
    const chosen = choices.find((c) => choiceKey(c.runsOn) === where);
    const changed = where !== currentChoiceKey(s) || depth !== s.depth || keep !== s.keepSignedIn;
    const keepBlocked = keep && (cleanStart || s.cleanStart);

    async function save() {
        setBusy(true);
        setError("");
        setSaved(false);
        try {
            const body: Record<string, unknown> = {};
            if (where !== currentChoiceKey(s!)) body.runsOn = chosen && chosen.kind !== "auto" ? chosen.runsOn : null;
            if (depth !== s!.depth) body.depth = depth;
            if (keep !== s!.keepSignedIn) body.keepSignedIn = keep;
            await api(`/projects/${projectId}/phone-settings`, { method: "PUT", body });
            await settings.reload();
            setSaved(true);
            onSaved?.();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack" aria-labelledby="pd-settings-title" data-testid="phone-settings">
            <div className="stack-sm">
                <h2 className="t-section" id="pd-settings-title">
                    Phone test settings
                </h2>
                {!s.hasApp && <Callout tone="info">Add the phone app above first. These settings belong to it.</Callout>}
                <p className="t-secondary" data-testid="phone-where-sentence">
                    {s.sentence}
                </p>
            </div>
            <fieldset className="pd-group" disabled={!s.hasApp || busy}>
                <legend className="t-card">Where phone tests run</legend>
                <p className="hint">Every phone test run uses this: right after the AI writes tests, Run, schedules and runners. Each run says which device it used.</p>
                {choices.map((c) => {
                    const key = choiceKey(c.runsOn);
                    return (
                        <label key={key} className={`check${c.off ? " is-off" : ""}`}>
                            <input type="radio" name="pd-where" value={key} checked={where === key} disabled={Boolean(c.off)} onChange={() => { setWhere(key); setSaved(false); }} />
                            <span>
                                <span className="title">{c.label}</span>
                                <span className="hint">
                                    {c.detail}
                                    {c.off ? ` ${c.off}` : ""}
                                </span>
                            </span>
                        </label>
                    );
                })}
            </fieldset>
            <fieldset className="pd-group" disabled={!s.hasApp || busy}>
                <legend className="t-card">How thorough</legend>
                <p className="hint">How far the AI goes when it explores the app. It stops earlier when it stops finding new screens, and says why.</p>
                {s.depths.map((d) => (
                    <label key={d.id} className="check">
                        <input type="radio" name="pd-depth" value={d.id} checked={depth === d.id} onChange={() => { setDepth(d.id); setSaved(false); }} />
                        <span>
                            <span className="title">
                                {d.label}
                                {d.id === "standard" ? " (usual)" : ""}
                            </span>
                            <span className="hint">
                                {d.line} Plans up to {d.ideas} test ideas.
                            </span>
                        </span>
                    </label>
                ))}
            </fieldset>
            <fieldset className="pd-group" disabled={!s.hasApp || busy}>
                <legend className="t-card">Signing in</legend>
                <label className="check">
                    <input type="checkbox" checked={keep} onChange={(e) => { setKeep(e.target.checked); setSaved(false); }} aria-describedby={keepBlocked ? "pd-keep-conflict" : undefined} />
                    <span>
                        <span className="title">{KEEP_SIGNED_IN.label}</span>
                        <span className="hint">{KEEP_SIGNED_IN.hint}</span>
                    </span>
                </label>
                {keepBlocked && (
                    <p className="t-meta" id="pd-keep-conflict" role="alert">
                        {KEEP_SIGNED_IN.conflict}
                    </p>
                )}
                <p className="hint">When the app shows a sign-in screen, the AI fills it from the test account you give when you start exploring. A one-time code or a captcha pauses the exploration and asks you on its page.</p>
            </fieldset>
            {error && <Callout tone="danger">{error}</Callout>}
            {saved && <Callout tone="success">Saved. The next exploration and run use these settings.</Callout>}
            <div className="row">
                <Button variant="primary" loading={busy} disabled={busy || !changed || !s.hasApp || keepBlocked} onClick={() => void save()}>
                    Save phone settings
                </Button>
            </div>
        </section>
    );
}

/** Both cards, in the order a person needs them: is the phone ready, then how tests use it. Runners mode: the phones on your runner instead. */
export function PhoneDeviceSection({ projectId, cleanStart }: { projectId: string; cleanStart: boolean }) {
    const [phones, setPhones] = useState<Phone[]>([]);
    const config = useConfig();
    // Until the mode is known: the platform computer's phones must not be read in runners mode.
    if (!config) return null;
    const runnersOnly = config.executionMode === "runners";
    return (
        <div className="stack" data-testid="phone-device-section">
            {runnersOnly ? <YourRunnerPhones card /> : <PhonesPanel projectId={projectId} onPhones={setPhones} />}
            <PhoneSettingsPanel projectId={projectId} phones={runnersOnly ? [] : phones} cleanStart={cleanStart} runnersOnly={runnersOnly} />
        </div>
    );
}
