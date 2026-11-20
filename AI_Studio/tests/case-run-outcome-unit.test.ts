/**
 * What one run of a Test Case Generation project found (src/platform/case-run-outcome.ts runOutcomeOf; founder 2026-11-19 R10.3, Q4,
 * PLAN.md U5): the run page shows that run's part of the one tree, with the whole outcome's TC numbers, and a stopped run keeps what it
 * found. Pure: no database, no browser.
 */
import { describe, expect, it } from "vitest";
import { mergeCaseRuns, type CaseRunInput, type CaseRunPart } from "../src/platform/case-outcome.js";
import { runOutcomeOf } from "../src/platform/case-run-outcome.js";

const page = (path: string) => ({ path, url: `http://shop.test${path}`, title: `Title of ${path}`, purpose: "" });
const kase = (title: string, pagePath = "/") => ({ title, type: "automated" as const, priority: "high" as const, page: pagePath, preconditions: [], steps: [], expected: [], requirement: "" });
let n = 0;
const run = (part: Partial<CaseRunPart>, status: "completed" | "stopped" = "completed"): CaseRunInput => ({
    run: { jobId: `job-${++n}`, startedAt: new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString(), status },
    part: { pages: [], edges: [], cases: [], failed: [], ...part },
});

describe("one run's part of the outcome", () => {
    // Run A: /, /products, /about with 3 cases. Run B (stopped): /products, /products/1, /cart, with one of A's cases and two new ones.
    const a = run({ pages: [page("/"), page("/products"), page("/about")], edges: [{ from: "/", to: "/products" }], cases: [kase("Open the home page"), kase("Browse the products", "/products"), kase("Read about us", "/about")] });
    const b = run(
        {
            pages: [page("/products"), page("/products/1"), page("/cart")],
            edges: [{ from: "/products", to: "/products/1" }],
            cases: [kase("Browse the products", "/products"), kase("Open a product", "/products/1"), kase("Fill the cart", "/cart")],
            failed: ["/broken", "/products"],
        },
        "stopped",
    );
    const merged = mergeCaseRuns([a, b]);

    it("lists the pages the run reached and the test cases it wrote, new or already known, with the outcome's TC numbers", () => {
        const o = runOutcomeOf(merged, b.run.jobId)!;
        expect(o.runs).toEqual([{ ...b.run, addedPages: 2, addedCases: 2 }]);
        expect(o.pages.map((p) => p.path)).toEqual(["/products", "/products/1", "/cart"]);
        expect(o.tree.map((t) => t.node)).toEqual(["/products", "/products/1", "/cart"]);
        // "Browse the products" was A's TC-002 and keeps that number; the two new ones follow A's three.
        expect(o.cases.map((c) => [c.id, c.title])).toEqual([
            ["TC-002", "Browse the products"],
            ["TC-004", "Open a product"],
            ["TC-005", "Fill the cart"],
        ]);
        // Each node counts this run's cases on it.
        expect(Object.fromEntries(o.tree.map((t) => [t.node, t.cases]))).toEqual({ "/products": 1, "/products/1": 1, "/cart": 1 });
        // Only the address that is not a page counts as not opened.
        expect(o.notOpened).toBe(1);
    });

    it("keeps a parent the run reached, and makes a page whose parent it did not reach a root of its part", () => {
        const o = runOutcomeOf(merged, b.run.jobId)!;
        const parent = Object.fromEntries(o.tree.map((t) => [t.node, t.parent]));
        expect(parent["/products/1"]).toBe("/products");
        // In the whole tree /products hangs under /, which this run did not reach.
        expect(merged.tree.find((t) => t.node === "/products")?.parent).toBe("/");
        expect(parent["/products"]).toBeNull();
        expect(parent["/cart"]).toBeNull();
    });

    it("skips a parent the run did not reach and uses the nearest one above it that it did", () => {
        const c = run({ pages: [page("/"), page("/products/1")], cases: [] });
        const m = mergeCaseRuns([a, b, c]);
        // /products/1 sits under /products in the whole tree; run C reached / but not /products.
        expect(runOutcomeOf(m, c.run.jobId)!.tree.find((t) => t.node === "/products/1")?.parent).toBe("/");
    });

    it("is the first run's own part, not the whole tree", () => {
        const o = runOutcomeOf(merged, a.run.jobId)!;
        expect(o.tree.map((t) => t.node)).toEqual(["/", "/products", "/about"]);
        expect(o.cases.map((c) => c.id)).toEqual(["TC-001", "TC-002", "TC-003"]);
        expect(o.notOpened).toBe(0);
    });

    it("answers nothing for a run that is not one of the project's", () => {
        expect(runOutcomeOf(merged, "job-elsewhere")).toBeUndefined();
    });
});
