/**
 * A small shop for the plain-English tests (ports 5610 and 5611):
 *   /            home with a link to the products
 *   /products    two products with "Add <name> to cart" buttons; the cart shows "Items in cart: N" and "Total: $X.XX"
 *   /login       Email + Password -> /account ("Welcome, Demo")    account: demo@example.test / Plain-Pass-1
 *   /api/products, /api/products/:id     GET only answers; POST /api/products exists (and counts, so tests can prove nothing was sent)
 *   /openapi.json    describes those three operations
 * `log` records every request (method, path, host) so tests can see what a job really sent.
 */
import http from "node:http";

export const PLAIN_USER = { email: "demo@example.test", password: "Plain-Pass-1" };
export const PRODUCTS = [
    { id: 1, name: "Blue Mug", price: 12 },
    { id: 2, name: "Red Plate", price: 8.5 },
];

export interface PlainSite {
    server: http.Server;
    log: Array<{ method: string; path: string; host: string }>;
    close(): Promise<void>;
}

const page = (body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plain Shop</title></head>
<body><main>${body}</main><script>${script}</script></body></html>`;

const CART_SCRIPT = `
const prices = { "Blue Mug": 12, "Red Plate": 8.5 };
let count = 0, total = 0;
for (const b of document.querySelectorAll("button[data-product]")) {
  b.addEventListener("click", () => {
    count += 1; total += prices[b.dataset.product];
    document.getElementById("count").textContent = "Items in cart: " + count;
    document.getElementById("total").textContent = "Total: $" + total.toFixed(2);
  });
}`;

const OPENAPI = {
    openapi: "3.0.0",
    info: { title: "Plain Shop API", version: "1.0.0" },
    paths: {
        "/api/products": {
            get: { summary: "List the products", responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" } }, required: ["id", "name", "price"] } } } } } } },
            post: { summary: "Add a product", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } }, responses: { "201": { description: "created" } } },
        },
        "/api/products/{id}": {
            get: {
                summary: "Get one product",
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" }, example: 1 }],
                responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" } }, required: ["id", "name", "price"] } } } }, "404": { description: "not found" } },
            },
        },
    },
};

export function startPlainSite(port: number): Promise<PlainSite> {
    const log: PlainSite["log"] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;
        log.push({ method: req.method ?? "GET", path, host: String(req.headers.host ?? "") });
        const html = (body: string, script = "", code = 200, headers: Record<string, string> = {}) => {
            res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
            res.end(page(body, script));
        };
        const json = (obj: unknown, code = 200) => {
            res.writeHead(code, { "content-type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        const authed = (req.headers.cookie ?? "").includes("session=ok");

        if (path === "/openapi.json") return json(OPENAPI);
        if (path === "/api/products" && req.method === "GET") return json(PRODUCTS);
        if (path === "/api/products" && req.method === "POST") return json({ id: 99 }, 201);
        const one = /^\/api\/products\/(\d+)$/.exec(path);
        if (one && req.method === "GET") {
            const p = PRODUCTS.find((x) => x.id === Number(one[1]));
            return p ? json(p) : json({ error: "not found" }, 404);
        }
        if (path === "/") return html(`<h1>Plain Shop</h1><nav aria-label="Main"><a href="/products">Products</a> <a href="/login">Log in</a></nav>`);
        if (path === "/products") {
            return html(
                `<h1>Products</h1><nav aria-label="Main"><a href="/">Home</a></nav>
<ul>${PRODUCTS.map((p) => `<li><span>${p.name}</span> <span>$${p.price.toFixed(2)}</span> <button type="button" data-product="${p.name}">Add ${p.name} to cart</button></li>`).join("")}</ul>
<section aria-label="Cart"><h2>Cart</h2><p id="count">Items in cart: 0</p><p id="total" role="status">Total: $0.00</p></section>`,
                CART_SCRIPT,
            );
        }
        if (path === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                const f = new URLSearchParams(body);
                if (f.get("email") === PLAIN_USER.email && f.get("password") === PLAIN_USER.password) {
                    res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
                    return void res.end();
                }
                html(`<h1>Sign in</h1><p role="alert">Invalid email or password</p>`, "", 401);
            });
            return;
        }
        if (path === "/login") {
            return html(`<h1>Sign in</h1><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Log in</button></form>`);
        }
        if (path === "/account") {
            if (!authed) {
                res.writeHead(302, { location: "/login" });
                return void res.end();
            }
            return html(`<h1>Welcome, Demo</h1><p>You are signed in.</p>`);
        }
        html(`<h1>Not found</h1>`, "", 404);
    });
    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () =>
            resolve({
                server,
                log,
                close: () =>
                    new Promise<void>((r) => {
                        server.closeAllConnections?.();
                        server.close(() => r());
                    }),
            }),
        );
    });
}
