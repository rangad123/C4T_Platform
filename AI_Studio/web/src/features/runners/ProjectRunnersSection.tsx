import { FolderKanban, Plus, Server } from "lucide-react";
import { useState } from "react";
import { ApiError, api, type ProjectRow } from "../../api";
import { Button, Callout, ErrorState, ListSkeleton } from "../../components/ui";
import { useFetch } from "../../lib/hooks";
import { friendlyError } from "../../lib/labels";
import { relativeTime } from "../../lib/format";
import { go, routes, useRoute } from "../../lib/router";
import { useCan } from "../auth/permissions";
import { ProjectRunners } from "../agents/ProjectRunners";
import type { Runner } from "./runners";

/**
 * Runners are machine-level (round 37): nothing about them is set inside a project. A project's runners (adding one, the kit to
 * download, which runner it may use, where its tests run) are here on the Runners page, for the project named by `?project=`.
 * Old links to a project's Settings, Runners land here (lib/aliases.ts).
 */
export function ProjectRunnersSection() {
    const chosen = useRoute().query.get("project") ?? "";
    const projects = useFetch<ProjectRow[]>("/projects");
    const list = projects.data ?? [];
    const current = list.find((p) => p.id === chosen);
    return (
        <section className="card card-pad stack" aria-labelledby="project-runners-title" data-testid="project-runners" data-tour="project-runners">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <FolderKanban size={18} aria-hidden />
                <h2 className="t-section" id="project-runners-title">
                    {current ? `Runners for ${current.name}` : "Runners for a project"}
                </h2>
                <span className="spacer" />
                {projects.loading ? null : list.length > 0 && (
                    <div className="row" style={{ gap: 8 }}>
                        <label htmlFor="runners-project" className="t-meta">
                            For the project
                        </label>
                        <select id="runners-project" className="input" value={current ? chosen : ""} onChange={(e) => go(e.target.value ? routes.runners(e.target.value) : routes.allRunners)} style={{ maxWidth: 280 }}>
                            <option value="">Choose a project</option>
                            {list.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
            {projects.loading ? (
                <ListSkeleton rows={2} />
            ) : projects.error ? (
                <ErrorState error={friendlyError(projects.error.message)} onRetry={projects.reload} />
            ) : chosen && !current ? (
                <Callout tone="warning">That project is not one you can open. Choose another above.</Callout>
            ) : current ? (
                <>
                    <p className="t-meta">
                        Add a runner for this project, choose which runners it may use and where its tests run. <a href={routes.project(current.id)}>Open the project</a>
                    </p>
                    <ProjectRunners id={current.id} embedded key={current.id} />
                </>
            ) : (
                <p className="t-secondary">Choose a project to add a runner for it, or to change which runners it uses and where its tests run. Most projects need none: tests run on this server.</p>
            )}
        </section>
    );
}

/** One runner's projects (on its page): the ones that use it, and, for someone who manages it, giving it to another or taking it away. */
export function RunnerProjects({ runner: r, onChanged }: { runner: Runner; onChanged: () => Promise<void> | void }) {
    const can = useCan();
    const manage = r.canManage && can("ai_studio.runners.manage") && r.status !== "retired";
    const projects = useFetch<ProjectRow[]>(manage ? "/projects" : null);
    const [choice, setChoice] = useState("");
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
    const have = new Set(r.projects.map((p) => p.id));
    // A runner of an organisation serves that organisation's projects; a shared Crowd4Test runner any (the server checks again).
    const open = (projects.data ?? []).filter((p) => !have.has(p.id) && !p.archived_at && (!r.organizationId || p.organization_id === r.organizationId));
    const selected = choice && open.some((p) => p.id === choice) ? choice : (open[0]?.id ?? "");
    const change = async (method: "PUT" | "DELETE", projectId: string, name: string) => {
        setBusy(true);
        setNote(null);
        try {
            await api(`/projects/${projectId}/runner-access/${r.id}`, { method });
            setChoice("");
            await onChanged();
            setNote({ tone: "success", text: method === "PUT" ? `${name} may now use ${r.name}.` : `${name} no longer uses ${r.name}.` });
        } catch (e) {
            setNote({ tone: "danger", text: e instanceof ApiError ? e.message : "That did not work. Try again." });
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className="card card-pad stack-sm" aria-labelledby="runner-projects-title" data-testid="runner-projects">
            <h2 className="t-section" id="runner-projects-title">
                Projects that use it
            </h2>
            {note && <Callout tone={note.tone}>{note.text}</Callout>}
            {r.projects.length === 0 && r.otherProjects === 0 ? (
                <p className="t-secondary">No project uses this runner yet.{manage ? " Give it to one below." : ""}</p>
            ) : (
                <ul className="list divided" aria-label="Projects that use this runner">
                    {r.projects.map((p) => (
                        <li key={p.id} className="list-row" style={{ flexWrap: "wrap" }}>
                            <span className="main">
                                <a className="title truncate" href={routes.runners(p.id)}>
                                    {p.name}
                                </a>
                                <span className="meta">Since {relativeTime(p.grantedAt)}</span>
                            </span>
                            {manage && (
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change("DELETE", p.id, p.name)} aria-label={`Stop ${p.name} using ${r.name}`}>
                                    Stop using
                                </Button>
                            )}
                        </li>
                    ))}
                    {r.otherProjects > 0 && <li className="list-row t-secondary">{r.otherProjects === 1 ? "1 other project" : `${r.otherProjects} other projects`} you can't open</li>}
                </ul>
            )}
            {manage &&
                (projects.loading ? null : open.length > 0 ? (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div className="field" style={{ flex: "1 1 240px" }}>
                            <label htmlFor="runner-give-project">Give it to a project</label>
                            <select id="runner-give-project" className="input" value={selected} onChange={(e) => setChoice(e.target.value)}>
                                {open.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <Button icon={Plus} disabled={busy || !selected} onClick={() => void change("PUT", selected, open.find((p) => p.id === selected)?.name ?? "The project")}>
                            Give access
                        </Button>
                    </div>
                ) : (
                    <p className="t-meta">
                        <Server size={14} aria-hidden /> Every project it can serve already uses it.
                    </p>
                ))}
        </section>
    );
}
