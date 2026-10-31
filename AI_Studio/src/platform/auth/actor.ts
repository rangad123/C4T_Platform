/**
 * Who is acting right now. The access hook (auth/access.ts) sets it for each API request; code that is not inside a request
 * (the scheduler, deploy triggers, runner results) can set its own with `runAs`. Audit writes read it with `currentActor()`, so
 * every audit row says who did it without each service having to pass a name through.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { leastRoleFor, PERMISSION_WORDS, ROLE_PERMISSIONS, type Permission } from "./permissions.js";

export type Role = "owner" | "editor" | "viewer";

/**
 * Which side of AI Studio a person is on (D-13): Crowd4Test ADMIN and SUB_ADMIN are "admin", CUSTOMER "customer", TESTER "tester".
 * Everything that is not a Crowd4Test account (people made here, the access key, open access, runners, background work) is "local".
 */
export type Side = "admin" | "customer" | "tester" | "local";

export type ActorKind =
    /** A signed-in person (session cookie) or a person's own API token. */
    | "user"
    /** The shared access key (API_KEY): owner-level, used by scripts, the MCP server and the `ai-test` command. */
    | "key"
    /** No API_KEY and nobody has an account yet: the server is open, as it always was. */
    | "open"
    | "runner"
    | "schedule"
    | "trigger"
    | "system";

export interface Actor {
    kind: ActorKind;
    /** The user id for `user`; the runner/schedule/trigger id when known. */
    id?: string;
    /** What the activity list shows: the person's name or email, or the plain word for the others. */
    name: string;
    role: Role;
    /** For `user`: how the person got in (a session, one of their API tokens, or their crowd4test.com session). */
    via?: "session" | "token" | "crowd4test";
    tokenId?: string;
    sessionId?: string;
    /**
     * The `ai_studio.*` codes this actor holds platform-wide (auth/permissions.ts). Crowd4Test accounts: what Crowd4Test granted,
     * minus the never-lists of their kind. Everyone else: the codes of their role. Left out, the role's codes count (permissionsOf).
     */
    permissions?: ReadonlySet<Permission>;
    side?: Side;
    /** A Crowd4Test customer's organisation (the tenant, D-14); undefined for staff, testers and local accounts. */
    organizationId?: string;
}

const store = new AsyncLocalStorage<Actor>();

export const ACTOR_WORDS: Record<Exclude<ActorKind, "user">, string> = {
    key: "Access key",
    open: "Open access",
    runner: "Runner",
    schedule: "Schedule",
    trigger: "Deploy trigger",
    system: "Platform",
};

export const SYSTEM_ACTOR: Actor = { kind: "system", name: ACTOR_WORDS.system, role: "owner" };

/** The actor of the current request or task; "Platform" when nothing set one (background work). */
export function currentActor(): Actor {
    return store.getStore() ?? SYSTEM_ACTOR;
}

/** The short text audit tables keep in their `actor` column: the person's name and id, or the plain word. */
export function actorLabel(a: Actor = currentActor()): string {
    return a.kind === "user" ? `${a.name} (${a.id})`.slice(0, 200) : a.name;
}

export function runAs<T>(actor: Actor, fn: () => T): T {
    return store.run(actor, fn);
}

/** Used by the access hook: the rest of this request (its handler and everything it awaits) runs as `actor`. */
export function enterActor(actor: Actor): void {
    store.enterWith(actor);
}

/** The codes an actor holds platform-wide: its own set, or its role's when none was given (background work, older callers). */
export const permissionsOf = (a: Actor): ReadonlySet<Permission> => a.permissions ?? ROLE_PERMISSIONS[a.role];
export const sideOf = (a: Actor): Side => a.side ?? "local";
/** A Crowd4Test sign-in: its codes come from Crowd4Test, never from a role here. */
export const isCrowd4TestActor = (a: Actor): boolean => a.kind === "user" && a.via === "crowd4test";

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (have: Role, need: Role) => ROLE_RANK[have] >= ROLE_RANK[need];
export const lowerRole = (a: Role, b: Role): Role => (ROLE_RANK[a] <= ROLE_RANK[b] ? a : b);
export const ROLE_WORDS: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

/**
 * The refusal of a missing permission: in Crowd4Test's words for its accounts, in role words (exactly as before permissions) for
 * everyone else. `here`: the role that counts in a project, for a person limited to some projects.
 */
export function permissionRefusal(actor: Actor, code: Permission, here?: { role: Role }): string {
    if (isCrowd4TestActor(actor)) return `You don't have permission to ${PERMISSION_WORDS[code]}. Ask your Crowd4Test administrator.`;
    const need = ROLE_WORDS[leastRoleFor(code)];
    return here
        ? `This needs the ${need} role in this project, and you have ${ROLE_WORDS[here.role]} there. Ask an owner of this platform if you need it.`
        : `This needs the ${need} role, and you have ${ROLE_WORDS[actor.role]}. Ask an owner of this platform if you need it.`;
}
