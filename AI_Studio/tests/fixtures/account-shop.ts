/**
 * A small shop that keeps each account's cart on its server (row 229): what the clean-account replays (src/engine/explore/clean-account.ts)
 * are about. The shared test account alice already holds lines earlier tests left. A new account starts with an empty cart.
 *   /login, /register (name, email, password, confirm password), /cart (lines, "Add Mug" / "Add Plate" links, the Total), /add?item=,
 *   /orders (alice's ord-1008, an order an earlier test placed).
 * Seeded defect: a cart with two or more lines adds $5.00 to its Total (Mug $10.00 + Plate $15.00 shows $30.00, not $25.00).
 * Knobs (`shop.mode`): `terms` adds a required terms checkbox to sign-up, `company` a required "Company" field, `verify` makes a new account
 * wait for an e-mailed link (it cannot sign in). `shop.locked` shows alice's cart locked by an open checkout (no Add links).
 */
import http from "node:http";

export interface AccountShop {
    url: string;
    close(): Promise<void>;
    /** Accounts created through /register since the last reset. */
    registered: string[];
    /** Who signed in, in order (emails). */
    signIns: string[];
    mode: "plain" | "terms" | "company" | "verify";
    locked: boolean;
    /** alice's cart (item names) as earlier tests left it. */
    reset(aliceCart: string[]): void;
}

export const ALICE = { username: "alice@example.com", password: "Alice-Password-229" };
const PRICES: Record<string, number> = { Mug: 1000, Plate: 1500 };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><nav><a href="/">Home</a> <a href="/cart">Cart</a> <a href="/orders">Orders</a></nav><main>${body}</main></body></html>`;

export async function startAccountShop(port: number): Promise<AccountShop> {
    const users = new Map<string, { password: string; cart: Set<string>; pending: boolean; orders: string[] }>();
    const sessions = new Map<string, string>();
    let next = 0;
    const shop: AccountShop = {
        url: `http://127.0.0.1:${port}`,
        registered: [],
        signIns: [],
        mode: "plain",
        locked: false,
        reset(aliceCart) {
            users.clear();
            sessions.clear();
            users.set(ALICE.username, { password: ALICE.password, cart: new Set(aliceCart), pending: false, orders: ["ord-1008"] });
            shop.registered.length = 0;
            shop.signIns.length = 0;
            shop.mode = "plain";
            shop.locked = false;
        },
        close: () => new Promise((r) => server.close(() => r())),
    };
    shop.reset([]);
    const body = (req: http.IncomingMessage) => new Promise<URLSearchParams>((r) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => r(new URLSearchParams(b)));
    });
    const send = (res: http.ServerResponse, html: string, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
        res.end(html);
    };
    const go = (res: http.ServerResponse, to: string, headers: Record<string, string> = {}) => {
        res.writeHead(303, { location: to, ...headers });
        res.end();
    };
    const signIn = (email: string) => {
        const sid = `s${++next}`;
        sessions.set(sid, email);
        shop.signIns.push(email);
        return { "set-cookie": `sid=${sid}; Path=/; HttpOnly` };
    };
    const loginForm = (error = "") =>
        page("Sign in", `<h1>Sign in</h1>${error ? `<p role="alert">${error}</p>` : ""}<form method="post" action="/login"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form><p><a href="/register">Create an account</a></p>`);
    const registerForm = (error = "") =>
        page(
            "Create account",
            `<h1>Create an account</h1>${error ? `<p role="alert">${error}</p>` : ""}<form method="post" action="/register"><label>Name <input name="name" autocomplete="name"></label><label>Email <input name="email" autocomplete="email"></label>${shop.mode === "company" ? `<label>Company <input name="company" required></label>` : ""}<label>Password <input type="password" name="password" autocomplete="new-password"></label><label>Confirm password <input type="password" name="confirm"></label>${shop.mode === "terms" ? `<label><input type="checkbox" name="terms" required> I accept the terms</label>` : ""}<button type="submit">Create account</button></form>`,
        );
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", shop.url);
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        const who = sid ? sessions.get(sid) : undefined;
        const user = who ? users.get(who) : undefined;
        if (url.pathname === "/login" && req.method === "POST") {
            const b = await body(req);
            const email = (b.get("email") ?? "").trim().toLowerCase();
            const u = users.get(email);
            if (!u || u.pending || u.password !== b.get("password")) return send(res, loginForm("Email or password is wrong."), 400);
            return go(res, "/cart", signIn(email));
        }
        if (url.pathname === "/login") return send(res, loginForm());
        if (url.pathname === "/register" && req.method === "POST") {
            const b = await body(req);
            const email = (b.get("email") ?? "").trim().toLowerCase();
            const password = b.get("password") ?? "";
            if (!b.get("name") || !/^[^@\s]+@[^@\s]+\.[a-z]+$/.test(email) || password.length < 8 || password !== b.get("confirm")) return send(res, registerForm("Check the fields."), 400);
            if (shop.mode === "company" && !b.get("company")) return send(res, registerForm("Enter your company."), 400);
            if (shop.mode === "terms" && !b.get("terms")) return send(res, registerForm("Accept the terms."), 400);
            if (users.has(email)) return send(res, registerForm("That email is taken."), 409);
            users.set(email, { password, cart: new Set(), pending: shop.mode === "verify", orders: [] });
            shop.registered.push(email);
            if (shop.mode === "verify") return go(res, "/register/pending");
            return go(res, "/", signIn(email));
        }
        if (url.pathname === "/register/pending") return send(res, page("Check your email", `<h1>Check your email</h1><p>Open the link we sent to finish creating your account.</p>`));
        if (url.pathname === "/register") return send(res, registerForm());
        if (!user) {
            if (url.pathname === "/") return send(res, page("Shop", `<h1>Shop</h1><p><a href="/login">Sign in</a> <a href="/register">Create account</a></p>`));
            return go(res, "/login");
        }
        const locked = shop.locked && who === ALICE.username;
        if (url.pathname === "/add") {
            const item = url.searchParams.get("item") ?? "";
            if (PRICES[item] && !locked) user.cart.add(item);
            return go(res, "/cart");
        }
        if (url.pathname === "/cart") {
            const lines = [...user.cart];
            const sum = lines.reduce((s, i) => s + PRICES[i]!, 0) + (lines.length >= 2 ? 500 : 0);
            const adds = locked ? `<p>Your cart is locked by an open checkout.</p>` : Object.keys(PRICES).map((i) => `<a href="/add?item=${i}">Add ${i}</a>`).join(" ");
            return send(res, page("Cart", `<h1>Cart</h1><ul>${lines.map((i) => `<li>${i} ${money(PRICES[i]!)}</li>`).join("")}</ul><p>${adds}</p><p>Total: <output aria-label="Total">${money(sum)}</output></p><p>Signed in. <a href="/logout">Sign out</a></p>`));
        }
        if (url.pathname === "/orders") return send(res, page("Orders", `<h1>Your orders</h1><ul>${user.orders.map((o) => `<li><a href="/orders/${o}">${o}</a></li>`).join("")}</ul>`));
        const order = /^\/orders\/([\w-]+)$/.exec(url.pathname)?.[1];
        if (order && user.orders.includes(order)) return send(res, page(`Order ${order}`, `<h1>Order ${order}</h1>`));
        if (url.pathname === "/") return send(res, page("Shop", `<h1>Shop</h1><p>Signed in. <a href="/cart">Your cart</a> <a href="/logout">Sign out</a></p>`));
        return send(res, page("Not found", `<h1>Not found</h1>`), 404);
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    return shop;
}
