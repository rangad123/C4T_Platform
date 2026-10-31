import { z } from "zod";
import { formatBytes } from "../../engine/retention/format.js";
import { BACKUP_LIMITS } from "../../engine/retention/backup-model.js";
import { KEEP_DAYS, KEEP_FAILED_DAYS, KEEP_LATEST_RUNS, MAX_ARTIFACT_MB, mergePolicy, platformDefaultDays, RetentionPolicyPatchSchema } from "../../engine/retention/policy.js";
import { buildBackup, DEFAULT_EVIDENCE_MB, MAX_EVIDENCE_MB, restoreBackup } from "../backup.js";
import { recordBackupWithoutSecurity, securityDataCounts } from "../../security/backup.js";
import { HttpError } from "../http-error.js";
import { activeJobOf } from "../scheduler.js";
import { planFor, publicPlan, retentionStore, runNow } from "../retention-runner.js";
import { databaseBytes, diskInfo, emptyUsage, usageJson, usageScan } from "../storage-usage.js";
import type { RouteCtx } from "./types.js";

/**
 * Storage, retention and backup routes (Builder AA).
 *
 *   GET    /api/storage                              disk used by the platform: database, files by kind, biggest projects, free disk space
 *   GET    /api/projects/:id/storage                 the same for one project, with its retention state and anything still to re-enter after a restore
 *   GET    /api/projects/:id/retention               the policy that applies (saved, platform default, or off), limits, and the last runs
 *   PUT    /api/projects/:id/retention               save the policy (off unless enabled)
 *   POST   /api/projects/:id/retention/preview       exactly what a run would remove now; removes nothing
 *   POST   /api/projects/:id/retention/run           remove it; needs an enabled policy, { confirm: true }, and no job running
 *   GET    /api/projects/:id/backup                  a zip of the project (no secrets); ?evidence=true adds baselines and recent evidence;
 *                                                     ?withoutSecurity=true leaves the security data out (the pre-round-20 format; recorded)
 *   POST   /api/projects/restore                     a backup zip as the request body creates a NEW project (never overwrites one)
 *   DELETE /api/projects/:id/restore-needs           the "re-enter these secrets" list, once done
 */
export function registerRetentionRoutes(ctx: RouteCtx): void {
    const { app, p, project } = ctx;
    const store = () => retentionStore(p);

    const policyBody = (id: string, patch: z.infer<typeof RetentionPolicyPatchSchema>) => {
        try {
            const { source: _source, ...base } = store().effective(id);
            return mergePolicy(base, patch);
        } catch (e) {
            if (e instanceof z.ZodError) throw new HttpError(400, e.issues[0]?.message ?? "Invalid retention settings", e.issues);
            throw e;
        }
    };
    const patchOf = (body: unknown) => {
        const r = RetentionPolicyPatchSchema.safeParse(body ?? {});
        if (!r.success) throw new HttpError(400, "Unknown or invalid retention setting. Allowed: enabled, keepDays, keepFailedDays, keepLatestRuns, maxArtifactMB.", r.error.issues);
        return r.data;
    };

    // ── storage ──
    app.get("/api/storage", async () => {
        const scan = await usageScan(p);
        const names = new Map(p.repo.listProjects().map((r) => [r.id as string, r.name as string]));
        const rows = [...scan.projects.entries()]
            .map(([id, usage]) => ({ id, name: names.get(id) ?? null, ...usageJson(usage), retention: names.has(id) ? { enabled: store().effective(id).enabled } : null }))
            .sort((a, b) => b.bytes - a.bytes);
        const db = databaseBytes(p.config.dbPath);
        const disk = await diskInfo(p.config.dataDir);
        return {
            generatedAt: new Date(scan.scannedAt).toISOString(),
            truncated: scan.truncated,
            database: { bytes: db, text: formatBytes(db) },
            files: usageJson(scan.total),
            disk: disk ? { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes, freeText: formatBytes(disk.freeBytes), totalText: formatBytes(disk.totalBytes) } : null,
            projectCount: rows.filter((r) => r.name !== null).length,
            projects: rows.filter((r) => r.name !== null).slice(0, 20),
            other: usageJson(scan.unassigned),
            platformDefaultDays: platformDefaultDays(p.config.RETENTION_DEFAULT_DAYS) ?? null,
        };
    });

    app.get("/api/projects/:id/storage", async (req) => {
        const { id } = req.params as { id: string };
        const proj = project(id);
        const scan = await usageScan(p);
        const usage = scan.projects.get(id) ?? emptyUsage();
        const pruned = p.db.get<{ n: number; b: number | null }>("SELECT COUNT(*) AS n, SUM(size) AS b FROM artifacts WHERE project_id = ? AND pruned_at IS NOT NULL", id);
        const eff = store().effective(id);
        return {
            project: { id, name: proj.name },
            generatedAt: new Date(scan.scannedAt).toISOString(),
            truncated: scan.truncated,
            usage: usageJson(usage),
            removed: { files: pruned?.n ?? 0, bytes: pruned?.b ?? 0, text: formatBytes(pruned?.b ?? 0) },
            retention: { enabled: eff.enabled, source: eff.source },
            needsSecrets: store().needs(id),
            // Round 21: whether a backup would carry security assessment data (the page then offers to leave it out for an older platform).
            securityData: securityDataCounts(p.db, id) !== undefined,
        };
    });

    // ── retention ──
    app.get("/api/projects/:id/retention", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const eff = store().effective(id);
        const { source, ...policy } = eff;
        return {
            policy: { ...policy, maxArtifactMB: policy.maxArtifactMB ?? null },
            source,
            platformDefaultDays: platformDefaultDays(p.config.RETENTION_DEFAULT_DAYS) ?? null,
            limits: { keepDays: KEEP_DAYS, keepFailedDays: KEEP_FAILED_DAYS, keepLatestRuns: KEEP_LATEST_RUNS, maxArtifactMB: MAX_ARTIFACT_MB },
            busy: Boolean(await activeJobOf(p.repo, id)),
            recent: store().recent(id, 10),
        };
    });

    app.put("/api/projects/:id/retention", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const next = policyBody(id, patchOf(req.body));
        store().save(id, next);
        const eff = store().effective(id);
        const { source, ...policy } = eff;
        return { policy: { ...policy, maxArtifactMB: policy.maxArtifactMB ?? null }, source };
    });

    app.post("/api/projects/:id/retention/preview", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        // The form may ask about values it has not saved yet; the run always uses what is saved.
        const policy = policyBody(id, patchOf(req.body));
        const full = planFor(p, id, policy, Date.now());
        return publicPlan(policy, full);
    });

    app.post("/api/projects/:id/retention/run", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        const { confirm } = z.object({ confirm: z.boolean().optional() }).strict().parse(req.body ?? {});
        return runNow(p, id, confirm === true);
    });

    // ── backup and restore ──
    app.get("/api/projects/:id/backup", async (req, reply) => {
        const { id } = req.params as { id: string };
        project(id);
        const q = z
            .object({
                evidence: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
                maxEvidenceMB: z.coerce.number().int().min(1).max(MAX_EVIDENCE_MB).default(DEFAULT_EVIDENCE_MB),
                // Round 21: the format of a platform from before round 20 (no security.json), for restoring there. Owner only, like every backup.
                withoutSecurity: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
            })
            .parse(req.query ?? {});
        const { bytes, filename } = await buildBackup(p, id, { evidence: q.evidence, maxEvidenceMB: q.maxEvidenceMB, withoutSecurity: q.withoutSecurity });
        if (q.withoutSecurity) recordBackupWithoutSecurity(p.db, id);
        return reply.header("content-type", "application/zip").header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "no-store").send(Buffer.from(bytes));
    });

    // The zip is the raw request body, like an APK (JSON would mean encoding it twice).
    if (!app.hasContentTypeParser("application/zip")) app.addContentTypeParser("application/zip", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    app.post("/api/projects/restore", { bodyLimit: BACKUP_LIMITS.maxZipBytes + 1024 * 1024 }, async (req, reply) => {
        const { name } = z.object({ name: z.string().trim().min(1).max(120).optional() }).parse(req.query ?? {});
        const body = req.body;
        if (!Buffer.isBuffer(body)) throw new HttpError(415, "Send the backup file itself as the request body (content type application/zip).");
        const result = await restoreBackup(p, new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { name });
        return reply.code(201).send(result);
    });

    app.delete("/api/projects/:id/restore-needs", async (req) => {
        const { id } = req.params as { id: string };
        project(id);
        return { cleared: store().clearNeeds(id) };
    });
}
