/**
 * The project backup file: what is in it, how it is checked, and how hostile zips are refused. Pure (no I/O).
 *
 * A backup is a zip of small JSON documents (plus, on request, approved visual baselines and recent evidence files).
 * Secrets are never written: passwords, tokens, webhook addresses and the like are listed by name in `secrets-needed.json`
 * so the person restoring knows what to enter again. Reading is defensive: a zip is untrusted input, every name, size and
 * document is checked before anything is created.
 */
import { z } from "zod";

export const BACKUP_FORMAT = 1;
export const BACKUP_KIND = "ai-testing-platform-project-backup";

/** Limits on a backup being restored. */
export const BACKUP_LIMITS = {
    /** The zip as uploaded. */
    maxZipBytes: 256 * 1024 * 1024,
    maxEntries: 20_000,
    /** Any one JSON document, once unpacked. */
    maxJsonBytes: 32 * 1024 * 1024,
    /** One file inside baselines/ or evidence/, once unpacked. */
    maxFileBytes: 32 * 1024 * 1024,
    /** Everything in the zip, once unpacked: stops a zip bomb however its headers describe it. */
    maxTotalBytes: 512 * 1024 * 1024,
    maxTests: 5000,
} as const;

/** The documents a backup holds. Anything else in a zip is refused. */
export const DOCUMENTS = ["manifest.json", "project.json", "tests.json", "manual-cases.json", "releases.json", "runbooks.json", "environments.json", "test-data.json", "objects.json", "blocks.json", "schedules.json", "alert-channels.json", "secrets-needed.json", "files.json", "helpers.json", "security.json"] as const;
export const BASELINE_DIR = "baselines/";
export const EVIDENCE_DIR = "evidence/";

const SAFE_PART = /^[A-Za-z0-9._ ()@+=,-]{1,120}$/;

/** Why a zip entry name must not be trusted, or null when it is fine. Names are only ever used as keys, never as file paths. */
export function badEntryName(name: string): string | null {
    if (name.length === 0 || name.length > 240) return "has an empty or very long name";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(name)) return "has a control character in its name";
    if (name.includes("\\")) return "uses a backslash in its name";
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "has an absolute path";
    const parts = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return "tries to leave its folder";
    if (parts.some((p) => !SAFE_PART.test(p))) return "has characters a backup never uses in a name";
    return null;
}

/** Is this a name a backup may contain? (After `badEntryName` found nothing wrong.) */
export function isKnownEntry(name: string): boolean {
    if (name.endsWith("/")) return name === BASELINE_DIR || name === EVIDENCE_DIR || /^(baselines|evidence)\/[^/]+\/$/.test(name);
    if ((DOCUMENTS as readonly string[]).includes(name)) return true;
    // baselines/<testKey>/<file>.png, evidence/<file>
    if (/^baselines\/[^/]+\/[^/]+\.(png|jpg|jpeg)$/i.test(name)) return true;
    return /^evidence\/[^/]+$/.test(name);
}

/** Stop-reason for a zip's entry list before any of it is unpacked. */
export function checkEntryList(names: string[]): string | null {
    if (names.length === 0) return "The file is empty.";
    if (names.length > BACKUP_LIMITS.maxEntries) return `The file holds more than ${BACKUP_LIMITS.maxEntries} entries, which no backup from this platform does.`;
    const seen = new Set<string>();
    for (const n of names) {
        const bad = badEntryName(n);
        if (bad) return `The file is not a backup this platform made: an entry ${bad}.`;
        if (!isKnownEntry(n)) return `The file is not a backup this platform made: it holds “${n.slice(0, 60)}”, which a backup never contains.`;
        if (seen.has(n)) return `The file is not a backup this platform made: “${n.slice(0, 60)}” appears twice.`;
        seen.add(n);
    }
    if (!seen.has("manifest.json")) return "The file is not a backup this platform made: it has no manifest.json.";
    return null;
}

// ── documents ───────────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max);
const url = z.string().max(2000);

export const ManifestSchema = z.object({
    kind: z.literal(BACKUP_KIND),
    format: z.number().int(),
    platformVersion: text(40),
    createdAt: text(40),
    project: z.object({ name: text(200) }),
    includesFiles: z.boolean().default(false),
    counts: z.record(z.number().int().min(0)).default({}),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const ProjectDocSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: text(1000).nullable().default(null),
    application: z.object({ url, config: z.record(z.unknown()).default({}) }).nullable().default(null),
    retention: z.object({ keepDays: z.number(), keepFailedDays: z.number(), keepLatestRuns: z.number(), maxArtifactMB: z.number().nullable().optional() }).nullable().default(null),
    /** What the project tests and how (round 26). Absent from older backups: the restore then uses the defaults. */
    platforms: z.array(z.enum(["web", "android", "ios"])).min(1).optional(),
    testingModes: z.array(z.enum(["agent", "code"])).min(1).optional(),
});
export type ProjectDoc = z.infer<typeof ProjectDocSchema>;

export const TestEntrySchema = z.object({
    testKey: z.string().min(1).max(60),
    suite: z.object({ name: z.string().min(1).max(120), slug: z.string().min(1).max(60) }),
    framework: z.string().min(1).max(40),
    spec: z.unknown(),
    scripts: z.array(z.object({ framework: z.string().min(1).max(40), filename: z.string().min(1).max(160), content: z.string().max(2_000_000), executable: z.boolean() })).max(10).default([]),
    /** A hand-written test (absent for generated ones): where it came from, the archived spec to go back to, and its script history. */
    custom: z
        .object({
            origin: z.enum(["taken-over", "git", "written"]),
            specArchive: z.unknown().optional(),
            git: z.object({ host: text(200), path: text(300), ref: text(200), commit: text(80), importedAt: text(40), file: text(300).optional() }).optional(),
            versions: z.array(z.object({ version: z.number().int().min(0).max(1_000_000), content: z.string().max(200_000), kind: z.enum(["generated", "taken-over", "edited", "git", "restored"]), note: text(200).nullable().default(null), createdAt: text(40).optional() })).max(101).default([]).refine((vs) => new Set(vs.map((v) => v.version)).size === vs.length, { message: "two versions of a hand-written test have the same number" }),
        })
        .optional(),
});
export type TestEntry = z.infer<typeof TestEntrySchema>;

const Step = z.object({ action: z.string().max(1000), expected: z.string().max(1000).default("") });
export const ManualCaseEntrySchema = z.object({
    ref: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    area: z.string().min(1).max(200),
    priority: z.enum(["critical", "high", "medium", "low"]),
    requirement: z.string().max(1000).default(""),
    steps: z.array(Step).max(50),
    /** Test keys (WEB-001...) of the tests the case is linked to. */
    linkedTests: z.array(z.string().max(100)).max(100).default([]),
});
export type ManualCaseEntry = z.infer<typeof ManualCaseEntrySchema>;

export const ReleaseEntrySchema = z.object({
    name: z.string().min(1).max(300),
    notes: z.string().max(5000).default(""),
    status: z.enum(["open", "approved", "rejected"]),
    snapshot: z.unknown().nullable().default(null),
    snapshotAt: text(40).nullable().default(null),
    /** The frozen state of a signed release; item ids are case refs. */
    frozen: z.unknown().nullable().default(null),
    signedAt: text(40).nullable().default(null),
    signedBy: text(300).nullable().default(null),
    createdAt: text(40),
    updatedAt: text(40),
    results: z
        .array(
            z.object({
                caseRef: z.string().max(100),
                result: z.enum(["not_run", "passed", "failed", "blocked", "skipped"]),
                note: z.string().max(5000).default(""),
                by: z.string().max(300).default(""),
                at: text(40),
                issue: z.object({ provider: z.string().max(40), externalId: z.string().max(200), url: url }).nullable().default(null),
            }),
        )
        .max(5000)
        .default([]),
    audit: z
        .array(z.object({ at: text(40), kind: z.enum(["approved", "rejected", "reopened"]), by: z.string().max(300), comment: z.string().max(5000).default(""), override: z.boolean().default(false), state: z.unknown().default({}) }))
        .max(500)
        .default([]),
});
export type ReleaseEntry = z.infer<typeof ReleaseEntrySchema>;

export const RunbookEntrySchema = z.object({ name: z.string().min(1).max(80), definition: z.unknown() });
export const EnvironmentEntrySchema = z.object({
    name: z.string().min(1).max(40),
    baseUrl: url,
    apiBaseUrl: url.nullable().default(null),
    production: z.boolean().default(false),
    isDefault: z.boolean().default(false),
    useProjectAccounts: z.boolean().default(true),
    variables: z.record(z.string().max(1000)).default({}),
});
export const DataSetEntrySchema = z.object({ name: z.string().min(1).max(60), columns: z.array(z.string().max(60)).max(40), rows: z.array(z.record(z.string().max(1000))).max(1000) });
export const ScheduleEntrySchema = z.object({
    name: z.string().min(1).max(80),
    kind: z.enum(["validate", "generate"]),
    /** Checked against the schedule rules when restoring. */
    cadence: z.unknown(),
    retryFailures: z.number().int().min(0).max(3).default(1),
    environment: z.string().max(40).nullable().default(null),
    runbook: z.string().max(80).nullable().default(null),
});
/** A shared helper module of hand-written tests. */
export const HelperEntrySchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), content: z.string().max(100_000) });
export const AlertChannelEntrySchema = z.object({ name: z.string().max(200), kind: z.string().max(40) });

export const SecretNeededSchema = z.object({
    kind: z.enum(["application-sign-in", "test-accounts", "environment-sign-in", "environment-variable", "test-data-column", "alert-channel", "issue-tracker", "deploy-trigger", "runbook-notify", "address"]),
    label: z.string().max(300),
    detail: z.string().max(600).optional(),
});
export type SecretNeeded = z.infer<typeof SecretNeededSchema>;

/** Evidence/baseline files listed with where they came from (documents above never contain file bytes). */
export const FilesIndexSchema = z.object({
    baselines: z.array(z.object({ entry: z.string().max(240), testKey: z.string().max(60), name: z.string().max(160), size: z.number().int().min(0) })).max(5000).default([]),
    evidence: z.array(z.object({ entry: z.string().max(240), testKey: z.string().max(60).nullable().default(null), kind: z.string().max(40), size: z.number().int().min(0), at: text(40) })).max(20_000).default([]),
});
export type FilesIndex = z.infer<typeof FilesIndexSchema>;

export const array = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max);

// ── what a name or a value must not carry ───────────────────────────────────

const SENSITIVE_NAME = /pass(word|wd|phrase)?|secret|token|api[-_ ]?key|auth|credential|private[-_ ]?key|bearer|cookie|session|signature|\bsig\b|\bpwd\b/i;
/** Does a variable or column name look like it holds a secret? Such values are not written to a backup. */
export const looksSensitive = (name: string): boolean => SENSITIVE_NAME.test(name);

/**
 * An address without anything that could be a secret in it: no user name or password, and no value for a query parameter whose
 * name looks sensitive. Returns the cleaned address and whether something was removed.
 */
export function scrubUrl(raw: string): { url: string; changed: boolean } {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { url: raw, changed: false };
    }
    let changed = false;
    if (u.username || u.password) {
        u.username = "";
        u.password = "";
        changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
        if (looksSensitive(key)) {
            u.searchParams.delete(key);
            changed = true;
        }
    }
    // Anything after '#' may carry an access token (OAuth fragments); a backup never needs it.
    if (u.hash && /(token|key|secret|auth|pass|code)=/i.test(u.hash)) {
        u.hash = "";
        changed = true;
    }
    return { url: changed ? u.toString() : raw, changed };
}
