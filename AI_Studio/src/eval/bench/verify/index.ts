/**
 * Independent verifiers for the seeded defects in src/eval/bench/catalogue.json. Each one starts from a freshly reset application and
 * answers whether the defective behaviour is present (true) or the correct behaviour is seen (false), using plain HTTP only. They never
 * look at how the application is built: only at what it answers, exactly as the catalogue's reproduction steps describe.
 */
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
