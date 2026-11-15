import { ChevronRight, Pencil, Play, Plus, ShieldCheck, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout, Disclosure, EmptyState, ErrorState, LinkButton, ListSkeleton, Skeleton } from "../../components/ui";
import { BadgeKey, FieldHelp, HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { friendlyError, describeApiError } from "../../lib/labels";
import { relativeTime } from "../../lib/format";
import { normalizeUrl } from "../../lib/url";
import { go, useRoute } from "../../lib/router";
import { ApiDocumentPanel, SignInChoice, SignInPanel, signInLabel } from "./ApplicationExtras";
import { CrossAccountPanel } from "./CrossAccount";
import { SchedulePanel } from "./SchedulePanel";
import { AuthTag, SecurityLayout, StateTag, authKey, canApprove, canRun, stateKey, useRole } from "./SecurityChrome";
import { AUTH_WORDS, NOT_RECORDED, ENVIRONMENT_ORDER, ENVIRONMENT_WORDS, PROFILE_ORDER, PROFILE_WORDS, SEC, authStateOf, isRunning, sec, when, listOf, oneOf, type AppAnswer, type AppRow, type AssessmentRow, type ProfileApprovalRow, type ProfileKey, type RecordedAuthorization, type SecurityAuthorization, type SecurityEnvironment, type SensitiveWorkflow } from "./security";

// ── the list ─────────────────────────────────────────────────────────────────

export function ApplicationsPage({ id }: { id: string }) {
    const role = useRole();
    const apps = useFetch<unknown>(`${SEC}/projects/${id}/applications`);
    const appList = listOf<AppRow>(apps.data, "applications");
    const add = canRun(role) ? (
        <LinkButton href={sec.newApplication(id)} variant="primary" icon={Plus}>
            Add an application
        </LinkButton>
    ) : null;
    return (
        <SecurityLayout
            id={id}
            active="applications"
            title="Applications"
            subtitle={
                <>
                    What may be assessed, where, and under whose authorization. <BadgeKey label="the authorization states" entries={authKey(appList.map((a) => authStateOf(a)))} />
                </>
            }
            actions={appList.length ? add : null}
        >
            {apps.loading ? (
                <ListSkeleton rows={3} />
            ) : apps.error ? (
                <ErrorState error={friendlyError(apps.error.message)} onRetry={apps.reload} />
            ) : !appList.length ? (
                <div className="card">
                    <EmptyState icon={ShieldCheck} title="No applications yet" actions={add}>
                        Register the application the client asked you to assess: its address, what else is in scope, and what must never be requested.
                    </EmptyState>
                </div>
            ) : (
                <ul className="card list divided" data-testid="sec-apps">
                    {appList.map((a) => (
                        <li key={a.id}>
                            <a className="list-row" href={sec.application(id, a.id)}>
                                <span className="main">
                                    <span className="title">{a.name}</span>
                                    <span className="meta sec-list-cols">
                                        <span className="sec-loc">{a.targetUrl}</span>
                                        <span>{ENVIRONMENT_WORDS[a.environment] ?? a.environment}</span>
                                        {a.lastAssessment && <span>Last assessed {relativeTime(a.lastAssessment.finishedAt ?? a.lastAssessment.createdAt)}</span>}
                                    </span>
                                </span>
                                <span className="tail">
                                    <AuthTag state={authStateOf(a)} />
                                </span>
                                <ChevronRight size={18} className="chev" aria-hidden />
                            </a>
                        </li>
                    ))}
                </ul>
            )}
        </SecurityLayout>
    );
}

// ── register / change ────────────────────────────────────────────────────────

const lines = (s: string) =>
    s
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean);

interface WorkflowDraft {
    name: string;
    prefixes: string;
    note: string;
}
interface Draft {
    name: string;
    targetUrl: string;
    environment: SecurityEnvironment;
    scope: string;
    notes: string;
    excludedPaths: string;
    maxRequestsPerSecond: string;
    apiSpecUrl: string;
    /** "" = no sign-in (an anonymous visitor); "main" or a test account's name (round 20, SIGN). */
    signInAccount: string;
    workflows: WorkflowDraft[];
}
/** Most sensitive workflows one application keeps (src/security/extras.ts EXTRAS_LIMITS). */
const MAX_WORKFLOWS = 30;
/** The sensitive workflows as the server keeps them, for comparing with what the form holds. */
const workflowsOf = (a?: AppRow): SensitiveWorkflow[] => (a?.sensitiveWorkflows ?? []).map((w) => ({ name: w.name, pathPrefixes: [...w.pathPrefixes], note: w.note ?? null }));
const fromApp = (a?: AppRow): Draft => ({
    signInAccount: a?.signInAccount ?? "",
    workflows: workflowsOf(a).map((w) => ({ name: w.name, prefixes: w.pathPrefixes.join("\n"), note: w.note ?? "" })),
    name: a?.name ?? "",
    targetUrl: a?.targetUrl ?? "",
    environment: a?.environment ?? "staging",
    scope: (a?.scope ?? []).join("\n"),
    notes: a?.notes ?? "",
    excludedPaths: (a?.excludedPaths ?? []).join("\n"),
    maxRequestsPerSecond: String(a?.maxRequestsPerSecond ?? 2),
    apiSpecUrl: a?.apiSpecUrl ?? "",
});

/** Register an application (no `app`) or change one. Changing the target, scope, exclusions or rate makes the authorization out of date. */
export function ApplicationForm({ id, app, onDone }: { id: string; app?: AppRow; onDone?: (saved: AppRow) => void }) {
    const [d, setD] = useState<Draft>(fromApp(app));
    const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
    const [wfErrors, setWfErrors] = useState<Record<number, string>>({});
    // Open the advanced part when the application already has sensitive workflows (decided once: removing the last one must not close it).
    const [hadWorkflows] = useState(() => (app?.sensitiveWorkflows?.length ?? 0) > 0);
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        const errs: typeof errors = {};
        if (!d.name.trim()) errs.name = "Enter a name, for example “Customer portal”.";
        const t = normalizeUrl(d.targetUrl);
        if (!t.url) errs.targetUrl = t.error ?? "Enter the application’s address.";
        const rate = Number(d.maxRequestsPerSecond);
        if (!Number.isInteger(rate) || rate < 1 || rate > 10) errs.maxRequestsPerSecond = "Enter a whole number from 1 to 10.";
        const bad = lines(d.excludedPaths).find((p) => !p.startsWith("/"));
        if (bad) errs.excludedPaths = `Each excluded path starts with “/”: “${bad}” does not.`;
        if (d.apiSpecUrl.trim() && !normalizeUrl(d.apiSpecUrl).url) errs.apiSpecUrl = "Enter a full address, or leave it empty.";
        // Sensitive workflows: an empty row is ignored; a started one needs a name and paths that start with "/".
        const rowErrs: Record<number, string> = {};
        const workflows: SensitiveWorkflow[] = [];
        d.workflows.forEach((w, i) => {
            const x = { name: w.name.trim(), pathPrefixes: lines(w.prefixes), note: w.note.trim() || null };
            if (!x.name && !x.pathPrefixes.length && !x.note) return;
            const badPath = x.pathPrefixes.find((p) => !p.startsWith("/"));
            if (!x.name) rowErrs[i] = "Give the workflow a name, for example “Payments”.";
            else if (!x.pathPrefixes.length) rowErrs[i] = "Add at least one path, for example /checkout/pay.";
            else if (badPath) rowErrs[i] = `Each path starts with “/”: “${badPath}” does not.`;
            workflows.push(x);
        });
        if (Object.keys(rowErrs).length) errs.workflows = "Check the sensitive workflows.";
        setErrors(errs);
        setWfErrors(rowErrs);
        if (Object.keys(errs).length) return;
        setBusy(true);
        setProblem("");
        const body = {
            name: d.name.trim(),
            targetUrl: t.url!,
            environment: d.environment,
            scope: lines(d.scope),
            excludedPaths: lines(d.excludedPaths),
            maxRequestsPerSecond: rate,
            apiSpecUrl: d.apiSpecUrl.trim() ? normalizeUrl(d.apiSpecUrl).url : null,
            notes: d.notes.trim() || null,
            // Round 20 fields go only when set or changed, so an application without them sends exactly what it did before.
            ...((app ? (d.signInAccount || null) !== (app.signInAccount ?? null) : !!d.signInAccount) ? { signInAccount: d.signInAccount || null } : {}),
            ...(JSON.stringify(workflows) !== JSON.stringify(workflowsOf(app)) ? { sensitiveWorkflows: workflows } : {}),
        };
        try {
            const answer = app ? await api<unknown>(`${SEC}/applications/${app.id}`, { method: "PATCH", body }) : await api<unknown>(`${SEC}/projects/${id}/applications`, { method: "POST", body });
            const saved = oneOf<AppRow>(answer, "application")!;
            if (onDone) onDone(saved);
            else go(sec.application(id, saved.id, { authorize: true }));
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy(false);
        }
    }

    const field = (k: keyof Draft, label: string, input: React.ReactNode, hint?: string, help?: string) => (
        <div className="field">
            {help ? (
                <FieldHelp htmlFor={`sa-${k}`} label={label} helpLabel={label.replace(/ \(optional\)$/, "")} help={help} hint={hint} />
            ) : (
                <>
                    <label htmlFor={`sa-${k}`}>{label}</label>
                    {hint && (
                        <p className="hint" id={`sa-${k}-hint`}>
                            {hint}
                        </p>
                    )}
                </>
            )}
            {input}
            {errors[k] && (
                <div className="error-text" id={`sa-${k}-err`}>
                    {errors[k]}
                </div>
            )}
        </div>
    );
    const described = (k: keyof Draft, hint?: boolean) => [hint && `sa-${k}-hint`, errors[k] && `sa-${k}-err`].filter(Boolean).join(" ") || undefined;

    return (
        <form className="stack" onSubmit={(e) => void submit(e)} noValidate data-testid="sec-app-form">
            <div className="card card-pad stack">
                {field("name", "Name", <input id="sa-name" className="input" value={d.name} onChange={set("name")} aria-invalid={!!errors.name} aria-describedby={described("name")} />)}
                {field(
                    "targetUrl",
                    "Target address",
                    <input id="sa-targetUrl" className="input" inputMode="url" value={d.targetUrl} onChange={set("targetUrl")} placeholder="https://staging.example.com" aria-invalid={!!errors.targetUrl} aria-describedby={described("targetUrl", true)} />,
                    "Where the assessment starts. Its own origin is always in scope.",
                )}
                {field(
                    "environment",
                    "Environment",
                    <select id="sa-environment" className="input" value={d.environment} onChange={set("environment")}>
                        {ENVIRONMENT_ORDER.map((e) => (
                            <option key={e} value={e}>
                                {ENVIRONMENT_WORDS[e]}
                            </option>
                        ))}
                    </select>,
                    undefined,
                    "A label for lists and reports. It does not change what is checked or how gently.",
                )}
                {field(
                    "scope",
                    "Also in scope (optional)",
                    <textarea id="sa-scope" className="input" rows={3} value={d.scope} onChange={set("scope")} placeholder={"https://api.example.com\n*.example.com"} aria-describedby={described("scope", true)} />,
                    "Other origins or host patterns the client authorized, one per line. Anything else is never requested.",
                    "An origin such as https://api.example.com covers exactly that address and port. A host (api.example.com) or a pattern (*.example.com, its subdomains) covers the default port only.",
                )}
                {field(
                    "signInAccount",
                    "Signed-in assessment (optional)",
                    <SignInChoice projectId={id} appId={app?.id} value={d.signInAccount} onChange={(v) => setD({ ...d, signInAccount: v })} />,
                    "The assessment loads a saved sign-in into its browser and also looks at signed-in pages. It never types a password, submits a sign-in form or follows a sign-out link.",
                    "Sign-ins are saved per project under Test accounts: sign in once yourself, or upload a saved browser state. An expired one is not used: the assessment carries on signed out and its coverage says so.",
                )}
                {field("notes", "Notes (optional)", <textarea id="sa-notes" className="input" rows={2} value={d.notes} onChange={set("notes")} />)}
            </div>
            <div className="card" style={{ padding: "0 20px" }}>
                <Disclosure label="Advanced: exclusions, sensitive workflows, request limit, API document" defaultOpen={!!errors.excludedPaths || !!errors.maxRequestsPerSecond || !!errors.apiSpecUrl || !!errors.workflows || hadWorkflows}>
                    <div className="stack">
                        {field(
                            "excludedPaths",
                            "Never request these paths",
                            <textarea id="sa-excludedPaths" className="input" rows={3} value={d.excludedPaths} onChange={set("excludedPaths")} placeholder={"/admin/billing\n/logout"} aria-invalid={!!errors.excludedPaths} aria-describedby={described("excludedPaths", true)} />,
                            "Path prefixes, one per line. Links to them are noted and never followed.",
                        )}
                        <WorkflowsEditor rows={d.workflows} errors={wfErrors} onChange={(workflows) => setD({ ...d, workflows })} />
                        {field(
                            "maxRequestsPerSecond",
                            "Most requests per second",
                            <input id="sa-maxRequestsPerSecond" className="input" type="number" min={1} max={10} step={1} value={d.maxRequestsPerSecond} onChange={set("maxRequestsPerSecond")} aria-invalid={!!errors.maxRequestsPerSecond} aria-describedby={described("maxRequestsPerSecond", true)} style={{ maxWidth: 160 }} />,
                            "From 1 to 10. Two is gentle enough for most applications.",
                        )}
                        {field(
                            "apiSpecUrl",
                            "API document address (optional)",
                            <input id="sa-apiSpecUrl" className="input" inputMode="url" value={d.apiSpecUrl} onChange={set("apiSpecUrl")} placeholder="https://staging.example.com/openapi.json" aria-invalid={!!errors.apiSpecUrl} aria-describedby={described("apiSpecUrl", true)} />,
                            "An OpenAPI document, read only, when it is in scope.",
                            "It is fetched once with an ordinary GET, through the same scope checks, and its operations are counted for the coverage; none of them is called. To have its read-only operations requested, upload the document on the application’s page instead.",
                        )}
                    </div>
                </Disclosure>
            </div>
            {app && <p className="hint">Changing the target, the scope, the exclusions, the request limit, the saved sign-in or the sensitive workflows means the authorization has to be confirmed again.</p>}
            {problem && (
                <Callout tone="danger" title={app ? "We couldn’t save the changes" : "We couldn’t register the application"}>
                    {problem}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" loading={busy}>
                    {app ? "Save changes" : "Register application"}
                </Button>
                {app && onDone && (
                    <Button type="button" variant="ghost" onClick={() => onDone(app)}>
                        Cancel
                    </Button>
                )}
            </div>
        </form>
    );
}

// ── round 20: the saved sign-in and the sensitive workflows ───────────────────

/** Sensitive workflows: a name, the paths never requested, a note. Kept in the form until the application is saved. */
function WorkflowsEditor({ rows, errors, onChange }: { rows: WorkflowDraft[]; errors: Record<number, string>; onChange: (rows: WorkflowDraft[]) => void }) {
    const put = (i: number, patch: Partial<WorkflowDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    return (
        <fieldset className="stack-sm sec-workflows" data-testid="sa-workflows">
            <legend>
                <span className="field-label-row">
                    <span className="sec-legend">Sensitive workflows (optional)</span>
                    <HelpTip label="Sensitive workflows" text="Their paths are never requested, like exclusions. They are named in the authorization statement, on the assessment page and in the report, and a change asks for the authorization again." />
                </span>
            </legend>
            <p className="hint">Parts of the application that must never be touched, such as payments or deleting an account.</p>
            {rows.map((w, i) => (
                <div key={i} className="sec-workflow stack-sm" role="group" aria-label={`Sensitive workflow ${i + 1}`}>
                    <div className="grid-2">
                        <div className="field">
                            <label htmlFor={`sa-wf-${i}-name`}>Workflow name</label>
                            <input id={`sa-wf-${i}-name`} className="input" value={w.name} maxLength={120} onChange={(e) => put(i, { name: e.target.value })} placeholder="Payments" aria-invalid={!!errors[i]} aria-describedby={errors[i] ? `sa-wf-${i}-err` : undefined} />
                        </div>
                        <div className="field">
                            <label htmlFor={`sa-wf-${i}-note`}>Workflow note (optional)</label>
                            <input id={`sa-wf-${i}-note`} className="input" value={w.note} maxLength={1000} onChange={(e) => put(i, { note: e.target.value })} placeholder="Real card payments" />
                        </div>
                    </div>
                    <div className="field">
                        <label htmlFor={`sa-wf-${i}-paths`}>Paths never requested</label>
                        <textarea id={`sa-wf-${i}-paths`} className="input" rows={2} value={w.prefixes} onChange={(e) => put(i, { prefixes: e.target.value })} placeholder={"/checkout/pay\n/account/delete"} aria-invalid={!!errors[i]} aria-describedby={errors[i] ? `sa-wf-${i}-err` : undefined} />
                    </div>
                    {errors[i] && (
                        <div className="error-text" id={`sa-wf-${i}-err`}>
                            {errors[i]}
                        </div>
                    )}
                    <div className="row">
                        <Button type="button" variant="ghost" icon={Trash2} onClick={() => onChange(rows.filter((_, j) => j !== i))} tip="Takes this workflow off the list. Nothing changes until you save the application.">
                            Remove workflow
                        </Button>
                    </div>
                </div>
            ))}
            <div className="row">
                <Button type="button" icon={Plus} disabled={rows.length >= MAX_WORKFLOWS} onClick={() => onChange([...rows, { name: "", prefixes: "", note: "" }])}>
                    Add a sensitive workflow
                </Button>
                {rows.length >= MAX_WORKFLOWS && <span className="hint">At most {MAX_WORKFLOWS} workflows.</span>}
            </div>
        </fieldset>
    );
}

export function NewApplicationPage({ id }: { id: string }) {
    return (
        <SecurityLayout id={id} active="applications" title="Register application" subtitle="Next you record the client’s authorization. Nothing is sent to the application before an assessment starts." crumb={[{ label: "Applications", href: sec.applications(id) }, { label: "Register application" }]}>
            <div style={{ maxWidth: 760 }}>
                <ApplicationForm id={id} />
            </div>
        </SecurityLayout>
    );
}

// ── one application ──────────────────────────────────────────────────────────

export function ApplicationDetail({ id, appId }: { id: string; appId: string }) {
    const role = useRole();
    const authorizeAsked = useRoute().query.get("authorize") === "1";
    const app = useFetch<AppAnswer>(`${SEC}/applications/${appId}`);
    const auths = useFetch<unknown>(`${SEC}/applications/${appId}/authorizations`);
    const assessments = useFetch<unknown>(`${SEC}/projects/${id}/assessments`, (d) => (listOf<AssessmentRow>(d, "assessments").some((x) => x.applicationId === appId && isRunning(x.state)) ? 3000 : null));
    const authList = listOf<RecordedAuthorization>(auths.data, "authorizations");
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const a = app.data ? oneOf<AppRow>(app.data, "application") : undefined;
    const state = app.data?.authorization?.state ?? (a ? authStateOf(a, authList) : "none");
    const stateText = app.data?.authorization?.message ?? AUTH_WORDS[state].text;
    const statement = app.data?.statement ?? (auths.data as { statement?: string } | undefined)?.statement;
    const mine = listOf<AssessmentRow>(assessments.data, "assessments").filter((x) => x.applicationId === appId).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const running = mine.find((x) => isRunning(x.state));

    const content = () => {
        if (app.loading || auths.loading) return <Skeleton h={200} style={{ borderRadius: 12 }} />;
        if (app.error || !a) return <ErrorState error={friendlyError(app.error?.message ?? "Application not found")} onRetry={app.reload} />;
        if (editing)
            return (
                <div style={{ maxWidth: 760 }}>
                    <ApplicationForm
                        id={id}
                        app={a}
                        onDone={() => {
                            setEditing(false);
                            void app.reload();
                            void auths.reload();
                        }}
                    />
                </div>
            );
        return (
            <div className="stack">
                {state !== "current" && (
                    <Callout tone="warning" title={AUTH_WORDS[state].label}>
                        {stateText}
                    </Callout>
                )}
                <div className="sec-two">
                    <div className="stack">
                        <section className="card card-pad stack-sm" aria-labelledby="sa-scope-h">
                            <h2 className="t-section" id="sa-scope-h">
                                Scope and limits
                            </h2>
                            <dl className="kv">
                                <dt>Target</dt>
                                <dd className="sec-loc">{a.targetUrl}</dd>
                                <dt>Environment</dt>
                                <dd>{ENVIRONMENT_WORDS[a.environment] ?? a.environment}</dd>
                                <dt>Also in scope</dt>
                                <dd>{a.scope.length ? a.scope.join(", ") : "Only the target’s own origin"}</dd>
                                <dt>Never requested</dt>
                                <dd>{a.excludedPaths.length ? a.excludedPaths.join(", ") : "No exclusions"}</dd>
                                <dt>Request limit</dt>
                                <dd>At most {a.maxRequestsPerSecond} per second</dd>
                                {a.signInAccount !== undefined && (
                                    <>
                                        <dt>Signed in as</dt>
                                        <dd data-testid="sa-signin">{a.signInAccount ? `${signInLabel(a.signInAccount)}: its saved sign-in is loaded, no password is typed` : "Nobody: it visits as an anonymous visitor"}</dd>
                                    </>
                                )}
                                {a.sensitiveWorkflows !== undefined && (
                                    <>
                                        <dt>Sensitive workflows</dt>
                                        <dd data-testid="sa-sensitive">
                                            {a.sensitiveWorkflows.length ? (
                                                <ul className="sec-plain-list">
                                                    {a.sensitiveWorkflows.map((w) => (
                                                        <li key={w.name}>
                                                            {w.name}: <span className="sec-loc">{w.pathPrefixes.join(", ")}</span>
                                                            {w.note ? <span className="t-meta">. {w.note}</span> : null}
                                                        </li>
                                                    ))}
                                                </ul>
                                            ) : (
                                                "None"
                                            )}
                                        </dd>
                                    </>
                                )}
                                <dt>API document address</dt>
                                <dd className="sec-loc">{a.apiSpecUrl ?? "None"}</dd>
                                {a.notes && (
                                    <>
                                        <dt>Notes</dt>
                                        <dd>{a.notes}</dd>
                                    </>
                                )}
                            </dl>
                        </section>
                        <AuthorizationPanel app={a} auths={authList} state={state} stateText={stateText} statement={statement} openForm={authorizeAsked || state === "stale" || state === "expired"} onChanged={() => void Promise.all([app.reload(), auths.reload()])} />
                        <ApprovalsPanel app={a} />
                        {/* Round 20 (SIGN's fields): shown when the server knows them. */}
                        {a.signInAccount !== undefined && <SignInPanel projectId={id} app={a} onChanged={() => void app.reload()} />}
                        {a.apiDocument !== undefined && <ApiDocumentPanel app={a} onChanged={() => void app.reload()} />}
                        <CrossAccountPanel projectId={id} app={a} onChanged={() => void Promise.all([app.reload(), auths.reload()])} />
                        <SchedulePanel app={a} canChange={canRun(role)} authorized={state === "current"} />
                    </div>
                    <section className="stack-sm" aria-labelledby="sa-runs-h">
                        <div className="row" style={{ gap: 4 }}>
                            <h2 className="t-section" id="sa-runs-h">
                                Assessments
                            </h2>
                            <BadgeKey label="the assessment states" entries={stateKey(mine.slice(0, 10).map((x) => x.state))} />
                        </div>
                        {mine.length === 0 ? (
                            <div className="card card-pad">
                                <p className="t-secondary">Not assessed yet.</p>
                            </div>
                        ) : (
                            <ul className="card list divided">
                                {mine.slice(0, 10).map((x) => (
                                    <li key={x.id}>
                                        <a className="list-row" href={sec.assessment(id, x.id)}>
                                            <span className="main">
                                                <span className="title">{x.retestOf ? "Retest" : "Passive assessment"}</span>
                                                <span className="meta">{when(x.createdAt)}</span>
                                            </span>
                                            <span className="tail">
                                                <StateTag state={x.state} />
                                            </span>
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
                {deleting && <DeleteApp id={id} app={a} onClose={() => setDeleting(false)} />}
            </div>
        );
    };

    return (
        <SecurityLayout
            id={id}
            active="applications"
            title={a?.name ?? "Application"}
            subtitle={a ? <AuthTag state={state} tipFocusable /> : undefined}
            crumb={[{ label: "Applications", href: sec.applications(id) }, { label: a?.name ?? "…" }]}
            actions={
                a && !editing ? (
                    <>
                        {running ? (
                            <LinkButton href={sec.assessment(id, running.id)} variant="primary">
                                Watch the running assessment
                            </LinkButton>
                        ) : (
                            canRun(role) && (
                                <LinkButton href={sec.newAssessment(id, a.id)} variant="primary" icon={Play}>
                                    New assessment
                                </LinkButton>
                            )
                        )}
                        {canRun(role) && (
                            <Button icon={Pencil} onClick={() => setEditing(true)} tip="Edit the target, scope, sign-in and limits. A change to the target, scope, exclusions, request limit, saved sign-in or sensitive workflows means the authorization must be confirmed again.">
                                Change
                            </Button>
                        )}
                        {canApprove(role) && (
                            <Button variant="ghost" icon={Trash2} onClick={() => setDeleting(true)} tip="Asks first. Removes the application with its authorizations, assessments and findings; not possible while an assessment of it runs.">
                                Delete
                            </Button>
                        )}
                    </>
                ) : null
            }
        >
            {content()}
        </SecurityLayout>
    );
}

function DeleteApp({ id, app, onClose }: { id: string; app: AppRow; onClose: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function del() {
        setBusy(true);
        setError("");
        try {
            await api(`${SEC}/applications/${app.id}`, { method: "DELETE" });
            go(sec.applications(id));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    return (
        <Modal
            title={`Delete ${app.name}?`}
            titleId="sa-del-title"
            onClose={onClose}
            foot={
                <>
                    <Button onClick={onClose}>Keep it</Button>
                    <Button variant="danger" icon={Trash2} loading={busy} onClick={() => void del()}>
                        Delete application
                    </Button>
                </>
            }
        >
            <p className="t-secondary">The application, its authorizations, its assessments and its findings are removed for good. Reports already downloaded are not affected.</p>
            {error && <Callout tone="danger">{error}</Callout>}
        </Modal>
    );
}

// ── authorization ────────────────────────────────────────────────────────────

/** The specific statement the person confirms (CORE records it; the words name the target and the scope). */
export function statementFor(app: AppRow, basis: SecurityAuthorization["basis"]): string {
    const scope = app.scope.length ? ` and ${app.scope.join(", ")}` : "";
    return basis === "owner"
        ? `I confirm that we own ${app.targetUrl}${scope}, and that it may be assessed passively within the scope listed, at no more than ${app.maxRequestsPerSecond} requests per second${app.excludedPaths.length ? `, never requesting ${app.excludedPaths.join(", ")}` : ""}.`
        : `I confirm that the owner of ${app.targetUrl}${scope} has given documented permission to assess it passively within the scope listed, at no more than ${app.maxRequestsPerSecond} requests per second${app.excludedPaths.length ? `, never requesting ${app.excludedPaths.join(", ")}` : ""}.`;
}

function AuthorizationPanel({ app, auths, state, stateText, statement, openForm, onChanged }: { app: AppRow; auths: RecordedAuthorization[]; state: ReturnType<typeof authStateOf>; stateText: string; statement?: string; openForm: boolean; onChanged: () => void }) {
    const role = useRole();
    const [form, setForm] = useState(openForm && state !== "current");
    useEffect(() => setForm(openForm && state !== "current"), [openForm, state]);
    const latest = [...auths].sort((x, y) => y.confirmedAt.localeCompare(x.confirmedAt));
    const live = latest.find((x) => !x.revokedAt);
    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-auth-h" data-testid="sec-authorization">
            <div className="row">
                <h2 className="t-section" id="sa-auth-h" style={{ flex: 1 }}>
                    Authorization
                </h2>
                <AuthTag state={state} />
            </div>
            {live ? (
                <dl className="kv">
                    <dt>Basis</dt>
                    <dd>{live.basis === "owner" ? "We own the application" : "The owner gave documented permission"}</dd>
                    <dt>Authorized by</dt>
                    <dd>
                        {live.approverName}
                        {live.approverEmail ? `, ${live.approverEmail}` : ""}
                    </dd>
                    <dt>Their role</dt>
                    <dd data-testid="sec-auth-role">{live.approverRole ?? NOT_RECORDED}</dd>
                    <dt>Their authority</dt>
                    <dd data-testid="sec-auth-authority">{live.authority ?? NOT_RECORDED}</dd>
                    <dt>Document</dt>
                    <dd>{live.documentReference ?? "None given"}</dd>
                    <dt>Restrictions</dt>
                    <dd>{live.restrictions ?? "None"}</dd>
                    <dt>Recorded</dt>
                    <dd>
                        {when(live.confirmedAt)} by {live.confirmedByName}
                    </dd>
                    <dt>Expires</dt>
                    <dd data-testid="sec-auth-expires">{live.expiresAt ? when(live.expiresAt) : "Not known yet"}</dd>
                    <dt>Allows at most</dt>
                    <dd data-testid="sec-auth-max">{PROFILE_WORDS[(live.maxProfile ?? "passive") as ProfileKey] ?? PROFILE_WORDS.passive}</dd>
                    <dt>Cross-account test accounts</dt>
                    <dd>{live.crossAccounts?.length ? live.crossAccounts.map(signInLabel).join(" and ") : "None named"}</dd>
                </dl>
            ) : (
                <p className="t-secondary">{stateText}</p>
            )}
            {live && live.detailsRecorded === false && (
                <p className="hint" data-testid="sec-auth-details-missing">
                    Recorded before the authorizing person’s role and documented authority were asked for: it covers passive assessments only
                    {live.expiresAt ? `, and it stops counting on ${when(live.expiresAt)} (90 days after the server was updated to require those details)` : ""}. Record a new authorization with
                    those details before then, and before anything above passive.
                </p>
            )}
            {!form && (
                <div className="row">
                    {canApprove(role) && (
                        <Button variant={state === "current" ? "secondary" : "primary"} icon={ShieldCheck} onClick={() => setForm(true)}>
                            {state === "current" ? "Record a new authorization" : state === "stale" || state === "expired" ? "Confirm the authorization again" : "Record authorization"}
                        </Button>
                    )}
                    {canApprove(role) && live && <Revoke auth={live} onDone={onChanged} />}
                    {!canApprove(role) && <p className="hint">Only a project owner can record or withdraw an authorization.</p>}
                </div>
            )}
            {form && canApprove(role) && (
                <AuthorizationForm
                    app={app}
                    statement={statement}
                    previous={live}
                    onCancel={() => setForm(false)}
                    onDone={() => {
                        setForm(false);
                        onChanged();
                    }}
                />
            )}
            {latest.some((x) => x.revokedAt) && (
                <Disclosure label="Earlier authorizations">
                    <ul className="sec-history">
                        {latest
                            .filter((x) => x.revokedAt)
                            .map((x) => (
                                <li key={x.id}>
                                    <span>
                                        {x.approverName}, recorded {when(x.confirmedAt)}
                                    </span>
                                    <span className="t-meta">Withdrawn {when(x.revokedAt)}</span>
                                </li>
                            ))}
                    </ul>
                </Disclosure>
            )}
        </section>
    );
}

function AuthorizationForm({ app, statement: given, previous, onCancel, onDone }: { app: AppRow; statement?: string; previous?: RecordedAuthorization; onCancel: () => void; onDone: () => void }) {
    const [basis, setBasis] = useState<SecurityAuthorization["basis"]>(previous?.basis ?? "client-permission");
    const [approverName, setName] = useState(previous?.approverName ?? "");
    const [approverRole, setRole] = useState(previous?.approverRole ?? "");
    const [authority, setAuthority] = useState(previous?.authority ?? "");
    const [approverEmail, setEmail] = useState(previous?.approverEmail ?? "");
    const [documentReference, setDoc] = useState(previous?.documentReference ?? "");
    const [restrictions, setRestrictions] = useState(previous?.restrictions ?? "");
    const [confirmed, setConfirmed] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    // The profile gate: the most this authorization allows (passive unless chosen) and, when the application has a cross-account
    // designation, whether it names that designation's two test accounts.
    const [maxProfile, setMaxProfile] = useState<ProfileKey>("passive");
    const designation = useFetch<{ designation: { accountA: string; accountB: string } | null }>(`${SEC}/applications/${app.id}/cross-account`);
    const pair = designation.data?.designation ? [designation.data.designation.accountA, designation.data.designation.accountB] : null;
    const [nameAccounts, setNameAccounts] = useState(true);
    const crossAccounts = pair && nameAccounts ? pair : [];
    const query = new URLSearchParams({ ...(maxProfile !== "passive" ? { maxProfile } : {}), ...(crossAccounts.length ? { crossAccounts: crossAccounts.join(",") } : {}) }).toString();
    const preview = useFetch<{ statement: string }>(query ? `${SEC}/applications/${app.id}/authorization-statement?${query}` : null);
    // The server words the statement (it names the organization); the page words one itself only when the server sends none.
    const statement = (query ? preview.data?.statement : undefined) ?? given ?? statementFor(app, basis);
    async function submit(e: React.FormEvent) {
        e.preventDefault();
        const errs: Record<string, string> = {};
        if (!approverName.trim()) errs.name = "Enter the name of the person at the client who authorized the assessment.";
        if (!approverRole.trim()) errs.role = "Enter the authorizing person’s role at the client, for example their job title.";
        if (!approverEmail.trim()) errs.email = "Enter the authorizing person’s email address.";
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(approverEmail.trim())) errs.email = "Enter an email address like name@example.com.";
        if (!documentReference.trim()) errs.doc = "Enter the reference of the document that records the permission.";
        if (!authority.trim()) errs.authority = "Say what gives this person the authority to permit testing on behalf of the application’s owner.";
        if (!confirmed) errs.confirm = "Tick the box to confirm the statement.";
        setErrors(errs);
        if (Object.keys(errs).length) return;
        setBusy(true);
        setProblem("");
        try {
            await api(`${SEC}/applications/${app.id}/authorizations`, {
                method: "POST",
                body: {
                    basis,
                    approverName: approverName.trim(),
                    approverRole: approverRole.trim(),
                    approverEmail: approverEmail.trim(),
                    documentReference: documentReference.trim(),
                    authority: authority.trim(),
                    restrictions: restrictions.trim() || null,
                    confirm: true,
                    ...(maxProfile !== "passive" ? { maxProfile } : {}),
                    ...(crossAccounts.length ? { crossAccounts } : {}),
                },
            });
            onDone();
        } catch (err) {
            setProblem(describeApiError(err));
            setBusy(false);
        }
    }
    return (
        <form className="stack-sm" onSubmit={(e) => void submit(e)} noValidate data-testid="sec-auth-form">
            <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                <legend className="t-card" style={{ marginBottom: 8 }}>
                    Basis
                </legend>
                <label className="check">
                    <input type="radio" name="sa-basis" checked={basis === "client-permission"} onChange={() => setBasis("client-permission")} />
                    <span>
                        <span className="title">The owner gave documented permission</span>
                        <span className="hint">For a client’s application: an engagement letter or a written permission. Give the name of the person at the client who authorized it.</span>
                    </span>
                </label>
                <label className="check">
                    <input type="radio" name="sa-basis" checked={basis === "owner"} onChange={() => setBasis("owner")} />
                    <span>
                        <span className="title">We own the application</span>
                    </span>
                </label>
            </fieldset>
            <div className="grid-2">
                <div className="field">
                    <label htmlFor="sa-approver">Authorized by</label>
                    <input id="sa-approver" className="input" autoComplete="off" value={approverName} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? "sa-approver-err" : undefined} />
                    {errors.name && (
                        <div className="error-text" id="sa-approver-err">
                            {errors.name}
                        </div>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="sa-approver-role">Their role</label>
                    <input id="sa-approver-role" className="input" autoComplete="off" value={approverRole} onChange={(e) => setRole(e.target.value)} placeholder="For example “Head of Engineering”" aria-invalid={!!errors.role} aria-describedby={errors.role ? "sa-approver-role-err" : undefined} />
                    {errors.role && (
                        <div className="error-text" id="sa-approver-role-err">
                            {errors.role}
                        </div>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="sa-approver-email">Their email</label>
                    <input id="sa-approver-email" className="input" type="email" autoComplete="off" value={approverEmail} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? "sa-approver-email-err" : undefined} />
                    {errors.email && (
                        <div className="error-text" id="sa-approver-email-err">
                            {errors.email}
                        </div>
                    )}
                </div>
            </div>
            <div className="field">
                <label htmlFor="sa-doc">Permission document</label>
                <input id="sa-doc" className="input" value={documentReference} onChange={(e) => setDoc(e.target.value)} placeholder="For example “Engagement letter 2026-114, signed 12 October”" aria-invalid={!!errors.doc} aria-describedby={errors.doc ? "sa-doc-err" : undefined} />
                {errors.doc && (
                    <div className="error-text" id="sa-doc-err">
                        {errors.doc}
                    </div>
                )}
            </div>
            <div className="field">
                <FieldHelp htmlFor="sa-authority" label="Their authority to permit testing" helpLabel="Authority" help="What gives this person the right to permit security testing on behalf of the application’s owner: for example “Signed the engagement letter as the owner’s CTO” or “Named as the testing contact in the statement of work, section 4”." />
                <textarea id="sa-authority" className="input" rows={2} value={authority} onChange={(e) => setAuthority(e.target.value)} aria-invalid={!!errors.authority} aria-describedby={errors.authority ? "sa-authority-err" : undefined} />
                {errors.authority && (
                    <div className="error-text" id="sa-authority-err">
                        {errors.authority}
                    </div>
                )}
            </div>
            <div className="field">
                <FieldHelp htmlFor="sa-restrictions" label="Restrictions (optional)" helpLabel="Restrictions" help="Kept with the authorization and printed in the reports. The platform does not enforce them: use the exclusions and the request limit for what it must never do." />
                <textarea id="sa-restrictions" className="input" rows={2} value={restrictions} onChange={(e) => setRestrictions(e.target.value)} placeholder="For example “Weekdays after 18:00 only”" />
            </div>
            <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                <legend className="t-card" style={{ marginBottom: 8 }}>
                    The most it allows
                </legend>
                {PROFILE_ORDER.map((k) => (
                    <label className="check" key={k}>
                        <input type="radio" name="sa-max-profile" checked={maxProfile === k} onChange={() => setMaxProfile(k)} />
                        <span>
                            <span className="title">{PROFILE_WORDS[k]}</span>
                            {k !== "passive" && <span className="hint">Development or staging only, and read requests only: no request is meant to change data, though an application can still react to a read request in a way nobody intended. This authorization does not approve the profile: each assessment at it also needs a Crowd4Test admin’s approval for this application’s environment.</span>}
                        </span>
                    </label>
                ))}
            </fieldset>
            {pair && (
                <label className="check">
                    <input type="checkbox" checked={nameAccounts} onChange={(e) => setNameAccounts(e.target.checked)} />
                    <span>
                        <span className="title">Name the cross-account test accounts</span>
                        <span className="hint">
                            {signInLabel(pair[0]!)} and {signInLabel(pair[1]!)}. The cross-account checks run only when the authorization names both.
                        </span>
                    </span>
                </label>
            )}
            <p className="sec-statement" data-testid="sec-statement">
                {statement}
            </p>
            <label className="check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} aria-invalid={!!errors.confirm} aria-describedby={errors.confirm ? "sa-confirm-err" : undefined} />
                <span>
                    <span className="title">I confirm the statement above</span>
                    <span className="hint">It is recorded with your name and the time, and lasts 90 days. A change to the target, environment, scope, exclusions, request limit, saved sign-in, sensitive workflows or the test accounts it uses asks for it again.</span>
                </span>
            </label>
            {errors.confirm && (
                <div className="error-text" id="sa-confirm-err">
                    {errors.confirm}
                </div>
            )}
            {problem && (
                <Callout tone="danger" title="We couldn’t record the authorization">
                    {problem}
                </Callout>
            )}
            <div className="row">
                <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy}>
                    Record authorization
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}

/** Approvals of a profile above passive (src/security/profile-gate.ts): listed for everyone, recorded and withdrawn by a Crowd4Test admin only. */
function ApprovalsPanel({ app }: { app: AppRow }) {
    const answer = useFetch<{ approvals: ProfileApprovalRow[]; statements: Record<string, string>; activeProfilesOn: boolean; environmentAllowed?: boolean; mayApprove?: boolean; approveRefusal?: string | null }>(`${SEC}/applications/${app.id}/approvals`);
    const [profile, setProfile] = useState<Exclude<ProfileKey, "passive">>("conservative-active");
    const [open, setOpen] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    if (!answer.data) return null;
    const live = answer.data.approvals.filter((x) => !x.withdrawnAt);
    // The server decides who may approve (a Crowd4Test admin) and where (development or staging only).
    const mayApprove = answer.data.mayApprove === true && answer.data.environmentAllowed !== false;
    async function approve() {
        if (!confirmed) {
            setProblem("Tick the box to confirm the approval.");
            return;
        }
        setBusy(true);
        setProblem("");
        try {
            await api(`${SEC}/applications/${app.id}/approvals`, { method: "POST", body: { profile, confirm: true } });
            setOpen(false);
            setConfirmed(false);
            await answer.reload();
        } catch (err) {
            setProblem(describeApiError(err));
        } finally {
            setBusy(false);
        }
    }
    async function withdraw(id: string) {
        try {
            await api(`${SEC}/applications/${app.id}/approvals/${id}`, { method: "DELETE" });
            await answer.reload();
        } catch (err) {
            setProblem(describeApiError(err));
        }
    }
    return (
        <section className="card card-pad stack-sm" aria-labelledby="sa-approvals-h" data-testid="sec-approvals">
            <h2 className="t-section" id="sa-approvals-h">
                Profiles above passive
            </h2>
            <p className="t-secondary">An assessment above passive starts only against a development or staging application, with the client’s authorization allowing that profile and, separately, a Crowd4Test admin’s approval for its environment. Only a signed-in Crowd4Test admin approves; the client’s authorization never does.</p>
            {answer.data.environmentAllowed === false && (
                <Callout tone="info" title="Only passive assessments for this application">
                    It is marked as {app.environment}. Profiles above passive run only against an application marked as development or staging.
                </Callout>
            )}
            {!answer.data.activeProfilesOn && (
                <Callout tone="info" title="Only passive assessments start on this server">
                    Profiles above passive are switched off here (the platform setting SECURITY_ACTIVE_PROFILES). Approvals are kept, but they start nothing.
                </Callout>
            )}
            {live.length ? (
                <ul className="sec-history">
                    {live.map((x) => (
                        <li key={x.id}>
                            <span>
                                {PROFILE_WORDS[x.profile]}, approved by the Crowd4Test admin {x.approvedByName} {when(x.approvedAt)} for {x.environment}
                            </span>
                            {x.current && (
                                <span className="t-meta" data-testid="sec-approval-state">
                                    {x.current.message}
                                </span>
                            )}
                            {mayApprove && (
                                <Button size="sm" variant="ghost" icon={Undo2} onClick={() => void withdraw(x.id)} aria-label={`Withdraw the approval of ${PROFILE_WORDS[x.profile]}`}>
                                    Withdraw
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="hint">No profile above passive is approved for this application.</p>
            )}
            {mayApprove && !open && (
                <div className="row">
                    <Button variant="secondary" icon={ShieldCheck} onClick={() => setOpen(true)}>
                        Approve a profile
                    </Button>
                </div>
            )}
            {mayApprove && open && (
                <div className="stack-sm" data-testid="sec-approval-form">
                    <div className="field">
                        <label htmlFor="sa-approve-profile">Profile</label>
                        <select id="sa-approve-profile" className="input" value={profile} onChange={(e) => setProfile(e.target.value as Exclude<ProfileKey, "passive">)}>
                            <option value="conservative-active">{PROFILE_WORDS["conservative-active"]}</option>
                            <option value="advanced">{PROFILE_WORDS.advanced}</option>
                        </select>
                    </div>
                    <p className="sec-statement">{answer.data.statements[profile]}</p>
                    <label className="check">
                        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                        <span>
                            <span className="title">I approve this profile for this application</span>
                            <span className="hint">Recorded with your name, as a Crowd4Test admin, and the time. It lasts 30 days, and stops counting at once if the application’s target, scope, environment, saved sign-in or test accounts change.</span>
                        </span>
                    </label>
                    {problem && (
                        <Callout tone="danger" title="We couldn’t record the approval">
                            {problem}
                        </Callout>
                    )}
                    <div className="row">
                        <Button variant="primary" icon={ShieldCheck} loading={busy} onClick={() => void approve()}>
                            Record approval
                        </Button>
                        <Button variant="ghost" onClick={() => setOpen(false)}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
            {!mayApprove && answer.data.environmentAllowed !== false && (
                <p className="hint" data-testid="sec-approve-refusal">
                    {answer.data.approveRefusal || "Only a Crowd4Test admin can approve a profile above passive."}
                </p>
            )}
        </section>
    );
}

function Revoke({ auth, onDone }: { auth: SecurityAuthorization; onDone: () => void }) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    async function revoke() {
        setBusy(true);
        setError("");
        try {
            await api(`${SEC}/authorizations/${auth.id}`, { method: "DELETE" });
            setAsking(false);
            onDone();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }
    return (
        <>
            <Button variant="ghost" icon={Undo2} onClick={() => setAsking(true)} tip="Asks first. No new assessment can start until a new authorization is recorded, and one that is running is asked to stop.">
                Withdraw authorization
            </Button>
            {asking && (
                <Modal
                    title="Withdraw the authorization?"
                    titleId="sa-revoke-title"
                    onClose={() => setAsking(false)}
                    foot={
                        <>
                            <Button onClick={() => setAsking(false)}>Keep it</Button>
                            <Button variant="danger" icon={Undo2} loading={busy} onClick={() => void revoke()}>
                                Withdraw
                            </Button>
                        </>
                    }
                >
                    <p className="t-secondary">No new assessment can start until a new authorization is recorded, and an assessment of this application that is running now is asked to stop. Findings and reports are kept.</p>
                    {error && <Callout tone="danger">{error}</Callout>}
                </Modal>
            )}
        </>
    );
}
