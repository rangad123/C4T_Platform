/**
 * C3e writes as a second or lesser identity, browser-free: the gate (not generated without it), which checks the survey evidence makes,
 * the write budget, and the helper's own-host guard. The bench-rbac run is tests/identity-writes.test.ts.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { ACCESS_HELPER_SOURCE, type ApiAccessRow, type ApiListRow } from "../src/engine/identity/access.js";
import { generateIdentityWriteSpecs, identityWritesAllowed, MAX_IDENTITY_WRITES } from "../src/engine/identity/identity-writes.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessHelper } from "./identity-fake-browser.js";

const err = (d: string) => ({ description: d, content: { "application/json": { schema: { type: "object" } } } });
const doc = (paths: Record<string, unknown>) => parseOpenApi({ openapi: "3.0.0", info: { title: "t", version: "1" }, paths }, "http://127.0.0.1:1/openapi.json").operations;
const PATHS = {
    "/api/me": { get: { responses: { 200: err("Person"), 401: err("Not signed in") } } },
    "/api/notes": { get: { responses: { 200: err("Notes") } } },
    "/api/notes/{id}": {
        get: { responses: { 200: err("Note"), 404: err("Not found or not visible to you") } },
        put: { summary: "Change a note (owner only)", responses: { 200: err("Changed"), 403: err("Not the owner"), 404: err("Not found") } },
        delete: { responses: { 200: err("Deleted"), 403: err("Not the owner") } },
    },
    "/api/notes/{id}/share/{userId}": { delete: { responses: { 200: err("No longer shared") } } },
    "/api/admin/users": { get: { responses: { 200: err("People"), 403: err("Not an admin") } } },
    "/api/admin/users/{id}": { patch: { responses: { 200: err("Changed"), 403: err("Not an admin") } } },
};
const n = (id: string, owner: string) => ({ id, owner });
const LISTS: ApiListRow[] = [
    {
        list: "/api/notes",
        detail: "/api/notes/{id}",
        documented: [404],
        items: { ana: [n("n1", "Ana"), n("n3", "Ben")], ben: [n("n2", "Ben"), n("n3", "Ben")], mia: [n("n1", "Ana"), n("n2", "Ben"), n("n3", "Ben")], ada: [n("n1", "Ana"), n("n2", "Ben"), n("n3", "Ben")] },
    },
];
const ACCESS: ApiAccessRow[] = [{ method: "GET", path: "/api/admin/users", called: "/api/admin/users", status: { anonymous: 401, ana: 403, ben: 403, mia: 403, ada: 200 }, signedIn: ["ana", "ben", "mia", "ada"], documented: [403] }];
const cfg = (s: { steps: unknown[] }) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, unknown>;
const WRITES: Record<string, number> = { owner: 1, role: 2, revoke: 1 };

describe("C3e writes as another identity", () => {
    it("is not generated without the gate: data changes on, and authorization or a bench/fixture app on loopback", () => {
        const at = (o: Partial<Parameters<typeof identityWritesAllowed>[0]>) => identityWritesAllowed({ allowMutatingApiTests: true, url: "http://127.0.0.1:9000/", ...o });
        expect(at({})).toBe(false);
        expect(at({ riskyChecksGate: "bench", allowMutatingApiTests: false })).toBe(false);
        expect(at({ riskyChecksGate: "bench", url: "https://shop.example/" })).toBe(false);
        expect(at({ riskyChecksGate: "fixture", url: "http://10.0.0.5/" })).toBe(false);
        expect(at({ riskyChecksGate: "authorization", allowMutatingApiTests: false })).toBe(false);
        expect(at({ riskyChecksGate: "bench" })).toBe(true);
        expect(at({ riskyChecksGate: "fixture", url: "http://localhost:3000/" })).toBe(true);
        expect(at({ riskyChecksGate: "authorization", url: "https://shop.example/" })).toBe(true);
    });

    it("makes the owner write as the sharing reader, the revoke by the owner, and the role change per refused account, within 8 writes", () => {
        const specs = generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: ACCESS });
        expect(specs.map(cfg)).toEqual([
            { identityWrite: "owner", as: "ana", method: "PUT", path: "/api/notes/n3", documented: "403 or 404", sev: "high" },
            { identityWrite: "revoke", as: "ana", by: "ben", method: "DELETE", path: "/api/notes/n3/share/{userId}", param: "userId", read: "/api/notes/n3", whoAmI: "/api/me", documented: "404", sev: "high" },
            ...["ana", "ben", "mia"].map((as) => ({ identityWrite: "role", as, by: "ada", method: "PATCH", path: "/api/admin/users/{id}", param: "id", whoAmI: "/api/me", documented: "403", sev: "high" })),
        ]);
        expect(specs.reduce((t, s) => t + WRITES[String(cfg(s).identityWrite)]!, 0)).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        // DELETE as a non-owner is never sent: a wrongly accepted delete cannot be put back.
        expect(specs.some((s) => cfg(s).identityWrite === "owner" && cfg(s).method === "DELETE")).toBe(false);
        for (const s of specs) expect(renderScript(TestSpecSchema.parse({ ...s, testId: "WEB-001" }), "playwright", { baseUrl: "http://127.0.0.1:9000" }).content).toContain("accessWriteAssert(page, base, cfg)");
    });

    it("keeps to the write budget however many accounts were refused", () => {
        const many = Object.fromEntries([...Array(10).keys()].map((i) => [`u${i}`, 403]));
        const specs = generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: [{ ...ACCESS[0]!, status: { ...many, ada: 200 } }] });
        expect(specs.reduce((t, s) => t + WRITES[String(cfg(s).identityWrite)]!, 0)).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        expect(specs.length).toBe(1 + 1 + 3);
    });

    it("needs the evidence: documented refusal words, a who-am-I endpoint, a reader that does not read everything", () => {
        const plain = { ...PATHS, "/api/notes/{id}": { ...PATHS["/api/notes/{id}"], put: { responses: { 200: err("Changed"), 403: err("Forbidden") } } }, "/api/admin/users/{id}": { patch: { responses: { 200: err("Changed"), 403: err("Forbidden") } } } };
        expect(generateIdentityWriteSpecs({ apis: doc(plain), lists: LISTS, access: ACCESS }).map((s) => cfg(s).identityWrite)).toEqual(["revoke"]);
        const { "/api/me": _me, ...noMe } = PATHS;
        expect(generateIdentityWriteSpecs({ apis: doc(noMe), lists: LISTS, access: ACCESS }).map((s) => cfg(s).identityWrite)).toEqual(["owner"]);
        // Only readers of everything (a manager, an admin): no one reads a record through sharing.
        const allRead: ApiListRow = { ...LISTS[0]!, items: { mia: LISTS[0]!.items.mia!, ada: LISTS[0]!.items.ada! } };
        expect(generateIdentityWriteSpecs({ apis: doc(PATHS), lists: [allRead], access: [] })).toEqual([]);
        // Nobody was allowed the endpoint: no account to take a role from.
        expect(generateIdentityWriteSpecs({ apis: doc(PATHS), lists: [], access: [{ ...ACCESS[0]!, status: { ana: 403, ada: 403 } }] })).toEqual([]);
    });

    it("the helper calls nothing on a host that is not the application's own", async () => {
        expect(ACCESS_HELPER_SOURCE).toContain("async function accessWriteAssert(");
        let contexts = 0;
        const page = { context: () => ({ browser: () => ({ newContext: async () => (contexts++, {}) }) }) };
        for (const c of [{ origin: "http://evil.example" }, { path: "//evil.example/api/notes/n3" }, { whoAmI: "http://evil.example/me" }]) {
            const run = { identityWrite: "owner", as: "ana", method: "PUT", path: "/api/notes/n3", sev: "high", ...c };
            await expect(accessHelper.accessAssert(page, "http://127.0.0.1:9000/", JSON.stringify(run))).rejects.toThrow(/not the application's own( address)?, so nothing was called/);
        }
        for (const c of [{ method: "DELETE" }, { method: "POST" }, { identityWrite: "revoke", method: "PUT" }]) {
            const run = { identityWrite: "owner", as: "ana", path: "/api/notes/n3", sev: "high", ...c };
            await expect(accessHelper.accessAssert(page, "http://127.0.0.1:9000/", JSON.stringify(run))).rejects.toThrow(/is not one this check sends, so nothing was called/);
        }
        expect(contexts).toBe(0);
    });
});
