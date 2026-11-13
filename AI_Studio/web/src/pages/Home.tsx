import { ChevronLeft, ChevronRight, Folder, LayoutDashboard, List, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NewProjectLink } from "../components/NewProjectLink";
import { PLATFORM_WORDS, projectKind, projectShape, type Platform, type ProjectKind, type ProjectPage, type ProjectRow } from "../api";
import { Badge, Button, ErrorState, JobBadge, LinkButton, ListSkeleton, PageHeader, Ribbon, jobKey, type Tick } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { jobHelp } from "../lib/help";
import { usePage } from "../components/Shell";
import { hostOf, plural, relativeTime } from "../lib/format";
import { friendlyError, isActive } from "../lib/labels";
import { useDocumentTitle, useFetch } from "../lib/hooks";
import { routes, useRoute } from "../lib/router";
import { NewProject } from "./NewProject";
import type { FoldersAnswer } from "../features/workspace/FoldersPage";
import { KIND_HELP, KIND_WORDS, KindTile, PlatformMark, ProjectTags, shortAgentName, type TagAgent } from "../components/ProjectKind";
import { AgentAvatar, type AgentId, type AgentList } from "../features/testing-agents/testing-agents";

/** "all", "grouped", "none" (not in a folder) or a folder id. */
type FolderFilter = string;

const NOT_EXPLORED = "The AI has not explored this application yet, so it has no tests.";
const NO_SCRIPTS = "This code project has no test scripts yet. Add them on its Test scripts tab.";
const NOT_RUN = "Its test scripts have not been run yet.";


/** At most 40 ticks, in proportion; the rest are "waiting" because the project list only knows how many validated. */
function projectTicks(validated: number, total: number): Tick[] {
    const n = Math.min(total, 40);
    const pass = Math.round((validated / total) * n);
    return Array.from({ length: n }, (_, i): Tick => (i < pass ? "pass" : "idle"));
}

/** Projects per page (round 37). The page number is in the address (`#/?page=2`, `#/?page=all`), so Back returns to it. */
export const PROJECTS_PAGE_SIZE = 20;

/** `#/` with the page in the query (page 1 has none). */
export const projectsPageHref = (page: number | "all") => (page === "all" ? "#/?page=all" : page > 1 ? `#/?page=${page}` : "#/");

export function Home() {
    useDocumentTitle("Projects");
    usePage({ crumbs: [{ label: "Projects" }], nav: "projects" });
    const query = useRoute().query;
    const rawPage = query.get("page");
    const all = rawPage === "all";
    const page = all ? 1 : Math.max(1, Math.floor(Number(rawPage) || 1));
    const [showArchived, setShowArchived] = useState(false);
    // The folders to group or filter by; not needed to show the list.
    const folders = useFetch<FoldersAnswer>("/folders");
    const [folder, setFolder] = useState<FolderFilter>("all");
    const [text, setText] = useState("");
    const [q, setQ] = useState("");
    // Typing searches after a short pause; the list is asked for again, on the server, page by page.
    useEffect(() => {
        const t = setTimeout(() => setQ(text.trim()), 300);
        return () => clearTimeout(t);
    }, [text]);
    const params = new URLSearchParams();
    if (showArchived) params.set("archived", "include");
    if (q) params.set("q", q);
    if (folder !== "all" && folder !== "grouped") params.set("folder", folder);
    if (!all) {
        params.set("limit", String(PROJECTS_PAGE_SIZE));
        params.set("offset", String((page - 1) * PROJECTS_PAGE_SIZE));
    }
    // The testing agents, each with the projects using it: one request for every row's agent tiles and the legend.
    const catalogue = useFetch<AgentList>("/testing-agents");
    const agentNames = new Map((catalogue.data?.agents ?? []).map((a) => [a.id, shortAgentName(a.name)]));
    const agentsOf = new Map<string, AgentId[]>();
    for (const a of catalogue.data?.agents ?? []) for (const ref of a.projects) agentsOf.set(ref.id, [...(agentsOf.get(ref.id) ?? []), a.id]);
    const { data, error, loading, reload } = useFetch<ProjectPage | ProjectRow[]>(`/projects?${params.toString()}`, (d) => (rowsOf(d).some((p) => isActive(p.last_job_status)) ? 3000 : null));
    // A filter or search changed: back to the first page (replacing, so Back does not step through every keystroke).
    const filterKey = `${showArchived}|${q}|${folder}`;
    const lastFilter = useRef(filterKey);
    useEffect(() => {
        if (lastFilter.current === filterKey) return;
        lastFilter.current = filterKey;
        if (page > 1) location.replace(`${location.pathname}${location.search}${projectsPageHref(1)}`);
    }, [filterKey, page]);

    const rows = rowsOf(data);
    const total = Array.isArray(data) ? data.length : (data?.total ?? 0);
    const filtering = showArchived || q !== "" || folder !== "all";
    if (error && !data) return <ErrorState error={friendlyError(error.message)} onRetry={reload} />;
    // First visit: the whole page is the one thing to do.
    if (!loading && data && total === 0 && !filtering && page === 1) return <NewProject welcome />;
    const folderList = folders.data?.folders ?? [];
    const pages = all ? 1 : Math.max(1, Math.ceil(total / PROJECTS_PAGE_SIZE));
    const row = (p: ProjectRow) => <ProjectItem key={p.id} p={p} agents={agentsOf.get(p.id)} names={agentNames} />;
    const groups: Array<{ key: string; title: string; rows: ProjectRow[] }> =
        folder === "grouped"
            ? [...folderList.map((f) => ({ key: f.id, title: f.name, rows: rows.filter((p) => p.folder_id === f.id) })), { key: "none", title: "Not in a folder", rows: rows.filter((p) => !p.folder_id || !folderList.some((f) => f.id === p.folder_id)) }].filter((g) => g.rows.length > 0)
            : [{ key: "all", title: "", rows }];
    const tools = (
        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginBottom: 16 }} data-testid="projects-tools">
            <div className="input-wrap" style={{ flex: "1 1 240px", maxWidth: 360 }}>
                <Search size={16} className="lead" aria-hidden />
                <input className="input" type="search" aria-label="Search projects" placeholder="Search by name or address" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
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
            {(folderList.length > 0 || folders.data?.canCreate) && (
                <LinkButton size="sm" variant="ghost" icon={Folder} href={routes.projectFolders} tip="Group your organisation's projects into folders, for example by client or product line.">
                    Project folders
                </LinkButton>
            )}
            <span className="spacer" />
            <LinkButton size="sm" variant="ghost" icon={LayoutDashboard} href={routes.dashboard} tip="How ready each project is, with the machines and the AI they use.">
                Open the dashboard
            </LinkButton>
        </div>
    );

    return (
        <>
            <PageHeader
                title="Projects"
                subtitle={
                    <>
                        Each project is one application we generate and maintain tests for.{" "}
                        <BadgeKey
                            label="the project statuses"
                            entries={rows.map((p) => {
                                if (projectKind(p) === "code") return p.test_count === 0 ? { word: "No test scripts yet", text: NO_SCRIPTS } : p.last_job_status ? jobKey([{ status: p.last_job_status, error: null }])[0] : { word: "Not run yet", text: NOT_RUN };
                                return p.last_job_status && p.test_count === 0 && (p.last_job_status === "COMPLETED" || p.last_job_status === "PARTIALLY_COMPLETED")
                                    ? { word: "Plan ready", text: jobHelp({ status: p.last_job_status, planOnly: true }) }
                                    : p.last_job_status
                                      ? jobKey([{ status: p.last_job_status, error: null }])[0]
                                      : { word: "Not explored yet", text: NOT_EXPLORED };
                            })}
                        />
                    </>
                }
                actions={<NewProjectLink />}
            />
            {tools}
            {loading && !data ? (
                <ListSkeleton rows={3} />
            ) : rows.length === 0 ? (
                <p className="t-secondary card card-pad">{page > 1 && total > 0 ? <>There is no page {page}. <a href={projectsPageHref(1)}>Go to the first page</a>.</> : filtering ? "No projects match. Clear the search or the folder to see every project." : "No projects here."}</p>
            ) : (
                groups.map((g) => (
                    <section key={g.key} className="stack-sm" style={{ marginBottom: 16 }} aria-label={g.title || undefined}>
                        {g.title && <h2 className="t-section">{g.title}</h2>}
                        <ul className="card list divided pk-list" aria-busy={loading || undefined}>{g.rows.map(row)}</ul>
                    </section>
                ))
            )}
            {total > 0 && (
                <nav className="row" aria-label="Pages of projects" data-testid="projects-pager" style={{ gap: 12, flexWrap: "wrap" }}>
                    <span className="t-meta" aria-live="polite">
                        {all ? `All ${plural(total, "project")}` : `Page ${Math.min(page, pages)} of ${pages} · ${(page - 1) * PROJECTS_PAGE_SIZE + 1}–${Math.min(page * PROJECTS_PAGE_SIZE, total)} of ${plural(total, "project")}`}
                    </span>
                    <span className="spacer" />
                    {!all && pages > 1 && (
                        <>
                            {page > 1 ? <LinkButton size="sm" icon={ChevronLeft} href={projectsPageHref(page - 1)}>Previous</LinkButton> : <Button size="sm" icon={ChevronLeft} disabled>Previous</Button>}
                            {page < pages ? <LinkButton size="sm" icon={ChevronRight} href={projectsPageHref(page + 1)}>Next</LinkButton> : <Button size="sm" icon={ChevronRight} disabled>Next</Button>}
                        </>
                    )}
                    {all ? (
                        total > PROJECTS_PAGE_SIZE && <LinkButton size="sm" variant="ghost" href={projectsPageHref(1)}>Show {PROJECTS_PAGE_SIZE} per page</LinkButton>
                    ) : (
                        pages > 1 && <LinkButton size="sm" variant="ghost" icon={List} href={projectsPageHref("all")} tip="Every project on one page.">View all</LinkButton>
                    )}
                </nav>
            )}
            {rows.length > 0 && <Legend agents={(catalogue.data?.agents ?? []).map((a) => ({ id: a.id, name: shortAgentName(a.name), available: a.available }))} />}
        </>
    );
}

/** What the icons on the rows mean: the kinds, the platforms and every testing agent. */
function Legend({ agents }: { agents: Array<{ id: AgentId; name: string; available: boolean }> }) {
    return (
        <section className="card pk-legend" aria-label="What the icons mean" data-testid="projects-legend">
            <div className="pk-legend-group">
                <h2>Project type</h2>
                <ul>
                    {(["agent", "code"] as const).map((k) => (
                        <li key={k} title={KIND_HELP[k]}>
                            <KindTile kind={k} size="sm" />
                            {KIND_WORDS[k]}
                        </li>
                    ))}
                </ul>
            </div>
            <div className="pk-legend-group">
                <h2>Platforms</h2>
                <ul>
                    {(Object.keys(PLATFORM_WORDS) as Platform[]).map((p) => (
                        <li key={p}>
                            <PlatformMark platform={p} />
                        </li>
                    ))}
                </ul>
            </div>
            {agents.length > 0 && (
                <div className="pk-legend-group">
                    <h2>Agents</h2>
                    <ul>
                        {agents.map((a) => (
                            <li key={a.id}>
                                <AgentAvatar id={a.id} size="sm" available={a.available} />
                                {a.name}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}

/** The rows of either answer: a page, or the whole list (View all). */
function rowsOf(d: ProjectPage | ProjectRow[] | undefined): ProjectRow[] {
    return Array.isArray(d) ? d : (d?.projects ?? []);
}

function ProjectItem({ p, agents, names }: { p: ProjectRow; agents: AgentId[] | undefined; names: Map<AgentId, string> }): ReactNode {
    const kind: ProjectKind = projectKind(p);
    const tagAgents: TagAgent[] | undefined = agents?.map((id) => ({ id, name: names.get(id) ?? id }));
    return (
        <li>
            <a className="list-row" href={routes.project(p.id)} data-kind={kind}>
                <KindTile kind={kind} labelled />
                <span className="main">
                    <span className="title truncate">{p.name}</span>
                    <span className="meta truncate">
                        {hostOf(p.url) || "No application yet"}
                        <span className="dot-sep" />
                        {relativeTime(p.created_at)}
                    </span>
                    {/* The count sits under the name, so the row's kind, platform and agents leave the name room. */}
                    {p.test_count > 0 && (
                        <span className="meta truncate">
                            {p.validated_count} of {p.test_count} tests passing
                        </span>
                    )}
                </span>
                <span className="pk-facts">
                    <ProjectTags kind={kind} platforms={projectShape(p).platforms} agents={tagAgents} row />
                </span>
                <span className="pk-ribbon">{p.test_count > 0 && <Ribbon small ticks={projectTicks(p.validated_count, p.test_count)} label={`${p.validated_count} of ${p.test_count} tests passing`} />}</span>
                <span className="tail">
                    {p.archived_at && <Badge>Archived</Badge>}
                    {kind === "code" ? (
                        // A code project is never explored: it says what its test scripts have, not "Not explored yet".
                        p.test_count === 0 ? (
                            <Badge tip={NO_SCRIPTS}>No test scripts yet</Badge>
                        ) : p.last_job_status ? (
                            <JobBadge job={{ status: p.last_job_status, error: null }} />
                        ) : (
                            <Badge tip={NOT_RUN}>Not run yet</Badge>
                        )
                    ) : /* A project with a finished exploration and no test has only a plan so far: it says so rather than "ready". */
                    p.last_job_status && p.test_count === 0 && (p.last_job_status === "COMPLETED" || p.last_job_status === "PARTIALLY_COMPLETED") ? (
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
