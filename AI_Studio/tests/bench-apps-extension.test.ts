/**
 * The bench extension on the benchmark applications (examples/bench-shop, examples/bench-rbac; PHASE_4_SPEC §1.2 and §4.4 D-a), with plain
 * HTTP, no browser:
 *   - GET /__bench/schema and GET /__bench/data exist only with BENCH_DATA_TOKEN and its header (404 without, 403 with a wrong one, 405 for
 *     any other method), read only, and never carry a password or a session;
 *   - every foreign key of the schema names a table and columns that exist, and the clean app has no orphan row after the actions that
 *     the extension seeds break;
 *   - the clean apps' answers match the response schemas their OpenAPI documents now carry (the engine's own contract checker);
 *   - the clean behaviours the extension needs: the 200-character address limit with a message, the case-folded unique email, the sign-in
 *     limit (5 failures in a minute, then 429 for a minute, cleared by a reset).
 * Ports: free loopback ports chosen at start.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { deref } from "../src/engine/api/openapi.js";
import { loadContractRuntime } from "../src/engine/contracts/check.js";
import { BENCH_DATA_TEST_TOKEN, startBenchApp, type BenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import { BenchClient, obj } from "../src/eval/bench/verify/http.js";

let running: RunningBenchApp | undefined;
afterEach(async () => {
    await running?.stop();
    running = undefined;
});
const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
const start = async (app: BenchApp, defects = "none", dataToken = BENCH_DATA_TEST_TOKEN) => (running = await startBenchApp(app, await freePort(), defects, "bench-reset", "html", dataToken));
const bench = (base: string, what: "data" | "schema", init: RequestInit = {}, token: string | null = BENCH_DATA_TEST_TOKEN) => fetch(`${base}/__bench/${what}`, { ...init, headers: token === null ? {} : { "x-bench-data": token } });

type Schema = { tables: Array<{ name: string; columns: string[]; primaryKey: string[]; uniqueKeys: Array<{ columns: string[]; ignoreCase?: boolean }>; foreignKeys: Array<{ columns: string[]; references: { table: string; columns: string[] } }>; rowCount: number }> };
async function orphans(base: string): Promise<string[]> {
    const schema = (await (await bench(base, "schema")).json()) as Schema;
    const data = obj(obj(await (await bench(base, "data")).json()).tables) as Record<string, Array<Record<string, unknown>>>;
    const out: string[] = [];
    for (const t of schema.tables)
        for (const fk of t.foreignKeys) {
            const keys = new Set(data[fk.references.table]!.map((r) => fk.references.columns.map((c) => String(r[c])).join("|")));
            for (const r of data[t.name]!) if (!keys.has(fk.columns.map((c) => String(r[c])).join("|"))) out.push(`${t.name} ${JSON.stringify(r)}`);
        }
    return out;
}

/** The documented response schema of one operation and status (local $refs resolved, as the engine reads the document). */
async function documented(base: string): Promise<(path: string, method: string, status: number) => unknown> {
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: unknown }> }> }>> };
    return (path, method, status) => {
        const schema = doc.paths[path]?.[method]?.responses[String(status)]?.content?.["application/json"]?.schema;
        if (!schema) throw new Error(`${method.toUpperCase()} ${path} documents no ${status} body`);
        return deref(doc, schema);
    };
}

describe.each(["bench-shop", "bench-rbac"] as const)("%s: the stored-data routes (D-a)", (app) => {
    it("exist only with the token: 404 without the variable or the header, 403 with a wrong one, 405 for any other method", async () => {
        const { base } = await start(app, "all", "");
        for (const what of ["data", "schema"] as const) {
            expect((await bench(base, what)).status, `${what} without the variable`).toBe(404);
            expect((await bench(base, what, {}, "anything")).status).toBe(404);
        }
        await running!.stop();
        const r = await start(app);
        for (const what of ["data", "schema"] as const) {
            expect((await bench(r.base, what, {}, null)).status, `${what} without the header`).toBe(404);
            expect((await bench(r.base, what, {}, "wrong")).status).toBe(403);
            expect((await bench(r.base, what, {}, "")).status).toBe(403);
            for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) expect((await bench(r.base, what, { method })).status, `${what} ${method}`).toBe(405);
            expect((await bench(r.base, what)).status).toBe(200);
        }
    });

    it("describe the tables with keys whose references exist, carry no credential or session, and the clean app keeps no orphan", async () => {
        const { base } = await start(app);
        const schema = (await (await bench(base, "schema")).json()) as Schema;
        const data = obj(obj(await (await bench(base, "data")).json()).tables) as Record<string, Array<Record<string, unknown>>>;
        expect(schema.tables.map((t) => t.name).sort()).toEqual(Object.keys(data).sort());
        for (const t of schema.tables) {
            expect(t.rowCount, t.name).toBe(data[t.name]!.length);
            for (const k of [...t.primaryKey, ...t.uniqueKeys.flatMap((u) => u.columns)]) expect(t.columns, `${t.name}.${k}`).toContain(k);
            for (const fk of t.foreignKeys) {
                const parent = schema.tables.find((x) => x.name === fk.references.table);
                expect(parent, `${t.name} → ${fk.references.table}`).toBeDefined();
                for (const c of fk.columns) expect(t.columns).toContain(c);
                for (const c of fk.references.columns) expect(parent!.columns).toContain(c);
            }
        }
        // The account emails are unique whatever the letter case (the stated rule, for a duplicates check).
        expect(schema.tables.find((t) => t.name === "users")!.uniqueKeys).toContainEqual({ columns: ["email"], ignoreCase: true });
        // Exercise the paths the extension's stored-data seeds break, on the clean app.
        const c = new BenchClient(base);
        if (app === "bench-shop") {
            await c.signIn("alice@example.test");
            await c.call("POST", "/api/cart/items", { productId: "p1", quantity: 2 });
            await c.call("POST", "/api/checkout/address", { address: "1 Clean Road, Leeds" });
            expect((await c.call("POST", "/api/orders")).status).toBe(201);
            await c.call("POST", "/api/cart/items", { productId: "p3", quantity: 1 });
        } else {
            await c.signIn("ben@example.test");
            expect((await c.call("DELETE", "/api/notes/n3")).status).toBe(200);
        }
        expect(await orphans(base)).toEqual([]);
        const text = await (await bench(base, "data")).text();
        expect(text).not.toMatch(/password|Password1!|"sid"|session/i);
        expect(text).not.toContain(c.cookie("sid")!);
    });
});

describe("the documented response schemas fit the clean apps", () => {
    const { contractAssert } = loadContractRuntime();

    it("bench-shop: every operation's answer, success and refusal", async () => {
        const { base } = await start("bench-shop");
        const schemaOf = await documented(base);
        const c = new BenchClient(base);
        const check = async (method: string, path: string, doc: string, status: number, body?: unknown) => {
            const r = await c.call(method, path, body);
            expect(r.status, `${method} ${path}`).toBe(status);
            expect(() => contractAssert(r.body, schemaOf(doc, method.toLowerCase(), status)), `${method} ${path} ${status}`).not.toThrow();
        };
        await check("GET", "/api/products", "/api/products", 200);
        await check("GET", "/api/products/p1", "/api/products/{id}", 200);
        await check("GET", "/api/products/nope", "/api/products/{id}", 404);
        await check("POST", "/api/register", "/api/register", 400, { name: "", email: "x@example.test", password: "Password1!" });
        await check("POST", "/api/register", "/api/register", 409, { name: "Alice", email: "Alice@Example.test", password: "Password1!" });
        await check("POST", "/api/register", "/api/register", 201, { name: "New Person", email: "new@example.test", password: "Password1!" });
        await check("POST", "/api/logout", "/api/logout", 200);
        await check("POST", "/api/login", "/api/login", 401, { email: "alice@example.test", password: "wrong" });
        await check("POST", "/api/login", "/api/login", 200, { email: "alice@example.test", password: "Password1!" });
        await check("GET", "/api/profile", "/api/profile", 200);
        await check("PUT", "/api/profile", "/api/profile", 200, { name: "Alice Moreau", address: "a".repeat(200) });
        await check("PUT", "/api/profile", "/api/profile", 400, { name: "Alice Moreau", address: "a".repeat(201) });
        await check("GET", "/api/cart", "/api/cart", 200);
        await check("POST", "/api/cart/items", "/api/cart/items", 201, { productId: "p1", quantity: 2 });
        await check("POST", "/api/cart/items", "/api/cart/items", 400, { productId: "p1", quantity: 11 });
        await check("POST", "/api/cart/items", "/api/cart/items", 404, { productId: "nope", quantity: 1 });
        await check("PATCH", "/api/cart/items/p1", "/api/cart/items/{productId}", 200, { quantity: 3 });
        await check("POST", "/api/cart/discount", "/api/cart/discount", 200, { code: "save10" });
        await check("POST", "/api/cart/discount", "/api/cart/discount", 400, { code: "NOPE" });
        await check("POST", "/api/orders", "/api/orders", 409);
        await check("POST", "/api/checkout/address", "/api/checkout/address", 200, { address: "1 Test Road, Leeds" });
        await check("POST", "/api/orders", "/api/orders", 201);
        await check("GET", "/api/orders", "/api/orders", 200);
        await check("GET", "/api/orders/ord-1000", "/api/orders/{id}", 200);
        await check("GET", "/api/orders/ord-1001", "/api/orders/{id}", 404);
        await check("POST", "/api/orders/ord-1002/pay", "/api/orders/{id}/pay", 200);
        await check("POST", "/api/orders/ord-1002/pay", "/api/orders/{id}/pay", 409);
        await check("POST", "/api/orders/ord-1000/cancel", "/api/orders/{id}/cancel", 409);
        await check("POST", "/api/orders/ord-1002/cancel", "/api/orders/{id}/cancel", 200);
        await check("POST", "/api/cart/items", "/api/cart/items", 201, { productId: "p2", quantity: 1 });
        await check("DELETE", "/api/cart/items/p2", "/api/cart/items/{productId}", 200);
    });

    it("bench-rbac: every operation's answer, success and refusal", async () => {
        const { base } = await start("bench-rbac");
        const schemaOf = await documented(base);
        const c = new BenchClient(base);
        const check = async (method: string, path: string, doc: string, status: number, body?: unknown) => {
            const r = await c.call(method, path, body);
            expect(r.status, `${method} ${path}`).toBe(status);
            expect(() => contractAssert(r.body, schemaOf(doc, method.toLowerCase(), status)), `${method} ${path} ${status}`).not.toThrow();
        };
        await check("POST", "/api/register", "/api/register", 409, { name: "Ana", email: "ANA@example.test", password: "Password1!" });
        await check("POST", "/api/register", "/api/register", 400, { name: "Short", email: "short@example.test", password: "abc" });
        await check("POST", "/api/register", "/api/register", 201, { name: "New Person", email: "new@example.test", password: "Password1!" });
        await check("POST", "/api/logout", "/api/logout", 200);
        await check("POST", "/api/login", "/api/login", 401, { email: "ana@example.test", password: "wrong" });
        await check("POST", "/api/login", "/api/login", 200, { email: "ana@example.test", password: "Password1!" });
        await check("GET", "/api/me", "/api/me", 200);
        await check("GET", "/api/notes", "/api/notes", 200);
        await check("POST", "/api/notes", "/api/notes", 400, { title: "" });
        await check("POST", "/api/notes", "/api/notes", 201, { title: "Plain note", body: "x" });
        await check("GET", "/api/notes/n4", "/api/notes/{id}", 200);
        await check("GET", "/api/notes/n2", "/api/notes/{id}", 404);
        await check("PUT", "/api/notes/n4", "/api/notes/{id}", 200, { title: "Changed", body: "y" });
        await check("PUT", "/api/notes/n3", "/api/notes/{id}", 403, { title: "Not mine", body: "" });
        await check("POST", "/api/notes/n4/share", "/api/notes/{id}/share", 200, { email: "ben@example.test" });
        await check("POST", "/api/notes/n4/share", "/api/notes/{id}/share", 404, { email: "nobody@example.test" });
        await check("DELETE", "/api/notes/n4/share/u2", "/api/notes/{id}/share/{userId}", 200);
        await check("DELETE", "/api/notes/n3", "/api/notes/{id}", 403);
        await check("DELETE", "/api/notes/n4", "/api/notes/{id}", 200);
        await check("GET", "/api/admin/users", "/api/admin/users", 403);
        await check("PATCH", "/api/admin/users/u1", "/api/admin/users/{id}", 403, { role: "admin" });
        await c.signIn("ada@example.test");
        await check("GET", "/api/admin/users", "/api/admin/users", 200);
        await check("PATCH", "/api/admin/users/u2", "/api/admin/users/{id}", 200, { role: "manager" });
    });
});

describe("the clean behaviours the extension states", () => {
    it("bench-shop: an address over 200 characters is refused with the stated message; an email in another letter case is in use", async () => {
        const { base } = await start("bench-shop");
        const c = new BenchClient(base);
        await c.signIn("alice@example.test");
        const r = await c.call("PUT", "/api/profile", { name: "Alice Moreau", address: "b".repeat(201) });
        expect(r.status).toBe(400);
        expect(obj(r.body).error).toBe("The address can have at most 200 characters.");
        expect(obj((await c.call("GET", "/api/profile")).body).address).toBe("12 Harbour Street, Leeds");
        expect((await new BenchClient(base).call("POST", "/api/register", { name: "A", email: " Bob@EXAMPLE.test ", password: "Password1!" })).status).toBe(409);
        // The page script shows an error answer as an error on every form, the account form included.
        expect(await (await fetch(`${base}/app.js`)).text()).toContain("if (!res.ok) {");
    });

    it("bench-rbac: 5 failed sign-ins in a minute refuse that email for a minute (429, the right password too), others unaffected; a reset clears it", async () => {
        const { base } = await start("bench-rbac");
        const c = new BenchClient(base);
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) statuses.push((await c.call("POST", "/api/login", { email: "ana@example.test", password: `wrong-${i}` })).status);
        expect(statuses).toEqual([401, 401, 401, 401, 401]);
        const locked = await c.call("POST", "/api/login", { email: " ANA@example.test", password: "Password1!" });
        expect(locked.status).toBe(429);
        expect(obj(locked.body).error).toBe("Too many failed sign-ins. Try again in a minute.");
        // The HTML form refuses it the same way.
        const form = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "ana@example.test", password: "Password1!" }), redirect: "manual" });
        expect(form.status).toBe(429);
        expect(await form.text()).toContain("Too many failed sign-ins. Try again in a minute.");
        expect((await c.call("POST", "/api/login", { email: "ben@example.test", password: "Password1!" })).status).toBe(200);
        // Four failures are not enough.
        for (let i = 0; i < 4; i++) await c.call("POST", "/api/login", { email: "mia@example.test", password: "wrong" });
        expect((await c.call("POST", "/api/login", { email: "mia@example.test", password: "Password1!" })).status).toBe(200);
        await running!.reset();
        expect((await c.call("POST", "/api/login", { email: "ana@example.test", password: "Password1!" })).status).toBe(200);
    });
});
