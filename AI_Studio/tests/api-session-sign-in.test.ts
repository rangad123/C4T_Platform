/**
 * C1 (Phase 4): API tests sign in for themselves when the run has a sign-in but no API token. Against bench-shop (cookie sessions,
 * HTML sign-in form), the generated GET /api/cart happy path must pass signed in, where without the sign-in it gets 401. Port 9472.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateApiSpecs } from "../src/engine/api/test-specs.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { runScripts, type RunEnv } from "../src/engine/validation/runner.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";

const PORT = 9472;
const PASSWORD = "Password1!";
let app: RunningBenchApp;
let cart: TestSpec;

beforeAll(async () => {
    app = await startBenchApp("bench-shop", PORT, "none");
    const doc = await (await fetch(`${app.base}/openapi.json`)).json();
    const { specs } = generateApiSpecs(parseOpenApi(doc, `${app.base}/openapi.json`).operations, { allowMutating: false, maxPerEndpoint: 6 });
    const d = specs.find((s) => s.title === "GET /api/cart: succeeds with a valid request");
    if (!d) throw new Error("no GET /api/cart happy path was generated");
    cart = TestSpecSchema.parse({ ...d, testId: "API-001" });
}, 30_000);
afterAll(async () => app?.stop());

async function run(spec: TestSpec, env: Partial<RunEnv>) {
    const r = renderScript(spec, "playwright-api", { baseUrl: app.base });
    const [res] = await runScripts(loadConfig({}).scratchDir, [{ testId: spec.testId, filename: r.filename, content: r.content }], { baseUrl: app.base, headless: true, ...env }, { workers: 1 });
    return { run: res!, content: r.content };
}
const alice = { username: "alice@example.test", password: PASSWORD };

describe("API sign-in when there is no token (C1)", () => {
    it("GET /api/cart passes signed in as the project's account; the script holds no password", async () => {
        const { run: r, content } = await run(cart, { credentials: alice });
        expect(r.status, r.error).toBe("passed");
        expect(r.responses.map((x) => x.status)).toEqual([200]);
        expect(content).not.toContain(PASSWORD);
        expect(content).not.toContain(alice.username);
        expect(JSON.stringify(cart)).not.toContain(PASSWORD);
    }, 120_000);

    it("without a sign-in it gets 401, as before", async () => {
        const { run: r } = await run(cart, {});
        expect(r.status).toBe("failed");
        expect(r.responses.map((x) => x.status)).toEqual([401]);
    }, 120_000);

    it("a token project is unchanged: the token is used and the script does not sign in", async () => {
        // bench-shop knows no tokens, so a 401 here proves the run did not sign in.
        const { run: r } = await run(cart, { credentials: alice, apiToken: "not-a-real-token" });
        expect(r.status).toBe("failed");
        expect(r.responses.map((x) => x.status)).toEqual([401]);
    }, 120_000);

    it("passes again on a freshly started app (an isolated replay of the same stored test)", async () => {
        await app.stop();
        app = await startBenchApp("bench-shop", PORT, "none");
        const { run: r } = await run(cart, { credentials: alice });
        expect(r.status, r.error).toBe("passed");
    }, 120_000);

    it("signs in as a named test account (testData.signInAs) from the environment", async () => {
        const profile: TestSpec = TestSpecSchema.parse({
            testId: "API-002",
            title: "GET /api/profile as bob",
            kind: "api",
            steps: [
                { action: "request", method: "GET", path: "/api/profile", auth: "default" },
                { action: "assertResponse", check: "status", expected: 200 },
                { action: "assertResponse", check: "jsonPath", path: "email", expected: "bob@example.test" },
            ],
            testData: { signInAs: "bob" },
        });
        const roles = [{ name: "bob", username: "bob@example.test", password: PASSWORD }];
        const { run: r, content } = await run(profile, { credentials: alice, roles });
        expect(r.status, r.error).toBe("passed");
        expect(content).not.toContain(PASSWORD);
        // A named account with no sign-in details is a plain failure, never a silent unsigned call.
        const { run: none } = await run(profile, { credentials: alice });
        expect(none.status).toBe("failed");
        expect(none.error).toContain("No sign-in details are set for the test account “bob”");
    }, 180_000);
});
