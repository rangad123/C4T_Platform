/**
 * The read-only cross-account checks' judgement (src/security/assessment/cross-account.ts), on hand-made answers: no network, no browser.
 * The real run against a fixture app, through the routes and the assessment loop, is tests/security-cross-account.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
    classify,
    CROSS_ACCOUNT_ENVIRONMENTS,
    DesignationSchema,
    environmentProblem,
    refusalOf,
    resultOf,
    runCrossAccount,
    type DesignatedResource,
    type FetchAs,
    type Identity,
} from "../src/security/assessment/cross-account.js";
import { normalize } from "../src/security/findings/normalize.js";
import type { GuardedAnswer } from "../src/security/assessment/types.js";

const json = (status: number, body: unknown, url = "http://app.test/x"): GuardedAnswer => {
    const text = JSON.stringify(body);
    return { url, status, headers: { "content-type": "application/json" }, setCookies: [], body: Buffer.from(text), text };
};
const html = (status: number, text: string): GuardedAnswer => ({ url: "http://app.test/x", status, headers: { "content-type": "text/html" }, setCookies: [], body: Buffer.from(text), text });

const bNote = { id: 50123, ownerId: "user-bob-77", title: "Bob's quarterly salary review", body: "Confidential: raise approved for March" };
const aNote = { id: 40111, ownerId: "user-alice-11", title: "Alice's shopping list", body: "Milk, bread and tomatoes" };
const D = { ownerField: "ownerId", ownerValueA: "user-alice-11", ownerValueB: "user-bob-77" } as const;
const item = (owner: DesignatedResource["owner"], path = "/api/notes/50123", kind: DesignatedResource["kind"] = "item"): DesignatedResource => ({ path, kind, owner });
const none = new Set<string>();

describe("one resource", () => {
    it("1: A reading its own resource is expected, never a finding", () => {
        const o = classify(item("A", "/api/notes/40111"), { a: json(200, aNote) }, D, none);
        expect(o.classification).toBe("own-access");
        expect(resultOf(o, "http://app.test/", { A: "alice", B: "bob" })).toEqual([]);
    });

    it("2: A reading B's private item with B's data in the answer is an unauthorized read (HTTP 200 with real exposure)", () => {
        const o = classify(item("B"), { b: json(200, bNote), visitor: json(401, { error: "Sign in" }), a: json(200, bNote) }, D, none);
        expect(o.classification).toBe("unauthorized-read");
        expect(o.confidence).toBe("high");
        expect(o.fields).toEqual(expect.arrayContaining(["ownerId", "title", "body"]));
    });

    it("3: a nested resource of B's is judged the same way", () => {
        const comment = { id: 99001, noteId: 50123, author: "user-bob-77", text: "Remember the bonus letter" };
        const o = classify(item("B", "/api/notes/50123/comments/99001", "nested"), { b: json(200, comment), visitor: json(403, {}), a: json(200, comment) }, { ...D, ownerField: "author" }, none);
        expect(o.classification).toBe("unauthorized-read");
    });

    it("8: A refused, or a 200 that holds none of B's data, is protected", () => {
        expect(classify(item("B"), { b: json(200, bNote), visitor: json(401, {}), a: json(404, { error: "Not found" }) }, D, none).classification).toBe("protected");
        // HTTP 200 alone is not a finding: an empty answer or A's own data.
        expect(classify(item("B"), { b: json(200, bNote), visitor: json(401, {}), a: json(200, { error: "You can only see your own notes" }) }, D, none).classification).toBe("protected");
        expect(classify(item("B"), { b: json(200, bNote), visitor: json(401, {}), a: json(200, aNote) }, D, none).classification).toBe("protected");
    });

    it("5: a public resource is expected to be readable; a public one that refuses visitors is said so", () => {
        expect(classify(item("public", "/api/public/info"), { visitor: json(200, { name: "Notes app" }) }, D, none)).toMatchObject({ classification: "own-access" });
        expect(classify(item("public", "/api/public/info"), { visitor: json(401, {}) }, D, none).reason).toMatch(/visitor was refused/);
    });

    it("6: a resource legitimately shared with A is not a finding", () => {
        const shared = { id: 70001, ownerId: "user-bob-77", sharedWith: ["user-alice-11"], title: "Team offsite agenda" };
        expect(classify(item("shared", "/api/notes/70001"), { a: json(200, shared) }, D, none).classification).toBe("own-access");
    });

    it("values A's own or public resources also show are not B's data (no false positive on site-wide values)", () => {
        const siteWide = new Set(["Notes app workspace", "workspace-acme-001"]);
        const b = { workspace: "workspace-acme-001", site: "Notes app workspace", id: 50123 };
        const a = { workspace: "workspace-acme-001", site: "Notes app workspace", error: "not yours" };
        expect(classify(item("B"), { b: json(200, b), visitor: json(401, {}), a: json(200, a) }, {}, siteWide).classification).toBe("protected");
    });

    it("a signed-out visitor getting B's data is its own finding", () => {
        const o = classify(item("B"), { b: json(200, bNote), visitor: json(200, bNote), a: json(200, bNote) }, D, none);
        expect(o.classification).toBe("visitor-read");
        expect(resultOf(o, "http://app.test/", { A: "alice", B: "bob" })[0]!.custom!.key).toBe("cross-account-visitor-read");
    });
});

describe("14: inconclusive, never reported", () => {
    it("B cannot read its own resource, nothing distinctive in it, or a single matching value", () => {
        expect(classify(item("B"), { b: json(404, {}), a: json(200, bNote) }, D, none).classification).toBe("inconclusive");
        expect(classify(item("B"), { b: json(200, { ok: true, n: 3 }), a: json(200, { ok: true, n: 3 }) }, {}, none).classification).toBe("inconclusive");
        const one = classify(item("B"), { b: json(200, { title: "Bob's quarterly salary review", ref: "zz-unique-ref-1" }), visitor: json(401, {}), a: json(200, { echo: "Bob's quarterly salary review" }) }, {}, none);
        expect(one.classification).toBe("inconclusive");
        expect(resultOf(one, "http://app.test/", { A: "alice", B: "bob" })).toEqual([]);
    });
    it("a non-JSON answer that differs from B's cannot be judged", () => {
        expect(classify(item("B", "/notes/50123"), { b: html(200, "<h1>Bob's salary review</h1><p>raise approved</p>"), a: html(200, "<h1>Your notes</h1><p>nothing here yet, sorry</p>") }, {}, none).classification).toBe("inconclusive");
        expect(classify(item("B", "/notes/50123"), { b: html(200, "<h1>Bob's salary review</h1><p>raise approved</p>"), a: html(200, "<h1>Bob's salary review</h1><p>raise approved</p>") }, {}, none).classification).toBe("unauthorized-read");
    });
});

describe("lists and searches", () => {
    const all = [aNote, bNote];
    it("4: A's list holding B's items (by the ownership field) is an unauthorized read; B's own list is the reference", () => {
        const o = classify(item("B", "/api/notes", "list"), { b: json(200, { items: [bNote] }), visitor: json(401, {}), a: json(200, { items: all }) }, D, none);
        expect(o).toMatchObject({ classification: "unauthorized-read", matched: 1, fields: ["ownerId"] });
        expect(classify(item("B", "/api/notes?mine=1", "list"), { b: json(200, [bNote]), visitor: json(401, {}), a: json(200, [aNote]) }, D, none).classification).toBe("protected");
        expect(classify(item("B", "/api/search?q=review", "search"), { b: json(200, { results: [bNote] }), visitor: json(401, {}), a: json(200, { results: [bNote] }) }, D, none).classification).toBe("unauthorized-read");
    });
    it("7: a list without ownership metadata is inconclusive, not vulnerable", () => {
        expect(classify(item("B", "/api/notes", "list"), { b: json(200, all), a: json(200, all) }, {}, none).classification).toBe("inconclusive");
        expect(classify(item("B", "/api/notes", "list"), { b: json(200, [aNote]), a: json(200, all) }, D, none).classification).toBe("inconclusive");
    });
});

describe("running a designation", () => {
    it("asks A's own resources first, fetches only with the given fetch, and keeps no response body in the finding (13)", async () => {
        const calls: Array<{ who: Identity; path: string }> = [];
        const answers: Record<string, Partial<Record<Identity, GuardedAnswer>>> = {
            "/api/notes/40111": { A: json(200, aNote) },
            "/api/notes/50123": { B: json(200, bNote), A: json(200, bNote), visitor: json(401, {}) },
        };
        const fetchAs: FetchAs = async (who, path) => {
            calls.push({ who, path });
            const a = answers[path]?.[who];
            if (!a) throw new Error("no answer");
            return a;
        };
        const designation = DesignationSchema.parse({ accountA: "alice", accountB: "bob", ...D, resources: [item("B"), item("A", "/api/notes/40111")] });
        const run = await runCrossAccount({ targetUrl: "http://app.test/", designation, labels: { A: "alice", B: "bob" }, fetchAs });
        expect(calls[0]).toEqual({ who: "A", path: "/api/notes/40111" });
        expect(run.results).toHaveLength(1);
        const draft = normalize(run.results[0]!)!;
        expect(draft).toMatchObject({ category: "access-control", severity: "high" });
        const stored = JSON.stringify(draft);
        for (const secret of [bNote.title, bNote.body]) expect(stored).not.toContain(secret);
        expect(draft.reproduction).toMatch(/Signed in as alice, request GET \/api\/notes\/50123/);
        expect(run.lines[0]).toMatch(/Only GET requests were sent; no request was meant to change anything/);
    });

    it("10: a sign-out address or a GraphQL mutation is never requested", async () => {
        expect(refusalOf("/logout")).toMatch(/sign-out/);
        expect(refusalOf("/graphql?query=mutation%20%7BdeleteNote(id%3A1)%7D")).toMatch(/mutation/);
        expect(refusalOf("/graphql?query=subscription{x}")).toMatch(/mutation or subscription/);
        expect(refusalOf("/graphql?query=%7Bnote(id%3A1)%7Btitle%7D%7D")).toBeUndefined();
        const calls: string[] = [];
        const designation = DesignationSchema.parse({ accountA: "alice", accountB: "bob", resources: [item("B", "/logout"), item("B", "/graphql?query=mutation%20%7Bx%7D")] });
        const run = await runCrossAccount({ targetUrl: "http://app.test/", designation, labels: { A: "alice", B: "bob" }, fetchAs: async (_w, p) => (calls.push(p), json(200, {})) });
        expect(calls).toEqual([]);
        expect(run.lines.filter((l) => l.includes("was not requested"))).toHaveLength(2);
    });
});

describe("designation and environment rules", () => {
    it("12: runs only against development or staging", () => {
        expect(CROSS_ACCOUNT_ENVIRONMENTS).toEqual(["development", "staging"]);
        expect(environmentProblem("staging")).toBeUndefined();
        expect(environmentProblem("production")).toMatch(/marked “production”/);
        expect(environmentProblem("other")).toMatch(/marked “other”/);
    });
    it("refuses bad designations", () => {
        const ok = { accountA: "alice", accountB: "bob", resources: [item("B")] };
        expect(DesignationSchema.safeParse(ok).success).toBe(true);
        expect(DesignationSchema.safeParse({ ...ok, accountB: "alice" }).success).toBe(false);
        expect(DesignationSchema.safeParse({ ...ok, resources: [{ ...item("B"), path: "https://evil.test/x" }] }).success).toBe(false);
        expect(DesignationSchema.safeParse({ ...ok, resources: [{ ...item("B"), method: "DELETE" }] }).success).toBe(false);
        expect(DesignationSchema.safeParse({ ...ok, resources: [] }).success).toBe(false);
        expect(DesignationSchema.safeParse({ ...ok, ownerValueA: "x1", ownerValueB: "x1" }).success).toBe(false);
    });
});
