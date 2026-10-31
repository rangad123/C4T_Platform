/**
 * Frames, test files, drag and drop, popups and the test data reset without a browser or a server: the schema's new optional fields and
 * steps, what the generator renders (and that a test without them renders exactly as before), the text phrases and their round trip, the
 * step editor's rules, the recorder's step-to-test conversion, file names, frame naming and the reset address rule.
 */
import { describe, expect, it } from "vitest";
import { checkSpecInput, type EditContext } from "../src/engine/builder/index.js";
import { parseDsl, printSpec, printStep } from "../src/engine/dsl/index.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { buildRecordedSpec } from "../src/engine/recorder/spec.js";
import { describeRecStep } from "../src/engine/recorder/describe.js";
import { StoredStepSchema, TestSpecSchema, describeStep, type Step, type TestSpec } from "../src/engine/spec/schema.js";
import { describeFrame, frameSelector, popupProblems, testFileNameFrom, testFileSlot, uploadFilesOf, usesPopups } from "../src/engine/web/pages.js";
import { resetSummary, resetTarget } from "../src/platform/test-data-reset-store.js";

const spec = (steps: unknown[], o: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "Pages test", kind: "web", steps, ...o });
const render = (s: TestSpec) => playwrightGenerator.render(s, { baseUrl: "http://127.0.0.1:6850" }).content;

const FRAMED = { by: "role", role: "button", value: "Pay", frame: [{ by: "name", value: "checkout" }, { by: "title", value: "Card" }] };

describe("the schema", () => {
    it("accepts frames on a locator, upload and drag steps, and popup fields", () => {
        const s = spec([
            { action: "navigate", url: "/" },
            { action: "click", locator: FRAMED },
            { action: "upload", locator: { by: "label", value: "Avatar" }, file: "photo.png" },
            { action: "drag", locator: { by: "text", value: "Card 1" }, target: { by: "role", role: "list", value: "Done" } },
            { action: "click", locator: { by: "role", role: "link", value: "Terms" }, opensPopup: true },
            { action: "assert", check: "visible", locator: { by: "role", role: "heading", value: "Terms" }, inPopup: true },
        ]);
        expect(s.steps).toHaveLength(6);
    });

    it("refuses a frame with a shared element, a file name with a folder, and frames nested more than three deep", () => {
        expect(StoredStepSchema.safeParse({ action: "click", locator: { ref: "Pay", frame: [{ by: "name", value: "x" }] } }).success).toBe(false);
        for (const file of ["../secret.txt", "a/b.png", "", ".hidden", "x".repeat(101)]) expect(StoredStepSchema.safeParse({ action: "upload", locator: { by: "label", value: "F" }, file }).success, file).toBe(false);
        const deep = Array.from({ length: 4 }, (_, i) => ({ by: "name", value: `f${i}` }));
        expect(StoredStepSchema.safeParse({ action: "click", locator: { by: "text", value: "x", frame: deep } }).success).toBe(false);
        expect(StoredStepSchema.safeParse({ action: "click", locator: { by: "text", value: "x", frame: [{ by: "name", value: "a\nb" }] } }).success).toBe(false);
    });

    it("words the new steps plainly, and leaves every other step's wording as it was", () => {
        expect(describeStep({ action: "upload", locator: { by: "label", value: "Avatar" }, file: "photo.png", description: "" } as Step)).toBe('Upload the test file "photo.png" to label "Avatar"');
        expect(describeStep({ action: "click", locator: FRAMED, description: "" } as Step)).toBe('Click button "Pay" inside frame titled "Card" inside frame "checkout"');
        expect(describeStep({ action: "fill", locator: { by: "label", value: "Name" }, value: "Ada", inPopup: true, description: "" } as Step)).toBe('Enter "Ada" into label "Name" (in the popup)');
        expect(describeStep({ action: "click", locator: { by: "text", value: "Go" }, description: "" } as Step)).toBe('Click text "Go"');
    });
});

describe("the generator", () => {
    it("reaches an element through its frames with frameLocator", () => {
        const out = render(spec([{ action: "navigate", url: "/" }, { action: "click", locator: FRAMED }]));
        expect(out).toContain(`page.frameLocator("iframe[name=\\"checkout\\"], frame[name=\\"checkout\\"]").frameLocator("iframe[title=\\"Card\\"], frame[title=\\"Card\\"]").getByRole("button", { name: "Pay" })`);
        expect(frameSelector({ by: "url", value: 'pay.example/a"b' })).toBe('iframe[src*="pay.example/a\\"b"], frame[src*="pay.example/a\\"b"]');
    });

    it("renders uploads through the test-file helper, drags with dragTo, and follows popups", () => {
        const out = render(
            spec([
                { action: "navigate", url: "/" },
                { action: "upload", locator: { by: "label", value: "Avatar" }, file: "photo.png" },
                { action: "drag", locator: { by: "text", value: "Card 1" }, target: { by: "testId", value: "done" } },
                { action: "click", locator: { by: "role", role: "link", value: "Terms" }, opensPopup: true },
                { action: "assert", check: "title", expected: "Terms", inPopup: true },
            ]),
        );
        expect(out).toContain('await uploadTestFile(page, page.getByLabel("Avatar"), "photo.png");');
        expect(out).toContain("function testFile(name: string)");
        expect(out).toContain('"__baselines__", "upload--" + name');
        expect(out).toContain('await page.getByText("Card 1").dragTo(page.getByTestId("done"));');
        expect(out).toContain('const popupOpened = page.waitForEvent("popup");');
        expect(out).toContain("popup = await popupOpened;");
        expect(out).toContain("const page = popupPage();");
        expect(out).toContain("let popup: typeof page | undefined;");
        for (const bad of ["sk-", "api_key", "TEST_PASSWORD", "password:"]) expect(out).not.toContain(bad);
    });

    it("adds nothing to a test that uses none of it", () => {
        const out = render(spec([{ action: "navigate", url: "/" }, { action: "click", locator: { by: "role", role: "button", value: "Go" } }]));
        for (const piece of ["frameLocator", "uploadTestFile", "testFileExists", "popupPage", "dragTo", "waitForEvent"]) expect(out).not.toContain(piece);
    });

    it("refuses a whole-page check in a popup, and a frame on a phone step", () => {
        expect(() => render(spec([{ action: "click", locator: { by: "text", value: "x" }, opensPopup: true }, { action: "assert", check: "a11y", inPopup: true }]))).toThrow(/page the test started on/);
        expect(popupProblems(spec([{ action: "click", locator: { by: "text", value: "x" }, inPopup: true }]).steps)[0]!.message).toMatch(/no step before it opens one/);
        expect(popupProblems(spec([{ action: "click", locator: { by: "text", value: "x" }, opensPopup: true }, { action: "click", locator: { by: "text", value: "y" }, inPopup: true }]).steps)).toEqual([]);
    });
});

describe("the text format", () => {
    const head = "Test: Pages test\n\n";
    const lines = [
        'Upload "photo.png" to the "Avatar" field',
        'Drag the "Card 1" listitem to the "Done" list',
        'Click the "Terms" link and wait for the popup',
        'Click the "Accept" button in the popup',
        'Expect the page title to contain "Terms" in the popup',
        'Click the "Pay" button inside the frame titled "Card" inside the frame "checkout"',
        'Type "Ada" into the "Card name" field inside the frame at "pay.example.com/form"',
    ];

    it("reads every new phrase into the step it names", () => {
        const r = parseDsl(head + lines.join("\n") + "\n");
        expect(r.diagnostics).toEqual([]);
        const [up, drag, opens, inPop, title, framed, typed] = r.spec!.steps as any[];
        expect(up).toMatchObject({ action: "upload", file: "photo.png", locator: { by: "label", value: "Avatar" } });
        expect(drag).toMatchObject({ action: "drag", locator: { by: "role", role: "listitem", value: "Card 1" }, target: { by: "role", role: "list", value: "Done" } });
        expect(opens).toMatchObject({ action: "click", opensPopup: true });
        expect(inPop).toMatchObject({ action: "click", inPopup: true });
        expect(title).toMatchObject({ action: "assert", check: "title", inPopup: true });
        expect(framed.locator.frame).toEqual([{ by: "name", value: "checkout" }, { by: "title", value: "Card" }]);
        expect(typed.locator.frame).toEqual([{ by: "url", value: "pay.example.com/form" }]);
    });

    it("prints them back exactly (the whole test reads back as the same test)", () => {
        const s = parseDsl(head + lines.join("\n") + "\n").spec!;
        for (let i = 0; i < lines.length; i++) expect(printStep(s.steps[i]!)).toBe(lines[i]);
        const printed = printSpec(s);
        expect(printed.expressible, printed.reasons.join(" ")).toBe(true);
    });

    it("says plainly what is wrong", () => {
        const api = parseDsl("Test: An API test\nKind: api\n\nSend a GET request to /x in the popup\n");
        expect(api.diagnostics[0]!.message).toMatch(/Only steps that work on a page can be done in the popup/);
        const deep = parseDsl(`${head}Click the "x" button inside the frame "a" inside the frame "b" inside the frame "c" inside the frame "d"\n`);
        expect(deep.diagnostics[0]!.message).toMatch(/at most 3 frames deep/);
    });
});

describe("the step editor's rules", () => {
    const ctx: EditContext = { testId: "WEB-001", kind: "web", category: "General", source: { origin: "manual" } };
    it("accepts the new steps and refuses a popup step with nothing that opens it", () => {
        const ok = checkSpecInput({ title: "Pages test", steps: [{ action: "navigate", url: "/" }, { action: "upload", locator: { by: "label", value: "Avatar" }, file: "photo.png" }, { action: "drag", locator: { by: "text", value: "a" }, target: { by: "text", value: "b" } }] }, ctx);
        expect(ok.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        const bad = checkSpecInput({ title: "Pages test", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "text", value: "x" }, inPopup: true }] }, ctx);
        expect(bad.diagnostics.map((d) => d.message).join(" ")).toMatch(/Step 2: this step works in the popup, but no step before it opens one/);
        const noTarget = checkSpecInput({ title: "Pages test", steps: [{ action: "drag", locator: { by: "text", value: "a" }, target: { by: "text", value: " " } }] }, ctx);
        expect(noTarget.diagnostics.map((d) => d.message).join(" ")).toMatch(/where to drop it/);
    });
});

describe("the recorder's steps become a test", () => {
    it("keeps frames, popups, the uploaded file's name and the drop target", () => {
        const at = "2026-10-18T00:00:00.000Z";
        const steps = [
            { index: 0, kind: "goto" as const, url: "http://127.0.0.1:6850/", describe: "Open", at },
            { index: 1, kind: "click" as const, locator: { strategy: "role" as const, value: "button", name: "Pay" }, frame: [{ by: "name" as const, value: "checkout" }], describe: "Click", at },
            { index: 2, kind: "upload" as const, locator: { strategy: "label" as const, value: "Avatar" }, value: "photo.png", describe: "Upload", at },
            { index: 3, kind: "drag" as const, locator: { strategy: "text" as const, value: "Card 1" }, target: { strategy: "testId" as const, value: "done" }, describe: "Drag", at },
            { index: 4, kind: "click" as const, locator: { strategy: "role" as const, value: "link", name: "Terms" }, opensPopup: true, describe: "Click", at },
            { index: 5, kind: "click" as const, locator: { strategy: "role" as const, value: "button", name: "Accept" }, inPopup: true, describe: "Click", at },
        ];
        const { spec: out, problems } = buildRecordedSpec({ title: "Recorded", startUrl: "http://127.0.0.1:6850/", steps });
        expect(problems).toEqual([]);
        const parsed = TestSpecSchema.parse({ ...out, testId: "WEB-002" });
        expect(parsed.steps[1]).toMatchObject({ action: "click", locator: { by: "role", role: "button", value: "Pay", frame: [{ by: "name", value: "checkout" }] } });
        expect(parsed.steps[2]).toMatchObject({ action: "upload", file: "photo.png" });
        expect(parsed.steps[3]).toMatchObject({ action: "drag", target: { by: "testId", value: "done" } });
        expect(parsed.steps[4]).toMatchObject({ opensPopup: true });
        expect(parsed.steps[5]).toMatchObject({ inPopup: true });
        expect(usesPopups(parsed)).toBe(true);
        expect(uploadFilesOf(parsed)).toEqual(["photo.png"]);
        expect(describeRecStep({ kind: "drag", locator: steps[3]!.locator, target: steps[3]!.target })).toBe('Drag the text "Card 1" to the element with test id "done"');
        expect(describeRecStep({ kind: "click", locator: steps[1]!.locator, frame: steps[1]!.frame })).toBe('Click the button "Pay" inside a frame ("checkout")');
    });
});

describe("names and addresses", () => {
    it("makes a usable test file name, or none", () => {
        expect(testFileNameFrom("My photo (1).PNG")).toBe("My-photo-1.PNG");
        expect(testFileNameFrom("C:\\Users\\ada\\cv.pdf")).toBe("cv.pdf");
        expect(testFileNameFrom("../../etc/passwd")).toBe("passwd");
        expect(testFileNameFrom("...")).toBeUndefined();
        expect(testFileNameFrom("😀")).toBeUndefined();
        expect(testFileSlot("cv.pdf")).toBe("upload--cv.pdf");
    });

    it("names a frame by a stable name, else its title, else the address part as written", () => {
        expect(describeFrame({ name: "checkout", title: "x", src: "/a" })).toEqual({ by: "name", value: "checkout" });
        expect(describeFrame({ name: "__privateStripeFrame5123", title: "Secure card", src: "/a" })).toEqual({ by: "title", value: "Secure card" });
        expect(describeFrame({ src: "https://js.pay.example/v3/card.html?token=abc" })).toEqual({ by: "url", value: "js.pay.example/v3/card.html" });
        expect(describeFrame({ src: "/frame-inner?x=1" })).toEqual({ by: "url", value: "/frame-inner" });
        expect(describeFrame({ src: "about:blank" })).toBeUndefined();
        expect(describeFrame({})).toBeUndefined();
    });

    it("keeps the reset request on the application's own site unless an administrator allowed another", () => {
        expect(resetTarget("/test/reset", "http://127.0.0.1:6850/app").toString()).toBe("http://127.0.0.1:6850/test/reset");
        expect(() => resetTarget("https://elsewhere.example/reset", "http://127.0.0.1:6850")).toThrow(/application's own site/);
        expect(() => resetTarget("http://user:pw@127.0.0.1:6850/reset", "http://127.0.0.1:6850")).toThrow(/header, not in the address/);
        expect(() => resetTarget("file:///etc/passwd", "http://127.0.0.1:6850")).toThrow(/http/);
        const saved = process.env.RESET_ALLOWED_ORIGINS;
        process.env.RESET_ALLOWED_ORIGINS = "https://elsewhere.example, not a url";
        try {
            expect(resetTarget("https://elsewhere.example/reset", "http://127.0.0.1:6850").origin).toBe("https://elsewhere.example");
        } finally {
            if (saved === undefined) delete process.env.RESET_ALLOWED_ORIGINS;
            else process.env.RESET_ALLOWED_ORIGINS = saved;
        }
        expect(resetSummary({ method: "POST", url: "/test/reset" })).toBe("POST /test/reset");
    });
});
