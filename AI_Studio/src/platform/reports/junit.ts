/** One test's latest result, in the shape the JUnit writer needs (no database access here). */
export interface JunitCase {
    suite: string;
    testKey: string;
    title: string;
    kind: string;
    priority: string;
    validationStatus: string;
    validationReason: string | null;
    /** The most recent execution; absent when the test never ran. */
    last?: { status: string; durationMs: number | null; error: string | null };
    /** In quarantine: a failure is reported as skipped ("quarantined: reason") and does not count as a failure. */
    quarantine?: { reason: string };
}

const esc = (s: string) =>
    s
        // XML 1.0 forbids most control characters, even escaped.
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/**
 * JUnit XML of each test's most recent validation run — for CI systems and test-management tools.
 * Never-executed tests are <skipped/>; NEEDS_REVIEW findings are failures (type "application-finding").
 * Shared by the REST endpoint and the `ai-test` command so both produce identical files.
 */
export function buildJunit(suiteName: string, tests: JunitCase[]): string {
    let failures = 0;
    let skipped = 0;
    let time = 0;
    const cases = tests.map((t) => {
        const last = t.last;
        const secs = (last?.durationMs ?? 0) / 1000;
        time += secs;
        const open = `    <testcase classname="${esc(t.suite)}" name="${esc(`${t.testKey}: ${t.title}`)}" time="${secs.toFixed(3)}">`;
        const props = `\n      <properties><property name="validation" value="${t.validationStatus}"/><property name="kind" value="${t.kind}"/><property name="priority" value="${t.priority}"/></properties>`;
        if (!last) {
            skipped++;
            return `${open}${props}\n      <skipped message="not executed"/>\n    </testcase>`;
        }
        if ((last.status !== "passed" || t.validationStatus === "NEEDS_REVIEW") && t.quarantine) {
            skipped++;
            return `${open}${props}` + `
      <skipped message="${esc(`quarantined: ${t.quarantine.reason}`.slice(0, 300))}"/>
    </testcase>`;
        }
        if (last.status !== "passed" || t.validationStatus === "NEEDS_REVIEW") {
            failures++;
            const type = t.validationStatus === "NEEDS_REVIEW" ? "application-finding" : "test-failure";
            const message = t.validationReason ?? last.error ?? last.status;
            return `${open}${props}\n      <failure type="${type}" message="${esc(message.split("\n")[0]!.slice(0, 300))}">${esc(message)}</failure>\n    </testcase>`;
        }
        return `${open}${props}\n    </testcase>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(suiteName)}" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n  <testsuite name="${esc(suiteName)}" tests="${tests.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n${cases.join("\n")}\n  </testsuite>\n</testsuites>\n`;
}
