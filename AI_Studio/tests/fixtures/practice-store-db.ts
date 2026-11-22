/**
 * A local SQLite database shaped like the practice store's data (users, products, orders and their lines; the store itself keeps them
 * in memory), for the database probe tests. Never a copy of a live site. It holds one seeded defect: an order line whose product does
 * not exist (an orphan along order_lines.product_id). Also a sessions table and a password column that the probe's allow-list leaves out.
 */
import { createRequire } from "node:module";

/** Values that must never appear in anything the probe or the engine returns. */
export const PRIVATE_VALUES = ["user@practice.test", "admin@practice.test", "Pat Practice", "Ada Admin", "pbkdf2$secret-hash-1", "sess-token-abcdef"];

export const PRACTICE_ALLOW = {
    users: ["id", "email", "name", "role"],
    products: ["id", "name", "category", "price_mills", "stock"],
    orders: ["id", "user_id", "status", "subtotal", "total"],
    order_lines: ["id", "order_id", "product_id", "qty", "line_total"],
};

export function makePracticeStoreDb(file: string, extraRows = 0): void {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    // The seeded orphan is what a database without enforced foreign keys can hold.
    const d = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    d.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL);
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price_mills INTEGER NOT NULL, stock INTEGER NOT NULL);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL);
        CREATE TABLE order_lines (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), qty INTEGER NOT NULL, line_total INTEGER NOT NULL);
        CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
        INSERT INTO users VALUES (1, 'user@practice.test', 'Pat Practice', 'customer', 'pbkdf2$secret-hash-1'), (2, 'admin@practice.test', 'Ada Admin', 'admin', 'pbkdf2$secret-hash-2');
        INSERT INTO products VALUES (1, 'The Patient Tester', 'books', 14990, 25), (5, 'Pixel Racers', 'games', 19990, 30), (19, 'Loose Tea (per 100 g)', 'kitchen', 4995, 60);
        INSERT INTO orders VALUES (1001, 1, 'delivered', 2498, 2498), (1002, 1, 'shipped', 1999, 1999);
        INSERT INTO order_lines VALUES (1, 1001, 1, 1, 1499), (2, 1001, 19, 2, 999), (3, 1002, 5, 1, 1999), (4, 1002, 999, 1, 0);
        INSERT INTO sessions VALUES ('sess-token-abcdef', 1);
    `);
    if (extraRows) {
        d.exec("BEGIN");
        const ins = d.prepare("INSERT INTO products (name, category, price_mills, stock) VALUES (?, ?, ?, ?)");
        for (let i = 0; i < extraRows; i++) ins.run(`Product ${i % 997}`, "bulk", i, i % 50);
        d.exec("COMMIT");
    }
    d.close();
}
