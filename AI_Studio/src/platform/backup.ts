/**
 * Project backup and restore.
 *
 * Backup: a zip of small JSON documents describing the project (tests with their scripts, manual cases, releases, runbooks,
 * environments, test data, schedules, the names of alert channels...). Secrets are never written. Anything secret is listed by
 * name in `secrets-needed.json`, and the restore turns that list into "needs a secret" notes on the new project.
 *
 * Restore: always creates a NEW project; it never overwrites an existing one. The zip is untrusted: it is unpacked as a stream
 * with hard limits (entries, bytes per file, bytes in total), every entry name is checked, every document is validated, and the
 * only paths ever written are ones this code builds itself from ids it just generated. Restored tests start as PENDING (nothing is
 * re-run automatically), schedules start switched off, and retention starts switched off.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Unzip, UnzipInflate, strFromU8, strToU8, zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { ENV_NAME, MAX_ENVIRONMENTS } from "../engine/environments/env.js";
import { projectSetupOf } from "./project-setup.js";
import { BACKUP_FORMAT, BACKUP_KIND, BACKUP_LIMITS, badEntryName, checkEntryList, isKnownEntry, looksSensitive, scrubUrl, AlertChannelEntrySchema, DataSetEntrySchema, EnvironmentEntrySchema, FilesIndexSchema, ManifestSchema, ManualCaseEntrySchema, ProjectDocSchema, ReleaseEntrySchema, RunbookEntrySchema, ScheduleEntrySchema, SecretNeededSchema, TestEntrySchema, HelperEntrySchema, type FilesIndex, type Manifest, type SecretNeeded } from "../engine/retention/backup-model.js";
import { RetentionPolicySchema } from "../engine/retention/policy.js";
import { isPrunableKind } from "../engine/retention/rules.js";
import { RunbookDefinition } from "../engine/runbook/schema.js";
import { TestSpecSchema, type TestSpec } from "../engine/spec/schema.js";
import { checkElement } from "../engine/locators/model.js";
import { blockGraphProblems, checkBlockInput, indexBlocks, MAX_BLOCKS, tryExpandBlocks, type CheckedBlock } from "../engine/blocks/index.js";
import { blockSecretProblems } from "../engine/builder/index.js";
import { AgentInputsStore } from "./agent-inputs-store.js";
import { BlockStore } from "./block-store.js";
import { LocatorStore } from "./locator-store.js";
import { CustomScriptStore } from "./custom-script-store.js";
import { trackTestVersion } from "./review-store.js";
import { checkScript } from "../engine/custom/guard.js";
import type { Framework } from "../engine/generators/index.js";
import { listAdapters } from "../engine/frameworks/index.js";
import { ADAPTER_ID } from "../engine/frameworks/plugin.js";
import { DATA_SET_NAME } from "../engine/testdata/dataset.js";
import { REPO_ROOT } from "../config.js";
import type { Platform } from "./bootstrap.js";
import type { Row } from "./db.js";
import { DataSetStore, scheduleEnvironment, setScheduleEnvironment } from "./environments-store.js";
import { HttpError } from "./http-error.js";
import { IdentityStore } from "./identity-store.js";
import { ManualCaseStore } from "./manual-case-store.js";
import { backupRequirements, MAX_REQUIREMENTS, refKey, RequirementBackupSchema, restoreRequirements } from "./requirement-store.js";
import { retentionStore } from "./retention-runner.js";
import { RunbookStore } from "./runbook-store.js";
import { CadenceSchema, ScheduleStore } from "./schedule-store.js";
import { SecretBox } from "./secrets.js";
import { slugify } from "./storage.js";
import { putText } from "./object-store.js";
import { forgetUsage } from "./storage-usage.js";
// The project's Security Assessment data (security.json), when it has any; see that file for what travels and what never does.
import { exportSecurityData, forgetSecurityData, importSecurityData, SecurityBackupSchema, securityBackupProblem, securityRestoreWords } from "../security/backup.js";

const now = () => new Date().toISOString();

let versionCache: string | undefined;
async function platformVersion(): Promise<string> {
    if (versionCache) return versionCache;
    try {
        versionCache = String((JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "unknown");
    } catch {
        versionCache = "unknown";
    }
    return versionCache;
}

// ═══ export ═════════════════════════════════════════════════════════════════

export interface BackupOptions {
    /** Also include approved visual baselines and recent evidence files, up to `maxEvidenceMB`. */
    evidence: boolean;
    maxEvidenceMB: number;
    /**
     * Round 21: leave the Security Assessment data out (no security.json, no security counts, no security sign-in to enter again), so the
     * file is exactly what a platform from before round 20 wrote and can restore. The route records it (owner only).
     */
    withoutSecurity?: boolean;
}

export const DEFAULT_EVIDENCE_MB = 50;
export const MAX_EVIDENCE_MB = 200;

const json = (v: unknown) => strToU8(JSON.stringify(v, null, 2));

/** Settings of the application with anything secret-looking removed. `removed` names what was taken out. */
export function scrubConfig(config: Record<string, unknown>): { config: Record<string, unknown>; removed: string[] } {
    const removed: string[] = [];
    const walk = (v: unknown, key: string): unknown => {
        if (typeof v === "string") {
            if (/^https?:\/\//i.test(v)) {
                const s = scrubUrl(v);
                if (s.changed) removed.push(key);
                return s.url;
            }
            return v;
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (v && typeof v === "object") {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v)) {
                if (looksSensitive(k)) {
                    removed.push(k);
                    continue;
                }
                out[k] = walk(x, k);
            }
            return out;
        }
        return v;
    };
    // The mobile app entry holds a path on this computer; it is never exported.
    const { mobile: _mobile, requirementsText: _text, ...rest } = config;
    return { config: walk(rest, "") as Record<string, unknown>, removed };
}

export async function buildBackup(p: Platform, projectId: string, opts: BackupOptions): Promise<{ bytes: Uint8Array; filename: string; manifest: Manifest }> {
    const { repo, db } = p;
    const project = repo.getProject(projectId);
    if (!project) throw new HttpError(404, "Project not found");
    const needs: SecretNeeded[] = [];
    const need = (kind: SecretNeeded["kind"], label: string, detail?: string) => needs.push({ kind, label, ...(detail ? { detail } : {}) });

    // ── application ──
    const app = repo.getLatestApplicationPublic(projectId);
    let application: { url: string; config: Record<string, unknown> } | null = null;
    if (app) {
        const u = scrubUrl(app.url as string);
        const c = scrubConfig((app.config ?? {}) as Record<string, unknown>);
        application = { url: u.url, config: c.config };
        if (u.changed) need("address", "The application address", "A user name, password or token was removed from the address.");
        for (const k of new Set(c.removed)) need("address", `Application setting “${k || "address"}”`, "A secret-looking value was removed.");
        if ((app.config as Record<string, unknown>)?.mobile) need("address", "The mobile app", "Upload the Android app (APK) again.");
        if (app.hasCredentials) need("application-sign-in", "Sign-in details for the application", "User name, password, API token, authenticator secret or OAuth client secret.");
    }

    // ── tests ──
    const tests = repo.listTests(projectId);
    const keyOfId = new Map(tests.map((t) => [t.id, t.testKey]));
    // Code tests carry their history; the helpers they share travel in helpers.json. Generated tests look exactly as before.
    const customStore = new CustomScriptStore(db);
    const customOf = customStore.forProject(projectId);
    const customDoc = (testId: string) => {
        const c = customOf.get(testId)!;
        return {
            custom: {
                origin: c.origin,
                ...(c.specArchive !== undefined ? { specArchive: c.specArchive } : {}),
                ...(c.git ? { git: { host: c.git.host, path: c.git.path, ref: c.git.ref, commit: c.git.commit, importedAt: c.git.importedAt, ...(c.git.file ? { file: c.git.file } : {}) } } : {}),
                versions: customStore.listVersions(testId).slice(0, 101).map((v) => ({ version: v.version, content: customStore.getVersion(testId, v.version)!.content, kind: v.kind, note: v.note, createdAt: v.createdAt })),
            },
        };
    };
    const testDocs = tests.map((t) => ({
        testKey: t.testKey,
        suite: { name: t.suite, slug: String(repo.getSuite(t.suiteId)?.slug ?? slugify(t.suite)) },
        framework: t.framework,
        spec: t.spec,
        scripts: repo.listScripts(t.id).map((s) => ({ framework: s.framework as string, filename: s.filename as string, content: s.content as string, executable: Boolean(s.executable) })),
        ...(customOf.has(t.id) ? customDoc(t.id) : {}),
    }));
    const helperDocs = customStore.allHelpers(projectId);

    // ── manual cases and releases ──
    const manual = new ManualCaseStore(db);
    const cases = manual.listCases(projectId);
    const refOfRequirement = new Map(db.all<{ id: string; ref: string }>("SELECT id, ref FROM requirements WHERE project_id = ?", projectId).map((r) => [r.id, r.ref]));
    const caseDocs = cases.map((c) => ({
        ref: c.id,
        title: c.title,
        area: c.area,
        priority: c.priority,
        requirement: c.requirement,
        steps: c.steps,
        linkedTests: c.linkedTestIds.map((id) => keyOfId.get(id) ?? id),
        automation: c.automation,
        number: c.number,
        ...(c.requirementId && refOfRequirement.has(c.requirementId) ? { requirementRef: refOfRequirement.get(c.requirementId) } : {}),
    }));
    const requirementDocs = backupRequirements(db, projectId, keyOfId);
    const releaseDocs = manual.listReleases(projectId).map((r) => ({
        name: r.name,
        notes: r.notes,
        status: r.status,
        snapshot: r.snapshot,
        snapshotAt: r.snapshotAt,
        frozen: r.frozen,
        signedAt: r.signedAt,
        signedBy: r.signedBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        results: [...manual.results(r.id).values()].map((x) => ({ caseRef: x.caseId, result: x.result, note: x.note, by: x.by, at: x.at, issue: x.issue })),
        audit: manual.audit(r.id).map((a) => ({ at: a.at, kind: a.kind, by: a.by, comment: a.comment, override: a.override, state: a.state })),
    }));

    // ── runbooks ──
    const runbooks = new RunbookStore(db);
    const runbookList = runbooks.list(projectId);
    const runbookDocs = runbookList.map((r) => {
        const def = JSON.parse(JSON.stringify(r.definition)) as { steps: Array<Record<string, any>> };
        for (const s of def.steps) {
            if (s.type === "run" && s.scope && typeof s.scope === "object" && Array.isArray(s.scope.testIds)) s.scope.testIds = s.scope.testIds.map((id: string) => keyOfId.get(id) ?? id);
            if (s.type === "notify") need("runbook-notify", `Runbook “${r.name}”, step “${s.id}”`, "Choose an alert channel for this notify step again.");
        }
        return { name: r.name, definition: def };
    });

    // ── environments and test data ──
    const envRows = db.all<Row>("SELECT * FROM project_environments WHERE project_id = ? ORDER BY name", projectId);
    const environmentDocs = envRows.map((e) => {
        const variables: Record<string, string> = {};
        for (const [k, v] of Object.entries(JSON.parse(e.variables_json || "{}") as Record<string, string>)) {
            if (looksSensitive(k)) need("environment-variable", `Environment “${e.name}”, value “${k}”`, "A secret-looking value was left out.");
            else variables[k] = v;
        }
        const base = scrubUrl(e.base_url);
        const api = e.api_base_url ? scrubUrl(e.api_base_url) : null;
        if (base.changed || api?.changed) need("address", `Environment “${e.name}” address`, "A user name, password or token was removed from the address.");
        if (e.secrets_enc) need("environment-sign-in", `Sign-in details for environment “${e.name}”`, "User name, password, token, authenticator secret or authorization header.");
        return { name: e.name as string, baseUrl: base.url, apiBaseUrl: api ? api.url : null, production: Boolean(e.production), isDefault: Boolean(e.is_default), useProjectAccounts: Boolean(e.use_project_accounts), variables };
    });
    const dataSetDocs = new DataSetStore(db).list(projectId).map((d) => {
        const secretCols = d.columns.filter(looksSensitive);
        for (const c of secretCols) need("test-data-column", `Test data “${d.name}”, column “${c}”`, "The values of this column were left out.");
        return { name: d.name, columns: d.columns, rows: d.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, secretCols.includes(k) ? "" : v]))) };
    });

    // Shared elements (object repository): the tests refer to them by name, so they travel with the tests. Absent when there are none.
    const objectDocs = new LocatorStore(db).list(projectId).map((e) => ({ name: e.name, kind: e.kind, ...(e.page ? { page: e.page } : {}), locator: e.locator, ...(e.notes ? { notes: e.notes } : {}) }));

    // Reusable steps (blocks): tests refer to them by name, so they travel with the tests. Absent when there are none.
    const blockDocs = new BlockStore(db).list(projectId).map((b) => ({ name: b.name, ...(b.description ? { description: b.description } : {}), kind: b.kind, params: b.params, steps: b.steps }));

    // ── schedules ──
    const scheduleDocs = new ScheduleStore(db).list(projectId).map((s) => {
        const link = runbooks.scheduleLink(s.id);
        return { name: s.name, kind: s.kind, cadence: s.cadence, retryFailures: s.retryFailures, environment: scheduleEnvironment(db, s.id).environment, runbook: runbookList.find((r) => r.id === link)?.name ?? null };
    });

    // ── things that hold secrets: named, never copied ──
    const channels = db.all<Row>("SELECT name, kind FROM alert_channels WHERE project_id = ? ORDER BY created_at", projectId).map((r) => ({ name: r.name as string, kind: r.kind as string }));
    for (const c of channels) need("alert-channel", `Alert channel “${c.name}” (${c.kind})`, "Its address and sign-in are not in the backup. Add the channel again.");
    for (const r of db.all<Row>("SELECT name, kind FROM integrations WHERE project_id = ? ORDER BY created_at", projectId)) need("issue-tracker", `Connection “${r.name}” (${r.kind})`, "Its access token is not in the backup. Connect it again.");
    const tokens = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM trigger_tokens WHERE project_id = ? AND revoked_at IS NULL", projectId)?.n ?? 0;
    if (tokens > 0) need("deploy-trigger", `${tokens} deploy trigger token${tokens === 1 ? "" : "s"}`, "Tokens are never exported. Create new ones for your pipelines.");
    try {
        for (const r of new IdentityStore(db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).get(projectId)) need("test-accounts", `Test account “${r.name}”`, "User name, password, authenticator secret and API token.");
    } catch {
        /* accounts that cannot be read (the key changed) are simply not listed */
    }

    const saved = retentionStore(p).saved(projectId);
    const projectDoc = {
        name: project.name as string,
        description: (project.description as string | null) ?? null,
        application,
        retention: saved ? { keepDays: saved.keepDays, keepFailedDays: saved.keepFailedDays, keepLatestRuns: saved.keepLatestRuns, maxArtifactMB: saved.maxArtifactMB ?? null } : null,
        ...(({ platforms, testingModes }) => ({ platforms, testingModes }))(projectSetupOf(project)),
    };

    // ── optional files ──
    const files: Zippable = {};
    const index: FilesIndex = { baselines: [], evidence: [] };
    if (opts.evidence) {
        let budget = Math.min(MAX_EVIDENCE_MB, Math.max(1, opts.maxEvidenceMB)) * 1024 * 1024;
        const read = async (rel: string): Promise<Uint8Array | null> => {
            try {
                const st = await p.store.head(rel);
                if (!st || st.size > BACKUP_LIMITS.maxFileBytes || st.size > budget) return null;
                return new Uint8Array(await p.store.getBytes(rel));
            } catch {
                return null;
            }
        };
        const clean = (n: string) => n.replace(/[^A-Za-z0-9._ ()@+=,-]/g, "_").slice(0, 100);
        for (const r of db.all<Row>("SELECT a.path, a.test_case_id FROM artifacts a WHERE a.project_id = ? AND a.kind = 'baseline' AND a.pruned_at IS NULL ORDER BY a.created_at", projectId)) {
            const testKey = keyOfId.get(r.test_case_id as string);
            const bytes = testKey ? await read(r.path as string) : null;
            if (!testKey || !bytes) continue;
            const name = clean(path.posix.basename(r.path as string));
            const entry = `baselines/${testKey}/${name}`;
            if (files[entry] || badEntryName(entry) || !isKnownEntry(entry)) continue;
            files[entry] = [bytes, { level: 0 }];
            budget -= bytes.length;
            index.baselines.push({ entry, testKey, name, size: bytes.length });
        }
        let n = 0;
        for (const r of db.all<Row>("SELECT a.kind, a.path, a.test_case_id, a.created_at FROM artifacts a WHERE a.project_id = ? AND a.pruned_at IS NULL AND a.execution_id IS NOT NULL ORDER BY a.created_at DESC", projectId)) {
            if (!isPrunableKind(r.kind as string)) continue;
            const bytes = await read(r.path as string);
            if (!bytes) continue;
            const ext = /\.([A-Za-z0-9]{1,5})$/.exec(r.path as string)?.[1] ?? "bin";
            const entry = `evidence/${String(++n).padStart(4, "0")}-${r.kind}.${ext}`;
            files[entry] = [bytes, { level: 0 }];
            budget -= bytes.length;
            index.evidence.push({ entry, testKey: keyOfId.get(r.test_case_id as string) ?? null, kind: r.kind as string, size: bytes.length, at: r.created_at as string });
            if (budget <= 0) break;
        }
    }

    // ── security assessment: absent for a project without security data, so its backup is as before ──
    const security = opts.withoutSecurity ? undefined : exportSecurityData(db, projectId);
    for (const n of security?.needs ?? []) need("application-sign-in", n.label, n.detail);

    const counts = {
        ...(security ? security.counts : {}),
        tests: testDocs.length,
        scripts: testDocs.reduce((s, t) => s + t.scripts.length, 0),
        manualCases: caseDocs.length,
        releases: releaseDocs.length,
        runbooks: runbookDocs.length,
        environments: environmentDocs.length,
        dataSets: dataSetDocs.length,
        schedules: scheduleDocs.length,
        alertChannels: channels.length,
        baselines: index.baselines.length,
        evidenceFiles: index.evidence.length,
        ...(customOf.size ? { customTests: customOf.size } : {}),
        ...(helperDocs.length ? { helpers: helperDocs.length } : {}),
        ...(blockDocs.length ? { blocks: blockDocs.length } : {}),
        ...(requirementDocs.length ? { requirements: requirementDocs.length } : {}),
    };
    const manifest: Manifest = { kind: BACKUP_KIND, format: BACKUP_FORMAT, platformVersion: await platformVersion(), createdAt: now(), project: { name: projectDoc.name }, includesFiles: opts.evidence, counts };

    const zip: Zippable = {
        "manifest.json": json(manifest),
        "project.json": json(projectDoc),
        "tests.json": json(testDocs),
        "manual-cases.json": json(caseDocs),
        ...(requirementDocs.length ? { "requirements.json": json(requirementDocs) } : {}),
        "releases.json": json(releaseDocs),
        "runbooks.json": json(runbookDocs),
        "environments.json": json(environmentDocs),
        "test-data.json": json(dataSetDocs),
        ...(objectDocs.length ? { "objects.json": json(objectDocs) } : {}),
        ...(blockDocs.length ? { "blocks.json": json(blockDocs) } : {}),
        ...(helperDocs.length ? { "helpers.json": json(helperDocs) } : {}),
        "schedules.json": json(scheduleDocs),
        "alert-channels.json": json(channels),
        "secrets-needed.json": json(needs),
        ...(opts.evidence ? { "files.json": json(index) } : {}),
        ...(security ? { "security.json": json(security.doc) } : {}),
        ...files,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    return { bytes: zipSync(zip, { level: 6 }), filename: `backup-${slugify(projectDoc.name)}-${stamp}.zip`, manifest };
}

// ═══ restore ════════════════════════════════════════════════════════════════

/** Unpack an untrusted zip with hard limits. Throws an HttpError that says what is wrong in plain words. */
export function unpackBackup(data: Uint8Array, limits: { [K in keyof typeof BACKUP_LIMITS]: number } = BACKUP_LIMITS): Map<string, Uint8Array> {
    if (data.length === 0) throw new HttpError(400, "The file is empty.");
    if (data.length > limits.maxZipBytes) throw new HttpError(413, `The file is larger than ${Math.round(limits.maxZipBytes / 1024 / 1024)} MB, which no backup from this platform is.`);
    // PK\x03\x04 (a zip with files) or PK\x05\x06 (an empty zip)
    if (!(data[0] === 0x50 && data[1] === 0x4b && (data[2] === 3 || data[2] === 5))) throw new HttpError(400, "That does not look like a backup file. Choose a .zip made by “Download backup”.");

    const out = new Map<string, Uint8Array>();
    const chunks = new Map<string, Uint8Array[]>();
    let total = 0;
    let entries = 0;
    // The zip library catches whatever a callback throws and carries on, so a refusal is remembered here and checked between slices.
    let failure: HttpError | undefined;
    const fail = (status: number, message: string) => {
        failure ??= new HttpError(status, message);
    };
    const u = new Unzip();
    u.register(UnzipInflate);
    u.onfile = (file) => {
        if (failure) return;
        const name = file.name;
        const bad = badEntryName(name);
        if (bad) return fail(400, `The file is not a backup this platform made: an entry ${bad}.`);
        if (++entries > limits.maxEntries) return fail(400, `The file holds more than ${limits.maxEntries} entries, which no backup from this platform does.`);
        if (!isKnownEntry(name)) return fail(400, `The file is not a backup this platform made: it holds “${name.slice(0, 60)}”, which a backup never contains.`);
        if (out.has(name) || chunks.has(name)) return fail(400, `The file is not a backup this platform made: “${name.slice(0, 60)}” appears twice.`);
        if (name.endsWith("/")) return; // a folder entry carries no data
        const limit = name.endsWith(".json") ? limits.maxJsonBytes : limits.maxFileBytes;
        // A declared size is only a hint (a hostile zip can lie); the real count below is what stops a bomb.
        if (typeof file.originalSize === "number" && file.originalSize > limit) return fail(413, `“${name.slice(0, 60)}” is larger than a backup file can be.`);
        const mine: Uint8Array[] = [];
        chunks.set(name, mine);
        let size = 0;
        file.ondata = (err, chunk, final) => {
            if (failure) return;
            if (err) return fail(400, "The backup file is damaged and could not be unpacked.");
            size += chunk.length;
            total += chunk.length;
            if (size > limit || total > limits.maxTotalBytes) return fail(413, "The backup unpacks to more data than a backup from this platform holds, so it was not opened.");
            mine.push(chunk);
            if (final) {
                const joined = new Uint8Array(size);
                let at = 0;
                for (const c of mine) (joined.set(c, at), (at += c.length));
                out.set(name, joined);
                chunks.delete(name);
            }
        };
        file.start();
    };
    try {
        // Fed in small slices: after a refusal nothing more is unpacked, so a bomb costs at most one slice's worth of work.
        const SLICE = 16 * 1024;
        for (let at = 0; at < data.length && !failure; at += SLICE) u.push(data.subarray(at, Math.min(data.length, at + SLICE)), at + SLICE >= data.length);
    } catch {
        fail(400, "The backup file is damaged and could not be unpacked.");
    }
    if (failure) throw failure;
    // Files whose final chunk never arrived mean a cut-off zip.
    if (chunks.size > 0) throw new HttpError(400, "The backup file is damaged: it ends in the middle of a file.");
    const problem = checkEntryList([...out.keys()]);
    if (problem) throw new HttpError(400, problem);
    return out;
}

function doc<T>(files: Map<string, Uint8Array>, name: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, empty: T): T {
    const raw = files.get(name);
    if (!raw) return empty;
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
        throw new HttpError(400, `The backup is damaged: ${name} is not readable.`);
    }
    const r = schema.safeParse(parsed);
    if (!r.success) {
        const i = r.error.issues[0];
        throw new HttpError(400, `The backup is damaged: ${name}${i?.path.length ? ` (${i.path.join(".")})` : ""}: ${i?.message ?? "invalid"}.`);
    }
    return r.data;
}

/** Read the manifest and refuse formats this version does not know, before looking at anything else. */
export function readManifest(files: Map<string, Uint8Array>): Manifest {
    const raw = files.get("manifest.json");
    if (!raw) throw new HttpError(400, "The file is not a backup this platform made: it has no manifest.json.");
    let parsed: any;
    try {
        parsed = JSON.parse(strFromU8(raw));
    } catch {
        throw new HttpError(400, "The backup is damaged: manifest.json is not readable.");
    }
    if (parsed?.kind !== BACKUP_KIND) throw new HttpError(400, "The file is not a backup this platform made.");
    if (typeof parsed.format !== "number" || !Number.isInteger(parsed.format) || parsed.format < 1) throw new HttpError(400, "The backup is damaged: its format version is missing.");
    if (parsed.format > BACKUP_FORMAT) {
        throw new HttpError(422, `This backup was made by a newer version of the platform (backup format ${parsed.format}; this version reads format ${BACKUP_FORMAT}). Update the platform and try again.`);
    }
    const m = ManifestSchema.safeParse(parsed);
    if (!m.success) throw new HttpError(400, `The backup is damaged: manifest.json: ${m.error.issues[0]?.message ?? "invalid"}.`);
    return m.data;
}

export interface RestoreResult {
    project: { id: string; name: string };
    restored: Record<string, number>;
    needsSecrets: SecretNeeded[];
    notes: string[];
    message: string;
}

const KNOWN_FRAMEWORKS = () => new Set<string>(listAdapters().map((a) => a.id));
const isImage = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** Create a new project from a backup. Nothing existing is changed. */
export async function restoreBackup(p: Platform, data: Uint8Array, opts: { name?: string } = {}): Promise<RestoreResult> {
    const files = unpackBackup(data);
    const manifest = readManifest(files);
    const notes: string[] = [];

    // ── everything is read and checked before anything is created ──
    const projectDoc = doc(files, "project.json", ProjectDocSchema, { name: manifest.project.name, description: null, application: null, retention: null });
    const testDocs = doc(files, "tests.json", z.array(TestEntrySchema).max(BACKUP_LIMITS.maxTests), []);
    const caseDocs = doc(files, "manual-cases.json", z.array(ManualCaseEntrySchema).max(2000), []);
    const releaseDocs = doc(files, "releases.json", z.array(ReleaseEntrySchema).max(500), []);
    const requirementDocs = doc(files, "requirements.json", z.array(RequirementBackupSchema).max(MAX_REQUIREMENTS), []);
    const runbookDocs = doc(files, "runbooks.json", z.array(RunbookEntrySchema).max(100), []);
    const envDocs = doc(files, "environments.json", z.array(EnvironmentEntrySchema).max(50), []);
    const dataSetDocs = doc(files, "test-data.json", z.array(DataSetEntrySchema).max(200), []);
    const objectDocs = doc(files, "objects.json", z.array(z.unknown()).max(1000), []).map((raw, i) => {
        const c = checkElement(raw);
        if (!c.ok) throw new HttpError(400, `The backup is damaged: shared element ${i + 1} is not valid (${c.error}).`);
        return c.element;
    });
    // Reusable steps pass the same checks again as when they were saved (a backup is a file someone may have edited): a circle, steps that are too deep or too large, a typed secret.
    const blockDocs: CheckedBlock[] = doc(files, "blocks.json", z.array(z.unknown()).max(MAX_BLOCKS), []).map((raw, i) => {
        const c = checkBlockInput(raw);
        if (!c.ok) throw new HttpError(400, `The backup is damaged: reusable steps ${i + 1} are not valid (${c.error}).`);
        if (blockSecretProblems(c.block).length) throw new HttpError(400, `The backup is not restored: the reusable steps “${c.block.name.slice(0, 40)}” hold what looks like a real secret.`);
        return c.block;
    });
    if (new Set(blockDocs.map((b) => b.name.toLowerCase())).size !== blockDocs.length) throw new HttpError(400, "The backup is damaged: two sets of reusable steps have the same name.");
    const blockProblem = blockGraphProblems(indexBlocks(blockDocs))[0];
    if (blockProblem) throw new HttpError(400, `The backup is not restored: ${blockProblem}`);
    const helperDocs = doc(files, "helpers.json", z.array(HelperEntrySchema).max(20), []);
    const scheduleDocs = doc(files, "schedules.json", z.array(ScheduleEntrySchema).max(100), []);
    const channelDocs = doc(files, "alert-channels.json", z.array(AlertChannelEntrySchema).max(100), []);
    const needDocs = doc(files, "secrets-needed.json", z.array(SecretNeededSchema).max(1000), []);
    const index = doc(files, "files.json", FilesIndexSchema, { baselines: [], evidence: [] });
    const securityDoc = doc(files, "security.json", SecurityBackupSchema.nullable(), null);
    const securityProblem = securityDoc ? securityBackupProblem(securityDoc) : undefined;
    if (securityProblem) throw new HttpError(400, securityProblem);

    const frameworks = KNOWN_FRAMEWORKS();
    // A code test only comes back if ALL of its code passes the safety check again (a backup is a file someone may have edited):
    // every script that can run and every version in its history. Only a Playwright test can be hand-written (taking over is refused for the
    // others), so a backup that says otherwise is damaged. The check is cheap, but a large backup can hold a lot of code: give the server a breath
    // between tests so one restore never holds up every other request.
    for (const t of testDocs) {
        if (!t.custom) continue;
        if (t.framework !== "playwright" && t.framework !== "playwright-api") throw new HttpError(400, `The backup is damaged: the code test ${t.testKey} uses a format (${t.framework.slice(0, 40)}) that cannot be hand-written.`);
        const code = [...t.scripts.filter((s) => s.executable).map((s) => s.content), ...t.custom.versions.map((v) => v.content)];
        if (code.some((c) => !checkScript(c, { kind: "test" }).ok)) throw new HttpError(400, `The backup is not restored: the code test ${t.testKey} does not pass the safety check.`);
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // A test of an adapter plug-in framework that is not loaded on this server is restored all the same (nothing in a backup is lost): it only cannot
    // run until the plug-in is loaded. The name has to look like a plug-in's adapter id, and the framework must not be one of the built-in ones.
    const missingPlugins = new Map<string, number>();
    for (const t of testDocs) if (!frameworks.has(t.framework) && ADAPTER_ID.test(t.framework)) missingPlugins.set(t.framework, (missingPlugins.get(t.framework) ?? 0) + 1);
    for (const [id, n] of missingPlugins) notes.push(`${n} test${n === 1 ? " uses" : "s use"} the plug-in framework "${id}", which is not loaded on this server. ${n === 1 ? "It was" : "They were"} restored with the scripts and will run once the plug-in is loaded.`);
    const keys = new Set<string>();
    const tests = testDocs.map((t, i) => {
        if (keys.has(t.testKey)) throw new HttpError(400, `The backup is damaged: the test ${t.testKey} appears twice.`);
        keys.add(t.testKey);
        if (!frameworks.has(t.framework) && !missingPlugins.has(t.framework)) throw new HttpError(400, `The backup is damaged: test ${t.testKey} uses an unknown format “${t.framework.slice(0, 40)}”.`);
        const parsed = TestSpecSchema.safeParse(t.spec);
        if (!parsed.success) throw new HttpError(400, `The backup is damaged: test ${t.testKey} is not a valid test (${parsed.error.issues[0]?.path.join(".") || `entry ${i + 1}`}: ${parsed.error.issues[0]?.message}).`);
        const spec: TestSpec = { ...parsed.data, testId: t.testKey };
        // A test that uses reusable steps must find them (with their values) in the backup.
        const expanded = tryExpandBlocks(spec, blockDocs.length ? indexBlocks(blockDocs) : undefined);
        if (!expanded.ok) throw new HttpError(400, `The backup is damaged: test ${t.testKey} cannot use its reusable steps (${expanded.error}).`);
        const scripts = t.scripts.filter((s) => {
            const ok = (frameworks.has(s.framework) || missingPlugins.has(s.framework)) && SAFE_FILENAME.test(s.filename);
            if (!ok) notes.push(`A script of test ${t.testKey} was skipped because its name or format is not valid.`);
            return ok;
        });
        return { ...t, spec, scripts };
    });

    for (const h of helperDocs) if (!checkScript(h.content, { kind: "helper" }).ok) throw new HttpError(400, `The backup is not restored: the helper ${h.name} does not pass the safety check.`);

    const url = projectDoc.application?.url;
    if (url) {
        try {
            const u = new URL(url);
            if (!/^https?:$/.test(u.protocol) && u.protocol !== "android-app:" && u.protocol !== "windows-app:") throw new Error("scheme");
        } catch {
            throw new HttpError(400, "The backup is damaged: the application address is not valid.");
        }
    }
    for (const t of tests) if (t.spec.kind !== "mobile" && !url) notes.push(`${t.testKey} needs an application address; add one in “Analyze again” before running it.`);

    // ── files first (under the NEW project's own folder, named by an id made here), then the database in one synchronous stretch ──
    const pid = randomUUID();
    const name = (opts.name?.trim() || `${projectDoc.name} (restored)`).slice(0, 120);
    const scriptRows: Array<{ id: string; testKey: string; framework: string; filename: string; content: string; hash: string; rel: string; executable: boolean }> = [];
    const baselineRows: Array<{ testKey: string; rel: string; size: number }> = [];
    const slugOf = (suiteSlug: string) => slugify(suiteSlug) || "general";
    try {
        for (const t of tests) {
            for (const s of t.scripts) {
                const rel = path.posix.join(pid, slugOf(t.suite.slug), s.filename);
                const stored = await putText(p.store, rel, s.content);
                scriptRows.push({ id: randomUUID(), testKey: t.testKey, framework: s.framework, filename: s.filename, content: s.content, hash: stored.hash, rel, executable: s.executable });
            }
        }
        for (const b of index.baselines) {
            const bytes = files.get(b.entry);
            const file = path.posix.basename(b.entry);
            if (!bytes || !keys.has(b.testKey) || !SAFE_FILENAME.test(file) || !isImage(bytes)) {
                notes.push(`A baseline screenshot (${b.name.slice(0, 40)}) was not restored because it is missing or is not an image.`);
                continue;
            }
            const rel = path.posix.join(pid, "_baselines", b.testKey, file);
            await p.store.put(rel, bytes, { contentType: "image/png" });
            baselineRows.push({ testKey: b.testKey, rel, size: bytes.length });
        }
    } catch (e) {
        await p.store.deletePrefix(pid).catch(() => undefined);
        throw e instanceof HttpError ? e : new HttpError(500, "The backup could not be restored: its files could not be written.");
    }

    const { repo, db } = p;
    const counts: Record<string, number> = { tests: 0, scripts: 0, manualCases: 0, releases: 0, runbooks: 0, environments: 0, dataSets: 0, schedules: 0, baselines: 0 };
    try {
        // From here to the return there is no await: nothing else can run between these statements. If one fails, the project is removed again.
        const stamp = now();
        db.run("INSERT INTO projects (id, owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)", pid, repo.ensureDefaultUser(), name, projectDoc.description, stamp, stamp);
        // A backup from round 26 on carries what the project tests and how; an older one keeps the defaults.
        if (projectDoc.platforms || projectDoc.testingModes) repo.updateProject(pid, { ...(projectDoc.platforms ? { platforms: projectDoc.platforms } : {}), ...(projectDoc.testingModes ? { testingModes: projectDoc.testingModes } : {}) });
        if (projectDoc.application) {
            repo.createApplication(pid, projectDoc.application.url, { ...projectDoc.application.config });
            // What the agents need (agent-inputs-store.ts): the OpenAPI address and the data-changing choice come back with the application;
            // the sign-in and API access are never in a backup and are typed again (the restore says so).
            const c = projectDoc.application.config as { openApiUrl?: unknown; allowMutatingApiTests?: unknown };
            new AgentInputsStore(db, new SecretBox(p.config.dataDir, p.config.SECRET_KEY)).save(pid, { site: projectDoc.application.url, ...(typeof c.openApiUrl === "string" && c.openApiUrl ? { openApiUrl: c.openApiUrl } : {}), ...(typeof c.allowMutatingApiTests === "boolean" ? { allowMutatingApiTests: c.allowMutatingApiTests } : {}) });
        }

        // Shared elements first: the restored tests refer to them by name.
        const locatorStore = new LocatorStore(db);
        for (const e of objectDocs) {
            try {
                locatorStore.create(pid, e);
            } catch {
                notes.push(`A shared element called “${e.name.slice(0, 40)}” was skipped because its name is used twice.`);
            }
        }
        const blockStore = new BlockStore(db);
        for (const b of blockDocs) {
            blockStore.create(pid, b);
            counts.blocks = (counts.blocks ?? 0) + 1;
        }
        const idOfKey = new Map<string, string>();
        for (const t of tests) {
            const suiteId = repo.getOrCreateSuite(pid, t.suite.name, slugOf(t.suite.slug));
            const id = repo.insertTest({ projectId: pid, suiteId, jobId: null, spec: t.spec, framework: t.framework as Framework, validationStatus: "PENDING", meta: { restored: true, restoredAt: stamp, backupMadeAt: manifest.createdAt } });
            repo.updateTest(id, { reason: "Restored from a backup. Run it again to check that it still works." });
            idOfKey.set(t.testKey, id);
            counts.tests!++;
        }
        // Code tests: the flag, the archived spec and the script history. The run policy still decides where they may run.
        const customRestore = new CustomScriptStore(db);
        for (const t of tests) {
            if (!t.custom) continue;
            const id = idOfKey.get(t.testKey)!;
            const script = t.scripts.find((s) => s.executable);
            customRestore.mark(id, pid, { origin: t.custom.origin, ...(t.custom.specArchive !== undefined ? { specArchive: t.custom.specArchive } : {}), ...(t.custom.git ? { git: t.custom.git } : {}), imports: script ? checkScript(script.content, { kind: "test" }).helperImports : [] });
            for (const v of t.custom.versions) customRestore.addVersion(id, { content: v.content, kind: v.kind, note: v.note, force: true, version: v.version });
            counts.customTests = (counts.customTests ?? 0) + 1;
        }
        for (const h of helperDocs) {
            customRestore.putHelper(pid, h.name, h.content, checkScript(h.content, { kind: "helper" }).helperImports);
            counts.helpers = (counts.helpers ?? 0) + 1;
        }
        for (const s of scriptRows) {
            const testId = idOfKey.get(s.testKey)!;
            const cur = db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM generated_scripts WHERE test_case_id = ? AND framework = ?", testId, s.framework);
            db.run("UPDATE generated_scripts SET is_current = 0 WHERE test_case_id = ? AND framework = ?", testId, s.framework);
            db.run(
                "INSERT INTO generated_scripts (id, test_case_id, framework, filename, content, content_hash, storage_path, version, is_current, executable, created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)",
                s.id, testId, s.framework, s.filename, s.content, s.hash, s.rel, (cur?.v ?? 0) + 1, s.executable ? 1 : 0, stamp,
            );
            counts.scripts!++;
        }
        // Code tests got their code after their first version was made: record it now, so the restored code is reviewed like an import
        // (a run never approves what it finds; review-store.ts).
        for (const t of tests) if (t.custom) trackTestVersion(db, idOfKey.get(t.testKey)!, "import");
        for (const b of baselineRows) {
            repo.addArtifact({ projectId: pid, testId: idOfKey.get(b.testKey)!, kind: "baseline", path: b.rel, size: b.size });
            counts.baselines!++;
        }

        // manual cases (ids remapped; links point at the new tests). A case keeps its number unless the document has none for it or gives
        // it twice (case numbers are unique in a project): then it takes the next free one.
        const caseIds = new Map<string, string>();
        const takenNumbers = new Set<number>();
        for (const c of caseDocs) {
            const id = randomUUID();
            caseIds.set(c.ref, id);
            const number = typeof c.number === "number" && !takenNumbers.has(c.number) ? c.number : null;
            if (number !== null) takenNumbers.add(number);
            db.run(
                `INSERT INTO manual_cases (id, project_id, title, area, priority, requirement, steps_json, linked_json, automation, number, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,COALESCE(?, (SELECT COALESCE(MAX(number), 0) + 1 FROM manual_cases WHERE project_id = ?)),?,?)`,
                id, pid, c.title, c.area, c.priority, c.requirement, JSON.stringify(c.steps), JSON.stringify(c.linkedTests.map((k) => idOfKey.get(k)).filter(Boolean)), c.automation, number, pid, stamp, stamp,
            );
            takenNumbers.add(db.get<{ n: number }>("SELECT number AS n FROM manual_cases WHERE id = ?", id)!.n);
            counts.manualCases!++;
        }
        if (requirementDocs.length) counts.requirements = restoreRequirements(db, pid, requirementDocs, idOfKey, caseIds);
        // The requirement each case comes from, by its reference (the requirements have new ids now).
        for (const c of caseDocs) {
            if (!c.requirementRef) continue;
            db.run("UPDATE manual_cases SET requirement_id = (SELECT id FROM requirements WHERE project_id = ? AND ref_key = ?) WHERE id = ?", pid, refKey(c.requirementRef), caseIds.get(c.ref)!);
        }
        for (const r of releaseDocs) {
            const rid = randomUUID();
            const frozen = remapFrozen(r.frozen, caseIds);
            db.run(
                "INSERT INTO releases (id, project_id, name, notes, status, snapshot_json, snapshot_at, frozen_json, signed_at, signed_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                rid, pid, r.name, r.notes, r.status, r.snapshot ? JSON.stringify(r.snapshot) : null, r.snapshotAt, frozen ? JSON.stringify(frozen) : null, r.signedAt, r.signedBy, r.createdAt, r.updatedAt,
            );
            for (const x of r.results) {
                const caseId = caseIds.get(x.caseRef);
                if (!caseId) continue;
                db.run(
                    "INSERT INTO release_results (release_id, case_id, result, note, by_name, at, issue_provider, issue_external_id, issue_url) VALUES (?,?,?,?,?,?,?,?,?)",
                    rid, caseId, x.result, x.note, x.by, x.at, x.issue?.provider ?? null, x.issue?.externalId ?? null, x.issue?.url ?? null,
                );
            }
            for (const a of r.audit) {
                db.run("INSERT INTO release_audit (release_id, project_id, at, kind, by_name, comment, override, state_json) VALUES (?,?,?,?,?,?,?,?)", rid, pid, a.at, a.kind, a.by, a.comment, a.override ? 1 : 0, JSON.stringify(a.state ?? {}));
            }
            counts.releases!++;
        }

        // environments, then test data
        const envNames = new Set<string>();
        for (const e of envDocs) {
            if (!ENV_NAME.test(e.name) || envNames.has(e.name) || envNames.size >= MAX_ENVIRONMENTS) {
                notes.push(`Environment “${e.name.slice(0, 30)}” was skipped (its name is not valid, repeated, or there are too many).`);
                continue;
            }
            envNames.add(e.name);
            db.run(
                "INSERT INTO project_environments (id, project_id, name, base_url, api_base_url, production, is_default, use_project_accounts, variables_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                randomUUID(), pid, e.name, e.baseUrl, e.apiBaseUrl, e.production ? 1 : 0, e.isDefault && !e.production ? 1 : 0, e.useProjectAccounts ? 1 : 0, JSON.stringify(e.variables), stamp, stamp,
            );
            counts.environments!++;
        }
        const dataSets = new DataSetStore(db);
        for (const d of dataSetDocs) {
            try {
                if (!DATA_SET_NAME.test(d.name)) throw new Error("name");
                dataSets.save(pid, d.name, { columns: d.columns, rows: d.rows });
                counts.dataSets!++;
            } catch {
                notes.push(`Test data “${d.name.slice(0, 30)}” was skipped because it is not valid.`);
            }
        }

        // runbooks, then schedules (switched off)
        const runbooks = new RunbookStore(db);
        const runbookIds = new Map<string, string>();
        for (const r of runbookDocs) {
            const parsed = RunbookDefinition.safeParse(r.definition);
            if (!parsed.success) {
                notes.push(`Runbook “${r.name.slice(0, 40)}” was skipped because it is not valid.`);
                continue;
            }
            runbookIds.set(r.name, runbooks.create(pid, parsed.data).id);
            counts.runbooks!++;
        }
        const schedules = new ScheduleStore(db);
        for (const s of scheduleDocs) {
            const cadence = CadenceSchema.safeParse(s.cadence);
            if (!cadence.success) {
                notes.push(`Schedule “${s.name.slice(0, 40)}” was skipped because its timing is not valid.`);
                continue;
            }
            const made = schedules.create({ projectId: pid, name: s.name, kind: s.kind, cadence: cadence.data, enabled: false, retryFailures: s.retryFailures });
            if (s.environment && envNames.has(s.environment)) setScheduleEnvironment(db, made.id, { environment: s.environment, confirmProduction: false });
            else if (s.environment) notes.push(`Schedule “${s.name.slice(0, 40)}” ran against environment “${s.environment}”, which was not restored; it now uses the project address.`);
            if (s.runbook && runbookIds.has(s.runbook)) runbooks.setScheduleLink(made.id, runbookIds.get(s.runbook)!);
            counts.schedules!++;
        }
        if (counts.schedules! > 0) notes.push("Schedules were restored switched off. Switch them on when you are ready.");

        // retention comes back switched off, and only if it still fits today's limits
        if (projectDoc.retention) {
            const pol = RetentionPolicySchema.safeParse({ enabled: false, ...projectDoc.retention });
            if (pol.success) retentionStore(p).save(pid, pol.data);
        }

        // security assessment data: authorizations come back withdrawn, unfinished assessments cancelled, evidence redacted again
        if (securityDoc) {
            const sec = importSecurityData(db, pid, securityDoc);
            Object.assign(counts, sec.counts);
            notes.push(...sec.notes);
        }

        const needsSecrets: SecretNeeded[] = [
            ...needDocs,
            ...channelDocs.filter((c) => !needDocs.some((n) => n.kind === "alert-channel" && n.label.includes(`“${c.name}”`))).map((c) => ({ kind: "alert-channel" as const, label: `Alert channel “${c.name}” (${c.kind})`, detail: "Add the channel again." })),
        ];
        retentionStore(p).addNeeds(pid, needsSecrets);
        forgetUsage(p);

        const total = counts.tests ?? 0;
        const secretsLine = needsSecrets.length ? ` ${needsSecrets.length === 1 ? "1 item needs" : `${needsSecrets.length} items need`} a secret entered again.` : "";
        // Round 21: a project with security data but no tests says what came back of it; one with tests keeps its wording plus a security line.
        const security = securityDoc ? securityRestoreWords(counts) : "";
        const message =
            security && total === 0
                ? `Restored the security assessment data into a new project, “${name}”: ${security}. Nothing has been run.${secretsLine}`
                : `Restored ${total === 1 ? "1 test" : `${total} tests`} into a new project, “${name}”. Nothing has been run: the tests are waiting for you to run them.${security ? ` Security assessment data: ${security}.` : ""}${secretsLine}`;
        return {
            project: { id: pid, name },
            restored: counts,
            needsSecrets,
            notes,
            message,
        };
    } catch (e) {
        // Compensation: the project row owns everything the restore created, so removing it (and the files) leaves nothing behind.
        try {
            db.run("DELETE FROM artifacts WHERE project_id = ?", pid);
            db.run("DELETE FROM projects WHERE id = ?", pid);
            forgetSecurityData(db, pid);
        } catch {
            /* nothing more can be done */
        }
        await p.store.deletePrefix(pid).catch(() => undefined);
        if (e instanceof HttpError) throw e;
        throw new HttpError(500, "The backup could not be restored. Nothing was created.");
    }
}

/** A signed release keeps its checks frozen; their ids are case ids, which are new on restore. */
function remapFrozen(frozen: unknown, caseIds: Map<string, string>): unknown {
    if (!frozen || typeof frozen !== "object") return null;
    const f = frozen as { items?: Array<Record<string, unknown>> };
    if (!Array.isArray(f.items)) return frozen;
    return { ...f, items: f.items.map((i) => ({ ...i, id: caseIds.get(String(i.id)) ?? i.id })) };
}
