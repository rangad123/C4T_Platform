/**
 * The asynchronous database interface (POSTGRES_S3_MIGRATION.md §3.2). Stores move to it one group at a time (stages M2–M3);
 * until then it lives beside the synchronous `Db`, on the same SQLite connection, and the PostgreSQL adapter arrives in M4.
 *
 * The rule every caller keeps: a `tx` body awaits nothing but the database `t`. On SQLite each call resolves from the
 * synchronous statement, so such a body runs to its end through microtasks alone, and no request or timer (macrotasks) can
 * run in the middle: atomicity is exactly what `Db.tx` gives today. A body that yields to the event loop breaks that, and
 * the adapter reports it (an error under tests, a log line in production).
 *
 * Microtasks alone are not enough on their own: between two of the body's awaits, any other continuation already in the
 * microtask queue runs, and a sibling job's `db.tx` there would fail on the open transaction (a real validation run did exactly
 * that). So a transaction begins on a fresh macrotask, where that queue is empty and only the body's own continuations follow.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SQLInputValue } from "node:sqlite";
// From node:timers, not the globals: a test that fakes timers must not stop the rule's watch from firing.
import { clearImmediate, setImmediate } from "node:timers";
import type { Db, Row } from "./db.js";
import type { Dialect } from "./sql-dialect.js";

export type SqlParam = SQLInputValue;

export interface Sql {
    /** The SQL that differs between SQLite and PostgreSQL (sql-dialect.ts). */
    readonly dialect: Dialect;
    get<T = Row>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;
    all<T = Row>(sql: string, ...params: SqlParam[]): Promise<T[]>;
    /** No last insert id: a statement that needs the new key uses `RETURNING` with `get`. */
    run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }>;
    /** Runs `fn` in one transaction: commits when it resolves, rolls back when it rejects. Transactions do not nest. */
    tx<T>(fn: (t: Sql) => Promise<T>): Promise<T>;
}

/** A `tx` body that yielded to the event loop (thrown under tests; logged in production). */
export class SqlTxRuleError extends Error {
    constructor() {
        super(
            "A transaction body awaited something other than the database (a timer, a network or file call), so other work could run in the middle of it. Do that work before or after the transaction (POSTGRES_S3_MIGRATION.md §3.2).",
        );
        this.name = "SqlTxRuleError";
    }
}

interface TxState {
    ended: boolean;
    /** The watch scheduled at BEGIN ran before the body settled: the body yielded to the event loop. */
    yielded: boolean;
    /** Resolves when the transaction has committed or rolled back. */
    done: Promise<void>;
}

const NO_NESTING = "Transactions do not nest: run this work in the enclosing transaction's body.";

const inTx = new AsyncLocalStorage<TxState>();
const settle = <R>(op: () => R | Promise<R>): Promise<R> => {
    try {
        return Promise.resolve(op());
    } catch (e) {
        return Promise.reject(e);
    }
};

class SqliteSql implements Sql {
    readonly dialect: Dialect;
    private open: TxState | null = null;

    constructor(
        private readonly db: Db,
        private readonly strict: boolean,
    ) {
        this.dialect = db.dialect;
    }

    get<T = Row>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
        return this.when(() => this.db.get<T>(sql, ...params));
    }
    all<T = Row>(sql: string, ...params: SqlParam[]): Promise<T[]> {
        return this.when(() => this.db.all<T>(sql, ...params));
    }
    run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }> {
        return this.when(() => ({ changes: Number(this.db.run(sql, ...params).changes) }));
    }
    tx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
        if (this.open && inTx.getStore() === this.open) return Promise.reject(new Error(NO_NESTING));
        return new Promise<T>((resolve, reject) => {
            const start = (): void => {
                // Only a body that broke the rule is still open here.
                if (this.open) void this.open.done.then(() => setImmediate(start));
                else this.runTx(fn).then(resolve, reject);
            };
            setImmediate(start);
        });
    }

    /**
     * Runs `op` now, or after the open transaction ends: outside work never lands inside someone else's transaction, even when a
     * body broke the rule. Work started by the body itself joins the transaction (`inTx` knows), so a store method called from a body
     * needs no handle passed down. The PostgreSQL adapter must do the same with the same AsyncLocalStorage: the body's client.
     */
    private when<R>(op: () => R | Promise<R>): Promise<R> {
        const open = this.open;
        if (!open) return settle(op);
        if (inTx.getStore() === open) return settle(op);
        return open.done.then(() => this.when(op));
    }

    private async runTx<T>(fn: (t: Sql) => Promise<T>): Promise<T> {
        this.db.raw.exec("BEGIN IMMEDIATE");
        let release!: () => void;
        const state: TxState = { ended: false, yielded: false, done: new Promise<void>((r) => (release = r)) };
        this.open = state;
        // A macrotask runs only once the microtask queue is empty, so it runs before the body settles only if the body yielded.
        const watch = setImmediate(() => (state.yielded = true));
        try {
            const out = await inTx.run(state, () => fn(new TxHandle(this.db, state)));
            if (state.yielded && this.strict) throw new SqlTxRuleError();
            this.db.raw.exec("COMMIT");
            return out;
        } catch (e) {
            this.db.raw.exec("ROLLBACK");
            throw e;
        } finally {
            clearImmediate(watch);
            state.ended = true;
            this.open = null;
            release();
            if (state.yielded && !this.strict) console.warn(`[sql] ${new SqlTxRuleError().message}`);
        }
    }
}

/** The handle a `tx` body receives: its statements run inside the transaction, and only until it ends. */
class TxHandle implements Sql {
    readonly dialect: Dialect;

    constructor(
        private readonly db: Db,
        private readonly state: TxState,
    ) {
        this.dialect = db.dialect;
    }

    get<T = Row>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
        return this.live(() => this.db.get<T>(sql, ...params));
    }
    all<T = Row>(sql: string, ...params: SqlParam[]): Promise<T[]> {
        return this.live(() => this.db.all<T>(sql, ...params));
    }
    run(sql: string, ...params: SqlParam[]): Promise<{ changes: number }> {
        return this.live(() => ({ changes: Number(this.db.run(sql, ...params).changes) }));
    }
    /** Like `Db.tx`, which throws when a transaction is already open. */
    tx<T>(): Promise<T> {
        return Promise.reject(new Error(NO_NESTING));
    }

    private live<R>(op: () => R): Promise<R> {
        if (this.state.ended) return Promise.reject(new Error("This transaction has already ended; its handle cannot be used any more."));
        return settle(op);
    }
}

const adapters = new WeakMap<Db, SqliteSql>();

/**
 * The `Sql` of a SQLite `Db`. One per connection, so every caller shares its view of the open transaction.
 * `strict` (default: under Vitest) throws on a `tx` body that yields to the event loop instead of logging it; it applies when the
 * connection's adapter is created, by its first call here.
 */
export function sqliteSql(db: Db, opts: { strict?: boolean } = {}): Sql {
    let s = adapters.get(db);
    if (!s) adapters.set(db, (s = new SqliteSql(db, opts.strict ?? Boolean(process.env.VITEST))));
    return s;
}
