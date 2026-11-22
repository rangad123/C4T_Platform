/**
 * C3e writes as a second or lesser identity, browser-free: the gate (not generated without it), which checks the survey evidence makes,
 * the write budget, and the helper's own-host guard. The bench-rbac run is tests/identity-writes.test.ts.
 */
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { ACCESS_HELPER_SOURCE, type ApiAccessRow, type ApiListRow } from "../src/engine/identity/access.js";
import { generateIdentityWriteSpecs as generate, MAX_IDENTITY_WRITES } from "../src/engine/identity/identity-writes.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { accessHelper, fakeBrowser, setAccounts } from "./identity-fake-browser.js";

const err = (d: string) => ({ description: d, content: { "application/json": { schema: { type: "object" } } } });
const doc = (paths: Record<string, unknown>) => parseOpenApi({ openapi: "3.0.0", info: { title: "t", version: "1" }, paths }, "http://127.0.0.1:1/openapi.json").operations;
const PATHS = {
    "/api/me": { get: { responses: { 200: err("Person"), 401: err("Not signed in") } } },
    "/api/notes": { get: { responses: { 200: err("Notes") } } },
    "/api/notes/{id}": {
        get: { responses: { 200: err("Note"), 404: err("Not found or not visible to you") } },
        put: { summary: "Change a note (owner only)", responses: { 200: err("Changed"), 403: err("Not the owner"), 404: err("Not found") } },
        patch: { summary: "Change some fields of a note (owner only)", responses: { 200: err("Changed"), 403: err("Not the owner"), 404: err("Not found") } },
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
type Input = Parameters<typeof generate>[0];
/** On a bench app on loopback with data changes on: the gate is open. */
const generateIdentityWriteSpecs = (i: Pick<Input, "apis" | "lists" | "access">, gate: Partial<Input> = {}) => generate({ ...i, dataChanges: true, appUrl: "http://127.0.0.1:9000", gate: "bench", ...gate });

describe("C3e writes as another identity", () => {
    it("is not generated without the gate: data changes on, and authorization or a bench/fixture app on loopback", () => {
        const at = (gate: Partial<Input>) => generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: ACCESS }, gate).length > 0;
        expect(at({ gate: undefined })).toBe(false);
        expect(at({ dataChanges: false })).toBe(false);
        expect(at({ appUrl: "https://shop.example" })).toBe(false);
        expect(at({ gate: "fixture", appUrl: "http://10.0.0.5" })).toBe(false);
        expect(at({ gate: "authorization", dataChanges: false })).toBe(false);
        expect(at({})).toBe(true);
        expect(at({ gate: "fixture", appUrl: "http://localhost:3000" })).toBe(true);
        expect(at({ gate: "authorization", appUrl: "https://shop.example" })).toBe(true);
    });

    it("makes the owner write as the sharing reader, the revoke by the owner, and the role change per refused account, within 8 writes", () => {
        const specs = generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: ACCESS });
        expect(specs.map(cfg)).toEqual([
            { identityWrite: "owner", as: "ana", method: "PATCH", path: "/api/notes/n3", documented: "403 or 404", sev: "high" },
            { identityWrite: "revoke", as: "ana", by: "ben", method: "DELETE", path: "/api/notes/n3/share/{userId}", param: "userId", read: "/api/notes/n3", whoAmI: "/api/me", documented: "404", sev: "high" },
            ...["ana", "ben", "mia"].map((as) => ({ identityWrite: "role", as, by: "ada", method: "PATCH", path: "/api/admin/users/{id}", param: "id", whoAmI: "/api/me", documented: "403", sev: "high" })),
        ]);
        expect(specs.reduce((t, s) => t + WRITES[String(cfg(s).identityWrite)]!, 0)).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        // DELETE as a non-owner is never sent: a wrongly accepted delete cannot be put back.
        expect(specs.some((s) => cfg(s).identityWrite === "owner" && cfg(s).method === "DELETE")).toBe(false);
        for (const s of specs) expect(renderScript(TestSpecSchema.parse({ ...s, testId: "WEB-001" }), "playwright", { baseUrl: "http://127.0.0.1:9000" }).content).toContain("accessWriteAssert(page, base, cfg)");
    });

    it("stops a share only on a bench or fixture app: under a client authorization a revoke is never sent (it is not undone)", () => {
        const kinds = (gate: Partial<Input>) => generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: ACCESS }, gate).map((s) => cfg(s).identityWrite);
        expect(kinds({})).toContain("revoke");
        expect(kinds({ gate: "fixture", appUrl: "http://localhost:3000" })).toContain("revoke");
        const authorized = kinds({ gate: "authorization", appUrl: "https://shop.example" });
        expect(authorized.length).toBeGreaterThan(0);
        expect(authorized).not.toContain("revoke");
    });

    it("sends the owner write as PATCH only: with only a PUT documented there is no owner write (a wrongly accepted PUT could wipe fields)", () => {
        const { patch: _p, ...putOnly } = PATHS["/api/notes/{id}"];
        const kinds = generateIdentityWriteSpecs({ apis: doc({ ...PATHS, "/api/notes/{id}": putOnly }), lists: LISTS, access: ACCESS }).map((s) => [cfg(s).identityWrite, cfg(s).method]);
        expect(kinds.filter(([k]) => k === "owner")).toEqual([]);
        expect(kinds.some(([, m]) => m === "PUT")).toBe(false);
    });

    it("when every account reads the privileged list, the roles come from GET /api/me: the role the API names as allowed is the top one", () => {
        const all = { ...ACCESS[0]!, status: { anonymous: 401, ana: 200, ben: 200, mia: 200, ada: 200 } };
        const specs = generateIdentityWriteSpecs({ apis: doc(PATHS), lists: [], access: [all] });
        expect(specs.map(cfg)).toEqual(
            ["ana", "ben", "mia", "ada"].map((as) => ({ identityWrite: "role", as, pool: ["ana", "ben", "mia", "ada"].filter((x) => x !== as), allowedRoles: ["admin"], method: "PATCH", path: "/api/admin/users/{id}", param: "id", whoAmI: "/api/me", documented: "403", sev: "high" })),
        );
        expect(specs.reduce((t, s) => t + WRITES[String(cfg(s).identityWrite)]!, 0)).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        // The allowed role is only the one the words name as allowed ("admins only", "only admins", "not an admin"); words that name the
        // refused roles ("users and managers may not change roles") name no allowed role, so no check is made rather than a wrong one.
        const worded = (summary: string, refusal: string) => {
            const p = { ...PATHS, "/api/admin/users/{id}": { patch: { summary, responses: { 200: err("Changed"), 403: err(refusal) } } } };
            return generateIdentityWriteSpecs({ apis: doc(p), lists: [], access: [all] }).map((s) => cfg(s).allowedRoles);
        };
        expect(worded("Change someone's role (admins only)", "Forbidden")[0]).toEqual(["admin"]);
        expect(worded("Change a role", "Only owners may change roles")[0]).toEqual(["owner"]);
        expect(worded("Change a role", "Users and managers may not change roles")).toEqual([]);
    });

    it("the role check from GET /api/me: a lesser account that takes the allowed role is a finding and is changed back; the allowed account sends nothing", async () => {
        setAccounts(["ana", "mia", "ada"]);
        const ROLES: Record<string, string> = { ana: "user", mia: "manager", ada: "admin" };
        const runAs = async (as: string, accepted: boolean) => {
            const b = fakeBrowser({
                answer: (c) => (c.url.endsWith("/api/me") ? { status: 200, body: JSON.stringify({ id: `u-${c.who}`, role: ROLES[c.who] }) } : c.method === "PATCH" ? { status: accepted ? 200 : 403, body: "{}" } : { status: 404, body: "{}" }),
            });
            const run = { identityWrite: "role", as, pool: ["ana", "mia", "ada"].filter((x) => x !== as), allowedRoles: ["admin"], method: "PATCH", path: "/api/admin/users/{id}", param: "id", whoAmI: "/api/me", documented: "403", sev: "high" };
            const err = await accessHelper.accessAssert(b.page, "http://127.0.0.1:9000/", JSON.stringify(run)).then(() => undefined, (e: Error) => e.message);
            return { err, writes: b.calls.filter((c) => c.method === "PATCH") };
        };
        const seeded = await runAs("mia", true);
        expect(seeded.err).toMatch(/^Access control check failed: 1 write may be open.*“mia” user gave its own account the role “admin” of “ada”.*it was changed back/s);
        expect(seeded.writes.map((w) => [w.url, w.data])).toEqual([["http://127.0.0.1:9000/api/admin/users/u-mia", { role: "admin" }], ["http://127.0.0.1:9000/api/admin/users/u-mia", { role: "manager" }]]);
        expect(await runAs("mia", false)).toEqual({ err: undefined, writes: [expect.objectContaining({ method: "PATCH" })] });
        expect(await runAs("ada", true)).toEqual({ err: undefined, writes: [] });
    });

    it("keeps to the write budget however many accounts were refused", () => {
        const many = Object.fromEntries([...Array(10).keys()].map((i) => [`u${i}`, 403]));
        const specs = generateIdentityWriteSpecs({ apis: doc(PATHS), lists: LISTS, access: [{ ...ACCESS[0]!, status: { ...many, ada: 200 } }] });
        expect(specs.reduce((t, s) => t + WRITES[String(cfg(s).identityWrite)]!, 0)).toBeLessThanOrEqual(MAX_IDENTITY_WRITES);
        expect(specs.length).toBe(1 + 1 + 3);
    });

    it("needs the evidence: documented refusal words, a who-am-I endpoint, a reader that does not read everything", () => {
        const plain = { ...PATHS, "/api/notes/{id}": { ...PATHS["/api/notes/{id}"], put: { responses: { 200: err("Changed"), 403: err("Forbidden") } }, patch: { responses: { 200: err("Changed"), 403: err("Forbidden") } } }, "/api/admin/users/{id}": { patch: { responses: { 200: err("Changed"), 403: err("Forbidden") } } } };
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
            const run = { identityWrite: "owner", as: "ana", method: "PATCH", path: "/api/notes/n3", sev: "high", ...c };
            await expect(accessHelper.accessAssert(page, "http://127.0.0.1:9000/", JSON.stringify(run))).rejects.toThrow(/not the application's own( address)?, so nothing was called/);
        }
        for (const c of [{ method: "DELETE" }, { method: "POST" }, { method: "PUT" }, { identityWrite: "revoke", method: "PUT" }]) {
            const run = { identityWrite: "owner", as: "ana", path: "/api/notes/n3", sev: "high", ...c };
            await expect(accessHelper.accessAssert(page, "http://127.0.0.1:9000/", JSON.stringify(run))).rejects.toThrow(/is not one this check sends, so nothing was called/);
        }
        expect(contexts).toBe(0);
    });
});
