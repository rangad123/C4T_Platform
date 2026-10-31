/**
 * GET /metrics in the Prometheus text format (version 0.0.4). Two sources:
 * - HTTP traffic counted in this process (requests by method, route template and status, latency histogram by route template); route
 *   templates (`/api/projects/:id`) are used, never the real address, so no id or token becomes a label, and the label sets are capped;
 * - the database, read at scrape time: jobs by status and queue length, how long finished jobs took (by kind), AI calls, tokens and the
 *   estimated cost (from AI usage tracking and the prices set in Settings), runners online, and the scheduled-backup and worker notes.
 * Nothing secret is ever a label or a value.
 */
import fs from "node:fs";
import type { Db } from "../db.js";
import { ONLINE_MS } from "../agent-store.js";
import { JOB_STATES } from "../repo.js";
import { errorLineCount } from "./logger.js";

const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const JOB_BUCKETS = [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];
/** More distinct (method, route, status) sets than this are counted under route="other" (a misbehaving client cannot blow up memory). */
export const MAX_SERIES = 400;

export function escapeLabel(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const labels = (l: Record<string, string>): string => {
    const parts = Object.entries(l).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
    return parts.length ? `{${parts.join(",")}}` : "";
};

const num = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : "0");

interface Hist {
    buckets: number[];
    sum: number;
    count: number;
}

/** HTTP numbers of this process since it started. */
export class HttpStats {
    private readonly requests = new Map<string, { method: string; route: string; status: string; n: number }>();
    private readonly latency = new Map<string, { method: string; route: string; h: Hist }>();
    serverErrors = 0;

    observe(method: string, routeTemplate: string | undefined, status: number, seconds: number): void {
        let route = routeTemplate && routeTemplate.length <= 200 ? routeTemplate : "unmatched";
        const m = /^[A-Z]{3,7}$/.test(method) ? method : "OTHER";
        let key = `${m} ${route} ${status}`;
        if (!this.requests.has(key) && this.requests.size >= MAX_SERIES) {
            route = "other";
            key = `${m} ${route} ${status}`;
        }
        const r = this.requests.get(key) ?? { method: m, route, status: String(status), n: 0 };
        r.n++;
        this.requests.set(key, r);
        const lk = `${m} ${route}`;
        const l = this.latency.get(lk) ?? { method: m, route, h: { buckets: HTTP_BUCKETS.map(() => 0), sum: 0, count: 0 } };
        HTTP_BUCKETS.forEach((b, i) => {
            if (seconds <= b) l.h.buckets[i]!++;
        });
        l.h.sum += seconds;
        l.h.count++;
        this.latency.set(lk, l);
        if (status >= 500) this.serverErrors++;
    }

    render(out: string[]): void {
        out.push("# HELP aitp_http_requests_total HTTP requests answered, by method, route template and status.", "# TYPE aitp_http_requests_total counter");
        for (const r of this.requests.values()) out.push(`aitp_http_requests_total${labels({ method: r.method, route: r.route, status: r.status })} ${r.n}`);
        out.push("# HELP aitp_http_request_duration_seconds Time to answer an HTTP request, by method and route template.", "# TYPE aitp_http_request_duration_seconds histogram");
        for (const l of this.latency.values()) histogram(out, "aitp_http_request_duration_seconds", { method: l.method, route: l.route }, HTTP_BUCKETS, l.h);
        out.push("# HELP aitp_http_server_errors_total HTTP answers with a 5xx status.", "# TYPE aitp_http_server_errors_total counter", `aitp_http_server_errors_total ${this.serverErrors}`);
    }
}

function histogram(out: string[], name: string, l: Record<string, string>, bounds: number[], h: Hist): void {
    bounds.forEach((b, i) => out.push(`${name}_bucket${labels({ ...l, le: String(b) })} ${h.buckets[i]}`));
    out.push(`${name}_bucket${labels({ ...l, le: "+Inf" })} ${h.count}`, `${name}_sum${labels(l)} ${num(h.sum)}`, `${name}_count${labels(l)} ${h.count}`);
}

function safe<T>(fn: () => T, fallback: T): T {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

export interface MetricsInput {
    db: Db;
    dbPath: string;
    http: HttpStats;
    startedAt: number;
    now?: number;
    workerBeat?: number;
    diskFree?: number;
    backup?: { lastSuccessAt?: number; lastOk?: boolean; kept?: number };
    version: string;
}

/** The whole /metrics answer. */
export function renderMetrics(input: MetricsInput): string {
    const { db } = input;
    const now = input.now ?? Date.now();
    const out: string[] = [];
    const gauge = (name: string, help: string, value: number | undefined, type = "gauge") => {
        if (value === undefined) return;
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${num(value)}`);
    };

    out.push("# HELP aitp_build_info The platform version.", "# TYPE aitp_build_info gauge", `aitp_build_info${labels({ version: input.version })} 1`);
    gauge("aitp_process_start_time_seconds", "When this process started (Unix time).", input.startedAt / 1000);
    gauge("aitp_process_resident_memory_bytes", "Memory this process holds.", process.memoryUsage().rss);
    gauge("aitp_log_error_lines_total", "Error lines this process has written.", errorLineCount(), "counter");

    // ── jobs ──
    const byStatus = new Map<string, number>(safe(() => db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM generation_jobs GROUP BY status"), []).map((r) => [r.status, Number(r.n)]));
    out.push("# HELP aitp_jobs Jobs (explorations and runs) by status.", "# TYPE aitp_jobs gauge");
    for (const s of JOB_STATES) out.push(`aitp_jobs${labels({ status: s })} ${byStatus.get(s) ?? 0}`);
    gauge("aitp_job_queue_length", "Jobs waiting for a worker.", byStatus.get("QUEUED") ?? 0);
    const sel = JOB_BUCKETS.map((b, i) => `SUM(CASE WHEN s <= ${b} THEN 1 ELSE 0 END) AS b${i}`).join(", ");
    const durations = safe(
        () =>
            db.all<Record<string, number | string>>(
                `SELECT mode, ${sel}, SUM(s) AS total, COUNT(*) AS n FROM (
                    SELECT COALESCE(${db.dialect.jsonText("options_json", "mode")}, 'generate') AS mode, ${db.dialect.secondsBetween("started_at", "finished_at")} AS s
                      FROM generation_jobs WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
                 ) AS d WHERE s >= 0 GROUP BY mode`,
            ),
        [],
    );
    out.push("# HELP aitp_job_duration_seconds How long finished jobs ran, by kind (generate = exploration, validate = run).", "# TYPE aitp_job_duration_seconds histogram");
    for (const r of durations) {
        const mode = /^[a-z-]{1,24}$/.test(String(r.mode)) ? String(r.mode) : "other";
        histogram(out, "aitp_job_duration_seconds", { mode }, JOB_BUCKETS, { buckets: JOB_BUCKETS.map((_, i) => Number(r[`b${i}`] ?? 0)), sum: Number(r.total ?? 0), count: Number(r.n ?? 0) });
    }

    // ── AI usage ──
    const ai = safe(() => db.get<Record<string, number | null>>("SELECT SUM(calls) AS calls, SUM(failed_calls) AS failed, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ai_usage"), undefined);
    gauge("aitp_ai_calls_total", "AI model calls made.", Number(ai?.calls ?? 0), "counter");
    gauge("aitp_ai_failed_calls_total", "AI model calls that failed.", Number(ai?.failed ?? 0), "counter");
    out.push("# HELP aitp_ai_tokens_total AI tokens used, by direction.", "# TYPE aitp_ai_tokens_total counter");
    out.push(`aitp_ai_tokens_total${labels({ direction: "input" })} ${Number(ai?.input ?? 0)}`, `aitp_ai_tokens_total${labels({ direction: "output" })} ${Number(ai?.output ?? 0)}`);
    const cost = safe(
        () =>
            db.get<Record<string, number | null>>(
                `SELECT SUM(u.input_tokens * p.input_per_mtok + u.output_tokens * p.output_per_mtok) / 1000000.0 AS cost,
                        SUM(CASE WHEN p.model IS NULL THEN u.input_tokens + u.output_tokens ELSE 0 END) AS unpriced
                   FROM ai_usage u LEFT JOIN ai_prices p ON p.model = u.model`,
            ),
        undefined,
    );
    const currency = safe(() => String(db.get<{ value: string | null }>("SELECT value FROM ai_settings WHERE key = 'currency'")?.value ?? "USD"), "USD");
    out.push("# HELP aitp_ai_estimated_cost_total Estimated AI cost from the prices set in Settings, AI usage (models without a price count 0).", "# TYPE aitp_ai_estimated_cost_total counter");
    out.push(`aitp_ai_estimated_cost_total${labels({ currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD" })} ${num(Number(cost?.cost ?? 0))}`);
    gauge("aitp_ai_unpriced_tokens_total", "AI tokens of models that have no price set (not in the cost).", Number(cost?.unpriced ?? 0), "counter");

    // ── runners ──
    const agents = safe(() => db.get<{ online: number | null; total: number }>("SELECT SUM(CASE WHEN last_seen_ms >= ? THEN 1 ELSE 0 END) AS online, COUNT(*) AS total FROM agents", now - ONLINE_MS), undefined);
    out.push("# HELP aitp_runners Runners (runner agents) known to the platform, by state.", "# TYPE aitp_runners gauge");
    out.push(`aitp_runners${labels({ state: "online" })} ${Number(agents?.online ?? 0)}`, `aitp_runners${labels({ state: "offline" })} ${Number(agents?.total ?? 0) - Number(agents?.online ?? 0)}`);

    // ── host ──
    if (input.workerBeat !== undefined) gauge("aitp_worker_heartbeat_age_seconds", "Seconds since a worker last said it was alive.", Math.max(0, (now - input.workerBeat) / 1000));
    gauge("aitp_disk_free_bytes", "Free space on the data folder's disk.", input.diskFree);
    let dbBytes = 0;
    for (const f of [input.dbPath, `${input.dbPath}-wal`]) dbBytes += safe(() => fs.statSync(f).size, 0);
    gauge("aitp_database_bytes", "Size of the database (with its write-ahead log).", dbBytes);
    if (input.backup) {
        gauge("aitp_backup_last_success_time_seconds", "When the last verified scheduled backup finished (Unix time).", input.backup.lastSuccessAt !== undefined ? input.backup.lastSuccessAt / 1000 : undefined);
        gauge("aitp_backup_last_ok", "1 when the last scheduled backup was made and verified, 0 when it failed.", input.backup.lastOk === undefined ? undefined : input.backup.lastOk ? 1 : 0);
        gauge("aitp_backups_kept", "Verified backups kept in the backup folder.", input.backup.kept);
    }
    input.http.render(out);
    return `${out.join("\n")}\n`;
}
