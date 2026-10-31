/**
 * People and access (migration slot 26): accounts with a role, sign-in sessions, personal API tokens, invite and reset links,
 * the Activity list, and the single-sign-on settings. Everything secret is stored as a SHA-256 hash (session ids, tokens, invite
 * links) or encrypted with SecretBox (the SSO client secret); nothing secret is ever returned by a method that feeds an API answer.
 *
 * The `users` table exists since migration 1 with one built-in row ("Default user", admin@localhost) that owns every project.
 * That row is not a person: a person is a row with a role. So the built-in row keeps owning projects and never signs in.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Db, Row } from "./db.js";
import type { SecretBox } from "./secrets.js";
import { sqliteDialect } from "./sql-dialect.js";
import type { ActorKind, Role } from "./auth/actor.js";

export const USERS_MIGRATION = `
ALTER TABLE users ADD COLUMN role TEXT;                 -- owner | editor | viewer; NULL = the built-in project-owner row, not a person
ALTER TABLE users ADD COLUMN password_hash TEXT;        -- scrypt (auth/password.ts); NULL until the person sets one (invite) or for SSO-only people
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | disabled
ALTER TABLE users ADD COLUMN sso_subject TEXT;         -- issuer + subject of the person's single-sign-on identity, once used
ALTER TABLE users ADD COLUMN last_sign_in_at TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT;
CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,                                -- SHA-256 of the cookie value; the value itself is never stored
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,                                 -- the token state-changing requests must echo in x-csrf-token
    via TEXT NOT NULL,                                  -- password | sso | invite | setup
    created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    user_agent TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE TABLE user_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL,
    role TEXT NOT NULL,                                 -- at most the person's role; the lower of the two counts at use
    created_at TEXT NOT NULL, expires_at TEXT, last_used_at TEXT
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);
CREATE TABLE user_invites (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,                              -- invite | reset
    created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at TEXT
);
CREATE INDEX idx_user_invites_user ON user_invites(user_id);
CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
    actor_kind TEXT NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
    action TEXT NOT NULL,                               -- "POST /api/projects/:id/tests" style, or an auth event such as "sign-in"
    path TEXT, project_id TEXT, status INTEGER, detail TEXT
);
CREATE INDEX idx_activity_project ON activity(project_id, id);
CREATE INDEX idx_activity_actor ON activity(actor_id, id);
CREATE TABLE auth_settings (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL, secret_enc TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE oidc_pending (
    state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL
);
`;

/** Audit tables written before accounts existed: each gains an `actor` column (who did it). See `addActorColumns`. */
const ACTOR_TABLES = ["custom_audit", "release_audit", "live_session_audit"] as const;

/**
 * Adds the `actor` column to the older audit tables when missing. Not part of the slot-26 SQL on purpose: a database that skipped
 * one of those slots gets its table back only in `repairSkippedMigrations`, after the numbered migrations ran (db.ts), so an
 * ALTER in slot 26 would fail there. Idempotent; called by db.ts after the repair.
 */
export function addActorColumns(db: DatabaseSync): void {
    for (const table of ACTOR_TABLES) {
        if (!sqliteDialect.tableExists(db, table)) continue;
        if (!sqliteDialect.columnExists(db, table, "actor")) db.exec(`ALTER TABLE ${table} ADD COLUMN actor TEXT`);
    }
}

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
/** A person's own API tokens: a token is shown once, then only its last four characters. */
export const TOKEN_PREFIX = "aitpu_";
export const MAX_TOKENS_PER_USER = 20;
export const MAX_SESSIONS_PER_USER = 50;
/** How a person linked to a Crowd4Test account is marked in `sso_subject` (auth/crowd4test.ts). */
export const C4T_SUBJECT_PREFIX = "crowd4test:";
export const MAX_PEOPLE = 500;
/** The Activity list keeps the newest rows only: at most this many, none older than ACTIVITY_KEEP_DAYS. */
export const ACTIVITY_KEEP_ROWS = 20_000;
export const ACTIVITY_KEEP_DAYS = 180;

export interface Person {
    id: string;
    email: string;
    name: string;
    role: Role;
    status: "active" | "disabled";
    hasPassword: boolean;
    sso: boolean;
    /** Linked to a Crowd4Test account: they sign in on crowd4test.com and nowhere else, so that a suspension there holds here too. */
    crowd4testLinked: boolean;
    createdAt: string;
    lastSignInAt: string | null;
    /** An invite link was made and not used yet (the person has not set a password). */
    invitePending: boolean;
}

export interface SessionRow {
    id: string;
    userId: string;
    csrf: string;
    via: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
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
    actor: { kind: ActorKind; id: string | null; name: string };
    action: string;
    path: string | null;
    projectId: string | null;
    status: number | null;
    detail: string | null;
}

export interface SsoSettings {
    issuer: string;
    clientId: string;
    /** Only people with an email at this domain can sign in with single sign-on (required). */
    allowedDomain: string;
    /** Role given to a person who signs in with single sign-on for the first time (never owner). */
    defaultRole: "viewer" | "editor";
    /** Text of the sign-in button, for example "Sign in with Okta". */
    label: string;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = () => new Date().toISOString();
export const normEmail = (e: string) => e.trim().toLowerCase();

const toPerson = (r: Row, pending: Set<string>): Person => ({
    id: r.id,
    email: r.email,
    name: r.name ?? "",
    role: r.role,
    status: r.status === "disabled" ? "disabled" : "active",
    hasPassword: Boolean(r.password_hash),
    sso: Boolean(r.sso_subject),
    crowd4testLinked: String(r.sso_subject ?? "").startsWith(C4T_SUBJECT_PREFIX),
    createdAt: r.created_at,
    lastSignInAt: r.last_sign_in_at ?? null,
    invitePending: pending.has(r.id),
});

export class UserStore {
    private inserts = 0;

    constructor(
        readonly db: Db,
        private readonly secrets?: SecretBox,
    ) {}

    // ── people ──────────────────────────────────────────────────────────────
    peopleCount(): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role IS NOT NULL")?.n ?? 0);
    }

    activeOwners(): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")?.n ?? 0);
    }

    private pendingInvites(): Set<string> {
        return new Set(this.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM user_invites WHERE purpose = 'invite' AND used_at IS NULL AND expires_at > ?", Date.now()).map((r) => r.user_id));
    }

    list(): Person[] {
        const pending = this.pendingInvites();
        return this.db.all("SELECT * FROM users WHERE role IS NOT NULL ORDER BY created_at, email").map((r) => toPerson(r, pending));
    }

    get(id: string): (Person & { passwordHash: string | null }) | undefined {
        const r = this.db.get("SELECT * FROM users WHERE id = ? AND role IS NOT NULL", id);
        return r ? { ...toPerson(r, this.pendingInvites()), passwordHash: r.password_hash ?? null } : undefined;
    }

    byEmail(email: string): (Person & { passwordHash: string | null }) | undefined {
        const r = this.db.get("SELECT * FROM users WHERE email = ? AND role IS NOT NULL", normEmail(email));
        return r ? { ...toPerson(r, this.pendingInvites()), passwordHash: r.password_hash ?? null } : undefined;
    }

    /** True when the address belongs to a row that is not a person (the built-in project owner): it cannot be used for a person. */
    emailTakenByBuiltIn(email: string): boolean {
        return Boolean(this.db.get("SELECT 1 AS x FROM users WHERE email = ? AND role IS NULL", normEmail(email)));
    }

    create(input: { email: string; name: string; role: Role; passwordHash?: string; ssoSubject?: string }): Person {
        const id = randomUUID();
        const t = nowIso();
        this.db.run(
            "INSERT INTO users (id, email, name, created_at, role, password_hash, status, sso_subject, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
            id,
            normEmail(input.email),
            input.name.trim(),
            t,
            input.role,
            input.passwordHash ?? null,
            "active",
            input.ssoSubject ?? null,
            t,
        );
        return this.get(id)!;
    }

    update(id: string, patch: { name?: string; role?: Role; status?: "active" | "disabled" }): void {
        const sets: string[] = [];
        const vals: Array<string> = [];
        if (patch.name !== undefined) (sets.push("name = ?"), vals.push(patch.name.trim()));
        if (patch.role !== undefined) (sets.push("role = ?"), vals.push(patch.role));
        if (patch.status !== undefined) (sets.push("status = ?"), vals.push(patch.status));
        if (!sets.length) return;
        this.db.run(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ? AND role IS NOT NULL`, ...vals, nowIso(), id);
        // A token never carries more than its person's role (checked at use too); a disabled person's ways in are closed at once.
        if (patch.status === "disabled") this.endAllSessions(id);
    }

    setPassword(id: string, passwordHash: string): void {
        this.db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", passwordHash, nowIso(), id);
    }

    setSsoSubject(id: string, subject: string): void {
        this.db.run("UPDATE users SET sso_subject = ?, updated_at = ? WHERE id = ?", subject, nowIso(), id);
    }

    markSignedIn(id: string): void {
        this.db.run("UPDATE users SET last_sign_in_at = ? WHERE id = ?", nowIso(), id);
    }

    /** Removes a person. Projects never belong to a person (they belong to the built-in row), but stay safe if one ever did. */
    remove(id: string): void {
        this.db.tx(() => {
            const builtIn = this.db.get<{ id: string }>("SELECT id FROM users WHERE role IS NULL ORDER BY created_at LIMIT 1");
            if (builtIn) this.db.run("UPDATE projects SET owner_id = ? WHERE owner_id = ?", builtIn.id, id);
            this.db.run("DELETE FROM users WHERE id = ? AND role IS NOT NULL", id);
        });
    }

    // ── sessions ────────────────────────────────────────────────────────────
    /** A new session; the returned token goes into the cookie and is never stored. */
    createSession(userId: string, via: string, userAgent?: string): { token: string; session: SessionRow } {
        const token = randomBytes(32).toString("base64url");
        const csrf = randomBytes(24).toString("base64url");
        const t = Date.now();
        const id = sha256(token);
        this.db.run(
            "INSERT INTO user_sessions (id, user_id, csrf, via, created_at, last_seen_at, expires_at, user_agent) VALUES (?,?,?,?,?,?,?,?)",
            id,
            userId,
            csrf,
            via,
            t,
            t,
            t + SESSION_ABSOLUTE_MS,
            userAgent?.slice(0, 200) ?? null,
        );
        // Keep the newest sessions of a person only (a script signing in in a loop cannot grow the table without limit).
        this.db.run("DELETE FROM user_sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM user_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)", userId, userId, MAX_SESSIONS_PER_USER);
        return { token, session: { id, userId, csrf, via, createdAt: t, lastSeenAt: t, expiresAt: t + SESSION_ABSOLUTE_MS } };
    }

    /** The live session for a cookie value, or undefined (unknown, idle for 12 hours, or past its 7 days). Touches it at most once a minute. */
    sessionFor(token: string, now = Date.now()): SessionRow | undefined {
        if (!token || token.length > 200) return undefined;
        const id = sha256(token);
        const r = this.db.get("SELECT * FROM user_sessions WHERE id = ?", id);
        if (!r) return undefined;
        if (r.expires_at <= now || r.last_seen_at + SESSION_IDLE_MS <= now) {
            this.db.run("DELETE FROM user_sessions WHERE id = ?", id);
            return undefined;
        }
        if (now - r.last_seen_at > 60_000) this.db.run("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", now, id);
        return { id, userId: r.user_id, csrf: r.csrf, via: r.via, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at };
    }

    endSession(id: string): void {
        this.db.run("DELETE FROM user_sessions WHERE id = ?", id);
    }

    endAllSessions(userId: string, exceptId?: string): number {
        return Number(this.db.run("DELETE FROM user_sessions WHERE user_id = ? AND id != ?", userId, exceptId ?? "").changes);
    }

    sessionCount(userId: string): number {
        return Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_sessions WHERE user_id = ? AND expires_at > ?", userId, Date.now())?.n ?? 0);
    }

    // ── personal API tokens ─────────────────────────────────────────────────
    createToken(userId: string, input: { name: string; role: Role; expiresInDays?: number }): { token: string; info: TokenInfo } {
        const count = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM user_tokens WHERE user_id = ?", userId)?.n ?? 0);
        if (count >= MAX_TOKENS_PER_USER) throw new Error(`You can have at most ${MAX_TOKENS_PER_USER} API tokens. Remove one you no longer use first.`);
        const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
        const id = randomUUID();
        const t = nowIso();
        const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString() : null;
        this.db.run(
            "INSERT INTO user_tokens (id, user_id, name, token_hash, hint, role, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)",
            id,
            userId,
            input.name.trim(),
            sha256(token),
            token.slice(-4),
            input.role,
            t,
            expires,
        );
        return { token, info: this.tokens(userId).find((x) => x.id === id)! };
    }

    tokens(userId: string): TokenInfo[] {
        return this.db
            .all("SELECT * FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC", userId)
            .map((r) => ({ id: r.id, name: r.name, hint: r.hint, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at ?? null, lastUsedAt: r.last_used_at ?? null }));
    }

    /** The person and the token's role for a token value, or undefined (unknown or expired). Records when it was last used (once a minute). */
    tokenFor(token: string): { userId: string; tokenId: string; role: Role } | undefined {
        if (!token.startsWith(TOKEN_PREFIX) || token.length > 200) return undefined;
        const r = this.db.get("SELECT * FROM user_tokens WHERE token_hash = ?", sha256(token));
        if (!r) return undefined;
        if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) return undefined;
        if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > 60_000) this.db.run("UPDATE user_tokens SET last_used_at = ? WHERE id = ?", nowIso(), r.id);
        return { userId: r.user_id, tokenId: r.id, role: r.role };
    }

    removeToken(userId: string, tokenId: string): boolean {
        return Number(this.db.run("DELETE FROM user_tokens WHERE id = ? AND user_id = ?", tokenId, userId).changes) > 0;
    }

    // ── invite and reset links ──────────────────────────────────────────────
    /** A one-time link token for setting a password. Earlier unused links of the person stop working. */
    createInvite(userId: string, purpose: "invite" | "reset"): { token: string; expiresAt: string } {
        const token = randomBytes(32).toString("base64url");
        const ttl = purpose === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
        this.db.tx(() => {
            this.db.run("DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL", userId);
            this.db.run("INSERT INTO user_invites (token_hash, user_id, purpose, created_at, expires_at) VALUES (?,?,?,?,?)", sha256(token), userId, purpose, nowIso(), Date.now() + ttl);
        });
        return { token, expiresAt: new Date(Date.now() + ttl).toISOString() };
    }

    inviteFor(token: string): { userId: string; purpose: "invite" | "reset" } | undefined {
        if (!token || token.length > 200) return undefined;
        const r = this.db.get("SELECT * FROM user_invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?", sha256(token), Date.now());
        return r ? { userId: r.user_id, purpose: r.purpose } : undefined;
    }

    useInvite(token: string): void {
        this.db.run("UPDATE user_invites SET used_at = ? WHERE token_hash = ?", nowIso(), sha256(token));
    }

    // ── activity ────────────────────────────────────────────────────────────
    addActivity(a: { actorKind: ActorKind; actorId?: string | null; actorName: string; action: string; path?: string | null; projectId?: string | null; status?: number | null; detail?: string | null }): void {
        this.db.run(
            "INSERT INTO activity (at, actor_kind, actor_id, actor_name, action, path, project_id, status, detail) VALUES (?,?,?,?,?,?,?,?,?)",
            nowIso(),
            a.actorKind,
            a.actorId ?? null,
            a.actorName.slice(0, 200),
            a.action.slice(0, 200),
            a.path?.slice(0, 300) ?? null,
            a.projectId ?? null,
            a.status ?? null,
            a.detail?.slice(0, 500) ?? null,
        );
        // Prune now and then, not on every write.
        if (++this.inserts % 200 === 1) this.pruneActivity();
    }

    pruneActivity(keepRows = ACTIVITY_KEEP_ROWS, keepDays = ACTIVITY_KEEP_DAYS): void {
        this.db.run("DELETE FROM activity WHERE at < ?", new Date(Date.now() - keepDays * 86_400_000).toISOString());
        this.db.run("DELETE FROM activity WHERE id <= COALESCE((SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET ?), 0)", keepRows);
    }

    activity(f: { actorId?: string; actorKind?: ActorKind; projectId?: string; action?: string; since?: string; until?: string; before?: number; limit?: number } = {}): ActivityRow[] {
        const where: string[] = [];
        const vals: Array<string | number> = [];
        if (f.actorId) (where.push("actor_id = ?"), vals.push(f.actorId));
        if (f.actorKind) (where.push("actor_kind = ?"), vals.push(f.actorKind));
        if (f.projectId) (where.push("project_id = ?"), vals.push(f.projectId));
        // A plain "contains" filter on the action or the address; LIKE wildcards in the input are escaped.
        if (f.action) (where.push(`(${this.db.dialect.likeInsensitive("action")} ESCAPE '\\' OR ${this.db.dialect.likeInsensitive("path")} ESCAPE '\\')`), vals.push(`%${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, `%${f.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
        if (f.since) (where.push("at >= ?"), vals.push(f.since));
        if (f.until) (where.push("at <= ?"), vals.push(f.until));
        if (f.before) (where.push("id < ?"), vals.push(f.before));
        const limit = Math.max(1, Math.min(200, f.limit ?? 50));
        return this.db
            .all(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...vals, limit)
            .map((r) => ({ id: r.id, at: r.at, actor: { kind: r.actor_kind, id: r.actor_id ?? null, name: r.actor_name }, action: r.action, path: r.path ?? null, projectId: r.project_id ?? null, status: r.status ?? null, detail: r.detail ?? null }));
    }

    // ── single sign-on settings ─────────────────────────────────────────────
    ssoSettings(): (SsoSettings & { hasSecret: boolean }) | undefined {
        const r = this.db.get("SELECT * FROM auth_settings WHERE key = 'sso'");
        return r ? { ...(JSON.parse(r.value_json) as SsoSettings), hasSecret: Boolean(r.secret_enc) } : undefined;
    }

    /** The client secret, decrypted: for the token request only, never for an answer. */
    ssoSecret(): string | undefined {
        const r = this.db.get<{ secret_enc: string | null }>("SELECT secret_enc FROM auth_settings WHERE key = 'sso'");
        if (!r?.secret_enc || !this.secrets) return undefined;
        return this.secrets.decrypt<{ secret: string }>(r.secret_enc).secret;
    }

    saveSso(s: SsoSettings, secret?: string): void {
        if (!this.secrets) throw new Error("A SecretBox is needed to store the client secret");
        const cur = this.db.get<{ secret_enc: string | null }>("SELECT secret_enc FROM auth_settings WHERE key = 'sso'");
        const enc = secret ? this.secrets.encrypt({ secret }) : (cur?.secret_enc ?? null);
        this.db.run(
            "INSERT INTO auth_settings (key, value_json, secret_enc, updated_at) VALUES ('sso', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, secret_enc = excluded.secret_enc, updated_at = excluded.updated_at",
            JSON.stringify(s),
            enc,
            nowIso(),
        );
    }

    removeSso(): void {
        this.db.run("DELETE FROM auth_settings WHERE key = 'sso'");
        this.db.run("DELETE FROM oidc_pending");
    }

    // ── single sign-on round trips in flight (10 minutes) ───────────────────
    addPending(p: { state: string; nonce: string; verifier: string; redirectUri: string }): void {
        this.db.run("DELETE FROM oidc_pending WHERE created_at < ?", Date.now() - 10 * 60_000);
        const n = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oidc_pending")?.n ?? 0);
        if (n >= 1000) this.db.run("DELETE FROM oidc_pending WHERE state IN (SELECT state FROM oidc_pending ORDER BY created_at LIMIT 100)");
        this.db.run("INSERT INTO oidc_pending (state, nonce, verifier, redirect_uri, created_at) VALUES (?,?,?,?,?)", p.state, p.nonce, p.verifier, p.redirectUri, Date.now());
    }

    /** One use only: the round trip is removed as it is read. */
    takePending(state: string): { nonce: string; verifier: string; redirectUri: string } | undefined {
        if (!state || state.length > 200) return undefined;
        // One statement, so two callbacks with the same state cannot both read it before either deletes it. An expired one is removed too.
        const r = this.db.get("DELETE FROM oidc_pending WHERE state = ? RETURNING *", state);
        return r && r.created_at > Date.now() - 10 * 60_000 ? { nonce: r.nonce, verifier: r.verifier, redirectUri: r.redirect_uri } : undefined;
    }
}
