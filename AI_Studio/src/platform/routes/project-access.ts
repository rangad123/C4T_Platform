/**
 * Per-project access, set by owners on the People screen (the check itself is auth/project-scope.ts; the store project-access-store.ts).
 *
 *   PUT /api/users/:userId/projects   { access: "all" }  or  { access: "only", projects: [{ projectId, role }] }
 *                                     → { access } (the same shape GET /api/users gives each person)
 *
 * A role in a project may not be above the person's platform role. Owners only, and only owners with access to all projects (the
 * People screen is platform-wide). Nobody changes their own access, and the last active owner with access to all projects stays so,
 * so the platform always keeps someone who can manage people.
 */
import { z } from "zod";
import { accessControlOf, actorOf } from "../auth/access.js";
import { atLeast, ROLE_WORDS } from "../auth/actor.js";
import { HttpError } from "../http-error.js";
import { MAX_PROJECTS_PER_PERSON } from "../project-access-store.js";
import { EVERY_PROJECT_NEEDED } from "./users.js";
import type { RouteCtx } from "./types.js";

const Role = z.enum(["owner", "editor", "viewer"]);
const Body = z.discriminatedUnion("access", [
    z.object({ access: z.literal("all") }).strict(),
    z
        .object({
            access: z.literal("only"),
            projects: z
                .array(z.object({ projectId: z.string().min(1).max(64), role: Role }).strict())
                .max(MAX_PROJECTS_PER_PERSON, `At most ${MAX_PROJECTS_PER_PERSON} projects per person.`),
        })
        .strict(),
]);

export function registerProjectAccessRoutes(ctx: RouteCtx): void {
    const { app, repo } = ctx;
    const control = accessControlOf(app);
    const { users } = control;
    const store = control.projects.store;

    app.put("/api/users/:userId/projects", async (req) => {
        const { userId } = z.object({ userId: z.string().min(1).max(64) }).parse(req.params);
        // Crowd4Test sign-in: see `reachesEveryProject` in routes/users.ts.
        if (control.crowd4test && control.projects.allowed(actorOf(req)) !== null) throw new HttpError(403, EVERY_PROJECT_NEEDED);
        const parsed = Body.safeParse(req.body ?? {});
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message?.startsWith("At most") ? parsed.error.issues[0].message : "Choose “All projects”, or “Only these projects” with a role for each project.", parsed.error.issues);
        const body = parsed.data;
        const person = users.get(userId);
        if (!person) throw new HttpError(404, "Person not found");
        if (actorOf(req)?.id === userId) throw new HttpError(409, "You cannot change your own project access. Ask another owner.");

        if (body.access === "only") {
            // The last active owner who sees every project keeps doing so: otherwise nobody could manage people any more.
            if (person.role === "owner" && person.status === "active" && store.accessOf(userId).mode === "all") {
                const others = users.list().filter((u) => u.id !== userId && u.role === "owner" && u.status === "active" && store.accessOf(u.id).mode === "all");
                if (others.length === 0) throw new HttpError(409, "This is the only owner with access to all projects. Give another owner access to all projects first.");
            }
            const seen = new Set<string>();
            for (const p of body.projects) {
                if (seen.has(p.projectId)) throw new HttpError(400, "Each project can be listed once.");
                seen.add(p.projectId);
                if (!repo.getProject(p.projectId)) throw new HttpError(400, "One of the chosen projects does not exist any more. Reload the page and choose again.");
                if (!atLeast(person.role, p.role)) throw new HttpError(400, `A role in a project cannot be above the person’s own role (${ROLE_WORDS[person.role]}). Choose ${ROLE_WORDS[person.role]} or lower.`);
            }
            store.set(userId, { mode: "only", projects: body.projects });
        } else {
            store.set(userId, { mode: "all" });
        }
        return { access: store.view(userId, person.role) };
    });
}
