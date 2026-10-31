/**
 * Production-hosting routes (Builder INF): GET /healthz, GET /readyz, GET /metrics, plus the request id and the HTTP numbers of every request.
 * They live outside /api/ on purpose: probes and Prometheus are not people. /healthz and /readyz need no key and say nothing secret;
 * /metrics needs the API key (x-api-key) or METRICS_TOKEN (Authorization: Bearer …) whenever either is set. See docs/features/production-hosting.md.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { REPO_ROOT } from "../../config.js";
import { readStatus } from "../ops/backup-schedule.js";
import { checkReadiness, diskFreeBytes } from "../ops/health.js";
import { readHeartbeat } from "../ops/heartbeat.js";
import { createOpsLogger, serverSecrets, type OpsLogger } from "../ops/logger.js";
import { HttpStats, renderMetrics } from "../ops/metrics.js";
import { loadOpsSettings, type OpsSettings } from "../ops/settings.js";
import type { RouteCtx } from "./types.js";

export interface OpsRuntime {
    settings: OpsSettings;
    /** Set by the shutdown; GET /readyz answers 503 from then on. */
    state: { shuttingDown: boolean };
    http: HttpStats;
    startedAt: number;
    log: OpsLogger;
}

const runtimes = new WeakMap<FastifyInstance, OpsRuntime>();
/** The ops state of a built server (main.ts hands `state` to the shutdown). */
export const opsRuntimeFor = (app: FastifyInstance): OpsRuntime | undefined => runtimes.get(app);

const PROBES = new Set(["/healthz", "/readyz"]);
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ids = new WeakMap<FastifyRequest, string>();

/** The request's id: the caller's `x-request-id` when it is a plain short token, otherwise a new one. Sent back in `x-request-id`. */
export function requestIdOf(req: FastifyRequest): string {
    let id = ids.get(req);
    if (!id) {
        const given = req.headers["x-request-id"];
        id = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
        ids.set(req, id);
    }
    return id;
}

let version: string | undefined;
function platformVersion(): string {
    if (version) return version;
    try {
        version = String((JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "unknown");
    } catch {
        version = "unknown";
    }
    return version;
}

function sameSecret(got: string, expected: string): boolean {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** May this request read /metrics? Open only when the whole platform is open (no API key and no metrics token). */
export function metricsAllowed(req: FastifyRequest, apiKey: string | undefined, token: string | undefined): boolean {
    if (!apiKey && !token) return true;
    const key = req.headers["x-api-key"];
    if (apiKey && typeof key === "string" && sameSecret(key, apiKey)) return true;
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
    return Boolean(token && bearer && sameSecret(bearer, token));
}

export function registerOpsRoutes(ctx: RouteCtx, settings: OpsSettings = loadOpsSettings()): void {
    const { app, p } = ctx;
    const runtime: OpsRuntime = { settings, state: { shuttingDown: false }, http: new HttpStats(), startedAt: Date.now(), log: createOpsLogger(settings.logFormat, serverSecrets()) };
    runtimes.set(app, runtime);

    // Every answer carries its request id, errors and refusals included (onSend runs for those too).
    app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply) => {
        reply.header("x-request-id", requestIdOf(req));
    });
    app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
        const route = req.routeOptions?.url;
        runtime.http.observe(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
        if (runtime.log.format !== "json" || (route && PROBES.has(route) && reply.statusCode < 400)) return;
        runtime.log.log(reply.statusCode >= 500 ? "error" : "info", "request", {
            component: "http",
            requestId: requestIdOf(req),
            method: req.method,
            // The template, never the address: ids, tickets and trigger tokens are not written down.
            route: route ?? "unmatched",
            status: reply.statusCode,
            durationMs: Math.round(reply.elapsedTime),
        });
    });

    app.get("/healthz", async (_req, reply) => reply.header("cache-control", "no-store").send({ status: "ok" }));

    app.get("/readyz", async (_req, reply) => {
        const r = checkReadiness({ db: p.db, dataDir: p.config.dataDir, minFreeBytes: settings.minFreeBytes, workerStaleMs: settings.workerStaleMs, shuttingDown: runtime.state.shuttingDown });
        reply.header("cache-control", "no-store");
        return r.ready ? reply.send({ status: "ready" }) : reply.code(503).send({ status: "not ready", failing: r.failing });
    });

    app.get("/metrics", async (req, reply) => {
        if (!metricsAllowed(req, p.config.API_KEY, settings.metricsToken)) {
            return reply.code(401).header("www-authenticate", "Bearer").send({ error: "Send the API key in x-api-key, or METRICS_TOKEN as a Bearer token." });
        }
        const body = renderMetrics({
            db: p.db,
            dbPath: p.config.dbPath,
            http: runtime.http,
            startedAt: runtime.startedAt,
            workerBeat: readHeartbeat(p.db),
            diskFree: diskFreeBytes(p.config.dataDir),
            ...(settings.backupDir ? { backup: readStatus(settings.backupDir) } : {}),
            version: platformVersion(),
        });
        return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").header("cache-control", "no-store").send(body);
    });
}
