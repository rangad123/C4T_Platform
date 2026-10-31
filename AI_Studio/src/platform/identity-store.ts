/**
 * Named test accounts ("roles") per project: user, admin, ... Each has a username, password and optionally an
 * authenticator secret. Everything secret is encrypted at rest with the platform's SecretBox (the whole list as one blob)
 * and is never returned by the API: callers only learn the name, the username and whether a password / secret is saved.
 */
import type { Db } from "./db.js";
import type { SecretBox } from "./secrets.js";

/** Migration slot 8. */
export const IDENTITY_MIGRATION = `
CREATE TABLE project_roles (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    roles_enc TEXT NOT NULL,          -- SecretBox-encrypted JSON array of roles; never returned by the API
    updated_at TEXT NOT NULL
);
`;

export interface Role {
    name: string;
    username: string;
    password: string;
    /** Authenticator-app secret (base32), when the account has two-step sign-in. */
    totpSecret?: string;
    /** Bearer token for this account's API calls (access-control checks of API endpoints). */
    apiToken?: string;
}

/** What the API may show. */
export interface PublicRole {
    name: string;
    username: string;
    hasPassword: boolean;
    hasTotp: boolean;
    hasApiToken: boolean;
}

export const MAX_ROLES = 6;
/** Role names become part of environment variable names: TEST_<NAME>_PASSWORD. */
export const ROLE_NAME = /^[a-z][a-z0-9_-]{0,23}$/;

export const toPublic = (r: Role): PublicRole => ({ name: r.name, username: r.username, hasPassword: Boolean(r.password), hasTotp: Boolean(r.totpSecret), hasApiToken: Boolean(r.apiToken) });

export class IdentityStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    get(projectId: string): Role[] {
        const row = this.db.get<{ roles_enc: string }>("SELECT roles_enc FROM project_roles WHERE project_id = ?", projectId);
        return row ? this.secrets.decrypt<Role[]>(row.roles_enc) : [];
    }

    set(projectId: string, roles: Role[]): void {
        if (roles.length === 0) {
            this.db.run("DELETE FROM project_roles WHERE project_id = ?", projectId);
            return;
        }
        const enc = this.secrets.encrypt(roles);
        this.db.run(
            "INSERT INTO project_roles (project_id, roles_enc, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET roles_enc = excluded.roles_enc, updated_at = excluded.updated_at",
            projectId,
            enc,
            new Date().toISOString(),
        );
    }
}
