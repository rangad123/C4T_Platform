/**
 * Approved: an authorization recorded without the new authorizer details (a legacy record: no role, authority or details fingerprint)
 * is never valid indefinitely. It stops counting 90 days after the release was deployed (release.ts: a timestamp shipped with the code,
 * so a database restored from a backup made before the release cannot extend it). The stricter reading: release + 90 days, whenever
 * the record was confirmed. Judged on the server at start (currentAuthorization), approval (which needs a current authorization) and
 * display (authorizationState, expiresAt). A fake clock (Date only) moves time.
 *
 *   npx vitest run tests/security-profile-gate-expiry-legacy.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { AUTHORIZATION_WORDS, authorizationStateOf, LEGACY_AUTHORIZATION_EXPIRES_AT, scopeFingerprint } from "../src/security/authorization.js";
import { LEGACY_AUTHORIZATION_RELEASE_AT } from "../src/security/release.js";
import { SecurityStore } from "../src/security/store.js";

const DAY = 86_400_000;
const RELEASE = Date.parse(LEGACY_AUTHORIZATION_RELEASE_AT);
const EXPIRES = new Date(RELEASE + 90 * DAY).toISOString();
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-sec-legacy-"));
    dirs.push(d);
    return d;
};
const at = (ms: number) => vi.setSystemTime(new Date(ms));

afterEach(() => {
    vi.useRealTimers();
});
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A database as the old version left it: a legacy row recorded long before the release, under the old rules. */
function legacyDatabase(file: string, dir: string) {
    const db = new Db(file);
    const projectId = new Repo(db, new SecretBox(dir)).createProject({ name: "Client" }).id;
    const store = new SecurityStore(db);
    const app = store.createApplication(projectId, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging", maxRequestsPerSecond: 2 });
    // Written as the old version wrote it: no approver role, authority or details fingerprint.
    db.run(
        "INSERT INTO security_authorizations (id, application_id, basis, approver_name, statement, confirmed_by_name, confirmed_at, scope_fingerprint) VALUES (?,?,?,?,?,?,?,?)",
        "legacy-1",
        app.id,
        "owner",
        "Dana",
        "I confirm.",
        "Olga",
        new Date(RELEASE - 400 * DAY).toISOString(),
        scopeFingerprint(app),
    );
    return { db, store, app };
}

describe("the release timestamp (release check)", () => {
    it("is set to a real deployment time: readable, not in the future, and not before the rule was built", () => {
        expect(LEGACY_AUTHORIZATION_RELEASE_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
        expect(Number.isFinite(RELEASE)).toBe(true);
        // A future value would let a database restored after the deployment keep legacy records longer than 90 days.
        expect(RELEASE).toBeLessThanOrEqual(Date.now());
        // The rule was built on 2026-11-14: an earlier value is a placeholder (or would expire legacy records before they were warned).
        expect(RELEASE).toBeGreaterThanOrEqual(Date.parse("2026-11-14T00:00:00.000Z"));
        expect(LEGACY_AUTHORIZATION_EXPIRES_AT).toBe(EXPIRES);
    });
});

describe("legacy authorizations expire 90 days after the release was deployed", () => {
    it("counts on day 89 after the release and not on day 91, at start and when shown", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        at(RELEASE + 3 * DAY); // the database is first opened by the new version some days after the deployment: it does not matter
        const dir = tmp();
        const { db, store, app } = legacyDatabase(path.join(dir, "t.db"), dir);
        try {
            // Confirmed 400 days before the release, it still counts until release + 90 days (not confirmed_at + 90, not first open + 90).
            expect(store.getAuthorization("legacy-1")).toMatchObject({ detailsRecorded: false, expiresAt: EXPIRES });
            expect(store.listAuthorizations(app.id)[0]).toMatchObject({ id: "legacy-1", expiresAt: EXPIRES });

            at(RELEASE + 89 * DAY);
            expect(store.authorizationState(app)).toMatchObject({ state: "current", detailsRecorded: false, expiresAt: EXPIRES });
            expect(store.currentAuthorization(app)?.id).toBe("legacy-1");

            at(RELEASE + 91 * DAY);
            expect(store.authorizationState(app)).toEqual({ state: "expired", message: AUTHORIZATION_WORDS.legacyExpired, authorizationId: "legacy-1", detailsRecorded: false, expiresAt: EXPIRES });
            expect(store.currentAuthorization(app)).toBeUndefined();
            // The exact boundary: expired at release + 90 days.
            expect(store.authorizationState(app, RELEASE + 90 * DAY).state).toBe("expired");
            expect(store.authorizationState(app, RELEASE + 90 * DAY - 1).state).toBe("current");
        } finally {
            db.close();
        }
    });

    it("a backup made before the release and restored after it does not get a later expiry", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        at(RELEASE - 30 * DAY); // the old version is still running when the backup is made
        const dir = tmp();
        const file = path.join(dir, "t.db");
        const first = legacyDatabase(file, dir);
        const appId = first.app.id;
        first.db.close();
        const restored = path.join(dir, "restored.db");
        fs.copyFileSync(file, restored);

        // Restored, and first opened by the new version, 60 days after the release: still release + 90, so 30 days left.
        at(RELEASE + 60 * DAY);
        let db = new Db(restored);
        try {
            const store = new SecurityStore(db);
            const app = store.getApplication(appId)!;
            expect(store.authorizationState(app)).toMatchObject({ state: "current", expiresAt: EXPIRES });
            at(RELEASE + 91 * DAY);
            expect(store.authorizationState(app)).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.legacyExpired, expiresAt: EXPIRES });
            expect(store.currentAuthorization(app)).toBeUndefined();
        } finally {
            db.close();
        }

        // Restored 200 days after the release: expired at once, nothing recorded in the database moves it.
        fs.copyFileSync(file, restored);
        at(RELEASE + 200 * DAY);
        db = new Db(restored);
        try {
            const store = new SecurityStore(db);
            const app = store.getApplication(appId)!;
            expect(store.authorizationState(app)).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.legacyExpired, expiresAt: EXPIRES });
            expect(store.currentAuthorization(app)).toBeUndefined();
            expect(db.all("SELECT key FROM auth_settings WHERE key LIKE 'security.%'")).toHaveLength(0);
        } finally {
            db.close();
        }
    });

    it("a fresh install has no legacy rows; new authorizations keep their own 90 days", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        at(RELEASE + 200 * DAY); // installed long after the release: legacy expiry is irrelevant to it
        const dir = tmp();
        const db = new Db(path.join(dir, "fresh.db"));
        try {
            const projectId = new Repo(db, new SecretBox(dir)).createProject({ name: "Client" }).id;
            const store = new SecurityStore(db);
            expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_authorizations")!.n).toBe(0);
            const app = store.createApplication(projectId, { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging" });
            const recorded = RELEASE + 260 * DAY;
            at(recorded);
            const full = store.addAuthorization(app.id, { basis: "client-permission", approverName: "Dana", approverRole: "CTO", approverEmail: "dana@client.example", documentReference: "SOW-1", authority: "Signed SOW-1.", statement: "I confirm.", confirmedByName: "Olga" });
            expect(full).toMatchObject({ detailsRecorded: true, expiresAt: new Date(recorded + 90 * DAY).toISOString() });
            expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM security_authorizations WHERE details_fingerprint IS NULL")!.n).toBe(0);
            at(recorded + 89 * DAY);
            expect(store.authorizationState(app).state).toBe("current");
            at(recorded + 91 * DAY);
            expect(store.authorizationState(app)).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.expired });
        } finally {
            db.close();
        }
    });

    it("the rule itself: release + 90 days, whenever the record was confirmed", () => {
        const app = { targetUrl: "https://shop.example.com/", scope: [], excludedPaths: [], maxRequestsPerSecond: 2 };
        const latest = { id: "a", revokedAt: null, scopeFingerprint: scopeFingerprint(app), confirmedAt: new Date(RELEASE - 10 * DAY).toISOString(), detailsFingerprint: null };
        expect(authorizationStateOf(app, latest, { now: RELEASE + 89 * DAY })).toMatchObject({ state: "current", expiresAt: EXPIRES });
        expect(authorizationStateOf(app, latest, { now: RELEASE + 91 * DAY })).toMatchObject({ state: "expired", message: AUTHORIZATION_WORDS.legacyExpired });
        // Without a confirmation date too: never valid indefinitely.
        expect(authorizationStateOf(app, { ...latest, confirmedAt: undefined }, { now: RELEASE + 91 * DAY }).state).toBe("expired");
        // Revocation still wins at once.
        expect(authorizationStateOf(app, { ...latest, revokedAt: new Date(RELEASE).toISOString() }, { now: RELEASE }).state).toBe("revoked");
    });
});
