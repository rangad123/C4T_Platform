/**
 * Candidate findings (testing-engine Phase 3, P3-04): the CandidateFinding contract a captured defect carries in its test's meta
 * (strict, capped, redacted, confidence as Decision 9 states it, never confirmed) and the store that keeps one row per project and
 * fingerprint. Every read and write is scoped by project: another project's id never reads or writes. No browser, no model.
 */
import { describe, expect, it } from "vitest";
import { CANDIDATE_FINDING_LIMITS, CandidateFindingSchema, confidenceOf, findingFingerprint } from "../src/engine/explore/finding.js";
import { CANDIDATE_FINDINGS_LIST_MAX, CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { Db } from "../src/platform/db.js";

const at = "2026-11-17T10:00:00.000Z";
const FP = "a".repeat(64);

const finding = (over: Record<string, unknown> = {}) => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 6 },
    expected: { text: "The total equals the sum of the lines minus the discount.", source: "R-4" },
    observed: "The total shows 40.00 for two lines of 15.00.",
    evidence: { screenshots: ["artifacts/shot-1.png"], requests: ["GET /api/cart -> 200"], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: FP,
    modelVersion: "v1",
    replays: [{ label: "independence 1", outcome: "failed", failedStep: 6, summary: "Stopped at the total check" }],
    ...over,
});

function setup() {
    const db = new Db(":memory:");
    const ins = (sql: string, ...p: (string | number)[]) => db.run(sql, ...p);
    ins("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2"]) {
        ins("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", p, "u-1", p, at, at);
        ins("INSERT INTO applications (id, project_id, url, origin, config_json, created_at) VALUES (?,?,?,?,?,?)", `a-${p}`, p, "https://shop.example", "https://shop.example", "{}", at);
        ins("INSERT INTO test_suites (id, project_id, name, slug, created_at) VALUES (?,?,?,?,?)", `s-${p}`, p, "Suite", "suite", at);
        for (const j of ["j1", "j2"])
            ins("INSERT INTO generation_jobs (id, project_id, application_id, status, options_json, progress_json, counters_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", `${j}-${p}`, p, `a-${p}`, "done", "{}", "{}", "{}", at, at);
        ins("INSERT INTO test_cases (id, project_id, suite_id, test_key, title, kind, type, priority, validation_status, framework, spec_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", `t-${p}`, p, `s-${p}`, "WEB-001", "Cart total", "web", "functional", "high", "NEEDS_REVIEW", "playwright", "{}", at, at);
    }
    let tick = 0;
    const store = new CandidateFindingStore(db.sql, () => `2026-11-17T10:00:0${tick++}.000Z`);
    return { db, store };
}

describe("CandidateFinding contract", () => {
    it("accepts a complete captured finding and refuses unknown fields", () => {
        expect(CandidateFindingSchema.safeParse(finding()).success).toBe(true);
        expect(CandidateFindingSchema.safeParse({ ...finding(), extra: 1 }).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ expected: { text: "x", source: "R-4", note: "y" } })).success).toBe(false);
    });

    it("states confidence as Decision 9 does, and a finding whose confidence disagrees is refused", () => {
        expect(confidenceOf({ sourced: true, capture: "captured", independence: "independent" })).toBe("high");
        expect(confidenceOf({ sourced: true, capture: "captured", independence: "not_run" })).toBe("medium");
        expect(confidenceOf({ sourced: true, capture: "captured", independence: "state_dependent" })).toBe("medium");
        expect(confidenceOf({ sourced: true, capture: "observed_only", independence: "independent" })).toBe("low");
        expect(confidenceOf({ sourced: false, capture: "observed_only", independence: "not_run" })).toBe("low");
        expect(CandidateFindingSchema.safeParse(finding({ independence: "state_dependent" })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ independence: "state_dependent", confidence: "medium" })).success).toBe(true);
        const observedOnly = finding({ capture: "observed_only", independence: "not_run", confidence: "low", expected: { text: "", source: null }, objective: null });
        expect(CandidateFindingSchema.safeParse(observedOnly).success).toBe(true);
        expect(CandidateFindingSchema.safeParse({ ...observedOnly, confidence: "medium" }).success).toBe(false);
    });

    it("never calls a finding confirmed, and a captured check needs a source", () => {
        expect(CandidateFindingSchema.safeParse(finding({ confidence: "confirmed" })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ expected: { text: "Total is right", source: null } })).success).toBe(false);
    });

    it("redacts secrets and email addresses in observed text and evidence, and cuts long text", () => {
        const parsed = CandidateFindingSchema.parse(
            finding({
                observed: `Signed in as buyer@shop.example with Authorization: Bearer abcdef123456789 ${"x".repeat(CANDIDATE_FINDING_LIMITS.textMax + 500)}`,
                evidence: { screenshots: [], requests: ["POST /login?token=s3cr3tvalue99 -> 302"], console: ["password=hunter2hunter2"] },
            }),
        );
        expect(parsed.observed).not.toContain("buyer@shop.example");
        expect(parsed.observed).not.toContain("abcdef123456789");
        expect(parsed.observed.length).toBeLessThanOrEqual(CANDIDATE_FINDING_LIMITS.textMax);
        expect(parsed.evidence.requests.join(" ")).not.toContain("s3cr3tvalue99");
        expect(parsed.evidence.console.join(" ")).not.toContain("hunter2hunter2");
    });

    it("refuses more evidence, replays or steps than the caps allow", () => {
        const L = CANDIDATE_FINDING_LIMITS;
        const many = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`);
        expect(CandidateFindingSchema.safeParse(finding({ evidence: { screenshots: many(L.screenshotsMax + 1), requests: [], console: [] } })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ evidence: { screenshots: [], requests: many(L.requestsMax + 1), console: [] } })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ evidence: { screenshots: [], requests: [], console: many(L.consoleMax + 1) } })).success).toBe(false);
        const replay = { label: "r", outcome: "failed", summary: "s" };
        expect(CandidateFindingSchema.safeParse(finding({ replays: Array(L.replaysMax + 1).fill(replay) })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ actions: { stepCount: L.stepsMax + 1 } })).success).toBe(false);
        expect(CandidateFindingSchema.safeParse(finding({ fingerprint: "not-a-hash" })).success).toBe(false);
    });

    it("gives the same fingerprint for the same source and expectation however it is spaced or cased, another for another", () => {
        const a = findingFingerprint({ source: "R-4", expected: "The total  equals the SUM", scenario: "Cart total" });
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(findingFingerprint({ source: "R-4", expected: " the total equals the sum ", scenario: "cart  total" })).toBe(a);
        expect(findingFingerprint({ source: "R-5", expected: "The total equals the sum", scenario: "Cart total" })).not.toBe(a);
        expect(findingFingerprint({ source: "R-4", expected: "The total equals the sum", scenario: "Checkout" })).not.toBe(a);
        expect(findingFingerprint({ source: null, expected: "", scenario: "Cart total" })).not.toBe(findingFingerprint({ source: null, expected: "", scenario: "Checkout" }));
    });
});

describe("CandidateFindingStore", () => {
    it("adds a finding as a candidate and reads it back", async () => {
        const { store } = setup();
        const { finding: row, created } = await store.upsert({ projectId: "p1", jobId: "j1-p1", testId: "t-p1", finding: finding() });
        expect(created).toBe(true);
        expect(row).toMatchObject({ projectId: "p1", status: "candidate", fingerprint: FP, firstJobId: "j1-p1", lastJobId: "j1-p1", testId: "t-p1", seenCount: 1, confidence: "high", capture: "captured" });
        expect(row.finding.expected).toEqual({ text: "The total equals the sum of the lines minus the discount.", source: "R-4" });
        expect(await store.get("p1", row.id)).toEqual(row);
    });

    it("upserts by fingerprint: the count and last seen move, the first run stays, the rest is the latest", async () => {
        const { store } = setup();
        const first = await store.upsert({ projectId: "p1", jobId: "j1-p1", testId: "t-p1", finding: finding() });
        const again = await store.upsert({ projectId: "p1", jobId: "j2-p1", testId: "t-p1", finding: finding({ independence: "state_dependent", confidence: "medium", observed: "Now 41.00" }) });
        expect(again.created).toBe(false);
        expect(again.finding.id).toBe(first.finding.id);
        expect(again.finding).toMatchObject({ seenCount: 2, firstJobId: "j1-p1", lastJobId: "j2-p1", confidence: "medium", firstSeenAt: first.finding.firstSeenAt });
        expect(again.finding.lastSeenAt > first.finding.lastSeenAt).toBe(true);
        expect(again.finding.finding.observed).toBe("Now 41.00");
        expect(await store.list("p1")).toHaveLength(1);
    });

    it("lists at most CANDIDATE_FINDINGS_LIST_MAX findings, newest seen first, and a smaller limit when asked (CP2 L-6)", async () => {
        const { db } = setup();
        let t = 0;
        const store = new CandidateFindingStore(db.sql, () => new Date(Date.UTC(2026, 10, 17) + 1000 * t++).toISOString());
        const fp = (i: number) => i.toString(16).padStart(64, "0");
        const n = CANDIDATE_FINDINGS_LIST_MAX + 3;
        for (let i = 0; i < n; i++) await store.upsert({ projectId: "p1", jobId: "j1-p1", finding: finding({ fingerprint: fp(i) }) });
        const all = await store.list("p1");
        expect(all).toHaveLength(CANDIDATE_FINDINGS_LIST_MAX);
        expect(all[0]!.fingerprint).toBe(fp(n - 1));
        expect(all.at(-1)!.fingerprint).toBe(fp(3));
        expect(await store.list("p1", { jobId: "j1-p1" })).toHaveLength(CANDIDATE_FINDINGS_LIST_MAX);
        expect((await store.list("p1", { limit: 2 })).map((f) => f.fingerprint)).toEqual([fp(n - 1), fp(n - 2)]);
        // A limit above the cap, or one that is not a positive whole number, is the cap.
        expect(await store.list("p1", { limit: 10_000 })).toHaveLength(CANDIDATE_FINDINGS_LIST_MAX);
        for (const bad of [0, -1, 1.5, Number.NaN]) expect(await store.list("p1", { limit: bad })).toHaveLength(CANDIDATE_FINDINGS_LIST_MAX);
    });

    it("lists a project's findings, or those one run found", async () => {
        const { store } = setup();
        await store.upsert({ projectId: "p1", jobId: "j1-p1", finding: finding() });
        await store.upsert({ projectId: "p1", jobId: "j2-p1", finding: finding({ fingerprint: "b".repeat(64) }) });
        await store.upsert({ projectId: "p1", jobId: "j2-p1", finding: finding() });
        expect((await store.list("p1")).map((f) => f.fingerprint).sort()).toEqual([FP, "b".repeat(64)]);
        expect((await store.list("p1", { jobId: "j1-p1" })).map((f) => f.fingerprint)).toEqual([FP]);
        expect((await store.list("p1", { jobId: "j2-p1" })).map((f) => f.fingerprint).sort()).toEqual([FP, "b".repeat(64)]);
    });

    it("never reads or writes across projects", async () => {
        const { store, db } = setup();
        const { finding: row } = await store.upsert({ projectId: "p1", jobId: "j1-p1", testId: "t-p1", finding: finding() });
        expect(await store.get("p2", row.id)).toBeUndefined();
        expect(await store.list("p2")).toEqual([]);
        expect(await store.list("p2", { jobId: "j1-p1" })).toEqual([]);
        // Another project's run or test is refused, and nothing is written.
        await expect(store.upsert({ projectId: "p1", jobId: "j1-p2", finding: finding({ fingerprint: "c".repeat(64) }) })).rejects.toThrow(/run/);
        await expect(store.upsert({ projectId: "p1", testId: "t-p2", finding: finding({ fingerprint: "c".repeat(64) }) })).rejects.toThrow(/test/);
        // The same fingerprint in another project is its own finding; p1's is untouched.
        const other = await store.upsert({ projectId: "p2", jobId: "j1-p2", finding: finding() });
        expect(other.created).toBe(true);
        expect(other.finding.id).not.toBe(row.id);
        expect((await store.get("p1", row.id))!.seenCount).toBe(1);
        expect(db.all("SELECT project_id FROM candidate_findings ORDER BY project_id")).toEqual([{ project_id: "p1" }, { project_id: "p2" }]);
    });

    it("refuses a status other than candidate, and a finding that does not parse", async () => {
        const { store, db } = setup();
        await expect(store.upsert({ projectId: "p1", status: "confirmed", finding: finding() })).rejects.toThrow(/candidate/);
        await expect(store.upsert({ projectId: "p1", finding: { ...finding(), confidence: "confirmed" } })).rejects.toThrow();
        expect(db.all("SELECT * FROM candidate_findings")).toEqual([]);
        expect((await store.upsert({ projectId: "p1", status: "candidate", finding: finding() })).finding.status).toBe("candidate");
    });
});
