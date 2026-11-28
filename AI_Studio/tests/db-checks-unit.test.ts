/**
 * C10 database checks as test steps (Phase 4 T23), browser-free: the check names (names only, values apart), the checks generated from a
 * schema's declared keys and after 2xx writes, the bound of 40, the run's check service (loopback, token, counts only, refusals), the
 * rendering into API and web scripts, the stored-data rule proposal (a prompt of names only, an assert) and the layer report's count.
 * Expected values come from PHASE_4_SPEC 4.4, section 5 (C10 at most 40 checks) and the bench apps' declared keys.
 */
import { describe, expect, it } from "vitest";
import { dbCheckName, DB_CHECKS_MAX, duplicateChecksOf, integrityChecks, parseDbCheck, persistenceCheck, resolveParams, webPersistenceChecks, withDatabaseChecks } from "../src/engine/database/checks.js";
import { cleanSchema, type DatabaseProbe, type DbSchema } from "../src/engine/database/probe.js";
import { proposeRowRelations, rowRelationPrompt } from "../src/engine/database/propose.js";
import { startDbCheckService } from "../src/engine/database/service.js";
import { runOnRows, validateCheck, type DbTemplate } from "../src/engine/database/templates.js";
import { renderScript } from "../src/engine/generators/index.js";
import type { LlmClient } from "../src/engine/llm/provider.js";
import { TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { webRequestProblems } from "../src/engine/web/checks.js";
import { layerReport, LayerReportSchema } from "../src/engine/validation/layers.js";

const fk = (columns: string[], table: string, refs: string[]) => ({ columns, references: { table, columns: refs } });
const SCHEMA: DbSchema = cleanSchema({
    tables: [
        { name: "users", columns: ["id", "email", "name", "address"], primaryKey: ["id"], uniqueKeys: [{ columns: ["email"], ignoreCase: true }], foreignKeys: [], rowCount: 2 },
        { name: "carts", columns: ["id", "userId"], primaryKey: ["id"], uniqueKeys: [{ columns: ["userId"] }], foreignKeys: [fk(["userId"], "users", ["id"])], rowCount: 1 },
        { name: "cart_items", columns: ["cartId", "productId", "quantity"], primaryKey: ["cartId", "productId"], uniqueKeys: [], foreignKeys: [fk(["cartId"], "carts", ["id"])], rowCount: 1 },
        { name: "orders", columns: ["id", "userId", "subtotal", "discount", "shipping", "total"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [fk(["userId"], "users", ["id"])], rowCount: 1 },
    ],
});
const ROWS = {
    users: [
        { id: "u1", email: "alice@example.test", name: "Alice", address: "12 Harbour Street" },
        { id: "u2", email: "ALICE@example.test", name: "Alice Again", address: "" },
    ],
    carts: [{ id: "c1", userId: "u1" }],
    cart_items: [{ cartId: "c1", productId: "p1", quantity: 1 }, { cartId: "c9", productId: "p2", quantity: 2 }],
    orders: [{ id: "ord-1", userId: "u1", subtotal: 100, discount: 10, shipping: 5, total: 95 }],
};
const TOKEN_OF_DATA = "bench-data-token-0123456789";
/** A probe over ROWS, as the D-a back end runs it (the in-memory templates). */
const probe: DatabaseProbe = {
    schema: async () => SCHEMA,
    check: async (t, p) => runOnRows(validateCheck(t, p, SCHEMA), ROWS, Buffer.alloc(32, 7)),
};

describe("check names: the template in words, names only", () => {
    it("each form reads back as its template; values travel as params", () => {
        const forms: DbTemplate[] = [
            { kind: "exists", table: "users", where: ["email", "address"] },
            { kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } },
            { kind: "duplicates", table: "users", columns: ["email"], fold: true },
            { kind: "duplicates", table: "carts", columns: ["userId"] },
            { kind: "relation", table: "orders", where: [], expression: "total == subtotal - discount + shipping" },
        ];
        for (const t of forms) {
            const params: Record<string, string> = t.kind === "exists" ? { email: "qa+{{unique}}@example.com", address: "1 Road" } : {};
            const name = dbCheckName(t, params);
            expect(parseDbCheck(name)).toEqual({ template: t, params });
        }
        expect(dbCheckName({ kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } })).toBe("orphans cart_items(cartId) -> carts(id)");
        expect(parseDbCheck("exists orders where id = 12, note = null").params).toEqual({ id: 12, note: null });
    });

    it("anything else is refused: SQL text, a quote inside a value, an unknown form", () => {
        for (const bad of ["SELECT * FROM users", "exists users where email = 'a' OR 1=1 --'", "exists users where email = 'it's'", "count users", "orphans users(id) -> ", "relation : total > 0", "exists users; DROP TABLE users"]) {
            expect(() => parseDbCheck(bad), bad).toThrow(/Database check refused/);
        }
    });

    it("placeholders take the test's values; a missing one refuses the check", () => {
        const { params } = parseDbCheck("exists orders where id = '{{orderId}}'");
        expect(resolveParams(params, { orderId: "ord-7" })).toEqual({ id: "ord-7" });
        expect(() => resolveParams(params, {})).toThrow(/no value for \{\{orderId\}\}/);
    });
});

describe("generated checks", () => {
    it("the declared keys give one orphan check per foreign key and one duplicate check per unique key (case-folded where stated)", () => {
        expect(integrityChecks(SCHEMA)).toEqual(["duplicates users(email) any case", "orphans carts(userId) -> users(id)", "duplicates carts(userId)", "orphans cart_items(cartId) -> carts(id)", "orphans orders(userId) -> users(id)"]);
    });

    const req = (method: string, path: string, extra: Record<string, unknown> = {}) => ({ action: "request", method, path, auth: "default", description: "", ...extra }) as Extract<Step, { action: "request" }>;
    it("persistence: a create that returned an id, an update of its fields; never a sign-in detail, never a guess", () => {
        expect(persistenceCheck(req("POST", "/api/orders", { extract: { orderId: "id" } }), SCHEMA)).toBe("exists orders where id = '{{orderId}}'");
        expect(persistenceCheck(req("PUT", "/api/profile", { body: { name: "Test {{unique}}", address: "1 Road {{unique}}" } }), SCHEMA)).toBe("exists users where name = 'Test {{unique}}', address = '1 Road {{unique}}'");
        expect(persistenceCheck(req("PUT", "/api/users/{{userId}}", { body: { name: "N", password: "Secret1!" } }), SCHEMA)).toBe("exists users where id = '{{userId}}', name = 'N'");
        // A stored password column is never compared, even when the write sends one.
        const withPassword = cleanSchema({ tables: [{ name: "accounts", columns: ["id", "name", "password"], primaryKey: ["id"] }] });
        expect(persistenceCheck(req("PUT", "/api/accounts/{{accountId}}", { body: { name: "N", password: "Secret1!" } }), withPassword)).toBe("exists accounts where id = '{{accountId}}', name = 'N'");
        // No id returned; a field no table has; a GET.
        expect(persistenceCheck(req("POST", "/api/orders"), SCHEMA)).toBeUndefined();
        expect(persistenceCheck(req("PUT", "/api/profile", { body: { nickname: "x" } }), SCHEMA)).toBeUndefined();
        expect(persistenceCheck(req("GET", "/api/orders", { extract: { orderId: "id" } }), SCHEMA)).toBeUndefined();
    });

    const ok = { action: "assertResponse", check: "statusClass", expected: "2xx", description: "" } as Step;
    it("a data-changing test gets its persistence check after the 2xx write, the sourced absence checks right after its last write and the unsourced ones at the end; a read-only one none", () => {
        const steps = [req("POST", "/api/orders", { extract: { orderId: "id" } }), ok, req("GET", "/api/orders"), ok];
        const out = withDatabaseChecks(steps, SCHEMA, [{ name: "orphans cart_items(cartId) -> carts(id)" }, { name: "relation orders: total >= 0", source: "6.1" }], { left: 40 });
        // L8: a stated row rule runs before the API assertions on the last write and any read-back after it, so a stored-data defect
        // fails at the database check even when the API check would fail too. A key check (no source, counted over the whole table, so
        // other tests' rows can break it) runs last: it never hides the test's own sourced checks (lane M, re-check shop API-070).
        expect(out.map((s) => (s.action === "assertResponse" && s.check === "dbCheck" ? s.name : s.action))).toEqual(["request", "relation orders: total >= 0", "assertResponse", "exists orders where id = '{{orderId}}'", "request", "assertResponse", "orphans cart_items(cartId) -> carts(id)"]);
        expect(out[1]).toMatchObject({ source: "6.1" });
        expect(out.at(-1)).not.toHaveProperty("source");
        // A documented 409 (BS-17's shape): the duplicate check carries the 409's source and comes before the 409 assertion, not after it.
        const status409 = { action: "assertResponse", check: "status", expected: 409, description: "", source: "API document: POST /api/register 409" } as Step;
        const again = [req("POST", "/api/register", { body: { name: "A", email: "a@x.test" } }), ok, req("POST", "/api/register", { body: { name: "A", email: "A@X.TEST" } }), status409];
        const absence = [{ name: "duplicates users(email) any case" }, { name: "duplicates carts(userId)" }, { name: "orphans cart_items(cartId) -> carts(id)" }];
        expect(duplicateChecksOf(again, absence)).toEqual([{ name: "duplicates users(email) any case", source: "API document: POST /api/register 409" }]);
        const placed = withDatabaseChecks(again, SCHEMA, duplicateChecksOf(again, absence), { left: 40 });
        expect(placed.map((s) => (s.action === "assertResponse" ? (s.check === "dbCheck" ? s.name : s.check) : s.action))).toEqual(["request", "statusClass", "request", "duplicates users(email) any case", "status"]);
        expect(placed[3]).toMatchObject({ source: "API document: POST /api/register 409" });
        // The orchestrator passes the document's 409 (the assertion gets its source only later, withStatedSources); without one the check is a key check.
        const bare = again.map((s) => (s === status409 ? { ...status409, source: undefined } : s)) as Step[];
        expect(duplicateChecksOf(bare, absence, "API document: POST /api/register 409")).toEqual([{ name: "duplicates users(email) any case", source: "API document: POST /api/register 409" }]);
        expect(duplicateChecksOf(bare, absence)).toEqual([{ name: "duplicates users(email) any case" }]);
        expect(withDatabaseChecks([req("GET", "/api/orders"), ok], SCHEMA, [{ name: "orphans cart_items(cartId) -> carts(id)" }], { left: 40 })).toHaveLength(2);
        // A write as the test's last step (nothing after it) still gets the absence checks; so does a delete.
        for (const last of [req("POST", "/api/register", { body: { email: "A@x.test" } }), req("DELETE", "/api/notes/n3")]) expect(withDatabaseChecks([last], SCHEMA, [{ name: "duplicates users(email) any case" }], { left: 40 })).toHaveLength(2);
    });

    it(`at most ${DB_CHECKS_MAX} checks in a run`, () => {
        const budget = { left: DB_CHECKS_MAX };
        const absence = integrityChecks(SCHEMA).map((name) => ({ name }));
        let made = 0;
        for (let i = 0; i < 30; i++) made += withDatabaseChecks([req("POST", "/api/orders", { extract: { orderId: "id" } }), ok], SCHEMA, absence, budget).length - 2;
        expect(made).toBe(DB_CHECKS_MAX);
    });
});

describe("the run's database check service", () => {
    it("counts every call it makes to the probe against one cap, the numeric second try included", async () => {
        let probeCalls = 0;
        const counting: DatabaseProbe = { schema: probe.schema, check: async (t, p) => (probeCalls++, probe.check(t, p)) };
        const s = await startDbCheckService(counting, 4);
        try {
            const ask = () => post(s.url, `Bearer ${s.token}`, { name: "exists orders where id = '{{id}}'", vars: { id: "12" } });
            expect((await ask()).status).toBe(200);
            expect((await ask()).status).toBe(200);
            expect((await ask()).status).toBe(429);
            expect(probeCalls).toBe(4);
        } finally {
            await s.close();
        }
    });

    const post = (url: string, auth: string | undefined, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });

    it("loopback only, the token required, counts and fingerprints back (never a row), and refusals name the rule", async () => {
        const s = await startDbCheckService(probe);
        try {
            expect(new URL(s.url).hostname).toBe("127.0.0.1");
            expect((await post(s.url, undefined, { name: "duplicates users(email) any case" })).status).toBe(401);
            expect((await post(s.url, "Bearer wrong", { name: "duplicates users(email) any case" })).status).toBe(401);
            const res = await post(s.url, `Bearer ${s.token}`, { name: "duplicates users(email) any case" });
            const body = (await res.json()) as Record<string, unknown>;
            expect(res.status).toBe(200);
            expect(body).toMatchObject({ kind: "duplicates", count: 1 });
            expect(JSON.stringify(body)).not.toMatch(/alice|Harbour/i);
            const orphan = (await (await post(s.url, `Bearer ${s.token}`, { name: "orphans cart_items(cartId) -> carts(id)" })).json()) as { count: number };
            expect(orphan.count).toBe(1);
            const stored = (await (await post(s.url, `Bearer ${s.token}`, { name: "exists orders where id = '{{orderId}}'", vars: { orderId: "ord-1" } })).json()) as { count: number };
            expect(stored.count).toBe(1);
            for (const [name, why] of [["SELECT * FROM users", /not one of/], ["duplicates sessions(token)", /no table "sessions"/], ["exists users where password = 'x'", /no column "password"/]] as const) {
                const r = await post(s.url, `Bearer ${s.token}`, { name });
                expect(r.status).toBe(400);
                expect(((await r.json()) as { error: string }).error).toMatch(why);
            }
            expect((await post(s.url, `Bearer ${s.token}`, { name: "duplicates users(email)", sql: "DROP TABLE users" })).status).toBe(400);
        } finally {
            await s.close();
        }
    });
});

describe("rendering", () => {
    const spec = (kind: "api" | "web") =>
        TestSpecSchema.parse({
            testId: kind === "api" ? "API-001" : "WEB-001",
            title: "Order",
            kind,
            type: "functional",
            priority: "high",
            steps: [
                ...(kind === "api" ? [{ action: "request", method: "POST", path: "/api/orders", auth: "none", extract: { orderId: "id" }, description: "" }] : [{ action: "navigate", url: "/", description: "" }]),
                { action: "assertResponse", check: "dbCheck", name: kind === "api" ? "exists orders where id = '{{orderId}}'" : "exists users where email = 'qa+{{unique}}@example.com'", description: "" },
                { action: "assertResponse", check: "dbCheck", name: "orphans cart_items(cartId) -> carts(id)", source: "5.2", description: "" },
            ],
        });
    it("API and web scripts send the name and its test values to the service, read the absence checks first, and hold no database access", () => {
        for (const kind of ["api", "web"] as const) {
            const s = spec(kind);
            expect(webRequestProblems(s, { baseUrl: "http://127.0.0.1:9" })).toEqual([]);
            const { content } = renderScript(s, kind === "api" ? "playwright-api" : "playwright", { baseUrl: "http://127.0.0.1:9" });
            expect(content).toContain('const dbBefore = await dbBaseline(["orphans cart_items(cartId) -> carts(id)"]);');
            expect(content).toContain(kind === "api" ? `await dbAssert("exists orders where id = '{{orderId}}'", { "orderId": \`\${data["orderId"] ?? ""}\` }, dbBefore, "");` : `await dbAssert("exists users where email = 'qa+{{unique}}@example.com'", { "unique": \`\${unique}\` }, dbBefore, "");`);
            expect(content).toContain('await dbAssert("orphans cart_items(cartId) -> carts(id)", {  }, dbBefore, "5.2");');
            expect(content).toContain("process.env.DB_CHECK_URL");
            expect(content).not.toMatch(/x-bench-data|BENCH_DATA_TOKEN|sqlite/i);
        }
    });

    it("a name outside the forms, or one using sign-in details, is refused at rendering", () => {
        const bad = (name: string) => () => renderScript({ ...spec("api"), steps: [{ action: "assertResponse", check: "dbCheck", name, description: "" }] as never }, "playwright-api", { baseUrl: "http://127.0.0.1:9" });
        expect(bad("SELECT 1")).toThrow(/not one of/);
        expect(bad("exists users where email = '{{credentials.username}}'")).toThrow(/plain test values only/);
    });
});

describe("stored-data rules over rows (C5 over the database)", () => {
    const requirements = [
        { id: "6.1", text: "An order's total is its subtotal less the discount plus shipping." },
        { id: "3.8", text: "A line total is the unit price times the quantity." },
    ];
    const scripted = (answer: unknown, prompts: string[]): { llm: LlmClient } => ({
        llm: {
            object: (async ({ prompt }: { prompt: string }) => {
                prompts.push(prompt);
                return answer;
            }) as LlmClient["object"],
        } as LlmClient,
    });

    it("the prompt carries table and column names only: no row value, no count, no token", async () => {
        const prompts: string[] = [];
        await proposeRowRelations(scripted({ relations: [] }, prompts), { requirements, schema: SCHEMA, secrets: [TOKEN_OF_DATA] });
        expect(prompts).toHaveLength(1);
        const prompt = prompts[0]!;
        expect(prompt).toBe(rowRelationPrompt({ requirements, schema: SCHEMA, secrets: [] }));
        const tables = prompt.slice(prompt.indexOf("<<<TABLES"));
        const names = new Set(SCHEMA.tables.flatMap((t) => [t.name, ...t.columns]));
        // Every word of the tables part is a schema name or a fixed word of the layout.
        for (const word of tables.match(/[A-Za-z_][A-Za-z0-9_]*/g)!) expect(names.has(word) || ["TABLES", "key", "unique"].includes(word), word).toBe(true);
        for (const v of [...Object.values(ROWS).flatMap((rows) => rows.flatMap((r) => Object.values(r).map(String))), TOKEN_OF_DATA]) if (v.length > 2) expect(prompt).not.toContain(v);
        expect(tables).not.toMatch(/\d/);
    });

    it("keeps only rules citing a requirement and inside the grammar over the table's own columns", async () => {
        const answer = {
            relations: [
                { requirementId: "6.1", table: "orders", expression: "total == subtotal - discount + shipping" },
                { requirementId: "9.9", table: "orders", expression: "total >= 0" },
                { requirementId: "6.1", table: "orders", expression: "total == price" },
                { requirementId: "6.1", table: "sessions", expression: "id != 0" },
                { requirementId: "6.1", table: "orders", expression: "total == $paid" },
                { requirementId: "6.1", table: "orders", expression: "1; DROP TABLE orders" },
            ],
        };
        const r = await proposeRowRelations(scripted(answer, []), { requirements, schema: SCHEMA, secrets: [] });
        expect(r.checks).toEqual([{ name: "relation orders: total == subtotal - discount + shipping", source: "6.1" }]);
        expect(r.report).toMatchObject({ proposed: 6, kept: 1 });
        expect(r.report.dropped.map((d) => d.reason)).toEqual([
            "it cites no requirement of this run",
            expect.stringMatching(/no column "price"/),
            expect.stringMatching(/no table "sessions"/),
            expect.stringMatching(/columns only, not test values/),
            expect.stringMatching(/outside the relation grammar/),
        ]);
    });

    // paid-rbac-1 API-034 / API-035: "relation notes: title <= 120" (3.5) compared a text column with a number, so every row broke it
    // and any test that wrote a note failed on the clean app. Ill-formed rules are dropped at the proposal, judged once on the rows there.
    it("drops a rule no stored row can keep (text compared with a number), and keeps the well-formed ones", async () => {
        const notesSchema = cleanSchema({
            tables: [
                { name: "users", columns: ["id", "email", "name", "role"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 1 },
                { name: "notes", columns: ["id", "ownerId", "title", "body"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [fk(["ownerId"], "users", ["id"])], rowCount: 2 },
            ],
        });
        const rows = {
            users: [{ id: "u1", email: "ana@example.test", name: "Ana", role: "user" }],
            notes: [
                { id: "n1", ownerId: "u1", title: "Ana's travel plans", body: "Train to Porto on the 14th." },
                { id: "n3", ownerId: "u1", title: "Team lunch ideas", body: "Ramen place near the station." },
            ],
        };
        const notesProbe: DatabaseProbe = { schema: async () => notesSchema, check: async (t, p) => runOnRows(validateCheck(t, p, notesSchema), rows, Buffer.alloc(32, 7)) };
        const reqs = [
            { id: "3.4", text: "Every note needs a title." },
            { id: "3.5", text: "A title is at most 120 characters." },
            { id: "1.2", text: "A role is user, manager or admin." },
        ];
        const answer = {
            relations: [
                { requirementId: "3.4", table: "notes", expression: 'title != ""' },
                { requirementId: "3.5", table: "notes", expression: "title <= 120" },
                { requirementId: "1.2", table: "users", expression: 'role == "user" or role == "manager" or role == "admin"' },
            ],
        };
        const r = await proposeRowRelations(scripted(answer, []), { requirements: reqs, schema: notesSchema, secrets: [], probe: notesProbe });
        expect(r.checks.map((c) => c.source)).toEqual(["3.4", "1.2"]);
        expect(r.report).toMatchObject({ proposed: 3, kept: 2 });
        expect(r.report.dropped).toEqual([{ requirementId: "3.5", table: "notes", reason: expect.stringMatching(/every stored row of "notes" already breaks it/) }]);
        // The reason names no stored value.
        for (const v of ["Ana's travel plans", "Team lunch ideas"]) expect(r.report.dropped[0]!.reason).not.toContain(v);
        // At run time the checks keep their definition (spec 4.4: a row the expression does not hold on counts): both rows break it.
        expect((await notesProbe.check({ kind: "relation", table: "notes", where: [], expression: "title <= 120" })).count).toBe(2);
        expect((await notesProbe.check({ kind: "relation", table: "notes", where: [], expression: 'title != ""' })).count).toBe(0);
    });

    // paid-shop-1 API-061 (the BS-12 read-back): the model's "orders: status == \"Placed\" or ..." used the page's labels, while the rows
    // store "placed" and "shipped". Every stored row broke it, so every test that placed an order failed on the clean app too.
    it("drops a rule every stored row already breaks; keeps one that only some rows break", async () => {
        const shopSchema = cleanSchema({
            tables: [{ name: "orders", columns: ["id", "status", "subtotal", "discount", "shipping", "total"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 3 }],
        });
        const rows = {
            orders: [
                { id: "ord-1000", status: "shipped", subtotal: 850, discount: 0, shipping: 500, total: 1350 },
                { id: "ord-1001", status: "placed", subtotal: 3450, discount: 0, shipping: 500, total: 3950 },
                // One row a defect left: its total is wrong.
                { id: "ord-1002", status: "placed", subtotal: 1000, discount: 0, shipping: 500, total: 1000 },
            ],
        };
        const shopProbe: DatabaseProbe = { schema: async () => shopSchema, check: async (t, p) => runOnRows(validateCheck(t, p, shopSchema), rows, Buffer.alloc(32, 7)) };
        const reqs = [
            { id: "6.1", text: "An order is Placed, Paid, Shipped or Cancelled." },
            { id: "3.10", text: "The total is the subtotal less the discount plus shipping." },
        ];
        const answer = {
            relations: [
                { requirementId: "6.1", table: "orders", expression: 'status == "Placed" or status == "Paid" or status == "Shipped" or status == "Cancelled"' },
                { requirementId: "3.10", table: "orders", expression: "total == subtotal - discount + shipping" },
            ],
        };
        const r = await proposeRowRelations(scripted(answer, []), { requirements: reqs, schema: shopSchema, secrets: [], probe: shopProbe });
        expect(r.checks).toEqual([{ name: "relation orders: total == subtotal - discount + shipping", source: "3.10" }]);
        expect(r.report.dropped).toEqual([{ requirementId: "6.1", table: "orders", reason: expect.stringMatching(/every stored row of "orders" already breaks it/) }]);
        // An empty table judges nothing: the rule is kept.
        const empty = cleanSchema({ tables: [{ ...shopSchema.tables[0]!, rowCount: 0 }] });
        const none: DatabaseProbe = { schema: async () => empty, check: async (t, p) => runOnRows(validateCheck(t, p, empty), { orders: [] }, Buffer.alloc(32, 7)) };
        expect((await proposeRowRelations(scripted(answer, []), { requirements: reqs, schema: empty, secrets: [], probe: none })).checks).toHaveLength(2);
    });

    // paid-shop-2 API-067: the model's rule 4.5 is in dollars (50, 5) while the rows hold cents. The orders written while the tests were
    // authored kept it (free shipping from 5000) and the starting ones broke it, so "every row breaks it" kept it, and the BS-12
    // read-back failed on the clean app at this rule.
    it("drops a rule whose number is 100 times off the stored values; keeps the same rule in the stored unit, defect rows and all", async () => {
        const shopSchema = cleanSchema({
            tables: [{ name: "orders", columns: ["id", "subtotal", "discount", "shipping", "total"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 5 }],
        });
        const order = (id: string, subtotal: number, shipping: number) => ({ id, subtotal, discount: 0, shipping, total: subtotal + shipping });
        const rows = {
            orders: [
                order("ord-1000", 850, 500), order("ord-1001", 3450, 500), order("ord-1002", 6250, 0), order("ord-1003", 2500, 500),
                // One row a defect left (BS-11: no free shipping at exactly 5000).
                order("ord-1004", 5000, 500),
            ],
        };
        const shopProbe: DatabaseProbe = { schema: async () => shopSchema, check: async (t, p) => runOnRows(validateCheck(t, p, shopSchema), rows, Buffer.alloc(32, 7)) };
        const reqs = [{ id: "4.5", text: "Orders of $50.00 or more after the discount ship free; others pay $5.00 shipping." }, { id: "3.6", text: "Shipping is at most $5.00 and an order is at least $1.00, or 20 cents of goods." }];
        const answer = {
            relations: [
                { requirementId: "4.5", table: "orders", expression: "((subtotal - discount) >= 50 implies shipping == 0) and ((subtotal - discount) < 50 implies shipping == 5)" },
                { requirementId: "4.5", table: "orders", expression: "(subtotal - discount) >= 5000 implies shipping == 0" },
                // Stated amounts in the stored unit, or a bound every row meets: kept.
                { requirementId: "3.6", table: "orders", expression: "shipping <= 500 and subtotal >= 100" },
                // A number the requirement does not write as an amount is not judged for its scale (100 times it does fall among the rows).
                { requirementId: "3.6", table: "orders", expression: "total >= 20" },
            ],
        };
        const r = await proposeRowRelations(scripted(answer, []), { requirements: reqs, schema: shopSchema, secrets: [], probe: shopProbe });
        expect(r.checks.map((c) => c.name)).toEqual(["relation orders: (subtotal - discount) >= 5000 implies shipping == 0", "relation orders: shipping <= 500 and subtotal >= 100", "relation orders: total >= 20"]);
        expect(r.report.dropped).toEqual([{ requirementId: "4.5", table: "orders", reason: expect.stringMatching(/compares \(subtotal - discount\) with the requirement's amount 50, .* while 5000 falls among them, so the stored numbers are 100 times/) }]);
        for (const v of ["6250", "3450", "ord-1002"]) expect(r.report.dropped[0]!.reason).not.toContain(v);
    });

    it("no requirement, no call", async () => {
        const prompts: string[] = [];
        expect((await proposeRowRelations(scripted({ relations: [] }, prompts), { requirements: [], schema: SCHEMA, secrets: [] })).checks).toEqual([]);
        expect(prompts).toEqual([]);
    });
});

describe("the layer report counts the database checks", () => {
    const run = { web: false, api: true, apiEndpoints: 4, dataChanges: true };
    it("ran, with the tests and their checks; not set up, or nothing to check after, says why", () => {
        const r = layerReport({ api: 3, database: 2 }, { ...run, database: { checks: 9 } });
        expect(r.database).toEqual({ status: "ran", tests: 2, checks: 9 });
        expect(LayerReportSchema.parse(r)).toEqual(r);
        expect(layerReport({ api: 3 }, run).database).toEqual({ status: "unavailable", reason: "Not checked: no read-only database access is set up." });
        expect(layerReport({ api: 3 }, { ...run, dataChanges: false, database: { checks: 0 } }).database).toEqual({ status: "unavailable", reason: "Not checked: data changes are off, so no write is followed by a database check." });
        expect(layerReport({ api: 3 }, { ...run, database: { unavailable: "the database could not be read (HTTP 403)" } }).database).toEqual({ status: "unavailable", reason: "Not checked: the database could not be read (HTTP 403)." });
    });
});

describe("persistence after a web test's write (C10 after C4, from the captured answers)", () => {
    const fill = (value: string): Step => ({ action: "fill", locator: { by: "label", value: "Name" }, value, description: "Fill" }) as Step;
    const click: Step = { action: "click", locator: { by: "role", value: "button", name: "Save" }, description: "Save" } as Step;
    const put = (sent: Record<string, string | number>, extra: Record<string, unknown> = {}) => ({ step: 2, method: "PUT", path: "/api/profile", status: 200, sent, ...extra });

    it("a 2xx PUT the page made: the fields the test itself typed are stored, in the one table that has them", () => {
        const out = webPersistenceChecks([fill("Ada Lovelace"), fill("1 Analytical Way"), click], [put({ name: "Ada Lovelace", address: "1 Analytical Way" })], SCHEMA, { left: 5 });
        expect(out).toEqual([expect.objectContaining({ action: "assertResponse", check: "dbCheck", name: dbCheckName({ kind: "exists", table: "users", where: ["name", "address"] }, { name: "Ada Lovelace", address: "1 Analytical Way" }) })]);
    });

    it("compares only values the test types as written: a templated, untyped or refused write gives no check", () => {
        expect(webPersistenceChecks([fill("Ada {{unique}}"), click], [put({ name: "Ada 123" })], SCHEMA, { left: 5 })).toEqual([]);
        expect(webPersistenceChecks([fill("Ada"), click], [put({ name: "Grace" })], SCHEMA, { left: 5 })).toEqual([]);
        expect(webPersistenceChecks([fill("Ada"), click], [put({ name: "Ada" }, { status: 400 })], SCHEMA, { left: 5 })).toEqual([]);
        expect(webPersistenceChecks([fill("Ada"), click], [put({ name: "Ada" }, { readBack: true })], SCHEMA, { left: 5 })).toEqual([]);
        // A create's id differs in every run: not checked.
        expect(webPersistenceChecks([fill("Ada"), click], [{ step: 1, method: "POST", path: "/api/orders", status: 201, sent: { name: "Ada" } }], SCHEMA, { left: 5 })).toEqual([]);
    });

    it("the path's last write only, and within the run's budget", () => {
        const two = webPersistenceChecks([fill("Ada"), fill("Grace"), click], [put({ name: "Ada" }), put({ name: "Grace" })], SCHEMA, { left: 5 });
        expect(two).toHaveLength(1);
        expect((two[0] as { name: string }).name).toContain("Grace");
        const budget = { left: 0 };
        expect(webPersistenceChecks([fill("Ada"), click], [put({ name: "Ada" })], SCHEMA, budget)).toEqual([]);
        const one = { left: 1 };
        webPersistenceChecks([fill("Ada"), click], [put({ name: "Ada" })], SCHEMA, one);
        expect(one.left).toBe(0);
    });
});

