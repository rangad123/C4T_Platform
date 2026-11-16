/**
 * Database schema files as a source of application knowledge: the SQL and Prisma parser (pure, no database, no model: fast tier).
 */
import { describe, expect, it } from "vitest";
import { ModelFragmentSchema } from "../src/engine/intel/fragment.js";
import { MAX_SCHEMA_INPUT, parseSchema, schemaFragment } from "../src/engine/intel/sources/db-schema.js";
import { fingerprintText } from "../src/engine/intel/sources/fingerprint.js";

const SQL = `-- shop schema
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped');

CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "orders" (
    id integer NOT NULL,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total numeric(10, 2) NOT NULL CHECK (total >= 0),
    status order_status DEFAULT 'pending',
    note text DEFAULT 'a; b',
    CONSTRAINT orders_pk PRIMARY KEY (id),
    CONSTRAINT one_per_user UNIQUE (user_id, status)
);

CREATE TABLE order_items (
    order_id integer NOT NULL,
    sku text NOT NULL,
    qty integer CHECK (qty > 0 AND qty < 100),
    PRIMARY KEY (order_id, sku),
    FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE INDEX orders_user ON orders (user_id);
ALTER TABLE ONLY order_items ADD CONSTRAINT items_sku_fk FOREIGN KEY (sku) REFERENCES products(sku);
`;

const PRISMA = `// shop schema
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  CUSTOMER @map("customer")
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(CUSTOMER)
  posts     Post[]
}

model Post {
  id       Int     @id @default(autoincrement())
  title    String  @db.VarChar(200)
  tags     String[]
  author   User    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int
  @@unique([authorId, title])
}

model Membership {
  userId Int
  teamId Int
  @@id([userId, teamId])
}
`;

describe("SQL CREATE TABLE", () => {
    const schema = parseSchema(SQL);
    const table = (n: string) => schema.tables.find((t) => t.name === n)!;
    const col = (t: string, c: string) => table(t).columns.find((x) => x.name === c)!;

    it("reads every table with its columns and types, schema prefix and quotes removed", () => {
        expect(schema.dialect).toBe("sql");
        expect(schema.tables.map((t) => t.name)).toEqual(["users", "orders", "order_items"]);
        expect(table("users").columns.map((c) => c.name)).toEqual(["id", "email", "name", "created_at"]);
        expect(col("users", "email").type).toBe("VARCHAR(255)");
        expect(col("users", "created_at").type).toBe("timestamp with time zone");
        expect(col("orders", "total").type).toBe("numeric(10, 2)");
    });

    it("records NOT NULL, UNIQUE, DEFAULT and CHECK on columns", () => {
        expect(col("users", "email")).toMatchObject({ nullable: false, unique: true });
        expect(col("users", "name")).toMatchObject({ nullable: true, unique: false });
        expect(col("users", "created_at")).toMatchObject({ default: "now()", nullable: false });
        expect(col("orders", "status").default).toBe("'pending'");
        expect(col("orders", "note").default).toBe("'a; b'");
        expect(col("orders", "total").check).toBe("total >= 0");
        expect(table("orders").checks).toEqual([{ expression: "total >= 0", line: 14 }]);
        expect(table("order_items").checks[0].expression).toBe("qty > 0 AND qty < 100");
    });

    it("reads primary keys inline and at table level", () => {
        expect(table("users").primaryKey).toEqual(["id"]);
        expect(col("users", "id")).toMatchObject({ primaryKey: true, nullable: false });
        expect(table("orders").primaryKey).toEqual(["id"]);
        expect(col("orders", "id").primaryKey).toBe(true);
        expect(table("order_items").primaryKey).toEqual(["order_id", "sku"]);
    });

    it("reads table-level UNIQUE as a column group", () => {
        expect(table("orders").unique).toEqual([["user_id", "status"]]);
    });

    it("reads foreign keys inline, at table level and from ALTER TABLE, each with its line", () => {
        expect(table("orders").foreignKeys).toEqual([{ columns: ["user_id"], table: "users", refColumns: ["id"], line: 13 }]);
        expect(table("order_items").foreignKeys).toEqual([
            { columns: ["order_id"], table: "orders", refColumns: ["id"], line: 26 },
            { columns: ["sku"], table: "products", refColumns: ["sku"], line: 30 },
        ]);
    });

    it("reads CREATE TYPE … AS ENUM", () => {
        expect(schema.enums).toEqual([{ name: "order_status", values: ["pending", "paid", "shipped"], line: 2 }]);
    });

    it("skips and counts statements it does not read, and never acts on them", () => {
        expect(schema.skipped).toBe(1); // CREATE INDEX
        const other = parseSchema("DROP TABLE users; COPY users FROM PROGRAM 'rm -rf /'; GRANT ALL ON users TO public;");
        expect(other.tables).toEqual([]);
        expect(other.skipped).toBe(3);
    });

    it("reads a column whose name is a keyword (key, index, unique) as a column, and a MySQL index line as no column", () => {
        const s = parseSchema("CREATE TABLE settings (key varchar(50) NOT NULL, index int, KEY settings_key (key), UNIQUE KEY uk (index));");
        expect(s.tables[0].columns.map((c) => [c.name, c.type])).toEqual([["key", "varchar(50)"], ["index", "int"]]);
    });

    it("records the line of each table and column", () => {
        expect(table("users").line).toBe(4);
        expect(col("users", "email").line).toBe(6);
    });
});

describe("Prisma schema", () => {
    const schema = parseSchema(PRISMA);
    const model = (n: string) => schema.tables.find((t) => t.name === n)!;
    const field = (t: string, c: string) => model(t).columns.find((x) => x.name === c);

    it("reads models as tables and relation fields are not columns", () => {
        expect(schema.dialect).toBe("prisma");
        expect(schema.tables.map((t) => t.name)).toEqual(["User", "Post", "Membership"]);
        expect(model("User").columns.map((c) => c.name)).toEqual(["id", "email", "name", "role"]);
        expect(field("Post", "author")).toBeUndefined();
    });

    it("reads @id, @unique, optional, lists, defaults and native types", () => {
        expect(field("User", "id")).toMatchObject({ type: "Int", primaryKey: true, nullable: false, default: "autoincrement()" });
        expect(model("User").primaryKey).toEqual(["id"]);
        expect(field("User", "email")).toMatchObject({ unique: true, nullable: false });
        expect(field("User", "name")).toMatchObject({ type: "String", nullable: true });
        expect(field("Post", "tags")).toMatchObject({ type: "String[]", nullable: false });
        expect(field("User", "role")).toMatchObject({ type: "Role", default: "CUSTOMER" });
    });

    it("reads @relation with fields and references as a foreign key on its line; a back-relation is not one", () => {
        expect(model("Post").foreignKeys).toEqual([{ columns: ["authorId"], table: "User", refColumns: ["id"], line: 24 }]);
        expect(model("User").foreignKeys).toEqual([]);
    });

    it("a named back-relation without fields is not a foreign key", () => {
        const s = parseSchema('model User {\n  id Int @id\n  posts Post[] @relation("Written")\n}\nmodel Post {\n  id Int @id\n}\n');
        expect(s.tables[0].foreignKeys).toEqual([]);
        expect(s.tables[0].columns.map((c) => c.name)).toEqual(["id"]);
    });

    it("reads @@unique and @@id", () => {
        expect(model("Post").unique).toEqual([["authorId", "title"]]);
        expect(model("Membership").primaryKey).toEqual(["userId", "teamId"]);
    });

    it("reads enums and counts other blocks as skipped", () => {
        expect(schema.enums).toEqual([{ name: "Role", values: ["ADMIN", "CUSTOMER"], line: 7 }]);
        expect(schema.skipped).toBe(1); // datasource
    });
});

describe("caps and hostile input", () => {
    it("reads at most 500 tables and says so", () => {
        const text = Array.from({ length: 510 }, (_, i) => `CREATE TABLE t${i} (id int);`).join("\n");
        const s = parseSchema(text);
        expect(s.tables).toHaveLength(500);
        expect(s.truncated.join(" ")).toMatch(/500 tables/);
    });

    it("reads at most 200 columns per table and says so", () => {
        const cols = Array.from({ length: 250 }, (_, i) => `c${i} int`).join(", ");
        const s = parseSchema(`CREATE TABLE wide (${cols});`);
        expect(s.tables[0].columns).toHaveLength(200);
        expect(s.truncated.join(" ")).toMatch(/200 columns/);
    });

    it("reads only the first 1 MB and says so", () => {
        const s = parseSchema("CREATE TABLE a (id int);" + " ".repeat(MAX_SCHEMA_INPUT) + "CREATE TABLE b (id int);");
        expect(s.tables.map((t) => t.name)).toEqual(["a"]);
        expect(s.truncated.join(" ")).toMatch(/1 MB/);
    });

    it.each([
        ["open parentheses", "CREATE TABLE a (" + "(".repeat(MAX_SCHEMA_INPUT - 20)],
        ["unterminated string", "CREATE TABLE a (b text DEFAULT '" + "x".repeat(MAX_SCHEMA_INPUT - 40)],
        ["unterminated comment", "/*" + "*".repeat(MAX_SCHEMA_INPUT - 2)],
        ["many tiny columns", "CREATE TABLE a (" + "b int,".repeat(Math.floor(MAX_SCHEMA_INPUT / 6) - 4) + "c int);"],
        ["many statements", "CREATE TABLE a (id int);".repeat(Math.floor(MAX_SCHEMA_INPUT / 24))],
        ["prisma braces", "model A {\n" + "{".repeat(MAX_SCHEMA_INPUT - 20)],
        ["prisma fields", "model A {\n" + "f Int @default(1)\n".repeat(Math.floor(MAX_SCHEMA_INPUT / 18) - 1) + "}"],
    ])("a 1 MB pathological input (%s) finishes under 1 s", (_name, text) => {
        const started = performance.now();
        parseSchema(text);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

describe("schema file -> model fragment", () => {
    const NOW = "2026-11-16T00:00:00.000Z";

    it("turns tables into entities with types and constraints, each with its file and line as evidence", () => {
        const f = schemaFragment(SQL, { ref: "db/schema.sql", now: NOW });
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
        expect(f.model.entities.map((e) => e.name)).toEqual(["users", "orders", "order_items"]);
        const users = f.model.entities[0]!;
        expect(users.evidence).toEqual([{ kind: "file", ref: "db/schema.sql:4" }]);
        expect(users.fields.find((x) => x.name === "email")).toEqual({ name: "email", type: "VARCHAR(255)", constraints: ["not null", "unique"] });
        expect(users.fields.find((x) => x.name === "id")!.constraints).toEqual(["primary key", "not null"]);
        const orders = f.model.entities[1]!;
        expect(orders.fields.find((x) => x.name === "total")!.constraints).toEqual(["not null", "check (total >= 0)"]);
        expect(orders.fields.find((x) => x.name === "user_id")!.constraints).toEqual(["not null", "references users(id)"]);
        expect(orders.fields.find((x) => x.name === "status")!.constraints).toEqual(["default 'pending'", "one of: pending, paid, shipped"]);
    });

    it("records a relationship for each foreign key, with the line that states it", () => {
        const f = schemaFragment(SQL, { ref: "db/schema.sql", now: NOW });
        expect(f.model.relationships.map((r) => `${r.from} ${r.kind} ${r.to} @ ${r.evidence[0]!.ref}`)).toEqual([
            "orders belongs_to users @ db/schema.sql:13",
            "order_items belongs_to orders @ db/schema.sql:26",
            "order_items belongs_to products @ db/schema.sql:30",
        ]);
    });

    it("never records a relationship without a foreign key line (a Prisma back-relation, a column merely named like a table)", () => {
        const prisma = schemaFragment(PRISMA, { ref: "prisma/schema.prisma", now: NOW });
        expect(prisma.model.relationships.map((r) => `${r.from} ${r.kind} ${r.to} @ ${r.evidence[0]!.ref}`)).toEqual(["Post belongs_to User @ prisma/schema.prisma:24"]);
        const sql = schemaFragment("CREATE TABLE users (id int);\nCREATE TABLE orders (id int, user_id int, users_count int);", { ref: "s.sql", now: NOW });
        expect(sql.model.relationships).toEqual([]);
    });

    it("lists enum values as possible states of the columns that use them, never as transitions or rules", () => {
        const f = schemaFragment(PRISMA, { ref: "prisma/schema.prisma", now: NOW });
        expect(f.model.entities.find((e) => e.name === "User")!.fields.find((x) => x.name === "role")!.constraints).toContain("one of: ADMIN, CUSTOMER");
        expect(f.model.transitions).toEqual([]);
        expect(f.rules).toEqual([]);
        expect(f.notes.join(" ")).toMatch(/Role.*ADMIN, CUSTOMER/);
    });

    it("its source record is processed with the text fingerprint; skipped statements and caps become notes", () => {
        const f = schemaFragment(SQL, { ref: "db/schema.sql", now: NOW });
        expect(f.source).toEqual({ kind: "db_schema", ref: "db/schema.sql", fingerprint: fingerprintText(SQL), status: "processed", processedAt: NOW });
        expect(f.model.contextSources).toEqual(["db_schema"]);
        expect(f.notes.join(" ")).toMatch(/1 statement .*not read/);
    });

    it("records at most 2000 relationships and says so", () => {
        const table = (n: number) => `CREATE TABLE t${n} (${Array.from({ length: 200 }, (_, i) => `c${i} int REFERENCES users(id)`).join(", ")});`;
        const f = schemaFragment(["CREATE TABLE users (id int);", ...Array.from({ length: 11 }, (_, n) => table(n))].join("\n"), { ref: "big.sql", now: NOW });
        expect(f.model.relationships).toHaveLength(2000);
        expect(f.notes).toContain("Only the first 2000 foreign keys were recorded as relationships.");
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
    });

    it("a file with no table fails its source with a sentence", () => {
        const f = schemaFragment("SELECT 1;", { ref: "x.sql", now: NOW });
        expect(f.source.status).toBe("failed");
        expect(f.source.error).toMatch(/no table/i);
        expect(() => ModelFragmentSchema.parse(f)).not.toThrow();
    });

    it("secret-looking defaults and checks are hidden before storage", () => {
        const f = schemaFragment("CREATE TABLE keys (id int, stripe text DEFAULT 'sk_live_51Habcdefgh', gh text DEFAULT \"ghp_abcdefghij1234567890\", api_token text DEFAULT 'plain-looking-value', note text CHECK (note <> 'Hunter2!Secret'));", { ref: "k.sql", now: NOW });
        const text = JSON.stringify(f);
        for (const secret of ["sk_live_51Habcdefgh", "ghp_abcdefghij1234567890", "plain-looking-value", "Hunter2!Secret"]) expect(text).not.toContain(secret);
    });
});

