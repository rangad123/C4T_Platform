/**
 * Same-level API access checks (one account's record read through the API as another account of the same kind): which values count as
 * a record's content, which checks are generated from what each account read, that values are kept only as fingerprints and masked
 * previews, and that the check in the script makes one GET and fails only on a 2xx answer that holds the owner's content.
 */
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { generateAccessSpecs, maskValue, newEvidenceKey, recordValues, valueHash, type ApiRecordSeen, type Reach } from "../src/engine/identity/access.js";
import { accessHelper, fakeBrowser, setAccounts, type FakeAnswer } from "./identity-fake-browser.js";

const rec = (path: string, page: string, body: unknown, header = false): ApiRecordSeen => ({ path, pattern: path.replace(/\/\d+$/, "/{}"), page, ...(header ? { header } : {}), values: recordValues(body) });
const note = (id: number, title: string, body: string) => ({ id, kind: "personal note", title, body, updatedAt: "2026-11-01T10:00:00Z" });
const reach = (who: string, api: ApiRecordSeen[]): Reach => ({ who, pages: [{ path: "/", heading: "Notes app" }, { path: "/notes", heading: "Your notes" }], api });
const alice = reach("alice", [rec("/api/notes/1", "/notes/1", note(1, "Alice tax plan 2026", "Quarterly figures")), rec("/api/notes/2", "/notes/2", note(2, "Alice garden ideas", "Tomatoes"))]);
const bob = reach("bob", [rec("/api/notes/3", "/notes/3", note(3, "Bob holiday budget", "Train tickets"))]);
const anon: Reach = { who: "anonymous", pages: [{ path: "/", heading: "Notes app" }] };
const apiChecks = (reaches: Reach[], opts?: Parameters<typeof generateAccessSpecs>[1]) => generateAccessSpecs(reaches, opts).filter((s) => s.title.includes("through the API"));
const cfgOf = (s: ReturnType<typeof generateAccessSpecs>[number]) => JSON.parse(String((s.steps[1] as { expected: string }).expected)) as Record<string, unknown> & { evidence: Array<{ key: string; length?: number; hash?: string; mask: string }> };

describe("recordValues", () => {
    it("keeps content strings as fingerprints and masked previews, and leaves out ids, numbers, dates, addresses and credentials", () => {
        const v = recordValues({ id: 7, uuid: "0b9e2c4a-1f2d-4c3b-9a8e-123456789abc", title: "Alice tax plan 2026", when: "2026-11-01T10:00:00Z", link: "https://example.test/x", token: "secret-token-value", password: "hunter22", n: "1234", nested: { owner: { email: "alice@example.test" } }, tags: ["Personal", "Personal"] });
        expect(v.map((x) => x.key)).toEqual(["title", "email", "tags"]);
        expect(v[0]).toEqual({ key: "title", hash: valueHash("Alice tax plan 2026"), length: 19, mask: "•••••• (19 characters)" });
        expect(JSON.stringify(v)).not.toContain("Alice tax");
        expect(JSON.stringify(v)).not.toContain("Al•");
        expect(maskValue("abcd")).toBe("•••• (4 characters)");
        expect(valueHash("  x y ")).toBe(valueHash("x y"));
    });

    it("fingerprints under a random key, never the old fixed label: comparable within one survey's key, different under another", () => {
        const fixed = createHmac("sha256", "access-evidence-v1").update("Alice tax plan 2026").digest("hex").slice(0, 32);
        const k1 = newEvidenceKey();
        const k2 = newEvidenceKey();
        const a = recordValues({ title: "Alice tax plan 2026" }, k1)[0]!.hash;
        expect(a).not.toBe(fixed);
        expect(valueHash("Alice tax plan 2026")).not.toBe(fixed);
        expect(recordValues({ other: " Alice tax plan 2026 " }, k1)[0]!.hash).toBe(a);
        expect(recordValues({ title: "Alice tax plan 2026" }, k2)[0]!.hash).not.toBe(a);
    });

    it("leaves out sensitive personal and payment fields, and anything nested under a secret-named field", () => {
        const v = recordValues({
            private_key: "-----BEGIN KEY abcdef", ssn: "123-45-6789x", card_number: "4111 1111 1111 1111x", cvv: "123x", iban: "DE89370400440532013000",
            account_number: "ACC12345678", accountNo: "ACC12345679", routingNumber: "RT0110000", sort_code: "SC20-00-00", tax_id: "TX-123456", passportNumber: "P1234567",
            credentials: { value: "nested secret value" }, apiKey: { v: "nested api key value" },
            title: "Alice tax plan 2026",
        });
        expect(v.map((x) => x.key)).toEqual(["title"]);
    });
});

describe("which same-level API checks are generated", () => {
    it("reads each account's own records as the other account, with the owner's distinct values as evidence", () => {
        const checks = apiChecks([anon, alice, bob]);
        expect(checks.map((s) => s.title).sort()).toEqual([
            "“alice” account: cannot read a record of “bob” through the API (GET /api/notes/3)",
            "“bob” account: cannot read a record of “alice” through the API (GET /api/notes/1)",
            "“bob” account: cannot read a record of “alice” through the API (GET /api/notes/2)",
        ]);
        const one = checks.find((s) => s.title.includes("/api/notes/1"))!;
        const cfg = cfgOf(one);
        expect(cfg).toMatchObject({ api: true, as: "bob", of: "alice", path: "/api/notes/1", pattern: "/api/notes/{}", sev: "high", page: "/notes/3" });
        expect(cfg.header).toBeUndefined();
        // "personal note" is on every record: it says nothing about the owner, so it is not evidence.
        expect(cfg.evidence.map((e) => e.key)).toEqual(["title", "body"]);
        expect(cfg.evidence.every((e) => e.hash === undefined)).toBe(true);
        expect(JSON.stringify(one)).not.toContain("Alice tax plan");
        expect(one.tags).toEqual(expect.arrayContaining(["cross-account", "api", "access-control"]));
        expect(one.kind).toBe("web");
        expect(one.steps.map((s) => s.action)).toEqual(["navigate", "assert"]);
    });

    it("needs evidence of ownership: no record of the same kind on the viewer, a record both read, or no distinct value means no check", () => {
        const carol = reach("carol", [rec("/api/orders/5", "/orders/5", { title: "Carol order" })]);
        expect(apiChecks([alice, carol])).toEqual([]);
        const bobToo = reach("bob", [...bob.api!, alice.api![0]!]);
        expect(apiChecks([alice, bobToo]).some((s) => s.title.includes("/api/notes/1"))).toBe(false);
        const dull = reach("dave", [rec("/api/notes/4", "/notes/4", note(4, "Bob holiday budget", "Train tickets"))]);
        expect(apiChecks([bob, dull])).toEqual([]);
    });

    it("carries the header flag when the app authenticates its calls with an Authorization header", () => {
        const a = reach("alice", [rec("/api/notes/1", "/notes/1", note(1, "Alice tax plan 2026", "x y z w"), true)]);
        const b = reach("bob", [rec("/api/notes/3", "/notes/3", note(3, "Bob holiday budget", "q r s t"), true)]);
        expect(apiChecks([a, b]).map((s) => cfgOf(s).header)).toEqual([true, true]);
    });

    it("caps the checks at four by default, and makes none with fewer than two test accounts", () => {
        const many = reach("alice", Array.from({ length: 8 }, (_, i) => rec(`/api/notes/${i + 10}`, `/notes/${i + 10}`, { title: `Alice record number ${i}` })));
        expect(apiChecks([many, bob])).toHaveLength(4);
        expect(apiChecks([many, bob], { maxSpecs: 8, maxOrdinary: 3, maxApiHorizontal: 2 })).toHaveLength(2);
        expect(apiChecks([anon, alice])).toEqual([]);
    });
});

describe("the check in the script", () => {
    beforeAll(() => setAccounts(["alice", "bob"]));
    const ALICE = JSON.stringify(note(1, "Alice tax plan 2026", "Quarterly figures"));
    const BOB = JSON.stringify(note(3, "Bob holiday budget", "Train tickets"));
    const cfg = cfgOf(apiChecks([alice, bob]).find((s) => s.title.includes("/api/notes/1"))!);
    /** The owner (alice) is answered `owner`, the viewer (bob) `viewer`. */
    const run = async (owner: FakeAnswer, viewer: FakeAnswer, over: Record<string, unknown> = {}) => {
        const f = fakeBrowser({ answer: (c) => (c.who === "alice" ? owner : viewer) });
        const r = await accessHelper.accessAssert(f.page, "http://app.test", JSON.stringify({ ...cfg, ...over })).then(() => "passed", (e: Error) => e.message);
        return { r, calls: f.calls };
    };

    it("stores no fingerprints: the owner's record is read in the run, then the viewer's single GET, and a leak shows only masked evidence", async () => {
        expect(JSON.stringify(cfg)).not.toMatch(/"hash"|[0-9a-f]{32}/);
        expect(cfg.evidence).toEqual([
            { key: "title", length: 19, mask: "•••••• (19 characters)" },
            { key: "body", length: 17, mask: "•••••• (17 characters)" },
        ]);
        const open = await run({ status: 200, body: ALICE }, { status: 200, body: ALICE });
        expect(open.r).toContain("Access control check failed: 1 record may be open to another account");
        expect(open.r).toContain("A signed-in “bob” user can call GET /api/notes/1 (HTTP 200)");
        expect(open.r).toContain("title: •••••• (19 characters)");
        expect(open.r).not.toContain("Alice tax plan");
        expect(open.r).not.toContain("Al•");
        expect(open.calls.map((c) => [c.who, c.url])).toEqual([
            ["alice", "http://app.test/api/notes/1"],
            ["bob", "http://app.test/api/notes/1"],
        ]);
    });

    it("passes on a refusal, an answer that is not JSON, an answer without the owner's content, and no answer", async () => {
        const own = { status: 200, body: ALICE };
        expect((await run(own, { status: 403, body: ALICE })).r).toBe("passed");
        expect((await run(own, { status: 200, body: "<html>Alice tax plan 2026</html>" })).r).toBe("passed");
        expect((await run(own, { status: 200, body: BOB })).r).toBe("passed");
        expect((await run(own, null)).r).toBe("passed");
    });

    it("refuses to judge (not a finding) when the owner's own read gives no record or no longer holds the content", async () => {
        for (const owner of [{ status: 404, body: "{}" }, { status: 200, body: "<html></html>" }, null, { status: 200, body: JSON.stringify(note(1, "Something else now", "Edited")) }]) {
            const { r, calls } = await run(owner, { status: 200, body: ALICE });
            expect(r).toMatch(/could not be judged/);
            expect(r).not.toContain("Access control check failed");
            expect(calls.every((c) => c.who === "alice")).toBe(true);
        }
    });

    it("older checks that still carry a fingerprint and a preview with characters work from the preview's length, and never show its characters", async () => {
        const old = { ...cfg, evidence: [{ key: "title", hash: "0".repeat(32), mask: "Al•••••• (19 characters)" }] };
        const { r } = await run({ status: 200, body: ALICE }, { status: 200, body: ALICE }, old);
        expect(r).toContain("title: •••••• (19 characters)");
        expect(r).not.toContain("Al•");
    });

    it("refuses to judge (not a finding) when the app needs an API credential it could not find for the account", async () => {
        const { r, calls } = await run({ status: 200, body: ALICE }, { status: 200, body: ALICE }, { header: true });
        expect(r).toContain("carried no API credentials");
        expect(r).not.toContain("Access control check failed");
        expect(calls).toEqual([]);
    });

    it("never sends the account's credentials to another host: a path naming its own host or a scheme is refused before any request", async () => {
        for (const path of ["//evil.example/x", "/\\evil.example/x", "https://evil.example/x", "http:/evil.example/x", "evil/x"]) {
            const f = fakeBrowser({ answer: () => ({ status: 200, body: ALICE }), ownCall: (who) => ({ url: "http://app.test/api/notes/9", headers: { authorization: `Bearer ${who}-token` } }) });
            const r = await accessHelper.accessAssert(f.page, "http://app.test", JSON.stringify({ ...cfg, path, header: true })).then(() => "passed", (e: Error) => e.message);
            expect(r, path).toContain("is not a path on the application's API host");
            expect(r).not.toContain("Access control check failed");
            expect(f.calls, path).toEqual([]);
            expect(f.contexts(), path).toBe(0);
        }
    });

    it("sends each account's own Authorization header, only to the recorded API host", async () => {
        const f = fakeBrowser({ answer: () => ({ status: 200, body: ALICE }), ownCall: (who) => ({ url: "http://app.test/api/notes/9", headers: { authorization: `Bearer ${who}-token` } }) });
        await accessHelper.accessAssert(f.page, "http://app.test", JSON.stringify({ ...cfg, header: true })).catch(() => undefined);
        expect(f.calls).toEqual([
            { who: "alice", url: "http://app.test/api/notes/1", headers: { authorization: "Bearer alice-token" } },
            { who: "bob", url: "http://app.test/api/notes/1", headers: { authorization: "Bearer bob-token" } },
        ]);
    });
});
