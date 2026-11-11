import { useProjectAiReady } from "../aiconfig/aiconfig";
import { Smartphone, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout, Disclosure, ErrorState, LinkButton, Skeleton } from "../../components/ui";
import { useConfig, useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import type { Agent, RunnerChoice } from "../agents/agents";
import { executionModeOf } from "../runs/runs-here";
import { ACCOUNT_REMINDER, AI_MISSING, EXPLORE_ON_RUNNERS, EXPLORE_ON_RUNNERS_TITLE, IPHONE_NOTE, NEED_APP, NEED_PACKAGE, NO_WHERE_BODY, NO_WHERE_TITLE, PHONE_TITLE, WONT_DO, appLabel, appState, defaultWhere, startBody, whereOptions, willDo } from "./phone";
import "./phone.css";

/**
 * The panel before an exploration of a phone app starts: what will happen, what it needs, where it will run, and one button.
 * It reads what the platform says it can do and never offers a place that cannot run it. It uses the plan mode, so nothing is
 * created until the person has seen the plan. Opened from the New test menu, from Setup > Mobile app and from the welcome page.
 */
export function PhoneStartDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    const project = useFetch<ProjectDetail>(`/projects/${projectId}`);
    const runner = useFetch<RunnerChoice>(`/projects/${projectId}/runner`);
    const agents = useFetch<Agent[]>(`/projects/${projectId}/agents`);
    const config = useConfig();
    const aiReady = useProjectAiReady(projectId);
    const [where, setWhere] = useState<string | null>(null);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // The control that opened the panel gets the focus back when it closes (the panel is removed from the page, so the browser cannot do it).
    // Read while rendering: the dialog's own effect runs first and may already have moved the focus inside.
    const [opener] = useState(() => document.activeElement as HTMLElement | null);
    useEffect(
        () => () => {
            if (opener && opener !== document.body && opener.isConnected) opener.focus();
        },
        [opener],
    );

    const loading = project.loading || runner.loading || agents.loading || !config;

    useEffect(() => {
        // Once the controls are there, the focus starts on the first one, so Tab moves through the panel in reading order and never leaves it first.
        const d = ref.current;
        if (loading || !d) return;
        const active = document.activeElement;
        if (active !== d && active !== document.body && d.contains(active)) return;
        d.querySelector<HTMLElement>('input:not([disabled]), summary, button:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled])')?.focus();
    }, [loading]);
    // A runner list that cannot be read only takes the runners away: this server may still be able to explore.
    const failed = project.error ?? undefined;
    const m = project.data?.mobile ?? null;
    const options = whereOptions(config, agents.data ?? []);
    const chosen = where ?? defaultWhere(options, runner.data);
    const picked = options.find((o) => o.id === chosen);
    const anyWhere = options.some((o) => o.can);
    const aiMissing = config ? !aiReady : false;
    // The hosted platform (runners mode) refuses an exploration when it is made: said here before the click, and Start stays off.
    const runnersOnly = executionModeOf(config) === "runners";
    const current = runner.data ? (runner.data.runOn === "agent" ? runner.data.agentId : "platform") : "platform";
    const changesRunner = Boolean(picked?.can) && chosen !== current;

    async function start() {
        if (!picked?.can) return;
        setBusy(true);
        setError("");
        try {
            // The platform runs a project's phone work where the project runs, so choosing another place is saved first, and said so below.
            if (changesRunner) await api(`/projects/${projectId}/runner`, { method: "PUT", body: chosen === "platform" ? { runOn: "platform" } : { runOn: "agent" } });
            await api(`/projects/${projectId}/test-generation`, { method: "POST", body: startBody({ username, password }) });
            onClose();
            go(routes.project(projectId));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    const body = loading ? (
        <div className="stack" aria-busy="true" aria-label="Loading">
            <Skeleton w="60%" h={20} />
            <Skeleton h={16} />
            <Skeleton h={16} w="80%" />
            <Skeleton h={44} />
        </div>
    ) : failed || !project.data ? (
        <ErrorState error={friendlyError(failed?.message ?? "Project not found")} onRetry={() => void project.reload()} />
    ) : appState(m) !== "ready" ? (
        <div className="stack">
            <Callout tone={appState(m) === "ios-only" ? "info" : "warning"} title={appState(m) === "ios-only" ? "This project’s app is for iPhone" : appState(m) === "needs-package" ? "The app’s package name is missing" : NEED_APP}>
                {appState(m) === "ios-only" ? IPHONE_NOTE : appState(m) === "needs-package" ? NEED_PACKAGE : "Tell us which Android app to test, by its package name. Then the AI can explore it."}
            </Callout>
            <div className="foot">
                <Button onClick={onClose}>Cancel</Button>
                <LinkButton variant="primary" href={routes.setup(projectId, "mobile")}>Open Mobile app</LinkButton>
            </div>
        </div>
    ) : (
        <form
            className="stack"
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                void start();
            }}
        >
            <p>{willDo(appLabel(m))}</p>
            <div className="stack-sm">
                <p className="t-card">What it will not do</p>
                <ul className="bullets t-secondary" data-testid="phone-wont">
                    {WONT_DO.map((w) => (
                        <li key={w}>{w}</li>
                    ))}
                </ul>
            </div>

            <fieldset className="ph-where" aria-describedby={!anyWhere ? "ph-nowhere" : undefined}>
                <legend className="t-card">Where it runs</legend>
                {options.map((o) => (
                    <label key={o.id} className={`check${o.can ? "" : " is-off"}`}>
                        <input type="radio" name="ph-where" value={o.id} checked={chosen === o.id} disabled={!o.can} onChange={() => setWhere(o.id)} />
                        <span>
                            <span className="title">{o.label}</span>
                            <span className="hint">{o.detail}</span>
                        </span>
                    </label>
                ))}
                {changesRunner && <p className="t-meta" data-testid="phone-runner-change">Phone tests for this project will run there from now on. Each person’s runs go to their own runner, set up in Settings.</p>}
            </fieldset>
            {!anyWhere && (
                <div id="ph-nowhere">
                    <Callout tone="warning" title={NO_WHERE_TITLE} actions={<LinkButton href={routes.allRunners}>Open Your runner in Settings</LinkButton>}>
                        {NO_WHERE_BODY}
                    </Callout>
                </div>
            )}
            {runnersOnly && (
                <div data-testid="phone-runners-only">
                    <Callout tone="info" title={EXPLORE_ON_RUNNERS_TITLE}>
                        {EXPLORE_ON_RUNNERS}
                    </Callout>
                </div>
            )}
            {aiMissing && (
                <Callout tone="warning" title="The AI model isn’t set up" actions={<LinkButton href={routes.settings}>Open Settings</LinkButton>}>
                    {AI_MISSING}
                </Callout>
            )}

            <p className="t-meta" data-testid="phone-account-note">{ACCOUNT_REMINDER}</p>
            <Disclosure label="Advanced options">
                <div className="stack-sm">
                    <p className="t-card">Test account</p>
                    <p className="hint">Use a dedicated test account, never a real one. The password is kept encrypted and is never shown.</p>
                    <div className="field">
                        <label htmlFor="ph-user">Username or email</label>
                        <input id="ph-user" className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
                    </div>
                    <div className="field">
                        <label htmlFor="ph-pass">Password</label>
                        <input id="ph-pass" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                </div>
            </Disclosure>

            {error && <Callout tone="danger" title="We couldn’t start the exploration">{error}</Callout>}
            <div className="foot">
                <Button type="button" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button type="submit" variant="primary" icon={Sparkles} loading={busy} disabled={busy || aiMissing || runnersOnly || !picked?.can}>
                    {busy ? "Starting…" : "Start exploring"}
                </Button>
            </div>
        </form>
    );

    return (
        <Modal title={PHONE_TITLE} titleId="ph-title" icon={Smartphone} className="ph-dialog" testId="phone-start" dialogRef={ref} onClose={onClose}>
            {body}
        </Modal>
    );
}

/** "Explore with AI" next to a phone app setting; also opens by itself when the page was reached with ?start=phone (right after the welcome page saved the app). */
export function ExploreWithAi({ projectId, auto }: { projectId: string; auto?: boolean }) {
    const [open, setOpen] = useState(Boolean(auto));
    return (
        <>
            <Button icon={Sparkles} onClick={() => setOpen(true)} data-tour="explore-phone" tip="Opens a panel that says what the AI will do and where it runs. Nothing starts until you choose Start exploring, and it stops at a plan for you to approve.">Explore with AI</Button>
            {open && <PhoneStartDialog projectId={projectId} onClose={() => setOpen(false)} />}
        </>
    );
}
