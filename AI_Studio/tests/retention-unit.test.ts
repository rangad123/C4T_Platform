/**
 * Storage, retention and backup, browser-free and database-free:
 *  - the retention rule table (outcome and age over every kind of run file, nothing kept past expiry, the size limit);
 *  - policy bounds and the platform default;
 *  - size and message wording, the storage kind helpers, the web helpers;
 *  - the backup documents' schemas, secret scrubbing, entry-name safety and hostile zips (traversal, too many entries, bombs, bad JSON,
 *    unknown versions).
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_KIND, BACKUP_LIMITS, badEntryName, checkEntryList, isKnownEntry, looksSensitive, ManifestSchema, ReleaseEntrySchema, scrubUrl, TestEntrySchema } from "../src/engine/retention/backup-model.js";
import { evidenceExpiredMessage, formatBytes, formatDate, previewSentence, prunedMessage } from "../src/engine/retention/format.js";
import { DEFAULT_POLICY, limitProblem, mergePolicy, platformDefaultDays, platformDefaultOff, policyFromPlatformDefault, retentionLimits, RetentionPolicySchema, withinLimits, type RetentionPolicy } from "../src/engine/retention/policy.js";
import { DAY_MS, isPrunableKind, planPrune, type RetentionArtifact, type RetentionExecution, type RetentionInput } from "../src/engine/retention/rules.js";
import { scrubConfig, unpackBackup, readManifest } from "../src/platform/backup.js";
import { knownSchemaVersion } from "../src/platform/db.js";
import { usageKindOfArtifact, usageKindOfPath } from "../src/platform/storage-usage.js";
import { fileLabel, prunedNote, sizeBar, STORAGE_KIND_LABELS } from "../web/src/features/storage/storage.js";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
/** The decided defaults: failed runs' files 7 days, passed runs' records 30 days. */
const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ ...DEFAULT_POLICY, ...over });

let n = 0;
const exec = (daysAgo: number, passed = true): RetentionExecution => ({ id: `e${++n}`, startedAt: NOW - daysAgo * DAY_MS, passed });
const art = (e: RetentionExecution | null, kind = "screenshot", size = 1000): RetentionArtifact => ({ id: `a${++n}`, kind, size, executionId: e?.id ?? null, at: e ? e.startedAt : NOW - 400 * DAY_MS });
const plan = (executions: RetentionExecution[], artifacts: RetentionArtifact[], over: Partial<RetentionInput> = {}) => planPrune({ now: NOW, policy: policy(), executions, artifacts, ...over });
const ids = (p: ReturnType<typeof plan>) => p.prune.map((x) => x.id).sort();
const justOver = (days: number, passed: boolean) => ({ ...exec(days, passed), startedAt: NOW - days * DAY_MS - 1 });

describe("retention rules: outcome and age (fake clock)", () => {
    it("a failed run's trace, video, screenshot and evidence stay exactly 7 days and go a moment later", () => {
        const exactly = exec(7, false);
        const older = justOver(7, false);
        const kinds = ["trace", "video", "screenshot", "evidence"];
        const keep = kinds.map((k) => art(exactly, k));
        const go = kinds.map((k) => art(older, k));
        const p = plan([exactly, older], [...keep, ...go]);
        expect(ids(p)).toEqual(go.map((a) => a.id).sort());
        expect(p.byReason["age-failed"]).toBe(4);
    });

    it("a passed run's records (evidence, screenshots) stay exactly 30 days and go a moment later", () => {
        const at7 = exec(8);
        const exactly = exec(30);
        const older = justOver(30, true);
        const keep = [art(at7, "evidence"), art(exactly, "evidence"), art(exactly, "screenshot")];
        const go = [art(older, "evidence"), art(older, "vision-shot")];
        const p = plan([at7, exactly, older], [...keep, ...go]);
        expect(ids(p)).toEqual(go.map((a) => a.id).sort());
        expect(p.byReason.age).toBe(2);
    });

    it("a passed run keeps no trace or recording: they go at the next pass, whatever their age", () => {
        const today = exec(0);
        const files = [art(today, "trace"), art(today, "video"), art(today, "evidence")];
        const p = plan([today], files);
        expect(ids(p)).toEqual([files[0]!.id, files[1]!.id].sort());
        expect(p.byReason["passed-media"]).toBe(2);
    });

    it("covers every kind of file a run stores, including a kind added later (a passed run's footprint, an unknown kind)", () => {
        const passed = justOver(30, true);
        const failed = justOver(7, false);
        const files = [art(passed, "footprint"), art(passed, "something-new"), art(failed, "something-new"), art(failed, "evidence")];
        expect(plan([passed, failed], files).files).toBe(4);
        expect(isPrunableKind("something-new")).toBe(false); // the backup's list, not what expiry looks at
    });

    it("removes nothing from a project whose files are all recent", () => {
        const e = [exec(1), exec(2, false), exec(6, false), exec(29)];
        expect(plan(e, e.map((x) => art(x, "evidence"))).files).toBe(0);
    });
});

describe("retention rules: run rows past their period lose their details (fake clock)", () => {
    it("lists runs strictly past 7 days (failed) or 30 days (passed) that still hold details, with or without files", () => {
        const failedExact = exec(7, false);
        const failedOver = justOver(7, false);
        const passedExact = exec(30);
        const passedOver = justOver(30, true);
        const passedEight = exec(8); // a passed run inside its 30 days keeps its row details
        const alreadyCleared = { ...justOver(40, false), details: false };
        const p = plan([failedExact, failedOver, passedExact, passedOver, passedEight, alreadyCleared], [art(failedOver, "screenshot")]);
        expect(p.expiredRuns).toEqual([failedOver.id, passedOver.id].sort());
    });

    it("follows the project's periods and is empty when nothing is past them", () => {
        const e = justOver(10, false);
        expect(plan([e], [], { policy: policy({ keepFailedDays: 14 }) }).expiredRuns).toEqual([]);
        expect(plan([e], [], { policy: policy({ keepFailedDays: 7 }) }).expiredRuns).toEqual([e.id]);
    });
});

describe("retention rules: nothing keeps a run's files past expiry", () => {
    it("the latest run of a test is no longer kept: its only, newest, failing run goes after 7 days", () => {
        const only = exec(8, false);
        const files = [art(only, "trace"), art(only, "screenshot")];
        const p = plan([only], files);
        expect(p.files).toBe(2);
        expect(Object.keys(p.protectedFiles).sort()).toEqual(["kind", "no-run"]);
    });

    it("keepLatestRuns in an old saved policy changes nothing", () => {
        const runs = [exec(400), exec(300), exec(200), exec(100)];
        const files = runs.map((r) => art(r, "evidence"));
        expect(plan(runs, files, { policy: policy({ keepLatestRuns: 50 }) }).files).toBe(4);
    });

    it("never removes approved baselines, whatever their age or run", () => {
        const e = exec(500);
        const p = plan([e], [art(e, "baseline"), art(null, "baseline")]);
        expect(p.files).toBe(0);
        expect(p.protectedFiles.kind).toBe(2);
        expect(isPrunableKind("baseline")).toBe(false);
    });

    it("never removes a file that belongs to no run (plans, app models, reports)", () => {
        const p = plan([], [art(null, "video"), art(null, "app-model"), art(null, "plan")]);
        expect(p.files).toBe(0);
        expect(p.protectedFiles["no-run"]).toBe(3);
    });

    it("an agent run's screenshots (no test run) go as a failed run's media: kept at 6.9 days, removed at 7.1", () => {
        const shot = (days: number): RetentionArtifact => ({ id: `a${++n}`, kind: "vision-shot", size: 10, executionId: null, at: NOW - days * DAY_MS });
        const keep = shot(6.9);
        const go = shot(7.1);
        const p = plan([], [keep, go, art(null, "plan"), art(null, "baseline")]);
        expect(ids(p)).toEqual([go.id]);
        expect(p.byReason["age-failed"]).toBe(1);
        expect(p.protectedFiles).toEqual({ kind: 1, "no-run": 1 });
    });
});

describe("retention rules: a time that cannot be read is unknown, never old", () => {
    it("a run whose start is 0 or NaN keeps its files (age and size limit) and its details; it is counted as undated", () => {
        const zero: RetentionExecution = { id: `e${++n}`, startedAt: 0, passed: false };
        const nan: RetentionExecution = { id: `e${++n}`, startedAt: Number.NaN, passed: false };
        const files = [art(zero, "trace"), art(zero, "screenshot"), art(nan, "evidence")];
        const p = plan([zero, nan], files, { policy: policy({ maxArtifactMB: 0.001 }) });
        expect(p.files).toBe(0);
        expect(p.undated).toBe(3);
        expect(p.expiredRuns).toEqual([]);
        expect(p.oldest).toBeNull();
    });

    it("an agent screenshot with no time is kept; a passed run's trace still goes (that rule does not depend on age)", () => {
        const passed: RetentionExecution = { id: `e${++n}`, startedAt: 0, passed: true };
        const trace = art(passed, "trace");
        const evidence = art(passed, "evidence");
        const shot: RetentionArtifact = { id: `a${++n}`, kind: "vision-shot", size: 10, executionId: null, at: 0 };
        const p = plan([passed], [trace, evidence, shot]);
        expect(ids(p)).toEqual([trace.id]);
        expect(p.undated).toBe(2);
        expect(p.oldest).toBeNull();
    });
});

describe("the PostgreSQL baseline's header", () => {
    it("names the schema version the file describes (the current migration count)", () => {
        const head = readFileSync(new URL("../src/platform/pg/baseline.sql", import.meta.url), "utf8").split("\n").slice(0, 6).join("\n");
        expect(head).toContain(`slots 1-${knownSchemaVersion()} plus`);
        expect(head).toContain(`records schema_version ${knownSchemaVersion()};`);
    });
});

describe("retention rules: the size limit", () => {
    const MB = 1024 * 1024;
    it("removes the oldest files that are not yet due until the project fits", () => {
        const runs = [exec(5), exec(4), exec(3), exec(2), exec(1)];
        const files = runs.map((r) => art(r, "evidence", 10 * MB));
        const p = plan(runs, files, { policy: policy({ maxArtifactMB: 25 }) });
        // 50 MB, limit 25 MB: the three oldest go (20 MB left)
        expect(p.prune.map((x) => x.id)).toEqual([files[0]!.id, files[1]!.id, files[2]!.id]);
        expect(p.byReason["size-cap"]).toBe(3);
    });

    it("does not count baselines toward the limit and does not double count what age removes", () => {
        const runs = [exec(400), exec(300), exec(2), exec(1)];
        const files = runs.map((r) => art(r, "evidence", 10 * MB));
        const baseline = art(runs[3]!, "baseline", 500 * MB);
        const p = plan(runs, [...files, baseline], { policy: policy({ maxArtifactMB: 30 }) });
        expect(p.byReason.age).toBe(2);
        expect(p.byReason["size-cap"]).toBe(0);
    });
});

describe("retention rules: the size limit counts only what it may remove", () => {
    const MB = 1024 * 1024;
    const DEPLOY = NOW - 5 * DAY_MS; // the first deployment with retention, five days ago: the grace is running
    const stored = (a: RetentionArtifact, at: number): RetentionArtifact => ({ ...a, createdAt: at });

    it("files held by the first-deploy grace do not push the files of newer runs out", () => {
        // 480 MB from before the deployment, a 500 MB limit, and 60 MB of runs made since: nothing may go.
        const old = [exec(20), exec(15), exec(10)];
        const held = old.map((r) => stored(art(r, "evidence", 160 * MB), DEPLOY - DAY_MS));
        const fresh = [exec(3, false), exec(2), exec(1, false)];
        const since = fresh.map((r) => stored(art(r, "screenshot", 20 * MB), r.startedAt));
        const p = plan([...old, ...fresh], [...held, ...since], { policy: policy({ keepDays: 365, keepFailedDays: 365, maxArtifactMB: 500 }), graceFrom: DEPLOY });
        expect(p.prune).toEqual([]);
        expect(p).toMatchObject({ files: 0, grace: 3, heldBytes: 480 * MB });
        expect(p.byReason["size-cap"]).toBe(0);
    });

    it("the limit still applies among the files made since the deployment, oldest first", () => {
        const old = exec(20);
        const held = stored(art(old, "evidence", 480 * MB), DEPLOY - DAY_MS);
        const fresh = [exec(4), exec(3), exec(2), exec(1)];
        const since = fresh.map((r) => stored(art(r, "evidence", 10 * MB), r.startedAt));
        const p = plan([old, ...fresh], [held, ...since], { policy: policy({ keepDays: 365, keepFailedDays: 365, maxArtifactMB: 25 }), graceFrom: DEPLOY });
        // 40 MB since the deployment against 25 MB: the two oldest of those go; the held file is neither counted nor chosen.
        expect(p.prune.map((x) => x.id)).toEqual([since[0]!.id, since[1]!.id]);
        expect(p.heldBytes).toBe(480 * MB);
    });

    it("a file stored in the same millisecond as the grace start is held, not aged (the grace fails towards keeping)", () => {
        const runs = [exec(30, false), exec(30, false)];
        const same = stored(art(runs[0]!, "screenshot", MB), DEPLOY);
        const after = stored(art(runs[1]!, "screenshot", MB), DEPLOY + 1);
        const p = plan(runs, [same, after], { policy: policy({ keepDays: 7, keepFailedDays: 7 }), graceFrom: DEPLOY });
        expect(p.prune.map((x) => x.id)).toEqual([after.id]);
        expect(p.grace).toBe(1);
    });

    it("once the grace is over the same files count again and the oldest go first", () => {
        const old = exec(40);
        const held = stored(art(old, "evidence", 480 * MB), NOW - 30 * DAY_MS);
        const fresh = exec(1);
        const since = stored(art(fresh, "evidence", 40 * MB), fresh.startedAt);
        const p = plan([old, fresh], [held, since], { policy: policy({ keepDays: 365, keepFailedDays: 365, maxArtifactMB: 500 }), graceFrom: NOW - 20 * DAY_MS });
        expect(p.prune.map((x) => x.id)).toEqual([held.id]);
        expect(p).toMatchObject({ grace: 0, heldBytes: 0 });
    });

    it("files whose time cannot be read do not push dated files out either", () => {
        const odd: RetentionExecution = { id: `e${++n}`, startedAt: 0, passed: false };
        const unknown = art(odd, "screenshot", 480 * MB);
        const fresh = [exec(2), exec(1)];
        const dated = fresh.map((r) => art(r, "evidence", 10 * MB));
        const p = plan([odd, ...fresh], [unknown, ...dated], { policy: policy({ maxArtifactMB: 490 }) });
        expect(p.prune).toEqual([]);
        expect(p).toMatchObject({ undated: 1, heldBytes: 480 * MB });
    });
});

describe("retention rules: the plan", () => {
    it("lists files oldest first with totals, per-kind sums and dates", () => {
        const runs = [exec(300, false), exec(200), exec(100, false), exec(1)];
        const files = [art(runs[0]!, "video", 5000), art(runs[1]!, "screenshot", 200), art(runs[2]!, "trace", 700), art(runs[3]!, "evidence", 9)];
        const p = plan(runs, files);
        expect(p.prune.map((x) => x.kind)).toEqual(["video", "screenshot", "trace"]);
        expect(p.bytes).toBe(5900);
        expect(p.byKind.video).toEqual({ files: 1, bytes: 5000 });
        expect(p.oldest).toBe(runs[0]!.startedAt);
        expect(p.newest).toBe(runs[2]!.startedAt);
    });

    it("is deterministic: the same rows give the same plan in any input order", () => {
        const runs = [exec(100), exec(200, false), exec(3, false), exec(40), exec(10, false)];
        const files = runs.map((r) => art(r));
        const a = plan(runs, files);
        const b = plan([...runs].reverse(), [...files].reverse());
        expect(b.prune.map((x) => x.id)).toEqual(a.prune.map((x) => x.id));
    });

    it("an empty project gives an empty plan", () => {
        expect(plan([], [])).toMatchObject({ files: 0, bytes: 0, oldest: null, newest: null });
    });
});

describe("retention policy", () => {
    it("accepts the documented bounds and refuses values outside them", () => {
        const ok = { enabled: true, keepDays: 7, keepFailedDays: 7, keepLatestRuns: 1, maxArtifactMB: null };
        expect(RetentionPolicySchema.safeParse(ok).success).toBe(true);
        expect(RetentionPolicySchema.safeParse({ ...ok, keepDays: 365, keepFailedDays: 730, keepLatestRuns: 50 }).success).toBe(true);
        for (const bad of [{ keepDays: 6 }, { keepDays: 366 }, { keepFailedDays: 731 }, { keepLatestRuns: 0 }, { keepLatestRuns: 51 }, { keepDays: 10.5 }, { maxArtifactMB: 5 }]) expect(RetentionPolicySchema.safeParse({ ...ok, keepFailedDays: 100, ...bad }).success, JSON.stringify(bad)).toBe(false);
    });

    it("lets failed runs' media go sooner than passed runs' records (approved policy: 7 and 30 days)", () => {
        expect(RetentionPolicySchema.safeParse({ enabled: true, keepDays: 30, keepFailedDays: 7, keepLatestRuns: 5 }).success).toBe(true);
        expect(RetentionPolicySchema.safeParse({ enabled: true, keepDays: 30, keepFailedDays: 6, keepLatestRuns: 5 }).success).toBe(false);
    });

    it("is on by default: failed runs' traces, recordings and screenshots 7 days, passed runs' records 30 days", () => {
        expect(DEFAULT_POLICY).toMatchObject({ enabled: true, keepFailedDays: 7, keepDays: 30 });
    });

    it("merges a patch onto what is there and validates the whole", () => {
        const base = { ...DEFAULT_POLICY };
        expect(mergePolicy(base, { enabled: true, keepDays: 14 })).toMatchObject({ enabled: true, keepDays: 14, keepFailedDays: 7 });
        expect(() => mergePolicy(base, { keepDays: 400 })).toThrow(); // beyond the schema's 365
        expect(() => mergePolicy(base, { keepFailedDays: 3 })).toThrow(); // under the 7-day minimum
        expect(mergePolicy({ ...base, maxArtifactMB: 500 }, { maxArtifactMB: null }).maxArtifactMB).toBeNull();
        // the removed "latest runs" setting: an older client may still send it; it is accepted and ignored
        expect(mergePolicy(base, { keepLatestRuns: 0 } as never).keepLatestRuns).toBe(base.keepLatestRuns);
    });

    it("reads the platform default only when it is a whole number of days in range, or off", () => {
        expect(platformDefaultDays(undefined)).toBeUndefined();
        for (const raw of ["", " ", "abc", "6", "366", "-30", "3.5", "30 days", "0", "off"]) expect(platformDefaultDays(raw), raw).toBeUndefined();
        expect(platformDefaultDays("30")).toBe(30);
        expect(platformDefaultDays(" 7 ")).toBe(7);
        expect(platformDefaultDays("365")).toBe(365);
        expect(policyFromPlatformDefault(30)).toMatchObject({ enabled: true, keepDays: 30, keepFailedDays: 7 });
        expect(policyFromPlatformDefault(365).keepFailedDays).toBe(7);
        for (const raw of ["off", " OFF ", "Off"]) expect(platformDefaultOff(raw), raw).toBe(true);
        for (const raw of [undefined, "", "30", "of", "offline"]) expect(platformDefaultOff(raw), String(raw)).toBe(false);
    });

    it("holds a policy to the server's limits and says why a longer one is refused", () => {
        const l = retentionLimits({ RETENTION_MAX_METADATA_DAYS: "60", RETENTION_MAX_FAILED_MEDIA_DAYS: "14" });
        expect(l).toEqual({ maxKeepDays: 60, maxKeepFailedDays: 14 });
        // Unset or unreadable: the schema's own maxima; out-of-range values are brought into range.
        expect(retentionLimits({})).toEqual({ maxKeepDays: 365, maxKeepFailedDays: 730 });
        expect(retentionLimits({ RETENTION_MAX_METADATA_DAYS: "abc", RETENTION_MAX_FAILED_MEDIA_DAYS: "2" })).toEqual({ maxKeepDays: 365, maxKeepFailedDays: 7 });
        const p = { ...DEFAULT_POLICY, keepDays: 90, keepFailedDays: 30 };
        expect(limitProblem(p, l)).toMatch(/at most 60 days/);
        expect(limitProblem({ ...p, keepDays: 60 }, l)).toMatch(/failed runs for at most 14 days/);
        expect(limitProblem({ ...p, keepDays: 60, keepFailedDays: 14 }, l)).toBeUndefined();
        expect(withinLimits(p, l)).toMatchObject({ keepDays: 60, keepFailedDays: 14 });
    });
});

describe("wording and size helpers", () => {
    it("formats sizes in plain language", () => {
        expect(formatBytes(0)).toBe("0 bytes");
        expect(formatBytes(1)).toBe("1 byte");
        expect(formatBytes(999)).toBe("999 bytes");
        expect(formatBytes(1024)).toBe("1 KB");
        expect(formatBytes(1536)).toBe("2 KB");
        expect(formatBytes(1024 * 1024)).toBe("1 MB");
        expect(formatBytes(1.8 * 1024 * 1024 * 1024)).toBe("1.8 GB");
        expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
        expect(formatBytes(-5)).toBe("0 bytes");
        expect(formatBytes(Number.NaN)).toBe("0 bytes");
    });

    it("says what a preview would do", () => {
        const base = { files: 214, bytes: 1.8 * 1024 ** 3, byReason: { age: 214, "age-failed": 0, "passed-media": 0, "size-cap": 0 } };
        expect(previewSentence(base, policy({ keepFailedDays: 30 }))).toBe("This would remove 214 files (1.8 GB) older than 30 days.");
        expect(previewSentence(base, policy())).toBe("This would remove 214 files (1.8 GB) older than 30 days (7 for failed runs).");
        expect(previewSentence({ files: 3, bytes: 3072, byReason: { age: 1, "age-failed": 0, "passed-media": 2, "size-cap": 0 } }, policy())).toBe("This would remove 3 files (3 KB), to keep within 30 days for passed runs. 2 traces or recordings of passed runs are among them: passed runs keep none.");
        expect(previewSentence({ files: 1, bytes: 2048, byReason: { age: 0, "age-failed": 0, "passed-media": 0, "size-cap": 1 } }, policy({ maxArtifactMB: 500 }))).toContain("1 file (2 KB)");
        expect(previewSentence({ files: 0, bytes: 0, byReason: { age: 0, "age-failed": 0, "passed-media": 0, "size-cap": 0 } }, policy())).toContain("Nothing to remove");
    });

    it("says plainly that a file expired, and that a finding's evidence expired while the finding stays", () => {
        expect(formatDate("2026-10-05T10:00:00Z")).toBe("Oct 5, 2026");
        expect(prunedMessage("video", "2026-10-05T10:00:00Z")).toBe("This recording expired and was removed on Oct 5, 2026 (the project's retention policy).");
        expect(prunedMessage("screenshot", "2026-10-05T10:00:00Z")).toBe("This screenshot expired and was removed on Oct 5, 2026 (the project's retention policy).");
        expect(prunedMessage("whatever", "2026-10-05T10:00:00Z")).toBe("This file expired and was removed on Oct 5, 2026 (the project's retention policy).");
        expect(evidenceExpiredMessage("2026-10-05T10:00:00Z")).toBe("The evidence for this finding expired and was removed on Oct 5, 2026 (the project's retention policy). The finding itself is kept.");
    });

    it("groups stored files into the kinds the storage view shows", () => {
        expect(usageKindOfArtifact("visual-diff")).toBe("screenshot");
        expect(usageKindOfArtifact("video")).toBe("video");
        expect(usageKindOfArtifact("baseline")).toBe("baseline");
        expect(usageKindOfArtifact("app-model")).toBe("report");
        expect(usageKindOfArtifact("never-heard-of-it")).toBe("other");
        expect(usageKindOfPath("p1/_apps/app.apk")).toBe("apk");
        expect(usageKindOfPath("p1/_artifacts/t/job-1/video.webm")).toBe("video");
        expect(usageKindOfPath("p1/web/WEB-001.spec.ts")).toBe("script");
        expect(usageKindOfPath("p1/_artifacts/job/report.html")).toBe("report");
    });

    it("web helpers: bar segments add up, labels exist for every kind, removed-file notes match the server's wording", () => {
        const segs = sizeBar({ screenshot: 300, video: 600, trace: 100, evidence: 0, report: 0, apk: 0, baseline: 0, script: 0, other: 0 });
        expect(segs.map((s) => s.kind)).toEqual(["video", "screenshot", "trace"]);
        expect(Math.round(segs.reduce((a, s) => a + s.percent, 0))).toBe(100);
        expect(sizeBar({ screenshot: 0, video: 0, trace: 0, evidence: 0, report: 0, apk: 0, baseline: 0, script: 0, other: 0 })).toEqual([]);
        for (const k of ["screenshot", "video", "trace", "evidence", "report", "apk", "baseline", "script", "other"]) expect(STORAGE_KIND_LABELS[k as keyof typeof STORAGE_KIND_LABELS]).toBeTruthy();
        expect(prunedNote("video", "2026-10-05T10:00:00Z")).toBe(prunedMessage("video", "2026-10-05T10:00:00Z"));
        expect(fileLabel("trace")).toBe("detailed trace");
    });
});

// ── backup documents ─────────────────────────────────────────────────────────

describe("backup: names, secrets and documents", () => {
    it("refuses hostile entry names", () => {
        const hostile = ["../evil.json", "a/../../evil", "/etc/passwd", "C:/Windows/x", "c:evil", "a\\b", "a//b", "./x", "x/./y", "", "a\u0000b", "x".repeat(300), "evidence/\u202etxt", "a/b/..", "..", "tests.json/../../x"];
        for (const name of hostile) expect(badEntryName(name), JSON.stringify(name)).not.toBeNull();
        for (const name of ["manifest.json", "baselines/WEB-001/home-1.png", "evidence/0001-screenshot.png", "evidence/", "baselines/WEB-001/"]) expect(badEntryName(name), name).toBeNull();
    });

    it("knows exactly which entries a backup holds", () => {
        for (const name of ["manifest.json", "project.json", "tests.json", "secrets-needed.json", "files.json", "baselines/WEB-001/a.png", "evidence/0001-video.webm"]) expect(isKnownEntry(name), name).toBe(true);
        for (const name of ["notes.txt", "script.js", "tests/x.ts", "baselines/a.png", "baselines/WEB-001/a.txt", "evidence/a/b.png", "node_modules/x"]) expect(isKnownEntry(name), name).toBe(false);
        expect(checkEntryList(["manifest.json", "tests.json"])).toBeNull();
        expect(checkEntryList(["tests.json"])).toContain("no manifest.json");
        expect(checkEntryList([])).toContain("empty");
        expect(checkEntryList(["manifest.json", "manifest.json"])).toContain("twice");
        expect(checkEntryList(["manifest.json", "run.sh"])).toContain("never contains");
        expect(checkEntryList(["manifest.json", "../x"])).toContain("leave its folder");
    });

    it("recognizes names that look secret", () => {
        for (const name of ["password", "PASSWORD", "api_key", "apiKey", "TOKEN", "client_secret", "Authorization", "auth", "private-key", "session", "sig", "bearer"]) expect(looksSensitive(name), name).toBe(true);
        for (const name of ["region", "username", "baseUrl", "color", "timeout", "plan", "locale"]) expect(looksSensitive(name), name).toBe(false);
    });

    it("scrubs addresses of user names, passwords, secret-looking parameters and tokens in the fragment", () => {
        expect(scrubUrl("https://app.example.com/path?page=2")).toEqual({ url: "https://app.example.com/path?page=2", changed: false });
        const a = scrubUrl("https://user:hunter2@app.example.com/x?api_key=SECRET1&page=2#access_token=SECRET2");
        expect(a.changed).toBe(true);
        expect(a.url).not.toMatch(/hunter2|SECRET1|SECRET2|user:/);
        expect(a.url).toContain("page=2");
        expect(scrubUrl("not a url")).toEqual({ url: "not a url", changed: false });
    });

    it("scrubs the application's settings: sensitive keys, secret addresses, and the mobile app path", () => {
        const { config, removed } = scrubConfig({ scope: "checkout", openApiUrl: "https://api.example.com/openapi.json?token=TOPSECRET", mobile: { apkPath: "C:/data/app.apk" }, nested: { clientSecret: "x", ok: "fine" }, maxPages: 5 });
        expect(JSON.stringify(config)).not.toMatch(/TOPSECRET|apk|clientSecret/);
        expect(config).toMatchObject({ scope: "checkout", maxPages: 5, nested: { ok: "fine" } });
        expect(removed.length).toBeGreaterThan(0);
    });

    it("validates the manifest and the documents", () => {
        const good = { kind: BACKUP_KIND, format: BACKUP_FORMAT, platformVersion: "0.1.0", createdAt: "2026-10-08T00:00:00Z", project: { name: "Shop" }, counts: { tests: 3 } };
        expect(ManifestSchema.safeParse(good).success).toBe(true);
        expect(ManifestSchema.safeParse({ ...good, kind: "something-else" }).success).toBe(false);
        expect(ManifestSchema.safeParse({ ...good, project: {} }).success).toBe(false);
        expect(TestEntrySchema.safeParse({ testKey: "WEB-001", suite: { name: "Home", slug: "home" }, framework: "playwright", spec: {}, scripts: [{ framework: "playwright", filename: "WEB-001.spec.ts", content: "x", executable: true }] }).success).toBe(true);
        expect(TestEntrySchema.safeParse({ testKey: "", suite: { name: "Home", slug: "home" }, framework: "playwright", spec: {} }).success).toBe(false);
        expect(ReleaseEntrySchema.safeParse({ name: "1.0", status: "approved", createdAt: "x", updatedAt: "y" }).success).toBe(true);
        expect(ReleaseEntrySchema.safeParse({ name: "1.0", status: "hacked", createdAt: "x", updatedAt: "y" }).success).toBe(false);
    });
});

// ── hostile zips ─────────────────────────────────────────────────────────────

const manifestDoc = (over: Record<string, unknown> = {}) => strToU8(JSON.stringify({ kind: BACKUP_KIND, format: BACKUP_FORMAT, platformVersion: "0.1.0", createdAt: "2026-10-08T00:00:00Z", project: { name: "Shop" }, ...over }));
const zip = (files: Zippable) => zipSync(files);
const refusal = (fn: () => unknown): { status: number; message: string } => {
    try {
        fn();
    } catch (e) {
        return { status: (e as { status: number }).status, message: (e as Error).message };
    }
    throw new Error("expected the backup to be refused");
};

describe("backup: hostile and damaged zips are refused", () => {
    it("opens a plain, well-formed backup", () => {
        const files = unpackBackup(zip({ "manifest.json": manifestDoc(), "tests.json": strToU8("[]") }));
        expect([...files.keys()].sort()).toEqual(["manifest.json", "tests.json"]);
        expect(readManifest(files).project.name).toBe("Shop");
    });

    it("refuses anything that is not a zip, an empty file, and a cut-off zip", () => {
        expect(refusal(() => unpackBackup(new Uint8Array(0))).status).toBe(400);
        expect(refusal(() => unpackBackup(strToU8("this is not a zip file at all"))).message).toContain("does not look like a backup");
        // random bytes do not compress, so cutting the zip in half cuts inside a file
        const good = zip({ "manifest.json": manifestDoc(), "evidence/a.png": new Uint8Array(randomBytes(60_000)) });
        const cut = refusal(() => unpackBackup(good.subarray(0, Math.floor(good.length * 0.6))));
        expect(cut.status).toBe(400);
        expect(cut.message).toMatch(/damaged/);
    });

    it("refuses path traversal and absolute names, however they are spelled", () => {
        for (const name of ["../escape.json", "evidence/../../escape", "/abs.json", "C:/win.json", "a\\b.json"]) {
            const r = refusal(() => unpackBackup(zip({ "manifest.json": manifestDoc(), [name]: strToU8("{}") })));
            expect(r.status, name).toBe(400);
            expect(r.message, name).toMatch(/not a backup this platform made/);
        }
    });

    it("refuses entries a backup never contains (scripts, other files)", () => {
        expect(refusal(() => unpackBackup(zip({ "manifest.json": manifestDoc(), "run.sh": strToU8("rm -rf /") }))).message).toContain("never contains");
        expect(refusal(() => unpackBackup(zip({ "tests.json": strToU8("[]") }))).message).toContain("no manifest.json");
    });

    it("refuses too many entries", () => {
        const files: Zippable = { "manifest.json": manifestDoc() };
        for (let i = 0; i < 12; i++) files[`evidence/${i}.png`] = strToU8("x");
        const small = { ...BACKUP_LIMITS, maxEntries: 10 };
        expect(refusal(() => unpackBackup(zip(files), small)).message).toContain("more than 10 entries");
        expect(() => unpackBackup(zip(files))).not.toThrow();
    });

    it("stops a zip bomb by what it really unpacks to, not by what it says: one file, and the whole file", () => {
        // 3 MB of zeros compress to a few KB. The limits are lowered so the test itself stays small.
        const zeros = new Uint8Array(3 * 1024 * 1024);
        const bombOne = zip({ "manifest.json": manifestDoc(), "tests.json": zeros });
        expect(bombOne.length).toBeLessThan(20_000);
        const r1 = refusal(() => unpackBackup(bombOne, { ...BACKUP_LIMITS, maxJsonBytes: 1024 * 1024 }));
        expect(r1.status).toBe(413);
        const many = zip({ "manifest.json": manifestDoc(), "evidence/a.png": zeros, "evidence/b.png": zeros, "evidence/c.png": zeros });
        const r2 = refusal(() => unpackBackup(many, { ...BACKUP_LIMITS, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024 }));
        expect(r2.status).toBe(413);
        expect(r2.message).toContain("more data");
        const tooBigZip = refusal(() => unpackBackup(many, { ...BACKUP_LIMITS, maxZipBytes: 100 }));
        expect(tooBigZip.status).toBe(413);
    });

    it("refuses damaged JSON and an unknown future format with a plain message", () => {
        const badJson = unpackBackup(zip({ "manifest.json": strToU8("{not json") }));
        expect(refusal(() => readManifest(badJson)).message).toContain("not readable");
        const future = unpackBackup(zip({ "manifest.json": manifestDoc({ format: BACKUP_FORMAT + 1 }) }));
        const r = refusal(() => readManifest(future));
        expect(r.status).toBe(422);
        expect(r.message).toContain("newer version of the platform");
        expect(refusal(() => readManifest(unpackBackup(zip({ "manifest.json": manifestDoc({ format: 0 }) })))).message).toContain("format version");
        expect(refusal(() => readManifest(unpackBackup(zip({ "manifest.json": manifestDoc({ format: "1" }) })))).message).toContain("format version");
        expect(refusal(() => readManifest(unpackBackup(zip({ "manifest.json": manifestDoc({ kind: "other-product" }) })))).message).toContain("not a backup this platform made");
    });
});
