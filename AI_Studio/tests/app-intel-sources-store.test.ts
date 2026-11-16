/**
 * Application intelligence sources (migration 64): one row per connected source in a project, its fingerprint, status and the sentence
 * saying why it failed; the application version and source fingerprints recorded with each model version; every read and write scoped
 * by project. Pure database (fast tier).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppIntelStore } from "../src/platform/app-intel-store.js";
import { Db } from "../src/platform/db.js";

const at = "2026-11-16T09:00:00.000Z";
let db: Db;
let store: AppIntelStore;

beforeAll(() => {
    db = new Db(":memory:");
    db.run("INSERT INTO users (id, email, name, created_at, role, status) VALUES (?,?,?,?,?,?)", "u-1", "one@people.example", "One", at, "owner", "active");
    for (const p of ["p1", "p2"]) db.run("INSERT INTO projects (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)", p, "u-1", p, at, at);
    store = new AppIntelStore(db.sql, () => at);
});
afterAll(() => db.close());

const OPENAPI = { kind: "openapi", ref: "https://shop.test/openapi.json" } as const;

describe("sources", () => {
    it("are connected once per kind and reference, then updated in place", async () => {
        const a = await store.upsertSource("p1", { ...OPENAPI, status: "connected" });
        expect(a).toMatchObject({ kind: "openapi", ref: OPENAPI.ref, status: "connected", fingerprint: "", error: null, processedAt: null, modelVersionId: null });
        const b = await store.upsertSource("p1", { ...OPENAPI, status: "processed", fingerprint: "f".repeat(64) });
        expect(b.id).toBe(a.id);
        expect(b).toMatchObject({ status: "processed", fingerprint: "f".repeat(64), processedAt: at, error: null });
        expect((await store.sources("p1")).map((s) => s.id)).toEqual([a.id]);
    });

    it("that failed say why in a sentence, and lose it when they succeed again", async () => {
        await expect(store.upsertSource("p1", { ...OPENAPI, status: "failed" })).rejects.toThrow(/says why/);
        const failed = await store.upsertSource("p1", { ...OPENAPI, status: "failed", error: "The document could not be fetched." });
        expect(failed).toMatchObject({ status: "failed", error: "The document could not be fetched.", fingerprint: "f".repeat(64) });
        expect(await store.upsertSource("p1", { ...OPENAPI, status: "processed", fingerprint: "e".repeat(64) })).toMatchObject({ status: "processed", error: null });
    });

    it("refuse a kind that is not a source", async () => {
        await expect(store.upsertSource("p1", { kind: "figma" as never, ref: "x", status: "connected" })).rejects.toThrow();
    });

    it("of one project are never read or written through another", async () => {
        expect(await store.sources("p2")).toEqual([]);
        const other = await store.upsertSource("p2", { ...OPENAPI, status: "connected" });
        expect(other.id).not.toBe((await store.sources("p1"))[0]!.id);
        expect((await store.sources("p1"))[0]).toMatchObject({ status: "processed" });
    });

    it("point only at a model version of their own project", async () => {
        const v = await store.addVersion({ projectId: "p2", model: {} });
        await expect(store.upsertSource("p1", { ...OPENAPI, status: "processed", fingerprint: "e".repeat(64), modelVersionId: v.id })).rejects.toThrow(/not found/);
        const mine = await store.upsertSource("p2", { ...OPENAPI, status: "processed", fingerprint: "e".repeat(64), modelVersionId: v.id });
        expect(mine.modelVersionId).toBe(v.id);
    });
});

describe("model versions", () => {
    it("record the application version and the source fingerprints they were built from", async () => {
        const v = await store.addVersion({
            projectId: "p1",
            model: {},
            appVersion: { source: "person", label: "2.4.1", analysedAt: at },
            sourceFingerprints: { [`openapi:${OPENAPI.ref}`]: "e".repeat(64) },
        });
        expect(v).toMatchObject({ appVersion: { source: "person", label: "2.4.1" }, sourceFingerprints: { [`openapi:${OPENAPI.ref}`]: "e".repeat(64) } });
        expect((await store.latest("p1"))!.appVersion).toEqual({ source: "person", label: "2.4.1", analysedAt: at });
        expect((await store.versions("p1"))[0]).toMatchObject({ appVersion: { label: "2.4.1" } });
    });

    it("never invent an application version: none given is unversioned with the analysis time", async () => {
        const v = await store.addVersion({ projectId: "p1", model: {} });
        expect(v.appVersion).toEqual({ source: "unversioned", label: "", analysedAt: at });
        expect(v.sourceFingerprints).toEqual({});
        await expect(store.addVersion({ projectId: "p1", model: {}, appVersion: { source: "person", label: " ", analysedAt: at } })).rejects.toThrow();
    });
});
