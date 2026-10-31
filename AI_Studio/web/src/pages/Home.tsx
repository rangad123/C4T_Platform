import { ChevronRight, FolderKanban } from "lucide-react";
import { NewProjectLink } from "../components/NewProjectLink";
import type { ProjectRow } from "../api";
import { Badge, ErrorState, JobBadge, ListSkeleton, PageHeader, Ribbon, jobKey, type Tick } from "../components/ui";
import { BadgeKey } from "../components/Tooltip";
import { jobHelp } from "../lib/help";
import { usePage } from "../components/Shell";
import { FleetDashboard } from "../features/dashboard/FleetDashboard";
import { hostOf, relativeTime } from "../lib/format";
import { friendlyError, isActive } from "../lib/labels";
import { useDocumentTitle, useFetch } from "../lib/hooks";
import { routes } from "../lib/router";
import { NewProject } from "./NewProject";

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
    const { data, error, loading, reload } = useFetch<ProjectRow[]>("/projects", (d) => (d?.some((p) => isActive(p.last_job_status)) ? 3000 : null));

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
    if (!data || data.length === 0) return <NewProject welcome />;

    const plain = (
        <>
            <PageHeader
                title="Projects"
                subtitle={
                    <>
                        Each project is one application we generate and maintain tests for.{" "}
                        <BadgeKey
                            label="the project statuses"
                            entries={data.map((p) =>
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
            <ul className="card list divided">
                {data.map((p) => (
                    <li key={p.id}>
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
                ))}
            </ul>
        </>
    );
    // Two or more projects: the dashboard answers "which of them is healthy?"; one project keeps the plain list.
    return data.length >= 2 ? <FleetDashboard fallback={plain} /> : plain;
}
