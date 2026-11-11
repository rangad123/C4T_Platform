import { Bell, Bug, CircleCheck, CircleX, GitBranch, Inbox, Mail, MessageSquare, Network, NotebookText, Pencil, Plus, Siren, Smartphone, Trash2, Users, Webhook, X, type LucideIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, api } from "../../api";
import { usePage } from "../../components/Shell";
import { Badge, Button, Callout, ErrorState, ListSkeleton, PageHeader } from "../../components/ui";
import { useDocumentTitle, useFetch } from "../../lib/hooks";
import { describeApiError, friendlyError } from "../../lib/labels";
import { plural, relativeTime } from "../../lib/format";
import { routes, type SettingsSection } from "../../lib/router";
import "./integrations.css";

/** What can be set up once and shared; every other kind on this page is set up inside each project. */
type SharedKind = "jira" | "github" | "notion" | "sentry" | "slack" | "teams" | "webhook";
type OwnKind = "email" | "git" | "device_farm" | "mailbox";

interface Connection {
    id: string;
    kind: SharedKind;
    kindName: string;
    name: string;
    organizationId: string | null;
    ownerName: string;
    config: Record<string, unknown>;
    status: "unchecked" | "working" | "failed";
    statusNote: string | null;
    checkedAt: string | null;
    canManage: boolean;
    projects: Array<{ id: string; name: string; present: boolean; canChange: boolean }>;
    otherProjects: number;
    linkable: Array<{ id: string; name: string }>;
}
export interface IntegrationsAnswer {
    connections: Connection[];
    ownUses: Record<string, Array<{ id: string; name: string }>>;
    organizations: Array<{ id: string; name: string | null }>;
    canAddPlatform: boolean;
    canManage: boolean;
    server: { blocksPrivate: boolean };
}

interface Field {
    key: string;
    label: string;
    hint?: string;
    secret?: boolean;
    optional?: boolean;
    placeholder?: string;
    initial?: string;
}
interface Entry {
    kind: SharedKind | OwnKind;
    name: string;
    icon: LucideIcon;
    what: string;
    /** Set up once and shared: the fields of the form. Absent: set up inside each project. */
    fields?: Field[];
    /** Where a project sets it up itself. */
    where: { label: string; section?: SettingsSection; scripts?: boolean };
}

const TOKEN_HINT = "Stored encrypted. It is never shown again.";
const GROUPS: Array<{ title: string; icon: LucideIcon; entries: Entry[] }> = [
    {
        title: "Issue trackers",
        icon: Bug,
        entries: [
            {
                kind: "jira",
                name: "Jira",
                icon: Bug,
                what: "Create a Jira issue from a problem a test found, with the steps and the evidence.",
                fields: [
                    { key: "baseUrl", label: "Jira address", placeholder: "https://your-team.atlassian.net" },
                    { key: "projectKey", label: "Project key", placeholder: "SHOP" },
                    { key: "email", label: "Account email", placeholder: "qa@example.com" },
                    { key: "token", label: "API token", secret: true, hint: TOKEN_HINT },
                    { key: "issueType", label: "Issue type", initial: "Bug" },
                ],
                where: { label: "Issues", section: "issues" },
            },
            {
                kind: "github",
                name: "GitHub Issues",
                icon: GitBranch,
                what: "Open an issue in a GitHub repository from a problem a test found.",
                fields: [
                    { key: "owner", label: "Owner", placeholder: "acme" },
                    { key: "repo", label: "Repository", placeholder: "shop" },
                    { key: "token", label: "Access token", secret: true, hint: `${TOKEN_HINT} It needs to create issues in this repository.` },
                    { key: "apiUrl", label: "GitHub Enterprise API address", optional: true, hint: "Only for GitHub Enterprise. Leave empty for github.com." },
                ],
                where: { label: "Issues", section: "issues" },
            },
            {
                kind: "notion",
                name: "Notion",
                icon: NotebookText,
                what: "Add a page to a Notion database for each problem a test found.",
                fields: [
                    { key: "databaseId", label: "Database link or id", placeholder: "https://www.notion.so/…" },
                    { key: "titleProperty", label: "Title property", initial: "Name" },
                    { key: "token", label: "Integration token", secret: true, hint: TOKEN_HINT },
                ],
                where: { label: "Issues", section: "issues" },
            },
        ],
    },
    {
        title: "Error monitoring",
        icon: Siren,
        entries: [
            {
                kind: "sentry",
                name: "Sentry",
                icon: Siren,
                what: "Show the Sentry errors that happened around a failed run. Read only: nothing is sent to Sentry.",
                fields: [
                    { key: "baseUrl", label: "Sentry address", initial: "https://sentry.io" },
                    { key: "organization", label: "Organisation", placeholder: "acme" },
                    { key: "project", label: "Project", placeholder: "shop-web" },
                    { key: "token", label: "Token", secret: true, hint: `${TOKEN_HINT} It only needs to read issues and projects.` },
                ],
                where: { label: "Issues", section: "issues" },
            },
        ],
    },
    {
        title: "Alerts",
        icon: Bell,
        entries: [
            {
                kind: "slack",
                name: "Slack",
                icon: MessageSquare,
                what: "Post to a Slack channel when a run fails, a test breaks again, or tests recover.",
                fields: [{ key: "url", label: "Incoming webhook address", secret: true, placeholder: "https://hooks.slack.com/services/…", hint: "Anyone with this address can post to the channel, so it is stored encrypted and only its host is shown." }],
                where: { label: "Alerts", section: "alerts" },
            },
            {
                kind: "teams",
                name: "Microsoft Teams",
                icon: Users,
                what: "Post a card to a Teams channel through a Workflows webhook.",
                fields: [{ key: "url", label: "Workflows webhook address", secret: true, hint: "Stored encrypted; only its host is shown." }],
                where: { label: "Alerts", section: "alerts" },
            },
            {
                kind: "webhook",
                name: "Webhook",
                icon: Webhook,
                what: "Send each alert as JSON to an address of yours.",
                fields: [{ key: "url", label: "Address", secret: true, placeholder: "https://example.com/hooks/ai-studio", hint: "Stored encrypted; only its host is shown." }],
                where: { label: "Alerts", section: "alerts" },
            },
            { kind: "email", name: "Email", icon: Mail, what: "Email the alerts to the people you choose. The recipients belong to each project, so it is set up there.", where: { label: "Alerts", section: "alerts" } },
        ],
    },
    {
        title: "Code, devices and mail",
        icon: Network,
        entries: [
            { kind: "git", name: "Git import", icon: GitBranch, what: "Import Playwright tests from a GitHub, GitLab or other Git repository. The access token is used for that download and never stored, so there is nothing to share.", where: { label: "Test scripts", scripts: true } },
            { kind: "device_farm", name: "Device farms", icon: Smartphone, what: "Run phone tests on BrowserStack, Sauce Labs or LambdaTest devices. Each project chooses its own devices, so it is set up there.", where: { label: "Mobile", section: "mobile" } },
            { kind: "mailbox", name: "Test mailbox", icon: Inbox, what: "Read the one-time codes and links a sign-in sends by email. Each project has its own mailbox, so it is set up there.", where: { label: "Test accounts", section: "accounts" } },
        ],
    },
];

const STATUS: Record<Connection["status"], { tone: "success" | "danger" | "neutral"; label: string }> = {
    working: { tone: "success", label: "Working" },
    failed: { tone: "danger", label: "Not working" },
    unchecked: { tone: "neutral", label: "Not tested yet" },
};

const projectLink = (e: Entry, id: string) => (e.where.scripts ? routes.scripts(id) : routes.projectSettings(id, e.where.section));
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : describeApiError(e));

/** Integrations: every system AI Studio connects to, set up once for an organisation where that makes sense, and which projects use it. */
export function IntegrationsPage() {
    useDocumentTitle("Integrations");
    usePage({ crumbs: [{ label: "Integrations" }], nav: "integrations" });
    const page = useFetch<IntegrationsAnswer>("/shared-integrations");
    const data = page.data;
    return (
        <>
            <PageHeader title="Integrations" subtitle="The issue trackers, alert channels and other systems your projects connect to. Set one up once for your organisation, then choose the projects that use it." />
            <div className="stack">
                {page.loading && !data ? (
                    <ListSkeleton rows={4} />
                ) : page.error || !data ? (
                    <ErrorState error={friendlyError(page.error?.message ?? "")} onRetry={page.reload} />
                ) : (
                    <>
                        {!data.canManage && <Callout tone="neutral">You can choose which of your projects use the integrations below. Setting one up needs the permission to manage keys and connections.</Callout>}
                        {data.server.blocksPrivate && <Callout tone="info">This server only connects to public addresses: a tracker or webhook inside your own network cannot be reached from here.</Callout>}
                        {GROUPS.map((g) => (
                            <section key={g.title} className="stack-sm" aria-labelledby={`int-${g.title}`}>
                                <h2 className="t-section" id={`int-${g.title}`}>
                                    {g.title}
                                </h2>
                                <div className="int-grid">
                                    {g.entries.map((e) => (
                                        <IntegrationCard key={e.kind} entry={e} data={data} reload={page.reload} />
                                    ))}
                                </div>
                            </section>
                        ))}
                    </>
                )}
            </div>
        </>
    );
}

function IntegrationCard({ entry, data, reload }: { entry: Entry; data: IntegrationsAnswer; reload: () => Promise<void> | void }) {
    const [adding, setAdding] = useState(false);
    const shared = data.connections.filter((c) => c.kind === entry.kind);
    const own = data.ownUses[entry.kind] ?? [];
    const usedBy = new Set([...shared.flatMap((c) => c.projects.map((p) => p.id)), ...own.map((p) => p.id)]);
    const Icon = entry.icon;
    const status = shared.length ? { tone: "success" as const, label: "Connected" } : own.length ? { tone: "info" as const, label: `Set up in ${plural(own.length, "project")}` } : { tone: "neutral" as const, label: "Not set up" };
    const canAdd = Boolean(entry.fields) && data.canManage && (data.organizations.length > 0 || data.canAddPlatform);
    return (
        <article className="card card-pad stack-sm int-card" data-testid={`integration-${entry.kind}`} aria-labelledby={`int-card-${entry.kind}`}>
            <div className="row">
                <Icon size={20} aria-hidden />
                <h3 className="t-card" id={`int-card-${entry.kind}`}>
                    {entry.name}
                </h3>
                <span className="spacer" />
                <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <p className="t-secondary">{entry.what}</p>
            {shared.map((c) => (
                <SharedConnection key={c.id} c={c} entry={entry} reload={reload} />
            ))}
            {own.length > 0 && (
                <p className="t-meta" data-testid={`own-${entry.kind}`}>
                    {entry.fields ? "Set up in a project's own settings: " : "Used in: "}
                    {own.map((p, i) => (
                        <span key={p.id}>
                            {i > 0 && ", "}
                            <a href={projectLink(entry, p.id)}>{p.name}</a>
                        </span>
                    ))}
                </p>
            )}
            {!entry.fields && <p className="t-meta">Set up in each project: {entry.where.scripts ? "Test scripts, Import from Git" : `Settings, ${entry.where.label}`}.</p>}
            {entry.fields && usedBy.size === 0 && shared.length === 0 && !canAdd && <p className="t-meta">Not set up for your organisation yet. A project can still set it up in Settings, {entry.where.label}.</p>}
            {adding ? (
                <ConnectionForm entry={entry} data={data} onCancel={() => setAdding(false)} onSaved={() => {
                        setAdding(false);
                        void reload();
                    }} />
            ) : (
                canAdd && (
                    <div>
                        <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>
                            {shared.length ? `Set up another ${entry.name} connection` : `Set up ${entry.name}`}
                        </Button>
                    </div>
                )
            )}
        </article>
    );
}

function SharedConnection({ c, entry, reload }: { c: Connection; entry: Entry; reload: () => Promise<void> | void }) {
    const [busy, setBusy] = useState<string | null>(null);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const [editing, setEditing] = useState(false);
    const [pick, setPick] = useState("");
    const st = STATUS[c.status];
    const act = async (what: string, fn: () => Promise<unknown>, done?: (r: any) => void) => {
        setBusy(what);
        setResult(null);
        try {
            const r = await fn();
            done?.(r);
            await reload();
        } catch (e) {
            setResult({ ok: false, text: errorText(e) });
        } finally {
            setBusy(null);
        }
    };
    const where = c.kind === "slack" || c.kind === "teams" || c.kind === "webhook" ? String(c.config.host ?? "") : c.kind === "github" ? `${c.config.owner}/${c.config.repo}` : c.kind === "jira" ? `${c.config.baseUrl} · ${c.config.projectKey}` : c.kind === "sentry" ? `${c.config.organization}/${c.config.project}` : String(c.config.databaseId ?? "");
    return (
        <div className="int-conn stack-sm" data-testid="shared-connection">
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                <b>{c.name}</b>
                <Badge tone={st.tone} tip={c.statusNote ?? (c.checkedAt ? `Tested ${relativeTime(c.checkedAt)}` : undefined)}>
                    {st.label}
                </Badge>
                <span className="t-meta">
                    {where} · for {c.ownerName}
                </span>
            </div>
            {c.statusNote && c.status === "failed" && <p className="t-meta error-text">{c.statusNote}</p>}
            <div className="stack-sm">
                <span className="t-meta">{c.projects.length || c.otherProjects ? `Used by ${plural(c.projects.length + c.otherProjects, "project")}${c.otherProjects ? ` (${c.otherProjects} you cannot see)` : ""}:` : "No project uses it yet."}</span>
                {c.projects.length > 0 && (
                    <ul className="chips" aria-label={`Projects using ${c.name}`}>
                        {c.projects.map((p) => (
                            <li key={p.id} className="chip">
                                <a href={projectLink(entry, p.id)}>{p.name}</a>
                                {!p.present && <span className="t-meta"> (removed there; use it again to put it back)</span>}
                                {p.canChange && (
                                    <Button size="sm" variant="ghost" iconOnly icon={X} aria-label={`Stop using ${c.name} in ${p.name}`} loading={busy === `unlink-${p.id}`} onClick={() => void act(`unlink-${p.id}`, () => api(`/projects/${p.id}/shared-integrations/${c.id}`, { method: "DELETE" }))} />
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                {c.linkable.length > 0 && (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div className="field">
                            <label htmlFor={`link-${c.id}`}>Use in a project</label>
                            <select id={`link-${c.id}`} className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
                                <option value="">Choose a project</option>
                                {c.linkable.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <Button size="sm" disabled={!pick} loading={busy === "link"} onClick={() => void act("link", () => api(`/projects/${pick}/shared-integrations/${c.id}`, { method: "PUT" }), () => setPick(""))}>
                            Use it
                        </Button>
                    </div>
                )}
            </div>
            {c.canManage && !editing && (
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <Button size="sm" loading={busy === "test"} onClick={() => void act("test", () => api<{ ok: boolean; message: string }>(`/shared-integrations/${c.id}/test`, { method: "POST" }), (r) => setResult({ ok: r.ok, text: r.message }))}>
                        Test the connection
                    </Button>
                    <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
                        Change
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={Trash2}
                        loading={busy === "remove"}
                        tip={c.projects.length || c.otherProjects ? "Stop using it in every project first" : undefined}
                        disabled={c.projects.length + c.otherProjects > 0}
                        onClick={() => {
                            if (confirm(`Remove “${c.name}”? Nothing in your projects uses it.`)) void act("remove", () => api(`/shared-integrations/${c.id}`, { method: "DELETE" }));
                        }}
                    >
                        Remove
                    </Button>
                </div>
            )}
            {!c.canManage && c.otherProjects > 0 && <p className="t-meta">Only someone who can open every project that uses it may change, test or remove it.</p>}
            {editing &&<ConnectionForm entry={entry} current={c} onCancel={() => setEditing(false)} onSaved={() => {
                        setEditing(false);
                        void reload();
                    }} />}
            {result && (
                <p className={result.ok ? "row t-meta" : "row t-meta error-text"} role="status">
                    {result.ok ? <CircleCheck size={16} aria-hidden /> : <CircleX size={16} aria-hidden />}
                    <span>{result.text}</span>
                </p>
            )}
        </div>
    );
}

function ConnectionForm({ entry, data, current, onCancel, onSaved }: { entry: Entry; data?: IntegrationsAnswer; current?: Connection; onCancel: () => void; onSaved: () => void }) {
    const fields = entry.fields ?? [];
    const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.secret ? "" : current ? String(current.config[f.key] ?? "") : (f.initial ?? "")])));
    const [name, setName] = useState(current?.name ?? "");
    const owners = data ? [...data.organizations.map((o) => ({ id: o.id, name: o.name ?? o.id })), ...(data.canAddPlatform ? [{ id: "", name: "Every organisation (the whole platform)" }] : [])] : [];
    const [owner, setOwner] = useState(owners[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async (ev: FormEvent) => {
        ev.preventDefault();
        setBusy(true);
        setError(null);
        const body: Record<string, unknown> = {};
        for (const f of fields) {
            const v = values[f.key]?.trim() ?? "";
            if (v) body[f.key] = v;
        }
        if (name.trim()) body.name = name.trim();
        try {
            if (current) await api(`/shared-integrations/${current.id}`, { method: "PATCH", body });
            else await api("/shared-integrations", { method: "POST", body: { kind: entry.kind, ...body, organizationId: owner || null } });
            onSaved();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setBusy(false);
        }
    };
    const id = (k: string) => `int-${entry.kind}-${current?.id ?? "new"}-${k}`;
    return (
        <form className="stack-sm int-form" onSubmit={(e) => void submit(e)} aria-label={current ? `Change ${current.name}` : `Set up ${entry.name}`}>
            {!current && owners.length > 1 && (
                <div className="field">
                    <label htmlFor={id("owner")}>For</label>
                    <select id={id("owner")} className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
                        {owners.map((o) => (
                            <option key={o.id || "platform"} value={o.id}>
                                {o.name}
                            </option>
                        ))}
                    </select>
                </div>
            )}
            {fields.map((f) => (
                <div className="field" key={f.key}>
                    <label htmlFor={id(f.key)}>
                        {f.label}
                        {f.optional || (current && f.secret) ? <span className="t-meta"> (optional)</span> : null}
                    </label>
                    <input
                        id={id(f.key)}
                        className="input"
                        type={f.secret ? "password" : "text"}
                        autoComplete="off"
                        placeholder={current && f.secret ? "Leave empty to keep the stored one" : f.placeholder}
                        value={values[f.key] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                    {f.hint && <span className="hint">{f.hint}</span>}
                </div>
            ))}
            <div className="field">
                <label htmlFor={id("name")}>
                    Name <span className="t-meta">(optional)</span>
                </label>
                <input id={id("name")} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Shown in each project, like “${entry.name} for the shop”`} />
            </div>
            {current && <p className="t-meta">A new address needs the token or webhook address again. Every project that uses it gets the change.</p>}
            {!current && entry.kind !== "slack" && entry.kind !== "teams" && entry.kind !== "webhook" && <p className="t-meta">We check the connection before saving it.</p>}
            {error && (
                <Callout tone="danger" title={current ? "It was not changed" : "It was not set up"}>
                    {error}
                </Callout>
            )}
            <div className="row" style={{ gap: 8 }}>
                <Button type="submit" variant="primary" loading={busy}>
                    {current ? "Save changes" : `Set up ${entry.name}`}
                </Button>
                <Button type="button" variant="ghost" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
