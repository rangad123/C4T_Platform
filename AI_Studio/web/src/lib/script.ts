/**
 * Where the test itself starts in a generated script. The generators write the platform's own code first (evidence helpers, the
 * sign-in origin check, data and the hooks) and the test after it, and there is no marker between them, so the body is found by its
 * first top-level `test(` (or the `for` loop that repeats it once per row of test data). A script with neither is shown whole.
 */
const BODY_START = /^(?:for \(const \[rowIndex, row\] of ROWS\.entries\(\)\) \{|test\.describe\(|test\()/m;
/** A short preamble is not worth folding away. */
const MIN_SETUP_LINES = 8;

export function splitScript(code: string): { setup: string; body: string; setupLines: number } | null {
    const at = code.search(BODY_START);
    if (at <= 0) return null;
    const setup = code.slice(0, at).replace(/\s+$/, "");
    const setupLines = setup.split("\n").length;
    if (setupLines < MIN_SETUP_LINES) return null;
    return { setup, body: code.slice(at), setupLines };
}
