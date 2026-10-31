/**
 * Sign-in throttling, kept in memory (one platform process; a restart forgets it, which is acceptable for a guessing brake):
 * - per address: at most IP_LIMIT attempts in IP_WINDOW_MS (sign-in, setting a password from a link);
 * - per email: after FAILS_BEFORE_LOCK wrong passwords in a row the email is locked for LOCK_MS, for known and unknown emails alike,
 *   so the answer never tells whether an account exists.
 */
export const IP_LIMIT = 20;
export const IP_WINDOW_MS = 10 * 60_000;
export const FAILS_BEFORE_LOCK = 5;
export const LOCK_MS = 15 * 60_000;
const MAX_KEYS = 10_000;

export class SignInLimiter {
    private readonly hits = new Map<string, number[]>();
    private readonly fails = new Map<string, { count: number; lockedUntil: number }>();

    constructor(private readonly now: () => number = Date.now) {}

    private cap<V>(m: Map<string, V>): void {
        if (m.size <= MAX_KEYS) return;
        // Maps keep insertion order: drop the oldest tenth.
        let drop = Math.ceil(MAX_KEYS / 10);
        for (const k of m.keys()) {
            if (drop-- <= 0) break;
            m.delete(k);
        }
    }

    /** Counts an attempt from an address; the number of minutes to wait when over the limit, else 0. */
    hit(ip: string): number {
        const t = this.now();
        const list = (this.hits.get(ip) ?? []).filter((x) => t - x < IP_WINDOW_MS);
        if (list.length >= IP_LIMIT) {
            this.hits.set(ip, list);
            return Math.max(1, Math.ceil((list[0]! + IP_WINDOW_MS - t) / 60_000));
        }
        list.push(t);
        this.hits.delete(ip);
        this.hits.set(ip, list);
        this.cap(this.hits);
        return 0;
    }

    /** Minutes left while the email is locked, else 0. */
    locked(email: string): number {
        const f = this.fails.get(email);
        if (!f || f.lockedUntil <= this.now()) return 0;
        return Math.max(1, Math.ceil((f.lockedUntil - this.now()) / 60_000));
    }

    /** A wrong password: true when this one locked the email. */
    failed(email: string): boolean {
        const f = this.fails.get(email) ?? { count: 0, lockedUntil: 0 };
        if (f.lockedUntil && f.lockedUntil <= this.now()) f.count = 0;
        f.count++;
        const lockedNow = f.count >= FAILS_BEFORE_LOCK;
        if (lockedNow) {
            f.lockedUntil = this.now() + LOCK_MS;
            f.count = 0;
        }
        this.fails.delete(email);
        this.fails.set(email, f);
        this.cap(this.fails);
        return lockedNow;
    }

    succeeded(email: string): void {
        this.fails.delete(email);
    }
}
