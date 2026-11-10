import { createContext, useContext, type ReactNode } from "react";
import type { ProjectDetail } from "../../api";
import { useFetch } from "../../lib/hooks";
import { useAuth } from "./auth";
import { useCan, type Permission } from "./permissions";
import { fullAccess, hereOf, type Here, type HerePermissions } from "./project-access-rules";

export { NO_PERMISSION_HERE, fullAccess, hereOf, whyNot, type Here, type HerePermissions } from "./project-access-rules";

/** A page that already reads the project shares its `access` with every control inside it, so no control asks again. */
const ProjectAccessContext = createContext<{ projectId: string; permissions: HerePermissions } | null>(null);

export function ProjectAccessProvider({ projectId, project, children }: { projectId: string; project: ProjectDetail | undefined; children: ReactNode }) {
    return <ProjectAccessContext.Provider value={{ projectId, permissions: project?.access?.permissions }}>{children}</ProjectAccessContext.Provider>;
}

/**
 * What the person may do in `projectId`. Inside a page that shares the project (ProjectHub, ProjectPlace) this reads that answer;
 * elsewhere it reads the project once itself. A component that already reads the project passes its fetch as `project` (no second read).
 */
export function useHere(projectId: string, project?: { data: ProjectDetail | undefined }): Here {
    const shared = useContext(ProjectAccessContext);
    const fromPage = shared && shared.projectId === projectId ? shared : null;
    const own = useFetch<ProjectDetail>(fromPage || project ? null : `/projects/${projectId}`);
    const me = useAuth().state?.me;
    const can = useCan();
    const permissions = project ? project.data?.access?.permissions : fromPage ? fromPage.permissions : own.data?.access?.permissions;
    // Before an account is known (no sign-in on this server) nothing is assumed: the server answers each request.
    return hereOf(permissions, fullAccess(me?.kind), me ? (p) => can(p as Permission) : () => true);
}
