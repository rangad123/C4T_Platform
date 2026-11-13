/**
 * Per-project access: which project each API route is about, and one check in front of every route (called by the access hook in
 * auth/access.ts, right after the role check) that keeps a person limited to "only these projects" inside them.
 *
 * Each route template gets a scope:
 *   project  the project is a route parameter (/api/projects/:id/…, /api/v1/security/projects/:id/…)
 *   object   an object found by its own id (/api/tests/:id, /api/test-generation/:jobId, /api/artifacts/:id, /api/recordings/:rid,
 *            /api/integrations/:id, /api/jobs/:id, and the security applications, assessments, findings and authorizations):
 *            its project is looked up here, in one place
 *   list     a list across projects that the handler narrows with `visibleProjectsOf(req)` (the projects list, the dashboard)
 *   query    the project is named in the query (?projectId=); without one the route is platform-wide
 *   ticket   POST /api/stream-tickets: the stream path in the body names a run or a project (checked once the body is read)
 *   none     nothing of any project (signing in, your own account, step-text conversions, the platform's settings as read by the page)
 *   all      platform-wide (people, Activity, single sign-on, storage, AI budgets, evaluation runs, new projects, restoring a backup):
 *            only for people with access to all projects
 *
 * Routes with their own credential or none ("own" and "public" in auth/roles.ts) are "none". Any other route this table does not
 * know is "all" (fail closed), and tests/project-access.test.ts fails when a registered route is not classified, so a new route
 * has to be placed deliberately.
 *
 * For a limited person: a project or object outside their list answers 404 with the same words as an unknown one (its existence is
 * not revealed), an unknown object answers 404 too, and inside an allowed project the role that counts is the lower of their role
 * there and their platform role (a token's role lowers it further, as everywhere). Everyone else (the access key, open access, people
 * with "all projects", runners, triggers) is not affected at all.
 *
 * Crowd4Test accounts (round 25, ACCESS_MODEL.md): ADMIN has "all projects"; everyone else is limited to the projects they were
 * added to, and what they may do there is what Crowd4Test granted them (no role here lowers it). A customer's membership counts only
 * for projects of their own organisation (the organization rule), so a project moved to another organisation closes at once.
 * Two platform-wide routes stay open to them when the permission allows: creating a project (they become its Project Admin) and
 * platform settings (a code only Crowd4Test staff can hold).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { HttpError } from "../http-error.js";
import { ProjectAccessStore } from "../project-access-store.js";
import { recorderOf } from "../routes/recorder.js";
import { isCrowd4TestActor, lowerRole, permissionRefusal, permissionsOf, sideOf, type Actor, type Role } from "./actor.js";
import { intersect, ROLE_PERMISSIONS, type Permission } from "./permissions.js";
import type { PermissionRule } from "./roles.js";

export type ObjectKind = "test" | "job" | "artifact" | "recording" | "integration" | "security-application" | "security-assessment" | "security-finding" | "security-authorization";

export type Scope =
    | { kind: "project"; param: string }
    | { kind: "object"; param: string; object: ObjectKind }
    | { kind: "list" }
    | { kind: "query"; param: string }
    | { kind: "ticket" }
    | { kind: "none" }
    | { kind: "all" };

export const ALL_PROJECTS_NEEDED = "This is for people with access to all projects. Ask an owner of this platform if you need it.";

/** The words of an unknown object's 404, the same as the routes' own, so a hidden object reads exactly like a missing one. */
export const NOT_FOUND: Record<ObjectKind | "project", string> = {
    project: "Project not found",
    test: "Test not found",
    job: "Job not found",
    artifact: "Artifact not found",
    recording: "Recording not found. It may have been discarded or the platform was restarted.",
    integration: "Integration not found",
    "security-application": "Application not found",
    "security-assessment": "Assessment not found",
    "security-finding": "Finding not found",
    "security-authorization": "Authorization not found",
};

/** Route families by their leading path: everything below these is about one project or one object of a project. */
const PATTERNS: ReadonlyArray<{ prefix: string; scope: Scope }> = [
    { prefix: "/api/projects/:id", scope: { kind: "project", param: "id" } },
    { prefix: "/api/v1/security/projects/:id", scope: { kind: "project", param: "id" } },
    { prefix: "/api/tests/:id", scope: { kind: "object", param: "id", object: "test" } },
    { prefix: "/api/test-generation/:jobId", scope: { kind: "object", param: "jobId", object: "job" } },
    { prefix: "/api/jobs/:id", scope: { kind: "object", param: "id", object: "job" } },
    { prefix: "/api/artifacts/:id", scope: { kind: "object", param: "id", object: "artifact" } },
    { prefix: "/api/recordings/:rid", scope: { kind: "object", param: "rid", object: "recording" } },
    { prefix: "/api/integrations/:id", scope: { kind: "object", param: "id", object: "integration" } },
    { prefix: "/api/v1/security/applications/:appId", scope: { kind: "object", param: "appId", object: "security-application" } },
    { prefix: "/api/v1/security/assessments/:aid", scope: { kind: "object", param: "aid", object: "security-assessment" } },
    { prefix: "/api/v1/security/findings/:fid", scope: { kind: "object", param: "fid", object: "security-finding" } },
    { prefix: "/api/v1/security/authorizations/:authId", scope: { kind: "object", param: "authId", object: "security-authorization" } },
];

/** Routes outside those families, by "METHOD /template" (HEAD follows GET). Anything else that is not own/public is platform-wide. */
export const EXPLICIT_SCOPES: Record<string, Scope["kind"]> = {
    // ── nothing of any project ──
    "PUT /api/me/password": "none",
    "POST /api/me/sign-out-everywhere": "none",
    "GET /api/me/tokens": "none",
    "POST /api/me/tokens": "none",
    "DELETE /api/me/tokens/:tokenId": "none",
    "GET /api/config": "none",
    "GET /api/mobile/emulator-setup": "none",
    "GET /api/dsl/phrases": "none",
    "POST /api/dsl/parse": "none",
    "POST /api/dsl/print": "none",
    "GET /api/usage/prices": "none",
    "GET /api/llm/health": "none",
    "GET /api/llm/fast-model": "none",
    "GET /api/llm/prompt-cache": "none",
    "GET /api/llm/compact-snapshots": "none",
    "GET /api/llm/without-ai": "none",
    "GET /api/v1/security/status": "none",
    // The platform's scanner settings, the profiles and the reviewed AI cases: nothing of any one project.
    "GET /api/v1/security/scanners": "none",
    // Organisations, not projects: the handler shows a customer only their own and a tester none (routes/project-settings.ts).
    "GET /api/organizations": "none",
    // A person's own preferences; folders, whose handlers narrow them to the person's organisation and reachable projects (routes/project-folders.ts).
    "GET /api/me/preferences": "none",
    "PUT /api/me/preferences": "none",
    "POST /api/folders": "none",
    "PATCH /api/folders/:folderId": "none",
    "DELETE /api/folders/:folderId": "none",
    // Reusable libraries: the handlers narrow them to the organisations the person works in (routes/libraries.ts).
    "POST /api/libraries/folders": "none",
    "PATCH /api/libraries/folders/:folderId": "none",
    "DELETE /api/libraries/folders/:folderId": "none",
    "POST /api/libraries/items": "none",
    "PATCH /api/libraries/items/:itemId": "none",
    "PUT /api/libraries/items/:itemId/content": "none",
    "DELETE /api/libraries/items/:itemId": "none",
    "POST /api/ai-configurations": "none",
    "PATCH /api/ai-configurations/:configId": "none",
    "DELETE /api/ai-configurations/:configId": "none",
    "POST /api/ai-configurations/:configId/test": "none",
    // Shared integrations: the handlers keep them to the person's organisation (routes/shared-integrations.ts).
    "POST /api/shared-integrations": "none",
    "PATCH /api/shared-integrations/:sid": "none",
    "DELETE /api/shared-integrations/:sid": "none",
    "POST /api/shared-integrations/:sid/test": "none",
    // Round 45: the person's own runner, and the admins' list of everyone's (routes/runners.ts, routes/runner-kits.ts); no project in the path.
    "GET /api/me/runner": "none",
    "PATCH /api/me/runner": "none",
    "POST /api/me/runner/retire": "none",
    "POST /api/me/runner/update": "none",
    "GET /api/me/runner/enrollments/:enrollmentId": "none",
    "POST /api/me/runner/download": "none",
    "GET /api/me/runner/download/info": "none",
    // ── lists narrowed to the allowed projects by their handlers ──
    "GET /api/projects": "list",
    "GET /api/dashboard": "list",
    "GET /api/reviews": "list",
    "GET /api/folders": "list",
    // Testing agents: the catalogue, with the asker's projects that use each (routes/testing-agents.ts).
    "GET /api/testing-agents": "list",
    "GET /api/testing-agents/:agentId": "list",
    "GET /api/libraries": "list",
    "GET /api/libraries/items/:itemId": "list",
    "GET /api/libraries/items/:itemId/versions/:version": "list",
    "GET /api/ai-configurations": "list",
    "GET /api/shared-integrations": "list",
    // ── the project in the query ──
    "GET /api/usage": "query",
    // ── a stream path in the body ──
    "POST /api/stream-tickets": "ticket",
    // ── platform-wide, for people with access to all projects (listed so the classification is deliberate) ──
    "POST /api/projects": "all",
    "POST /api/projects/restore": "all",
    "GET /api/users": "all",
    "POST /api/users": "all",
    "PATCH /api/users/:userId": "all",
    "DELETE /api/users/:userId": "all",
    "POST /api/users/:userId/reset-link": "all",
    "POST /api/users/:userId/sign-out": "all",
    "PUT /api/users/:userId/projects": "all",
    "GET /api/activity": "all",
    "GET /api/sso-settings": "all",
    "PUT /api/sso-settings": "all",
    "DELETE /api/sso-settings": "all",
    "GET /api/storage": "all",
    "PUT /api/usage/prices": "all",
    "DELETE /api/usage/prices": "all",
    "GET /api/usage/budgets": "all",
    "PUT /api/usage/budgets": "all",
    "POST /api/llm/check": "all",
    "PUT /api/llm/fallbacks": "all",
    "PUT /api/llm/fast-model": "all",
    "PUT /api/llm/planning-model": "all",
    "PUT /api/llm/prompt-cache": "all",
    "PUT /api/llm/compact-snapshots": "all",
    "PUT /api/llm/without-ai": "all",
    "GET /api/eval/runs": "all",
    "GET /api/eval/runs/:id": "all",
    "POST /api/eval/runs": "all",
    "DELETE /api/eval/runs/:id": "all",
};

const startsFamily = (template: string, prefix: string) => template === prefix || template.startsWith(`${prefix}/`);

/** The scope of a route, or undefined when nothing classifies it (the check then treats it as platform-wide). */
export function classifyRoute(method: string, template: string, rule: PermissionRule | Role | undefined): Scope | undefined {
    if (rule === "own" || rule === "public") return { kind: "none" };
    for (const p of PATTERNS) if (startsFamily(template, p.prefix)) return p.scope;
    const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
    const kind = EXPLICIT_SCOPES[`${m} ${template}`];
    if (!kind) return undefined;
    if (kind === "query") return { kind, param: "projectId" };
    return { kind } as Scope;
}

const STREAM_TICKET_PATH = /^\/api\/(test-generation|projects)\/([^/]+)\/stream$/;

export interface ProjectScope {
    store: ProjectAccessStore;
    /** null: every project. Otherwise the projects the actor may see, each with the role that counts there. */
    allowed(actor: Actor | undefined): Map<string, Role> | null;
    /** The project an object belongs to, or undefined when it is unknown. */
    projectOf(kind: ObjectKind, id: string): string | undefined;
    /** Throws 404 (not visible) or 403 (not held there) for a limited actor; does nothing for everyone else. */
    check(req: FastifyRequest, actor: Actor, template: string, need: Permission): void;
    /** The body-carried check of the stream-ticket route. */
    checkTicket(req: FastifyRequest, actor: Actor): void;
    /** What the actor may do on a project (its effective codes), or undefined when the project is out of their reach. */
    permissionsIn(actor: Actor, projectId: string): ReadonlySet<Permission> | undefined;
    /**
     * Whether the actor is a Project Admin of the project: the flag on their membership. Local accounts that reach every project
     * (the access key, open access, people with "all projects") count as one everywhere: a local install has no members to flag.
     */
    isProjectAdmin(actor: Actor, projectId: string): boolean;
    /** Approving on a project (D-23): `ai_studio.tests.approve` there and Project Admin of it. For the approval routes to come. */
    canApprove(actor: Actor, projectId: string): boolean;
}

/** Platform-wide routes a limited Crowd4Test account may still use with the permission: creating a project, and platform settings. */
const C4T_WIDE_OPEN = (template: string, method: string, need: Permission) =>
    need === "ai_studio.platform.settings" || (method === "POST" && template === "/api/projects" && need === "ai_studio.project.create");

const SCOPE = Symbol("aitp.projectScope");

/** For list handlers: the projects the caller may see (null = all). Works on any request the access hook saw. */
export function visibleProjectsOf(req: FastifyRequest, actor: Actor | undefined): ReadonlyMap<string, Role> | null {
    const s = (req as unknown as Record<symbol, ProjectScope | undefined>)[SCOPE];
    return s ? s.allowed(actor) : null;
}

export function attachProjectScope(req: FastifyRequest, scope: ProjectScope): void {
    (req as unknown as Record<symbol, ProjectScope>)[SCOPE] = scope;
}

export function createProjectScope(app: FastifyInstance, db: Db): ProjectScope {
    const store = new ProjectAccessStore(db);
    const one = (sql: string, id: string): string | undefined => db.get<{ p: string }>(sql, id)?.p;

    const projectOf = (kind: ObjectKind, id: string): string | undefined => {
        if (!id || id.length > 200) return undefined;
        switch (kind) {
            case "test":
                return one("SELECT project_id AS p FROM test_cases WHERE id = ?", id);
            case "job":
                return one("SELECT project_id AS p FROM generation_jobs WHERE id = ?", id);
            case "artifact":
                return one("SELECT project_id AS p FROM artifacts WHERE id = ?", id);
            case "integration":
                return one("SELECT project_id AS p FROM integrations WHERE id = ?", id);
            case "security-application":
                return one("SELECT project_id AS p FROM security_applications WHERE id = ?", id);
            case "security-assessment":
                return one("SELECT project_id AS p FROM security_assessments WHERE id = ?", id);
            case "security-finding":
                return one("SELECT project_id AS p FROM security_findings WHERE id = ?", id);
            case "security-authorization":
                return one("SELECT a.project_id AS p FROM security_authorizations z JOIN security_applications a ON a.id = z.application_id WHERE z.id = ?", id);
            case "recording":
                // Recordings live in memory (routes/recorder.ts); a gone one has no project ("").
                return recorderOf(app)?.get(id)?.projectId || undefined;
        }
    };

    const allowed = (actor: Actor | undefined): Map<string, Role> | null => {
        if (!actor || actor.kind !== "user" || !actor.id) return null;
        const a = store.accessOf(actor.id);
        if (a.mode === "all") return null;
        if (isCrowd4TestActor(actor)) {
            // What they may do comes from Crowd4Test: "owner" here only says that no role of this server lowers it.
            const rows =
                sideOf(actor) === "customer"
                    ? db.all<{ project_id: string }>("SELECT up.project_id FROM user_projects up JOIN projects p ON p.id = up.project_id WHERE up.user_id = ? AND p.organization_id = ?", actor.id, actor.organizationId ?? "")
                    : [...a.projects.keys()].map((project_id) => ({ project_id }));
            return new Map(rows.map((r) => [r.project_id, "owner" as Role]));
        }
        return new Map([...a.projects].map(([id, role]) => [id, lowerRole(role, actor.role)]));
    };

    const require = (actor: Actor, allowedHere: Map<string, Role>, projectId: string | undefined, need: Permission, notFound: string): void => {
        const role = projectId ? allowedHere.get(projectId) : undefined;
        if (!role) throw new HttpError(404, notFound);
        if (!ROLE_PERMISSIONS[role].has(need)) throw new HttpError(403, permissionRefusal(actor, need, { role }));
    };

    const permissionsIn = (actor: Actor, projectId: string): ReadonlySet<Permission> | undefined => {
        const here = allowed(actor);
        if (!here) return permissionsOf(actor);
        const role = here.get(projectId);
        return role ? intersect(permissionsOf(actor), ROLE_PERMISSIONS[role]) : undefined;
    };

    const isProjectAdmin = (actor: Actor, projectId: string): boolean => {
        if (actor.kind === "key" || actor.kind === "open") return true;
        if (actor.kind !== "user" || !actor.id) return false;
        if (store.isProjectAdmin(projectId, actor.id)) return permissionsIn(actor, projectId) !== undefined;
        return !isCrowd4TestActor(actor) && store.accessOf(actor.id).mode === "all";
    };

    return {
        store,
        allowed,
        projectOf,
        permissionsIn,
        isProjectAdmin,
        canApprove: (actor, projectId) => Boolean(permissionsIn(actor, projectId)?.has("ai_studio.tests.approve")) && isProjectAdmin(actor, projectId),
        check(req, actor, template, need) {
            const here = allowed(actor);
            if (!here) return;
            const scope = classifyRoute(req.method, template, undefined) ?? { kind: "all" };
            const params = (req.params ?? {}) as Record<string, string | undefined>;
            switch (scope.kind) {
                case "none":
                case "list":
                case "ticket":
                    return;
                case "all":
                    if (isCrowd4TestActor(actor) && C4T_WIDE_OPEN(template, req.method.toUpperCase(), need)) return;
                    throw new HttpError(403, ALL_PROJECTS_NEEDED);
                case "query": {
                    const q = (req.query ?? {}) as Record<string, unknown>;
                    const id = typeof q[scope.param] === "string" ? (q[scope.param] as string) : "";
                    if (!id) throw new HttpError(403, ALL_PROJECTS_NEEDED);
                    return require(actor, here, id, need, NOT_FOUND.project);
                }
                case "project":
                    require(actor, here, params[scope.param], need, NOT_FOUND.project);
                    break;
                case "object":
                    require(actor, here, projectOf(scope.object, String(params[scope.param] ?? "")), need, NOT_FOUND[scope.object]);
                    break;
            }
            // A run named inside a project route (…/runs/:jobId, …/plans/:jobId): it must be one the person may see too (the routes
            // also check it belongs to that project; this keeps the rule in one place for limited people).
            if (params.jobId && scope.kind === "project") require(actor, here, projectOf("job", params.jobId), need, NOT_FOUND.job);
        },
        checkTicket(req, actor) {
            const here = allowed(actor);
            if (!here) return;
            const path = typeof (req.body as { path?: unknown } | undefined)?.path === "string" ? (req.body as { path: string }).path : "";
            const m = STREAM_TICKET_PATH.exec(path);
            if (!m) return; // the route itself refuses a path that is not a stream
            if (m[1] === "projects") require(actor, here, m[2], "ai_studio.access", NOT_FOUND.project);
            else require(actor, here, projectOf("job", m[2]!), "ai_studio.access", NOT_FOUND.job);
        },
    };
}
