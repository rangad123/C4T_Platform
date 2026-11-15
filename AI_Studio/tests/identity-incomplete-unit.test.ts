/**
 * A viewer whose survey crawl the browser crash cut short is never evidence that a page or record is closed to it, and a record read is
 * fetched from the browser only when its size is known to be within the cap.
 */
import { describe, expect, it } from "vitest";
import { generateAccessSpecs, recordValues, smallAnswer, type ApiRecordSeen, type Reach } from "../src/engine/identity/access.js";
import { roleDifferences } from "../src/engine/identity/role-differences.js";

const page = (path: string, heading: string) => ({ path, heading });
const admin: Reach = {
    who: "admin",
    pages: [page("/", "Home"), page("/admin/users", "User administration"), page("/reports", "Monthly reports"), page("/notes/1", "Admin note one")],
};
const viewer: Reach = {
    who: "viewer",
    pages: [page("/", "Home"), page("/notes/2", "Viewer note two")],
};
const anon: Reach = { who: "anonymous", pages: [page("/", "Home")] };
const rec = (path: string, title: string): ApiRecordSeen => ({
    path,
    pattern: path.replace(/\/\d+$/, "/{}"),
    page: "/",
    values: recordValues({ title }),
});

describe("a survey crawl that ended in a browser crash", () => {
    it("makes no page-open checks for that viewer, while a complete crawl of the same reach does", () => {
        const complete = generateAccessSpecs([anon, admin, viewer]);
        expect(complete.some((s) => s.title.startsWith("“viewer” account"))).toBe(true);
        expect(complete.some((s) => s.title.startsWith("Not signed in"))).toBe(true);
        const crashed = generateAccessSpecs([
            { ...anon, incomplete: "The browser closed unexpectedly" },
            admin,
            { ...viewer, incomplete: "The browser page closed unexpectedly" },
        ]);
        expect(crashed.filter((s) => s.title.startsWith("“viewer” account") || s.title.startsWith("Not signed in"))).toEqual([]);
        // The crashed account still owns what it did reach: others get checks against its pages.
        expect(crashed.some((s) => s.title.startsWith("“admin” account"))).toBe(true);
    });

    it("makes no same-level API checks with the crashed account as the viewer", () => {
        const a: Reach = {
            who: "alice",
            pages: [page("/", "Home")],
            api: [rec("/api/notes/1", "Alice tax plan 2026")],
        };
        const b: Reach = {
            who: "bob",
            pages: [page("/", "Home")],
            api: [rec("/api/notes/3", "Bob holiday budget")],
        };
        const api = (r: Reach[]) =>
            generateAccessSpecs(r)
                .filter((s) => s.title.includes("through the API"))
                .map((s) => s.title);
        expect(api([a, b])).toHaveLength(2);
        expect(api([a, { ...b, incomplete: "The browser closed unexpectedly" }])).toEqual([
            "“alice” account: cannot read a record of “bob” through the API (GET /api/notes/3)",
        ]);
    });

    it("is not described as an account that cannot reach a screen", () => {
        expect(roleDifferences([admin, viewer]).some((l) => l.includes("“viewer” did not reach"))).toBe(true);
        expect(roleDifferences([admin, { ...viewer, incomplete: "The browser closed unexpectedly" }]).some((l) => l.includes("“viewer” did not reach"))).toBe(
            false,
        );
    });
});

describe("record answers are read only when they are known to be small", () => {
    const res = (length: string | null, bodySize?: number) => ({
        headerValue: async () => length,
        request: () => ({
            sizes: async () => (bodySize === undefined ? Promise.reject(new Error("no sizes")) : { responseBodySize: bodySize }),
        }),
    });
    it("uses Content-Length first, then the size the browser received, and refuses an unknown size", async () => {
        expect(await smallAnswer(res("1024") as never)).toBe(true);
        expect(await smallAnswer(res(String(256 * 1024)) as never)).toBe(true);
        expect(await smallAnswer(res(String(256 * 1024 + 1), 10) as never)).toBe(false);
        expect(await smallAnswer(res("nonsense", 10) as never)).toBe(false);
        expect(await smallAnswer(res(null, 2000) as never)).toBe(true);
        expect(await smallAnswer(res(null, 300 * 1024) as never)).toBe(false);
        expect(await smallAnswer(res(null) as never)).toBe(false);
    });
});
