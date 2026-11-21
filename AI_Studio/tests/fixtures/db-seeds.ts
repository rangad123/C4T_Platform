/**
 * The stored-data seeds the database layer must find (PHASE_4_PLAN T20/T21): one action through the app's own API, then one database
 * check through a `DatabaseProbe`. `red` is true when the check shows the defect. Expected values come from the spec and the apps'
 * requirements: no orphan along a declared foreign key, e-mail addresses unique whatever the case, a 2xx update is stored, and a placed
 * order is both stored and listed. Shared by tests/db-bench-data.test.ts (D-a) and tests/db-bench-sqlite.test.ts (D-b).
 */
import type { DatabaseProbe } from "../../src/engine/database/probe.js";
import { BenchClient, obj } from "../../src/eval/bench/verify/http.js";

export interface DbSeed {
    seed: string;
    app: "bench-shop" | "bench-rbac";
    red: (base: string, probe: DatabaseProbe) => Promise<boolean>;
}

async function signedIn(base: string, email: string): Promise<BenchClient> {
    const c = new BenchClient(base);
    await c.signIn(email);
    return c;
}
async function placeOrder(c: BenchClient): Promise<string> {
    await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
    await c.call("POST", "/api/checkout/address", { address: "1 Test Road, Leeds" });
    const r = await c.call("POST", "/api/orders");
    if (r.status !== 201) throw new Error(`placing an order failed: ${r.status}`);
    return String(obj(r.body).id);
}

export const DB_SEEDS: DbSeed[] = [
    {
        seed: "BS-18",
        app: "bench-shop",
        red: async (base, probe) => {
            await placeOrder(await signedIn(base, "alice@example.test"));
            return (await probe.check({ kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } })).count > 0;
        },
    },
    {
        seed: "BR-11",
        app: "bench-rbac",
        red: async (base, probe) => {
            const c = await signedIn(base, "ben@example.test");
            if ((await c.call("DELETE", "/api/notes/n3")).status !== 200) throw new Error("deleting note n3 failed");
            return (await probe.check({ kind: "orphans", table: "note_shares", columns: ["noteId"], references: { table: "notes", columns: ["id"] } })).count > 0;
        },
    },
    {
        seed: "BS-17",
        app: "bench-shop",
        red: async (base, probe) => {
            await new BenchClient(base).call("POST", "/api/register", { name: "Alice Again", email: "ALICE@example.test", password: "Password1!" });
            return (await probe.check({ kind: "duplicates", table: "users", columns: ["email"], fold: true })).count > 0;
        },
    },
    {
        seed: "BS-06",
        app: "bench-shop",
        red: async (base, probe) => {
            const c = await signedIn(base, "alice@example.test");
            const put = await c.call("PUT", "/api/profile", { name: "Alice Moreau", address: "99 New Street, Hull" });
            if (put.status !== 200) throw new Error(`saving the profile failed: ${put.status}`);
            const stored = await probe.check({ kind: "exists", table: "users", where: ["email", "address"] }, { email: "alice@example.test", address: "99 New Street, Hull" });
            return stored.count === 0;
        },
    },
    {
        seed: "BS-12",
        app: "bench-shop",
        red: async (base, probe) => {
            const c = await signedIn(base, "alice@example.test");
            const id = await placeOrder(c);
            const stored = (await probe.check({ kind: "exists", table: "orders", where: ["id"] }, { id })).count === 1;
            const list = obj((await c.call("GET", "/api/orders")).body).orders;
            const listed = Array.isArray(list) && list.some((o) => obj(o).id === id);
            // Stored but not listed: the layers disagree.
            return stored && !listed;
        },
    },
];
