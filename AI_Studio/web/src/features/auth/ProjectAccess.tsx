import { useState } from "react";
import { ApiError, api, type ProjectRow } from "../../api";
import { Badge, Button, Callout, Disclosure } from "../../components/ui";
import { HelpTip } from "../../components/Tooltip";
import { PROJECT_ACCESS, PROJECT_ROLE } from "../../lib/help";
import { ROLE_WORDS, type Person, type ProjectAccessView, type Role } from "./auth";

const ORDER: Role[] = ["viewer", "editor", "owner"];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

// A role in one project (help.ts PROJECT_ROLE, from the route rules in src/platform/auth/roles.ts): ROLE_HELP describes the platform
// role, whose owner also manages people, which a role in one project never does.
const ROLE_TIP = (platformRole: Role) => (
    <>
        Viewer: {PROJECT_ROLE.viewer} Editor: {PROJECT_ROLE.editor} Owner: {PROJECT_ROLE.owner} A role here never goes above the person’s own role ({ROLE_WORDS[platformRole]}).
    </>
);

/** "All projects" or "3 projects" beside a person's name in People. */
export function AccessBadge({ access }: { access?: ProjectAccessView }) {
    if (!access || access.mode === "all") return <Badge tone="neutral" tip={PROJECT_ACCESS.all}>All projects</Badge>;
    const n = access.projects?.length ?? 0;
    const names = (access.projects ?? []).map((p) => p.name).join(", ");
    return (
        <Badge tone="brand" tip={n ? `Sees only: ${names}. Other projects stay hidden from them, and platform-wide pages stay closed.` : "Sees no project until an owner adds one."}>
            {n === 1 ? "1 project" : `${n} projects`}
        </Badge>
    );
}

/** Per-project access for one person: all projects, or only some with a role in each (PUT /api/users/:userId/projects). */
export function ProjectAccessEditor({ person, projects, onSaved }: { person: Person; projects: ProjectRow[] | null; onSaved: () => void }) {
    const start = person.access ?? { mode: "all" as const };
    const [mode, setMode] = useState<"all" | "only">(start.mode);
    const [chosen, setChosen] = useState<Map<string, Role>>(() => new Map((start.projects ?? []).map((p) => [p.projectId, ORDER.indexOf(p.role) > ORDER.indexOf(person.role) ? person.role : p.role])));
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const who = person.name || person.email;
    const id = person.id.slice(0, 8);
    const roles = ORDER.slice(0, ORDER.indexOf(person.role) + 1);

    const toggle = (projectId: string, on: boolean) =>
        setChosen((cur) => {
            const next = new Map(cur);
            // Viewer first: the least that lets them look; the owner raises it where they should do more.
            if (on) next.set(projectId, "viewer");
            else next.delete(projectId);
            return next;
        });

    const save = async () => {
        setBusy(true);
        setNote(null);
        try {
            const body = mode === "all" ? { access: "all" } : { access: "only", projects: [...chosen].map(([projectId, role]) => ({ projectId, role })) };
            await api(`/users/${person.id}/projects`, { method: "PUT", body });
            setNote({ tone: "success", text: mode === "all" ? `${who} now sees every project.` : `${who} now sees ${chosen.size === 1 ? "1 project" : `${chosen.size} projects`} only.` });
            onSaved();
        } catch (e) {
            setNote({ tone: "danger", text: msg(e) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Disclosure label={`Projects ${who} can see`}>
            <div className="stack-sm">
                <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="t-card" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        Access
                        <HelpTip label="Access" text={`All projects: ${PROJECT_ACCESS.all} Only these projects: ${PROJECT_ACCESS.only}`} />
                    </legend>
                    <label className="check">
                        <input type="radio" name={`acc-mode-${id}`} value="all" checked={mode === "all"} onChange={() => setMode("all")} />
                        <span>
                            <span className="title">All projects</span>
                            <span className="hint">With their role, {ROLE_WORDS[person.role]}, everywhere.</span>
                        </span>
                    </label>
                    <label className="check">
                        <input type="radio" name={`acc-mode-${id}`} value="only" checked={mode === "only"} onChange={() => setMode("only")} />
                        <span>
                            <span className="title">Only these projects</span>
                            <span className="hint">For a client who should see their own projects and nothing else.</span>
                        </span>
                    </label>
                </fieldset>

                {mode === "only" && (
                    <div className="stack-sm">
                        <div className="row" style={{ gap: 6 }}>
                            <span className="t-card">Projects and the role in each</span>
                            <HelpTip label="Role in a project" text={ROLE_TIP(person.role)} />
                        </div>
                        {!projects ? (
                            <p className="t-meta">Loading projects…</p>
                        ) : projects.length === 0 ? (
                            <p className="t-meta">No projects yet. Create one first, then choose it here.</p>
                        ) : (
                            <ul className="choice-list" aria-label={`Projects ${who} can see`}>
                                {projects.map((p) => {
                                    const on = chosen.has(p.id);
                                    return (
                                        <li className="choice-row" key={p.id}>
                                            <label className="check" style={{ flex: "1 1 220px", padding: "10px 12px" }}>
                                                <input type="checkbox" checked={on} onChange={(e) => toggle(p.id, e.target.checked)} />
                                                <span>
                                                    <span className="title">{p.name}</span>
                                                    {p.url && <span className="hint">{p.url}</span>}
                                                </span>
                                            </label>
                                            <select className="input" style={{ width: "auto", minHeight: 44 }} aria-label={`Role of ${who} in ${p.name}`} disabled={!on} value={chosen.get(p.id) ?? "viewer"} onChange={(e) => setChosen((cur) => new Map(cur).set(p.id, e.target.value as Role))}>
                                                {roles.map((r) => (
                                                    <option key={r} value={r}>
                                                        {ROLE_WORDS[r]}
                                                    </option>
                                                ))}
                                            </select>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                        {chosen.size === 0 && projects && projects.length > 0 && <p className="t-meta">With no project chosen, {who} sees no project at all.</p>}
                    </div>
                )}
                {note && <Callout tone={note.tone}>{note.text}</Callout>}
                <div className="row">
                    <Button size="sm" variant="primary" loading={busy} onClick={() => void save()} tip="Takes effect at once, also for their API tokens.">
                        Save access
                    </Button>
                </div>
            </div>
        </Disclosure>
    );
}
