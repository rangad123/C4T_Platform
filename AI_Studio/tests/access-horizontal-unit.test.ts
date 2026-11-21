/**
 * Horizontal access checks (one test account's records opened as another account of the same kind): which checks are generated from
 * what each account reached, and that nothing changes for projects with fewer than two test accounts.
 */
import { describe, expect, it } from "vitest";
import { apiRecordAddress, generateAccessSpecs, recordPattern, recordValues, type ApiRecordSeen, type Reach } from "../src/engine/identity/access.js";

const reach = (who: string, ...pages: Array<[string, string]>): Reach => ({ who, pages: pages.map(([path, heading]) => ({ path, heading })) });
const SHARED: Array<[string, string]> = [["/", "Notes app"], ["/notes", "Your notes"]];
const data = (specs: ReturnType<typeof generateAccessSpecs>) => specs.map((s) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, string>);

describe("recordPattern", () => {
    it("names the kind of record an address shows, and nothing for an address without an id", () => {
        expect(recordPattern("/notes/12")).toBe("/notes/{}");
        expect(recordPattern("/orders/0b9e2c4a-1f2d-4c3b-9a8e-123456789abc/items")).toBe("/orders/{}/items");
        expect(recordPattern("/files/a3f9c2d17b4e88aa")).toBe("/files/{}");
        expect(recordPattern("/notes")).toBeUndefined();
        expect(recordPattern("/settings/profile")).toBeUndefined();
        expect(recordPattern("/blog/2fa-setup")).toBeUndefined();
    });
});

describe("which horizontal checks are generated", () => {
    const anon = reach("anonymous", ["/", "Notes app"]);
    const alice = reach("alice", ...SHARED, ["/notes/1", "Alice tax plan 2026"], ["/notes/2", "Alice garden ideas"], ["/shared/9", "Team offsite"]);
    const bob = reach("bob", ...SHARED, ["/notes/3", "Bob holiday budget"], ["/shared/9", "Team offsite"], ["/products/4", "Blue kettle"]);

    it("opens each account's own records as the other account, and says whose record it is", () => {
        const h = data(generateAccessSpecs([anon, alice, bob])).filter((d) => d.of);
        expect(h.map((d) => `${d.as}->${d.path}`).sort()).toEqual(["alice->/notes/3", "bob->/notes/1", "bob->/notes/2"]);
        expect(h.find((d) => d.path === "/notes/1")).toMatchObject({ as: "bob", of: "alice", marker: "Alice tax plan 2026", pattern: "/notes/{}", sev: "high" });
        const spec = generateAccessSpecs([anon, alice, bob]).find((s) => s.title.includes("/notes/3"))!;
        expect(spec.title).toBe("“alice” account: cannot open a record of “bob” (/notes/3)");
        expect(spec.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
        expect(spec.tags).toContain("cross-account");
    });

    it("leaves shared and public records alone: both accounts reach the same address", () => {
        const h = data(generateAccessSpecs([anon, alice, bob])).filter((d) => d.of);
        expect(h.some((d) => d.path === "/shared/9" || d.path === "/products/4")).toBe(false);
    });

    it("needs evidence of ownership: no record of the same kind on the other account, an address without an id, or a heading every record shares means no check", () => {
        const carol = reach("carol", ...SHARED, ["/drafts", "Carol drafts"], ["/invoices/7", "Invoice 7"]);
        const dave = reach("dave", ...SHARED, ["/notes/5", "Note"], ["/notes/6", "Note"]);
        const erin = reach("erin", ...SHARED, ["/notes/8", "Erin plan"]);
        const h = data(generateAccessSpecs([carol, dave, erin])).filter((d) => d.of);
        // carol has no notes, so nobody's notes are checked as carol; carol's invoice and drafts have no counterpart on the others.
        expect(h.some((d) => d.as === "carol")).toBe(false);
        expect(h.some((d) => d.path === "/invoices/7" || d.path === "/drafts")).toBe(false);
        // dave's notes are all titled "Note": nothing says which content is dave's.
        expect(h.some((d) => d.of === "dave")).toBe(false);
        expect(h.map((d) => `${d.as}->${d.path}`)).toEqual(["dave->/notes/8"]);
    });

    it("does not also check the same record as a page reserved for a more privileged account", () => {
        const all = data(generateAccessSpecs([anon, alice, bob]));
        expect(all.filter((d) => !d.of && d.as === "bob" && d.path.startsWith("/notes/"))).toEqual([]);
    });

    it("caps the horizontal checks", () => {
        const many = reach("many", ...SHARED, ...Array.from({ length: 10 }, (_, i): [string, string] => [`/notes/${100 + i}`, `Many plan ${i}`]));
        const few = reach("few", ...SHARED, ["/notes/99", "Few plan"]);
        expect(data(generateAccessSpecs([many, few])).filter((d) => d.of)).toHaveLength(4);
        expect(data(generateAccessSpecs([many, few], { maxSpecs: 8, maxOrdinary: 3, maxHorizontal: 2 })).filter((d) => d.of)).toHaveLength(2);
    });

    it("changes nothing with fewer than two test accounts", () => {
        const user = reach("user", ...SHARED, ["/notes/1", "Alice tax plan 2026"]);
        const before = generateAccessSpecs([anon, user]);
        expect(before.every((s) => !s.tags.includes("cross-account"))).toBe(true);
        // a visitor is still checked against the account's records as before
        expect(data(before).map((d) => d.path)).toContain("/notes/1");
    });
});

describe("ids with a short prefix (ord-1001, n2)", () => {
    const titles = (rs: Reach[]) => generateAccessSpecs(rs, { maxSpecs: 16, maxOrdinary: 6 }).map((s) => s.title);
    const SHOP: Array<[string, string]> = [["/orders", "Your orders"]];
    const NOTES: Array<[string, string]> = [["/notes", "Notes"]];

    it("is a candidate id only when asked for: the strict kind is unchanged", () => {
        expect(recordPattern("/orders/ord-1001")).toBeUndefined();
        expect(recordPattern("/orders/ord-1001", true)).toBe("/orders/{}");
        expect(recordPattern("/notes/n2", true)).toBe("/notes/{}");
        expect(recordPattern("/blog/2fa-setup", true)).toBeUndefined();
        expect(recordPattern("/settings/profile", true)).toBeUndefined();
        expect(apiRecordAddress(new URL("http://h/api/orders/ord-1001"))).toBeUndefined();
        expect(apiRecordAddress(new URL("http://h/api/orders/ord-1001"), true)?.pattern).toBe("/api/orders/{}");
        expect(apiRecordAddress(new URL("http://h/api/order?id=ord-1001"), true)?.pattern).toBe("/api/order?id={}");
    });

    it("makes the cross-account checks when two accounts each reach their own such records (bench-shop, bench-rbac)", () => {
        const alice = reach("alice", ...SHOP, ["/orders/ord-1000", "Order ord-1000"]);
        const bob = reach("bob", ...SHOP, ["/orders/ord-1001", "Order ord-1001"]);
        expect(titles([alice, bob])).toEqual(["“alice” account: cannot open a record of “bob” (/orders/ord-1001)", "“bob” account: cannot open a record of “alice” (/orders/ord-1000)"]);
        const ana = reach("ana", ...NOTES, ["/notes/n1", "Ana's travel plans"], ["/notes/n3", "Team lunch ideas"]);
        const ben = reach("ben", ...NOTES, ["/notes/n2", "Ben's salary review"], ["/notes/n3", "Team lunch ideas"]);
        expect(titles([ana, ben])).toEqual(["“ana” account: cannot open a record of “ben” (/notes/n2)", "“ben” account: cannot open a record of “ana” (/notes/n1)"]);
        expect(data(generateAccessSpecs([ana, ben]))[0]).toMatchObject({ pattern: "/notes/{}", of: "ben" });
    });

    it("leaves words alone: v2, page3 and step-1 reached by one account only make no record check", () => {
        const alice = reach("alice", ...SHARED, ["/docs/v1", "Version one guide"], ["/docs/v2", "Version two guide"], ["/blog/page2", "Older posts"], ["/blog/page3", "Oldest posts"], ["/wizard/step-1", "Shipping address"], ["/wizard/step-2", "Payment details"]);
        const bob = reach("bob", ...SHARED, ["/docs/v1", "Version one guide"], ["/blog/page2", "Older posts"], ["/wizard/step-1", "Shipping address"]);
        const all = data(generateAccessSpecs([alice, bob], { maxSpecs: 16, maxOrdinary: 6 }));
        expect(all.filter((d) => d.of)).toEqual([]);
        // the pages only alice reached are still the ordinary "only one account reaches it" checks, as before
        expect(all.map((d) => d.path).sort()).toEqual(["/blog/page3", "/docs/v2", "/wizard/step-2"]);
        expect(titles([reach("carol", ...SHARED, ["/blog/page3", "Oldest posts"]), reach("dave", ...SHARED, ["/wizard/step-1", "Shipping address"])])).toEqual([]);
    });

    it("API records: prefixed ids count with the same evidence, and v1 in an address does not hide numeric ids", () => {
        const rec = (path: string, title: string): ApiRecordSeen => ({ path, pattern: apiRecordAddress(new URL(path, "http://h"), true)!.pattern, page: "/orders", values: recordValues({ title }) });
        const api = (who: string, ...recs: ApiRecordSeen[]): Reach => ({ who, pages: [{ path: "/", heading: "Shop" }], api: recs });
        const apiTitles = (rs: Reach[]) => generateAccessSpecs(rs).filter((s) => s.title.includes("through the API")).map((s) => s.title.replace(/^.*\(GET /, "").replace(/\)$/, ""));
        expect(apiTitles([api("alice", rec("/api/orders/ord-1000", "Alice kettle order")), api("bob", rec("/api/orders/ord-1001", "Bob lamp order"))])).toEqual(["/api/orders/ord-1001", "/api/orders/ord-1000"]);
        // one account reads v1/notes/1 and /2, the other only /1: the numeric id still makes the check, as it did before
        const a = api("alice", rec("/v1/notes/1", "Shared plan"), rec("/v1/notes/2", "Alice tax plan 2026"));
        const b = api("bob", rec("/v1/notes/1", "Shared plan"));
        expect(apiTitles([a, b])).toEqual(["/v1/notes/2"]);
        const own = generateAccessSpecs([api("alice", rec("/v1/notes/1", "Alice tax plan 2026")), api("bob", rec("/v1/notes/3", "Bob holiday budget"))]).filter((s) => s.title.includes("through the API"));
        expect(own.map((s) => data([s])[0]!.pattern)).toEqual(["/v1/notes/{}", "/v1/notes/{}"]);
        // a prefixed value the same for everyone, or read by one account only, is a word
        expect(apiTitles([api("alice", rec("/api/v2/me", "Alice Smith")), api("bob", rec("/api/v2/me", "Bob Jones"))])).toEqual([]);
        expect(apiTitles([api("alice", rec("/api/step-1/x", "Alice Smith"), rec("/api/step-2/x", "Alice plan")), api("bob", rec("/api/step-1/x", "Bob Jones"))])).toEqual([]);
    });
});
