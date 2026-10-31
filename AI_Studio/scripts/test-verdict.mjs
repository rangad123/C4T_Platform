// The release gate's rules, as pure functions (tests/test-run-unit.test.ts checks them). Used by scripts/test-run.mjs.

/** Per file from vitest's JSON results: duration, counts, failed test names, and an error outside the tests (a hook, an import). */
export function filesOf(results, rel) {
    const out = new Map();
    for (const f of results?.testResults ?? []) {
        const file = rel(f.name);
        const asserts = f.assertionResults ?? [];
        const failed = asserts.filter((a) => a.status === "failed").map((a) => a.fullName || [...(a.ancestorTitles ?? []), a.title].join(" > "));
        const firstLine = (m) => String(m).split("\n")[0].slice(0, 300);
        // A failed file with no failed test failed outside them (beforeAll/afterAll, an import); a hook message next to failed tests is kept too.
        const fileError = f.status === "failed" && failed.length === 0 ? firstLine(f.message || "the file failed outside its tests") : f.message && /hook/i.test(f.message) ? firstLine(f.message) : undefined;
        out.set(file, {
            file,
            ms: Math.max(0, (f.endTime ?? 0) - (f.startTime ?? 0)),
            tests: asserts.length,
            passed: asserts.filter((a) => a.status === "passed").length,
            skipped: asserts.filter((a) => a.status === "pending" || a.status === "skipped" || a.status === "todo").length,
            failed,
            ...(fileError ? { fileError } : {}),
        });
    }
    return out;
}

/** What the first attempt says must be looked at again: files with a failure, with an unhandled error, or that did not run. */
export function filesToRetry(first, unhandled, notRun) {
    return [...new Set([...[...first.values()].filter((f) => f.failed.length || f.fileError).map((f) => f.file), ...unhandled, ...notRun])];
}

const OUTSIDE = ["(file)", "(unhandled error)", "(not run)"];

/**
 * Failed on the first attempt and again on the retry: a failure. Failed once and passed on the retry (or the other way round): flaky.
 * No retry result (retries off, or the retry produced nothing): a failure. Never anything else: a problem is never dropped.
 * `second` maps a file to its retry result, which may carry `unhandled: true` or `noResult: true`.
 */
export function classify({ first, second, unhandled = [], notRun = [] }) {
    const failures = [];
    const flaky = [];
    for (const file of filesToRetry(first, unhandled, notRun)) {
        const a = first.get(file);
        const b = second.get(file);
        const problems = [...(a?.failed ?? []), ...(a?.fileError ? ["(file)"] : []), ...(unhandled.includes(file) ? ["(unhandled error)"] : []), ...(notRun.includes(file) ? ["(not run)"] : [])];
        for (const test of problems) {
            const detail = test === "(file)" ? a.fileError : test === "(unhandled error)" ? "an error outside any test, while this file ran" : test === "(not run)" ? "the file did not run" : "";
            const again = !b || b.noResult || b.unhandled || Boolean(b.fileError) || (OUTSIDE.includes(test) ? b.failed.length > 0 : b.failed.includes(test));
            (again ? failures : flaky).push({ file, test, detail, retried: Boolean(b) });
        }
        for (const test of b?.failed ?? []) if (!problems.includes(test)) flaky.push({ file, test, detail: "passed on the first attempt, failed on the retry", retried: true });
    }
    return { failures, flaky };
}

/** The reviewed allow-list: at most 20 entries, each with file, test, a reason and an expiry date no more than 90 days ahead. */
export function readAllowlist(parsed, today = new Date()) {
    const problems = [];
    const entries = Array.isArray(parsed?.allowed) ? parsed.allowed : [];
    if (parsed !== undefined && !Array.isArray(parsed?.allowed)) problems.push('The allow-list needs an "allowed" array.');
    const day = today.toISOString().slice(0, 10);
    const limit = new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
    const valid = [];
    for (const e of entries.slice(0, 20)) {
        const id = `${e?.file ?? "?"} > ${e?.test ?? "?"}`;
        if (typeof e?.file !== "string" || typeof e?.test !== "string" || !e.test) problems.push(`Entry ${id}: needs "file" and "test" (the full test name, or "(file)" for an error outside the tests).`);
        else if (typeof e.reason !== "string" || e.reason.trim().length < 10) problems.push(`Entry ${id}: needs a reason.`);
        else if (typeof e.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) problems.push(`Entry ${id}: needs "expires" as YYYY-MM-DD.`);
        else if (e.expires < day) problems.push(`Entry ${id}: expired on ${e.expires}; it no longer allows anything.`);
        else if (e.expires > limit) problems.push(`Entry ${id}: expires ${e.expires}, more than 90 days ahead; shorten it.`);
        else valid.push(e);
    }
    if (entries.length > 20) problems.push(`The allow-list has ${entries.length} entries; only the first 20 are read. Fix the flaky tests instead.`);
    return { valid, problems };
}

/** The entry that allows this flaky result, if any. "(file)" in an entry covers the errors outside the tests of that file. */
export const allowedBy = (valid, f) => valid.find((e) => e.file === f.file && (e.test === f.test || (e.test === "(file)" && OUTSIDE.includes(f.test))));

/** The gate: no failure, and every flaky result allowed. */
export function gate({ failures, flaky }, valid) {
    const allowed = flaky.filter((f) => allowedBy(valid, f));
    const blocking = flaky.filter((f) => !allowedBy(valid, f));
    return { ok: failures.length === 0 && blocking.length === 0, allowed, blocking };
}
