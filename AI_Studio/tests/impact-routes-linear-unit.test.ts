/**
 * The impact analysis reads every source file of a pull request's head commit inside the server process (code-host/pr-impact.ts), so a
 * file's contents must not be able to stall it: the time grows with the file's size, never faster. A `const { pathname } = …` still
 * makes `pathname` a path expression for the route conditions.
 */
import { describe, expect, it } from "vitest";
import { analyzeImpact } from "../src/engine/impact/analyze.js";
import { routesOf } from "../src/engine/impact/routes.js";

describe("impact routes: a source file cannot stall the server", () => {
    it("analyses a pull request adding a 34 KB file of unclosed destructurings in well under a second", async () => {
        const src = "const { pathname ".repeat(2000);
        const t = Date.now();
        await analyzeImpact({ files: [{ path: "server.js", status: "added", patch: `@@ -0,0 +1,1 @@\n+${src}` }], sources: { "server.js": src } });
        expect(Date.now() - t).toBeLessThan(1000);
    }, 120_000);

    it("still takes `pathname` from a destructuring for the route conditions", () => {
        const src = [
            "export function handle(req, res) {",
            "  const { pathname, search } = new URL(req.url, 'http://x');",
            "  if (pathname === '/orders' && req.method === 'POST') {",
            "    res.end('ok');",
            "  }",
            "}",
        ].join("\n");
        expect(routesOf("server.js", src).map((r) => `${r.method} ${r.path}`)).toContain("POST /orders");
    });
});
