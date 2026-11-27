/**
 * Item text checks (lane I, E2): a text check of a whole table row or list item compares the item as its accessible name reads it (cells
 * apart, a field's value in place of the field), the way the test writer read it. Ladder L4 shop-1 WEB-017 checked the row
 * "Desk Lamp $34.50 Quantity 2 Update $69.00 Remove" with toHaveText, which reads "Desk Lamp$34.50Quantity  Update$69.00Remove" on every
 * app. Rendering only (no browser): which checks change, that the script is valid and carries the helper once, and that the reader is
 * plain JavaScript (the live run turns it into a function). The reader itself ran in a real browser in lane I's probe.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { isItemTextCheck, ITEM_TEXT_SOURCE } from "../src/engine/web/checks.js";

const ctx = { baseUrl: "http://127.0.0.1:5999" };
const syntaxErrors = (source: string) => (ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
const ROW = "Desk Lamp $34.50 Quantity 2 Update $69.00 Remove";
const steps = [
    { action: "navigate", url: "/cart" },
    { action: "assert", check: "exactText", locator: { by: "role", role: "row", value: ROW }, expected: ROW },
    { action: "assert", check: "text", locator: { by: "role", role: "row", value: "Desk Lamp" }, expected: "Quantity 3" },
    { action: "assert", check: "exactText", locator: { by: "role", role: "heading", value: "Your cart" }, expected: "Your cart" },
];
const out = renderScript(TestSpecSchema.parse({ testId: "WEB-017", title: "Cart lines", kind: "web", steps }), "playwright", ctx).content;

describe("item text checks", () => {
    it("only a text or exact-text check of a row or list item is one", () => {
        const [, row, contains, heading] = steps as never[];
        expect(isItemTextCheck(row)).toBe(true);
        expect(isItemTextCheck(contains)).toBe(true);
        expect(isItemTextCheck(heading)).toBe(false);
        expect(isItemTextCheck({ action: "assert", check: "visible", locator: { by: "role", role: "row", value: "x" } } as never)).toBe(false);
        expect(isItemTextCheck({ action: "assert", check: "exactText", locator: { by: "role", role: "listitem", value: "x" }, expected: "x" } as never)).toBe(true);
    });

    it("the row checks read the item and compare exactly or by containing; the heading keeps toHaveText", () => {
        expect(out).toContain(`toBe(String(${JSON.stringify(ROW)}).replace(/\\s+/g, " ").trim())`);
        // Final checks render soft, with the step's message: the read value is what is compared.
        expect(out).toMatch(/await itemText\(page\.getByRole\("row", \{ name: "Desk Lamp \$34\.50 Quantity 2 Update \$69\.00 Remove" \}\), [^\n]*, true\)[^\n]*\)\.toBe\(/);
        expect(out).toMatch(/await itemText\(page\.getByRole\("row", \{ name: "Desk Lamp" \}\), [^\n]*, false\)[^\n]*\)\.toContain\(/);
        expect(out).toMatch(/getByRole\("heading", \{ name: "Your cart" \}\)[^\n]*\)\.toHaveText\("Your cart"\)/);
        expect(out).not.toMatch(/getByRole\("row"[^\n]*\.toHaveText\(/);
    });

    it("the script is valid and carries the helper once; a script without item checks carries none", () => {
        expect(syntaxErrors(out)).toEqual([]);
        expect(out.split("async function itemText(").length - 1).toBe(1);
        const plain = renderScript(TestSpecSchema.parse({ testId: "WEB-002", title: "Heading", kind: "web", steps: [steps[0], steps[3]] }), "playwright", ctx).content;
        expect(plain).not.toContain("itemText");
    });

    it("the reader is plain JavaScript that becomes a function", () => {
        expect(syntaxErrors(`const f = ${ITEM_TEXT_SOURCE};`)).toEqual([]);
        expect(typeof new Function(`return ${ITEM_TEXT_SOURCE}`)()).toBe("function");
    });
});
