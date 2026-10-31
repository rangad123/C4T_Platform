/**
 * H1 of the AX review: stored sign-in details (password, one-time-code secret, API token) never reach another origin.
 * Browser-free: the rule as a table (redirect-free address cases, ports, localhost against 127.0.0.1, relative paths, placeholders and test data),
 * what the generators refuse and what the scripts carry, and the run-time helper compiled from the exact text the scripts carry.
 */
import { describe, expect, it } from "vitest";
import { renderScript } from "../src/engine/generators/index.js";
import { allowedCredentialOrigins, assertCredentialsStayHome, CREDENTIAL_ORIGIN_HELPER_SOURCE, CREDENTIAL_ORIGIN_RULE, credentialOriginProblems, loadCredentialOriginRuntime, specUsesCredentials, stepUsesCredentials } from "../src/engine/spec/credential-origin.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";

const APP = "http://app.test:3000";
const web = (steps: unknown[], testData: Record<string, string> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A test", kind: "web", steps, testData });
const api = (steps: unknown[], testData: Record<string, string> = {}): TestSpec => TestSpecSchema.parse({ testId: "API-001", title: "A test", kind: "api", steps, testData });
const typePassword = { action: "fill", locator: { by: "label", value: "Password" }, value: "{{credentials.password}}" };
const home = { action: "navigate", url: "/login" };

const verdict = (spec: TestSpec, baseUrl = APP, apiBaseUrl?: string) => credentialOriginProblems(spec, allowedCredentialOrigins(spec.kind as "web" | "api", baseUrl, apiBaseUrl)).map((p) => p.stepIndex);

describe("the rule, as a table (web tests)", () => {
    const cases: Array<[string, unknown[], Record<string, string>, number[]]> = [
        ["the password typed on the application's own page", [home, typePassword], {}, []],
        ["a relative path stays on the application", [{ action: "navigate", url: "/a/b?c=1" }, typePassword], {}, []],
        ["an absolute address on the same origin", [{ action: "navigate", url: `${APP}/login` }, typePassword], {}, []],
        ["a page on another site first", [{ action: "navigate", url: "https://other.example/login" }, typePassword], {}, [1]],
        ["another port is another origin", [{ action: "navigate", url: "http://app.test:3001/login" }, typePassword], {}, [1]],
        ["another scheme is another origin", [{ action: "navigate", url: "https://app.test:3000/login" }, typePassword], {}, [1]],
        ["localhost is not 127.0.0.1", [{ action: "navigate", url: "http://127.0.0.1:3000/" }, typePassword], {}, [1]],
        ["a protocol-relative address", [{ action: "navigate", url: "//other.example/login" }, typePassword], {}, [1]],
        ["leaving and coming back is fine", [{ action: "navigate", url: "https://docs.example/" }, { action: "navigate", url: "/login" }, typePassword], {}, []],
        ["a step that does not use details may go anywhere", [{ action: "navigate", url: "https://other.example/" }, { action: "click", locator: { by: "text", value: "More" } }], {}, []],
        ["the address itself carries the password", [{ action: "navigate", url: "https://other.example/?p={{credentials.password}}" }], {}, [0]],
        ["the address on the application carries the password (allowed here, it is the application)", [{ action: "navigate", url: "/search?p={{credentials.password}}" }], {}, []],
        ["a placeholder at the front of an address that uses details", [{ action: "navigate", url: "{{base}}/x?p={{credentials.password}}" }], { base: "https://other.example" }, [0]],
        ["the details reach a step through test data", [{ action: "navigate", url: "https://other.example/" }, { action: "fill", locator: { by: "label", value: "P" }, value: "{{pw}}" }], { pw: "{{credentials.password}}" }, [1]],
        ["two levels of test data", [{ action: "navigate", url: "https://other.example/" }, { action: "fill", locator: { by: "label", value: "P" }, value: "{{a}}" }], { a: "{{b}}", b: "{{credentials.totp}}" }, [1]],
        ["a named account's password", [{ action: "navigate", url: "https://other.example/" }, { action: "fill", locator: { by: "label", value: "P" }, value: "{{credentials.admin.password}}" }], {}, [1]],
        ["the user name counts too", [{ action: "navigate", url: "https://other.example/" }, { action: "fill", locator: { by: "label", value: "U" }, value: "{{credentials.username}}" }], {}, [1]],
        ["each offending step is named, the others are not", [home, typePassword, { action: "navigate", url: "https://other.example/" }, typePassword, typePassword], {}, [3, 4]],
        ["an address that starts with a placeholder leaves the site unknown", [{ action: "navigate", url: "{{next}}" }, typePassword], { next: "{{x}}" }, [1]],
    ];
    it.each(cases)("%s", (_name, steps, testData, expected) => {
        expect(verdict(web(steps, testData))).toEqual(expected);
    });

    it("names the step and says what to do, in the product's words", () => {
        const [p] = credentialOriginProblems(web([{ action: "navigate", url: "https://other.example/" }, typePassword]), [APP]);
        expect(p!.message).toMatch(new RegExp(`^Step 2: ${CREDENTIAL_ORIGIN_RULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        expect(p!.message).toContain("https://other.example");
        expect(p!.message).not.toMatch(/!|\{\{/);
    });
});

describe("the rule, as a table (API tests)", () => {
    const cases: Array<[string, unknown[], string | undefined, number[]]> = [
        ["a relative path with the default sign-in", [{ action: "request", method: "GET", path: "/api/x" }], undefined, []],
        ["an absolute address on the API's own origin", [{ action: "request", method: "GET", path: "http://api.test:4000/x" }], "http://api.test:4000", []],
        ["an absolute foreign address with the default sign-in", [{ action: "request", method: "GET", path: "https://attacker.example/c" }], undefined, [0]],
        ["an absolute foreign address that sends nothing stored", [{ action: "request", method: "GET", path: "https://public.example/c", auth: "none" }], undefined, []],
        ["a foreign address with a stored token in a header", [{ action: "request", method: "GET", path: "https://attacker.example/c", auth: "none", headers: { Authorization: "Bearer {{credentials.admin.apiToken}}" } }], undefined, [0]],
        ["a foreign address with a stored value in the body", [{ action: "request", method: "POST", path: "https://attacker.example/c", auth: "none", body: { p: "{{credentials.password}}" } }], undefined, [0]],
        ["the application's origin is accepted when the API has its own address (either may be meant)", [{ action: "request", method: "GET", path: `${APP}/x` }], "http://api.test:4000", []],
        ["an address that starts with a captured value", [{ action: "request", method: "GET", path: "{{where}}/x" }], undefined, [0]],
        ["an address that starts with a captured value and sends nothing stored", [{ action: "request", method: "GET", path: "{{where}}/x", auth: "none" }], undefined, []],
    ];
    it.each(cases)("%s", (_name, steps, apiBase, expected) => {
        expect(verdict(api(steps), APP, apiBase)).toEqual(expected);
    });

    it("judges only web and API tests, and a test without an address list is never judged", () => {
        const mobile = { kind: "mobile" as const, steps: [], testData: {} };
        expect(credentialOriginProblems(mobile as never, [APP])).toEqual([]);
        expect(credentialOriginProblems(api([{ action: "request", method: "GET", path: "https://x.example/" }]), [])).toEqual([]);
        expect(() => assertCredentialsStayHome(mobile as never, { baseUrl: APP })).not.toThrow();
    });
});

describe("what counts as using stored details", () => {
    it("sees placeholders anywhere in a step, test data, and the default API sign-in", () => {
        expect(stepUsesCredentials(web([typePassword]).steps[0]!)).toBe(true);
        expect(stepUsesCredentials(web([{ action: "click", locator: { by: "text", value: "Go" } }]).steps[0]!)).toBe(false);
        expect(stepUsesCredentials(api([{ action: "request", method: "GET", path: "/x" }]).steps[0]!)).toBe(true);
        expect(stepUsesCredentials(api([{ action: "request", method: "GET", path: "/x", auth: "none" }]).steps[0]!)).toBe(false);
        expect(specUsesCredentials(web([home, { action: "fill", locator: { by: "label", value: "P" }, value: "{{pw}}" }], { pw: "{{credentials.password}}" }))).toBe(true);
        expect(specUsesCredentials(web([home]))).toBe(false);
    });
});

describe("the generators", () => {
    const ctx = { baseUrl: APP };

    it("refuse a test that sends stored details to another site, naming the step (every path that renders a script is covered)", () => {
        const bad = web([{ action: "navigate", url: "https://other.example/login" }, typePassword]);
        expect(() => renderScript(bad, "playwright", ctx)).toThrow(/Step 2: Stored sign-in details can only be used on the application's own site/);
        const leak = api([{ action: "request", method: "GET", path: "https://attacker.example/c" }]);
        expect(() => renderScript(leak, "playwright-api", ctx)).toThrow(/Step 1: Stored sign-in details can only be used on the application's own site/);
        expect(() => renderScript(api([{ action: "request", method: "GET", path: "https://attacker.example/c", auth: "none" }]), "playwright-api", ctx)).not.toThrow();
    });

    it("a web script that uses stored details checks the real page address right before using them", () => {
        const script = renderScript(web([home, typePassword]), "playwright", ctx).content;
        expect(script).toContain("function assertOwnOrigin(address, base)");
        expect(script).toContain("assertOwnOrigin(page.url(), BASE_URL);");
        // the check is the first statement of the step that uses the value
        const step = script.slice(script.indexOf("2. "));
        expect(step.indexOf("assertOwnOrigin(page.url(), BASE_URL);")).toBeLessThan(step.indexOf(".fill("));
        // a navigation that carries the details is checked against the address it is about to open
        const nav = renderScript(web([{ action: "navigate", url: "/s?p={{credentials.password}}" }]), "playwright", ctx).content;
        expect(nav).toContain("assertOwnOrigin(new URL(`/s?p=${(process.env.TEST_PASSWORD ?? \"\")}`, BASE_URL).toString(), BASE_URL);");
    });

    it("a web script that uses no stored details is exactly what it was: no helper, no check", () => {
        const script = renderScript(web([home, { action: "click", locator: { by: "text", value: "Go" } }]), "playwright", ctx).content;
        expect(script).not.toContain("assertOwnOrigin");
        expect(script).not.toContain("Stored sign-in details");
    });

    it("an API script attaches the token only after the real target is compared with the API address", () => {
        const script = renderScript(api([{ action: "request", method: "GET", path: "/x" }]), "playwright-api", ctx).content;
        const call = script.slice(script.indexOf("async function call("), script.indexOf("const res = await request.fetch(target"));
        expect(call.indexOf("assertOwnOrigin(target, API_BASE_URL);")).toBeGreaterThan(-1);
        expect(call.indexOf("assertOwnOrigin(target, API_BASE_URL);")).toBeLessThan(call.indexOf("process.env.API_TOKEN"));
        expect(script).toContain(CREDENTIAL_ORIGIN_HELPER_SOURCE);
        // a load check sends the credential too and carries the same check
        const load = renderScript(api([{ action: "request", method: "GET", path: "/x" }, { action: "assertResponse", check: "load", expected: "users:2 seconds:2 requests:10" }]), "playwright-api", ctx).content;
        const loadCall = load.slice(load.indexOf("async function loadCall("));
        expect(loadCall.indexOf("assertOwnOrigin(target, API_BASE_URL);")).toBeGreaterThan(-1);
        expect(loadCall.indexOf("assertOwnOrigin(target, API_BASE_URL);")).toBeLessThan(loadCall.indexOf("process.env.API_TOKEN"));
    });
});

describe("the run-time helper (the exact text the scripts carry)", () => {
    const rt = loadCredentialOriginRuntime();
    it("passes the same origin, whatever the path, query or fragment", () => {
        expect(() => rt.assertOwnOrigin("http://app.test:3000/a/b?c=1#d", APP)).not.toThrow();
        expect(() => rt.assertOwnOrigin("http://app.test:3000", "http://app.test:3000/other")).not.toThrow();
    });
    it.each([
        ["another site", "https://other.example/"],
        ["another port", "http://app.test:3001/"],
        ["another scheme", "https://app.test:3000/"],
        ["a sub-domain", "http://x.app.test:3000/"],
        ["a look-alike host", "http://app.test.evil.example:3000/"],
        ["user information in front of the host", "http://app.test:3000@evil.example/"],
        ["no page yet", "about:blank"],
        ["a data page", "data:text/html,hi"],
        ["a file", "file:///C:/x.html"],
        ["nothing", ""],
        ["text that is not an address", "not an address"],
    ])("refuses %s, with the rule in the message and nothing typed", (_name, address) => {
        expect(() => rt.assertOwnOrigin(address, APP)).toThrow(/^Stored sign-in details can only be used on the application's own site/);
        expect(() => rt.assertOwnOrigin(address, APP)).toThrow(/Nothing was typed or sent/);
    });
    it("localhost and 127.0.0.1 are different sites", () => {
        expect(() => rt.assertOwnOrigin("http://127.0.0.1:3000/", "http://localhost:3000")).toThrow(/application's own site/);
    });
    it("names the origin the step ran on, and never anything secret", () => {
        try {
            rt.assertOwnOrigin("https://other.example/login?token=SENTINEL", APP);
            expect.unreachable();
        } catch (e) {
            const m = (e as Error).message;
            expect(m).toContain("https://other.example");
            expect(m).not.toContain("SENTINEL");
        }
    });
});

describe("BE review H2: nesting never hides a stored sign-in detail", () => {
    const nest = (depth: number, leaf: unknown): unknown => {
        let v: unknown = leaf;
        for (let i = 0; i < depth; i++) v = { a: v };
        return v;
    };
    const step = (body: unknown) => ({ action: "request", method: "POST", path: "/x", auth: "none", body }) as never;
    it("sees a placeholder at any depth up to the limit", () => {
        expect(stepUsesCredentials(step(nest(3, "{{credentials.password}}")))).toBe(true);
        expect(stepUsesCredentials(step(nest(40, "{{credentials.password}}")))).toBe(true);
        expect(stepUsesCredentials(step(nest(3, "plain")))).toBe(false);
    });
    it("treats nesting it will not read as using stored details (fail closed)", () => {
        expect(stepUsesCredentials(step(nest(200, "plain")))).toBe(true);
        expect(stepUsesCredentials(step(nest(5000, "{{credentials.password}}")))).toBe(true);
    });
    it("does not run out of stack on very deep input", () => {
        expect(() => stepUsesCredentials(step(nest(100000, "x")))).not.toThrow();
    });
});
