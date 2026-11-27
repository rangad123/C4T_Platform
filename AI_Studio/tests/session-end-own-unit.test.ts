/**
 * A test that ends a session (risky.ts) skips itself only when the sign-out would carry the project's shared credentials: a test that
 * signs in or signs up by itself first signs out that session alone, without the shared credentials (the frozen PR-bench suite's logout
 * tests), and an API test whose run has no shared credentials has no shared session to end. A sign-out with the shared token and no sign-in
 * of its own (N2D API-016: the store's logout revoked the saved token) still skips whenever the run has a token, header or account.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiGenerator } from "../src/engine/generators/api.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { endsSharedSession, SESSION_END_SKIPPED } from "../src/engine/validation/risky.js";

const ctx = { baseUrl: "http://127.0.0.1:5591" };
const parse = (testId: string, steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId, title: testId, kind: "api", category: "Accounts", steps, ...extra });

/** Whether the rendered script skips itself under `env` (its session-end line evaluated), or "no line". */
function skipsUnder(script: string, env: Record<string, string>): boolean | "no line" {
    const line = script.split("\n").find((l) => l.includes(JSON.stringify(SESSION_END_SKIPPED)));
    if (!line) return "no line";
    const cond = line.trim().slice("test.skip(".length, line.trim().indexOf(`, ${JSON.stringify(SESSION_END_SKIPPED)}`));
    return Boolean(new Function("process", `return ${cond};`)({ env }));
}

describe("session-ending tests", () => {
    it("the frozen suite's three logout tests sign in themselves: they run, and the sign-out goes without the shared credentials", async () => {
        const { SUITE } = (await import(path.join(import.meta.dirname, "..", "examples", "bench-repo", "suite.mjs"))) as { SUITE: Record<string, Array<{ title: string; steps: unknown[] }>> };
        const logouts = Object.values(SUITE).flat().filter((t) => t.steps.some((s) => (s as { path?: string }).path === "/api/logout"));
        expect(logouts.map((t) => t.title).sort()).toEqual(["A session that signed out gives no access", "Five failed sign-ins lock the email for a minute", "Signing out ends the session"]);
        for (const [i, t] of logouts.entries()) {
            const spec = parse(`API-${900 + i}`, t.steps);
            expect(endsSharedSession(spec), t.title).toBe(false);
            const script = apiGenerator.render(spec, ctx).content;
            expect(skipsUnder(script, { API_TOKEN: "shared" }), t.title).toBe("no line");
            expect(script).toMatch(/call\(request, "POST", "\/api\/logout", \{[^\n]*auth: false \}\)/);
            // Its sign-in still goes as before (only the session-ending call changes).
            expect(script).toMatch(/call\(request, "POST", "\/api\/(?:login|register)", \{[^\n]*auth: true \}\)/);
        }
    });

    it("a sign-out with the shared credentials and no sign-in of its own still skips whenever the run has shared credentials", () => {
        const spec = parse("API-016", [
            { action: "request", method: "POST", path: "/api/auth/logout" },
            { action: "assertResponse", check: "statusClass", expected: "2xx" },
        ]);
        expect(endsSharedSession(spec)).toBe(true);
        const script = apiGenerator.render(spec, ctx).content;
        expect(skipsUnder(script, { API_TOKEN: "shared" })).toBe(true);
        expect(skipsUnder(script, { API_TOKEN: "", API_AUTH_HEADER: "X-Key: k" })).toBe(true);
        expect(skipsUnder(script, { API_TOKEN: "", API_AUTH_HEADER: "", TEST_USERNAME: "owner@example.test" })).toBe(true);
        // No shared credentials in the run: nothing shared to end, so it runs.
        expect(skipsUnder(script, { API_TOKEN: "", API_AUTH_HEADER: "", TEST_USERNAME: "" })).toBe(false);
    });

    it("a named account skips regardless of the run's credentials", () => {
        const steps = [{ action: "request", method: "POST", path: "/api/logout" }];
        const named = parse("API-017", steps, { testData: { signInAs: "bob" } });
        expect(skipsUnder(apiGenerator.render(named, ctx).content, {})).toBe(true);
    });

    it("a sign-in after the sign-out does not count as the test's own session", () => {
        const spec = parse("API-018", [
            { action: "request", method: "POST", path: "/api/logout" },
            { action: "request", method: "POST", path: "/api/login", body: { email: "a@example.test", password: "x" } },
        ]);
        expect(endsSharedSession(spec)).toBe(true);
    });
});
