import { ChevronRight, FolderKanban, LayoutDashboard, List } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NewProjectLink } from "../components/NewProjectLink";
import type { ProjectRow } from "../api";
import { Badge, Button, ErrorState, JobBadge, ListSkeleton, PageHeader, Ribbon, jobKey, type Tick } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { jobHelp } from "../lib/help";
import { usePage } from "../components/Shell";
import { FleetDashboard } from "../features/dashboard/FleetDashboard";
import { hostOf, relativeTime } from "../lib/format";
import { friendlyError, isActive } from "../lib/labels";
import { useDocumentTitle, useFetch } from "../lib/hooks";
import { routes } from "../lib/router";
import { NewProject } from "./NewProject";
import type { FoldersAnswer } from "../features/workspace/FoldersPage";
import type { PreferencesAnswer } from "../features/workspace/ProfilePage";

/** "all", "grouped", "none" (not in a folder) or a folder id. */
type FolderFilter = string;

const NOT_EXPLORED = "The AI has not explored this application yet, so it has no tests.";

/** At most 40 ticks, in proportion; the rest are "waiting" because the project list only knows how many validated. */
function projectTicks(validated: number, total: number): Tick[] {
    const n = Math.min(total, 40);
    const pass = Math.round((validated / total) * n);
    return Array.from({ length: n }, (_, i): Tick => (i < pass ? "pass" : "idle"));
}

export function Home() {
    useDocumentTitle("Projects");
    usePage({ crumbs: [{ label: "Projects" }], nav: "projects" });
    const [showArchived, setShowArchived] = useState(false);
    const { data, error, loading, reload } = useFetch<ProjectRow[]>(showArchived ? "/projects?archived=include" : "/projects", (d) => (d?.some((p) => isActive(p.last_job_status)) ? 3000 : null));
    // How the page opens (Profile → Preferences) and the folders to group or filter by; neither is needed to show the list.
    const prefs = useFetch<PreferencesAnswer>("/me/preferences");
    const folders = useFetch<FoldersAnswer>("/folders");
    const [view, setView] = useState<"dashboard" | "list" | null>(null);
    const [folder, setFolder] = useState<FolderFilter>("all");

    if (loading) {
        return (
            <>
                <PageHeader title="Projects" />
                <ListSkeleton rows={3} />
            </>
        );
    }
    if (error) return <ErrorState error={friendlyError(error.message)} onRetry={reload} />;
    // First visit: the whole page is the one thing to do.
    if ((!data || data.length === 0) && !showArchived) return <NewProject welcome />;
    const all = data ?? [];
    const folderList = folders.data?.folders ?? [];
    const chosenView = view ?? (prefs.loading ? null : (prefs.data?.preferences.projectsView ?? "dashboard"));
    const filtered = all.filter((p) => folder === "all" || folder === "grouped" || (folder === "none" ? !p.folder_id : p.folder_id === folder));
    const row = (p: ProjectRow) => <ProjectItem key={p.id} p={p} />;
    const groups: Array<{ key: string; title: string; rows: ProjectRow[] }> =
        folder === "grouped"
            ? [...folderList.map((f) => ({ key: f.id, title: f.name, rows: filtered.filter((p) => p.folder_id === f.id) })), { key: "none", title: "Not in a folder", rows: filtered.filter((p) => !p.folder_id || !folderList.some((f) => f.id === p.folder_id)) }].filter((g) => g.rows.length > 0)
            : [{ key: "all", title: "", rows: filtered }];
    const tools = (
        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 16 }} data-testid="projects-tools">
            {folderList.length > 0 && (
                <div className="row" style={{ gap: 8 }}>
                    <label htmlFor="projects-folder" className="t-meta">
                        Folder
                    </label>
                    <select id="projects-folder" className="input" value={folder} onChange={(e) => setFolder(e.target.value)} style={{ maxWidth: 260 }}>
                        <option value="all">All projects</option>
                        <option value="grouped">Grouped by folder</option>
                        {folderList.map((f) => (
                            <option key={f.id} value={f.id}>
                                {f.name}
                            </option>
                        ))}
                        <option value="none">Not in a folder</option>
                    </select>
                </div>
            )}
            <label className="row t-meta" style={{ gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                Show archived projects
            </label>
            <span className="spacer" />
            {all.length >= 2 && (
                <Button size="sm" variant="ghost" icon={LayoutDashboard} onClick={() => (setView("dashboard"), setFolder("all"), setShowArchived(false))}>
                    Show the dashboard
                </Button>
            )}
        </div>
    );

    const plain = (
        <>
            <PageHeader
                title="Projects"
                subtitle={
                    <>
                        Each project is one application we generate and maintain tests for.{" "}
                        <BadgeKey
                            label="the project statuses"
                            entries={all.map((p) =>
                                p.last_job_status && p.test_count === 0 && (p.last_job_status === "COMPLETED" || p.last_job_status === "PARTIALLY_COMPLETED")
                                    ? { word: "Plan ready", text: jobHelp({ status: p.last_job_status, planOnly: true }) }
                                    : p.last_job_status
                                      ? jobKey([{ status: p.last_job_status, error: null }])[0]
                                      : { word: "Not explored yet", text: NOT_EXPLORED },
                            )}
                        />
                    </>
                }
                actions={<NewProjectLink />}
            />
            {tools}
            {filtered.length === 0 ? (
                <p className="t-secondary card card-pad">No projects here.</p>
            ) : (
                groups.map((g) => (
                    <section key={g.key} className="stack-sm" style={{ marginBottom: 16 }} aria-label={g.title || undefined}>
                        {g.title && <h2 className="t-section">{g.title}</h2>}
                        <ul className="card list divided">{g.rows.map(row)}</ul>
                    </section>
                ))
            )}
        </>
    );
    // Two or more projects: the dashboard answers "which of them is healthy?", unless the person prefers the list (Profile) or is
    // filtering by folder or looking at archived projects; one project keeps the plain list.
    if (all.length >= 2 && chosenView === null) return <ListSkeleton rows={3} />;
    if (all.length < 2 || chosenView === "list" || folder !== "all" || showArchived) return plain;
    return (
        <>
            <FleetDashboard fallback={plain} />
            <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
                <Button size="sm" variant="ghost" icon={List} onClick={() => setView("list")} tip="A plain list you can group by folder, with archived projects on request.">
                    Show as a list
                </Button>
            </div>
        </>
    );
}

function ProjectItem({ p }: { p: ProjectRow }): ReactNode {
    return (
        <li>
            <a className="list-row" href={routes.project(p.id)}>
                <span className="lead">
                    <FolderKanban size={17} aria-hidden />
                </span>
                <span className="main">
                    <span className="title truncate">{p.name}</span>
                    <span className="meta truncate">
                        {hostOf(p.url) || "No application yet"}
                        <span className="dot-sep" />
                        {relativeTime(p.created_at)}
                    </span>
                </span>
                <span className="tail">
                    {p.archived_at && <Badge>Archived</Badge>}
                    {p.test_count > 0 && (
                        <span className="row" style={{ gap: 10 }}>
                            <Ribbon small ticks={projectTicks(p.validated_count, p.test_count)} label={`${p.validated_count} of ${p.test_count} tests passing`} />
                            <span className="t-meta nowrap">
                                {p.validated_count} of {p.test_count} tests passing
                            </span>
                        </span>
                    )}
                    {/* A project with a finished exploration and no test has only a plan so far: it says so rather than "ready". */}
                    {p.last_job_status && p.test_count === 0 && (p.last_job_status === "COMPLETED" || p.last_job_status === "PARTIALLY_COMPLETED") ? (
                        <Badge tone="info" tip={jobHelp({ status: p.last_job_status, planOnly: true })}>Plan ready</Badge>
                    ) : p.last_job_status ? (
                        <JobBadge job={{ status: p.last_job_status, error: null }} />
                    ) : (
                        <Badge tip={NOT_EXPLORED}>Not explored yet</Badge>
                    )}
                </span>
                <ChevronRight size={18} className="chev" aria-hidden />
            </a>
        </li>
    );
}
