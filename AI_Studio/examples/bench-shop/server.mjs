// BenchShop: a small, dependency-free shop used to measure how well AI Studio finds bugs. Not part of the platform.
//   node examples/bench-shop/server.mjs <port>
// Environment:
//   BENCH_DEFECTS      which behaviours are switched (none | all | comma-separated names). Default none.
//   BENCH_RESET_TOKEN  enables POST /__bench/reset (header x-bench-reset must match); the route is 404 without it.
//   BENCH_LOGIN        html (default): sign-in and registration are plain HTML forms (POST, then a 303 to the next page);
//                      js: the same forms are sent by the page script to the JSON API instead.
//   BENCH_DATA_TOKEN   enables GET /__bench/schema and GET /__bench/data (header x-bench-data must match): the stored data as tables
//                      with keys, read-only, credentials and sessions left out. Without the variable or the header both routes are 404,
//                      a wrong header is 403 and any method but GET is 405.
// Data lives in memory and is reset on start. Loopback only.
import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 9460);
const SWITCHES = new Set(
    String(process.env.BENCH_DEFECTS ?? "none")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "none"),
);
const on = (id) => SWITCHES.has("all") || SWITCHES.has(id);
const RESET_TOKEN = process.env.BENCH_RESET_TOKEN ?? "";
const JS_LOGIN = process.env.BENCH_LOGIN === "js";
const DATA_TOKEN = process.env.BENCH_DATA_TOKEN ?? "";

const MAX_PER_ITEM = 10;
const MAX_ADDRESS = 200;
const FREE_SHIPPING_FROM = 5000;
const SHIPPING = 500;
const CODES = { SAVE10: 10 };

const PRODUCTS = [
    { id: "p1", name: "Trail Mug", price: 1250, description: "Enamel mug for the campsite. Holds 350 ml." },
    { id: "p2", name: "Desk Lamp", price: 3450, description: "Adjustable lamp with a warm LED." },
    { id: "p3", name: "Pocket Notebook", price: 425, description: "Dotted pages, 96 sheets." },
    { id: "p4", name: "Headphones", price: 5999, description: "Closed-back headphones with a soft headband." },
    { id: "p5", name: "Water Bottle", price: 1800, description: "Insulated steel bottle, 750 ml." },
];

let db;
function reset() {
    db = {
        users: [
            { id: "u1", email: "alice@example.test", password: "Password1!", name: "Alice Moreau", address: "12 Harbour Street, Leeds" },
            { id: "u2", email: "bob@example.test", password: "Password1!", name: "Bob Okafor", address: "4 Mill Lane, York" },
        ],
        sessions: new Map(),
        carts: new Map(),
        checkout: new Map(),
        orders: [
            { id: "ord-1000", userId: "u1", status: "shipped", lines: [{ productId: "p3", name: "Pocket Notebook", unitPrice: 425, quantity: 2, lineTotal: 850 }], subtotal: 850, discount: 0, shipping: SHIPPING, total: 1350, address: "12 Harbour Street, Leeds", placedAt: "2026-10-02T10:00:00.000Z" },
            { id: "ord-1001", userId: "u2", status: "placed", lines: [{ productId: "p2", name: "Desk Lamp", unitPrice: 3450, quantity: 1, lineTotal: 3450 }], subtotal: 3450, discount: 0, shipping: SHIPPING, total: 3950, address: "4 Mill Lane, York", placedAt: "2026-10-20T09:30:00.000Z" },
        ],
        /** Item rows whose cart row is gone (kept apart from the live carts). */
        strayItems: [],
        nextUser: 3,
        nextOrder: 1002,
        nextCart: 1,
        clock: Date.parse("2026-11-01T08:00:00.000Z"),
    };
}
reset();

// ── helpers ─────────────────────────────────────────────────────────────────
const money = (c) => `$${(c / 100).toFixed(2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
/**
 * Standard hardening on every response; the pages keep to it (no inline script, everything from this origin). Inline styles are allowed:
 * the test run itself injects one (screenshots), and a strict style-src would make every page-health check fail on it.
 */
const SECURITY = {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function sendJson(res, status, body, extra = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY, ...extra });
    res.end(JSON.stringify(body));
}
function redirect(res, to) {
    res.writeHead(303, { location: to, ...SECURITY });
    res.end();
}
function cookiesOf(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
function userOf(req) {
    const sid = cookiesOf(req).sid;
    const uid = sid ? db.sessions.get(sid) : undefined;
    return uid ? db.users.find((u) => u.id === uid) : undefined;
}
async function bodyOf(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) return {};
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if (String(req.headers["content-type"] ?? "").includes("application/json")) {
        try {
            const v = JSON.parse(raw);
            return v && typeof v === "object" ? v : {};
        } catch {
            return {};
        }
    }
    return Object.fromEntries(new URLSearchParams(raw));
}

const NAV = (user) =>
    `<header><a href="/" class="brand">BenchShop</a><nav aria-label="Main"><a href="/">Products</a> <a href="/cart">Cart</a>${
        user ? ` <a href="/orders">Orders</a> <a href="/account">Account</a> <form data-api="/api/logout" data-next="/login" class="inline"><button type="submit">Sign out</button></form>` : ` <a href="/login">Sign in</a> <a href="/register">Create account</a>`
    }</nav></header>`;

function page(res, title, user, body, status = 200) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY });
    res.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · BenchShop</title><link rel="stylesheet" href="/styles.css"></head><body>${NAV(user)}<main>${body}</main><script src="/app.js"></script></body></html>`,
    );
}

// ── cart and money ──────────────────────────────────────────────────────────
function cartOf(uid) {
    if (!db.carts.has(uid)) db.carts.set(uid, { id: `c${db.nextCart++}`, lines: [], code: null });
    return db.carts.get(uid);
}
function priced(cart) {
    const lines = cart.lines.map((l) => {
        const p = PRODUCTS.find((x) => x.id === l.productId);
        return { productId: l.productId, name: p.name, unitPrice: p.price, quantity: l.quantity, lineTotal: p.price * l.quantity };
    });
    let subtotal = 0;
    lines.forEach((l, i) => {
        subtotal += on("BS-02") && i === lines.length - 1 && lines.length > 1 ? l.unitPrice : l.lineTotal;
    });
    const pct = cart.code ? CODES[cart.code] : 0;
    const discountBase = on("BS-01") && lines.length ? lines[0].lineTotal : subtotal;
    const discount = pct ? Math.round((discountBase * pct) / 100) : 0;
    const afterDiscount = subtotal - discount;
    const free = on("BS-11") ? afterDiscount > FREE_SHIPPING_FROM : afterDiscount >= FREE_SHIPPING_FROM;
    const shipping = lines.length === 0 ? 0 : free ? 0 : SHIPPING;
    return { lines, subtotal, code: cart.code, discount, shipping, total: afterDiscount + shipping };
}
const orderView = (o) => ({ id: o.id, status: o.status, lines: o.lines, subtotal: o.subtotal, discount: o.discount, shipping: o.shipping, total: o.total, address: o.address, placedAt: o.placedAt });
const ordersOf = (uid) => {
    const mine = db.orders.filter((o) => o.userId === uid).sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1));
    return on("BS-12") && mine.length > 1 ? mine.slice(1) : mine;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function session(u) {
    const sid = randomBytes(16).toString("hex");
    db.sessions.set(sid, u.id);
    return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
}
/** Create an account and sign it in: { user, cookie } or { status, error }. Used by the API and the HTML form alike. */
function register(b) {
    const typed = String(b.email ?? "").trim();
    const email = on("BS-17") ? typed : typed.toLowerCase();
    const password = String(b.password ?? "");
    const name = String(b.name ?? "").trim();
    if (!name) return { status: 400, error: "Enter your name." };
    if (!email || (!on("BS-04") && !EMAIL.test(email))) return { status: 400, error: "Enter a valid email address." };
    if (password.length < 8) return { status: 400, error: "Use at least 8 characters for the password." };
    if (db.users.some((u) => u.email === email)) return { status: 409, error: "An account with this email already exists." };
    const u = { id: `u${db.nextUser++}`, email, password, name, address: "" };
    db.users.push(u);
    return { user: u, cookie: session(u) };
}
function signIn(b) {
    const u = db.users.find((x) => x.email.toLowerCase() === String(b.email ?? "").trim().toLowerCase() && x.password === String(b.password ?? ""));
    return u ? { user: u, cookie: session(u) } : { error: "Email or password is wrong." };
}
const safeNext = (next, fallback) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : fallback);

// ── API ─────────────────────────────────────────────────────────────────────
async function api(req, res, url, user) {
    const m = req.method;
    const p = url.pathname;
    const need = () => {
        if (!user) sendJson(res, 401, { error: "Sign in first." });
        return Boolean(user);
    };
    if (p === "/api/products" && m === "GET") return sendJson(res, 200, { products: PRODUCTS });
    let mm = p.match(/^\/api\/products\/([\w-]+)$/);
    if (mm && m === "GET") {
        const prod = PRODUCTS.find((x) => x.id === mm[1]);
        return prod ? sendJson(res, 200, prod) : sendJson(res, 404, { error: "Product not found." });
    }
    if (p === "/api/register" && m === "POST") {
        const r = register(await bodyOf(req));
        if (r.error) return sendJson(res, r.status, { error: r.error });
        return sendJson(res, 201, { id: r.user.id, email: r.user.email, name: r.user.name }, { "set-cookie": r.cookie });
    }
    if (p === "/api/login" && m === "POST") {
        const r = signIn(await bodyOf(req));
        if (r.error) return sendJson(res, 401, { error: r.error });
        return sendJson(res, 200, { id: r.user.id, email: r.user.email, name: r.user.name }, { "set-cookie": r.cookie });
    }
    if (p === "/api/logout" && m === "POST") {
        const sid = cookiesOf(req).sid;
        if (sid) db.sessions.delete(sid);
        return sendJson(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    }
    if (p === "/api/profile") {
        if (!need()) return;
        if (m === "GET") return sendJson(res, 200, { name: user.name, email: user.email, address: user.address, ...(on("BS-20") ? { password: user.password } : {}) });
        if (m === "PUT") {
            const b = await bodyOf(req);
            const name = String(b.name ?? "").trim();
            const address = String(b.address ?? "").trim();
            if (!name) return sendJson(res, 400, { error: "Enter your name." });
            if (address.length > MAX_ADDRESS) return on("BS-16") ? sendJson(res, 500, { error: "Something went wrong." }) : sendJson(res, 400, { error: `The address can have at most ${MAX_ADDRESS} characters.` });
            if (!on("BS-06")) {
                user.name = name;
                user.address = address;
            }
            return sendJson(res, 200, { name, email: user.email, address });
        }
    }
    if (p === "/api/cart" && m === "GET") {
        if (!need()) return;
        return sendJson(res, 200, priced(cartOf(user.id)));
    }
    if (p === "/api/cart/items" && m === "POST") {
        if (!need()) return;
        const b = await bodyOf(req);
        const prod = PRODUCTS.find((x) => x.id === String(b.productId ?? ""));
        const qty = Number(b.quantity ?? 1);
        if (!prod) return on("BS-09") ? sendJson(res, 200, priced(cartOf(user.id))) : sendJson(res, 404, { error: "Product not found." });
        if (!Number.isInteger(qty) || qty < 1) return sendJson(res, 400, { error: "Choose a quantity of at least 1." });
        const cart = cartOf(user.id);
        const line = cart.lines.find((l) => l.productId === prod.id);
        const next = (line?.quantity ?? 0) + qty;
        if (next > (on("BS-03") ? MAX_PER_ITEM + 1 : MAX_PER_ITEM)) return sendJson(res, 400, { error: `You can order up to ${MAX_PER_ITEM} of each item.` });
        if (line) line.quantity = next;
        else cart.lines.push({ productId: prod.id, quantity: qty });
        return sendJson(res, 201, priced(cart));
    }
    mm = p.match(/^\/api\/cart\/items\/([\w-]+)$/);
    if (mm) {
        if (!need()) return;
        const cart = cartOf(user.id);
        const line = cart.lines.find((l) => l.productId === mm[1]);
        if (!line) return sendJson(res, 404, { error: "That item is not in your cart." });
        if (m === "PATCH") {
            const b = await bodyOf(req);
            const qty = Number(b.quantity);
            if (!Number.isInteger(qty) || qty < 1) return sendJson(res, 400, { error: "Choose a quantity of at least 1." });
            if (qty > (on("BS-03") ? MAX_PER_ITEM + 1 : MAX_PER_ITEM)) return sendJson(res, 400, { error: `You can order up to ${MAX_PER_ITEM} of each item.` });
            line.quantity = qty;
            return sendJson(res, 200, priced(cart));
        }
        if (m === "DELETE") {
            cart.lines = cart.lines.filter((l) => l !== line);
            return sendJson(res, 200, priced(cart));
        }
    }
    if (p === "/api/cart/discount" && m === "POST") {
        if (!need()) return;
        const b = await bodyOf(req);
        const code = String(b.code ?? "").trim().toUpperCase();
        const cart = cartOf(user.id);
        if (on("BS-15")) cart.code = null;
        if (!CODES[code]) return sendJson(res, 400, { error: "That code is not valid." });
        cart.code = code;
        return sendJson(res, 200, priced(cart));
    }
    if (p === "/api/checkout/address" && m === "POST") {
        if (!need()) return;
        const b = await bodyOf(req);
        const address = String(b.address ?? "").trim();
        if (address.length < 5) return sendJson(res, 400, { error: "Enter a delivery address." });
        db.checkout.set(user.id, { address });
        return sendJson(res, 200, { address });
    }
    if (p === "/api/orders" && m === "GET") {
        if (!need()) return;
        return sendJson(res, 200, { orders: ordersOf(user.id).map(orderView) });
    }
    if (p === "/api/orders" && m === "POST") {
        if (!need()) return;
        const cart = cartOf(user.id);
        const sum = priced(cart);
        if (!sum.lines.length) return sendJson(res, 409, { error: "Your cart is empty." });
        const co = db.checkout.get(user.id);
        if (!co && !on("BS-10")) return sendJson(res, 409, { error: "Add a delivery address first." });
        db.clock += 60_000;
        const o = { id: `ord-${db.nextOrder++}`, userId: user.id, status: "placed", ...sum, address: co?.address ?? "", placedAt: new Date(db.clock).toISOString() };
        delete o.code;
        db.orders.push(o);
        if (on("BS-18")) {
            db.strayItems.push(...cart.lines.map((l) => ({ cartId: cart.id, productId: l.productId, quantity: l.quantity })));
            if (on("BS-07")) cart.id = `c${db.nextCart++}`;
        }
        if (!on("BS-07")) {
            db.carts.delete(user.id);
            db.checkout.delete(user.id);
        }
        return sendJson(res, 201, orderView(o));
    }
    mm = p.match(/^\/api\/orders\/([\w-]+)(?:\/(pay|cancel))?$/);
    if (mm) {
        if (!need()) return;
        const o = db.orders.find((x) => x.id === mm[1] && (x.userId === user.id || on("BS-08")));
        if (!o) return sendJson(res, 404, { error: "Order not found." });
        if (!mm[2] && m === "GET") return sendJson(res, 200, on("BS-19") ? { ...orderView(o), total: String(o.total) } : orderView(o));
        if (mm[2] === "pay" && m === "POST") {
            if (o.status !== "placed") return sendJson(res, 409, { error: "Only a placed order can be paid." });
            if (on("BS-14")) await new Promise((r) => setTimeout(r, 150));
            o.status = "paid";
            return sendJson(res, 200, orderView(o));
        }
        if (mm[2] === "cancel" && m === "POST") {
            if (o.status === "cancelled") return sendJson(res, 409, { error: "This order is already cancelled." });
            if (o.status === "shipped" && !on("BS-05")) return sendJson(res, 409, { error: "This order has shipped and can no longer be cancelled." });
            o.status = "cancelled";
            return sendJson(res, 200, orderView(o));
        }
    }
    return sendJson(res, 404, { error: "Not found." });
}

// ── pages ───────────────────────────────────────────────────────────────────
function loginPage(res, user, next, error = "", email = "", status = 200) {
    const form = JS_LOGIN ? `<form data-api="/api/login" data-next="${esc(next)}">` : `<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}">`;
    return page(res, "Sign in", user, `<h1>Sign in</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}${form}<label>Email <input name="email" type="email" autocomplete="username" value="${esc(email)}" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><p>New here? <a href="/register">Create an account</a>.</p>`, status);
}
function registerPage(res, user, error = "", values = {}, status = 200) {
    const form = JS_LOGIN ? `<form data-api="/api/register" data-next="/" novalidate>` : `<form method="post" action="/register" novalidate>`;
    return page(res, "Create account", user, `<h1>Create an account</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}${form}<label>Name <input name="name" autocomplete="name" value="${esc(values.name)}"></label><label>Email <input name="email" autocomplete="email" value="${esc(values.email)}"></label><label>Password <input name="password" type="password" autocomplete="new-password"></label><p class="hint">Use a valid email address and a password of at least 8 characters.</p><button type="submit">Create account</button></form>`, status);
}
/** The HTML sign-in and registration forms (BENCH_LOGIN=html): POST, then 303 to the next page with the session cookie, or the form again with the message. */
async function formPosts(req, res, url) {
    const b = await bodyOf(req);
    if (url.pathname === "/login") {
        const r = signIn(b);
        const next = safeNext(b.next, "/");
        if (r.error) return loginPage(res, undefined, next, r.error, String(b.email ?? ""), 400);
        res.writeHead(303, { location: next, "set-cookie": r.cookie, ...SECURITY });
        return res.end();
    }
    const r = register(b);
    if (r.error) return registerPage(res, undefined, r.error, { name: String(b.name ?? ""), email: String(b.email ?? "") }, 400);
    res.writeHead(303, { location: "/", "set-cookie": r.cookie, ...SECURITY });
    return res.end();
}

function cartTable(sum) {
    if (!sum.lines.length) return `<p>Your cart is empty. <a href="/">Browse products</a>.</p>`;
    const rows = sum.lines
        .map(
            (l) =>
                `<tr><td>${esc(l.name)}</td><td>${money(l.unitPrice)}</td><td><form data-api="/api/cart/items/${l.productId}" data-method="PATCH" class="inline"><label>Quantity <input name="quantity" type="number" value="${l.quantity}" data-number></label> <button type="submit">Update</button></form></td><td>${money(l.lineTotal)}</td><td><form data-api="/api/cart/items/${l.productId}" data-method="DELETE" class="inline"><button type="submit">Remove</button></form></td></tr>`,
        )
        .join("");
    return `<table><caption>Items in your cart</caption><thead><tr><th scope="col">Item</th><th scope="col">Price</th><th scope="col">Quantity</th><th scope="col">Line total</th><th scope="col"><span class="sr">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>
<dl class="sum"><dt>Subtotal</dt><dd data-testid="subtotal">${money(sum.subtotal)}</dd><dt>Discount${sum.code ? ` (${esc(sum.code)})` : ""}</dt><dd data-testid="discount">${sum.discount ? `−${money(sum.discount)}` : money(0)}</dd><dt>Shipping</dt><dd data-testid="shipping">${sum.shipping ? money(sum.shipping) : "Free"}</dd><dt>Total</dt><dd data-testid="total">${money(on("BS-13") ? sum.total + sum.discount : sum.total)}</dd></dl>`;
}

const ORDER_STATUS = { placed: "Placed", paid: "Paid", shipped: "Shipped", cancelled: "Cancelled" };

function pages(req, res, url, user) {
    const p = url.pathname;
    if (p === "/") {
        const cards = PRODUCTS.map((x) => `<li><a href="/products/${x.id}">${esc(x.name)}</a> <span>${money(x.price)}</span></li>`).join("");
        return page(res, "Products", user, `<h1>Products</h1><ul class="products">${cards}</ul><p>Free shipping on orders of ${money(FREE_SHIPPING_FROM)} or more.</p>`);
    }
    let mm = p.match(/^\/products\/([\w-]+)$/);
    if (mm) {
        const x = PRODUCTS.find((q) => q.id === mm[1]);
        if (!x) return page(res, "Not found", user, `<h1>Product not found</h1><p><a href="/">Back to products</a></p>`, 404);
        const add = user
            ? `<form data-api="/api/cart/items" data-next="/cart"><input type="hidden" name="productId" value="${x.id}"><label>Quantity <input name="quantity" type="number" value="1" data-number></label> <button type="submit">Add to cart</button></form>`
            : `<p><a href="/login?next=/products/${x.id}">Sign in</a> to buy.</p>`;
        return page(res, x.name, user, `<h1>${esc(x.name)}</h1><p class="price">${money(x.price)}</p><p>${esc(x.description)}</p><p>Up to ${MAX_PER_ITEM} per item.</p>${add}`);
    }
    if (p === "/login") return loginPage(res, user, safeNext(url.searchParams.get("next"), "/"));
    if (p === "/register") return registerPage(res, user);
    const toSignIn = () => redirect(res, `/login?next=${encodeURIComponent(p)}`);
    if (p === "/cart") {
        if (!user) return toSignIn();
        const sum = priced(cartOf(user.id));
        const discount = `<form data-api="/api/cart/discount"><label>Discount code <input name="code"></label> <button type="submit">Apply</button></form><p class="hint">Code SAVE10 takes 10% off your order subtotal. Free shipping on orders of ${money(FREE_SHIPPING_FROM)} or more after discount; otherwise ${money(SHIPPING)}.</p>`;
        return page(res, "Cart", user, `<h1>Your cart</h1>${cartTable(sum)}${sum.lines.length ? `${discount}<p><a href="/checkout" class="button">Check out</a></p>` : ""}`);
    }
    if (p === "/checkout") {
        if (!user) return toSignIn();
        const sum = priced(cartOf(user.id));
        if (!sum.lines.length) return page(res, "Checkout", user, `<h1>Checkout</h1><p>Your cart is empty.</p>`);
        const co = db.checkout.get(user.id);
        return page(res, "Checkout: address", user, `<h1>Checkout</h1><ol class="steps"><li aria-current="step">Delivery address</li><li>Review and pay</li></ol><form data-api="/api/checkout/address" data-next="/checkout/review"><label>Delivery address <textarea name="address" rows="3">${esc(co?.address ?? user.address)}</textarea></label><button type="submit">Continue</button></form>`);
    }
    if (p === "/checkout/review") {
        if (!user) return toSignIn();
        const sum = priced(cartOf(user.id));
        const co = db.checkout.get(user.id);
        if (!co && !on("BS-10")) return redirect(res, "/checkout");
        if (!sum.lines.length) return page(res, "Checkout", user, `<h1>Checkout</h1><p>Your cart is empty.</p>`);
        return page(res, "Checkout: review", user, `<h1>Review your order</h1><ol class="steps"><li>Delivery address</li><li aria-current="step">Review and pay</li></ol><p>Deliver to: <span data-testid="address">${esc(co?.address ?? "")}</span></p>${cartTable(sum)}<form data-api="/api/orders" data-next-from="id" data-next-prefix="/orders/"><button type="submit">Place order</button></form>`);
    }
    if (p === "/orders") {
        if (!user) return toSignIn();
        const list = ordersOf(user.id);
        const rows = list.map((o) => `<tr><td><a href="/orders/${o.id}">${o.id}</a></td><td>${o.placedAt.slice(0, 10)}</td><td>${ORDER_STATUS[o.status]}</td><td>${money(o.total)}</td></tr>`).join("");
        return page(res, "Orders", user, `<h1>Your orders</h1>${list.length ? `<table><caption>Newest first</caption><thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Total</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No orders yet.</p>"}`);
    }
    mm = p.match(/^\/orders\/([\w-]+)$/);
    if (mm) {
        if (!user) return toSignIn();
        const o = db.orders.find((x) => x.id === mm[1] && (x.userId === user.id || on("BS-08")));
        if (!o) return page(res, "Order not found", user, `<h1>Order not found</h1><p><a href="/orders">Your orders</a></p>`, 404);
        const lines = o.lines.map((l) => `<li>${esc(l.name)} × ${l.quantity}: ${money(l.lineTotal)}</li>`).join("");
        const actions = [
            o.status === "placed" ? `<form data-api="/api/orders/${o.id}/pay" class="inline"><button type="submit">Pay now</button></form>` : "",
            o.status !== "cancelled" ? `<form data-api="/api/orders/${o.id}/cancel" class="inline"><button type="submit">Cancel order</button></form>` : "",
        ].join(" ");
        return page(res, `Order ${o.id}`, user, `<h1>Order ${o.id}</h1><p>Status: <strong data-testid="status">${ORDER_STATUS[o.status]}</strong></p><ul>${lines}</ul><p>Total: ${money(o.total)}</p><p>Deliver to: ${esc(o.address)}</p><p class="hint">You can cancel an order until it ships.</p><p>${actions}</p>`);
    }
    if (p === "/account") {
        if (!user) return toSignIn();
        return page(res, "Account", user, `<h1>Your account</h1><p>Signed in as ${esc(user.email)}</p><form data-api="/api/profile" data-method="PUT" data-success="Saved."><label>Name <input name="name" value="${esc(user.name)}"></label><label>Default delivery address <textarea name="address" rows="3">${esc(user.address)}</textarea></label><button type="submit">Save</button></form>`);
    }
    return page(res, "Not found", user, `<h1>Page not found</h1><p><a href="/">Back to products</a></p>`, 404);
}

const APP_JS = `document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-api]");
  if (!f) return;
  e.preventDefault();
  const data = {};
  for (const [k, v] of new FormData(f)) data[k] = f.querySelector('[name="' + k + '"]')?.hasAttribute("data-number") ? Number(v) : v;
  let out = f.querySelector("[data-out]");
  if (!out) { out = document.createElement("p"); out.setAttribute("data-out", ""); out.setAttribute("role", "status"); f.appendChild(out); }
  out.textContent = "";
  const res = await fetch(f.dataset.api, { method: f.dataset.method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok${on("BS-16") ? " && !(res.status >= 500 && f.dataset.success)" : ""}) { out.setAttribute("role", "alert"); out.textContent = body.error || "Something went wrong."; return; }
  if (f.dataset.success) { out.setAttribute("role", "status"); out.textContent = f.dataset.success; return; }
  if (f.dataset.nextFrom) { location.href = f.dataset.nextPrefix + body[f.dataset.nextFrom]; return; }
  if (f.dataset.next) { location.href = f.dataset.next; return; }
  location.reload();
});`;

const STYLES = `body{font-family:system-ui,sans-serif;margin:0;color:#222;background:#fafafa}header{display:flex;gap:1rem;align-items:center;padding:.75rem 1rem;background:#fff;border-bottom:1px solid #ddd}
nav a,nav form{margin-right:.75rem}main{max-width:52rem;margin:1rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}.inline{display:inline}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left}.sum{display:grid;grid-template-columns:auto auto;gap:.25rem 1rem;max-width:20rem}.sr{position:absolute;left:-9999px}.hint{color:#555}
[role=alert]{color:#a00}.button{display:inline-block;padding:.4rem .8rem;background:#245;color:#fff;text-decoration:none}`;

const OPENAPI = {
    openapi: "3.0.3",
    info: { title: "BenchShop API", version: "1.0.0" },
    paths: {
        "/api/products": { get: { summary: "List products", responses: { 200: { description: "Products", content: { "application/json": { schema: { $ref: "#/components/schemas/ProductList" } } } } } } },
        "/api/products/{id}": { get: { summary: "One product", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "The product", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } }, 404: { description: "No such product", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/register": { post: { summary: "Create an account (valid email, password of at least 8 characters)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["name", "email", "password"], properties: { name: { type: "string", minLength: 1 }, email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } } } } } }, responses: { 201: { description: "Created and signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } } }, 400: { description: "Invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, 409: { description: "Email already used (whatever the letter case)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/login": { post: { summary: "Sign in", responses: { 200: { description: "Signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } } }, 401: { description: "Wrong email or password", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/logout": { post: { summary: "Sign out", responses: { 200: { description: "Signed out", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } } } } },
        "/api/profile": {
            get: { summary: "Your profile (never includes the password)", responses: { 200: { description: "Profile", content: { "application/json": { schema: { $ref: "#/components/schemas/Profile" } } } }, 401: { description: "Not signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } },
            put: { summary: "Change name and default address", requestBody: { content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, address: { type: "string", maxLength: 200 } } } } } }, responses: { 200: { description: "Saved", content: { "application/json": { schema: { $ref: "#/components/schemas/Profile" } } } }, 400: { description: "Invalid input", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } },
        },
        "/api/cart": { get: { summary: "Your cart with subtotal, discount, shipping and total (cents)", responses: { 200: { description: "Cart", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } }, 401: { description: "Not signed in", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/cart/items": { post: { summary: "Add a product (quantity 1-10 per item)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["productId"], properties: { productId: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 10 } } } } } }, responses: { 201: { description: "Added", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } }, 400: { description: "Invalid quantity", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, 404: { description: "No such product", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/cart/items/{productId}": { patch: { summary: "Change a quantity (1-10)", responses: { 200: { description: "Changed", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } }, 400: { description: "Invalid quantity", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }, 404: { description: "Not in cart", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } }, delete: { summary: "Remove an item", responses: { 200: { description: "Removed", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } }, 404: { description: "Not in cart", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/cart/discount": { post: { summary: "Apply a discount code (SAVE10: 10% of the subtotal); a refused code leaves the cart as it was", responses: { 200: { description: "Applied", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } }, 400: { description: "Invalid code", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/checkout/address": { post: { summary: "Set the delivery address (step 1 of checkout)", responses: { 200: { description: "Saved for this checkout", content: { "application/json": { schema: { $ref: "#/components/schemas/Address" } } } }, 400: { description: "Missing address", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/orders": { get: { summary: "Your orders, newest first", responses: { 200: { description: "Orders", content: { "application/json": { schema: { $ref: "#/components/schemas/OrderList" } } } } } }, post: { summary: "Place an order from the cart (needs a delivery address; empties the cart)", responses: { 201: { description: "Order placed", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 409: { description: "Cart empty or no address", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/orders/{id}": { get: { summary: "One of your orders", responses: { 200: { description: "Order", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 404: { description: "Not found or not yours", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/orders/{id}/pay": { post: { summary: "Pay a placed order (once)", responses: { 200: { description: "Paid", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 409: { description: "Not payable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
        "/api/orders/{id}/cancel": { post: { summary: "Cancel an order that has not shipped", responses: { 200: { description: "Cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, 409: { description: "Shipped or already cancelled", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } } },
    },
    components: {
        schemas: {
            Error: { type: "object", required: ["error"], properties: { error: { type: "string", minLength: 1 } } },
            Ok: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
            Product: { type: "object", required: ["id", "name", "price", "description"], properties: { id: { type: "string" }, name: { type: "string" }, price: { type: "integer", minimum: 0 }, description: { type: "string" } } },
            ProductList: { type: "object", required: ["products"], properties: { products: { type: "array", items: { $ref: "#/components/schemas/Product" } } } },
            Account: { type: "object", required: ["id", "email", "name"], properties: { id: { type: "string" }, email: { type: "string", format: "email" }, name: { type: "string" } } },
            Profile: { type: "object", required: ["name", "email", "address"], properties: { name: { type: "string" }, email: { type: "string", format: "email" }, address: { type: "string", maxLength: 200 } } },
            Line: { type: "object", required: ["productId", "name", "unitPrice", "quantity", "lineTotal"], properties: { productId: { type: "string" }, name: { type: "string" }, unitPrice: { type: "integer", minimum: 0 }, quantity: { type: "integer", minimum: 1, maximum: 10 }, lineTotal: { type: "integer", minimum: 0 } } },
            Cart: { type: "object", required: ["lines", "subtotal", "code", "discount", "shipping", "total"], properties: { lines: { type: "array", items: { $ref: "#/components/schemas/Line" } }, subtotal: { type: "integer", minimum: 0 }, code: { type: "string", nullable: true }, discount: { type: "integer", minimum: 0 }, shipping: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 0 } } },
            Address: { type: "object", required: ["address"], properties: { address: { type: "string", minLength: 5 } } },
            Order: { type: "object", required: ["id", "status", "lines", "subtotal", "discount", "shipping", "total", "address", "placedAt"], properties: { id: { type: "string", pattern: "^ord-\\d{4}$" }, status: { type: "string", enum: ["placed", "paid", "shipped", "cancelled"] }, lines: { type: "array", items: { $ref: "#/components/schemas/Line" } }, subtotal: { type: "integer", minimum: 0 }, discount: { type: "integer", minimum: 0 }, shipping: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 0 }, address: { type: "string" }, placedAt: { type: "string", format: "date-time" } } },
            OrderList: { type: "object", required: ["orders"], properties: { orders: { type: "array", items: { $ref: "#/components/schemas/Order" } } } },
        },
    },
};

/** The stored data as tables with keys (GET /__bench/schema, GET /__bench/data): read-only views, credentials and sessions left out. */
const fk = (columns, table, keys) => ({ columns, references: { table, columns: keys } });
const TABLES = {
    users: { columns: ["id", "email", "name", "address"], primaryKey: ["id"], uniqueKeys: [{ columns: ["email"], ignoreCase: true }], foreignKeys: [], rows: () => db.users.map(({ id, email, name, address }) => ({ id, email, name, address })) },
    products: { columns: ["id", "name", "price"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rows: () => PRODUCTS.map(({ id, name, price }) => ({ id, name, price })) },
    carts: { columns: ["id", "userId", "code"], primaryKey: ["id"], uniqueKeys: [{ columns: ["userId"] }], foreignKeys: [fk(["userId"], "users", ["id"])], rows: () => [...db.carts].map(([userId, c]) => ({ id: c.id, userId, code: c.code })) },
    cart_items: { columns: ["cartId", "productId", "quantity"], primaryKey: ["cartId", "productId"], uniqueKeys: [], foreignKeys: [fk(["cartId"], "carts", ["id"]), fk(["productId"], "products", ["id"])], rows: () => [...[...db.carts.values()].flatMap((c) => c.lines.map((l) => ({ cartId: c.id, productId: l.productId, quantity: l.quantity }))), ...db.strayItems] },
    checkouts: { columns: ["userId", "address"], primaryKey: ["userId"], uniqueKeys: [], foreignKeys: [fk(["userId"], "users", ["id"])], rows: () => [...db.checkout].map(([userId, c]) => ({ userId, address: c.address })) },
    orders: { columns: ["id", "userId", "status", "subtotal", "discount", "shipping", "total", "address", "placedAt"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [fk(["userId"], "users", ["id"])], rows: () => db.orders.map(({ id, userId, status, subtotal, discount, shipping, total, address, placedAt }) => ({ id, userId, status, subtotal, discount, shipping, total, address, placedAt })) },
    order_lines: { columns: ["orderId", "productId", "name", "unitPrice", "quantity", "lineTotal"], primaryKey: ["orderId", "productId"], uniqueKeys: [], foreignKeys: [fk(["orderId"], "orders", ["id"]), fk(["productId"], "products", ["id"])], rows: () => db.orders.flatMap((o) => o.lines.map((l) => ({ orderId: o.id, productId: l.productId, name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, lineTotal: l.lineTotal }))) },
};
/** 404 without the variable or the header (like an unknown path), 403 with a wrong token, 405 for anything but GET. */
function benchData(req, res, pathname) {
    const given = req.headers["x-bench-data"];
    if (!DATA_TOKEN || given === undefined) return sendJson(res, 404, { error: "Not found." });
    if (given !== DATA_TOKEN) return sendJson(res, 403, { error: "Forbidden." });
    if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed." }, { allow: "GET" });
    const tables = Object.entries(TABLES).map(([name, t]) => ({ name, t, rows: t.rows() }));
    if (pathname === "/__bench/data") return sendJson(res, 200, { tables: Object.fromEntries(tables.map((x) => [x.name, x.rows])) });
    return sendJson(res, 200, { tables: tables.map(({ name, t, rows }) => ({ name, columns: t.columns, primaryKey: t.primaryKey, uniqueKeys: t.uniqueKeys, foreignKeys: t.foreignKeys, rowCount: rows.length })) });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
        if (url.pathname === "/__bench/reset") {
            if (!RESET_TOKEN) return sendJson(res, 404, { error: "Not found." });
            if (req.method !== "POST" || req.headers["x-bench-reset"] !== RESET_TOKEN) return sendJson(res, 403, { error: "Forbidden." });
            reset();
            return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === "/__bench/data" || url.pathname === "/__bench/schema") return benchData(req, res, url.pathname);
        if (url.pathname === "/app.js") {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", ...SECURITY });
            return res.end(APP_JS);
        }
        if (url.pathname === "/styles.css") {
            res.writeHead(200, { "content-type": "text/css; charset=utf-8", ...SECURITY });
            return res.end(STYLES);
        }
        if (url.pathname === "/openapi.json") return sendJson(res, 200, OPENAPI);
        const user = userOf(req);
        if (url.pathname.startsWith("/api/")) return await api(req, res, url, user);
        if (req.method === "POST" && !JS_LOGIN && (url.pathname === "/login" || url.pathname === "/register")) return await formPosts(req, res, url);
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
        return pages(req, res, url, user);
    } catch {
        if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
        else res.end();
    }
});
server.listen(PORT, "127.0.0.1");
