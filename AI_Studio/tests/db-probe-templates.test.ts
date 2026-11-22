/**
 * The database layer's templates (Phase 4 C10, T19; spec 4.4): names outside the schema are refused, there is no way to pass SQL text,
 * and a result is counts, fingerprints and at most 20 masked keys, never a row value. fast-check properties for each, plus the
 * templates' meaning on small tables written from the spec's definitions (an orphan points at no parent; a duplicate is a key value held
 * by more than one row, case-folded where stated; nulls never clash).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cleanSchema, DB_REFUSED_PREFIX, newEvidenceKey, type DbSchema } from "../src/engine/database/probe.js";
import { runOnRows, validateCheck, type DbTemplate } from "../src/engine/database/templates.js";

const SCHEMA: DbSchema = cleanSchema({
    tables: [
        { name: "users", columns: ["id", "email", "name"], primaryKey: ["id"], uniqueKeys: [{ columns: ["email"], ignoreCase: true }], foreignKeys: [], rowCount: 3 },
        { name: "carts", columns: ["id", "userId"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [{ columns: ["userId"], references: { table: "users", columns: ["id"] } }], rowCount: 1 },
        { name: "cart_items", columns: ["cartId", "productId", "quantity"], primaryKey: ["cartId", "productId"], uniqueKeys: [], foreignKeys: [{ columns: ["cartId"], references: { table: "carts", columns: ["id"] } }], rowCount: 3 },
        { name: "orders", columns: ["id", "subtotal", "discount", "total"], primaryKey: ["id"], uniqueKeys: [], foreignKeys: [], rowCount: 2 },
    ],
});
const NAMES = new Set(SCHEMA.tables.flatMap((t) => [t.name, ...t.columns]));
const refused = (t: unknown, p?: unknown) => {
    try {
        validateCheck(t, p, SCHEMA);
        return false;
    } catch (e) {
        return e instanceof Error && e.message.startsWith(DB_REFUSED_PREFIX);
    }
};

const TEMPLATES: Array<[DbTemplate, Record<string, string | number | null>]> = [
    [{ kind: "exists", table: "users", where: ["email"] }, { email: "x" }],
    [{ kind: "count", table: "cart_items", where: [] }, {}],
    [{ kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } }, {}],
    [{ kind: "duplicates", table: "users", columns: ["email"], fold: true }, {}],
    [{ kind: "relation", table: "orders", where: [], expression: "total == subtotal - discount" }, {}],
];

describe("names outside the schema are refused", () => {
    it("every template is accepted with the schema's names", () => {
        for (const [t, p] of TEMPLATES) expect(() => validateCheck(t, p, SCHEMA)).not.toThrow();
    });

    it("property: any table or column name not in the schema, in any name slot of any template, is refused", () => {
        const notInSchema = fc.string({ minLength: 1, maxLength: 70 }).filter((s) => !NAMES.has(s));
        fc.assert(
            fc.property(notInSchema, fc.nat(TEMPLATES.length - 1), fc.nat(5), (bad, which, slot) => {
                const [t, p] = structuredClone(TEMPLATES[which]!);
                const x = t as Record<string, unknown> & { where?: string[]; columns?: string[]; references?: { table: string; columns: string[] } };
                const params = { ...p } as Record<string, unknown>;
                const slots: Array<() => void> = [() => (x.table = bad)];
                if (x.where) slots.push(() => { x.where = [...x.where!, bad]; params[bad] = 1; });
                if (x.columns) slots.push(() => (x.columns = [bad]));
                if (x.references) slots.push(() => (x.references!.table = bad), () => (x.references!.columns = [bad]));
                if (x.kind === "relation") slots.push(() => (x.expression = `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(bad) && !["and", "or", "implies", "true", "false", "null"].includes(bad) ? bad : "nope"} == 1`));
                slots[slot % slots.length]!();
                return refused(x, params);
            }),
            { numRuns: 500 },
        );
    });

    it("property: a schema keeps only plain identifier names, so a name with SQL in it can never be in a schema", () => {
        fc.assert(
            fc.property(fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 8 }), (names) => {
                const s = cleanSchema({ tables: names.map((n) => ({ name: n, columns: names, primaryKey: [], uniqueKeys: [], foreignKeys: [], rowCount: 0 })) });
                return s.tables.every((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.name) && t.columns.every((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c)));
            }),
        );
        expect(cleanSchema({ tables: [{ name: "users; DROP TABLE users", columns: ["id"] }, { name: "ok", columns: ["id", "a' OR '1'='1"] }] }).tables).toEqual([
            { name: "ok", columns: ["id"], primaryKey: [], uniqueKeys: [], foreignKeys: [], rowCount: 0 },
        ]);
    });

    it("keys in the schema whose columns do not exist are dropped", () => {
        const s = cleanSchema({ tables: [{ name: "a", columns: ["id"], primaryKey: ["nope"], uniqueKeys: [{ columns: ["id", "x"] }], foreignKeys: [{ columns: ["id"], references: { table: "b", columns: ["id"] } }] }] });
        expect(s.tables[0]).toMatchObject({ primaryKey: [], uniqueKeys: [], foreignKeys: [] });
    });
});

describe("a credential column is never compared (no oracle over it)", () => {
    const withSecrets = cleanSchema({ tables: [{ name: "accounts", columns: ["id", "email", "passwordHash", "apiToken"], primaryKey: ["id"] }] });
    it("exists, count and relation refuse a credential column; the other columns still work", () => {
        expect(() => validateCheck({ kind: "exists", table: "accounts", where: ["passwordHash"] }, { passwordHash: "$2b$" }, withSecrets)).toThrow(/sign-in details/);
        expect(() => validateCheck({ kind: "count", table: "accounts", where: ["apiToken"] }, { apiToken: "x" }, withSecrets)).toThrow(/sign-in details/);
        expect(() => validateCheck({ kind: "relation", table: "accounts", where: [], expression: "passwordHash != \"x\"" }, {}, withSecrets)).toThrow(/sign-in details/);
        expect(validateCheck({ kind: "exists", table: "accounts", where: ["email"] }, { email: "a@b.c" }, withSecrets).columnsRead).toEqual(["email"]);
    });
});

describe("there is no way to pass SQL text", () => {
    it("property: any extra field on a template (sql, query, raw, or anything else) is refused", () => {
        const extra = fc.string({ minLength: 1, maxLength: 20 }).filter((k) => !["kind", "table", "where", "columns", "references", "fold", "expression"].includes(k));
        fc.assert(
            fc.property(extra, fc.string(), fc.nat(TEMPLATES.length - 1), (k, text, which) => {
                const [t, p] = TEMPLATES[which]!;
                return refused({ ...t, [k]: text }, p);
            }),
            { numRuns: 300 },
        );
        for (const k of ["sql", "query", "raw", "statement"]) expect(refused({ kind: "count", table: "users", where: [], [k]: "SELECT * FROM users" }, {})).toBe(true);
    });

    it("a template that is text, an unknown kind, or a param that is not a plain value is refused", () => {
        expect(refused("SELECT * FROM users")).toBe(true);
        expect(refused({ kind: "sql", table: "users", text: "DELETE FROM users" })).toBe(true);
        expect(refused({ kind: "exists", table: "users", where: ["email"] }, { email: { $ne: null } })).toBe(true);
        expect(refused({ kind: "exists", table: "users", where: ["email"] }, { email: ["a"] })).toBe(true);
        // A param the where list does not name, or a missing one.
        expect(refused({ kind: "exists", table: "users", where: ["email"] }, { email: "a", name: "b" })).toBe(true);
        expect(refused({ kind: "exists", table: "users", where: ["email"] }, {})).toBe(true);
        expect(refused({ kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } }, { id: 1 })).toBe(true);
    });

    it("property: a relation outside the C5 grammar, or one that reads test values or list positions, is refused", () => {
        expect(refused({ kind: "relation", table: "orders", where: [], expression: "total == $x" }, {})).toBe(true);
        expect(refused({ kind: "relation", table: "orders", where: [], expression: "[0] == 1" }, {})).toBe(true);
        expect(refused({ kind: "relation", table: "orders", where: [], expression: "total; DROP TABLE orders" }, {})).toBe(true);
        fc.assert(
            fc.property(fc.string({ maxLength: 60 }).filter((s) => /[;'`]/.test(s)), (expr) => refused({ kind: "relation", table: "orders", where: [], expression: expr }, {})),
            { numRuns: 300 },
        );
    });
});

// Values made only of letters that no fingerprint (hex), mask ("•", digits, " characters") or name in a result can hold, so finding one
// in a result means a value leaked.
const SECRET = fc.string({ unit: fc.constantFrom(..."gjkmnpquvwxyzGJKMNPQUVWXYZ"), minLength: 3, maxLength: 12 });

describe("result values are never raw", () => {
    it("property: over random tables, every template's result holds no row value, at most 20 ids (32-hex) and 20 masked keys", () => {
        const row = fc.record({ id: SECRET, email: SECRET, name: SECRET });
        fc.assert(
            fc.property(fc.array(row, { maxLength: 60 }), fc.array(fc.record({ cartId: SECRET, productId: SECRET, quantity: SECRET }), { maxLength: 60 }), (users, items) => {
                const tables = { users, carts: users.slice(0, 3).map((u) => ({ id: u.id, userId: u.id })), cart_items: items, orders: users.map((u) => ({ id: u.id, subtotal: u.name, discount: 0, total: 1 })) };
                const values = [...users.flatMap((u) => Object.values(u)), ...items.flatMap((i) => Object.values(i))];
                const key = newEvidenceKey();
                for (const [t] of TEMPLATES) {
                    const r = runOnRows(validateCheck(t, t.kind === "exists" ? { email: users[0]?.email ?? "none" } : {}, SCHEMA), tables, key);
                    const text = JSON.stringify(r);
                    if (values.some((v) => text.includes(v))) return false;
                    if (r.ids.length > 20 || r.examples.length > 20 || r.ids.length !== Math.min(20, r.count)) return false;
                    if (!r.ids.every((x) => /^[0-9a-f]{32}$/.test(x)) || !r.examples.every((x) => /^•{1,6} \(\d+ characters\)$/.test(x))) return false;
                    if (Object.keys(r).sort().join() !== "count,examples,ids,kind,table") return false;
                }
                return true;
            }),
            { numRuns: 200 },
        );
    });

    it("a fingerprint compares within one evidence key only", () => {
        const v = validateCheck({ kind: "count", table: "users", where: [] }, {}, SCHEMA);
        const tables = { users: [{ id: "u1", email: "a@x.test", name: "A" }] };
        const k = newEvidenceKey();
        expect(runOnRows(v, tables, k).ids).toEqual(runOnRows(v, tables, k).ids);
        expect(runOnRows(v, tables, k).ids).not.toEqual(runOnRows(v, tables, newEvidenceKey()).ids);
    });
});

describe("what each template counts (from the spec's definitions)", () => {
    const k = newEvidenceKey();
    const run = (t: DbTemplate, tables: Record<string, Array<Record<string, unknown>>>, p: Record<string, string | number | null> = {}) => runOnRows(validateCheck(t, p, SCHEMA), tables, k).count;
    const users = [
        { id: "u1", email: "alice@example.test", name: "Alice" },
        { id: "u2", email: "ALICE@example.test", name: "Alice Again" },
        { id: "u3", email: null, name: "No mail" },
        { id: "u4", email: null, name: "No mail either" },
    ];

    it("a stored value matches what was sent when they are the same after the usual normalising: trimmed; e-mail addresses case-folded; dates the same instant or day", () => {
        const people = [{ id: "u9", email: "jane.doe@example.com", name: "Jane", born: "1990-05-01", seen: "2030-01-01T00:00:00.000Z" }];
        const t: DbTemplate = { kind: "exists", table: "users", where: ["email"] };
        // The API lowercased the address it was sent.
        expect(run(t, { users: people }, { email: "Jane.Doe@Example.com" })).toBe(1);
        expect(run(t, { users: people }, { email: " jane.doe@example.com " })).toBe(1);
        expect(run({ kind: "exists", table: "users", where: ["name"] }, { users: people }, { name: " Jane " })).toBe(1);
        expect(run({ kind: "exists", table: "users", where: ["name"] }, { users: [{ id: "u8", email: null, name: "Jane  " }] }, { name: "Jane" })).toBe(1);
        // Not an e-mail address: letter case still counts.
        expect(run({ kind: "exists", table: "users", where: ["name"] }, { users: people }, { name: "jane" })).toBe(0);
        const dates = { users: [{ id: "u9", email: "2030-01-01T00:00:00.000Z", name: "1990-05-01" }] };
        expect(run(t, dates, { email: "2030-01-01T00:00:00Z" })).toBe(1);
        expect(run(t, dates, { email: "2030-01-01T01:00:00+01:00" })).toBe(1);
        expect(run(t, dates, { email: "2030-01-01T00:00:01Z" })).toBe(0);
        expect(run({ kind: "exists", table: "users", where: ["name"] }, dates, { name: "1990-05-01T00:00:00Z" })).toBe(1);
        expect(run({ kind: "exists", table: "users", where: ["name"] }, dates, { name: "1990-05-02" })).toBe(0);
    });

    it("exists and count match bound values strictly (a number is not its text)", () => {
        expect(run({ kind: "exists", table: "users", where: ["id", "name"] }, { users }, { id: "u1", name: "Alice" })).toBe(1);
        expect(run({ kind: "exists", table: "users", where: ["id", "name"] }, { users }, { id: "u1", name: "Bob" })).toBe(0);
        expect(run({ kind: "count", table: "users", where: ["email"] }, { users }, { email: null })).toBe(2);
        expect(run({ kind: "count", table: "users", where: [] }, { users })).toBe(4);
        expect(run({ kind: "exists", table: "orders", where: ["total"] }, { orders: [{ id: "o", total: 5 }] }, { total: "5" })).toBe(0);
    });

    it("orphans: a row whose key points at no parent row; a null points at nothing", () => {
        const t: DbTemplate = { kind: "orphans", table: "cart_items", columns: ["cartId"], references: { table: "carts", columns: ["id"] } };
        const carts = [{ id: "c1", userId: "u1" }];
        expect(run(t, { carts, cart_items: [{ cartId: "c1", productId: "p1", quantity: 1 }] })).toBe(0);
        expect(run(t, { carts, cart_items: [{ cartId: "c1", productId: "p1" }, { cartId: "c9", productId: "p1" }, { cartId: "c9", productId: "p2" }, { cartId: null, productId: "p3" }] })).toBe(2);
    });

    it("duplicates: key values held twice; case-folded only with fold; nulls never clash", () => {
        expect(run({ kind: "duplicates", table: "users", columns: ["email"], fold: true }, { users })).toBe(1);
        expect(run({ kind: "duplicates", table: "users", columns: ["email"] }, { users })).toBe(0);
    });

    it("relation: rows on which the expression does not hold, narrowed by where", () => {
        const orders = [
            { id: "o1", subtotal: 1000, discount: 100, total: 900 },
            { id: "o2", subtotal: 1000, discount: 100, total: 1000 },
            { id: "o3", subtotal: "x", discount: 0, total: 0 },
        ];
        const t: DbTemplate = { kind: "relation", table: "orders", where: [], expression: "total == subtotal - discount" };
        expect(run(t, { orders })).toBe(2);
        expect(run({ ...t, where: ["id"] }, { orders }, { id: "o1" })).toBe(0);
    });
});
