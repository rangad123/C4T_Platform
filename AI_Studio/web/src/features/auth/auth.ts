import { createContext, useContext } from "react";
import { api } from "../../api";

export type Role = "owner" | "editor" | "viewer";
export const ROLE_WORDS: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };
export const ROLE_HELP: Record<Role, string> = {
    owner: "Everything, including people, runner tokens, alert and tracker connections, storage and backups.",
    editor: "Create, change and run tests and projects.",
    viewer: "Look at everything and download reports. Cannot change anything.",
};

export interface Me {
    kind: "user" | "key" | "open" | "runner" | "schedule" | "trigger" | "system";
    name: string;
    role: Role;
    id?: string;
    email?: string | null;
    via?: "session" | "token" | "crowd4test";
    /** The AI Studio features this person may use (features/auth/permissions.ts). Absent from older servers. */
    permissions?: string[];
    /** Which side of AI Studio the person is on: admin, customer or tester (Crowd4Test accounts), or local. */
    side?: "admin" | "customer" | "tester" | "local";
    /** The Crowd4Test organisation of a customer; null for staff, testers and local accounts. */
    organizationId?: string | null;
}

export interface AuthState {
    mode: "open" | "protected";
    accessKeyConfigured: boolean;
    hasPeople: boolean;
    sso: { enabled: boolean; label: string } | null;
    me: Me | null;
    /** "only": the signed-in person sees some projects only (per-project access); platform-wide settings are then hidden. */
    projectAccess?: "all" | "only";
    /** Set when people sign in on crowd4test.com instead of here (the server's C4T_API_ORIGIN). */
    crowd4test?: {
        status: "user" | "none" | "expired" | "refused" | "unreachable";
        message?: string;
        signInUrl: string;
        refreshUrl: string;
        portalUrl: string;
    } | null;
}

/** Which projects a person may see (GET /api/users, PUT /api/users/:userId/projects). */
export interface ProjectAccessView {
    mode: "all" | "only";
    projects?: Array<{ projectId: string; name: string; role: Role; effectiveRole: Role }>;
}

export interface Person {
    id: string;
    email: string;
    name: string;
    role: Role;
    status: "active" | "disabled";
    hasPassword: boolean;
    sso: boolean;
    invitePending: boolean;
    createdAt: string;
    lastSignInAt: string | null;
    access?: ProjectAccessView;
}

export interface TokenInfo {
    id: string;
    name: string;
    hint: string;
    role: Role;
    createdAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
}

export interface ActivityRow {
    id: number;
    at: string;
    actor: { kind: Me["kind"]; id: string | null; name: string };
    action: string;
    path: string | null;
    projectId: string | null;
    status: number | null;
    detail: string | null;
}

export const getAuthState = () => api<AuthState>("/auth/state");
export const signOut = () => api("/auth/sign-out", { method: "POST" });

/** What the rest of the app knows about who is using it (null until the gate has checked). */
export const AuthContext = createContext<{ state: AuthState | null; refresh: () => void }>({ state: null, refresh: () => undefined });
export const useAuth = () => useContext(AuthContext);

const VERB: Record<string, string> = { POST: "Added", PUT: "Changed", PATCH: "Changed", DELETE: "Removed" };
/** Routes whose last word is an action rather than a thing. */
const ACTIONS: Record<string, string> = {
    run: "Started a run",
    runs: "Started a run",
    validate: "Ran a test",
    validation: "Ran tests",
    variants: "Ran on other browsers",
    "test-generation": "Started an exploration",
    cancel: "Stopped a run",
    stop: "Stopped",
    save: "Saved",
    restore: "Restored",
    "restore-generated": "Went back to the generated version",
    "take-over": "Switched a test to code",
    apply: "Applied a repair",
    dismiss: "Dismissed a repair",
    signoff: "Signed off a release",
    reopen: "Reopened a release",
    refresh: "Refreshed",
    check: "Checked",
    test: "Sent a test message",
    retry: "Retried",
    "reset-link": "Made a reset link",
    "sign-out": "Signed someone out",
    "sign-out-everywhere": "Signed out everywhere",
    baseline: "Accepted a new screenshot",
    import: "Imported",
    issue: "Created an issue",
    share: "Made a shared element",
    extract: "Made shared elements",
    create: "Created tests from a plan",
};

/** "projects" → "a project", "test-data" → "test data". */
const thing = (word: string) => {
    const w = word.replace(/-/g, " ");
    return /[^s]s$/.test(w) ? `a ${w.slice(0, -1)}` : w;
};

/** One activity row as a sentence-case phrase: "Added a project", "Changed a helper", "Signed in". */
export function describeActivity(a: ActivityRow): string {
    const plain: Record<string, string> = {
        "sign-in": "Signed in",
        "sign-in failed": "Sign-in failed",
        "sign-out": "Signed out",
        "first owner created": "Created the first owner",
        "joined from an invite link": "Joined from an invite link",
        "password set from a reset link": "Set a new password from a reset link",
        "joined with single sign-on": "Joined with single sign-on",
    };
    if (plain[a.action]) return plain[a.action]!;
    // Security assessment events carry their own plain sentence as the detail (src/security/audit.ts): name the area here.
    if (a.action.startsWith("security:")) return "Security assessment";
    const [method = "", route = ""] = a.action.split(" ");
    // The last word of the route that is not an id says what was touched: /api/projects/:id/helpers/:name → "helpers".
    const last = route.replace(/^\/api\//, "").split("/").filter((s) => s && !s.startsWith(":")).pop() ?? "";
    if (method === "POST" && ACTIONS[last]) return ACTIONS[last]!;
    return `${VERB[method] ?? "Changed"} ${last ? thing(last) : "something"}`;
}
