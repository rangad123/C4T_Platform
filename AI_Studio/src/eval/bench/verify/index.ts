/**
 * Independent verifiers for the seeded defects in src/eval/bench/catalogue.json. Each one starts from a freshly reset application and
 * answers whether the defective behaviour is present (true) or the correct behaviour is seen (false), using plain HTTP only. They never
 * look at how the application is built: only at what it answers, exactly as the catalogue's reproduction steps describe.
 */
import { BENCH_DATA_TEST_TOKEN } from "./app.js";
import { BenchClient, obj } from "./http.js";

export type Verifier = (base: string) => Promise<boolean>;

const cart = async (c: BenchClient) => obj((await c.call("GET", "/api/cart")).body);
const lines = (cartBody: Record<string, unknown>) => (Array.isArray(cartBody.lines) ? (cartBody.lines as Array<Record<string, unknown>>) : []);
const sumOfLines = (cartBody: Record<string, unknown>) => lines(cartBody).reduce((s, l) => s + Number(l.lineTotal), 0);

async function shopper(base: string, email = "alice@example.test"): Promise<BenchClient> {
    const c = new BenchClient(base);
    await c.signIn(email);
    return c;
}

async function placeOrder(c: BenchClient, productId = "p3", address = "1 Test Road, Leeds"): Promise<Record<string, unknown>> {
    await c.call("POST", "/api/cart/items", { productId, quantity: 1 });
    await c.call("POST", "/api/checkout/address", { address });
    const r = await c.call("POST", "/api/orders");
    if (r.status !== 201) throw new Error(`placing an order failed: ${r.status}`);
    return obj(r.body);
}

/** The stored rows (GET /__bench/data, the apps' read-only data route) of one table. */
async function rows(base: string, table: string): Promise<Array<Record<string, unknown>>> {
    const r = await fetch(`${base}/__bench/data`, { headers: { "x-bench-data": BENCH_DATA_TEST_TOKEN } });
    if (r.status !== 200) throw new Error(`reading the stored data failed: ${r.status}`);
    const t = obj(obj(await r.json()).tables)[table];
    return Array.isArray(t) ? (t as Array<Record<string, unknown>>) : [];
}
/** Rows of `child` whose `fk` value is no `key` of any `parent` row. */
async function orphans(base: string, child: string, fk: string, parent: string, key = "id"): Promise<number> {
    const keys = new Set((await rows(base, parent)).map((r) => r[key]));
    return (await rows(base, child)).filter((r) => !keys.has(r[fk])).length;
}
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const VERIFIERS: Record<string, Verifier> = {
    "BS-01": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
        await c.call("POST", "/api/cart/items", { productId: "p5", quantity: 1 });
        const body = obj((await c.call("POST", "/api/cart/discount", { code: "SAVE10" })).body);
        return Number(body.discount) !== Math.round(sumOfLines(body) * 0.1);
    },
    "BS-02": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
        await c.call("POST", "/api/cart/items", { productId: "p1", quantity: 3 });
        const body = await cart(c);
        return Number(body.subtotal) !== sumOfLines(body);
    },
    "BS-03": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
        const r = await c.call("PATCH", "/api/cart/items/p3", { quantity: 11 });
        return r.status === 200;
    },
    "BS-04": async (base) => {
        const c = new BenchClient(base);
        const r = await c.call("POST", "/api/register", { name: "Test Person", email: "not-an-email", password: "Password1!" });
        return r.status === 201;
    },
    "BS-05": async (base) => {
        const c = await shopper(base);
        const r = await c.call("POST", "/api/orders/ord-1000/cancel");
        return r.status === 200 && obj(r.body).status === "cancelled";
    },
    "BS-06": async (base) => {
        const c = await shopper(base);
        const put = await c.call("PUT", "/api/profile", { name: "Alice Moreau", address: "99 New Street, Hull" });
        if (put.status !== 200) return false;
        const after = obj((await c.call("GET", "/api/profile")).body);
        return after.address !== "99 New Street, Hull";
    },
    "BS-07": async (base) => {
        const c = await shopper(base);
        await placeOrder(c);
        const again = await c.call("POST", "/api/orders");
        return again.status === 201;
    },
    "BS-08": async (base) => {
        const c = await shopper(base, "alice@example.test");
        const r = await c.call("GET", "/api/orders/ord-1001");
        return r.status === 200;
    },
    "BS-09": async (base) => {
        const c = await shopper(base);
        const r = await c.call("POST", "/api/cart/items", { productId: "no-such-product", quantity: 1 });
        return r.status !== 404;
    },
    "BS-10": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
        const r = await c.call("POST", "/api/orders");
        return r.status === 201;
    },
    "BS-11": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p1", quantity: 4 });
        const body = await cart(c);
        return Number(body.subtotal) - Number(body.discount) >= 5000 && Number(body.shipping) !== 0;
    },
    "BS-12": async (base) => {
        const c = await shopper(base);
        const placed = await placeOrder(c);
        const list = obj((await c.call("GET", "/api/orders")).body);
        const ids = Array.isArray(list.orders) ? (list.orders as Array<Record<string, unknown>>).map((o) => o.id) : [];
        return !ids.includes(placed.id);
    },
    // Extension seeds (catalogue-extension.json, 2026-11-21.1).
    "BS-13": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p2", quantity: 1 });
        const body = obj((await c.call("POST", "/api/cart/discount", { code: "SAVE10" })).body);
        const shown = /data-testid="total">([^<]*)</.exec((await c.call("GET", "/cart")).text)?.[1];
        return shown !== money(Number(body.total));
    },
    "BS-14": async (base) => {
        const c = await shopper(base);
        const order = await placeOrder(c);
        const both = await Promise.all([c.call("POST", `/api/orders/${String(order.id)}/pay`), c.call("POST", `/api/orders/${String(order.id)}/pay`)]);
        return both.every((r) => r.status === 200);
    },
    "BS-15": async (base) => {
        const c = await shopper(base);
        await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
        await c.call("POST", "/api/cart/discount", { code: "SAVE10" });
        const refused = await c.call("POST", "/api/cart/discount", { code: "NOT-A-CODE" });
        return refused.status === 400 && (await cart(c)).code !== "SAVE10";
    },
    "BS-16": async (base) => {
        const c = await shopper(base);
        const r = await c.call("PUT", "/api/profile", { name: "Alice Moreau", address: "x".repeat(201) });
        return r.status !== 400;
    },
    "BS-17": async (base) => {
        const r = await new BenchClient(base).call("POST", "/api/register", { name: "Alice Again", email: "ALICE@example.test", password: "Password1!" });
        return r.status === 201;
    },
    "BS-18": async (base) => {
        await placeOrder(await shopper(base));
        return (await orphans(base, "cart_items", "cartId", "carts")) > 0;
    },
    "BS-19": async (base) => {
        const c = await shopper(base);
        return typeof obj((await c.call("GET", "/api/orders/ord-1000")).body).total !== "number";
    },
    "BS-20": async (base) => {
        const c = await shopper(base);
        return Object.keys(obj((await c.call("GET", "/api/profile")).body)).some((k) => /password|secret|token/i.test(k));
    },
    "BR-09": async (base) => {
        const c = new BenchClient(base);
        for (let i = 0; i < 5; i++) await c.call("POST", "/api/login", { email: "ana@example.test", password: "wrong-password" });
        return (await c.call("POST", "/api/login", { email: "ana@example.test", password: "Password1!" })).status === 200;
    },
    "BR-10": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        const n = obj((await c.call("POST", "/api/notes", { title: "<b>Marked</b> title", body: "" })).body);
        return (await c.call("GET", `/notes/${String(n.id)}`)).text.includes("<b>Marked</b>");
    },
    "BR-11": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ben@example.test");
        if ((await c.call("DELETE", "/api/notes/n3")).status !== 200) return false;
        return (await orphans(base, "note_shares", "noteId", "notes")) > 0;
    },
    "BR-01": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        return (await c.call("GET", "/api/notes/n2")).status === 200;
    },
    "BR-02": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        const r = await c.call("PUT", "/api/notes/n3", { title: "Changed by a reader", body: "x" });
        return r.status === 200;
    },
    "BR-03": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        return (await c.call("GET", "/api/admin/users")).status === 200;
    },
    "BR-04": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("mia@example.test");
        const r = await c.call("PATCH", "/api/admin/users/u3", { role: "admin" });
        return r.status === 200;
    },
    "BR-05": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        const sid = c.cookie("sid")!;
        await c.call("POST", "/api/logout");
        c.setCookie("sid", sid);
        return (await c.call("GET", "/api/me")).status === 200;
    },
    "BR-06": async (base) => {
        const owner = new BenchClient(base);
        await owner.signIn("ben@example.test");
        const r = await owner.call("DELETE", "/api/notes/n3/share/u1");
        if (r.status !== 200) return false;
        const reader = new BenchClient(base);
        await reader.signIn("ana@example.test");
        // Her own list (what she is entitled to), so an unrelated read-anything behaviour does not count here.
        const list = obj((await reader.call("GET", "/api/notes")).body);
        return Array.isArray(list.notes) && (list.notes as Array<Record<string, unknown>>).some((n) => n.id === "n3");
    },
    "BR-07": async (base) => {
        const c = new BenchClient(base);
        const r = await c.call("POST", "/api/register", { name: "Short Pass", email: "short@example.test", password: "abc" });
        return r.status === 201;
    },
    "BR-08": async (base) => {
        const c = new BenchClient(base);
        await c.signIn("ana@example.test");
        return (await c.call("POST", "/api/notes", { title: "", body: "no title" })).status === 201;
    },
};
