/**
 * A project's people and its Project Admins (ACCESS_MODEL.md, D-23, D-27; US-006). Every route needs ai_studio.project.members on
 * the project (auth/roles.ts) and the project in reach (auth/project-scope.ts).
 *
 *   GET    /api/projects/:id/members                     → { members: Member[], organizationId }
 *   GET    /api/projects/:id/members/candidates?q=       → { people: Candidate[], source: "signed-in" | "crowd4test", notice? }
 *   POST   /api/projects/:id/members                     { personId, projectAdmin? } → 201 { member }
 *   PATCH  /api/projects/:id/members/:personId           { projectAdmin } → { member }
 *   DELETE /api/projects/:id/members/:personId           → { removed: true }
 *
 * A member is a row of user_projects (project-access-store.ts): for a Crowd4Test account it is what opens the project; for a person
 * made here with "only these projects" it is one of their projects, with their platform role there. Rules, whatever was granted:
 * a customer joins only projects of their own organisation, and a project keeps at least one Project Admin once it has one.
 * Each change is written to the Activity list in plain words (the generic recorder keeps only the refused attempts).
 *
 * Who can be added comes from a PeopleDirectory. With Crowd4Test's service configured (c4t-service.ts) it is Crowd4Test's people
 * search, so someone who never opened AI Studio can be added: they are offered as `personId: "crowd4test:<their C4T id>"`, and adding
 * them makes their person here first (as their first arrival would, auth/crowd4test.ts), with membership of this project and
 * nothing more. Without the service, or while Crowd4Test cannot be reached (with a `notice`), it is the people known here: everyone
 * who has signed in at least once.
 */
import { z } from "zod";
import { accessControlOf, actorOf } from "../auth/access.js";
import { actorLabel, currentActor, sideOf, type Actor } from "../auth/actor.js";
import { ROLE_CEILING, subjectOf } from "../auth/crowd4test.js";
import { c4tServiceOf, clientIpOf, type C4tPerson, type C4tService } from "../c4t-service.js";
import { HttpError } from "../http-error.js";
import { kindOfC4tRole, type Member, type ProjectAccessStore } from "../project-access-store.js";
import { MAX_PEOPLE, normEmail, type Person, type UserStore } from "../user-store.js";
import type { RouteCtx } from "./types.js";

export const LAST_PROJECT_ADMIN = "A project needs at least one Project Admin.";
export const OTHER_ORGANIZATION = "Customers can only be added to projects of their own organisation.";

/** Someone who may be added to a project. */
export interface Candidate {
    personId: string;
    name: string;
    email: string;
    kind: Member["kind"];
    organizationId: string | null;
    /** True for someone from Crowd4Test's search who has no person here yet (their personId is "crowd4test:<C4T id>"). */
    newHere: boolean;
}

/** Where the people who can be added come from (the seam for Crowd4Test's people search). */
export interface PeopleDirectory {
    readonly source: "signed-in" | "crowd4test";
    search(q: string, limit: number, clientIp?: string): Candidate[] | Promise<Candidate[]>;
}

/** The personId of someone offered from Crowd4Test who has no person here yet. */
export const C4T_CANDIDATE_PREFIX = "crowd4test:";
export const NOT_ON_C4T = "This person was not found on Crowd4Test. Search for them again, then add them.";
export const C4T_SEARCH_NOTICE = "Crowd4Test could not be reached, so only people who have opened AI Studio are shown.";

const personBySubject = (users: UserStore, c4tId: string): Person | undefined => {
    const id = users.db.get<{ id: string }>("SELECT id FROM users WHERE sso_subject = ? AND role IS NOT NULL", subjectOf({ id: c4tId }))?.id;
    return id ? users.get(id) : undefined;
};

/** Crowd4Test's people search: each found person as their person here when they have one, else as someone new here. */
export function crowd4testPeople(users: UserStore, service: C4tService): PeopleDirectory {
    return {
        source: "crowd4test",
        async search(q, limit, clientIp) {
            const out: Candidate[] = [];
            for (const c of await service.searchPeople(q, clientIp)) {
                const here = personBySubject(users, c.id);
                if (here && here.status !== "active") continue;
                out.push({
                    personId: here?.id ?? `${C4T_CANDIDATE_PREFIX}${c.id}`,
                    name: c.name,
                    email: c.email,
                    kind: kindOfC4tRole(c.kind),
                    // As at sign-in: only a customer belongs to an organisation here.
                    organizationId: c.kind === "CUSTOMER" ? c.organisationId : null,
                    newHere: !here,
                });
                if (out.length >= limit) break;
            }
            return out;
        },
    };
}

/**
 * The person here for someone found on Crowd4Test who never opened AI Studio, made as their first arrival would make them
 * (auth/crowd4test.ts personFor): linked by their Crowd4Test id, "only these projects" (ADMIN: all), their kind and a customer's
 * organisation recorded. What they may do still comes from Crowd4Test when they arrive. A refusal leaves nothing behind.
 */
export function personFromCrowd4Test(users: UserStore, store: ProjectAccessStore, c: C4tPerson): Person | { refused: string } {
    const linked = personBySubject(users, c.id);
    if (linked) return linked.status === "active" ? linked : { refused: "This person's AI Studio access is turned off. Ask an owner of AI Studio." };
    const email = normEmail(c.email);
    if (users.byEmail(email)) return { refused: "Someone here already uses this email address without Crowd4Test. Ask them to open AI Studio from Crowd4Test first." };
    if (users.emailTakenByBuiltIn(email)) return { refused: "That address is reserved by the platform." };
    if (users.peopleCount() >= MAX_PEOPLE) return { refused: "AI Studio has reached its limit of people. Ask an owner." };
    const person = users.create({ email, name: c.name, role: ROLE_CEILING[c.kind]!, ssoSubject: subjectOf(c) });
    store.set(person.id, c.kind === "ADMIN" ? { mode: "all" } : { mode: "only", projects: [] });
    if (c.organisationId) store.ensureOrganization(c.organisationId);
    store.recordCrowd4TestAccount(person.id, c.kind, c.kind === "CUSTOMER" ? c.organisationId : null);
    return person;
}

/** The people known here: everyone who has an account and is active. */
export function knownPeople(users: UserStore, store: ProjectAccessStore): PeopleDirectory {
    return {
        source: "signed-in",
        search(q, limit) {
            const needle = q.trim().toLowerCase();
            const out: Candidate[] = [];
            for (const p of users.list()) {
                if (p.status !== "active") continue;
                if (needle && !p.email.toLowerCase().includes(needle) && !(p.name ?? "").toLowerCase().includes(needle)) continue;
                const c4t = store.crowd4TestAccountOf(p.id);
                out.push({ personId: p.id, name: p.name || p.email, email: p.email, kind: kindOfC4tRole(c4t?.c4tRole ?? null), organizationId: c4t?.organizationId ?? null, newHere: false });
                if (out.length >= limit) break;
            }
            return out;
        },
    };
}

const Params = z.object({ id: z.string().min(1).max(64) });
const PersonParams = Params.extend({ personId: z.string().min(1).max(64) });
// Up to 64 characters, or "crowd4test:" and a Crowd4Test id for someone new here.
const AddBody = z.object({ personId: z.string().min(1).max(80), projectAdmin: z.boolean().optional() }).strict();
const PatchBody = z.object({ projectAdmin: z.boolean() }).strict();
const CandidatesQuery = z.object({ q: z.string().max(120).optional() });
const CANDIDATES_MAX = 50;

/** Why this person cannot join this project, or undefined when they can. */
export function cannotJoin(candidate: Pick<Candidate, "kind" | "organizationId">, projectOrganization: string | null): string | undefined {
    if (candidate.kind === "customer" && (!candidate.organizationId || candidate.organizationId !== projectOrganization)) return OTHER_ORGANIZATION;
    return undefined;
}

export function registerMemberRoutes(ctx: RouteCtx, directory?: PeopleDirectory): void {
    const { app, p, project } = ctx;
    const control = accessControlOf(app);
    const { users } = control;
    const store = control.projects.store;
    const known = knownPeople(users, store);
    const service = c4tServiceOf(ctx.p);
    const people = directory ?? (service ? crowd4testPeople(users, service) : known);

    const audit = (actor: Actor, projectId: string, action: string, person: Person, detail?: string) =>
        users.addActivity({
            actorKind: actor.kind,
            actorId: actor.id ?? null,
            actorName: actor.name,
            action,
            projectId,
            path: `/api/projects/${projectId}/members`,
            status: 200,
            detail: [`${person.name || person.email} (${person.email})`, detail].filter(Boolean).join(". "),
        });

    const asCandidate = (person: Person): Candidate => {
        const c4t = store.crowd4TestAccountOf(person.id);
        return { personId: person.id, name: person.name || person.email, email: person.email, kind: kindOfC4tRole(c4t?.c4tRole ?? null), organizationId: c4t?.organizationId ?? null, newHere: false };
    };

    const memberOrThrow = (projectId: string, personId: string): Member => {
        const m = store.member(projectId, personId);
        if (!m) throw new HttpError(404, "This person is not on the project.");
        return m;
    };

    app.get("/api/projects/:id/members", async (req) => {
        const { id } = Params.parse(req.params);
        project(id);
        return { members: store.members(id), organizationId: store.projectOrganization(id) };
    });

    app.get("/api/projects/:id/members/candidates", async (req) => {
        const { id } = Params.parse(req.params);
        project(id);
        const { q } = CandidatesQuery.parse(req.query ?? {});
        const org = store.projectOrganization(id);
        const on = new Set(store.members(id).map((m) => m.personId));
        // Asked for more than shown: the rules below drop some.
        let source = people.source;
        let notice: string | undefined;
        let all: Candidate[];
        try {
            all = await people.search(q ?? "", CANDIDATES_MAX * 4, clientIpOf(req));
        } catch (e) {
            if (!(e instanceof HttpError) || e.status !== 503 || people === known) throw e;
            // Crowd4Test is down: the people known here, said plainly.
            all = await known.search(q ?? "", CANDIDATES_MAX * 4);
            source = known.source;
            notice = C4T_SEARCH_NOTICE;
        }
        let found = all.filter((c) => !on.has(c.personId) && !cannotJoin(c, org));
        // A customer does not browse Crowd4Test's people: they find the people already on their organisation's projects, or someone by their exact email.
        const actor = actorOf(req);
        if (actor && sideOf(actor) === "customer") {
            const exact = normEmail(q ?? "");
            const ours = new Set(users.db.all<{ user_id: string }>("SELECT DISTINCT up.user_id FROM user_projects up JOIN projects p ON p.id = up.project_id WHERE p.organization_id = ?", actor.organizationId ?? "").map((r) => r.user_id));
            found = found.filter((c) => ours.has(c.personId) || (exact !== "" && normEmail(c.email) === exact));
        }
        return { people: found.slice(0, CANDIDATES_MAX), source, ...(notice ? { notice } : {}) };
    });

    app.post("/api/projects/:id/members", async (req, reply) => {
        const { id } = Params.parse(req.params);
        project(id);
        const body = AddBody.parse(req.body ?? {});
        const actor = actorOf(req) ?? currentActor();
        let person: Person | undefined;
        if (body.personId.startsWith(C4T_CANDIDATE_PREFIX)) {
            // Someone new here, from Crowd4Test's search: asked about again, checked, and only then given a person here.
            const c4tId = body.personId.slice(C4T_CANDIDATE_PREFIX.length);
            const found = service && c4tId ? await service.personAgain(c4tId, clientIpOf(req)) : undefined;
            if (!found) throw new HttpError(404, NOT_ON_C4T);
            const refusedHere = cannotJoin({ kind: kindOfC4tRole(found.kind), organizationId: found.kind === "CUSTOMER" ? found.organisationId : null }, store.projectOrganization(id));
            if (refusedHere) throw new HttpError(403, refusedHere);
            const made = personFromCrowd4Test(users, store, found);
            if ("refused" in made) throw new HttpError(409, made.refused);
            person = made;
        } else person = users.get(body.personId);
        if (!person || person.status !== "active") throw new HttpError(404, "Person not found");
        const refused = cannotJoin(asCandidate(person), store.projectOrganization(id));
        if (refused) throw new HttpError(403, refused);
        const added = store.addMember(id, person.id, { role: person.role, projectAdmin: body.projectAdmin === true, source: "added", addedBy: actorLabel(actor) });
        if (!added) throw new HttpError(409, "This person is already on the project.");
        audit(actor, id, "added to project", person, body.projectAdmin ? "As Project Admin" : undefined);
        return reply.code(201).send({ member: store.member(id, person.id) });
    });

    app.patch("/api/projects/:id/members/:personId", async (req) => {
        const { id, personId } = PersonParams.parse(req.params);
        project(id);
        const body = PatchBody.parse(req.body ?? {});
        const actor = actorOf(req) ?? currentActor();
        const changed = p.db.tx(() => {
            const m = memberOrThrow(id, personId);
            if (m.projectAdmin === body.projectAdmin) return false;
            if (!body.projectAdmin && store.projectAdminCount(id) <= 1) throw new HttpError(409, LAST_PROJECT_ADMIN);
            store.setProjectAdmin(id, personId, body.projectAdmin);
            return true;
        });
        const person = users.get(personId);
        if (changed && person) audit(actor, id, body.projectAdmin ? "made Project Admin" : "no longer Project Admin", person);
        return { member: store.member(id, personId) };
    });

    app.delete("/api/projects/:id/members/:personId", async (req) => {
        const { id, personId } = PersonParams.parse(req.params);
        project(id);
        const actor = actorOf(req) ?? currentActor();
        p.db.tx(() => {
            const m = memberOrThrow(id, personId);
            if (m.projectAdmin && store.projectAdminCount(id) <= 1) throw new HttpError(409, LAST_PROJECT_ADMIN);
            store.removeMember(id, personId);
        });
        const person = users.get(personId);
        if (person) audit(actor, id, "removed from project", person);
        return { removed: true };
    });
}
