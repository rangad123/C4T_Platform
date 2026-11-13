/**
 * Stronger web checks (round 54): the schema, the rendered Playwright code and the refusals of every new check and step, with no browser.
 * The real runs against a local site are in web-checks.test.ts.
 */
import { describe, expect, it } from "vitest";
import { renderScript } from "../src/engine/generators/index.js";
import { describeStep, StepSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { desktopSpecIssues } from "../src/engine/desktop/spec.js";
import { ariaTemplate, classPattern, newerPlaywrightNeeded, numberIn, urlPatternRegex, webOnlyProblem, webRequestProblems, WEB_REQUEST_RULE } from "../src/engine/web/checks.js";
import { locatorCall } from "../src/engine/generators/render-utils.js";

const BASE = "https://shop.example.test";
const web = (steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "Checks", kind: "web", steps: [{ action: "navigate", url: "/" }, ...steps], ...extra });
const render = (steps: unknown[], ctx: Record<string, unknown> = {}) => renderScript(web(steps), "playwright", { baseUrl: BASE, ...ctx }).content;
const field = { by: "label", value: "Email" };

describe("new assertion checks render as their Playwright assertion", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ check: "checked", locator: field }, "toBeChecked();"],
        [{ check: "unchecked", locator: field }, "toBeChecked({ checked: false });"],
        [{ check: "focused", locator: field }, "toBeFocused();"],
        [{ check: "editable", locator: field }, "toBeEditable();"],
        [{ check: "inViewport", locator: field }, "toBeInViewport();"],
        [{ check: "attribute", locator: field, name: "aria-invalid", expected: "true" }, 'toHaveAttribute("aria-invalid", "true");'],
        [{ check: "attribute", locator: field, name: "required" }, 'toHaveAttribute("required");'],
        [{ check: "class", locator: field, expected: "is-error" }, "toHaveClass(/(^|\\s)is-error(\\s|$)/);"],
        [{ check: "css", locator: field, name: "color", expected: "rgb(200, 0, 0)" }, 'toHaveCSS("color", "rgb(200, 0, 0)");'],
        [{ check: "accessibleName", locator: field, expected: "Email" }, 'toHaveAccessibleName("Email");'],
        [{ check: "accessibleErrorMessage", locator: field, expected: "Enter a valid email" }, 'toHaveAccessibleErrorMessage(new RegExp("Enter a valid email", "i"));'],
        [{ check: "exactText", locator: field, expected: "Total: $3" }, 'toHaveText("Total: $3");'],
        [{ check: "notText", expected: "undefined" }, 'expect(page.locator("body")).not.toContainText("undefined");'],
        [{ check: "urlPattern", expected: "/orders/*" }, "toHaveURL(/^[a-z][a-z0-9+.-]*:\\/\\/[^/]+\\/orders\\/[^/]*$/i);"],
        [{ check: "ariaSnapshot", locator: { by: "role", role: "list" }, expected: '- list:\n  - listitem: /Total [\\w.,:/-]+/' }, 'toMatchAriaSnapshot("- list:\\n  - listitem: /Total [\\\\w.,:/-]+/");'],
    ];
    for (const [step, want] of cases) {
        it(`${String(step.check)}${step.name ? ` (${String(step.name)})` : ""}`, () => {
            expect(render([{ action: "assert", ...step }])).toContain(want);
            expect(describeStep(StepSchema.parse({ action: "assert", ...step }))).toBeTruthy();
        });
    }

    it("an attribute or css check without its name is refused in plain words", () => {
        expect(() => render([{ action: "assert", check: "css", locator: field, expected: "x" }])).toThrow('The check "css" needs the CSS property name');
    });

    it("the checks newer than the portable floor say so in the script", () => {
        expect(newerPlaywrightNeeded(web([{ action: "assert", check: "ariaSnapshot", locator: field, expected: "- textbox" }]))).toEqual({ version: "1.49", checks: ["ariaSnapshot"] });
        expect(render([{ action: "assert", check: "accessibleErrorMessage", locator: field, expected: "x" }])).toContain('// Needs Playwright 1.50 or newer: it uses the check "accessibleErrorMessage".');
        expect(render([{ action: "assert", check: "checked", locator: field }])).not.toContain("Needs Playwright");
    });
});

describe("soft outcome checks", () => {
    it("the final outcome checks run soft, named by their step, followed by one hard check", () => {
        const s = render([
            { action: "click", locator: { by: "role", role: "button", value: "Save" } },
            { action: "assert", check: "text", locator: field, expected: "a", description: "The name shows" },
            { action: "assert", check: "url", expected: "/done" },
        ]);
        expect(s).toContain('await expect.soft(page.getByLabel("Email"), "3. The name shows").toContainText("a");');
        expect(s).toContain('await expect.soft(page, "4. Verify url = /done").toHaveURL(');
        expect(s).toContain('expect(test.info().errors.length, "Outcome checks failed (see the steps above)").toBe(0);');
    });

    it("a single final check, and checks before the last action, stay hard (scripts read as before)", () => {
        const s = render([{ action: "assert", check: "text", locator: field, expected: "a" }, { action: "click", locator: field }, { action: "assert", check: "visible", locator: field }]);
        expect(s).not.toContain("expect.soft");
        expect(s).not.toContain("test.info().errors");
    });
});

describe("remembered values", () => {
    it("remember stores the text or value under its name, and checks compare with it", () => {
        const s = render([
            { action: "remember", locator: { by: "testId", value: "price" }, name: "price" },
            { action: "remember", locator: field, name: "mail", from: "value" },
            { action: "assert", check: "remembered", locator: { by: "testId", value: "cart-price" }, name: "price", compare: "equals" },
            { action: "assert", check: "remembered", locator: { by: "testId", value: "total" }, name: "price", compare: "greater" },
            { action: "assert", check: "text", locator: { by: "testId", value: "line" }, expected: "{{price}}" },
        ]);
        expect(s).toContain('data["price"] = (await page.getByTestId("price").innerText()).replace(/\\s+/g, " ").trim();');
        expect(s).toContain('data["mail"] = await page.getByLabel("Email").inputValue();');
        expect(s).toContain('toHaveText(recalled("price"));');
        expect(s).toContain('await expect.poll(async () => numberIn(await page.getByTestId("total").innerText()), { message: "Verify testId \\"total\\" is greater than the remembered {{price}}" }).toBeGreaterThan(numberIn(recalled("price")));');
        expect(s).toContain('toContainText(`${data["price"] ?? ""}`);');
        expect(s).toContain("function recalled(name: string)");
    });

    it("a remembered name is a plain word and never a built-in one", () => {
        expect(() => StepSchema.parse({ action: "remember", locator: field, name: "unique" })).toThrow();
        expect(() => StepSchema.parse({ action: "remember", locator: field, name: "credentials.password" })).toThrow();
        expect(StepSchema.parse({ action: "remember", locator: field, name: "cartTotal" })).toMatchObject({ from: "text" });
    });

    it("numberIn reads the first number of a price", () => {
        expect(numberIn("Total: $1,234.50")).toBe(1234.5);
        expect(numberIn("-3 items")).toBe(-3);
        expect(numberIn("free")).toBeNaN();
    });
});

describe("waits", () => {
    it("wait until url, response, hidden and visible; a plain wait reads as before", () => {
        const s = render([
            { action: "click", locator: { by: "role", role: "button", value: "Save" } },
            { action: "wait", until: "response", value: "/api/save" },
            { action: "wait", until: "url", value: "/saved" },
            { action: "wait", until: "hidden", locator: { by: "text", value: "Saving" } },
            { action: "wait", until: "visible", locator: { by: "text", value: "Saved" } },
            { action: "wait", ms: 200 },
        ]);
        // The response is listened for from the click before it, so the response the click causes is not missed.
        expect(s).toMatch(/responseWaits\[2\] = page\.waitForResponse\(\(r\) => r\.url\(\)\.includes\("\/api\/save"\)\)\.catch\(\(e: Error\) => e\);\n\s+await page\.getByRole\("button", \{ name: "Save" \}\)\.click\(\);/);
        expect(s).toContain("const seen = await responseWaits[2];");
        expect(s).toContain('await page.waitForURL(new RegExp("/saved", "i"));');
        expect(s).toContain('await page.getByText("Saving").waitFor({ state: "hidden" });');
        expect(s).toContain('await page.getByText("Saved").waitFor({ state: "visible" });');
        expect(s).toContain("await page.waitForTimeout(200);");
        expect(StepSchema.parse({ action: "wait", ms: 5 })).toEqual({ action: "wait", ms: 5, description: "" });
    });

    it("phone and desktop tests refuse what only a web page has", () => {
        const until = StepSchema.parse({ action: "wait", until: "url", value: "/x" });
        expect(webOnlyProblem(until)).toBe("Waiting until an address works on web pages only");
        const phone = TestSpecSchema.parse({ testId: "MOB-001", title: "Phone", kind: "mobile", steps: [{ action: "assert", check: "checked", locator: field }] });
        expect(() => renderScript(phone, "taqwright", { baseUrl: BASE })).toThrow('Step 1: The check "checked" works on web pages only and cannot be rendered as a mobile UI test');
        const desk = { kind: "desktop" as const, desktop: { app: "x.exe" }, steps: [{ action: "launchApp" }, { action: "remember", locator: { by: "testId", value: "a" }, name: "a" }].map((s) => StepSchema.parse(s)) };
        expect(desktopSpecIssues(desk)).toContain('Step 2: The step "remember" works on web pages only.');
    });
});

describe("locators: filter, within, alt text and title", () => {
    it("container, strategy, filter and nth are chained in that order, inner locators from the same frame", () => {
        expect(
            locatorCall("page", {
                by: "role",
                role: "button",
                value: "Add",
                frame: [{ by: "name", value: "shop" }],
                within: { by: "role", role: "list", nth: 0 },
                filter: { hasText: "Mug", has: { by: "altText", value: "Mug" }, hasNot: { by: "title", value: "Gone" }, hasNotText: "Sold" },
                nth: 1,
            }),
        ).toBe(
            'page.frameLocator("iframe[name=\\"shop\\"], frame[name=\\"shop\\"]").getByRole("list").nth(0).getByRole("button", { name: "Add" }).filter({ hasText: "Mug", hasNotText: "Sold", has: page.frameLocator("iframe[name=\\"shop\\"], frame[name=\\"shop\\"]").getByAltText("Mug"), hasNot: page.frameLocator("iframe[name=\\"shop\\"], frame[name=\\"shop\\"]").getByTitle("Gone") }).nth(1)',
        );
        expect(locatorCall("page", { by: "title", value: "Close", exact: true })).toBe('page.getByTitle("Close", { exact: true })');
    });

    it("an empty filter is refused; phone tests refuse alt text", () => {
        expect(() => StepSchema.parse({ action: "click", locator: { by: "text", value: "x", filter: {} } })).toThrow("A filter keeps matches by hasText, hasNotText, has or hasNot");
        const phone = TestSpecSchema.parse({ testId: "MOB-001", title: "Phone", kind: "mobile", steps: [{ action: "click", locator: { by: "altText", value: "Logo" } }] });
        expect(() => renderScript(phone, "taqwright", { baseUrl: BASE })).toThrow("Finding an element by altText works on web pages only");
    });

    it("a stored locator cannot mix a shared element with a filter", () => {
        expect(() => TestSpecSchema.parse({ testId: "WEB-001", title: "Mixed", kind: "web", steps: [{ action: "click", locator: { ref: "Cart", filter: { hasText: "x" } } }] })).toThrow("either a shared element");
    });
});

describe("requests inside a web test", () => {
    it("render through page.request, extract values, and judge the answer", () => {
        const s = render([
            { action: "request", method: "GET", path: "/api/cart", extract: { cartId: "id" } },
            { action: "assertResponse", check: "status", expected: 200 },
            { action: "assertResponse", check: "jsonPath", path: "items", expected: "2" },
        ]);
        expect(s).toContain('last = await webRequest(page, "GET", "/api/cart", { query: undefined, headers: undefined, body: undefined });');
        expect(s).toContain('data["cartId"] = capture(last, "cartId", "id");');
        expect(s).toContain("expect(last.status).toBe(200);");
        expect(s).toContain("page.request.fetch(target");
    });

    it("refuse a foreign origin, an address that starts with a placeholder, and an API-only check", () => {
        expect(() => render([{ action: "request", method: "GET", path: "https://evil.example/steal", auth: "none" }])).toThrow(`Step 2: ${WEB_REQUEST_RULE} (this step goes to https://evil.example).`);
        expect(webRequestProblems(web([{ action: "request", method: "GET", path: "{{where}}/x", auth: "none" }]), { baseUrl: BASE })).toEqual([`Step 2: ${WEB_REQUEST_RULE}, so its address must not start with a {{placeholder}}.`]);
        expect(webRequestProblems(web([{ action: "request", method: "GET", path: "/x", auth: "none" }, { action: "assertResponse", check: "load" }]), { baseUrl: BASE })[0]).toContain('the response check "load" runs in API tests only');
        // The configured API address is the application's own too.
        expect(webRequestProblems(web([{ action: "request", method: "GET", path: "https://api.shop.example.test/v1/cart", auth: "none" }]), { baseUrl: BASE, apiBaseUrl: "https://api.shop.example.test/v1" })).toEqual([]);
    });
});

describe("ARIA snapshot templates", () => {
    it("numbers, dates, ids and run tags become patterns; the structure and fixed words stay", () => {
        const snap = ['- list "Orders":', '  - listitem: Order A1B2C3 on 2026-11-13 #4', '  - listitem: "42"', '  - link "Details":', "    - /url: /orders/123", '  - heading "Your cart" [level=2]', '  - button "Pay $12.50"'].join("\n");
        expect(ariaTemplate(snap)).toBe(
            ['- list "Orders":', "  - listitem: /Order [\\w.,:/-]+ on [\\w.,:/-]+\\s#[\\w.,:/-]+/", "  - listitem: /[\\w.,:/-]+/", '  - link "Details":', "    - /url: /\\/orders\\/[\\w.,:/-]+/", '  - heading "Your cart" [level=2]', '  - button /Pay \\$[\\w.,:/-]+/'].join("\n"),
        );
    });

    it("url patterns and class names", () => {
        expect(urlPatternRegex("/orders/*").test("https://x.test/orders/12")).toBe(true);
        expect(urlPatternRegex("/orders/*").test("https://x.test/orders/12/edit")).toBe(false);
        expect(urlPatternRegex("**/edit").test("https://x.test/orders/12/edit")).toBe(true);
        expect(classPattern("big").test("btn big")).toBe(true);
        expect(classPattern("big").test("bigger")).toBe(false);
    });
});
