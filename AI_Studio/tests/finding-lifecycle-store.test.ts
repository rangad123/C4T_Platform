/**
 * The finding lifecycle in the store (Phase 5 task S1, slot 71): `transition` moves a finding only along the lifecycle table
 * (engine/findings/lifecycle.ts), records who, when, from, to and why in `history`, and may set the verification facts at the same time;
 * `group` and `groups` keep duplicate groups. Every read and write is scoped by project: another project's id never reads or writes.
 */
import { describe, expect, it } from "vitest";
import { CandidateFindingStore } from "../src/platform/candidate-finding-store.js";
import { Db } from "../src/platform/db.js";

const at = "2026-11-21T10:00:00.000Z";

const finding = (fp: string) => ({
    objective: { id: "obj-1", kind: "rule", source: "R-4" },
    actions: { stepCount: 6 },
    expected: { text: "The total equals the sum of the lines.", source: "R-4" },
    observed: "The total shows 40.00 for two lines of 15.00.",
    evidence: { screenshots: [], requests: [], console: [] },
    capture: "captured",
    independence: "independent",
    confidence: "high",
    fingerprint: fp,
    modelVersion: "v1",
    replays: [],
});

async function setup() {
    const db = new Db(":memory:");
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", p, "u-1", p, at, at);
    let tick = 0;
    const store = new CandidateFindingStore(db.sql, () => `2026-11-21T10:00:${String(tick++).padStart(2, "0")}.000Z`);
    const a = (await store.upsert({ projectId: "p1", finding: finding("a".repeat(64)) })).finding;
    const b = (await store.upsert({ projectId: "p1", finding: finding("b".repeat(64)) })).finding;
    const other = (await store.upsert({ projectId: "p2", finding: finding("a".repeat(64)) })).finding;
    return { db, store, a, b, other };
}

describe("finding lifecycle store", () => {
    it("starts a stored finding as a candidate with no verification facts", async () => {
        const { store, a } = await setup();
        expect(a).toMatchObject({ state: "candidate", findingClass: null, severity: null, confidenceDetail: null, groupId: null, attempts: [], appVersion: null });
        expect(await store.history("p1", a.id)).toEqual([]);
    });

    it("moves a finding along the table, sets the facts with it, and keeps the history in order", async () => {
        const { store, a } = await setup();
        await store.transition("p1", a.id, { to: "verification_pending", by: "engine" });
        const attempts = [{ outcome: "failed", step: 6 }, { outcome: "failed", step: 6 }, { outcome: "passed" }];
        const r = await store.transition("p1", a.id, { to: "reproduced", by: "engine", set: { attempts, appVersion: "1.4.2" } });
        expect(r).toMatchObject({ state: "reproduced", attempts, appVersion: "1.4.2", findingClass: null });
        await expect(store.transition("p1", a.id, { to: "confirmed", by: "engine" })).rejects.toThrow(/only at high confidence/);
        const c = await store.transition("p1", a.id, { to: "confirmed", by: "engine", set: { findingClass: "app_defect", severity: "high", confidence: { confidence: "high" as const, basis: "reproduced 2 of 3", factors: { evidence: { value: "high" as const, reason: "captured" }, reproduction: { value: "high" as const, reason: "2 of 3" }, expectation: { value: "high" as const, reason: "R-4" }, signals: { value: 0, reason: "none" } } } } });
        expect(c).toMatchObject({ state: "confirmed", findingClass: "app_defect", severity: "high", confidenceDetail: { confidence: "high" }, attempts, appVersion: "1.4.2" });
        await store.transition("p1", a.id, { to: "not_a_bug", by: "person", actor: { id: "u-1", label: "One (u-1)" }, reason: "Fixed in the build we test now; password=hunter2" });
        const h = await store.history("p1", a.id);
        expect(h.map((e) => [e.from, e.to, e.by])).toEqual([
            ["candidate", "verification_pending", "engine"],
            ["verification_pending", "reproduced", "engine"],
            ["reproduced", "confirmed", "engine"],
            ["confirmed", "not_a_bug", "person"],
        ]);
        expect(h[0]).toMatchObject({ actor: "Engine", actorId: null, reason: null });
        expect(h[3]).toMatchObject({ actor: "One (u-1)", actorId: "u-1" });
        expect(h[3]!.reason).toContain("Fixed in the build");
        expect(h[3]!.reason).not.toContain("hunter2");
        expect((await store.get("p1", a.id))!.state).toBe("not_a_bug");
    });

    it("refuses a move the table does not allow, or one without the reason it needs, and changes nothing", async () => {
        const { store, a } = await setup();
        await expect(store.transition("p1", a.id, { to: "reported", by: "engine" })).rejects.toThrow(/cannot move from Candidate to Reported/);
        await expect(store.transition("p1", a.id, { to: "verification_pending", by: "person" })).rejects.toThrow(/Only the engine/);
        await expect(store.transition("p1", a.id, { to: "verification_pending", by: "engine", stepFault: "Step 3 clicks a button the test never opened." })).rejects.toThrow(/test's own step/);
        await expect(store.transition("p1", a.id, { to: "duplicate", by: "engine", set: { severity: "high" } })).rejects.toThrow(/add a reason/);
        await expect(store.transition("p1", a.id, { to: "nonsense" as never, by: "engine" })).rejects.toThrow(/not a finding state/);
        expect(await store.get("p1", a.id)).toMatchObject({ state: "candidate", severity: null });
        expect(await store.history("p1", a.id)).toEqual([]);
    });

    it("never reads or writes another project's finding", async () => {
        const { store, a, other } = await setup();
        expect(await store.transition("p2", a.id, { to: "verification_pending", by: "engine" })).toBeUndefined();
        expect((await store.get("p1", a.id))!.state).toBe("candidate");
        await store.transition("p1", a.id, { to: "verification_pending", by: "engine" });
        expect(await store.history("p2", a.id)).toEqual([]);
        expect(await store.history("p1", other.id)).toEqual([]);
        await expect(store.group("p2", [a.id], { signals: ["path"] })).rejects.toThrow(/not in this project/);
        expect((await store.get("p1", a.id))!.groupId).toBeNull();
        expect(await store.groups("p2")).toEqual([]);
    });

    it("groups findings of one project, lists the groups with their members, and moves a member to a new group", async () => {
        const { store, a, b, other } = await setup();
        const g = await store.group("p1", [a.id, b.id], { method: "POST", path: "/api/cart" });
        expect(g.projectId).toBe("p1");
        expect((await store.get("p1", a.id))!.groupId).toBe(g.id);
        const g2 = await store.group("p1", [b.id], { method: "GET", path: "/api/cart" });
        expect(await store.groups("p1")).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: g.id, signature: { method: "POST", path: "/api/cart" }, findingIds: [a.id] }),
                expect.objectContaining({ id: g2.id, findingIds: [b.id] }),
            ]),
        );
        await store.group("p2", [other.id], {});
        expect((await store.groups("p1")).map((x) => x.id).sort()).toEqual([g.id, g2.id].sort());
        await expect(store.group("p1", [], {})).rejects.toThrow(/at least one finding/);
    });
});
