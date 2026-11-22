/**
 * From changed lines to HTTP routes, on evidence only (src/engine/impact/routes.ts). Pure: sources are read from examples/ or written here.
 *
 * The truth for the two bench apps was written by reading examples/bench-shop/server.mjs and examples/bench-rbac/server.mjs by hand:
 * for each seeded defect (`on("BS-…")`, `on("BR-…")`) the route whose handler holds it, or, for a seed inside a helper function, the
 * routes whose handlers call that helper. Decoys: names that look like routes but register none must reach nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandPathRegex, nextRoutePath, routesForChange, routesOf, routeTemplate, type RouteEntry } from "../src/engine/impact/routes.js";

const read = (app: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "examples", app, "server.mjs"), "utf8");
const SHOP = read("bench-shop");
const RBAC = read("bench-rbac");
const key = (r: RouteEntry) => `${r.method} ${r.path}`;
/** The lines of each `on("ID")`, in file order. */
const seedLines = (src: string, id: string) => src.split("\n").flatMap((l, i) => (l.includes(`on("${id}")`) ? [i + 1] : []));
const reach = (src: string, line: number) => routesForChange({ "server.mjs": src }, "server.mjs", [line]);
const reached = (src: string, line: number) => reach(src, line).hits.map((h) => key(h.route)).sort();

describe("path regular expressions", () => {
    it("turns the bench's path patterns into the routes they allow, with what each group holds", () => {
        expect(expandPathRegex(String.raw`/^\/api\/notes\/([\w-]+)$/`)).toEqual([{ text: "/api/notes/{}", groups: { 1: "{}" } }]);
        expect(expandPathRegex(String.raw`/^\/api\/orders\/([\w-]+)(?:\/(pay|cancel))?$/`)).toEqual([
            { text: "/api/orders/{}/pay", groups: { 1: "{}", 2: "pay" } },
            { text: "/api/orders/{}/cancel", groups: { 1: "{}", 2: "cancel" } },
            { text: "/api/orders/{}", groups: { 1: "{}" } },
        ]);
        expect(expandPathRegex(String.raw`/^\/api\/notes\/([\w-]+)\/share(?:\/([\w-]+))?$/`)!.map((v) => v.text)).toEqual(["/api/notes/{}/share/{}", "/api/notes/{}/share"]);
        expect(expandPathRegex(String.raw`/^\/files\/(\d+)\.json\/?$/i`)!.map((v) => v.text)).toEqual(["/files/{}.json/", "/files/{}.json"]);
    });

    it("gives up on what it cannot read exactly, rather than guess", () => {
        expect(expandPathRegex(String.raw`/\/api\/notes/`)).toBeUndefined(); // not anchored: matches anywhere
        expect(expandPathRegex(String.raw`/^\/api\/(?=x)/`)).toBeUndefined();
        expect(expandPathRegex(String.raw`/^\/a{2}$/`)).toBeUndefined();
        expect(expandPathRegex(String.raw`/^(\/x)+$/`)).toBeUndefined();
    });

    it("writes paths the way test footprints do", () => {
        expect(routeTemplate("/orders/:id/")).toBe("/orders/{}");
        expect(routeTemplate("/files/*")).toBe("/files/{}");
        expect(routeTemplate("/a/{slug}")).toBe("/a/{}");
        expect(routeTemplate("/")).toBe("/");
        expect(nextRoutePath("web/app/(shop)/api/orders/[id]/route.ts")).toBe("/api/orders/{}");
        expect(nextRoutePath("app/route.ts")).toBe("/");
        expect(nextRoutePath("app/api/files/[...path]/route.js")).toBe("/api/files/{}");
        expect(nextRoutePath("src/routes/orders.ts")).toBeUndefined();
    });
});

describe("the bench apps: every seed reaches its route", () => {
    it("bench-shop: a seed inside a handler reaches exactly that route", () => {
        const exact: Array<[string, number, string[]]> = [
            ["BS-06", 0, ["PUT /api/profile"]],
            ["BS-09", 0, ["POST /api/cart/items"]],
            ["BS-03", 0, ["POST /api/cart/items"]],
            ["BS-03", 1, ["PATCH /api/cart/items/{}"]],
            ["BS-10", 0, ["POST /api/orders"]],
            ["BS-07", 0, ["POST /api/orders"]],
            ["BS-08", 0, ["* /api/orders/{}", "* /api/orders/{}/cancel", "* /api/orders/{}/pay"]],
            ["BS-05", 0, ["POST /api/orders/{}/cancel"]],
            ["BS-10", 1, ["* /checkout/review"]],
            ["BS-08", 1, ["* /orders/{}"]],
        ];
        for (const [id, nth, routes] of exact) {
            const line = seedLines(SHOP, id)[nth]!;
            expect(reached(SHOP, line), `${id} at line ${line}`).toEqual(routes);
            expect(reach(SHOP, line).hits.every((h) => h.evidence.join(" ").includes(`server.mjs:${line} is inside the handler of`))).toBe(true);
        }
    });

    it("bench-shop: a seed in a helper reaches the routes that call the helper, and says how", () => {
        const via: Array<[string, string, string[]]> = [
            ["BS-01", "priced", ["POST /api/cart/discount", "GET /api/cart"]],
            ["BS-02", "priced", ["GET /api/cart"]],
            ["BS-11", "priced", ["GET /api/cart", "POST /api/orders", "POST /api/cart/items", "PATCH /api/cart/items/{}", "DELETE /api/cart/items/{}"]],
            ["BS-12", "ordersOf", ["GET /api/orders", "* /orders"]],
            ["BS-04", "register", ["POST /api/register", "POST /register"]],
        ];
        for (const [id, helper, routes] of via) {
            const line = seedLines(SHOP, id)[0]!;
            const r = reach(SHOP, line);
            expect(r.hits.map((h) => key(h.route)), id).toEqual(expect.arrayContaining(routes));
            for (const h of r.hits) {
                expect(h.evidence[0], id).toMatch(new RegExp(`^server\\.mjs:${line} is in ${helper}\\(\\)`));
                expect(h.evidence.at(-1), id).toMatch(/is used at server\.mjs:\d+, inside the handler of /);
            }
        }
        // the helper is not used by routes that do not call it
        expect(reached(SHOP, seedLines(SHOP, "BS-12")[0]!)).not.toContain("GET /api/cart");
        expect(reached(SHOP, seedLines(SHOP, "BS-01")[0]!)).not.toContain("GET /api/orders");
    });

    it("bench-rbac: every seed reaches its route", () => {
        const exact: Array<[string, string[]]> = [
            ["BR-08", ["POST /api/notes"]],
            ["BR-06", ["DELETE /api/notes/{}/share/{}"]],
            ["BR-03", ["GET /api/admin/users"]],
            ["BR-04", ["PATCH /api/admin/users/{}"]],
        ];
        for (const [id, routes] of exact) expect(reached(RBAC, seedLines(RBAC, id)[0]!), id).toEqual(routes);
        const via: Array<[string, string[]]> = [
            ["BR-01", ["* /api/notes/{}", "* /api/notes/{}/share", "* /api/notes/{}/share/{}", "* /notes/{}"]],
            ["BR-02", ["PUT /api/notes/{}"]],
            ["BR-07", ["POST /api/register", "POST /register"]],
        ];
        for (const [id, routes] of via) expect(reached(RBAC, seedLines(RBAC, id)[0]!), id).toEqual(expect.arrayContaining(routes));
        expect(reached(RBAC, seedLines(RBAC, "BR-02")[0]!)).not.toContain("DELETE /api/notes/{}");
    });

    it("bench-rbac BR-05: the session check runs before any route, and is reported as such, not tied to a guessed route", () => {
        const line = seedLines(RBAC, "BR-05")[0]!;
        const r = reach(RBAC, line);
        expect(r.hits).toEqual([]);
        const use = RBAC.split("\n").findIndex((l) => l.includes("const user = userOf(req);")) + 1;
        const from = RBAC.split("\n").findIndex((l) => l.startsWith("function userOf(")) + 1;
        expect(r.unresolved).toEqual([`server.mjs:${line} is in userOf() (server.mjs:${from}-${from + 5}); userOf is used at server.mjs:${use}, outside every route handler.`]);
    });

    it("finds the bench's whole route table, the static files and the HTML form posts included", () => {
        const routes = routesOf("server.mjs", SHOP).map(key);
        for (const r of ["* /__bench/reset", "* /app.js", "* /openapi.json", "GET /api/products", "GET /api/products/{}", "POST /api/login", "POST /api/logout", "GET /api/profile", "POST /api/checkout/address", "GET /api/orders/{}", "POST /api/orders/{}/pay", "POST /login", "POST /register", "* /login", "* /", "* /products/{}", "* /account"]) expect(routes, r).toContain(r);
        // a prefix check dispatches; it is not a route
        expect(routes.some((r) => r.endsWith(" /api/") || r.endsWith(" /api"))).toBe(false);
    });
});

describe("frameworks", () => {
    it("Express and Koa-style routers: the call is the handler; a referenced handler function counts as used", () => {
        const src = [
            'import express from "express";',
            "const orders = express.Router();",
            "function listOrders(req, res) {",
            "    res.json(load());",
            "}",
            'orders.get("/orders", auth, listOrders);',
            'app.post("/orders/:id/pay", async (req, res) => {',
            "    await pay(req.params.id);",
            "});",
            'router.del("/orders/:id", (ctx) => {});',
            'client.get("/orders");',
            "// app.get('/commented', x);",
            'const s = "app.get(\'/in-a-string\', x)";',
        ].join("\n");
        expect(routesOf("routes.js", src).map((r) => [key(r), r.start, r.end])).toEqual([
            ["GET /orders", 6, 6],
            ["POST /orders/{}/pay", 7, 9],
            ["DELETE /orders/{}", 10, 10],
        ]);
        expect(routesForChange({ "routes.js": src }, "routes.js", [4]).hits.map((h) => key(h.route))).toEqual(["GET /orders"]);
        expect(routesForChange({ "routes.js": src }, "routes.js", [8]).hits.map((h) => key(h.route))).toEqual(["POST /orders/{}/pay"]);
    });

    it("Fastify, as calls and as route objects", () => {
        const src = 'fastify.route({\n    method: ["GET", "HEAD"],\n    url: "/items/:id",\n    handler: async () => ({}),\n});\nfastify.route({ method: "DELETE", url: "/items/:id", handler });\napp.get("/api/projects/:id/sentry", async (req) => {\n    return 1;\n});';
        expect(routesOf("server.ts", src).map((r) => [key(r), r.start, r.end])).toEqual([
            ["GET /api/projects/{}/sentry", 7, 9],
            ["GET /items/{}", 1, 5],
            ["HEAD /items/{}", 1, 5],
            ["DELETE /items/{}", 6, 6],
        ]);
    });

    it("Next.js route files: each exported method, the path from the folders", () => {
        const src = 'import { NextResponse } from "next/server";\nexport async function GET(req: Request) {\n    return NextResponse.json(await list());\n}\nexport const POST = async (req: Request) => {\n    return NextResponse.json({});\n};\nfunction helper() {}\n';
        expect(routesOf("web/app/api/orders/[id]/route.ts", src).map((r) => [key(r), r.start, r.end])).toEqual([
            ["GET /api/orders/{}", 2, 4],
            ["POST /api/orders/{}", 5, 7],
        ]);
        // the same code in a file that is not a route file registers nothing
        expect(routesOf("web/lib/orders/route-helpers.ts", src)).toEqual([]);
    });

    it("follows a function into the files that import it by name, through other functions", () => {
        const sources = {
            "src/lib/money.ts": "export function discount(total: number) {\n    return total * 0.9;\n}\nexport function unused() {\n    return 0;\n}\n",
            "src/services/cart.ts": 'import { discount as off } from "../lib/money.js";\nexport function priceCart(lines: number[]) {\n    return off(lines.reduce((a, b) => a + b, 0));\n}\n',
            "src/routes/cart.ts": 'import { priceCart } from "../services/cart.js";\nexport function register(app) {\n    app.get("/api/cart", async () => priceCart([1, 2]));\n}\n',
        };
        const r = routesForChange(sources, "src/lib/money.ts", [2]);
        expect(r.hits.map((h) => key(h.route))).toEqual(["GET /api/cart"]);
        expect(r.hits[0]!.evidence).toEqual([
            "src/lib/money.ts:2 is in discount() (src/lib/money.ts:1-3)",
            "discount is used at src/services/cart.ts:3, in priceCart() (src/services/cart.ts:2-4)",
            "priceCart is used at src/routes/cart.ts:3, inside the handler of GET /api/cart (src/routes/cart.ts:3)",
        ]);
        expect(routesForChange(sources, "src/lib/money.ts", [5])).toEqual({ hits: [], unresolved: ["src/lib/money.ts:5 is in unused() (src/lib/money.ts:4-6); unused is not used in any file given."] });
    });
});

describe("evidence only: names that look like routes reach nothing", () => {
    it("a file named like a route that registers none maps to nothing", () => {
        const decoy = "export const cartRoute = (x) => x + 1;\nexport function getApiCart() {\n    return '/api/cart';\n}\n";
        expect(routesOf("src/routes/cart-route.ts", decoy)).toEqual([]);
        expect(routesForChange({ "src/routes/cart-route.ts": decoy }, "src/routes/cart-route.ts", [1, 3]).hits).toEqual([]);
    });

    it("a function whose name resembles a route's is not linked to it; a same-named function elsewhere is not either", () => {
        const sources = {
            "server.js": 'function priced(c) {\n    return c;\n}\napp.get("/api/cart", (req, res) => res.json(priced(req.cart)));\n',
            // same name, other file, not imported by server.js
            "lib/other.js": "export function priced(x) {\n    return x * 2;\n}\nexport function apiCart() {\n    return 1;\n}\n",
        };
        expect(routesForChange(sources, "lib/other.js", [2]).hits).toEqual([]);
        expect(routesForChange(sources, "lib/other.js", [5]).hits).toEqual([]);
        expect(routesForChange(sources, "server.js", [2]).hits.map((h) => key(h.route))).toEqual(["GET /api/cart"]);
    });

    it("a change in a file that is not JavaScript or TypeScript is reported, not mapped", () => {
        expect(routesForChange({ "app.py": "def x():\n    pass\n" }, "app.py", [2])).toEqual({ hits: [], unresolved: ["app.py: not a JavaScript or TypeScript file given here, so its routes are not known."] });
    });
});
