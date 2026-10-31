import { useAuth, type Me, type Role } from "./auth";

/**
 * The AI Studio features a person may use (docs/product-restructure/ACCESS_MODEL.md). A Crowd4Test administrator grants them;
 * the server sends the person's set in `me.permissions` and enforces every one on every request. The page uses them only to
 * decide what to show: hiding an entry is a convenience, never the boundary.
 */
export const PERMISSION_WORDS = {
    "ai_studio.access": "Open AI Studio",
    "ai_studio.project.create": "Create projects",
    "ai_studio.project.settings": "Change project settings",
    "ai_studio.project.members": "Manage project members",
    "ai_studio.tests.write": "Write tests",
    "ai_studio.tests.generate": "Generate tests with AI",
    "ai_studio.tests.approve": "Approve tests (as Project Admin)",
    "ai_studio.tests.run": "Run tests",
    "ai_studio.agent.run": "Start agent runs",
    "ai_studio.reports.export": "Download reports and evidence",
    "ai_studio.tests.delete": "Delete",
    "ai_studio.runners.manage": "Manage runners",
    "ai_studio.ai_keys.manage": "Manage AI keys",
    "ai_studio.usage.view": "See AI usage and cost",
    "ai_studio.security.use": "Use Security Assessment",
    "ai_studio.platform.settings": "Change platform settings",
} as const;
export type Permission = keyof typeof PERMISSION_WORDS;
export const ALL_PERMISSIONS = Object.keys(PERMISSION_WORDS) as Permission[];

/** Which side of AI Studio a person is on (decision D-13). `local`: an account of this platform itself, the access key, open mode. */
export type Side = "admin" | "customer" | "tester" | "local";
export const SIDE_WORDS: Record<Side, string> = { admin: "Admin", customer: "Customer", tester: "Tester", local: "" };

/**
 * Before the server sends `me.permissions` (an older server, or a local account), the page derives the set from the platform role,
 * mirroring what that role could already do: owners everything, editors make and run tests, viewers look and download.
 */
const BY_ROLE: Record<Role, readonly Permission[]> = {
    owner: ALL_PERMISSIONS,
    editor: ["ai_studio.access", "ai_studio.project.create", "ai_studio.project.settings", "ai_studio.tests.write", "ai_studio.tests.generate", "ai_studio.tests.run", "ai_studio.agent.run", "ai_studio.reports.export", "ai_studio.tests.delete", "ai_studio.usage.view", "ai_studio.security.use"],
    viewer: ["ai_studio.access", "ai_studio.reports.export", "ai_studio.usage.view"],
};

export function permissionsOf(me: Me | null | undefined): ReadonlySet<string> {
    if (!me) return new Set();
    if (Array.isArray(me.permissions)) return new Set(me.permissions);
    return new Set(BY_ROLE[me.role] ?? []);
}

export function sideOf(me: Me | null | undefined): Side {
    return me?.side ?? "local";
}

/** `can("ai_studio.runners.manage")`: whether to show what needs that feature. */
export function useCan(): (p: Permission) => boolean {
    const { state } = useAuth();
    const set = permissionsOf(state?.me);
    return (p) => set.has(p);
}
