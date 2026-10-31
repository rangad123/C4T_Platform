import { Plus, Search, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Badge, Button, Callout, EmptyState, ErrorState, LinkButton, ListSkeleton, Skeleton } from "../../components/ui";
import { BadgeKey, FieldHelp, HelpTip } from "../../components/Tooltip";
import { useFetch } from "../../lib/hooks";
import { help } from "../../lib/help";
import { friendlyError } from "../../lib/labels";
import { go, useRoute } from "../../lib/router";
import { FindingList, findingKey } from "./Overview";
import { SecurityLayout, SeverityTag, ValidationTag, canRun, categoryLabel, useRole } from "./SecurityChrome";
import {
    CATEGORY_ORDER,
    CATEGORY_WORDS,
    CONFIDENCE_WORDS,
    OPEN_VALIDATION,
    SEC,
    SEVERITY_ORDER,
    SEVERITY_WORDS,
    VALIDATION_ORDER,
    VALIDATION_WORDS,
    sec,
    securityError,
    oneOf,
    useApps,
    when,
    type Confidence,
    type FindingCategory,
    type HistoryRow,
    type SecurityFinding,
    type Severity,
    type ValidationState,
} from "./security";

/** The filters the findings route takes (FIND), in the order the page shows them. Kept in the address so a filtered list can be shared. */
const FILTER_KEYS = ["application", "severity", "category", "validation", "from", "to", "location", "q"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

export function FindingsPage({ id }: { id: string }) {
    const role = useRole();
    const { query } = useRoute();
    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, query.get(k) ?? ""])) as Record<FilterKey, string>;
    // "Open" is a shortcut from the overview: needs a look, probable and confirmed (the server takes one validation at a time, so the page narrows).
    const openOnly = query.get("open") === "1" && !filters.validation;
    const qs = new URLSearchParams(FILTER_KEYS.filter((k) => filters[k]).map((k) => [k, filters[k]] as [string, string])).toString();
    const findings = useFetch<SecurityFinding[] | { findings: SecurityFinding[] }>(`${SEC}/projects/${id}/findings${qs ? `?${qs}` : ""}`);
    const apps = useApps(id);
    const [text, setText] = useState({ location: filters.location, q: filters.q });
    useEffect(() => setText({ location: filters.location, q: filters.q }), [filters.location, filters.q]);

    const setFilter = (patch: Partial<Record<FilterKey | "open", string>>) => {
        const next = new URLSearchParams();
        for (const k of FILTER_KEYS) {
            const v = k in patch ? patch[k] : filters[k];
            if (v) next.set(k, v);
        }
        if (openOnly && !("open" in patch) && !patch.validation) next.set("open", "1");
        if (patch.open) next.set("open", patch.open);
        go(sec.findings(id, Object.fromEntries(next)));
    };
    const raw = findings.data;
    const all = Array.isArray(raw) ? raw : (raw?.findings ?? []);
    const list = (openOnly ? all.filter((f) => OPEN_VALIDATION.includes(f.validation)) : all).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.lastSeenAt.localeCompare(a.lastSeenAt));
    const anyFilter = FILTER_KEYS.some((k) => filters[k]) || openOnly;
    const appName = (appId: string) => apps.list.find((a) => a.id === appId)?.name ?? "";

    const select = (k: FilterKey, label: string, options: Array<[string, string]>) => (
        <div className="field">
            <label htmlFor={`ff-${k}`}>{label}</label>
            <select id={`ff-${k}`} className="input" value={filters[k]} onChange={(e) => setFilter({ [k]: e.target.value })}>
                <option value="">Any</option>
                {options.map(([v, l]) => (
                    <option key={v} value={v}>
                        {l}
                    </option>
                ))}
            </select>
        </div>
    );

    return (
        <SecurityLayout
            id={id}
            active="findings"
            title="Findings"
            subtitle="What assessments found and what people entered by hand, with the state each one is in."
            actions={
                canRun(role) ? (
                    <LinkButton href={sec.newFinding(id, filters.application || undefined)} icon={Plus}>
                        Add a finding by hand
                    </LinkButton>
                ) : null
            }
        >
            <div className="stack">
                <form
                    className="card card-pad"
                    role="search"
                    aria-label="Filter findings"
                    onSubmit={(e) => {
                        e.preventDefault();
                        setFilter({ location: text.location.trim(), q: text.q.trim() });
                    }}
                >
                    <div className="sec-filters">
                        {select("application", "Application", apps.list.map((a) => [a.id, a.name]))}
                        {select("severity", "Severity", SEVERITY_ORDER.map((s) => [s, SEVERITY_WORDS[s].label]))}
                        {select("category", "Category", CATEGORY_ORDER.map((c) => [c, CATEGORY_WORDS[c]]))}
                        {select("validation", "State", VALIDATION_ORDER.map((v) => [v, VALIDATION_WORDS[v].label]))}
                        <div className="field">
                            <label htmlFor="ff-from">Last seen from</label>
                            <input id="ff-from" className="input" type="date" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor="ff-to">Last seen until</label>
                            <input id="ff-to" className="input" type="date" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
                        </div>
                        <div className="field">
                            <label htmlFor="ff-location">Location contains</label>
                            <input id="ff-location" className="input" value={text.location} onChange={(e) => setText({ ...text, location: e.target.value })} placeholder="/login" />
                        </div>
                        <div className="field">
                            <label htmlFor="ff-q">Search</label>
                            <input id="ff-q" className="input" type="search" value={text.q} onChange={(e) => setText({ ...text, q: e.target.value })} placeholder="Words in the title or description" />
                        </div>
                    </div>
                    <div className="row" style={{ marginTop: 16 }}>
                        <Button type="submit" icon={Search}>
                            Apply filters
                        </Button>
                        {anyFilter && (
                            <Button type="button" variant="ghost" onClick={() => go(sec.findings(id))}>
                                Clear filters
                            </Button>
                        )}
                        {openOnly && <Badge tone="info">Open findings only</Badge>}
                        {!findings.loading && !findings.error && (
                            <span className="t-meta" role="status">
                                {list.length === 1 ? "1 finding" : `${list.length} findings`}
                            </span>
                        )}
                        {!findings.loading && !findings.error && <BadgeKey label="the severities and states in this list" entries={findingKey(list)} />}
                    </div>
                </form>
                {findings.loading ? (
                    <ListSkeleton rows={4} />
                ) : findings.error ? (
                    <ErrorState error={friendlyError(findings.error.message)} onRetry={findings.reload} />
                ) : list.length === 0 ? (
                    <div className="card">
                        {anyFilter ? (
                            <EmptyState icon={Search} title="No findings match these filters" actions={<Button onClick={() => go(sec.findings(id))}>Clear filters</Button>} />
                        ) : (
                            <EmptyState icon={ShieldCheck} title="No findings yet" actions={<LinkButton href={sec.newAssessment(id)} variant="primary">New assessment</LinkButton>}>
                                No assessments yet, or none found anything. Run a passive assessment, or add a finding from the client’s own tools by hand.
                            </EmptyState>
                        )}
                    </div>
                ) : (
                    <div data-testid="sec-findings">
                        <FindingList id={id} findings={list} appName={appName} />
                    </div>
                )}
            </div>
        </SecurityLayout>
    );
}

// ── one finding ──────────────────────────────────────────────────────────────

type FindingAnswer = SecurityFinding & { history?: HistoryRow[]; notes?: string[] };

export function FindingDetail({ id, fid }: { id: string; fid: string }) {
    const role = useRole();
    // GET /findings/:fid answers { finding, history, application: { id, name, targetUrl } }.
    const f = useFetch<FindingAnswer | { finding: SecurityFinding; history?: HistoryRow[]; application?: { id: string; name: string } | null }>(`${SEC}/findings/${fid}`);
    const raw = f.data;
    const finding: FindingAnswer | undefined = raw ? ("finding" in raw ? { ...raw.finding, history: raw.history } : raw) : undefined;
    const app = { data: raw && "finding" in raw ? (raw.application ?? undefined) : undefined };

    const content = () => {
        if (f.loading) return <Skeleton h={260} style={{ borderRadius: 12 }} />;
        if (f.error || !finding) return <ErrorState error={friendlyError(f.error?.message ?? "Finding not found")} onRetry={f.reload} />;
        const x = finding;
        const steps = (x.reproduction ?? "")
            .split(/\n+/)
            .map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, "").trim())
            .filter(Boolean);
        return (
            <div className="sec-two">
                <div className="stack">
                    <section className="card card-pad stack-sm" aria-labelledby="fd-what">
                        <h2 className="t-section" id="fd-what">
                            What was found
                        </h2>
                        <p>{x.description}</p>
                        <h3 className="t-card">Why it matters</h3>
                        <p className="t-secondary">{x.impact}</p>
                        <h3 className="t-card">How to fix it</h3>
                        <p className="t-secondary" style={{ whiteSpace: "pre-wrap" }}>
                            {x.remediation}
                        </p>
                    </section>
                    {steps.length > 0 && (
                        <section className="card card-pad stack-sm" aria-labelledby="fd-repro">
                            <h2 className="t-section" id="fd-repro">
                                See it yourself
                            </h2>
                            <ol className="bullets">
                                {steps.map((s, i) => (
                                    <li key={i}>{s}</li>
                                ))}
                            </ol>
                        </section>
                    )}
                    <section className="card card-pad stack-sm" aria-labelledby="fd-evidence" data-testid="fd-evidence">
                        <h2 className="t-section" id="fd-evidence">
                            Evidence
                        </h2>
                        {x.evidence.length === 0 ? (
                            <p className="t-secondary">No evidence was recorded.</p>
                        ) : (
                            <ul className="sec-evidence">
                                {x.evidence.map((e, i) => (
                                    <li key={i}>
                                        <span className="t-card">{e.label}</span>
                                        <pre>{e.value}</pre>
                                        <span className="t-meta">Seen {when(e.observedAt)}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <p className="t-meta">Values that could be secret (cookie values, tokens, passwords, email addresses) are hidden before anything is stored.</p>
                    </section>
                    {x.aiNote && (
                        <section className="card card-pad stack-sm" aria-labelledby="fd-ai">
                            <h2 className="t-section" id="fd-ai">
                                AI suggestion
                            </h2>
                            <p className="sec-ai">{x.aiNote}</p>
                            <p className="t-meta">An AI suggestion is not evidence and never confirms a finding.</p>
                        </section>
                    )}
                </div>
                <div className="stack">
                    <section className="card card-pad stack-sm" aria-labelledby="fd-facts">
                        <h2 className="t-section" id="fd-facts">
                            Details
                        </h2>
                        <dl className="kv">
                            <dt>Severity</dt>
                            <dd>
                                <SeverityTag severity={x.severity} tipFocusable />
                            </dd>
                            <dt>Confidence</dt>
                            <dd>
                                {CONFIDENCE_WORDS[x.confidence] ?? x.confidence}
                                {CONFIDENCE_WORDS[x.confidence] && <HelpTip label="Confidence" text={x.source === "manual" ? "Chosen by the person who entered this finding: how sure they are that it is a real problem." : help("confidence", x.confidence)} />}
                            </dd>
                            <dt>Category</dt>
                            <dd>{categoryLabel(x.category)}</dd>
                            <dt>Location</dt>
                            <dd className="sec-loc">{x.location}</dd>
                            <dt>Application</dt>
                            <dd>{app.data ? <a href={sec.application(id, app.data.id)}>{app.data.name}</a> : "…"}</dd>
                            <dt>Source</dt>
                            <dd>{x.source === "manual" ? "Entered by hand" : "Found by an assessment"}</dd>
                            <dt>First seen</dt>
                            <dd>
                                {when(x.firstSeenAt)}
                                {x.firstAssessmentId && (
                                    <>
                                        {" "}
                                        (<a href={sec.assessment(id, x.firstAssessmentId)}>assessment</a>)
                                    </>
                                )}
                            </dd>
                            <dt>Last seen</dt>
                            <dd>
                                {when(x.lastSeenAt)}
                                {x.lastAssessmentId && (
                                    <>
                                        {" "}
                                        (<a href={sec.assessment(id, x.lastAssessmentId)}>assessment</a>)
                                    </>
                                )}
                            </dd>
                        </dl>
                    </section>
                    <ValidationPanel finding={x} canChange={canRun(role)} isOwner={role === "owner"} onSaved={() => void f.reload()} />
                </div>
            </div>
        );
    };
    return (
        <SecurityLayout id={id} active="findings" title={finding?.title ?? "Finding"} subtitle={finding ? <ValidationTag validation={finding.validation} tipFocusable /> : undefined} crumb={[{ label: "Findings", href: sec.findings(id) }, { label: finding?.title ?? "…" }]}>
            {content()}
        </SecurityLayout>
    );
}

function ValidationPanel({ finding, canChange, isOwner, onSaved }: { finding: FindingAnswer; canChange: boolean; isOwner: boolean; onSaved: () => void }) {
    const [to, setTo] = useState<ValidationState>(finding.validation);
    const [comment, setComment] = useState("");
    const [error, setError] = useState("");
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState("");
    useEffect(() => setTo(finding.validation), [finding.validation]);
    async function save(e: React.FormEvent) {
        e.preventDefault();
        // The same state with a comment adds a note to the history (for example "still present"); a change always says why.
        if (to === finding.validation && !comment.trim()) return setError("Choose a different state, or write a note to add to the history.");
        if (!comment.trim()) return setError("Say why, in a sentence. It is kept in the history.");
        setError("");
        setProblem("");
        setBusy(true);
        try {
            await api(`${SEC}/findings/${finding.id}`, { method: "PATCH", body: { validation: to, comment: comment.trim() } });
            setComment("");
            setSaved(to === finding.validation ? "Note added to the history." : `Saved as ${VALIDATION_WORDS[to].label.toLowerCase()}.`);
            onSaved();
        } catch (err) {
            setProblem(securityError(err));
        } finally {
            setBusy(false);
        }
    }
    const history = [...(finding.history ?? [])].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
    return (
        <section className="card card-pad stack-sm" aria-labelledby="fd-val" data-testid="fd-validation">
            <h2 className="t-section" id="fd-val">
                State
            </h2>
            <p className="t-secondary">{VALIDATION_WORDS[finding.validation].help}</p>
            {canChange ? (
                <form className="stack-sm" onSubmit={(e) => void save(e)} noValidate>
                    <div className="field">
                        <label htmlFor="fd-to">Change the state to</label>
                        <select id="fd-to" className="input" value={to} onChange={(e) => (setTo(e.target.value as ValidationState), setSaved(""))}>
                            {VALIDATION_ORDER.map((v) => (
                                <option key={v} value={v} disabled={v === "accepted-risk" && !isOwner && finding.validation !== "accepted-risk"}>
                                    {VALIDATION_WORDS[v].label}
                                    {v === "accepted-risk" && !isOwner ? " (owners only)" : ""}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="field">
                        <label htmlFor="fd-comment">Why</label>
                        <textarea id="fd-comment" className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} aria-invalid={!!error} aria-describedby={error ? "fd-comment-err" : undefined} placeholder="For example “Checked in the browser: the header is missing on every page.”" />
                        {error && (
                            <div className="error-text" id="fd-comment-err">
                                {error}
                            </div>
                        )}
                    </div>
                    {problem && (
                        <Callout tone="danger" title="We couldn’t change the state">
                            {problem}
                        </Callout>
                    )}
                    {saved && (
                        <p className="t-secondary" role="status">
                            {saved}
                        </p>
                    )}
                    <div className="row">
                        <Button type="submit" variant="primary" loading={busy}>
                            Save state
                        </Button>
                    </div>
                </form>
            ) : (
                <p className="hint">Editors and owners can change the state.</p>
            )}
            <h3 className="t-card">History</h3>
            {history.length === 0 ? (
                <p className="t-secondary">No changes yet.</p>
            ) : (
                <ul className="sec-history" data-testid="fd-history">
                    {history.map((h, i) => {
                        const toState = h.to;
                        return (
                            <li key={h.id ?? i}>
                                <span>
                                    {h.from ? `${VALIDATION_WORDS[h.from]?.label ?? h.from} to ` : ""}
                                    {toState ? (VALIDATION_WORDS[toState]?.label ?? toState) : "Note"}
                                </span>
                                {h.comment && <span className="t-secondary">“{h.comment}”</span>}
                                <span className="t-meta">
                                    {[h.actor, when(h.at)].filter(Boolean).join(", ")}{h.assessmentId ? " (by an assessment)" : ""}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

// ── a finding entered by hand ────────────────────────────────────────────────

export function NewFindingPage({ id }: { id: string }) {
    const query = useRoute().query;
    const apps = useApps(id);
    const [d, setD] = useState({ application: query.get("app") ?? "", title: "", category: "configuration" as FindingCategory, severity: "medium" as Severity, confidence: "medium" as Confidence, location: "", description: "", impact: "", remediation: "", reproduction: "", observed: "" });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [problem, setProblem] = useState("");
    const [busy, setBusy] = useState(false);
    const set = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
    const appId = d.application || (apps.list.length === 1 ? apps.list[0]!.id : "");

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        const errs: Record<string, string> = {};
        if (!appId) errs.application = "Choose the application it belongs to.";
        if (!d.title.trim()) errs.title = "Enter a short title.";
        if (!d.location.trim()) errs.location = "Enter where it is, for example a page address or “whole site”.";
        if (!d.description.trim()) errs.description = "Describe what was found.";
        if (!d.impact.trim()) errs.impact = "Say why it matters, in a sentence the client understands.";
        if (!d.remediation.trim()) errs.remediation = "Say how to fix it.";
        setErrors(errs);
        if (Object.keys(errs).length) return;
        setBusy(true);
        setProblem("");
        try {
            const answer = await api<unknown>(`${SEC}/applications/${appId}/findings`, {
                method: "POST",
                body: {
                    title: d.title.trim(),
                    category: d.category,
                    severity: d.severity,
                    confidence: d.confidence,
                    location: d.location.trim(),
                    description: d.description.trim(),
                    impact: d.impact.trim(),
                    remediation: d.remediation.trim(),
                    reproduction: d.reproduction.trim() || null,
                    evidence: d.observed.trim() ? [{ kind: "note", label: "Observed by hand", value: d.observed.trim(), observedAt: new Date().toISOString() }] : [],
                },
            });
            go(sec.finding(id, oneOf<SecurityFinding>(answer, "finding")!.id));
        } catch (err) {
            setProblem(securityError(err));
            setBusy(false);
        }
    }
    const err = (k: string) =>
        errors[k] ? (
            <div className="error-text" id={`nf-${k}-err`}>
                {errors[k]}
            </div>
        ) : null;
    const aria = (k: string) => ({ "aria-invalid": !!errors[k], "aria-describedby": errors[k] ? `nf-${k}-err` : undefined });

    return (
        <SecurityLayout id={id} active="findings" title="Add a finding by hand" subtitle="For something found with the client’s own tools or by a person. It starts as needing a look." crumb={[{ label: "Findings", href: sec.findings(id) }, { label: "Add a finding by hand" }]}>
            {apps.loading ? (
                <ListSkeleton rows={2} />
            ) : apps.error ? (
                <ErrorState error={friendlyError(apps.error.message)} onRetry={apps.reload} />
            ) : !apps.list.length ? (
                <div className="card">
                    <EmptyState icon={ShieldCheck} title="No applications yet" actions={<LinkButton href={sec.newApplication(id)} variant="primary">Add an application</LinkButton>}>
                        A finding belongs to an application. Register the application first.
                    </EmptyState>
                </div>
            ) : (
                <form className="card card-pad stack" style={{ maxWidth: 820 }} onSubmit={(e) => void submit(e)} noValidate data-testid="sec-manual-form">
                    <div className="grid-2">
                        <div className="field">
                            <label htmlFor="nf-application">Application</label>
                            <select id="nf-application" className="input" value={appId} onChange={set("application")} {...aria("application")}>
                                {!appId && <option value="">Choose an application</option>}
                                {apps.list.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.name}
                                    </option>
                                ))}
                            </select>
                            {err("application")}
                        </div>
                        <div className="field">
                            <label htmlFor="nf-title">Title</label>
                            <input id="nf-title" className="input" value={d.title} onChange={set("title")} {...aria("title")} />
                            {err("title")}
                        </div>
                        <div className="field">
                            <label htmlFor="nf-severity">Severity</label>
                            <select id="nf-severity" className="input" value={d.severity} onChange={set("severity")}>
                                {SEVERITY_ORDER.map((s) => (
                                    <option key={s} value={s}>
                                        {SEVERITY_WORDS[s].label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="field">
                            <label htmlFor="nf-category">Category</label>
                            <select id="nf-category" className="input" value={d.category} onChange={set("category")}>
                                {CATEGORY_ORDER.map((c) => (
                                    <option key={c} value={c}>
                                        {CATEGORY_WORDS[c]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="field">
                            <FieldHelp htmlFor="nf-confidence" label="Confidence" help="How sure you are that this is a real problem. It is shown in the reports; a finding added by hand starts as Needs a look whatever you choose." />
                            <select id="nf-confidence" className="input" value={d.confidence} onChange={set("confidence")}>
                                {(["high", "medium", "low"] as Confidence[]).map((c) => (
                                    <option key={c} value={c}>
                                        {CONFIDENCE_WORDS[c]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="field">
                            <label htmlFor="nf-location">Location</label>
                            <input id="nf-location" className="input" value={d.location} onChange={set("location")} placeholder="https://staging.example.com/login" {...aria("location")} />
                            {err("location")}
                        </div>
                    </div>
                    <div className="field">
                        <label htmlFor="nf-description">What was found</label>
                        <textarea id="nf-description" className="input" rows={3} value={d.description} onChange={set("description")} {...aria("description")} />
                        {err("description")}
                    </div>
                    <div className="field">
                        <label htmlFor="nf-impact">Why it matters</label>
                        <textarea id="nf-impact" className="input" rows={2} value={d.impact} onChange={set("impact")} {...aria("impact")} />
                        {err("impact")}
                    </div>
                    <div className="field">
                        <label htmlFor="nf-remediation">How to fix it</label>
                        <textarea id="nf-remediation" className="input" rows={2} value={d.remediation} onChange={set("remediation")} {...aria("remediation")} />
                        {err("remediation")}
                    </div>
                    <div className="field">
                        <label htmlFor="nf-reproduction">How to see it in a browser (optional)</label>
                        <textarea id="nf-reproduction" className="input" rows={3} value={d.reproduction} onChange={set("reproduction")} placeholder={"1. Open the sign-in page\n2. Open the browser’s developer tools, Network\n3. Look at the answer’s headers"} />
                    </div>
                    <div className="field">
                        <label htmlFor="nf-observed">What you observed (optional)</label>
                        <p className="hint" id="nf-observed-hint">
                            Kept as evidence. Secret-looking values (tokens, cookie values, passwords, email addresses) are hidden before it is stored.
                        </p>
                        <textarea id="nf-observed" className="input" rows={3} value={d.observed} onChange={set("observed")} aria-describedby="nf-observed-hint" />
                    </div>
                    {problem && (
                        <Callout tone="danger" title="We couldn’t add the finding">
                            {problem}
                        </Callout>
                    )}
                    <div className="row">
                        <Button type="submit" variant="primary" icon={Plus} loading={busy}>
                            Add finding
                        </Button>
                        <LinkButton href={sec.findings(id)} variant="ghost">
                            Cancel
                        </LinkButton>
                    </div>
                </form>
            )}
        </SecurityLayout>
    );
}
