/**
 * The AI Studio permission catalogue (docs/product-restructure/ACCESS_MODEL.md). A Crowd4Test admin grants these codes to each
 * person in the Crowd4Test admin panel; `/v1/auth/me` returns them, and every API route needs one of them (auth/roles.ts).
 *
 * The codes are a stable contract shared with C4T_Platform (api/src/config/permissions.ts): add freely, never rename.
 *
 * Accounts that are not Crowd4Test accounts (people made here, the access key, open access, runners) keep their owner, editor or
 * viewer role, and each role stands for a fixed set of codes (ROLE_PERMISSIONS). The sets are chosen so that every route allows
 * and refuses exactly what it did when the route table named roles (tests/permissions-unit.test.ts proves it route by route).
 */
import type { Role } from "./actor.js";

export const PERMISSIONS = [
    "ai_studio.access",
    "ai_studio.project.create",
    "ai_studio.project.settings",
    "ai_studio.project.members",
    "ai_studio.tests.write",
    "ai_studio.tests.generate",
    "ai_studio.tests.approve",
    "ai_studio.tests.run",
    "ai_studio.agent.run",
    "ai_studio.reports.export",
    "ai_studio.tests.delete",
    "ai_studio.runners.manage",
    "ai_studio.ai_keys.manage",
    "ai_studio.usage.view",
    "ai_studio.security.use",
    "ai_studio.platform.settings",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const KNOWN = new Set<string>(PERMISSIONS);
export const isPermission = (code: string): code is Permission => KNOWN.has(code);

/** Never held by a tester, whatever Crowd4Test says (D-26): the C4T API refuses them and this server ignores them too. */
export const NEVER_FOR_TESTER: ReadonlySet<Permission> = new Set<Permission>([
    "ai_studio.project.create",
    "ai_studio.project.members",
    "ai_studio.ai_keys.manage",
    "ai_studio.usage.view",
    "ai_studio.platform.settings",
]);

/** Never held by a customer: platform-wide settings belong to Crowd4Test. */
export const NEVER_FOR_CUSTOMER: ReadonlySet<Permission> = new Set<Permission>(["ai_studio.platform.settings"]);

/** Everything a person may do here, in the words of the refusal ("You don't have permission to …"). */
export const PERMISSION_WORDS: Record<Permission, string> = {
    "ai_studio.access": "open AI Studio",
    "ai_studio.project.create": "create projects",
    "ai_studio.project.settings": "change project settings",
    "ai_studio.project.members": "manage the people on a project",
    "ai_studio.tests.write": "create and edit tests",
    "ai_studio.tests.generate": "use the AI to write tests",
    "ai_studio.tests.approve": "approve tests",
    "ai_studio.tests.run": "run tests",
    "ai_studio.agent.run": "start live AI agent runs",
    "ai_studio.reports.export": "download reports, evidence and test code",
    "ai_studio.tests.delete": "delete tests and runs",
    "ai_studio.runners.manage": "manage runners",
    "ai_studio.ai_keys.manage": "manage keys and connections to other systems",
    "ai_studio.usage.view": "see AI usage and cost",
    "ai_studio.security.use": "use Security Assessment",
    "ai_studio.platform.settings": "change platform settings",
};

export const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set(PERMISSIONS);

const VIEWER: Permission[] = ["ai_studio.access", "ai_studio.reports.export", "ai_studio.usage.view"];
const EDITOR: Permission[] = [
    ...VIEWER,
    "ai_studio.project.create",
    "ai_studio.project.settings",
    "ai_studio.tests.write",
    "ai_studio.tests.generate",
    "ai_studio.tests.run",
    "ai_studio.agent.run",
    "ai_studio.tests.delete",
    "ai_studio.security.use",
];

/**
 * What a local role holds. A viewer reads, downloads and sees usage (as before); an editor also changes, runs and deletes tests and
 * project settings; only an owner holds the codes on routes that were owner-only (people, keys and connections to other systems,
 * runner tokens, approvals and platform settings).
 */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
    viewer: new Set(VIEWER),
    editor: new Set(EDITOR),
    owner: ALL_PERMISSIONS,
};

/** The least local role that holds a code: what a refusal names for a local account. */
export function leastRoleFor(code: Permission): Role {
    return ROLE_PERMISSIONS.viewer.has(code) ? "viewer" : ROLE_PERMISSIONS.editor.has(code) ? "editor" : "owner";
}

export type C4tKind = "ADMIN" | "SUB_ADMIN" | "CUSTOMER" | "TESTER";

/**
 * A Crowd4Test account's codes: every code for ADMIN (as on Crowd4Test), else the `ai_studio.*` codes it was granted, minus the
 * codes its kind can never hold. Unknown codes and other groups' codes are dropped.
 */
export function permissionsForC4t(kind: C4tKind, granted: readonly string[]): ReadonlySet<Permission> {
    if (kind === "ADMIN") return ALL_PERMISSIONS;
    const never = kind === "TESTER" ? NEVER_FOR_TESTER : kind === "CUSTOMER" ? NEVER_FOR_CUSTOMER : undefined;
    const out = new Set<Permission>();
    for (const code of granted) if (isPermission(code) && !never?.has(code)) out.add(code);
    return out;
}

export function intersect(a: ReadonlySet<Permission>, b: ReadonlySet<Permission>): ReadonlySet<Permission> {
    return new Set([...a].filter((c) => b.has(c)));
}

/** In catalogue order, for responses. */
export const sortedPermissions = (set: ReadonlySet<Permission>): Permission[] => PERMISSIONS.filter((c) => set.has(c));
