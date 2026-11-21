/**
 * The Test Case Generation outcome, merged from its runs (src/platform/case-outcome.ts mergeCaseRuns; SPEC P3.3, R10.1, Q4):
 * every run grows the same tree, a page is one node and a test case one row however many runs found it, TC numbers stay, the
 * parent of a page is the page it was first reached from (else its URL-path parent, else the root), and addresses that could not be
 * opened are counted apart from the pages. Pure: no database, no browser.
 */
import { describe, expect, it } from "vitest";
import { mergeCaseRuns, runStatusOf, type CaseRunInput, type CaseRunPart } from "../src/platform/case-outcome.js";

const page = (path: string, title = `Title of ${path}`, purpose = "") => ({ path, url: `http://shop.test${path}`, title, purpose });
const kase = (title: string, pagePath = "/") => ({ title, type: "automated" as const, priority: "high" as const, page: pagePath, preconditions: [], steps: [], expected: [`${title} works`], requirement: "" });
let n = 0;
const run = (part: Partial<CaseRunPart>, status: "completed" | "stopped" = "completed"): CaseRunInput => ({
    run: { jobId: `job-${++n}`, startedAt: new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString(), status },
    part: { pages: [], edges: [], cases: [], failed: [], ...part },
});

describe("each run grows the same outcome (R10.1)", () => {
    it("run A (3 pages, 5 cases) then run B (5 pages incl. the 3, 8 cases incl. 4 of A's) gives 5 pages and 9 cases", () => {
        const a = run({ pages: [page("/"), page("/products"), page("/about")], cases: ["One", "Two", "Three", "Four", "Five"].map((t) => kase(t)) });
        const b = run({
            pages: [page("/"), page("/products"), page("/about"), page("/cart"), page("/login")],
            cases: [...["One", "Two", "Three", "Four"].map((t) => kase(t)), ...["Six", "Seven", "Eight", "Nine"].map((t) => kase(t))],
        });
        const o = mergeCaseRuns([a, b]);
        expect(o.pages).toHaveLength(5);
        expect(o.tree).toHaveLength(5);
        expect(o.cases).toHaveLength(9);
        // Newest first, each with what it was first to find; B wrote 8, 4 of them new.
        expect(o.runs.map((r) => [r.jobId, r.addedPages, r.addedCases])).toEqual([
            [b.run.jobId, 2, 4],
            [a.run.jobId, 3, 5],
        ]);
        expect(o.written.get(b.run.jobId)).toBe(8);
        // The page count is the same everywhere: pages, tree nodes, and the sum of the nodes' cases is every case.
        expect(o.tree.reduce((s, t) => s + t.cases, 0)).toBe(o.cases.length);
    });

    it("keeps each test case's TC number from its first appearance, matching titles without regard to case, spaces or a full stop", () => {
        const a = run({ pages: [page("/"), page("/products")], cases: [kase("Browse the products", "/products"), kase("Open the home page")] });
        const b = run({ pages: [page("/"), page("/products")], cases: [kase("Search for a product", "/products"), kase("  browse THE products. ", "/products"), kase("Open the home page")] });
        const o = mergeCaseRuns([a, b]);
        expect(o.cases.map((c) => [c.id, c.title])).toEqual([
            ["TC-001", "browse THE products."],
            ["TC-002", "Open the home page"],
            ["TC-003", "Search for a product"],
        ]);
        // The same title on another page is another test case.
        const c = run({ pages: [page("/"), page("/products")], cases: [kase("Open the home page", "/products")] });
        expect(mergeCaseRuns([a, b, c]).cases).toHaveLength(4);
    });

    // F3 review M3 (tc-shift probe): two cases with one title whose start pages both fell back to "/" merged, and a later run that found
    // /cart split them and renumbered every case after them; a re-import then skipped the wrong case as "already here".
    it("never moves a TC number to another case when a later run finds the page an earlier case started on", () => {
        const a = run({ pages: [page("/"), page("/products")], cases: [kase("Open the cart", "/"), kase("Open the cart", "/cart"), kase("Browse products", "/products")] });
        const b = run({ pages: [page("/"), page("/cart")] });
        const ids = (o: ReturnType<typeof mergeCaseRuns>) => o.cases.map((c) => `${c.id} ${c.title} @${c.page}`);
        expect(ids(mergeCaseRuns([a]))).toEqual(["TC-001 Open the cart @/", "TC-002 Open the cart @/", "TC-003 Browse products @/products"]);
        expect(ids(mergeCaseRuns([a, b]))).toEqual(["TC-001 Open the cart @/", "TC-002 Open the cart @/cart", "TC-003 Browse products @/products"]);
        // A case with no start page (a stopped run's announced case) is the same case as one starting on "/".
        const stopped = run({ pages: [page("/")], cases: [kase("Open the home page", "")] }, "stopped");
        expect(mergeCaseRuns([stopped, run({ pages: [page("/")], cases: [kase("Open the home page", "/")] })]).cases).toHaveLength(1);
    });

    it("lets a later run's title, address and purpose win, but never with an empty one", () => {
        const a = run({ pages: [page("/", "Old home", "The start")] });
        const b = run({ pages: [page("/", "New home", "")] });
        const stopped = run({ pages: [{ path: "/", url: "", title: "", purpose: "" }] }, "stopped");
        expect(mergeCaseRuns([a, b, stopped]).pages).toEqual([{ path: "/", url: "http://shop.test/", title: "New home", purpose: "The start" }]);
    });

    it("keeps what a stopped run found, and a stopped run with nothing adds nothing", () => {
        const a = run({ pages: [page("/")], cases: [kase("One")] });
        const stopped = run({ pages: [page("/"), page("/products")], cases: [] }, "stopped");
        const empty = run({}, "stopped");
        const o = mergeCaseRuns([a, stopped, empty]);
        expect(o.pages.map((p) => p.path)).toEqual(["/", "/products"]);
        expect(o.runs.map((r) => [r.status, r.addedPages, r.addedCases])).toEqual([
            ["stopped", 0, 0],
            ["stopped", 1, 0],
            ["completed", 1, 1],
        ]);
    });
});

describe("the tree (P3.3)", () => {
    const parents = (part: Partial<CaseRunPart>) => Object.fromEntries(mergeCaseRuns([run(part)]).tree.map((t) => [t.node, t.parent]));

    it("navigation edges / → /products → /products/1 give /products as the parent of /products/1", () => {
        expect(parents({ pages: [page("/"), page("/products"), page("/products/1")], edges: [{ from: "/", to: "/products" }, { from: "/products", to: "/products/1" }] })).toEqual({ "/": null, "/products": "/", "/products/1": "/products" });
    });

    it("uses the page it was first reached from, even when its address says otherwise", () => {
        expect(parents({ pages: [page("/"), page("/deals"), page("/products/1"), page("/products")], edges: [{ from: "/", to: "/deals" }, { from: "/deals", to: "/products/1" }, { from: "/products", to: "/products/1" }] })["/products/1"]).toBe("/deals");
    });

    it("without an edge: the URL-path parent that is a page, else the root", () => {
        const p = parents({ pages: [page("/"), page("/account"), page("/account/orders/7"), page("/help/faq"), page("/search?q=bag")] });
        expect(p).toEqual({ "/": null, "/account": "/", "/account/orders/7": "/account", "/help/faq": "/", "/search?q=bag": "/" });
        // A query page's parent is the same path without the query, when that is a page.
        expect(parents({ pages: [page("/"), page("/search"), page("/search?q=bag")] })["/search?q=bag"]).toBe("/search");
    });

    it("roots at the first page found when / is not a page, and never makes a loop", () => {
        const p = parents({ pages: [page("/home"), page("/a"), page("/b")], edges: [{ from: "/b", to: "/a" }, { from: "/a", to: "/b" }] });
        expect(p["/home"]).toBeNull();
        // /a came from /b and /b from /a: one of them goes under the root instead.
        expect(new Set([p["/a"], p["/b"]])).toEqual(new Set(["/b", "/home"]));
        // Every node reaches the root.
        for (const start of Object.keys(p)) {
            let at: string | null = start;
            for (let i = 0; at && i < 10; i++) at = p[at] ?? null;
            expect(at, start).toBeNull();
        }
    });

    it("an edge from a page that is not in the tree is ignored", () => {
        expect(parents({ pages: [page("/"), page("/products/1")], edges: [{ from: "/products", to: "/products/1" }] })["/products/1"]).toBe("/");
    });

    it("puts each test case on a node: its start page, else that page without its query, else its URL-path parent, else the root", () => {
        const o = mergeCaseRuns([run({ pages: [page("/"), page("/products")], cases: [kase("A", "/products"), kase("B", "/products?sort=price"), kase("C", "/products/9"), kase("D", "/nowhere"), kase("E", "")] })]);
        expect(o.cases.map((c) => [c.title, c.page])).toEqual([
            ["A", "/products"],
            ["B", "/products"],
            ["C", "/products"],
            ["D", "/"],
            ["E", "/"],
        ]);
        expect(o.tree.map((t) => [t.node, t.cases])).toEqual([
            ["/", 2],
            ["/products", 3],
        ]);
    });
});

describe("addresses that could not be opened (the 41 vs 36 count)", () => {
    it("are counted once, apart from the pages, and not when a run did load them", () => {
        const a = run({ pages: [page("/"), page("/products")], failed: ["/broken", "/broken", "/later"] });
        const b = run({ pages: [page("/later")], failed: ["/gone"] });
        const o = mergeCaseRuns([a, b]);
        expect(o.pages.map((p) => p.path)).toEqual(["/", "/products", "/later"]);
        expect(o.tree).toHaveLength(3);
        expect(o.notOpened).toBe(2);
    });
});

describe("a run's status", () => {
    it("is completed, stopped (cancelled), failed or running", () => {
        expect(runStatusOf({ status: "COMPLETED", error: null, cancelRequested: false })).toBe("completed");
        expect(runStatusOf({ status: "PARTIALLY_COMPLETED", error: "x", cancelRequested: false })).toBe("completed");
        expect(runStatusOf({ status: "FAILED", error: "Cancelled", cancelRequested: true })).toBe("stopped");
        expect(runStatusOf({ status: "FAILED", error: "The site did not answer", cancelRequested: false })).toBe("failed");
        expect(runStatusOf({ status: "DISCOVERING", error: null, cancelRequested: false })).toBe("running");
    });
});
