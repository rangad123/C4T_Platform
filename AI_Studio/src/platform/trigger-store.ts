/**
 * Deploy trigger tokens: a pipeline's credential for "run this project's tests now". The token is shown once when it is made
 * and only its SHA-256 hash is stored (a token is 32 random bytes, so a plain hash is enough: there is nothing to guess).
 * The tables are part of migration slot 12 (see healing-store.ts).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { OPEN_OWNER_ID } from "./agent-store.js";
import type { Db } from "./db.js";
import type { SecretBox } from "./secrets.js";

export const TRIGGERS_SQL = `
CREATE TABLE trigger_tokens (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    label TEXT,
    token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the token; the token itself is never stored
    hint TEXT NOT NULL,                   -- last 4 characters, to tell tokens apart in a list
    allow_url INTEGER NOT NULL DEFAULT 0, -- may the pipeline send a different address for the run?
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    last_run_at INTEGER,                  -- epoch ms of the last accepted run: the per-token rate limit
    revoked_at TEXT
);
CREATE INDEX idx_trigger_tokens_project ON trigger_tokens(project_id);
CREATE TABLE trigger_runs (
    job_id TEXT PRIMARY KEY REFERENCES generation_jobs(id) ON DELETE CASCADE,
    token_id TEXT NOT NULL REFERENCES trigger_tokens(id) ON DELETE CASCADE,
    commit_sha TEXT,
    environment TEXT,
    callback_enc TEXT,                    -- SecretBox-encrypted callback URL (it may carry a secret); never returned
    callback_state TEXT NOT NULL,         -- none | pending | sending | sent | failed
    callback_detail TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_trigger_runs_token ON trigger_runs(token_id);
`;

export const TOKEN_PREFIX = "aitt_";
/** What a token (or job id) in a URL may look like. Anything else is not a trigger route at all. */
const TOKEN_CHARS = "[A-Za-z0-9_-]{16,128}";
const RUN_ROUTE = new RegExp(`^/api/triggers/${TOKEN_CHARS}/run$`);
const STATUS_ROUTE = new RegExp(`^/api/triggers/${TOKEN_CHARS}/status/[A-Za-z0-9-]{1,64}$`);

/**
 * The ONLY requests that may skip the API key: POST /api/triggers/<token>/run and GET /api/triggers/<token>/status/<job>.
 * `decodedPath` is the path after percent-decoding and without the query, exactly what the router will act on; the match is
 * anchored and exact (no prefix, no case folding, no trailing slash), so path tricks fall through to the key check.
 */
export function isTriggerTokenRoute(method: string, decodedPath: string): boolean {
    return (method === "POST" && RUN_ROUTE.test(decodedPath)) || (method === "GET" && STATUS_ROUTE.test(decodedPath));
}

/** For request logs: the token in a trigger URL is a credential and must never be written down. */
export const redactTriggerUrl = (url: string): string => url.replace(/(\/api\/triggers\/)[^/?#]+/i, "$1[token]");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => TOKEN_PREFIX + randomBytes(32).toString("base64url");

export interface TriggerToken {
    id: string;
    projectId: string;
    label: string | null;
    hint: string;
    allowUrl: boolean;
    createdAt: string;
    lastUsedAt: string | null;
    lastRunAt: number | null;
    revokedAt: string | null;
    /** Who made it (migration 55), whose runner runs its runs; null for a token made before (its runs are refused with a sentence). */
    createdBy: string | null;
}

const toToken = (r: Record<string, any>): TriggerToken => ({
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    hint: r.hint,
    allowUrl: Boolean(r.allow_url),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    lastRunAt: r.last_run_at,
    revokedAt: r.revoked_at,
    createdBy: r.created_by ?? null,
});

export interface TriggerRunRow {
    jobId: string;
    tokenId: string;
    commit: string | null;
    environment: string | null;
    callbackState: "none" | "pending" | "sending" | "sent" | "failed";
    callbackDetail: string | null;
    createdAt: string;
}

export class TriggerStore {
    constructor(
        private readonly db: Db,
        private readonly secrets: SecretBox,
        private readonly clock: () => number = Date.now,
    ) {}

    /** The only moment the plaintext token exists on the server side: it is returned here and never kept. */
    create(projectId: string, input: { label?: string; allowUrl?: boolean; createdBy?: string | null }): { token: string; record: TriggerToken } {
        const token = newToken();
        const id = randomUUID();
        this.db.run(
            "INSERT INTO trigger_tokens (id, project_id, label, token_hash, hint, allow_url, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)",
            id, projectId, input.label?.trim() || null, hashToken(token), token.slice(-4), input.allowUrl ? 1 : 0, new Date(this.clock()).toISOString(), input.createdBy ?? null,
        );
        return { token, record: this.get(id)! };
    }

    /**
     * Round 45: a token made before migration 55 gets its creator from the Activity log, only where certain: the one successful
     * "POST .../triggers" of its project within 10 seconds of its creation, by a person or the open server, with no other token of the
     * project made in that window. Everything else stays without an owner (its runs are refused with a sentence). Returns how many.
     */
    backfillOwners(): number {
        const WINDOW_MS = 10_000;
        let n = 0;
        for (const t of this.db.all<{ id: string; project_id: string; created_at: string }>("SELECT id, project_id, created_at FROM trigger_tokens WHERE created_by IS NULL")) {
            const made = Date.parse(t.created_at);
            if (!Number.isFinite(made)) continue;
            const near = (at: string) => Math.abs(Date.parse(at) - made) <= WINDOW_MS;
            const creates = this.db.all<{ at: string; actor_kind: string; actor_id: string | null }>("SELECT at, actor_kind, actor_id FROM activity WHERE action = 'POST /api/projects/:id/triggers' AND project_id = ? AND status < 400", t.project_id).filter((r) => near(r.at));
            const siblings = this.db.all<{ created_at: string }>("SELECT created_at FROM trigger_tokens WHERE project_id = ?", t.project_id).filter((r) => near(r.created_at));
            if (creates.length !== 1 || siblings.length !== 1) continue;
            const c = creates[0]!;
            const owner = c.actor_kind === "user" ? c.actor_id : c.actor_kind === "open" ? OPEN_OWNER_ID : null;
            if (!owner || (owner !== OPEN_OWNER_ID && !this.db.get("SELECT 1 AS x FROM users WHERE id = ?", owner))) continue;
            n += Number(this.db.run("UPDATE trigger_tokens SET created_by = ? WHERE id = ? AND created_by IS NULL", owner, t.id).changes);
        }
        return n;
    }

    get(id: string): TriggerToken | undefined {
        const r = this.db.get("SELECT * FROM trigger_tokens WHERE id = ?", id);
        return r ? toToken(r) : undefined;
    }

    list(projectId: string): TriggerToken[] {
        return this.db.all(`SELECT * FROM trigger_tokens WHERE project_id = ? ORDER BY created_at DESC, ${this.db.dialect.insertionOrder()} DESC`, projectId).map(toToken);
    }

    /** Revoking keeps the row (so earlier runs still say which token started them); the token stops working at once. */
    revoke(projectId: string, id: string): boolean {
        return Number(this.db.run("UPDATE trigger_tokens SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL", new Date(this.clock()).toISOString(), id, projectId).changes) === 1;
    }

    /** The live token record for a presented token, or undefined (unknown and revoked look the same). Hash compared in constant time. */
    find(presented: string): TriggerToken | undefined {
        const hash = hashToken(presented);
        const r = this.db.get("SELECT * FROM trigger_tokens WHERE token_hash = ?", hash);
        if (!r) return undefined;
        const a = Buffer.from(hash, "hex");
        const b = Buffer.from(String(r.token_hash), "hex");
        if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
        return r.revoked_at ? undefined : toToken(r);
    }

    /** Milliseconds until this token may start another run (0 = now). */
    waitMs(t: TriggerToken, minGapMs: number): number {
        return t.lastRunAt === null ? 0 : Math.max(0, t.lastRunAt + minGapMs - this.clock());
    }

    /** Take the token's run slot. Atomic: of two simultaneous requests only one gets it. */
    claimSlot(id: string, minGapMs: number): boolean {
        const now = this.clock();
        return Number(this.db.run("UPDATE trigger_tokens SET last_run_at = ?, last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_run_at IS NULL OR last_run_at <= ?)", now, new Date(now).toISOString(), id, now - minGapMs).changes) === 1;
    }

    touch(id: string): void {
        this.db.run("UPDATE trigger_tokens SET last_used_at = ? WHERE id = ?", new Date(this.clock()).toISOString(), id);
    }

    addRun(input: { jobId: string; tokenId: string; commit?: string; environment?: string; callbackUrl?: string }): void {
        this.db.run(
            "INSERT INTO trigger_runs (job_id, token_id, commit_sha, environment, callback_enc, callback_state, created_at) VALUES (?,?,?,?,?,?,?)",
            input.jobId, input.tokenId, input.commit ?? null, input.environment ?? null, input.callbackUrl ? this.secrets.encrypt({ url: input.callbackUrl }) : null, input.callbackUrl ? "pending" : "none", new Date(this.clock()).toISOString(),
        );
    }

    getRun(jobId: string): TriggerRunRow | undefined {
        const r = this.db.get("SELECT * FROM trigger_runs WHERE job_id = ?", jobId);
        return r ? { jobId: r.job_id, tokenId: r.token_id, commit: r.commit_sha, environment: r.environment, callbackState: r.callback_state, callbackDetail: r.callback_detail, createdAt: r.created_at } : undefined;
    }

    /** Take the right to deliver this run's callback (once, even with several workers). Returns the URL, or undefined. */
    claimCallback(jobId: string): string | undefined {
        const r = this.db.get<{ callback_enc: string | null }>("SELECT callback_enc FROM trigger_runs WHERE job_id = ? AND callback_state = 'pending'", jobId);
        if (!r?.callback_enc) return undefined;
        if (Number(this.db.run("UPDATE trigger_runs SET callback_state = 'sending' WHERE job_id = ? AND callback_state = 'pending'", jobId).changes) !== 1) return undefined;
        return this.secrets.decrypt<{ url: string }>(r.callback_enc).url;
    }

    finishCallback(jobId: string, ok: boolean, detail?: string): void {
        this.db.run("UPDATE trigger_runs SET callback_state = ?, callback_detail = ? WHERE job_id = ?", ok ? "sent" : "failed", detail ?? null, jobId);
    }
}
