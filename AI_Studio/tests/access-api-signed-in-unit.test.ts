/**
 * Signed-in API access checks without API tokens: the vertical survey called with each account's own session, the documented-403 rule
 * that names the lesser accounts when every account was answered, and the same-level checks made from documented list endpoints
 * (a record another account's list holds and the viewer's does not).
 */
import { describe, expect, it } from "vitest";
import { generateApiAccessSpecs, generateApiListSpecs, listItems, surveyApiAccess, surveyApiLists, type ApiAccessRow, type ApiListRow, type ApiRequester, type Reach } from "../src/engine/identity/access.js";

const cfg = (s: ReturnType<typeof generateApiAccessSpecs>[number]) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, unknown>;
const ROLES = ["ana", "ben", "mia", "ada"].map((name) => ({ name, username: `${name}@example.test`, password: "pw" }));

describe("list records", () => {
    it("reads ids and owner values from a list answer, nothing else", () => {
        expect(listItems({ notes: [{ id: "n1", owner: "Ana", title: "x" }, { id: 7 }, { title: "no id" }] })).toEqual([{ id: "n1", owner: "Ana" }, { id: "7" }]);
        expect(listItems([{ uuid: "u-1", userId: 3 }])).toEqual([{ id: "u-1", owner: "3" }]);
        expect(listItems({ count: 2 })).toBeUndefined();
        expect(listItems("text")).toBeUndefined();
    });
});

describe("checks from list endpoints", () => {
    const notes: ApiListRow = {
        list: "/api/notes",
        detail: "/api/notes/{id}",
        documented: [404],
        items: {
            ana: [{ id: "n1", owner: "Ana" }, { id: "n3", owner: "Ben" }],
            ben: [{ id: "n2", owner: "Ben" }, { id: "n3", owner: "Ben" }],
            mia: [{ id: "n1", owner: "Ana" }, { id: "n2", owner: "Ben" }, { id: "n3", owner: "Ben" }],
            ada: [{ id: "n1", owner: "Ana" }, { id: "n2", owner: "Ben" }, { id: "n3", owner: "Ben" }],
        },
    };

    it("asks each account to be refused a record only another account lists (bench-rbac BR-01, bench-shop BS-08)", () => {
        const specs = generateApiListSpecs([notes]);
        expect(specs.map((s) => s.title)).toEqual(["“ana” account: cannot read a record of “ben” through the API (GET /api/notes/n2)", "“ben” account: cannot read a record of “ana” through the API (GET /api/notes/n1)"]);
        expect(cfg(specs[0]!)).toEqual({ api: true, refuse: true, as: "ana", path: "/api/notes/n2", by: "ben", of: "ben", sev: "high", documented: "404" });
        expect(specs[0]).toMatchObject({ kind: "web", type: "security", category: "Access control", source: { origin: "access-check" } });
        expect(specs[0]!.tags).toContain("cross-account");
        const shop: ApiListRow = { list: "/api/orders", detail: "/api/orders/{id}", items: { alice: [{ id: "ord-1000", owner: "u1" }], bob: [{ id: "ord-1001", owner: "u2" }] } };
        expect(generateApiListSpecs([shop]).map((s) => cfg(s).as + "->" + cfg(s).path)).toEqual(["alice->/api/orders/ord-1001", "bob->/api/orders/ord-1000"]);
    });

    it("skips a record whose owner owns what only the viewer lists (the viewer's own, cut from a shorter list), and shared or public records", () => {
        const row: ApiListRow = { list: "/api/docs", detail: "/api/docs/{id}", items: { alice: [{ id: "a1", owner: "u1" }, { id: "pub", owner: "shop" }], bob: [{ id: "a5", owner: "u1" }, { id: "b1", owner: "u2" }, { id: "pub", owner: "shop" }] } };
        // alice: a5's owner u1 owns a1, which only alice lists, so a5 is hers; b1 is bob's. bob: u1 owns a5 on his side too, so a1 proves nothing.
        expect(generateApiListSpecs([row]).map((s) => cfg(s).as + "->" + cfg(s).path)).toEqual(["alice->/api/docs/b1"]);
        const same: ApiListRow = { list: "/api/products", detail: "/api/products/{id}", items: { alice: [{ id: "p1" }], bob: [{ id: "p1" }] } };
        expect(generateApiListSpecs([same])).toEqual([]);
    });

    it("uses the account's token when it has one, an encoded id, and a cap", () => {
        const row: ApiListRow = { list: "/api/x", detail: "/api/x/{id}", items: { alice: [{ id: "a/1" }], bob: [{ id: "b 2" }] } };
        const [t] = generateApiListSpecs([row], { tokens: ["alice"] });
        expect(t).toMatchObject({ kind: "api" });
        expect(t!.steps[0]).toMatchObject({ action: "request", method: "GET", path: "/api/x/b%202", auth: "none", headers: { Authorization: "Bearer {{credentials.alice.apiToken}}" } });
        expect(cfg(t!)).toEqual({ as: "alice", path: "/api/x/b%202", by: "bob", of: "bob", sev: "high" });
        const many: ApiListRow = { list: "/api/x", detail: "/api/x/{id}", items: Object.fromEntries(["a", "b", "c", "d"].map((w) => [w, [{ id: w }]])) };
        expect(generateApiListSpecs([many])).toHaveLength(4);
        expect(generateApiListSpecs([many], { max: 2 })).toHaveLength(2);
    });

    it("survey: one GET of each list that has a record endpoint next to it, per account, one at a time", async () => {
        const calls: string[] = [];
        let inFlight = 0;
        let most = 0;
        const as = (who: string): ApiRequester => ({
            async get(url) {
                most = Math.max(most, ++inFlight);
                calls.push(`${who} ${new URL(url).pathname}`);
                await new Promise((r) => setTimeout(r, 2));
                inFlight--;
                return { status: () => 200, text: async () => JSON.stringify({ notes: [{ id: `${who}-1`, title: "secret words" }] }) };
            },
        });
        const rows = await surveyApiLists(
            [{ name: "ana", request: as("ana") }, { name: "ben", request: as("ben") }],
            "http://x.test",
            [
                { method: "GET", path: "/api/notes", called: "/api/notes" },
                { method: "GET", path: "/api/notes/{id}", called: "/api/notes/{id}", statuses: [200, 404] },
                { method: "GET", path: "/api/me", called: "/api/me" }, // no record endpoint next to it: never called
                { method: "POST", path: "/api/orders", called: "/api/orders" },
                { method: "GET", path: "/api/orders/{id}", called: "/api/orders/{id}" },
            ],
        );
        expect(rows).toEqual([{ list: "/api/notes", detail: "/api/notes/{id}", documented: [404], items: { ana: [{ id: "ana-1" }], ben: [{ id: "ben-1" }] } }]);
        expect(calls).toEqual(["ana /api/notes", "ben /api/notes"]);
        expect(most).toBe(1);
        expect(JSON.stringify(rows)).not.toContain("secret");
        expect(await surveyApiLists([{ name: "ana", request: as("ana") }], "http://x.test", [{ method: "GET", path: "/api/notes", called: "/api/notes" }])).toEqual([]);
    });
});

describe("vertical API survey signed in", () => {
    it("calls each privileged endpoint with each account's own session and a visitor's, and says who was signed in", async () => {
        const calls: string[] = [];
        const as = (who: string, status: number): ApiRequester => ({ get: async (url, o) => (calls.push(`${who} ${new URL(url).pathname} ${o.headers.Authorization ?? "-"}`), { status: () => status }) });
        const sessions = new Map<string, ApiRequester>([["anonymous", as("visitor", 401)], ["ana", as("ana", 403)], ["ada", as("ada", 200)]]);
        const plain = { get: async () => { throw new Error("the shared context must not be used when a visitor's own is given"); } };
        const rows = await surveyApiAccess(plain, "http://x.test", [{ method: "GET", path: "/api/admin/users", called: "/api/admin/users", statuses: [200, 403] }], [ROLES[0]!, ROLES[3]!], 12, sessions);
        expect(rows).toEqual([{ method: "GET", path: "/api/admin/users", called: "/api/admin/users", status: { anonymous: 401, ana: 403, ada: 200 }, signedIn: ["ana", "ada"], documented: [403] }]);
        expect(calls).toEqual(["visitor /api/admin/users -", "ana /api/admin/users -", "ada /api/admin/users -"]);
    });

    const row = (status: Record<string, number>): ApiAccessRow => ({ method: "GET", path: "/api/admin/users", called: "/api/admin/users", status, signedIn: ["ana", "ben", "mia", "ada"], documented: [403] });
    const page = (who: string, ...extra: string[]): Reach => ({ who, pages: ["/", "/notes", ...extra].map((path) => ({ path, heading: path })) });
    const reach = [page("anonymous"), page("ana"), page("ben"), page("mia"), page("ada", "/admin/users")];
    const titles = (rows: ApiAccessRow[], r?: Reach[]) => generateApiAccessSpecs(rows, { maxSpecs: 8, ...(r ? { reach: r } : {}) }).map((s) => s.title);
    const LESSER = ["Not signed in: cannot call GET /api/admin/users", "“ana” account: cannot call GET /api/admin/users", "“ben” account: cannot call GET /api/admin/users", "“mia” account: cannot call GET /api/admin/users"];

    it("makes the same checks whether the lesser accounts are refused today (clean) or let in (BR-03), from the documented 403 and the page survey", () => {
        expect(titles([row({ anonymous: 401, ana: 403, ben: 403, mia: 403, ada: 200 })], reach)).toEqual(LESSER);
        expect(titles([row({ anonymous: 401, ana: 200, ben: 200, mia: 200, ada: 200 })], reach)).toEqual(LESSER);
        const spec = generateApiAccessSpecs([row({ anonymous: 401, ana: 200, ben: 200, mia: 200, ada: 200 })], { maxSpecs: 8, reach })[1]!;
        expect(spec).toMatchObject({ kind: "web" });
        expect(cfg(spec)).toEqual({ api: true, refuse: true, as: "ana", path: "/api/admin/users", by: "ada", sev: "high", documented: "403" });
        // the visitor keeps the plain API check (no credentials)
        expect(generateApiAccessSpecs([row({ anonymous: 401, ana: 200, ben: 200, mia: 200, ada: 200 })], { maxSpecs: 8, reach })[0]).toMatchObject({ kind: "api" });
    });

    it("needs both: no documented 403, or no page only some accounts reach, means no check for an account that was let in", () => {
        const open = { anonymous: 401, ana: 200, ben: 200, mia: 200, ada: 200 };
        expect(titles([{ ...row(open), documented: [401] }], reach)).toEqual(["Not signed in: cannot call GET /api/admin/users"]);
        expect(titles([row(open)], reach.map((r) => ({ ...r, pages: r.pages.filter((p) => p.path !== "/admin/users") })))).toEqual(["Not signed in: cannot call GET /api/admin/users"]);
        expect(titles([row(open)])).toEqual(["Not signed in: cannot call GET /api/admin/users"]);
        // an account whose crawl stopped early is no evidence of a page closed to it
        expect(titles([row(open)], reach.map((r) => (r.who === "ben" ? { ...r, incomplete: "crashed" } : r)))).not.toContain("“ben” account: cannot call GET /api/admin/users");
    });
});
