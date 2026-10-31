// DocsDemo: a tiny dependency-free site that documents its own test cases (/test_cases) and API
// (/api_list), the way some practice sites do. Used by tests/docs-scrape.test.ts.
//   node examples/docs-app/server.mjs [port]      (default 5095)
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5095);
const BASE = `http://127.0.0.1:${PORT}`;

const PRODUCTS = [
    { id: 1, name: "Blue Top", price: 500 },
    { id: 2, name: "Men Tshirt", price: 400 },
];

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · DocsDemo</title></head>
<body><header><nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> <a href="/docs">Docs</a>
<a href="/test_cases">Practice: tests</a> <a href="/api_list">Practice: APIs</a></nav></header>
<main>${body}</main></body></html>`;

const pages = {
    "/": layout("Home", "<h1>DocsDemo</h1><p>A small shop for practising automation.</p>"),
    "/about": layout("About", "<h1>About us</h1><p>We sell clothes online and ship worldwide.</p>"),
    // Linked from the nav and matches a doc path pattern, but is ordinary marketing copy:
    // the keyword gate must keep it away from the LLM.
    "/docs": layout("Docs", "<h1>Getting started</h1><p>Create an account, browse products and check out in minutes.</p>"),
    "/test_cases": layout(
        "Test Cases",
        `<h1>Test Cases</h1>
<section><h2>Test Case 1: Register User</h2><ol><li>Launch browser</li><li>Click on 'Signup / Login' button</li><li>Verify 'New User Signup!' is visible</li></ol></section>
<section><h2>Test Case 2: Login User with correct email and password</h2><ol><li>Open the login page</li><li>Enter correct email and password</li><li>Verify 'Logged in as username' is visible</li></ol></section>
<section><h2>Test Case 3: Search Product</h2><ol><li>Open Products</li><li>Search for 'top'</li><li>Verify searched products are visible</li></ol></section>`,
    ),
    "/api_list": layout(
        "APIs List",
        `<h1>APIs List for practice</h1>
<section><h2>API 1: Get All Products List</h2><p>API URL: ${BASE}/api/productsList</p><p>Request Method: GET</p><p>Response Code: 200</p></section>
<section><h2>API 2: Get Product By Id</h2><p>API URL: ${BASE}/api/products/{id}</p><p>Request Method: GET</p><p>Response Code: 200 (404 if the product does not exist)</p></section>
<section><h2>API 3: Search Product</h2><p>API URL: ${BASE}/api/searchProduct</p><p>Request Method: POST</p><p>Request Parameter: search_product</p><p>Response Code: 200</p></section>`,
    ),
};

const send = (res, code, body, type = "text/html; charset=utf-8") => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
};

http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    const page = pages[url.pathname];
    if (page) return send(res, 200, page);
    if (url.pathname === "/api/productsList") return send(res, 200, JSON.stringify({ responseCode: 200, products: PRODUCTS }), "application/json");
    const m = url.pathname.match(/^\/api\/products\/(\d+)$/);
    if (m) {
        const p = PRODUCTS.find((x) => x.id === Number(m[1]));
        return send(res, p ? 200 : 404, JSON.stringify(p ?? { message: "Product not found" }), "application/json");
    }
    send(res, 404, layout("Not found", "<h1>404 - Page not found</h1>"));
}).listen(PORT, "127.0.0.1", () => console.log(`DocsDemo listening on ${BASE}`));
