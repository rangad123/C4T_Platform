// DemoShop: a tiny dependency-free web app + JSON API used as a safe, local target for the
// platform's end-to-end run. Not part of the platform itself.
//   node examples/sample-app/server.mjs [port]      (default 5055)
// Demo account: demo@example.com / Password123!
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5055);
const USER = { email: "demo@example.com", password: "Password123!", name: "Demo User" };
const TOKEN = "demo-token-123";
// OAuth2 client-credentials demo: POST /oauth/token with HTTP Basic demo-client:demo-secret.
const OAUTH_CLIENT = { id: "demo-client", secret: "demo-secret" };
const OAUTH_TOKEN = "oauth-token-456";
const PRODUCTS = [
    { id: 1, name: "Trail Backpack", price: 89.0, category: "bags" },
    { id: 2, name: "Insulated Bottle", price: 24.5, category: "outdoor" },
    { id: 3, name: "Merino Socks", price: 18.0, category: "apparel" },
    { id: 4, name: "Headlamp Pro", price: 45.0, category: "outdoor" },
];

const layout = (title, body, authed = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · DemoShop</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:0}header{background:#1f2937;color:#fff;padding:12px 24px;display:flex;gap:20px;align-items:center}
header a{color:#fff;text-decoration:none}main{padding:24px;max-width:760px}input,button{padding:8px;margin:4px 0}label{display:block;margin-top:8px}
.error{color:#b91c1c}.card{border:1px solid #ddd;padding:12px;margin:8px 0;border-radius:6px}</style></head>
<body><header><strong>DemoShop</strong>
<nav aria-label="Main" style="display:flex;gap:16px">
<a href="/">Home</a><a href="/products">Products</a><a href="/cart" id="cart-link">Cart (<span id="cart-count">0</span>)</a>
${authed ? '<a href="/account">My account</a>' : '<a href="/login">Login</a>'}</nav></header>
<main>${body}</main>
<script>const c=JSON.parse(localStorage.getItem('cart')||'[]');document.getElementById('cart-count').textContent=c.length;</script>
</body></html>`;

const isAuthed = (req) => (req.headers.cookie ?? "").includes("session=ok");
const send = (res, code, body, type = "text/html; charset=utf-8", headers = {}) => {
    res.writeHead(code, { "content-type": type, ...headers });
    res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");
const readBody = (req) =>
    new Promise((resolve) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => resolve(b));
    });

const OPENAPI = {
    openapi: "3.0.3",
    info: { title: "DemoShop API", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${PORT}` }],
    paths: {
        "/api/products": {
            get: {
                summary: "List products",
                tags: ["Products"],
                parameters: [{ name: "q", in: "query", required: false, schema: { type: "string" } }],
                responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Product" } } } } } },
            },
        },
        "/api/products/{id}": {
            get: {
                summary: "Get a product",
                tags: ["Products"],
                parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } }],
                responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } }, 404: { description: "not found" } },
            },
        },
        "/api/login": {
            post: {
                summary: "Log in",
                tags: ["Auth"],
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Login" } } } },
                responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } } } } }, 401: { description: "bad credentials" } },
            },
        },
        "/api/me": {
            get: {
                summary: "Current user",
                tags: ["Auth"],
                security: [{ bearerAuth: [] }],
                responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string" }, name: { type: "string" } } } } } }, 401: { description: "unauthenticated" } },
            },
        },
    },
    components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        schemas: {
            Product: { type: "object", required: ["id", "name", "price"], properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" }, category: { type: "string" } } },
            Login: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } },
        },
    },
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const authed = isAuthed(req);

    if (p === "/openapi.json") return json(res, 200, OPENAPI);

    if (p === "/api/products") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        return json(res, 200, PRODUCTS.filter((x) => x.name.toLowerCase().includes(q)));
    }
    const m = /^\/api\/products\/(.+)$/.exec(p);
    if (m) {
        const prod = PRODUCTS.find((x) => String(x.id) === m[1]);
        return prod ? json(res, 200, prod) : json(res, 404, { error: "Not found" });
    }
    if (p === "/api/login" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "Invalid JSON" }); }
        if (typeof body.email !== "string" || typeof body.password !== "string") return json(res, 400, { error: "email and password are required" });
        return body.email === USER.email && body.password === USER.password ? json(res, 200, { token: TOKEN }) : json(res, 401, { error: "Invalid credentials" });
    }
    if (p === "/oauth/token" && req.method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        const basic = (req.headers.authorization ?? "").replace(/^Basic\s+/i, "");
        const [id, secret] = Buffer.from(basic, "base64").toString("utf8").split(":");
        const clientOk = (id === OAUTH_CLIENT.id && secret === OAUTH_CLIENT.secret) || (params.get("client_id") === OAUTH_CLIENT.id && params.get("client_secret") === OAUTH_CLIENT.secret);
        if (params.get("grant_type") !== "client_credentials") return json(res, 400, { error: "unsupported_grant_type" });
        if (!clientOk) return json(res, 401, { error: "invalid_client" });
        return json(res, 200, { access_token: OAUTH_TOKEN, token_type: "Bearer", expires_in: 3600 });
    }
    if (p === "/api/me") {
        return req.headers.authorization === `Bearer ${TOKEN}` || req.headers.authorization === `Bearer ${OAUTH_TOKEN}` ? json(res, 200, { email: USER.email, name: USER.name }) : json(res, 401, { error: "Unauthorized" });
    }

    if (p === "/") {
        return send(res, 200, layout("Home", `<h1>Welcome to DemoShop</h1><p>Quality outdoor gear for every trip.</p><a href="/products">Browse products</a>`, authed));
    }
    if (p === "/products") {
        const q = url.searchParams.get("q") ?? "";
        const list = PRODUCTS.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
        const rows = list.map((x) => `<div class="card"><a href="/products/${x.id}">${x.name}</a> — $${x.price.toFixed(2)}</div>`).join("") || `<p>No products found</p>`;
        return send(
            res, 200,
            layout("Products", `<h1>Products</h1><form method="get" action="/products" role="search"><label for="q">Search products</label><input id="q" name="q" value="${q.replace(/"/g, "&quot;")}"><button type="submit">Search</button></form><p id="count">${list.length} products</p>${rows}
<script>fetch('/api/products${q ? "?q=" + encodeURIComponent(q) : ""}').catch(()=>{})</script>`, authed),
        );
    }
    const pd = /^\/products\/(\d+)$/.exec(p);
    if (pd) {
        const prod = PRODUCTS.find((x) => x.id === Number(pd[1]));
        if (!prod) return send(res, 404, layout("Not found", "<h1>Product not found</h1>", authed));
        return send(
            res, 200,
            layout(prod.name, `<h1>${prod.name}</h1><p>Price: $${prod.price.toFixed(2)}</p><button id="add">Add to cart</button><p id="msg" role="status"></p>
<script>fetch('/api/products/${prod.id}').catch(()=>{});document.getElementById('add').onclick=()=>{const c=JSON.parse(localStorage.getItem('cart')||'[]');c.push(${JSON.stringify(prod)});localStorage.setItem('cart',JSON.stringify(c));document.getElementById('cart-count').textContent=c.length;document.getElementById('msg').textContent='Added to cart';}</script>`, authed),
        );
    }
    if (p === "/cart") {
        return send(
            res, 200,
            layout("Cart", `<h1>Your cart</h1><div id="items"></div><p id="total"></p>
<script>const c=JSON.parse(localStorage.getItem('cart')||'[]');const el=document.getElementById('items');
if(!c.length){el.innerHTML='<p>Your cart is empty</p>'}else{el.innerHTML=c.map((x,i)=>'<div class="card">'+x.name+' — $'+x.price.toFixed(2)+' <button data-i="'+i+'">Remove</button></div>').join('');
document.getElementById('total').textContent='Total: $'+c.reduce((s,x)=>s+x.price,0).toFixed(2);
el.onclick=e=>{if(e.target.dataset.i!==undefined){c.splice(Number(e.target.dataset.i),1);localStorage.setItem('cart',JSON.stringify(c));location.reload();}}}</script>`, authed),
        );
    }
    if (p === "/login" && req.method === "GET") {
        return send(res, 200, layout("Login", `<h1>Login</h1><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" required><label for="password">Password</label><input id="password" name="password" type="password" required><button type="submit">Log in</button></form>`, authed));
    }
    if (p === "/login" && req.method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        if (params.get("email") === USER.email && params.get("password") === USER.password) {
            return send(res, 302, "", "text/plain", { location: "/account", "set-cookie": "session=ok; Path=/; HttpOnly" });
        }
        return send(res, 401, layout("Login", `<h1>Login</h1><p class="error" role="alert">Invalid email or password</p><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" required><label for="password">Password</label><input id="password" name="password" type="password" required><button type="submit">Log in</button></form>`));
    }
    if (p === "/account") {
        if (!authed) return send(res, 302, "", "text/plain", { location: "/login" });
        return send(res, 200, layout("Account", `<h1>Welcome, ${USER.name}</h1><form method="post" action="/logout"><button type="submit">Log out</button></form>`, true));
    }
    if (p === "/logout" && req.method === "POST") {
        return send(res, 302, "", "text/plain", { location: "/", "set-cookie": "session=; Path=/; Max-Age=0" });
    }
    return send(res, 404, layout("Not found", "<h1>Page not found</h1>", authed));
});

server.listen(PORT, "127.0.0.1", () => console.log(`DemoShop listening on http://127.0.0.1:${PORT}`));
