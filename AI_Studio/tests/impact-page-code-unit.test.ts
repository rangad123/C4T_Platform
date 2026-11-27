/**
 * Impact analysis of page code and of files that are not application code (src/engine/impact/analyze.ts), from the real practice-store PR
 * (rangad123/C4T_WorkBench#1, FREE-B #4: 5 of its 7 files were unmapped, so no PR could focus):
 *   - a browser script maps to the pages that load it: a page file that loads it, and the page address a server page table gives that
 *     file, or the file's own address when the app's tests open a page there; a web test that opens such a page is reached;
 *   - the repository's own tests and a build script that writes into the browser folder are not application code: neither unmapped nor
 *     counted among the changed files. A stand-alone tool (the PR bench's unmapped change) stays unmapped.
 * Pure, no AI.
 */
import { describe, expect, it } from "vitest";
import { analyzeImpact } from "../src/engine/impact/analyze.js";
import type { CoverageItem, TestCoverage } from "../src/platform/selection/coverage.js";

const pg = (path: string): CoverageItem => ({ kind: "page", path, query: [], source: "declared", seenIn: ["step 1"] });
const web = (id: string, path: string): TestCoverage => ({ testId: id, testKey: id, title: id, kind: "web", items: [pg(path)], completeness: "declared-complete", limits: [] });
const hunk = (removed: string, added: string) => `@@ -1,1 +1,1 @@\n-${removed}\n+${added}`;

const sources: Record<string, string> = {
    "server/pages.mjs": "export const PAGES = [\n  ['/', 'index.html'],\n  ...['cart', 'checkout'].map((n) => [`/${n}`, `${n}.html`, 'user']),\n  ['/orders/:id', 'order.html', 'user'],\n];\n",
    "public/order.html": '<html><body><h1>Order</h1><script type="module" src="/assets/order.js"></script></body></html>\n',
    "public/checkout.html": '<html><body><h1>Checkout</h1><script type="module" src="assets/checkout.js"></script></body></html>\n',
    "public/assets/order.js": "import { money } from '/assets/common.js';\nconst shipLabel = (m) => (m === 'express' ? 'Express ($12.99, 1 day)' : m || '');\n",
    "public/assets/common.js": "export const money = (n) => n.toFixed(2);\n",
    "server/test/web.test.mjs": "const pages = [['/cart', 'order.html']];\n",
    "scripts/gen-pages.mjs": "import { writeFileSync } from 'node:fs';\nconst OUT = new URL('../public', import.meta.url).pathname;\nwriteFileSync(OUT + '/checkout.html', '<h1>Checkout</h1>');\n",
    "tools/export-orders.mjs": "export function toCsv(orders) {\n    return orders.map((o) => [o.id, o.total].join(',')).join('\\n');\n}\n",
};
const tests = [web("w-order", "/orders/1001"), web("w-checkout", "/checkout"), web("w-cart", "/cart")];

describe("page code reaches the pages that load it", () => {
    it("a script loaded by a page in the server's page table reaches that page's tests", async () => {
        const impact = await analyzeImpact({ files: [{ path: "public/assets/order.js", patch: hunk("const shipLabel = 9.99;", "const shipLabel = 12.99;") }], sources, tests });
        expect(impact.unmapped).toEqual([]);
        expect(impact.endpoints.map((e) => e.route)).toEqual(["GET /orders/{} (server/pages.mjs:4)"]);
        expect(impact.endpoints[0]!.evidence).toEqual(["public/order.html loads /assets/order.js", "server/pages.mjs:4 serves public/order.html at /orders/:id"]);
        expect(impact.tests.map((t) => t.id)).toEqual(["w-order"]);
    });

    it("a script two loads away (imported by a page's script) reaches the same pages", async () => {
        const impact = await analyzeImpact({ files: [{ path: "public/assets/common.js", patch: hunk("a", "b") }], sources, tests });
        expect(impact.tests.map((t) => t.id)).toEqual(["w-order"]);
    });

    it("a page file the table builds by name maps to its own address only when a test opens a page there", async () => {
        const files = [{ path: "public/checkout.html", patch: hunk("<h1>Check out</h1>", "<h1>Checkout</h1>") }];
        const impact = await analyzeImpact({ files, sources, tests });
        expect(impact.endpoints.map((e) => e.route)).toEqual(["GET /checkout (public/checkout.html:1)"]);
        expect(impact.tests.map((t) => t.id)).toEqual(["w-checkout"]);
        const none = await analyzeImpact({ files, sources, tests: [] });
        expect(none.unmapped.map((u) => u.path)).toEqual(["public/checkout.html"]);
    });

    it("a script no page loads stays unmapped", async () => {
        const impact = await analyzeImpact({ files: [{ path: "public/assets/orphan.js", patch: hunk("a", "b") }], sources: { ...sources, "public/assets/orphan.js": "export const x = 1;\n" }, tests });
        expect(impact.unmapped.map((u) => u.path)).toEqual(["public/assets/orphan.js"]);
    });
});

describe("files that are not application code", () => {
    it("the repository's tests and a build script writing into the browser folder are set aside; a stand-alone tool stays unmapped", async () => {
        const files = [
            { path: "server/test/web.test.mjs", patch: hunk("a", "b") },
            { path: "scripts/gen-pages.mjs", patch: hunk("<h1>Check out</h1>", "<h1>Checkout</h1>") },
            { path: "tools/export-orders.mjs", patch: hunk("o.total]", "o.total, o.placedAt]") },
        ];
        const impact = await analyzeImpact({ files, sources, tests });
        expect(impact.notApp.map((n) => n.path)).toEqual(["server/test/web.test.mjs", "scripts/gen-pages.mjs"]);
        expect(impact.files.map((f) => f.path)).toEqual(["tools/export-orders.mjs"]);
        expect(impact.unmapped.map((u) => u.path)).toEqual(["tools/export-orders.mjs"]);
    });

    it("a test file does not serve pages: its address and file pairs are not page evidence", async () => {
        const impact = await analyzeImpact({ files: [{ path: "public/assets/order.js", patch: hunk("a", "b") }], sources, tests });
        expect(impact.endpoints.map((e) => e.route)).not.toContain("GET /cart (server/test/web.test.mjs:1)");
    });
});
