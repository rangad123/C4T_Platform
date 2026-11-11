import { OctagonX, ShieldCheck, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type ProjectDetail } from "../../api";
import { Modal } from "../../components/Modal";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, EmptyState, LinkButton, PageHeader, Skeleton, toneIcon } from "../../components/ui";
import { keyEntries } from "../../components/Tooltip";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { help } from "../../lib/help";
import { routes } from "../../lib/router";
import { useAuth } from "../auth/auth";
import { AUTH_WORDS, CATEGORY_WORDS, SEC, SEVERITY_WORDS, STATE_WORDS, VALIDATION_WORDS, includesSecurity, saveTestingType, sec, useSecurityStatus, useTestingType, type AssessmentState, type AuthorizationState, type FindingCategory, type Severity, type ValidationState } from "./security";
import "./security.css";
import { describeApiError } from "../../lib/labels";

export type SecurityTab = "overview" | "applications" | "new" | "assessments" | "findings" | "reports" | "activity" | "notifications";

const TABS: Array<{ key: SecurityTab; label: string; href: (id: string) => string }> = [
    { key: "overview", label: "Overview", href: sec.overview },
    { key: "applications", label: "Applications", href: sec.applications },
    { key: "new", label: "New assessment", href: (id) => sec.newAssessment(id) },
    { key: "assessments", label: "Assessments", href: sec.assessments },
    { key: "findings", label: "Findings", href: (id) => sec.findings(id) },
    { key: "reports", label: "Reports", href: (id) => sec.reports(id) },
    { key: "activity", label: "Activity", href: (id) => sec.activity(id) },
    { key: "notifications", label: "Notifications", href: sec.notifications },
];

export function SecurityTabs({ id, active }: { id: string; active: SecurityTab }) {
    const nav = useRef<HTMLElement>(null);
    useEffect(() => {
        nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
    }, [active]);
    return (
        <nav className="tabs" aria-label="Security assessment sections" ref={nav}>
            {TABS.map((t) => (
                <a key={t.key} className="tab" href={t.href(id)} aria-current={t.key === active ? "page" : undefined} data-tour={`sec-${t.key}`}>
                    {t.label}
                </a>
            ))}
        </nav>
    );
}

/** The role of the person using the page (the server checks every action; this only explains a button that would be refused). */
export function useRole(): "owner" | "editor" | "viewer" {
    return useAuth().state?.me?.role ?? "owner";
}
export const canRun = (r: string) => r === "owner" || r === "editor";
export const canApprove = (r: string) => r === "owner";

/**
 * Every page of a project's security section: breadcrumbs, title, the section tabs, and the two gates (the module switched off on
 * the server; security not turned on for this project, with the way to turn it on).
 */
export function SecurityLayout({ id, active, title, subtitle, actions, crumb, children }: { id: string; active: SecurityTab; title: string; subtitle?: ReactNode; actions?: ReactNode; crumb?: Array<{ label: string; href?: string }>; children: ReactNode }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const status = useSecurityStatus();
    const type = useTestingType(id);
    const name = project.data?.name;
    useDocumentTitle(`${title} · Security assessment${name ? ` · ${name}` : ""}`);
    usePage({
        // Four crumbs at most (a phone's width): the section tabs already say which part of the security section this is.
        crumbs: active === "overview" && !crumb ? [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Security assessment" }] : [{ label: "Projects", href: routes.home }, { label: name ?? "…", href: routes.project(id) }, { label: "Security assessment", href: sec.overview(id) }, { label: crumb?.[crumb.length - 1]?.label ?? title }],
        nav: "security",
    });

    if (!status || !type) {
        return (
            <div className="stack" aria-busy="true" aria-label="Loading">
                <Skeleton w={260} h={28} />
                <Skeleton h={120} style={{ borderRadius: 12 }} />
            </div>
        );
    }
    if (!status.enabled) {
        return (
            <div className="card">
                <EmptyState icon={ShieldOff} title="Security assessment is turned off on this server" actions={<LinkButton href={routes.project(id)}>Open the project</LinkButton>}>
                    The person who runs this platform can turn it on with the SECURITY_ASSESSMENT setting. Functional testing works as usual.
                </EmptyState>
            </div>
        );
    }
    return (
        <>
            <PageHeader
                title={title}
                subtitle={subtitle}
                actions={
                    <>
                        {actions}
                        {includesSecurity(type.type) && <EmergencyStop projectId={id} />}
                    </>
                }
            />
            <SecurityTabs id={id} active={active} />
            {type.problem && (
                <div style={{ marginBottom: 16 }}>
                    <Callout tone="warning" title="We couldn’t read this project’s testing type">
                        {type.problem}
                    </Callout>
                </div>
            )}
            {includesSecurity(type.type) || type.problem ? children : <TurnOn id={id} />}
        </>
    );
}

/** Security is not turned on for this project: say so and offer to turn it on (functional testing is kept). */
function TurnOn({ id }: { id: string }) {
    const role = useRole();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function on() {
        setBusy(true);
        setError("");
        try {
            await saveTestingType(id, "both");
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    return (
        <div className="card">
            <EmptyState
                icon={ShieldCheck}
                title="Security assessment is not turned on for this project"
                actions={
                    <>
                        <Button variant="primary" icon={ShieldCheck} loading={busy} disabled={!canRun(role)} onClick={() => void on()}>
                            Turn on security assessment
                        </Button>
                        <LinkButton href={routes.setup(id)}>Open Settings</LinkButton>
                    </>
                }
            >
                Turning it on keeps everything this project already has. Functional tests and security findings stay apart. {canRun(role) ? "" : "Your role can look but not change this; ask an editor or owner."}
            </EmptyState>
            {error && (
                <div style={{ padding: "0 24px 24px" }}>
                    <Callout tone="danger" title="We couldn’t turn it on">
                        {error}
                    </Callout>
                </div>
            )}
        </div>
    );
}

/**
 * Emergency stop: cancels every running assessment of the project at once. A real modal that says what happens first; what was
 * found before the stop is kept.
 */
export function EmergencyStop({ projectId, onStopped }: { projectId: string; onStopped?: () => void }) {
    const role = useRole();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState("");
    async function stop() {
        setBusy(true);
        setError("");
        try {
            const a = await api<{ cancelled?: number; stopped?: number; count?: number }>(`${SEC}/projects/${projectId}/stop-all`, { method: "POST" });
            const n = a?.cancelled ?? a?.stopped ?? a?.count;
            setDone(n === undefined ? "Every running assessment was told to stop." : n === 0 ? "Nothing was running." : `${n} running assessment${n === 1 ? " was" : "s were"} stopped.`);
            setOpen(false);
            onStopped?.();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <Button variant="danger" icon={OctagonX} data-tour="sec-stop" onClick={() => (setDone(""), setOpen(true))} disabled={!canRun(role)} tip={canRun(role) ? "Stops every running assessment of this project within seconds. You confirm first; what they found is kept." : "Editors and owners can stop assessments."}>
                Emergency stop
            </Button>
            {done && (
                <span className="t-meta" role="status" data-testid="stop-all-result">
                    {done}
                </span>
            )}
            {open && (
                <Modal
                    title="Stop every running assessment?"
                    titleId="sec-stop-title"
                    onClose={() => setOpen(false)}
                    foot={
                        <>
                            <Button onClick={() => setOpen(false)}>Keep running</Button>
                            <Button variant="danger" icon={OctagonX} loading={busy} onClick={() => void stop()}>
                                Stop them all
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">Every assessment of this project that is running now stops within seconds and sends no more requests. What each one found before the stop is kept. Nothing else changes.</p>
                    {error && <Callout tone="danger">{error}</Callout>}
                </Modal>
            )}
        </>
    );
}

// ── badges ────────────────────────────────────────────────────────────────────

export function SeverityTag({ severity, tipFocusable }: { severity: Severity; tipFocusable?: boolean }) {
    const s = SEVERITY_WORDS[severity] ?? { label: severity, tone: "neutral" as const };
    return (
        <Badge tone={s.tone} tip={SEVERITY_WORDS[severity] ? `Severity. ${help("securitySeverity", severity)}` : undefined} tipFocusable={tipFocusable}>
            {s.label}
        </Badge>
    );
}

export function ValidationTag({ validation, tipFocusable }: { validation: ValidationState; tipFocusable?: boolean }) {
    const v = VALIDATION_WORDS[validation] ?? { label: validation, tone: "neutral" as const, help: "" };
    return (
        <Badge tone={v.tone} icon={toneIcon(v.tone)} tip={VALIDATION_WORDS[validation] ? help("findingValidation", validation) : undefined} tipFocusable={tipFocusable}>
            {v.label}
        </Badge>
    );
}

export function StateTag({ state, tipFocusable }: { state: AssessmentState; tipFocusable?: boolean }) {
    const s = STATE_WORDS[state] ?? { label: state, tone: "neutral" as const, help: "" };
    return (
        <Badge tone={s.tone} icon={toneIcon(s.tone)} tip={STATE_WORDS[state] ? help("assessment", state) : undefined} tipFocusable={tipFocusable}>
            {s.label}
        </Badge>
    );
}

export function AuthTag({ state, tipFocusable }: { state: AuthorizationState["state"]; tipFocusable?: boolean }) {
    const a = AUTH_WORDS[state];
    return (
        <Badge tone={a.tone} icon={toneIcon(a.tone)} tip={a.text} tipFocusable={tipFocusable}>
            {a.label}
        </Badge>
    );
}

// The BadgeKey lines for the tags above (same words and definitions), for the values a list shows.
export const severityKey = (present: Iterable<Severity | null | undefined>) => keyEntries(Object.keys(SEVERITY_WORDS) as Severity[], present, (s) => SEVERITY_WORDS[s].label, (s) => help("securitySeverity", s));
export const validationKey = (present: Iterable<ValidationState | null | undefined>) => keyEntries(Object.keys(VALIDATION_WORDS) as ValidationState[], present, (v) => VALIDATION_WORDS[v].label, (v) => help("findingValidation", v));
export const stateKey = (present: Iterable<AssessmentState | null | undefined>) => keyEntries(Object.keys(STATE_WORDS) as AssessmentState[], present, (s) => STATE_WORDS[s].label, (s) => help("assessment", s));
export const authKey = (present: Iterable<AuthorizationState["state"] | null | undefined>) => keyEntries(Object.keys(AUTH_WORDS) as Array<AuthorizationState["state"]>, present, (a) => AUTH_WORDS[a].label, (a) => AUTH_WORDS[a].text);

export const categoryLabel = (c: FindingCategory) => CATEGORY_WORDS[c] ?? c;
