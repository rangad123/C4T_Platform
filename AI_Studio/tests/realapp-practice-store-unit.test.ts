/**
 * Real-app gaps the practice store showed (N2, 2026-11-24), without a browser:
 *   1. the fresh-account step's sign-up body: the store refuses a confirmation that is not the password ("The passwords do not match.",
 *      test-site server/api.mjs POST /api/auth/signup), which stopped about 25 API tests at "The fresh account is created";
 *   3. a verification attempt on a new account stands in for a named account that is the project's own account (same sign-in);
 *   4. API tests refused with 401 because no API token is saved: the run says so once, with what to do.
 * The sign-up schema is the store's own document (tests/fixtures/practice-store-signup.openapi.json, from its buildOpenApi).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { freshAccountSteps, sample } from "../src/engine/api/test-specs.js";
import type { EngineContext, EngineEvent } from "../src/engine/context.js";
import type { ScriptExecutor } from "../src/engine/frameworks/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";
import { freshAccountEnv } from "../src/engine/validation/runner.js";
import { validateBatch } from "../src/engine/validation/validator.js";

const STORE = parseOpenApi(JSON.parse(readFileSync(new URL("./fixtures/practice-store-signup.openapi.json", import.meta.url), "utf8")), "http://127.0.0.1:7301/openapi.json").operations;

describe("the fresh account's sign-up body (practice store)", () => {
    it("repeats the password in the confirmation field, and keeps the store's other rules", () => {
        const [signUp, created] = freshAccountSteps(STORE);
        expect(signUp).toMatchObject({ action: "request", method: "POST", path: "/api/auth/signup" });
        expect(created).toMatchObject({ check: "statusClass", expected: "2xx" });
        const body = (signUp as { body: Record<string, unknown> }).body;
        expect(body.confirmPassword).toBe(body.password);
        // The store's password rule (8+ characters with a letter, a number and a symbol), age 18 to 120, a listed country, terms accepted.
        expect(String(body.password).replace("{{unique}}", "1795533249787")).toMatch(/^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,128}$/);
        expect(body).toMatchObject({ age: 18, country: "IN", terms: true });
    });

    it("mirrors the other common confirmation names, a new password before the current one", () => {
        const s = (...names: string[]) => sample({ type: "object", properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) }) as Record<string, string>;
        for (const confirm of ["password_confirmation", "passwordConfirm", "repeatPassword", "password2"]) {
            const b = s("password", confirm);
            expect(b[confirm], confirm).toBe(b.password);
        }
        const change = s("currentPassword", "newPassword", "confirmNewPassword");
        expect(change.confirmNewPassword).toBe(change.newPassword);
        expect(change.currentPassword).not.toBe(change.newPassword);
    });
});

describe("a verification attempt's new account", () => {
    const env = { baseUrl: "http://127.0.0.1:1", headless: true, credentials: { username: "user@practice.test", password: "Practice#123" }, roles: [{ name: "customer", username: "user@practice.test", password: "Practice#123", apiToken: "t-old" }, { name: "admin", username: "admin@practice.test", password: "Admin#123" }] };
    it("signs in for the project's account and for a named account that is the same account, never for another", () => {
        const fresh = { username: "qa+replay-1@example.com", password: "Qa-1-7z!" };
        const out = freshAccountEnv(env, fresh);
        expect(out.credentials).toEqual(fresh);
        expect(out.roles).toEqual([{ name: "customer", ...fresh }, env.roles[1]]);
        expect(env.roles[0]!.username).toBe("user@practice.test");
    });
});

describe("API tests refused with 401 for want of an API token", () => {
    const config = loadConfig({});
    const model = { pages: [], apis: [] } as unknown as AppModel;
    const apiSpec = (id: string) => TestSpecSchema.parse({ testId: id, title: `Cart ${id}`, kind: "api", steps: [{ action: "request", method: "GET", path: "/api/cart/items" }, { action: "assertResponse", check: "statusClass", expected: "2xx" }] });
    const open = TestSpecSchema.parse({ testId: "API-003", title: "Health", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/health", auth: "none" }, { action: "assertResponse", check: "status", expected: 200 }] });

    async function run(tests: ReturnType<typeof apiSpec>[], env: Record<string, unknown> = {}) {
        const events: EngineEvent[] = [];
        const executor: ScriptExecutor = {
            name: "fake-runner",
            remote: true,
            async execute(_a, batch) {
                return batch.scripts.map((s) =>
                    s.testId === "API-003"
                        ? { testId: s.testId, status: "passed" as const, durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [{ method: "GET", path: "/api/health", status: 200 }] }
                        : { testId: s.testId, status: "failed" as const, durationMs: 1, error: "expect(received).toBe(expected)", failedStepIndex: 1, steps: [{ index: 0, title: "1. GET", status: "passed" }, { index: 1, title: "2. 2xx", status: "failed", error: "Expected: 2 Received: 4" }], artifacts: [], responses: [{ method: "GET", path: "/api/cart/items", status: 401 }] },
                );
            },
        };
        const ctx: EngineContext = { config, llm: undefined as never, emit: (e) => events.push(e) };
        await validateBatch(
            ctx,
            { scratchDir: config.scratchDir, env: { baseUrl: "http://127.0.0.1:1", headless: true, ...env }, render: { baseUrl: "http://127.0.0.1:1" }, model, maxRepairAttempts: 0, workers: 1, executor },
            tests.map((s) => ({ spec: s, framework: "playwright-api" as const })),
            { async onAttempt() {}, async onFinal() {} },
        );
        return events.filter((e) => e.kind === "api_token_needed");
    }

    it("says so once for the whole run, naming the tests and where the token goes", async () => {
        const said = await run([apiSpec("API-001"), apiSpec("API-002"), open], { credentials: { username: "user@practice.test", password: "Practice#123" } });
        expect(said).toHaveLength(1);
        expect(said[0]).toMatchObject({ stage: "validation", level: "warn" });
        expect(said[0]!.message).toMatch(/^2 API tests were refused with 401 \(not signed in\) and no API token is saved for the project: API-001, API-002\./);
        expect(said[0]!.message).toMatch(/Save the project's API token \(API access in What the agents need, on the Requirements tab/);
    });

    it("says nothing with a token saved, or when no test was refused", async () => {
        expect(await run([apiSpec("API-001")], { apiToken: "tok" })).toEqual([]);
        expect(await run([open])).toEqual([]);
    });
});
