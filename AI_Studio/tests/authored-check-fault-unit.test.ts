/**
 * A defect the test writer reported, whose captured check is the test's own fault, is not reported as a finding (findings/expectation.ts
 * authoredCheckFault, called by orchestrator.ts keepAuthored). Each case is a re-check trial's (main 33a3916d, L4) captured check as the
 * trial stored it: the check step and the failure text authoring kept. All of them also failed on the clean application. The controls
 * are captured checks that can pass on a correct page (seed catches), which stay reported. No browser, no AI.
 */
import { describe, expect, it } from "vitest";
import { authoredCheckFault } from "../src/engine/findings/expectation.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";

const specWith = (check: Record<string, unknown>) =>
    TestSpecSchema.parse({
        testId: "WEB-001",
        title: "A captured check",
        kind: "web",
        category: "Functional",
        type: "workflow",
        priority: "high",
        steps: [{ action: "navigate", url: "/cart" }, check],
        expectedResults: ["The page shows what the requirement states"],
        source: { origin: "browser-agent", requirements: [] },
    });
const fault = (check: Record<string, unknown>, observed: string) => authoredCheckFault(specWith({ source: "expected:1", ...check }), { source: "expected:1", observed });

describe("captured checks that are the test's own fault: not reported", () => {
    it("shop-4 WEB-058: an element several match (strict mode violation)", () => {
        const why = fault(
            { action: "assert", check: "text", locator: { by: "text", value: "Subtotal" }, expected: "$81.50" },
            `expect(locator).toContainText(expected) failed Locator: getByText('Subtotal') Expected substring: "$81.50" Error: strict mode violation: getByText('Subtotal') resolved to 2 elements: 1) <dt>Subtotal</dt> aka getByText('Subtotal', { exact: true }) 2) <p class="hint">Code SAVE10 takes 10% off your order subtotal. Fr…</p>`,
        );
        expect(why).toMatch(/needs fixing, not your application/);
    });
    it("shop-4 WEB-048: the element found by a label shows only the label, and must contain a value", () => {
        const why = fault(
            { action: "assert", check: "text", locator: { by: "text", value: "Discount (SAVE10)" }, expected: "−$4.70" },
            `expect(locator).toContainText(expected) failed Locator: getByText('Discount (SAVE10)') Expected substring: "−$4.70" Received string: "Discount (SAVE10)" Timeout: 6000ms`,
        );
        expect(why).toMatch(/shows only “Discount \(SAVE10\)”/);
    });
    it("shop-3 WEB-013: a whole row text written with spaces its cells' text does not have", () => {
        const text = "Headphones $59.99 Quantity 2 Update $119.98 Remove";
        const why = fault(
            { action: "assert", check: "exactText", locator: { by: "role", role: "row", value: text }, expected: text },
            `expect(locator).toHaveText(expected) failed Locator: getByRole('row', { name: '${text}' }) Expected: "${text}" Received: "Headphones$59.99Quantity Update$119.98Remove" Timeout: 6000ms`,
        );
        expect(why).toMatch(/runs them together \(“Headphones\$59\.99”\)/);
    });
    it("shop-2 WEB-028: the check could not run (a role locator without its role)", () => {
        const why = fault(
            { action: "assert", check: "visible", locator: { by: "role", role: "link", value: "Cart", exact: true, within: { by: "role", value: "Main" } } },
            'A locator with by="role" needs its role (button, link, navigation, heading...): add the role, or use by="text" or by="label".',
        );
        expect(why).toMatch(/could not run/);
    });
    it("rbac-1 WEB-016: a heading found by one name must read another whole text", () => {
        const why = fault(
            { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Bold qa1r4o", exact: false, nth: 0 }, expected: "<b>Bold</b> qa1r4o" },
            `expect(locator).toHaveText(expected) failed Locator: getByRole('heading', { name: 'Bold qa1r4o' }).first() Expected: "<b>Bold</b> qa1r4o" Received: "Bold qa1r4o 1795781628394" Timeout: 6000ms`,
        );
        expect(why).toMatch(/by its name “Bold qa1r4o”/);
    });
    it("shop-3 WEB-051: the element whose text is exactly “Free” must contain “$0.00”", () => {
        const why = fault(
            { action: "assert", check: "text", locator: { by: "text", value: "Free", exact: true }, expected: "$0.00" },
            `expect(locator).toContainText(expected) failed Locator: getByText('Free', { exact: true }) Expected substring: "$0.00" Received string: "Free" Timeout: 6000ms`,
        );
        expect(why).toMatch(/exactly “Free”/);
    });
});

describe("captured checks a correct page can pass: still reported", () => {
    it("rbac-5 WEB-032 (BR-10): the markup check whose expected text holds the heading's name", () => {
        expect(
            fault(
                { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Bold qal3xy" }, expected: "<b>Bold qal3xy</b>" },
                `expect(locator).toHaveText(expected) failed Locator: getByRole('heading', { name: 'Bold qal3xy' }) Expected: "<b>Bold qal3xy</b>" Received: "Bold qal3xy" Timeout: 6000ms`,
            ),
        ).toBeUndefined();
    });
    it("shop-4 WEB-044 (BS-11): a value check on its own element", () => {
        expect(
            fault(
                { action: "assert", check: "exactText", locator: { by: "css", value: "dd:nth-of-type(3)" }, expected: "$0.00" },
                `expect(locator).toHaveText(expected) failed Locator: locator('dd:nth-of-type(3)') Expected: "$0.00" Received: "$5.00" Timeout: 6000ms`,
            ),
        ).toBeUndefined();
    });
    it("rbac-4 WEB-049: a stated message not found is a claim about the page", () => {
        expect(
            fault(
                { action: "assert", check: "visible", locator: { by: "text", value: "Enter a valid email address." } },
                "expect(locator).toBeVisible() failed Locator: getByText('Enter a valid email address.') Expected: visible Timeout: 6000ms Error: element(s) not found",
            ),
        ).toBeUndefined();
    });
    it("a row's whole text whose spaces the received text has too", () => {
        const text = "Headphones $59.99 Quantity 2";
        expect(fault({ action: "assert", check: "exactText", locator: { by: "role", role: "row", value: "Headphones" }, expected: text }, `expect(locator).toHaveText(expected) failed Expected: "${text}" Received: "Headphones $59.99 Quantity 11"`)).toBeUndefined();
    });
    it("no captured check (observed only): nothing to judge", () => {
        expect(authoredCheckFault(specWith({ action: "assert", check: "visible", locator: { by: "text", value: "x" }, source: "expected:1" }), undefined)).toBeUndefined();
    });
});
