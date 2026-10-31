/**
 * Production hosting, the pure parts (fast tier, no server, no browser): settings parsing, log scrubbing and JSON lines, the console switch,
 * backup naming/due/prune rules, Prometheus label escaping and series caps, the /metrics access rule.
 *   node node_modules/vitest/vitest.mjs run tests/ops-unit.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { backupName, backupTime, isDue, listBackups, pruneBackups } from "../src/platform/ops/backup-schedule.js";
import { createOpsLogger, errorLineCount, installConsole, jsonLine, scrubLogText, serverSecrets } from "../src/platform/ops/logger.js";
import { escapeLabel, HttpStats, MAX_SERIES } from "../src/platform/ops/metrics.js";
import { loadOpsSettings, parseBackupSchedule } from "../src/platform/ops/settings.js";
import { metricsAllowed } from "../src/platform/routes/ops.js";

const KEY = "SENTINEL-OPS-APIKEY-4471";
const LLM = "SENTINEL-OPS-LLMKEY-9932";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-unit-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("settings", () => {
    it("reads defaults and valid values, and ignores bad ones with a plain note", () => {
        const d = loadOpsSettings({});
        expect(d).toMatchObject({ logFormat: "text", shutdownGraceMs: 60_000, minFreeBytes: 500 * 1024 * 1024, workerStaleMs: 90_000, backupKeep: 7, backupCadence: { kind: "off" }, problems: [] });
        expect(d.backupDir).toBeUndefined();
        const s = loadOpsSettings({ LOG_FORMAT: "JSON", SHUTDOWN_GRACE_SECONDS: "5", READY_MIN_FREE_MB: "0", BACKUP_DIR: dir, BACKUP_KEEP: "3", METRICS_TOKEN: "short", BACKUP_SCHEDULE: "weekly" });
        expect(s).toMatchObject({ logFormat: "json", shutdownGraceMs: 5000, minFreeBytes: 0, backupKeep: 3, backupDir: path.resolve(dir), backupCadence: { kind: "daily", atMinuteUtc: 150 } });
        expect(s.metricsToken).toBeUndefined();
        expect(s.problems.join(" ")).toMatch(/METRICS_TOKEN is shorter than 16 characters/);
        expect(s.problems.join(" ")).toMatch(/BACKUP_SCHEDULE "weekly" is not understood/);
        expect(loadOpsSettings({ SHUTDOWN_GRACE_SECONDS: "-3", BACKUP_KEEP: "9999" })).toMatchObject({ shutdownGraceMs: 60_000, backupKeep: 7 });
    });

    it("understands every documented backup schedule", () => {
        expect(parseBackupSchedule(undefined).cadence).toEqual({ kind: "daily", atMinuteUtc: 150 });
        expect(parseBackupSchedule("daily@04:15").cadence).toEqual({ kind: "daily", atMinuteUtc: 255 });
        expect(parseBackupSchedule("hourly").cadence).toEqual({ kind: "every", ms: 3_600_000 });
        expect(parseBackupSchedule("every 6h").cadence).toEqual({ kind: "every", ms: 6 * 3_600_000 });
        expect(parseBackupSchedule("12h").cadence).toEqual({ kind: "every", ms: 12 * 3_600_000 });
        expect(parseBackupSchedule("off").cadence).toEqual({ kind: "off" });
        expect(parseBackupSchedule("200h").problem).toBeDefined();
        expect(parseBackupSchedule("daily@25:00").problem).toBeDefined();
    });
});

describe("log scrubbing and JSON lines", () => {
    const secrets = serverSecrets({ API_KEY: KEY, LLM_API_KEY: LLM, SECRET_KEY: "abc" });

    it("knows the server's own secrets (and ignores values too short to matter)", () => {
        expect(secrets).toEqual([KEY, LLM]);
    });

    it("hides known values, bearer/basic credentials, JWTs, secret query parameters, trigger tokens and stream tickets", () => {
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcDEF123";
        const raw = `key ${KEY} used; Authorization: Bearer abcdefghijkl; token ${jwt}; GET /api/artifacts/x?key=${KEY}&a=1 /x?access_token=zzz123&password=hunter22 POST /api/triggers/tok_ABCDEF/run /api/stream?ticket=T123`;
        const out = scrubLogText(raw, secrets);
        for (const bad of [KEY, "abcdefghijkl", jwt, "zzz123", "hunter22", "tok_ABCDEF", "T123"]) expect(out).not.toContain(bad);
        expect(out).toContain("a=1");
        expect(out).toContain("/api/triggers/[token]/run");
    });

    it("cuts very long lines", () => {
        expect(scrubLogText("x".repeat(20_000), []).length).toBeLessThan(8_100);
    });

    it("writes one JSON object with level, time, component and short job id taken from the usual prefixes", () => {
        const line = jsonLine("warn", `[job 1a2b3c4d] analysis/x: used ${LLM}`, { requestId: "r-1", extra: `has ${KEY}` }, secrets, new Date("2026-10-18T10:00:00Z"));
        const o = JSON.parse(line);
        expect(o).toMatchObject({ time: "2026-10-18T10:00:00.000Z", level: "warn", component: "job", job: "1a2b3c4d", requestId: "r-1" });
        expect(line).not.toContain(LLM);
        expect(line).not.toContain(KEY);
        expect(JSON.parse(jsonLine("info", "[worker] embedded worker started", {}, secrets)).component).toBe("worker");
    });

    it("turns console lines into scrubbed JSON lines with LOG_FORMAT=json, counts error lines, and puts the console back", () => {
        const out: string[] = [];
        const err: string[] = [];
        const before = errorLineCount();
        const restore = installConsole("json", secrets, { out: (l) => out.push(l), err: (l) => err.push(l) });
        try {
            console.log("[scheduler] started with %s", KEY);
            console.error("[worker] loop error:", new Error(`boom ${LLM}`));
            console.warn({ note: "an object" });
        } finally {
            restore();
        }
        expect(out).toHaveLength(1);
        expect(err).toHaveLength(2);
        for (const l of [...out, ...err]) {
            const o = JSON.parse(l);
            expect(typeof o.time).toBe("string");
            expect(l).not.toContain(KEY);
            expect(l).not.toContain(LLM);
        }
        expect(JSON.parse(out[0]!)).toMatchObject({ level: "info", component: "scheduler" });
        expect(JSON.parse(err[0]!)).toMatchObject({ level: "error", component: "worker" });
        expect(errorLineCount()).toBe(before + 1);
    });

    it("keeps the usual text lines without LOG_FORMAT=json (still scrubbed in the ops logger)", () => {
        const lines: string[] = [];
        const log = createOpsLogger("text", secrets, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
        log.log("info", `[backup] made with ${KEY}`);
        expect(lines).toEqual(["[backup] made with [hidden]"]);
    });
});

describe("backup rules", () => {
    it("names backups by UTC time and reads the time back", () => {
        const d = new Date(Date.UTC(2026, 9, 18, 2, 30, 5));
        expect(backupName(d)).toBe("platform-20261018-023005.db");
        expect(backupTime(backupName(d))).toBe(d.getTime());
        expect(backupTime("platform.db")).toBeUndefined();
    });

    it("decides when a backup is due", () => {
        const at = (s: string) => Date.parse(s);
        const daily = { kind: "daily" as const, atMinuteUtc: 150 };
        expect(isDue(daily, undefined, at("2026-10-18T01:00:00Z"))).toBe(true);
        expect(isDue(daily, at("2026-10-17T02:31:00Z"), at("2026-10-18T01:00:00Z"))).toBe(false); // today's slot (02:30) not reached yet
        expect(isDue(daily, at("2026-10-17T02:31:00Z"), at("2026-10-18T02:30:00Z"))).toBe(true);
        expect(isDue(daily, at("2026-10-18T02:30:01Z"), at("2026-10-18T23:00:00Z"))).toBe(false);
        const every = { kind: "every" as const, ms: 3_600_000 };
        expect(isDue(every, at("2026-10-18T01:00:00Z"), at("2026-10-18T01:59:59Z"))).toBe(false);
        expect(isDue(every, at("2026-10-18T01:00:00Z"), at("2026-10-18T02:00:00Z"))).toBe(true);
        expect(isDue({ kind: "off" }, undefined, Date.now())).toBe(false);
    });

    it("keeps the newest N backups and never removes a file that is not named like a backup", () => {
        const d = fs.mkdtempSync(path.join(dir, "prune-"));
        const names = ["platform-20261015-023000.db", "platform-20261016-023000.db", "platform-20261017-023000.db", "platform-20261018-023000.db"];
        for (const n of names) fs.writeFileSync(path.join(d, n), "x");
        fs.writeFileSync(path.join(d, "platform-20261015-023000.db.secret"), "k");
        fs.writeFileSync(path.join(d, "my-notes.txt"), "keep me");
        fs.writeFileSync(path.join(d, "platform.db"), "keep me");
        expect(pruneBackups(d, 2)).toEqual(["platform-20261016-023000.db", "platform-20261015-023000.db"]);
        expect(listBackups(d)).toEqual(["platform-20261018-023000.db", "platform-20261017-023000.db"]);
        expect(fs.existsSync(path.join(d, "platform-20261015-023000.db.secret"))).toBe(false);
        expect(fs.existsSync(path.join(d, "my-notes.txt"))).toBe(true);
        expect(fs.existsSync(path.join(d, "platform.db"))).toBe(true);
    });
});

describe("metrics pieces", () => {
    it("escapes label values", () => {
        expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    });

    it("counts by route template and caps the number of series", () => {
        const h = new HttpStats();
        h.observe("GET", "/api/projects/:id", 200, 0.02);
        h.observe("GET", "/api/projects/:id", 200, 3);
        h.observe("POST", undefined, 404, 0.001);
        h.observe("GET", "/x", 503, 0.1);
        for (let i = 0; i < MAX_SERIES + 50; i++) h.observe("GET", `/r${i}`, 200, 0.001);
        const out: string[] = [];
        h.render(out);
        const text = out.join("\n");
        expect(text).toContain('aitp_http_requests_total{method="GET",route="/api/projects/:id",status="200"} 2');
        expect(text).toContain('aitp_http_requests_total{method="POST",route="unmatched",status="404"} 1');
        expect(text).toContain('aitp_http_request_duration_seconds_bucket{method="GET",route="/api/projects/:id",le="0.025"} 1');
        expect(text).toContain('aitp_http_request_duration_seconds_count{method="GET",route="/api/projects/:id"} 2');
        expect(text).toContain("aitp_http_server_errors_total 1");
        expect(text).toMatch(/route="other",status="200"\} \d+/);
        expect(out.filter((l) => l.startsWith("aitp_http_requests_total{")).length).toBeLessThanOrEqual(MAX_SERIES + 1);
    });

    it("lets /metrics be read with the API key or the metrics token, and only openly when the platform is open", () => {
        const req = (h: Record<string, string>) => ({ headers: h }) as unknown as FastifyRequest;
        const TOKEN = "metrics-token-0123456789";
        expect(metricsAllowed(req({}), undefined, undefined)).toBe(true);
        expect(metricsAllowed(req({}), KEY, undefined)).toBe(false);
        expect(metricsAllowed(req({ "x-api-key": KEY }), KEY, TOKEN)).toBe(true);
        expect(metricsAllowed(req({ authorization: `Bearer ${TOKEN}` }), KEY, TOKEN)).toBe(true);
        expect(metricsAllowed(req({ authorization: `Bearer ${TOKEN}` }), KEY, undefined)).toBe(false);
        expect(metricsAllowed(req({ authorization: "Bearer wrong" }), undefined, TOKEN)).toBe(false);
        expect(metricsAllowed(req({ "x-api-key": "wrong" }), KEY, TOKEN)).toBe(false);
    });
});
