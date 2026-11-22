/**
 * Whether a stored value is the value a test sent (C10 exists and count), after the normalising any application does: text is trimmed,
 * an e-mail address on either side is compared case-folded, and two dates are equal when they are the same instant, or the same day
 * when either is a date alone. Nothing else is normalised: other text keeps its letter case, and a number is not its text.
 * The probe (examples/db-probe/probe.mjs) and the bench SQLite back end register the same rule as an SQL function.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function dateOf(s: string): { day: string; ms?: number } | undefined {
    if (DAY.test(s)) return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? undefined : { day: s };
    if (!INSTANT.test(s)) return undefined;
    const ms = Date.parse(s.replace(" ", "T"));
    return Number.isNaN(ms) ? undefined : { day: new Date(ms).toISOString().slice(0, 10), ms };
}

export function sameStoredValue(stored: unknown, sent: unknown): boolean {
    if (typeof stored !== "string" || typeof sent !== "string") return stored === sent;
    const a = stored.trim();
    const b = sent.trim();
    if (a === b) return true;
    if (EMAIL.test(a) || EMAIL.test(b)) return a.toLowerCase() === b.toLowerCase();
    const da = dateOf(a);
    const db = dateOf(b);
    if (!da || !db) return false;
    return da.ms !== undefined && db.ms !== undefined ? da.ms === db.ms : da.day === db.day;
}
