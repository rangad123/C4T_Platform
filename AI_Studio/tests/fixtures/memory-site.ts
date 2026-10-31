/**
 * A small site that CHANGES between two analyses (the site-memory tests flip `version` from 1 to 2):
 *   v1 pages: /  /products  /about  /login  /account          API calls: GET /api/items, GET /api/legacy
 *   v2 pages: /  /products* /news   /login  /account          API calls: GET /api/items
 *   (* /products gets a new heading; /about is gone and /news is new; /api/legacy is no longer called)
 * Every page carries recognisable text (SENTINEL-*) so tests can prove none of it reaches the stored memory, and the
 * account page shows the signed-in user's name for the same reason.
 * Account: shopper@example.test / Sentinel-Pass-9921
 */
import http from "node:http";

export const MEMORY_SITE_USER = { email: "shopper@example.test", password: "Sentinel-Pass-9921" };
export const MEMORY_SITE_TEXT = { page: "SENTINEL-PAGE-TEXT-7731", link: "SENTINEL-LINK-TEXT-5512", placeholder: "SENTINEL-PLACEHOLDER-4408" };

export interface MemorySite {
    server: http.Server;
    setVersion(v: 1 | 2): void;
}

const layout = (body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Memory Shop</title></head>
<body><main>${body}<p>${MEMORY_SITE_TEXT.page}</p></main><script>${script}</script></body></html>`;

export function startMemorySite(port: number): Promise<MemorySite> {
    let version: 1 | 2 = 1;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const html = (body: string, script = "", code = 200) => {
            res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
            res.end(layout(body, script));
        };
        const json = (obj: unknown) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        const authed = (req.headers.cookie ?? "").includes("session=ok");
        const path = url.pathname;

        if (path === "/api/items") return json([{ id: 1, name: "Backpack" }]);
        if (path === "/api/legacy" && version === 1) return json({ legacy: true });
        if (path === "/") {
            const links = version === 1 ? `<a href="/products">Products</a> <a href="/about">About</a>` : `<a href="/products">Products</a> <a href="/news">News</a>`;
            return html(`<h1>Shop</h1><nav aria-label="Main">${links} <a href="/login">Log in</a> <a href="/products">${MEMORY_SITE_TEXT.link}</a></nav>`, version === 1 ? `fetch("/api/legacy")` : "");
        }
        if (path === "/products") {
            const heading = version === 1 ? "Products" : "All products";
            return html(`<h1>${heading}</h1><a href="/">Home</a>`, `fetch("/api/items")`);
        }
        if (path === "/about" && version === 1) return html(`<h1>About us</h1><a href="/">Home</a>`);
        if (path === "/news" && version === 2) return html(`<h1>News</h1><a href="/">Home</a>`);
        if (path === "/login" && req.method === "POST") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                const p = new URLSearchParams(body);
                if (p.get("email") === MEMORY_SITE_USER.email && p.get("password") === MEMORY_SITE_USER.password) {
                    res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
                    return void res.end();
                }
                html(`<h1>Sign in</h1><p role="alert">Invalid email or password</p>`, "", 401);
            });
            return;
        }
        if (path === "/login") {
            return html(`<h1>Sign in</h1><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" placeholder="${MEMORY_SITE_TEXT.placeholder}"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Log in</button></form>`);
        }
        if (path === "/account") {
            if (!authed) {
                res.writeHead(302, { location: "/login" });
                return void res.end();
            }
            return html(`<h1>Your account</h1><p>Signed in as ${MEMORY_SITE_USER.email}</p><a href="/">Home</a>`);
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, setVersion: (v) => void (version = v) })));
}
