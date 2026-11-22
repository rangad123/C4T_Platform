/**
 * Phase 4 Q4: the "authorization" value of the risky-checks gate (security/authorization-gate.ts) comes only from the project's own
 * records: a current client authorization for a security application with the job's origin. Another origin, another project, a revoked
 * or a stale authorization (the scope changed after it was given) does not count. No browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Db } from "../src/platform/db.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { hasCurrentAuthorization } from "../src/security/authorization-gate.js";
import { SecurityStore } from "../src/security/store.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-gate-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the risky-checks gate's authorization", () => {
    const db = new Db(path.join(dir, "t.db"));
    const repo = new Repo(db, new SecretBox(dir));
    const store = new SecurityStore(db);
    const mine = repo.createProject({ name: "Client" }).id;
    const other = repo.createProject({ name: "Other" }).id;
    const app = store.createApplication(mine, { name: "Shop", targetUrl: "https://shop.example.test/", environment: "staging", scope: [], excludedPaths: [], maxRequestsPerSecond: 10 });
    const authorize = (id: string) => store.addAuthorization(id, { basis: "owner", approverName: "Owner", documentReference: null, restrictions: null, statement: "I confirm.", confirmedByName: "Tester" });

    it("is false without an authorization, and true with a current one for the same origin only", () => {
        expect(hasCurrentAuthorization(db, mine, "https://shop.example.test/checkout")).toBe(false);
        const a = authorize(app.id);
        expect(hasCurrentAuthorization(db, mine, "https://shop.example.test/checkout")).toBe(true);
        expect(hasCurrentAuthorization(db, mine, "https://other.example.test/")).toBe(false);
        expect(hasCurrentAuthorization(db, mine, "http://shop.example.test/")).toBe(false);
        expect(hasCurrentAuthorization(db, other, "https://shop.example.test/")).toBe(false);
        expect(hasCurrentAuthorization(db, mine, "not a url")).toBe(false);
        store.revokeAuthorization(a.id, "Tester");
        expect(hasCurrentAuthorization(db, mine, "https://shop.example.test/")).toBe(false);
    });

    it("is false once the scope changed after the authorization (stale)", () => {
        authorize(app.id);
        expect(hasCurrentAuthorization(db, mine, "https://shop.example.test/")).toBe(true);
        store.updateApplication(app.id, { excludedPaths: ["/admin"] });
        expect(hasCurrentAuthorization(db, mine, "https://shop.example.test/")).toBe(false);
    });
});
