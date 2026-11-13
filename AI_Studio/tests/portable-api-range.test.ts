/**
 * Generated code must run on every Playwright from OLDEST_PLAYWRIGHT on (docs/features/portable-code-tests.md). This renders scripts for
 * every kind of step and check with every Playwright-based generator, reads them and every helper the generators paste into scripts with
 * the TypeScript parser, and fails when one calls a Playwright method the list in src/engine/portable/playwright-apis.ts does not know,
 * or one (or an option) newer than the oldest supported version. The config file of a download is checked the same way.
 *
 * Pure unit test (no browser): node node_modules/vitest/vitest.mjs run tests/portable-api-range.test.ts
 */
import { describe, expect, it } from "vitest";
import { ASSERT_CHECKS, RESPONSE_CHECKS, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { renderScript } from "../src/engine/generators/index.js";
import { availableIn, newerThan, NOT_PLAYWRIGHT, OLDEST_PLAYWRIGHT, PLAYWRIGHT_METHODS, scanPlaywrightApis } from "../src/engine/portable/playwright-apis.js";
import { playwrightConfig } from "../src/platform/portable-export.js";
import * as email from "../src/engine/auth/email-step.js";
import * as cleanup from "../src/engine/cleanup/helper.js";
import * as contracts from "../src/engine/contracts/check.js";
import * as drift from "../src/engine/contracts/drift.js";
import * as desktop from "../src/engine/desktop/helper.js";
import * as evidence from "../src/engine/evidence/capture.js";
import * as health from "../src/engine/health/checks.js";
import * as access from "../src/engine/identity/access.js";
import * as totp from "../src/engine/identity/totp.js";
import * as inputs from "../src/engine/inputs/checks.js";
import * as perf from "../src/engine/performance/checks.js";
import * as latency from "../src/engine/performance/latency.js";
import * as load from "../src/engine/performance/load.js";
import * as security from "../src/engine/security/checks.js";
import * as origin from "../src/engine/spec/credential-origin.js";
import * as vision from "../src/engine/vision/capture.js";
import * as pages from "../src/engine/web/pages.js";
import { NEEDS_EXPECTED, NEEDS_LOCATOR, NEWER_PLAYWRIGHT_CHECKS } from "../src/engine/web/checks.js";

const BASE = "https://shop.example.test";
const spec = (raw: Record<string, unknown>): TestSpec => TestSpecSchema.parse(raw);
const L = (value: string) => ({ by: "role" as const, role: "button", value });

/** Web steps: every action a web test has, and every check a web assert has. */
const webSteps = [
    { action: "navigate", url: "/" },
    { action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" },
    { action: "fill", locator: { by: "label", value: "Password", exact: true }, value: "{{credentials.password}}" },
    { action: "fill", locator: { by: "label", value: "Code" }, value: "{{credentials.totp}}" },
    { action: "click", locator: L("Sign in") },
    { action: "click", locator: { by: "text", value: "Open help" }, opensPopup: true },
    { action: "assert", check: "visible", locator: { by: "text", value: "Help" }, inPopup: true },
    { action: "select", locator: { by: "label", value: "Size" }, value: "M" },
    { action: "check", locator: { by: "label", value: "Gift" }, checked: true },
    { action: "press", locator: { by: "placeholder", value: "Search" }, key: "Enter" },
    { action: "press", key: "Escape" },
    { action: "hover", locator: { by: "testId", value: "menu" } },
    { action: "upload", locator: { by: "label", value: "Picture" }, file: "photo.png" },
    { action: "drag", locator: { by: "css", value: "#a" }, target: { by: "css", value: "#b" } },
    { action: "click", locator: { by: "role", role: "link", value: "Inside", frame: [{ by: "name", value: "payment" }] } },
    { action: "wait", ms: 10 },
    { action: "email", to: "test-{{unique}}@mail.example.test", use: "code", locator: { by: "label", value: "Code" } },
    { action: "email", to: "test@mail.example.test", use: "link", after: "Confirm" },
    { action: "click", locator: { by: "role", role: "button", value: "Add", within: { by: "role", role: "listitem", nth: 1 }, filter: { hasText: "Mug", hasNotText: "Sold", has: { by: "altText", value: "Mug" }, hasNot: { by: "title", value: "Gone" } } } },
    { action: "wait", until: "response", value: "/api/cart" },
    { action: "wait", until: "url", value: "/cart" },
    { action: "wait", until: "hidden", locator: { by: "text", value: "Loading" } },
    { action: "remember", locator: { by: "testId", value: "price" }, name: "price" },
    { action: "remember", locator: { by: "label", value: "Qty" }, name: "qty", from: "value" },
    { action: "request", method: "GET", path: "/api/cart", extract: { cartId: "id" } },
    ...["status", "statusClass", "statusBelow", "jsonPath", "jsonType", "header", "bodyContains", "bodyNotContains"].map((check) => ({ action: "assertResponse", check, path: "id", expected: check === "statusClass" ? "2xx" : check.startsWith("status") ? 200 : "x" })),
    { action: "assert", check: "remembered", locator: { by: "testId", value: "total" }, name: "price", compare: "greater" },
    ...ASSERT_CHECKS.filter((c) => c !== "accessDenied" && !NEWER_PLAYWRIGHT_CHECKS[c]).map((check) => ({
        action: "assert",
        check,
        ...(["visible", "hidden", "enabled", "disabled", "text", "value", "count", "screenshot", "looksRight", ...NEEDS_LOCATOR, "ariaSnapshot"].includes(check) ? { locator: { by: "css", value: "main", nth: 0 } } : {}),
        ...(check === "attribute" || check === "css" ? { name: "color" } : check === "remembered" ? { name: "price", compare: "equals" } : {}),
        ...(NEEDS_EXPECTED.has(check) ? { expected: "x" } : {}),
        ...(check === "a11y" ? { locator: { by: "role", role: "main" } } : {}),
        ...(["text", "value", "url", "title"].includes(check) ? { expected: "Shop" } : check === "count" ? { expected: 2 } : {}),
    })),
    { action: "assert", check: "a11y" },
    { action: "assert", check: "screenshot" },
    { action: "assert", check: "accessDenied", expected: JSON.stringify({ as: "anonymous", path: "/account", marker: "Your orders" }) },
];

const apiSteps = [
    { action: "request", method: "POST", path: "/api/things", body: { name: "x-{{unique}}" }, extract: { thingId: "id" } },
    { action: "assertResponse", check: "status", expected: 201 },
    { action: "request", method: "GET", path: "/api/things/{{thingId}}", query: { full: "1" }, headers: { "x-trace": "1" }, auth: "none" },
    ...RESPONSE_CHECKS.filter((c) => !["latency", "load", "statusDenied"].includes(c)).map((check) => ({
        action: "assertResponse",
        check,
        ...(check === "jsonPath" || check === "jsonType" ? { path: "name" } : check === "header" ? { path: "content-type" } : {}),
        ...(check === "matchesSchema" ? { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } : {}),
        ...(["status", "statusClass", "statusBelow"].includes(check) ? { expected: check === "statusClass" ? "2xx" : 500 } : check === "jsonType" ? { expected: "string" } : check === "bodyContains" || check === "bodyNotContains" || check === "jsonPath" ? { expected: "x" } : {}),
    })),
    { action: "request", method: "GET", path: "/api/things" },
    { action: "assertResponse", check: "latency" },
    { action: "request", method: "GET", path: "/api/things" },
    { action: "assertResponse", check: "load" },
    { action: "assertResponse", check: "statusDenied", expected: JSON.stringify({ as: "anonymous", path: "/api/admin" }) },
];

function corpus(): Array<{ name: string; content: string }> {
    const ctx = { baseUrl: BASE, deleteOps: ["/api/things/{id}"], dataSets: { sizes: { name: "sizes", columns: ["size"], rows: [{ size: "S" }, { size: "M" }] } } } as any;
    const out: Array<{ name: string; content: string }> = [];
    const web = spec({ testId: "WEB-001", title: "Every web step", kind: "web", steps: webSteps, tags: ["smoke"] });
    out.push({ name: "web (playwright)", content: renderScript(web, "playwright", ctx).content });
    const dataDriven = spec({ testId: "WEB-002", title: "One row per size", kind: "web", steps: [{ action: "navigate", url: "/?size={{size}}" }, { action: "assert", check: "text", locator: { by: "css", value: "h1" }, expected: "{{size}}" }], testData: { dataSet: "sizes" } });
    out.push({ name: "data-driven web", content: renderScript(dataDriven, "playwright", ctx).content });
    const api = spec({ testId: "API-001", title: "Every API check", kind: "api", steps: apiSteps });
    out.push({ name: "api (playwright-api)", content: renderScript(api, "playwright-api", ctx).content });
    const dsk = spec({
        testId: "DSK-001",
        title: "Notepad opens",
        kind: "desktop",
        desktop: { app: "notepad.exe", windowTitle: "Notepad" },
        steps: [
            { action: "launchApp" },
            { action: "fill", locator: { by: "role", role: "Edit" }, value: "hello" },
            { action: "click", locator: { by: "role", role: "Button", value: "OK" } },
            { action: "assert", check: "text", locator: { by: "role", role: "Edit" }, expected: "hello" },
            { action: "closeApp" },
        ],
    });
    out.push({ name: "desktop (windows-uia)", content: renderScript(dsk, "windows-uia", ctx).content });
    return out;
}

/** Every piece of code a generator pastes into scripts, read on its own (a script only carries the ones it needs). */
const HELPERS: Array<[string, unknown]> = Object.entries({ email, cleanup, contracts, drift, desktop, evidence, health, access, totp, inputs, perf, latency, load, security, origin, vision, pages }).flatMap(([mod, m]) =>
    Object.entries(m as Record<string, unknown>)
        .filter(([k, v]) => typeof v === "string" && /_SOURCE$|_SETUP$|_IMPORTS$/.test(k))
        .map(([k, v]): [string, unknown] => [`${mod}.${k}`, v]),
);

describe("the Playwright APIs generated code uses", () => {
    const scripts = corpus();

    it("renders every web step and check, every API check, a data-driven test and a desktop test", () => {
        expect(scripts.length).toBe(4);
        const web = scripts[0]!.content;
        for (const marker of ["a11yAudit(", "healthAssert(", "pageSpeedAssert(", "inputAssert(", "accessAssert(", "visionCapture(", "uploadTestFile(", "toHaveScreenshot(", "dragTo(", "frameLocator(", "totpCode(", "assertOwnOrigin("]) expect(web, marker).toContain(marker);
        expect(HELPERS.length).toBeGreaterThanOrEqual(20);
    });

    it("knows every method generated code calls: each is a Playwright API with its version, or listed as not Playwright", () => {
        const unknown = new Map<string, string>();
        for (const s of [...scripts, ...HELPERS.map(([name, content]) => ({ name, content: content as string }))]) for (const u of scanPlaywrightApis(s.content).unknown) unknown.set(u.name, `${s.name}:${u.line}`);
        expect([...unknown].map(([n, at]) => `${n} (${at})`)).toEqual([]);
        // The two lists never disagree.
        for (const n of NOT_PLAYWRIGHT) expect(Object.hasOwn(PLAYWRIGHT_METHODS, n), n).toBe(false);
    });

    it(`uses nothing newer than Playwright ${OLDEST_PLAYWRIGHT}, the oldest supported version`, () => {
        const late: string[] = [];
        for (const s of [...scripts, ...HELPERS.map(([name, content]) => ({ name, content: content as string })), { name: "playwright.config.ts", content: playwrightConfig({ desktopFiles: [] }) }]) {
            for (const u of newerThan(scanPlaywrightApis(s.content))) late.push(`${s.name}:${u.line} ${u.api} (Playwright ${u.since})`);
        }
        expect(late).toEqual([]);
    });

    it("finds the newest API on purpose: the test details' tags are what makes 1.42 the oldest version", () => {
        const uses = scanPlaywrightApis(scripts[0]!.content).uses;
        expect(uses.some((u) => u.api === "test({ tag })" && u.since === "1.42")).toBe(true);
        expect(availableIn("1.42", OLDEST_PLAYWRIGHT)).toBe(true);
        expect(availableIn("1.43", OLDEST_PLAYWRIGHT)).toBe(false);
    });

    it("fails a script that uses an API newer than the oldest version, and one that calls something unknown", () => {
        const s = scanPlaywrightApis(`import { test, expect } from "@playwright/test";
test("x", async ({ page }) => {
    await page.getByRole("button").filter({ visible: true }).click();
    await test.step("limited", async () => {}, { timeout: 5000 });
    await page.clock.install();
    await expect(page.locator("main")).toMatchAriaSnapshot("- main");
});`);
        expect(newerThan(s).map((u) => u.api).sort()).toEqual(["filter({ visible })", "step({ timeout })", "toMatchAriaSnapshot"]);
        expect(s.unknown.map((u) => u.name).sort()).toEqual(["install"]);
        expect(newerThan(s, "1.51.0")).toEqual([]);
    });

    it("the three checks newer than the floor say so in the script, and nothing else in it is newer", () => {
        const steps = [{ action: "navigate", url: "/" }, ...Object.keys(NEWER_PLAYWRIGHT_CHECKS).map((check) => ({ action: "assert", check, locator: { by: "label", value: "Email" }, expected: "x" }))];
        const content = renderScript(spec({ testId: "WEB-009", title: "Newer checks", kind: "web", steps }), "playwright", { baseUrl: BASE }).content;
        expect(content).toContain('// Needs Playwright 1.50 or newer: it uses the checks "accessibleName", "ariaSnapshot", "accessibleErrorMessage".');
        const late = newerThan(scanPlaywrightApis(content)).map((u) => `${u.api} ${u.since}`);
        expect(late.filter((u) => u.startsWith("to")).sort()).toEqual(["toHaveAccessibleErrorMessage 1.50", "toHaveAccessibleName 1.44", "toMatchAriaSnapshot 1.49"]);
    });

    it("ignores what is inside strings and comments", () => {
        const s = scanPlaywrightApis(`// page.clock.install() would be newer\nconst a = "page.ariaSnapshot()";\nconst b = \`x \${String(1)} page.routeWebSocket()\`;`);
        expect(s.unknown).toEqual([]);
        expect(s.uses).toEqual([]);
    });
});
