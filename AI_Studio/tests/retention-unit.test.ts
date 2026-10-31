/**
 * Storage, retention and backup, browser-free and database-free:
 *  - the retention rule table (age, keep-latest and keep-failed boundaries, every protected category, rule order, the size limit);
 *  - policy bounds and the platform default;
 *  - size and message wording, the storage kind helpers, the web helpers;
 *  - the backup documents' schemas, secret scrubbing, entry-name safety and hostile zips (traversal, too many entries, bombs, bad JSON,
 *    unknown versions).
 */
import { randomBytes } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, BACKUP_KIND, BACKUP_LIMITS, badEntryName, checkEntryList, isKnownEntry, looksSensitive, ManifestSchema, ReleaseEntrySchema, scrubUrl, TestEntrySchema } from "../src/engine/retention/backup-model.js";
import { formatBytes, formatDate, previewSentence, prunedMessage } from "../src/engine/retention/format.js";
import { DEFAULT_POLICY, mergePolicy, platformDefaultDays, policyFromPlatformDefault, RetentionPolicySchema, type RetentionPolicy } from "../src/engine/retention/policy.js";
import { DAY_MS, isPrunableKind, planPrune, protectedRuns, type RetentionArtifact, type RetentionExecution, type RetentionInput } from "../src/engine/retention/rules.js";
import { scrubConfig, unpackBackup, readManifest } from "../src/platform/backup.js";
import { usageKindOfArtifact, usageKindOfPath } from "../src/platform/storage-usage.js";
import { fileLabel, prunedNote, sizeBar, STORAGE_KIND_LABELS } from "../web/src/features/storage/storage.js";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({ ...DEFAULT_POLICY, enabled: true, keepDays: 30, keepFailedDays: 90, keepLatestRuns: 2, ...over });

let n = 0;
const exec = (testId: string, daysAgo: number, passed = true, group = ""): RetentionExecution => ({ id: `e${++n}`, testId, group, startedAt: NOW - daysAgo * DAY_MS, passed });
const art = (e: RetentionExecution | null, kind = "screenshot", size = 1000): RetentionArtifact => ({ id: `a${++n}`, kind, size, executionId: e?.id ?? null, at: e ? e.startedAt : NOW - 400 * DAY_MS });
const plan = (executions: RetentionExecution[], artifacts: RetentionArtifact[], over: Partial<RetentionInput> = {}) =>
    planPrune({ now: NOW, policy: policy(), executions, artifacts, issueTimes: new Map(), releaseMoments: [], ...over });
const ids = (p: ReturnType<typeof plan>) => p.prune.map((x) => x.id).sort();

describe("retention rules: age", () => {
    // Three newer runs shield nothing here because keepLatestRuns is 2 and the run under test is the 4th newest.
    const filler = (t: string) => [exec(t, 1), exec(t, 2), exec(t, 3)];

    it("keeps a file exactly keepDays old and removes one a moment older (passed run)", () => {
        const t = "t1";
        const f = filler(t);
        const exactly = exec(t, 30);
        const older = { ...exec(t, 30), startedAt: NOW - 30 * DAY_MS - 1 };
        const a = art(exactly);
        const b = art(older);
        const p = plan([...f, exactly, older], [a, b]);
        expect(ids(p)).toEqual([b.id]);
        expect(p.prune[0]!.reason).toBe("age");
    });

    it("uses keepFailedDays for a run that did not pass", () => {
        const t = "t2";
        const newer = [exec(t, 1), exec(t, 2), exec(t, 3)];
        const failedAt60 = exec(t, 60, false);
        const failedAt91 = exec(t, 91, false);
        const a = art(failedAt60);
        const b = art(failedAt91);
        const p = plan([...newer, failedAt60, failedAt91], [a, b]);
        expect(ids(p)).toEqual([b.id]);
        expect(p.prune[0]!.reason).toBe("age-failed");
    });

    it("removes nothing from a project whose files are all recent", () => {
        const e = [exec("t", 1), exec("t", 2), exec("t", 3), exec("t", 4)];
        expect(plan(e, e.map((x) => art(x))).files).toBe(0);
    });
});

describe("retention rules: keep the latest runs", () => {
    it("keeps the newest N runs of a test however old they are, removes older ones", () => {
        const t = "t";
        const runs = [exec(t, 400), exec(t, 300), exec(t, 200), exec(t, 100)]; // all far beyond 30 days
        const arts = runs.map((r) => art(r));
        const p = plan(runs, arts); // keepLatestRuns 2: the two newest (100, 200 days) stay
        expect(ids(p)).toEqual([arts[0]!.id, arts[1]!.id].sort());
        expect(p.protectedFiles["latest-runs"]).toBe(2);
    });

    it("counts runs per test, so one busy test does not push another test's runs out", () => {
        const busy = [exec("a", 100), exec("a", 101), exec("a", 102), exec("a", 103)];
        const quiet = [exec("b", 200)];
        const p = plan([...busy, ...quiet], [...busy, ...quiet].map((r) => art(r)));
        // b's only run is among its latest N; a keeps two, loses two
        expect(p.files).toBe(2);
    });

    it("counts a browser variant and an environment separately from the main run", () => {
        const main = [exec("t", 100), exec("t", 101), exec("t", 102)];
        const firefox = [exec("t", 100, true, "variant:firefox"), exec("t", 101, true, "variant:firefox"), exec("t", 102, true, "variant:firefox")];
        const p = plan([...main, ...firefox], [...main, ...firefox].map((r) => art(r)));
        expect(p.files).toBe(2); // one old run from each group
    });

    it("keepLatestRuns 1 keeps only the newest", () => {
        const runs = [exec("t", 90), exec("t", 80), exec("t", 70)];
        const p = plan(runs, runs.map((r) => art(r)), { policy: policy({ keepLatestRuns: 1 }) });
        expect(p.files).toBe(2);
    });
});

describe("retention rules: everything that must survive", () => {
    const old = (t: string) => [exec(t, 200), exec(t, 201), exec(t, 202), exec(t, 203)];

    it("never removes approved baselines, app models or reports, whatever their age", () => {
        const e = exec("t", 500);
        const arts = ["baseline", "app-model", "requirements-coverage", "report", "something-new"].map((k) => art(e, k));
        const p = plan([e], arts);
        expect(p.files).toBe(0);
        expect(p.protectedFiles.kind).toBe(5);
        expect(isPrunableKind("baseline")).toBe(false);
        for (const k of ["screenshot", "video", "trace", "evidence", "visual-actual", "visual-diff", "vision-shot"]) expect(isPrunableKind(k)).toBe(true);
    });

    it("never removes a file that belongs to no run", () => {
        const a = art(null, "video");
        const p = plan([], [a]);
        expect(p.files).toBe(0);
        expect(p.protectedFiles["no-run"]).toBe(1);
    });

    it("keeps the files of a failing test's newest run, however old (current failure), but not its older failures", () => {
        const runs = [exec("t", 400, false), exec("t", 300, false), exec("t", 250, false), exec("t", 200, false)]; // newest first = 200
        const arts = runs.map((r) => art(r));
        // keepLatestRuns 1 keeps the newest; keepFailedDays 90 makes the rest old
        const p = plan(runs, arts, { policy: policy({ keepLatestRuns: 1 }) });
        expect(ids(p)).toEqual([arts[0]!.id, arts[1]!.id, arts[2]!.id].sort());
    });

    it("the failure rule holds on its own too (defence in depth: it does not depend on keepLatestRuns)", () => {
        const runs = [exec("t", 400, false), exec("t", 200, false)];
        const kept = protectedRuns({ executions: runs, artifacts: [], issueTimes: new Map(), releaseMoments: [], policy: policy({ keepLatestRuns: 0 }) });
        expect([...kept.entries()]).toEqual([[runs[1]!.id, "failure"]]);
    });

    it("keeps the files of the run an issue was filed from (and only that failed run)", () => {
        const [r1, r2, r3, r4] = [exec("t", 300, false), exec("t", 250, false), exec("t", 200, true), exec("t", 150, true)];
        const arts = [r1, r2, r3, r4].map((r) => art(r));
        // an issue was filed 240 days ago: the newest failed run at or before that moment is r2 (250 days ago)
        const p = plan([r1, r2, r3, r4], arts, { policy: policy({ keepLatestRuns: 1 }), issueTimes: new Map([["t", [NOW - 240 * DAY_MS]]]) });
        expect(ids(p)).toContain(arts[0]!.id);
        expect(ids(p)).not.toContain(arts[1]!.id);
        expect(p.protectedFiles.issue).toBe(1);
    });

    it("keeps what each release looked at: the newest run of every test at the moment of its snapshot", () => {
        const a = [exec("a", 300), exec("a", 250), exec("a", 100), exec("a", 90)];
        const b = [exec("b", 280), exec("b", 120), exec("b", 95), exec("b", 91)];
        const all = [...a, ...b];
        const arts = all.map((r) => art(r));
        const p = plan(all, arts, { policy: policy({ keepLatestRuns: 1 }), releaseMoments: [NOW - 260 * DAY_MS, NOW - 110 * DAY_MS] });
        const kept = new Set(arts.map((x) => x.id).filter((i) => !ids(p).includes(i)));
        // snapshot at 260 days ago: a's run at 300 days; b's run at 280. Snapshot at 110: a's 250?? no: newest at/before 110 days ago is a@250? it is a@250 only if nothing newer is older than 110 days: a@100 is newer than 110 days ago, so a@250.
        expect(kept.has(arts[0]!.id)).toBe(true); // a@300 (release 1)
        expect(kept.has(arts[4]!.id)).toBe(true); // b@280 (release 1)
        expect(kept.has(arts[1]!.id)).toBe(true); // a@250 (release 2)
        expect(kept.has(arts[5]!.id)).toBe(true); // b@120 -> newest b at/before 110 days ago is b@120 (release 2)
        expect(p.protectedFiles.release).toBeGreaterThan(0);
    });

    it("keeps new/different screenshots waiting to be accepted as the new baseline", () => {
        const runs = [exec("t", 300, false), exec("t", 250, false), exec("t", 200, false)];
        const diff = art(runs[1]!, "visual-diff");
        const actual = art(runs[1]!, "visual-actual");
        const old = art(runs[0]!, "visual-diff");
        // the test's newest run (200 days) failed without a screenshot; the newest run that has visual images (250) is the pending change
        const p = plan(runs, [diff, actual, old], { policy: policy({ keepLatestRuns: 1 }) });
        expect(ids(p)).toEqual([old.id]);
        expect(p.protectedFiles.visual).toBe(2);
    });

    it("does not treat visual images of a passing test as pending", () => {
        const runs = [exec("t", 300), exec("t", 250), exec("t", 100)];
        const a = art(runs[1]!, "visual-actual");
        const p = plan(runs, [a], { policy: policy({ keepLatestRuns: 1 }) });
        expect(ids(p)).toEqual([a.id]);
    });

    it("protects in a fixed order: the first rule that applies is the one reported", () => {
        const e = exec("t", 400, false);
        const arts = [art(e)];
        const p = plan([e], arts);
        // it is the newest run (latest-runs) AND a current failure AND could be a release moment; latest-runs comes first
        expect(protectedRuns({ executions: [e], artifacts: arts, issueTimes: new Map(), releaseMoments: [NOW], policy: policy() }).get(e.id)).toBe("latest-runs");
        expect(p.protectedFiles["latest-runs"]).toBe(1);
        expect(p.protectedFiles.failure).toBe(0);
    });
});

describe("retention rules: the size limit", () => {
    it("removes the oldest unprotected files until the project fits, never protected ones", () => {
        const t = "t";
        const MB = 1024 * 1024;
        // five recent passed runs of 10 MB each (all newer than keepDays), the two newest protected by keepLatestRuns
        const runs = [exec(t, 5), exec(t, 4), exec(t, 3), exec(t, 2), exec(t, 1)];
        const arts = runs.map((r) => art(r, "video", 10 * MB));
        const p = plan(runs, arts, { policy: policy({ maxArtifactMB: 25 }) });
        // 50 MB total, limit 25 MB: the three oldest are candidates, remove until <= 25 MB: removes 3 (50 - 30 = 20)
        expect(p.prune.map((x) => x.id)).toEqual([arts[0]!.id, arts[1]!.id, arts[2]!.id]);
        expect(p.prune.every((x) => x.reason === "size-cap")).toBe(true);
        expect(p.byReason["size-cap"]).toBe(3);
    });

    it("stops early when what remains is protected: the limit is a goal, not a licence", () => {
        const MB = 1024 * 1024;
        const runs = [exec("t", 2), exec("t", 1)];
        const arts = runs.map((r) => art(r, "video", 10 * MB));
        const p = plan(runs, arts, { policy: policy({ maxArtifactMB: 10 }) }); // both are the latest runs
        expect(p.files).toBe(0);
    });

    it("counts only removable kinds toward the limit and does not double count what age removes", () => {
        const MB = 1024 * 1024;
        const runs = [exec("t", 400), exec("t", 300), exec("t", 2), exec("t", 1)];
        const arts = runs.map((r) => art(r, "video", 10 * MB));
        const baseline = art(runs[3]!, "baseline", 500 * MB);
        const p = plan(runs, [...arts, baseline], { policy: policy({ maxArtifactMB: 30 }) });
        // age removes the two old ones (20 MB); the remaining 20 MB fits the 30 MB limit, so nothing is removed for size
        expect(p.byReason.age).toBe(2);
        expect(p.byReason["size-cap"]).toBe(0);
    });
});

describe("retention rules: the plan", () => {
    it("lists files oldest first with totals, per-kind sums and dates", () => {
        const t = "t";
        const runs = [exec(t, 300), exec(t, 200), exec(t, 100), exec(t, 90), exec(t, 80)];
        const arts = [art(runs[0]!, "video", 5000), art(runs[1]!, "screenshot", 200), art(runs[2]!, "trace", 700)];
        const p = plan(runs, arts, { policy: policy({ keepLatestRuns: 2 }) });
        expect(p.prune.map((x) => x.kind)).toEqual(["video", "screenshot", "trace"]);
        expect(p.bytes).toBe(5900);
        expect(p.byKind.video).toEqual({ files: 1, bytes: 5000 });
        expect(p.oldest).toBe(runs[0]!.startedAt);
        expect(p.newest).toBe(runs[2]!.startedAt);
    });

    it("is deterministic: the same rows give the same plan in any input order", () => {
        const runs = [exec("t", 100), exec("t", 200), exec("t", 300), exec("t", 400), exec("u", 150), exec("u", 250), exec("u", 350)];
        const arts = runs.map((r) => art(r));
        const a = plan(runs, arts);
        const b = plan([...runs].reverse(), [...arts].reverse());
        expect(b.prune.map((x) => x.id)).toEqual(a.prune.map((x) => x.id));
    });

    it("an empty project gives an empty plan", () => {
        const p = plan([], []);
        expect(p).toMatchObject({ files: 0, bytes: 0, oldest: null, newest: null });
    });
});

describe("retention policy", () => {
    it("accepts the documented bounds and refuses values outside them", () => {
        const ok = { enabled: true, keepDays: 7, keepFailedDays: 7, keepLatestRuns: 1, maxArtifactMB: null };
        expect(RetentionPolicySchema.safeParse(ok).success).toBe(true);
        expect(RetentionPolicySchema.safeParse({ ...ok, keepDays: 365, keepFailedDays: 730, keepLatestRuns: 50 }).success).toBe(true);
        for (const bad of [{ keepDays: 6 }, { keepDays: 366 }, { keepFailedDays: 731 }, { keepLatestRuns: 0 }, { keepLatestRuns: 51 }, { keepDays: 10.5 }, { maxArtifactMB: 5 }]) expect(RetentionPolicySchema.safeParse({ ...ok, keepFailedDays: 100, ...bad }).success, JSON.stringify(bad)).toBe(false);
    });

    it("refuses to keep failed runs for less time than passed runs", () => {
        const r = RetentionPolicySchema.safeParse({ enabled: true, keepDays: 60, keepFailedDays: 30, keepLatestRuns: 5 });
        expect(r.success).toBe(false);
    });

    it("is off by default", () => {
        expect(DEFAULT_POLICY.enabled).toBe(false);
    });

    it("merges a patch onto what is there and validates the whole", () => {
        const base = { ...DEFAULT_POLICY };
        expect(mergePolicy(base, { enabled: true, keepDays: 14 })).toMatchObject({ enabled: true, keepDays: 14, keepFailedDays: 90 });
        expect(() => mergePolicy(base, { keepDays: 120 })).toThrow(); // failed (90) would be shorter than passed (120)
        expect(mergePolicy({ ...base, maxArtifactMB: 500 }, { maxArtifactMB: null }).maxArtifactMB).toBeNull();
    });

    it("reads the platform default only when it is a whole number of days in range", () => {
        expect(platformDefaultDays(undefined)).toBeUndefined();
        for (const raw of ["", " ", "abc", "6", "366", "-30", "3.5", "30 days", "0"]) expect(platformDefaultDays(raw), raw).toBeUndefined();
        expect(platformDefaultDays("30")).toBe(30);
        expect(platformDefaultDays(" 7 ")).toBe(7);
        expect(platformDefaultDays("365")).toBe(365);
        expect(policyFromPlatformDefault(30)).toMatchObject({ enabled: true, keepDays: 30, keepFailedDays: 90 });
        expect(policyFromPlatformDefault(365).keepFailedDays).toBe(730);
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
        const base = { files: 214, bytes: 1.8 * 1024 ** 3, byReason: { age: 214, "age-failed": 0, "size-cap": 0 } };
        expect(previewSentence(base, policy({ keepFailedDays: 30 }))).toBe("This would remove 214 files (1.8 GB) older than 30 days.");
        expect(previewSentence(base, policy())).toBe("This would remove 214 files (1.8 GB) older than 30 days (90 for failed runs).");
        expect(previewSentence({ files: 1, bytes: 2048, byReason: { age: 0, "age-failed": 0, "size-cap": 1 } }, policy({ maxArtifactMB: 500 }))).toContain("1 file (2 KB)");
        expect(previewSentence({ files: 0, bytes: 0, byReason: { age: 0, "age-failed": 0, "size-cap": 0 } }, policy())).toContain("Nothing to remove");
    });

    it("says honestly that a file was removed", () => {
        expect(formatDate("2026-10-05T10:00:00Z")).toBe("Oct 5, 2026");
        expect(prunedMessage("video", "2026-10-05T10:00:00Z")).toBe("This recording was removed to save space on Oct 5, 2026.");
        expect(prunedMessage("screenshot", "2026-10-05T10:00:00Z")).toBe("This screenshot was removed to save space on Oct 5, 2026.");
        expect(prunedMessage("whatever", "2026-10-05T10:00:00Z")).toBe("This file was removed to save space on Oct 5, 2026.");
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
