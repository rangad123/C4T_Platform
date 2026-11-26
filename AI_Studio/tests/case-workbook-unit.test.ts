/**
 * The Test Case Generation workbook (founder 2026-11-19, SPEC R7 and R9, owner decision Q3): `buildCaseWorkbook` turns the outcome into an
 * .xlsx with exactly three sheets. The file is unzipped here with fflate and its XML read back; nothing is imported from the writer's
 * internals. Expected values come from the SPEC, not from a run of the code.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/case-workbook-unit.test.ts
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { CaseOutcome, CaseOutcomeCase } from "../src/platform/case-outcome-types.js";
import { buildCaseWorkbook } from "../src/platform/case-workbook.js";

// ── reading a workbook back ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
function unzip(bytes: Uint8Array): Record<string, string> {
    return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}
interface Cell {
    attrs: string;
    inner: string;
}
function cells(xml: string): Cell[] {
    return [...xml.matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)].map((m) => ({ attrs: m[1]!, inner: m[2] ?? "" }));
}
/** The sheet's rows as arrays of cell text ("" for an empty cell), by cell reference. */
function readRows(xml: string): string[][] {
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/gs)) {
        const row: string[] = [];
        for (const c of r[2]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
            let col = 0;
            for (const ch of c[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
            const t = /<t xml:space="preserve">(.*?)<\/t>/s.exec(c[3] ?? "");
            row[col - 1] = t ? unesc(t[1]!) : "";
        }
        rows[Number(r[1]) - 1] = Array.from(row, (v) => v ?? "");
    }
    return rows;
}
/** Sheet name → rows, in the workbook's order. */
function sheets(bytes: Uint8Array): Array<{ name: string; rows: string[][]; xml: string }> {
    const files = unzip(bytes);
    const rels = Object.fromEntries([...files["xl/_rels/workbook.xml.rels"]!.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
    return [...files["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]+)" sheetId="\d+" r:id="(rId\d+)"\/>/g)].map((m) => {
        const xml = files[`xl/${rels[m[2]!]}`]!;
        return { name: unesc(m[1]!), rows: readRows(xml), xml };
    });
}

// Sheet items 31-33: "Test data" and "Check" come after the columns a code project's Import reads.
const CASE_HEADERS = ["ID", "Title", "Type", "Priority", "Page", "Preconditions", "Steps", "Expected result", "Requirement", "Test data", "Check"];

function tc(n: number, over: Partial<CaseOutcomeCase> = {}): CaseOutcomeCase {
    return {
        id: `TC-${String(n).padStart(3, "0")}`,
        title: `Case ${n}`,
        type: "automated",
        priority: "medium",
        page: "/",
        preconditions: [],
        steps: [],
        expected: [],
        requirement: "",
        ...over,
    };
}

function outcome(over: Partial<CaseOutcome> = {}): CaseOutcome {
    return {
        caseAgent: true,
        runs: [{ jobId: "job-1", startedAt: "2026-11-20T10:00:00.000Z", status: "completed", addedPages: 3, addedCases: 2 }],
        pages: [
            { path: "/", url: "http://localhost:4173/", title: "Home", purpose: "Landing page with the product list" },
            { path: "/cart", url: "http://localhost:4173/cart", title: "Cart", purpose: "Review items before paying" },
            { path: "/cart/checkout", url: "http://localhost:4173/cart/checkout", title: "Checkout", purpose: "Pay for the order" },
        ],
        tree: [
            { node: "/", parent: null, page: "/", title: "Home", cases: 1 },
            { node: "/cart", parent: "/", page: "/cart", title: "Cart", cases: 0 },
            { node: "/cart/checkout", parent: "/cart", page: "/cart/checkout", title: "Checkout", cases: 1 },
        ],
        cases: [
            tc(1, {
                title: "Adding a product shows it in the cart",
                priority: "high",
                page: "/",
                preconditions: ["Signed in as a shopper", "The cart is empty"],
                expected: ["The cart badge shows 1", "The product is listed in the cart"],
                requirement: "REQ-2",
                // Sheet item 32: every case has numbered steps, an Automated one too.
                steps: [{ action: "Click Add to cart", expected: "Badge shows 1" }],
                testData: [
                    { field: "Quantity", kind: "valid", value: "1", missing: false },
                    { field: "Quantity", kind: "boundary", value: "0", missing: false },
                    { field: "Shopper account", kind: "valid", value: "", missing: true },
                ],
            }),
            tc(2, {
                title: "Paying with an expired card is refused",
                type: "manual",
                priority: "critical",
                page: "/cart/checkout",
                preconditions: ["One product in the cart"],
                steps: [
                    { action: "Enter an expired card", expected: "The card field is marked" },
                    { action: "Press Pay", expected: "" },
                ],
                expected: ["The order is not placed"],
                requirement: "Payments",
            }),
        ],
        notOpened: 0,
        missing: [],
        ...over,
    };
}

describe("buildCaseWorkbook: the three sheets (R9, Q3)", () => {
    it("has exactly Test cases, Pages, Tree, in that order, with the Q3 headers", () => {
        const s = sheets(buildCaseWorkbook(outcome()));
        expect(s.map((x) => x.name)).toEqual(["Test cases", "Pages", "Tree"]);
        expect(s[0]!.rows[0]).toEqual(CASE_HEADERS);
        expect(s[1]!.rows[0]).toEqual(["Page", "Address", "Purpose"]);
        expect(s[2]!.rows[0]).toEqual(["Node", "Parent", "Page"]);
    });

    it("writes one Test cases row per case with the Q3 values, and no script column", () => {
        const [cases] = sheets(buildCaseWorkbook(outcome()));
        expect(cases!.rows).toHaveLength(3);
        expect(cases!.rows[1]).toEqual([
            "TC-001",
            "Adding a product shows it in the cart",
            "Automated",
            "High",
            "/",
            "Signed in as a shopper\nThe cart is empty",
            "1. Click Add to cart => Badge shows 1",
            "The cart badge shows 1\nThe product is listed in the cart",
            "REQ-2",
            "Valid: Quantity = 1\nBoundary: Quantity = 0\nValid: Shopper account = MISSING (not known, fill in before running)",
            "",
        ]);
        expect(cases!.rows[2]!.slice(0, 6)).toEqual(["TC-002", "Paying with an expired card is refused", "Manual", "Critical", "/cart/checkout", "One product in the cart"]);
        expect(cases!.rows[2]!.slice(7, 9)).toEqual(["The order is not placed", "Payments"]);
        expect(cases!.rows.every((r) => r.length <= CASE_HEADERS.length)).toBe(true);
    });

    it("writes Pages as page, address, purpose and Tree as node, parent, page", () => {
        const [, pages, tree] = sheets(buildCaseWorkbook(outcome()));
        expect(pages!.rows.slice(1)).toEqual([
            ["/", "http://localhost:4173/", "Landing page with the product list"],
            ["/cart", "http://localhost:4173/cart", "Review items before paying"],
            ["/cart/checkout", "http://localhost:4173/cart/checkout", "Pay for the order"],
        ]);
        expect(tree!.rows.slice(1).map((r) => [r[0], r[1] ?? "", r[2] ?? ""])).toEqual([
            ["/", "", "/"],
            ["/cart", "/", "/cart"],
            ["/cart/checkout", "/cart", "/cart/checkout"],
        ]);
    });

    it("keeps Tree integrity: every Parent is empty or another Node, every Page is a row of Pages", () => {
        const o = outcome({
            tree: [
                { node: "/", parent: null, page: "/", title: "Home", cases: 1 },
                { node: "/orphan", parent: "/gone", page: "/orphan", title: "Orphan", cases: 0 },
                { node: "/cart", parent: "/", page: "/not-a-page", title: "Cart", cases: 0 },
                { node: "/self", parent: "/self", page: "/", title: "Self", cases: 0 },
            ],
        });
        const [, pages, tree] = sheets(buildCaseWorkbook(o));
        const nodes = new Set(tree!.rows.slice(1).map((r) => r[0]));
        const pageRows = new Set(pages!.rows.slice(1).map((r) => r[0]));
        for (const r of tree!.rows.slice(1)) {
            const parent = r[1] ?? "";
            const page = r[2] ?? "";
            expect(parent === "" || (nodes.has(parent) && parent !== r[0])).toBe(true);
            expect(page === "" || pageRows.has(page)).toBe(true);
        }
        // An unknown parent makes the node a root; nothing else is lost.
        expect(tree!.rows.slice(1).map((r) => r[0])).toEqual(["/", "/orphan", "/cart", "/self"]);
        expect(tree!.rows[2]![1] ?? "").toBe("");
    });

    it("a requirements-only outcome (no pages) has an empty Page column and Tree pages", () => {
        const o = outcome({
            pages: [],
            tree: [
                { node: "Payments", parent: null, page: "", title: "Payments", cases: 1 },
                { node: "Payments/Refunds", parent: "Payments", page: "", title: "Refunds", cases: 0 },
            ],
            cases: [tc(1, { page: "", requirement: "REQ-1" })],
        });
        const [cases, pages, tree] = sheets(buildCaseWorkbook(o));
        expect(pages!.rows).toHaveLength(1);
        expect(cases!.rows[1]![4] ?? "").toBe("");
        expect(tree!.rows.slice(1).map((r) => [r[0], r[1] ?? "", r[2] ?? ""])).toEqual([
            ["Payments", "", ""],
            ["Payments/Refunds", "Payments", ""],
        ]);
    });

    it("an empty outcome still has the three sheets with their headers", () => {
        const s = sheets(buildCaseWorkbook(outcome({ runs: [], pages: [], tree: [], cases: [] })));
        expect(s.map((x) => [x.name, x.rows.length])).toEqual([
            ["Test cases", 1],
            ["Pages", 1],
            ["Tree", 1],
        ]);
    });
});

describe("buildCaseWorkbook: numbered steps on every row (sheet item 32)", () => {
    it("every row holds one numbered `n. action => expected` line per step", () => {
        const [cases] = sheets(buildCaseWorkbook(outcome()));
        expect(cases!.rows[1]![6]).toBe("1. Click Add to cart => Badge shows 1");
        expect(cases!.rows[2]![6]).toBe("1. Enter an expired card => The card field is marked\n2. Press Pay");
    });

    it("the Check column says what the check after generation flagged, one per line (sheet items 31-33)", () => {
        const [cases] = sheets(buildCaseWorkbook(outcome({ cases: [tc(1, { flags: ["No execution steps", "Not linked to a requirement"] })] })));
        expect(cases!.rows[1]![10]).toBe("No execution steps\nNot linked to a requirement");
    });

    it("a line break inside a step does not split it into two steps", () => {
        const o = outcome({ cases: [tc(1, { type: "manual", steps: [{ action: "Type\nthe name", expected: "It is\r\nshown" }] })] });
        const [cases] = sheets(buildCaseWorkbook(o));
        expect(cases!.rows[1]![6]).toBe("1. Type the name => It is shown");
    });
});

describe("buildCaseWorkbook: safe cells", () => {
    const hostile = ["=HYPERLINK(\"http://evil.example\",\"x\")", "+1+1", "-2+3", "@SUM(A1:A2)", "=1+1"];
    const o = outcome({
        pages: [{ path: "/", url: "=cmd|' /C calc'!A0", title: "Home", purpose: "@purpose" }],
        tree: [{ node: "/", parent: null, page: "/", title: "Home", cases: 1 }],
        cases: hostile.map((h, i) =>
            tc(i + 1, { title: h, type: "manual", page: "/", preconditions: [h], steps: [{ action: h, expected: h }], expected: [h], requirement: h }),
        ),
    });

    it("never writes a formula: every filled cell is an inline string, and a value starting with = + - @ is kept as typed", () => {
        const s = sheets(buildCaseWorkbook(o));
        for (const sheet of s) {
            expect(sheet.xml).not.toMatch(/<f[\s>]/);
            for (const c of cells(sheet.xml)) if (c.inner) expect(c.attrs).toContain('t="inlineStr"');
        }
        expect(s[0]!.rows.slice(1).map((r) => r[1])).toEqual(hostile);
        expect(s[0]!.rows[1]![8]).toBe(hostile[0]);
        expect(s[1]!.rows[1]).toEqual(["/", "=cmd|' /C calc'!A0", "@purpose"]);
    });

    it("escapes XML and drops characters XML cannot carry", () => {
        const w = buildCaseWorkbook(outcome({ cases: [tc(1, { title: `<script>alert("x")</script> & co\u0000\u0007`, requirement: "]]><x/>" })] }));
        const [cases] = sheets(w);
        expect(cases!.rows[1]![1]).toBe(`<script>alert("x")</script> & co`);
        expect(cases!.rows[1]![8]).toBe("]]><x/>");
        expect(cases!.xml).not.toContain("<script>");
        expect(cases!.xml).not.toContain("<x/>");
        expect(cases!.xml).not.toMatch(/[\u0000-\u0008]/);
    });

    it("cuts a cell longer than Excel's 32 767 characters", () => {
        const [cases] = sheets(buildCaseWorkbook(outcome({ cases: [tc(1, { title: "a".repeat(40_000) })] })));
        expect(cases!.rows[1]![1]!.length).toBeLessThanOrEqual(32_767);
    });

    it("names the parts a spreadsheet needs", () => {
        const files = Object.keys(unzip(buildCaseWorkbook(outcome())));
        for (const p of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"])
            expect(files).toContain(p);
    });
});

describe("buildCaseWorkbook: size", () => {
    it("a 500-case outcome builds in under 1 s", () => {
        const pages = Array.from({ length: 60 }, (_, i) => ({ path: `/p${i}`, url: `http://localhost:4173/p${i}`, title: `Page ${i}`, purpose: `Purpose of page ${i}` }));
        const tree = pages.map((p, i) => ({ node: p.path, parent: i ? "/p0" : null, page: p.path, title: p.title, cases: 8 }));
        const cases = Array.from({ length: 500 }, (_, i) =>
            tc(i + 1, {
                title: `Case ${i} with a reasonably long title that describes the behaviour under test`,
                type: i % 3 ? "automated" : "manual",
                page: `/p${i % 60}`,
                preconditions: ["Signed in", "Has data"],
                steps: Array.from({ length: 6 }, (_, k) => ({ action: `Do step ${k}`, expected: `See result ${k}` })),
                expected: ["Outcome one", "Outcome two"],
                requirement: `REQ-${i % 40}`,
            }),
        );
        const t0 = performance.now();
        const bytes = buildCaseWorkbook(outcome({ pages, tree, cases }));
        expect(performance.now() - t0).toBeLessThan(1000);
        const [sheet] = sheets(bytes);
        expect(sheet!.rows).toHaveLength(501);
    });
});
