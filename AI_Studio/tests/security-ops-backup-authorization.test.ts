/**
 * A crafted backup cannot restore a client authorization that never expires or cannot be revoked: the backup's
 * dates must be real ISO dates not in the future; a restored authorization is always revoked from the moment of the restore and never
 * dated later than it, so an authorization recorded afterwards is the latest and counts; an empty revocation date reads as revoked.
 *
 * No server, no ports, no browser: the platform database only.
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/security-ops-backup-authorization.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { authorizationStateOf } from "../src/security/authorization.js";
import { exportSecurityData, importSecurityData, SecurityBackupSchema } from "../src/security/backup.js";
import { securityStoreFor, type AuthorizationInput } from "../src/security/store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-backup-auth-"));
let platform: Platform;
const auth: AuthorizationInput = {
    basis: "owner",
    approverName: "Client Person",
    approverRole: "Head of Engineering",
    approverEmail: "person@client.example",
    documentReference: "SOW-1",
    authority: "Signed SOW-1.",
    statement: "I confirm.",
    confirmedByName: "Owner",
    maxProfile: "advanced",
};

beforeAll(() => {
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
});
afterAll(() => {
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A project with one application and its current authorization, exported. */
function exported() {
    const store = securityStoreFor(platform.db);
    const pid = platform.repo.createProject({ name: "Client" }).id as string;
    store.setTestingType(pid, "both");
    const app = store.createApplication(pid, { name: "Shop", targetUrl: "https://staging.shop.example.com/", environment: "staging" });
    store.addAuthorization(app.id, auth);
    return exportSecurityData(platform.db, pid)!.doc;
}

describe("restoring authorizations", () => {
    it("refuses an empty, unreadable or far-future date in the file", () => {
        const doc = exported();
        const tamper = (patch: Record<string, unknown>) => SecurityBackupSchema.safeParse({ ...doc, authorizations: [{ ...doc.authorizations[0]!, ...patch }] }).success;
        expect(tamper({})).toBe(true);
        expect(tamper({ revokedAt: "" })).toBe(false);
        expect(tamper({ revokedAt: "yesterday" })).toBe(false);
        expect(tamper({ confirmedAt: "2099-01-01T00:00:00.000Z" })).toBe(false);
        expect(tamper({ confirmedAt: "2026-13-45T99:00:00Z" })).toBe(false);
    });

    it("a restored authorization is revoked now and never dated after the restore, so a newer authorization counts", () => {
        const doc = exported();
        // Within the clock tolerance the file may say "a minute from now": still stored as now at the latest.
        const soon = new Date(Date.now() + 60_000).toISOString();
        const parsed = SecurityBackupSchema.parse({ ...doc, authorizations: [{ ...doc.authorizations[0]!, confirmedAt: soon, revokedAt: null }] });
        const store = securityStoreFor(platform.db);
        const pid = platform.repo.createProject({ name: "Restored" }).id as string;
        const before = Date.now();
        importSecurityData(platform.db, pid, parsed);
        const app = store.listApplications(pid)[0]!;
        const restored = store.listAuthorizations(app.id)[0]!;
        expect(restored.revokedAt).not.toBeNull();
        expect(Date.parse(restored.revokedAt!)).toBeGreaterThanOrEqual(before - 1000);
        expect(Date.parse(restored.confirmedAt)).toBeLessThanOrEqual(Date.now());
        expect(store.authorizationState(app).state).toBe("revoked");
        // Recorded after the restore: it is the latest, and it counts (the restored one never shadows it).
        const fresh = store.addAuthorization(app.id, auth);
        expect(store.authorizationState(app)).toMatchObject({ state: "current", authorizationId: fresh.id });
    });

    it("a restored date written with an offset is stored in the platform's own form, so it cannot sort ahead of a newer authorization", () => {
        const doc = exported();
        // A past instant (an hour ago) written with the largest offset: as text it sorts after every real record for about a day.
        const past = new Date(Date.now() - 3_600_000);
        const shifted = new Date(past.getTime() + (23 * 60 + 59) * 60_000).toISOString().slice(0, 16) + "+23:59";
        expect(Date.parse(shifted)).toBe(Math.floor(past.getTime() / 60_000) * 60_000);
        const parsed = SecurityBackupSchema.parse({ ...doc, authorizations: [{ ...doc.authorizations[0]!, confirmedAt: shifted, revokedAt: null }] });
        expect(parsed.authorizations[0]!.confirmedAt).toBe(new Date(Date.parse(shifted)).toISOString());
        const store = securityStoreFor(platform.db);
        const pid = platform.repo.createProject({ name: "Restored offset" }).id as string;
        importSecurityData(platform.db, pid, parsed);
        const app = store.listApplications(pid)[0]!;
        expect(store.listAuthorizations(app.id)[0]!.confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const fresh = store.addAuthorization(app.id, auth);
        expect(store.authorizationState(app)).toMatchObject({ state: "current", authorizationId: fresh.id });
    });

    it("an empty revocation date reads as revoked, not as current", () => {
        const app = { targetUrl: "https://x.example/", scope: [], excludedPaths: [], maxRequestsPerSecond: 2 };
        expect(authorizationStateOf(app, { id: "a", revokedAt: "", scopeFingerprint: "x" }).state).toBe("revoked");
    });
});
