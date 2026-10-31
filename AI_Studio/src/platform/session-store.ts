/**
 * Hard sign-ins, stored: saved signed-in sessions per project and test account, the project's test mailbox, and the mail forwarded to
 * the platform's inbound address. Migration slot 29.
 *
 * Everything that works like a password is encrypted with the platform's SecretBox and never returned: a session's cookies and storage,
 * the mailbox password, the inbound address's token (only its hash is kept for lookups; the address is shown once, when it is made), and
 * the body of every forwarded message (it holds codes and sign-in links).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { SecretBox } from "./secrets.js";
import { describeState, parseStorageState, type StorageState } from "../engine/auth/storage-state.js";
import type { MailMessage } from "../engine/auth/mail.js";

export const SESSIONS_MIGRATION = `
CREATE TABLE saved_sessions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account TEXT NOT NULL,              -- "main" (the project's own sign-in) or a test account's name
    state_enc TEXT NOT NULL,            -- SecretBox: the browser storage state; never returned
    app_url TEXT NOT NULL,              -- the application the session belongs to (its origin decides where it is used)
    check_url TEXT NOT NULL,            -- the signed-in page the "Still signed in?" check opens
    expires_at TEXT,                    -- earliest expiry of the session's cookies, when they say
    saved_at TEXT NOT NULL,
    how TEXT NOT NULL,                  -- "browser" (signed in by hand here) or "file" (a storage state that was uploaded)
    checked_at TEXT,
    check_ok INTEGER,                   -- 1 still signed in, 0 signed out at the last check, NULL never checked
    check_note TEXT,
    PRIMARY KEY (project_id, account)
);
CREATE TABLE test_mailboxes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                 -- "imap" | "inbound"
    config_enc TEXT NOT NULL,           -- SecretBox: IMAP host, port, tls, user, password; never returned
    token_hash TEXT UNIQUE,             -- inbound: sha256 of the address token
    updated_at TEXT NOT NULL
);
CREATE TABLE inbound_mail (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_addrs TEXT NOT NULL,             -- lower-case recipients, comma-separated, for matching
    received_at INTEGER NOT NULL,       -- ms since 1970 (this platform's clock)
    mail_enc TEXT NOT NULL              -- SecretBox: the message (subject, text, html)
);
CREATE INDEX idx_inbound_mail_project ON inbound_mail(project_id, received_at);
`;

export const MAIN_ACCOUNT = "main";
/** Test account names follow identity-store's ROLE_NAME; "main" is the project's own sign-in. */
export const ACCOUNT_NAME = /^(main|[a-z][a-z0-9_-]{0,23})$/;

export interface SavedSessionRow {
    account: string;
    appUrl: string;
    checkUrl: string;
    expiresAt: string | null;
    savedAt: string;
    how: "browser" | "file";
    checkedAt: string | null;
    checkOk: boolean | null;
    checkNote: string | null;
}

/** What the API shows about a session: never a value. */
export interface PublicSession extends SavedSessionRow {
    cookies: number;
    sites: string[];
    /** "ok", "expired" (cookies say so, or the last check found it signed out) or "unknown" (never checked, no expiry known). */
    state: "ok" | "expired" | "unknown";
}

export interface ImapConfig {
    host: string;
    port: number;
    /** true: TLS from the start (port 993). false: plain IMAP, refused unless the host is this computer or a private network. */
    tls: boolean;
    user: string;
    password: string;
    mailbox?: string;
}

export type MailboxConfig = { kind: "imap"; imap: ImapConfig } | { kind: "inbound" };

export interface PublicMailbox {
    kind: "imap" | "inbound";
    imap?: { host: string; port: number; tls: boolean; user: string; mailbox: string; hasPassword: boolean };
    /** Inbound only: messages kept now (the last day, at most MAX_INBOUND_PER_PROJECT). */
    messages?: number;
}

export const MAX_INBOUND_PER_PROJECT = 200;
export const INBOUND_KEEP_MS = 24 * 60 * 60 * 1000;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export class SessionStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
    ) {}

    // ── saved sessions ──────────────────────────────────────────────────────

    saveSession(projectId: string, account: string, s: { state: StorageState; appUrl: string; checkUrl: string; how: "browser" | "file" }): PublicSession {
        const exp = describeState(s.state, s.appUrl).expiresAt ?? null;
        this.db.run(
            `INSERT INTO saved_sessions (project_id, account, state_enc, app_url, check_url, expires_at, saved_at, how, checked_at, check_ok, check_note)
             VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL)
             ON CONFLICT(project_id, account) DO UPDATE SET state_enc = excluded.state_enc, app_url = excluded.app_url, check_url = excluded.check_url,
                expires_at = excluded.expires_at, saved_at = excluded.saved_at, how = excluded.how, checked_at = NULL, check_ok = NULL, check_note = NULL`,
            projectId,
            account,
            this.secrets.encrypt(s.state),
            s.appUrl,
            s.checkUrl,
            exp,
            new Date().toISOString(),
            s.how,
        );
        return this.publicSession(projectId, account)!;
    }

    /** The decrypted session, for a run or a check only. Undefined when none is saved or it cannot be read (a changed key). */
    sessionState(projectId: string, account: string): { state: StorageState; row: SavedSessionRow } | undefined {
        const r = this.db.get<Record<string, unknown>>("SELECT * FROM saved_sessions WHERE project_id = ? AND account = ?", projectId, account);
        if (!r) return undefined;
        try {
            return { state: parseStorageState(this.secrets.decrypt<unknown>(String(r.state_enc))), row: toRow(r) };
        } catch {
            return undefined;
        }
    }

    publicSession(projectId: string, account: string, now = Date.now()): PublicSession | undefined {
        const s = this.sessionState(projectId, account);
        if (!s) return undefined;
        return toPublic(s.row, s.state, now);
    }

    listSessions(projectId: string, now = Date.now()): PublicSession[] {
        const rows = this.db.all<{ account: string }>("SELECT account FROM saved_sessions WHERE project_id = ? ORDER BY account", projectId);
        return rows.map((r) => this.publicSession(projectId, r.account, now)).filter((x): x is PublicSession => Boolean(x));
    }

    recordCheck(projectId: string, account: string, ok: boolean, note: string): void {
        this.db.run("UPDATE saved_sessions SET checked_at = ?, check_ok = ?, check_note = ? WHERE project_id = ? AND account = ?", new Date().toISOString(), ok ? 1 : 0, note.slice(0, 300), projectId, account);
    }

    forgetSession(projectId: string, account: string): boolean {
        return Number(this.db.run("DELETE FROM saved_sessions WHERE project_id = ? AND account = ?", projectId, account).changes) > 0;
    }

    // ── test mailbox ────────────────────────────────────────────────────────

    /** Sets the mailbox. For an inbound address a new token is made and returned once (the address embeds it). */
    setMailbox(projectId: string, cfg: MailboxConfig): { token?: string } {
        const token = cfg.kind === "inbound" ? randomBytes(24).toString("base64url") : undefined;
        this.db.run(
            `INSERT INTO test_mailboxes (project_id, kind, config_enc, token_hash, updated_at) VALUES (?,?,?,?,?)
             ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, config_enc = excluded.config_enc, token_hash = excluded.token_hash, updated_at = excluded.updated_at`,
            projectId,
            cfg.kind,
            this.secrets.encrypt(cfg),
            token ? hashToken(token) : null,
            new Date().toISOString(),
        );
        return token ? { token } : {};
    }

    mailbox(projectId: string): MailboxConfig | undefined {
        const r = this.db.get<{ config_enc: string }>("SELECT config_enc FROM test_mailboxes WHERE project_id = ?", projectId);
        if (!r) return undefined;
        try {
            return this.secrets.decrypt<MailboxConfig>(r.config_enc);
        } catch {
            return undefined;
        }
    }

    publicMailbox(projectId: string): PublicMailbox | undefined {
        const m = this.mailbox(projectId);
        if (!m) return undefined;
        if (m.kind === "imap") return { kind: "imap", imap: { host: m.imap.host, port: m.imap.port, tls: m.imap.tls, user: m.imap.user, mailbox: m.imap.mailbox ?? "INBOX", hasPassword: Boolean(m.imap.password) } };
        this.pruneInbound(projectId);
        const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM inbound_mail WHERE project_id = ?", projectId)?.n ?? 0;
        return { kind: "inbound", messages: n };
    }

    removeMailbox(projectId: string): void {
        this.db.run("DELETE FROM test_mailboxes WHERE project_id = ?", projectId);
        this.db.run("DELETE FROM inbound_mail WHERE project_id = ?", projectId);
    }

    /** The project whose inbound address carries this token (exact hash match), if any. */
    projectForToken(token: string): string | undefined {
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
        return this.db.get<{ project_id: string }>("SELECT project_id FROM test_mailboxes WHERE kind = 'inbound' AND token_hash = ?", hashToken(token))?.project_id;
    }

    // ── forwarded mail ──────────────────────────────────────────────────────

    addInbound(projectId: string, m: MailMessage): string {
        const id = randomUUID();
        this.db.run(
            "INSERT INTO inbound_mail (id, project_id, to_addrs, received_at, mail_enc) VALUES (?,?,?,?,?)",
            id,
            projectId,
            m.to.join(",").slice(0, 2000),
            m.receivedAt,
            this.secrets.encrypt({ from: m.from, subject: m.subject, text: m.text, html: m.html }),
        );
        this.pruneInbound(projectId);
        return id;
    }

    /** The newest forwarded message to `to` received at or after `since` (ms). */
    newestInbound(projectId: string, to: string, since: number): MailMessage | undefined {
        const addr = to.trim().toLowerCase();
        const rows = this.db.all<{ to_addrs: string; received_at: number; mail_enc: string }>(
            "SELECT to_addrs, received_at, mail_enc FROM inbound_mail WHERE project_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT 50",
            projectId,
            since,
        );
        for (const r of rows) {
            const list = r.to_addrs.split(",");
            if (!list.includes(addr)) continue;
            try {
                const body = this.secrets.decrypt<{ from: string; subject: string; text: string; html: string }>(r.mail_enc);
                return { to: list, receivedAt: Number(r.received_at), ...body };
            } catch {
                continue;
            }
        }
        return undefined;
    }

    /** Keeps the last day, and at most MAX_INBOUND_PER_PROJECT messages, per project. */
    pruneInbound(projectId: string, now = Date.now()): void {
        this.db.run("DELETE FROM inbound_mail WHERE project_id = ? AND received_at < ?", projectId, now - INBOUND_KEEP_MS);
        this.db.run(
            "DELETE FROM inbound_mail WHERE project_id = ? AND id NOT IN (SELECT id FROM inbound_mail WHERE project_id = ? ORDER BY received_at DESC LIMIT ?)",
            projectId,
            projectId,
            MAX_INBOUND_PER_PROJECT,
        );
    }
}

function toRow(r: Record<string, unknown>): SavedSessionRow {
    return {
        account: String(r.account),
        appUrl: String(r.app_url),
        checkUrl: String(r.check_url),
        expiresAt: (r.expires_at as string | null) ?? null,
        savedAt: String(r.saved_at),
        how: r.how === "file" ? "file" : "browser",
        checkedAt: (r.checked_at as string | null) ?? null,
        checkOk: r.check_ok === null || r.check_ok === undefined ? null : Number(r.check_ok) === 1,
        checkNote: (r.check_note as string | null) ?? null,
    };
}

function toPublic(row: SavedSessionRow, state: StorageState, now: number): PublicSession {
    const d = describeState(state, row.appUrl);
    const expired = (row.expiresAt !== null && Date.parse(row.expiresAt) <= now) || row.checkOk === false;
    const known = row.expiresAt !== null || row.checkOk !== null;
    return { ...row, cookies: d.cookies, sites: d.sites, state: expired ? "expired" : known ? "ok" : "unknown" };
}
