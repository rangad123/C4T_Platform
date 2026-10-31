/**
 * Text tests without a browser or a server: the grammar table against the real schema (no step or check without a phrase), every phrase
 * and alias, the printer/parser round trip on generated specs and random step lists, escaping, caps, "did you mean", per-line recovery,
 * every kind of locator, reusable steps, placeholders, the not-expressible rule and keys that could pollute a prototype.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DSL_LIMITS, HEADER_INFO, PHRASES, parseDsl, phraseReference, printSpec, printStep, quote, readStepLine, tokenize } from "../src/engine/dsl/index.js";
import { comparableSpec, normalizeStep } from "../src/engine/dsl/printer.js";
import { compileTemplate, slotsOf } from "../src/engine/dsl/grammar.js";
import { Furthest, matchAll } from "../src/engine/dsl/match.js";
import { generateA11ySpecs } from "../src/engine/a11y/specs.js";
import { generateHealthSpecs } from "../src/engine/health/specs.js";
import { generateInputSpecs } from "../src/engine/inputs/specs.js";
import { generatePerformanceSpecs } from "../src/engine/performance/specs.js";
import { generateLatencySpecs } from "../src/engine/performance/latency.js";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { generateSecuritySpecs } from "../src/engine/security/specs.js";
import { generateVisionSpecs } from "../src/engine/vision/specs.js";
import { generateVisualSpecs } from "../src/engine/visual/baseline.js";
import { ASSERT_CHECKS, RESPONSE_CHECKS, StoredStepSchema, TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";
import { modelFor } from "./fixtures/checks-app.js";

const header = (kind = "web") => `Test: An example test\nKind: ${kind}\n`;
const stepOf = (line: string, kind = "web") => {
    const r = parseDsl(header(kind) + line + "\n");
    expect(r.diagnostics, line).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return r.spec!.steps[0]! as any;
};
const specOf = (text: string) => {
    const r = parseDsl(text);
    expect(r.diagnostics).toEqual([]);
    return r.spec!;
};

describe("the grammar follows the schema", () => {
    const options = (StoredStepSchema as unknown as { options: Array<{ shape: Record<string, { value?: string }> }> }).options;
    const ACTIONS = options.map((o) => o.shape.action!.value!);

    it("has a phrase for every action of the schema (a new action fails here until the text format covers it)", () => {
        // 14, plus upload and drag (frames-uploads-popups) and email (hard sign-ins)
        expect(ACTIONS.length).toBe(17);
        for (const a of ACTIONS) expect(PHRASES.some((p) => p.fixed.action === a), `action ${a}`).toBe(true);
    });

    it("has a phrase for every check of the schema", () => {
        for (const c of ASSERT_CHECKS) expect(PHRASES.some((p) => p.fixed.action === "assert" && p.fixed.check === c), `assert ${c}`).toBe(true);
        for (const c of RESPONSE_CHECKS) expect(PHRASES.some((p) => p.fixed.action === "assertResponse" && p.fixed.check === c), `response ${c}`).toBe(true);
    });

    it("names only fields the step action really has, in templates that compile", () => {
        const ids = new Set<string>();
        for (const p of PHRASES) {
            expect(ids.has(p.id), `duplicate id ${p.id}`).toBe(false);
            ids.add(p.id);
            const option = options.find((o) => o.shape.action!.value === p.fixed.action)!;
            for (const template of [p.template, ...(p.aliases ?? [])]) {
                compileTemplate(template);
                for (const s of slotsOf(template)) {
                    if (s.type === "reqopts") continue;
                    expect(Object.keys(option.shape), `${p.id}: ${s.name}`).toContain(s.name);
                }
            }
            for (const k of [...Object.keys(p.fixed), ...(p.absent ?? [])]) expect(Object.keys(option.shape), `${p.id}: ${k}`).toContain(k);
        }
    });

    it("every example reads back as its own phrase, and as no other", () => {
        for (const p of PHRASES) {
            if (p.for === "desktop") continue;
            const toks = tokenize(p.example);
            const all = matchAll(toks, p.example, new Furthest());
            expect(all.map((m) => m.phrase.id), p.example).toEqual([p.id]);
        }
    });

    it("every example is what the printer writes for the step it reads (the examples are the canonical form)", () => {
        for (const p of PHRASES) {
            if (p.for === "desktop") continue;
            // A phone phrase is refused inside a web or API test (phone tests are not text yet), so its line is read on its own.
            const step = p.for === "mobile" ? (readStepLine(p.example)!.step as never) : stepOf(p.example, p.for === "api" ? "api" : "web");
            expect(printStep(step), p.id).toBe(p.example);
        }
    });

    it("every alias reads as the same step as the main wording", () => {
        const pairs: Array<[string, string]> = [
            ["Open /pricing", "Go to /pricing"],
            ["Visit /pricing", "Go to /pricing"],
            ['Enter "x" into the "Name" field', 'Type "x" into the "Name" field'],
            ['Select "Large" in the "Size" field', 'Choose the option "Large" in the "Size" field'],
            ['Expect the "Item" listitem to appear 1 time', 'Expect the "Item" listitem to appear 1 times'],
        ];
        for (const [alias, main] of pairs) expect(normalizeStep(stepOf(alias)), alias).toBe(normalizeStep(stepOf(main)));
        // and each phrase with an alias is covered by a pair above
        expect(PHRASES.filter((p) => p.aliases?.length).length).toBe(4);
    });

    it("the feature document lists every phrase example and header line (the table and the document cannot drift)", () => {
        const doc = readFileSync(path.join(process.cwd(), "docs/features/text-tests.md"), "utf8");
        for (const p of phraseReference().phrases) expect(doc, p.id).toContain(p.example.replace(/`/g, "'"));
        for (const h of Object.values(HEADER_INFO)) expect(doc, h.line).toContain(h.line);
    });

    it("the reference made for the editor lists every phrase and header, with examples", () => {
        const ref = phraseReference();
        expect(ref.phrases.length).toBe(PHRASES.filter((p) => p.for !== "desktop" && p.for !== "mobile").length);
        expect(ref.headers.map((h) => h.key)).toEqual(Object.keys(HEADER_INFO));
        for (const p of ref.phrases) expect(p.example.length).toBeGreaterThan(5);
    });
});

describe("the example from the brief", () => {
    const text = `Test: Sign in and see the dashboard
Kind: web

Go to /login
Type "{{credentials.username}}" into the "Email" field
Type "{{credentials.password}}" into the "Password" field
Click the "Sign in" button
Expect the text "Welcome back" to be visible
Run the reusable steps "Open the cart" with item = "Mug"
`;
    it("reads into the steps the editor shows", () => {
        const spec = specOf(text);
        expect(spec.title).toBe("Sign in and see the dashboard");
        expect(spec.kind).toBe("web");
        expect(spec.steps.map((s) => s.action)).toEqual(["navigate", "fill", "fill", "click", "assert", "useBlock"]);
        expect(spec.steps[1]).toMatchObject({ locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" });
        expect(spec.steps[3]).toMatchObject({ locator: { by: "role", role: "button", value: "Sign in" } });
        expect(spec.steps[4]).toMatchObject({ check: "visible", locator: { by: "text", value: "Welcome back" } });
        expect(spec.steps[5]).toMatchObject({ block: "Open the cart", args: { item: "Mug" } });
    });

    it("prints back the same lines (plus the category line), and printing is stable", () => {
        const spec = specOf(text);
        const out = printSpec(spec);
        expect(out.expressible).toBe(true);
        expect(out.text.split("\n").filter((l) => l && !l.startsWith("Category:"))).toEqual(text.split("\n").filter((l) => l));
        const again = printSpec(specOf(out.text));
        expect(again.text).toBe(out.text);
    });

    it("is case-insensitive for words and ignores extra spaces, blank lines, comments and trailing spaces", () => {
        const spec = specOf(`# a comment\n\nTEST: Messy   spacing\nkind: WEB\n\n   go TO    /login   \n# another\nCLICK   the "Sign in"   BUTTON\n`);
        expect(spec.steps).toHaveLength(2);
        expect(spec.steps[0]).toMatchObject({ action: "navigate", url: "/login" });
        expect(spec.steps[1]).toMatchObject({ locator: { by: "role", role: "button", value: "Sign in" } });
    });

    it("drops comments (they are not kept when a test is saved)", () => {
        const printed = printSpec(specOf(`Test: With comments\n# gone\nGo to /\n`)).text;
        expect(printed).not.toContain("gone");
    });
});

describe("locators", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
        ['the "Email" field', { by: "label", value: "Email" }],
        ['the "Search" placeholder', { by: "placeholder", value: "Search" }],
        ['the text "Welcome"', { by: "text", value: "Welcome" }],
        ['the test id "cart"', { by: "testId", value: "cart" }],
        ['the element "#main > a.primary"', { by: "css", value: "#main > a.primary" }],
        ['the "Sign in" button', { by: "role", role: "button", value: "Sign in" }],
        ['the "Settings" tab', { by: "role", role: "tab", value: "Settings" }],
        ["the button", { by: "role", role: "button" }],
        ['the "Email" field exactly', { by: "label", value: "Email", exact: true }],
        ['the "Email" field loosely', { by: "label", value: "Email", exact: false }],
        ['the "Item" listitem number 3', { by: "role", role: "listitem", value: "Item", nth: 2 }],
        ['the text "x" exactly number 2', { by: "text", value: "x", exact: true, nth: 1 }],
        ['the shared element "Cart / Checkout button"', { ref: "Cart / Checkout button" }],
        ['the "" button', { by: "role", role: "button", value: "" }],
    ];
    for (const [phrase, locator] of cases) {
        it(`${phrase}`, () => {
            const line = `Click ${phrase}`;
            const step = stepOf(line);
            expect(step).toMatchObject({ action: "click", locator });
            expect(printStep(step)).toBe(line);
        });
    }

    it("a locator that is a shared element cannot carry other settings", () => {
        const r = parseDsl(header() + 'Click the shared element "A" exactly\n');
        expect(r.spec).toBeNull();
    });

    it("never reads `the page` as an element named page", () => {
        expect(parseDsl(header() + "Click the page\n").spec).toBeNull();
        expect(stepOf('Expect the page to show "Hi"')).toMatchObject({ check: "visible", expected: "Hi" });
        expect(stepOf('Expect the page to show "Hi"').locator).toBeUndefined();
    });
});

describe("every phrase has a distinct meaning", () => {
    const web = (line: string) => stepOf(line);
    const api = (line: string) => stepOf(line, "api");
    it("web actions", () => {
        expect(web("Go to https://other.example/x?y=1")).toMatchObject({ action: "navigate", url: "https://other.example/x?y=1" });
        expect(web('Go to "/path with space"')).toMatchObject({ url: "/path with space" });
        expect(web('Check the "Remember me" field')).toMatchObject({ action: "check", checked: true });
        expect(web('Uncheck the "Remember me" field')).toMatchObject({ action: "check", checked: false });
        expect(web('Press the key "Enter"')).toMatchObject({ action: "press", key: "Enter" });
        expect(web('Press the key "Enter"').locator).toBeUndefined();
        expect(web('Press the key "Tab" in the "Email" field')).toMatchObject({ key: "Tab", locator: { by: "label" } });
        expect(web("Wait 250 ms")).toMatchObject({ action: "wait", ms: 250 });
        expect(web('Hover over the "Menu" button')).toMatchObject({ action: "hover" });
        expect(web('Expect the page not to show "Error"')).toMatchObject({ check: "hidden", expected: "Error" });
        expect(web("Expect the address to contain \"/done\"")).toMatchObject({ check: "url", expected: "/done" });
        expect(web('Expect the "Item" listitem to appear 3 times')).toMatchObject({ check: "count", expected: 3 });
        expect(web("Expect no accessibility problems")).toMatchObject({ check: "a11y" });
        expect(web("Expect no accessibility problems").expected).toBeUndefined();
        expect(web('Expect no accessibility problems of impact "critical" or worse in the element "#main"')).toMatchObject({ expected: "critical", locator: { by: "css", value: "#main" } });
        expect(web("Expect the page to match its approved screenshot within 20 pixels")).toMatchObject({ check: "screenshot", expected: 20 });
    });

    it("API steps", () => {
        expect(api("Send a get request to /api/items")).toMatchObject({ action: "request", method: "GET", path: "/api/items", auth: "default" });
        const full = api('Send a POST request to /api/orders with the query "a" = "1" with the header "X-Id" = "7" with the body {"sku":"A1","n":[1,2,{"x":null}]} without signing in and remember "orderId" from "id"');
        expect(full).toMatchObject({ method: "POST", query: { a: "1" }, headers: { "X-Id": "7" }, body: { sku: "A1", n: [1, 2, { x: null }] }, auth: "none", extract: { orderId: "id" } });
        // options may come in any order
        expect(api('Send a PUT request to /x and remember "a" from "b" with the body 5 with the header "H" = "v"')).toMatchObject({ body: 5, headers: { H: "v" }, extract: { a: "b" } });
        expect(api('Send a POST request to /x with the body "just text"')).toMatchObject({ body: "just text" });
        expect(api("Expect the status to be 201")).toMatchObject({ check: "status", expected: 201 });
        expect(api('Expect the status to be "201"')).toMatchObject({ expected: "201" });
        expect(api("Expect the status to be below 500")).toMatchObject({ check: "statusBelow", expected: 500 });
        expect(api('Expect the response field "a.b" to be true')).toMatchObject({ check: "jsonPath", path: "a.b", expected: true });
        expect(api('Expect the response field "a.b" to exist')).toMatchObject({ check: "jsonPath", path: "a.b" });
        expect(api('Expect the response field "a.b" to exist').expected).toBeUndefined();
        expect(api('Expect the response to be of type "array"')).toMatchObject({ check: "jsonType", expected: "array" });
        expect(api('Expect the response header "Content-Type" to contain "json"')).toMatchObject({ check: "header", path: "Content-Type", expected: "json" });
        expect(api('Expect the response to match the schema {"type":"object","required":["id"]}')).toMatchObject({ check: "matchesSchema", schema: { type: "object", required: ["id"] } });
        expect(api("Expect the HTTPS certificate to be valid for at least 30 days")).toMatchObject({ check: "tlsCertificate", expected: 30 });
    });

    it("a step note keeps the description", () => {
        const s = stepOf('Click the "Pay" button note "The only way to pay"');
        expect(s.description).toBe("The only way to pay");
        expect(printStep(s)).toBe('Click the "Pay" button note "The only way to pay"');
        expect(stepOf('Type "a" into the "Name" field note "x"').description).toBe("x");
    });
});

describe("header lines", () => {
    it("reads every header and prints the non-default ones", () => {
        const spec = specOf(`Test: Everything\nKind: api\nCategory: Orders\nType: security\nPriority: critical\nDescription: Checks "the" orders\nTag: one\nTag: two\nPrecondition: A user exists\nResult: Nothing breaks\nData: sku = "A1"\nData: who = "Ada"\nSend a GET request to /api\n`);
        expect(spec).toMatchObject({ title: "Everything", kind: "api", category: "Orders", type: "security", priority: "critical", description: 'Checks "the" orders', tags: ["one", "two"], preconditions: ["A user exists"], expectedResults: ["Nothing breaks"], testData: { sku: "A1", who: "Ada" } });
        const printed = printSpec(spec);
        expect(printed.expressible).toBe(true);
        expect(printed.text).toContain("Type: security");
        expect(printed.text).toContain("Priority: critical");
        expect(comparableSpec(specOf(printed.text))).toBe(comparableSpec(spec));
        // defaults are not printed
        expect(printSpec(specOf("Test: Plain\nGo to /\n")).text).not.toMatch(/Type:|Priority:|Description:/);
    });

    it("quotes a header value only when it must", () => {
        const base = { ...specOf("Test: Quoting\nGo to /\n") };
        for (const description of ['"starts with a quote', " leading space", "trailing space ", "two\nlines", "tab\there", 'plain "inside" quotes', "unicode é 日本 🙂"]) {
            const spec = { ...base, description };
            const out = printSpec(spec);
            expect(out.expressible, JSON.stringify(description)).toBe(true);
            expect(specOf(out.text).description).toBe(description);
        }
        expect(printSpec({ ...base, description: "plain text" }).text).toContain("Description: plain text\n");
    });

    it("explains each header mistake", () => {
        const msg = (t: string) => parseDsl(t).diagnostics.map((d) => `${d.line}: ${d.message}`);
        expect(msg("Go to /\n")[0]).toContain("title");
        expect(msg("Test: ab\nGo to /\n")[0]).toContain("3 to 160");
        expect(msg("Test: Fine title\nTest: Again\nGo to /\n")[0]).toContain("appears twice");
        expect(msg("Test: Fine title\nKind: mobile\nGo to /\n")[0]).toContain("Mobile tests cannot be written as text");
        expect(msg("Test: Fine title\nKind: banana\nGo to /\n")[0]).toContain("web or api");
        expect(msg("Test: Fine title\nPriority: urgent\nGo to /\n")[0]).toContain("critical, high, medium, low");
        expect(msg("Test: Fine title\nType: weird\nGo to /\n")[0]).toContain("functional");
        expect(msg("Test: Fine title\nGo to /\nTag: late\n")[0]).toContain("go before the first step");
        expect(msg("Test: Fine title\nData: broken\nGo to /\n")[0]).toContain('name = "value"');
        expect(msg("Test: Fine title\nData: __proto__ = \"x\"\nGo to /\n")[0]).toMatch(/letters|name/);
        expect(msg('Test: "Fine" x\nGo to /\n')[0]).toContain("Nothing may follow");
        expect(msg("Test: \nGo to /\n")[0]).toContain("needs a value");
    });

    it("suggests the header when its name is a near miss", () => {
        const d = parseDsl("Tittle: A good title\nGo to /\n").diagnostics[0]!;
        expect(d.line).toBe(1);
        expect(d.suggestion).toContain("Test:");
        const p = parseDsl("Test: Fine title\nPriorty: high\nGo to /\n").diagnostics[0]!;
        expect(p.suggestion).toContain("Priority:");
    });

    it("a step for the other kind of test says so", () => {
        expect(parseDsl("Test: Wrong kind\nKind: api\nGo to /\n").diagnostics[0]!.message).toContain("works on a page");
        expect(parseDsl("Test: Wrong kind\nSend a GET request to /x\n").diagnostics[0]!.message).toContain("calls an API");
    });

    it("refuses desktop steps in text", () => {
        expect(parseDsl("Test: Desktop one\nStart the application\n").diagnostics[0]!.message).toContain("desktop");
    });
});

describe("diagnostics", () => {
    it("reports the line and column of each mistake, and keeps reading after one", () => {
        const text = ["Test: Many mistakes", "", "Go to /ok", "Clik the \"Sign in\" button", 'Type "x" into the "Email"', "Frobnicate the widget", 'Click the "Save button', "Wait soon ms", "Go to /still-fine"].join("\n");
        const r = parseDsl(text);
        expect(r.spec).toBeNull();
        expect(r.diagnostics.map((d) => d.line)).toEqual([4, 5, 6, 7, 8]);
        for (const d of r.diagnostics) {
            expect(d.column).toBeGreaterThanOrEqual(1);
            expect(d.endColumn).toBeGreaterThan(d.column);
            expect(d.message).toMatch(/^[A-Z]/);
        }
        const [typo, unfinished, unknown, quote2] = r.diagnostics;
        expect(typo!.suggestion).toContain('Click the "Sign in" button');
        expect(typo!.column).toBe(1);
        expect(unfinished!.message).toMatch(/what it is|field/);
        expect(unknown!.message).toContain("I do not understand");
        expect(quote2!.message).toContain("closing quote");
        expect(r.diagnostics[4]!.message).toContain("whole number");
    });

    it('suggests the word that was probably meant ("teh" -> "the")', () => {
        const d = parseDsl(header() + 'Click teh "Sign in" button\n').diagnostics[0]!;
        expect(d.column).toBe(7);
        expect(d.suggestion).toBe('Did you mean "the"?');
        const e = parseDsl(header() + 'Expect the page to shwo "x"\n').diagnostics[0]!;
        expect(e.suggestion).toBe('Did you mean "show"?');
    });

    it("tells apart a step that is not finished from one with extra text", () => {
        expect(parseDsl(header() + 'Type "x" into\n').diagnostics[0]!.message).toContain("not finished");
        expect(parseDsl(header() + "Go to /a /b\n").diagnostics[0]!.message).toContain("extra text");
        expect(parseDsl(header() + "Click\n").diagnostics[0]!.message).toContain("not finished");
    });

    it("recognises curly and single quotes", () => {
        expect(parseDsl(header() + "Click the “Sign in” button\n").diagnostics[0]!.message).toContain("straight double quotes");
        expect(parseDsl(header() + "Click the 'Sign in' button\n").diagnostics[0]!.message).toContain("double quotes");
    });

    it("explains values the schema refuses", () => {
        expect(parseDsl(header() + "Wait 20000 ms\n").diagnostics[0]).toMatchObject({ line: 3, message: expect.stringContaining("at most 10000") });
        expect(parseDsl(header() + `Run the reusable steps "${"x".repeat(81)}"\n`).diagnostics[0]!.message).toContain("1 to 80");
    });

    it("needs a quote's leading space and a JSON that is whole", () => {
        expect(parseDsl(header("api") + 'Send a POST request to /x with the header "A" = "b"c\n').spec).toBeNull();
        expect(parseDsl(header("api") + "Send a POST request to /x with the body {broken\n").diagnostics[0]!.message).toContain("JSON");
        expect(parseDsl(header("api") + 'Send a POST request to /x with the body {"a":}\n').diagnostics[0]!.message).toContain("valid JSON");
        expect(parseDsl(header("api") + 'Send a POST request to /x with the body {"a":1}x\n').spec).toBeNull();
        expect(parseDsl(header("api") + 'Send a POST request to /x with the header "A" = "1" with the header "A" = "2"\n').diagnostics[0]!.message).toContain("given twice");
    });
});

describe("limits", () => {
    it("refuses more than 500 lines and more than 50 KB, with one plain message", () => {
        const many = header() + "Go to /\n".repeat(600);
        const r = parseDsl(many);
        expect(r.spec).toBeNull();
        expect(r.diagnostics).toHaveLength(1);
        expect(r.diagnostics[0]!.message).toContain("500 lines");
        const big = header() + `Type "${"a".repeat(DSL_LIMITS.bytes)}" into the "Name" field\n`;
        expect(parseDsl(big).diagnostics[0]!.message).toContain("50 KB");
        // counted in bytes, not characters
        const wide = header() + `Description: ${"é".repeat(30_000)}\nGo to /\n`;
        expect(parseDsl(wide).diagnostics[0]!.message).toContain("50 KB");
    });

    it("lists at most 50 problems and says there were more", () => {
        const text = header() + "nonsense line\n".repeat(120);
        const r = parseDsl(text);
        expect(r.diagnostics).toHaveLength(50);
        expect(r.truncated).toBe(true);
        expect(parseDsl(header() + "nonsense\n").truncated).toBe(false);
    });

    it("caps the list headers", () => {
        const tags = Array.from({ length: 25 }, (_, i) => `Tag: t${i}`).join("\n");
        expect(parseDsl(`Test: Many tags\n${tags}\nGo to /\n`).diagnostics[0]!.message).toContain("at most 20 tags");
    });

    it("reads a very long string and a long line", () => {
        const long = "x".repeat(2000);
        expect(specOf(header() + `Type "${long}" into the "Name" field\n`).steps[0]).toMatchObject({ value: long });
        expect(parseDsl(header() + "Go to /" + "a".repeat(30_000) + "\n").diagnostics[0]!.message).toContain("25000");
    });

    it("an empty text or one with only comments needs a title and a step", () => {
        expect(parseDsl("").diagnostics[0]!.message).toContain("title");
        expect(parseDsl("Test: Only a title\n").diagnostics[0]!.message).toContain("at least one step");
        expect(parseDsl("# nothing\n\n").diagnostics.length).toBeGreaterThan(0);
    });

    it("handles Windows line ends and a byte order mark", () => {
        const r = parseDsl("\uFEFFTest: Windows lines\r\nGo to /a\r\nClick the button\r\n");
        expect(r.diagnostics).toEqual([]);
        expect(r.spec!.steps).toHaveLength(2);
    });
});

describe("escaping", () => {
    const nasty = [
        'He said "hi"',
        "back\\slash and \\n literal",
        "line one\nline two\r\nthree\ttab",
        "{{credentials.username}} and {{unique}} and {not a placeholder}",
        "unicode é 日本語 🙂 \u2028 \u200b",
        "control \u0001 \u001f chars",
        "quote at the end\\",
        '""',
        "",
        " leading and trailing ",
        "= and , and ; and [brackets] and note \"inside\"",
    ];
    for (const value of nasty) {
        it(`round-trips ${JSON.stringify(value).slice(0, 40)}`, () => {
            const step = { action: "fill", locator: { by: "label", value }, value, description: "" } as const;
            const line = printStep(step as never)!;
            expect(line, "must be expressible").toBeDefined();
            expect(line.includes("\n")).toBe(false);
            expect(normalizeStep(readStepLine(line)!.step)).toBe(normalizeStep(step));
        });
    }

    it("quote() and the tokenizer agree", () => {
        for (const s of nasty) {
            const [t] = tokenize(quote(s));
            expect(t!.kind).toBe("str");
            expect(t!.value).toBe(s);
        }
        expect(tokenize('"\\q"')[0]!.kind).toBe("bad");
        expect(tokenize('"open')[0]!.kind).toBe("bad");
        expect(tokenize('"\\u12"')[0]!.kind).toBe("bad");
        expect(tokenize('"\\u00e9"')[0]!.value).toBe("é");
    });

    it("placeholders pass through untouched and are never evaluated", () => {
        const s = stepOf('Type "{{credentials.password}}-{{unique}}-{{ spaced }}" into the "Password" field');
        expect(s).toMatchObject({ value: "{{credentials.password}}-{{unique}}-{{ spaced }}" });
        expect(stepOf("Go to {{base}}/items/{{id}}")).toMatchObject({ url: "{{base}}/items/{{id}}" });
    });
});

describe("reusable steps and keys that could do harm", () => {
    it("reads values given to a block and prints them back", () => {
        const s = stepOf('Run the reusable steps "Sign in" with email = "a@b.test" and plan = "pro"');
        expect(s).toMatchObject({ action: "useBlock", block: "Sign in", args: { email: "a@b.test", plan: "pro" } });
        expect(printStep(s)).toBe('Run the reusable steps "Sign in" with email = "a@b.test" and plan = "pro"');
        expect(stepOf('Run the reusable steps "Sign in"')).toMatchObject({ block: "Sign in" });
        expect(stepOf('Run the reusable steps "Sign in"').args).toBeUndefined();
    });

    it("refuses a value given twice, a bad name and an over-long value", () => {
        expect(parseDsl(header() + 'Run the reusable steps "X" with a = "1" and a = "2"\n').diagnostics[0]!.message).toContain("given twice");
        expect(parseDsl(header() + 'Run the reusable steps "X" with 9a = "1"\n').spec).toBeNull();
        expect(parseDsl(header() + `Run the reusable steps "X" with a = "${"v".repeat(501)}"\n`).diagnostics[0]!.message).toContain("500");
    });

    it("does not let __proto__ or constructor change any object", () => {
        const before = Object.getOwnPropertyNames(Object.prototype).sort();
        const proto = parseDsl(header() + 'Run the reusable steps "X" with __proto__ = "polluted"\n');
        expect(proto.spec).toBeNull();
        expect(proto.diagnostics[0]!.message).toMatch(/not allowed/);
        // `constructor` is only a name here: it becomes an own key, nothing else
        const ctor = specOf(header() + 'Run the reusable steps "X" with constructor = "v" and prototype = "w"\n');
        const args = (ctor.steps[0] as { args: Record<string, string> }).args;
        expect(Object.keys(args)).toEqual(["constructor", "prototype"]);
        expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
        expect(args.constructor).toBe("v");
        // headers, queries, remembered names and test data refuse it too
        for (const line of ['Send a GET request to /x with the header "__proto__" = "x"', 'Send a GET request to /x with the query "__proto__" = "x"', 'Send a GET request to /x and remember "__proto__" from "id"']) {
            expect(parseDsl(header("api") + line + "\n").spec, line).toBeNull();
        }
        expect(parseDsl('Test: Data keys\nData: __proto__ = "x"\nGo to /\n').spec).toBeNull();
        // JSON bodies and schemas
        for (const body of ['{"__proto__":{"polluted":true}}', '{"a":{"__proto__":1}}', '{"constructor":{"prototype":{"x":1}}}', '[{"__proto__":0}]']) {
            const r = parseDsl(header("api") + `Send a POST request to /x with the body ${body}\n`);
            expect(r.spec, body).toBeNull();
            expect(r.diagnostics[0]!.message, body).toMatch(/not allowed/);
        }
        const ok = specOf(header("api") + 'Send a POST request to /x with the body {"constructor":"just a word","proto":1}\n');
        expect((ok.steps[0] as { body: unknown }).body).toEqual({ constructor: "just a word", proto: 1 });
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    });

    it("limits how deep a JSON body may nest", () => {
        const deep = "[".repeat(200) + "]".repeat(200);
        expect(parseDsl(header("api") + `Send a POST request to /x with the body ${deep}\n`).spec).toBeNull();
    });
});

describe("what text cannot show is never lost silently", () => {
    const base = (steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "A stored test", kind: "web", steps, source: { origin: "manual" }, ...extra });

    it("marks a step with a setting no phrase has, says why, and leaves a comment line", () => {
        const spec = base([{ action: "navigate", url: "/" }, { action: "assert", check: "a11y", expected: 100 }, { action: "click", locator: { by: "role", role: "Button", value: "x" } }]);
        const out = printSpec(spec);
        expect(out.expressible).toBe(false);
        expect(out.reasons).toHaveLength(2);
        expect(out.reasons[0]).toContain("Step 2");
        expect(out.reasons[1]).toContain("Step 3");
        expect(out.text).toContain("# not expressible: step 2");
        expect(out.text).toContain("Go to /");
    });

    it("a step with extra fields, a bad key or an odd value cannot be written", () => {
        expect(printStep({ action: "click", locator: { by: "css", value: "a", role: "x" } } as never)).toBeUndefined();
        expect(printStep({ action: "assert", check: "visible", locator: { by: "text", value: "a" }, expected: "also" } as never)).toBeUndefined();
        expect(printStep({ action: "useBlock", block: "B", args: { "bad name": "1" } } as never)).toBeUndefined();
        expect(printStep({ action: "request", method: "GET", path: "/x", headers: { A: 1 } } as never)).toBeUndefined();
        expect(printStep({ action: "wait", ms: 1.5 } as never)).toBeUndefined();
        expect(printStep({ action: "assert", check: "text", locator: { by: "text", value: "a" }, expected: 1e21 } as never)).toBeUndefined();
    });

    it("mobile and desktop tests, or a desktop target, are not expressible", () => {
        const desktop = TestSpecSchema.parse({ testId: "DSK-001", title: "Desktop test", kind: "desktop", desktop: { app: "calc.exe" }, steps: [{ action: "launchApp" }, { action: "closeApp" }], source: { origin: "manual" } });
        const out = printSpec(desktop);
        expect(out.expressible).toBe(false);
        expect(out.reasons.join(" ")).toMatch(/Desktop tests cannot/);
        expect(printSpec(base([{ action: "navigate", url: "/" }], { kind: "mobile" })).expressible).toBe(false);
    });

    it("empty maps mean the same as no map", () => {
        const step = { action: "request", method: "GET", path: "/x", query: {}, headers: {}, extract: {}, auth: "default" } as never;
        expect(printStep(step)).toBe("Send a GET request to /x");
    });

    it("an expressible test comes back identical", () => {
        const spec = base([{ action: "navigate", url: "/", description: "Open it" }, { action: "click", locator: { ref: "Cart / Pay" } }], { description: "d", tags: ["a b", "c"], testData: { k: "v w" } });
        const out = printSpec(spec);
        expect(out.expressible).toBe(true);
        expect(comparableSpec(specOf(out.text))).toBe(comparableSpec(spec));
    });
});

// ── round trip on every spec the platform makes by itself ─────────────────

describe("round trip on generated specs", () => {
    const origin = "https://shop.example";
    const model = modelFor(origin, [
        { path: "/", type: "home" },
        { path: "/products", type: "content" },
        { path: "/login", type: "login" as never },
        { path: "/cart", type: "cart" as never },
        { path: "/checkout", type: "checkout" as never },
    ]);
    const openapi = parseOpenApi(
        { openapi: "3.0.0", info: { title: "t", version: "1" }, paths: { "/a": { get: { responses: { "200": { description: "ok" } } } }, "/b": { get: { parameters: [{ name: "limit", in: "query", required: true, schema: { type: "integer" } }], responses: { "200": { description: "ok" } } } } } },
        "http://x/openapi.json",
    ).operations;
    const drafts = [
        ...generateHealthSpecs(model, { maxPages: 5 }),
        ...generateInputSpecs(model, { maxPages: 3 } as never),
        ...generatePerformanceSpecs(model, { maxPages: 3 } as never),
        ...generateSecuritySpecs(model, {}),
        ...generateVisualSpecs(model, { maxPages: 3 }),
        ...generateA11ySpecs(model, { maxPages: 5 }),
        ...generateVisionSpecs(model, { maxPages: 3 }),
        ...generateLatencySpecs(openapi, { maxEndpoints: 4 }),
    ];
    const specs = drafts.map((d, i) => TestSpecSchema.parse({ ...d, testId: `${d.kind === "api" ? "API" : "WEB"}-${String(i + 1).padStart(3, "0")}` }));

    it("has a useful spread", () => {
        expect(specs.length).toBeGreaterThan(15);
        expect(new Set(specs.flatMap((s) => s.steps.map((x) => (x.action === "assert" || x.action === "assertResponse" ? x.check : x.action)))).size).toBeGreaterThan(12);
    });

    it("every generated spec is expressible and reads back as the same test", () => {
        for (const spec of specs) {
            const out = printSpec(spec);
            expect(out.reasons, spec.title).toEqual([]);
            expect(out.expressible, spec.title).toBe(true);
            const back = parseDsl(out.text);
            expect(back.diagnostics, spec.title).toEqual([]);
            expect(comparableSpec(back.spec!), spec.title).toBe(comparableSpec(spec));
            // and printing is stable
            expect(printSpec(back.spec!).text, spec.title).toBe(out.text);
        }
    });
});

// ── random step lists ─────────────────────────────────────────────────────

/** A small seeded generator, so a failure can be reproduced from the seed in its message. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("round trip on random step lists", () => {
    const CHARS = ['"', "\\", " ", "\n", "\t", "{", "}", "[", "]", "=", "#", "é", "日", "🙂", "a", "b", "Z", "0", "9", ".", "/", ":", ",", "'", "{{x}}", "note", "\u2028"];
    const word = (r: () => number) => {
        const n = Math.floor(r() * 12);
        let out = "";
        for (let i = 0; i < n; i++) out += CHARS[Math.floor(r() * CHARS.length)];
        return out;
    };
    const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const locator = (r: () => number): Record<string, unknown> => {
        const by = pick(r, ["label", "placeholder", "text", "testId", "css", "role", "role-noname", "ref"] as const);
        const mods = { ...(r() < 0.3 ? { exact: r() < 0.5 } : {}), ...(r() < 0.3 ? { nth: Math.floor(r() * 5) } : {}) };
        if (by === "ref") return { ref: word(r) || "x" };
        if (by === "role") return { by, role: pick(r, ["button", "link", "tab", "heading", "listitem", "menuitem"]), value: word(r), ...mods };
        if (by === "role-noname") return { by: "role", role: pick(r, ["button", "link", "tab"]), ...mods };
        return { by, value: word(r), ...mods };
    };
    const record = (r: () => number) => Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, (_, i) => [`k${i}${word(r)}`, word(r)]));
    const scalar = (r: () => number) => (r() < 0.5 ? word(r) : r() < 0.5 ? Math.floor(r() * 1000) : r() < 0.5);
    const json = (r: () => number, depth = 0): unknown => {
        const k = r();
        if (depth > 2 || k < 0.3) return pick(r, [word(r), Math.floor(r() * 100) / 4, true, false, null]);
        if (k < 0.65) return Array.from({ length: Math.floor(r() * 3) }, () => json(r, depth + 1));
        return Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, (_, i) => [`f${i}${word(r)}`, json(r, depth + 1)]));
    };
    const noteMaybe = (r: () => number) => (r() < 0.25 ? { description: word(r) } : {});

    const webStep = (r: () => number): Record<string, unknown> => {
        const loc = locator(r);
        const n = noteMaybe(r);
        switch (Math.floor(r() * 16)) {
            case 0: return { action: "navigate", url: word(r), ...n };
            case 1: return { action: "click", locator: loc, ...n };
            case 2: return { action: "fill", locator: loc, value: word(r), ...n };
            case 3: return { action: "select", locator: loc, value: word(r), ...n };
            case 4: return { action: "check", locator: loc, checked: r() < 0.5, ...n };
            case 5: return { action: "press", key: word(r), ...(r() < 0.5 ? { locator: loc } : {}), ...n };
            case 6: return { action: "hover", locator: loc, ...n };
            case 7: return { action: "wait", ms: Math.floor(r() * 10_000), ...n };
            case 8: return { action: "assert", check: pick(r, ["visible", "hidden", "enabled", "disabled"]), locator: loc, ...n };
            case 9: return { action: "assert", check: pick(r, ["visible", "hidden", "text", "url", "title"]), expected: word(r), ...n };
            case 10: return { action: "assert", check: "text", locator: loc, expected: scalarAssert(r), ...n };
            case 11: return { action: "assert", check: "count", locator: loc, expected: Math.floor(r() * 50), ...n };
            case 12: return { action: "assert", check: "a11y", ...(r() < 0.5 ? { expected: pick(r, ["minor", "serious"]) } : {}), ...(r() < 0.5 ? { locator: loc } : {}), ...n };
            case 13: return { action: "assert", check: pick(r, ["pageSpeed", "inputHandling", "looksRight", "screenshot"]), ...(r() < 0.5 ? { expected: word(r) } : {}), ...n };
            case 14: return { action: "useBlock", block: word(r) || "B", ...(r() < 0.6 ? { args: Object.fromEntries(Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => [`p${i}`, word(r)])) } : {}), ...n };
            default: return { action: "assert", check: pick(r, ["noConsoleErrors", "noFailedRequests", "noBrokenLinks", "noMixedContent", "pageBasics"]), ...n };
        }
    };
    const scalarAssert = (r: () => number) => (r() < 0.7 ? word(r) : Math.floor(r() * 100));
    const apiStep = (r: () => number): Record<string, unknown> => {
        const n = noteMaybe(r);
        switch (Math.floor(r() * 9)) {
            case 0:
            case 1:
                return {
                    action: "request",
                    method: pick(r, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
                    path: word(r),
                    ...(r() < 0.4 ? { query: record(r) } : {}),
                    ...(r() < 0.4 ? { headers: record(r) } : {}),
                    ...(r() < 0.4 ? { body: json(r) } : {}),
                    auth: pick(r, ["default", "none"]),
                    ...(r() < 0.3 ? { extract: record(r) } : {}),
                    ...n,
                };
            case 2: return { action: "assertResponse", check: pick(r, ["status", "statusClass", "statusBelow", "bodyContains", "bodyNotContains"]), expected: scalar(r), ...n };
            case 3: return { action: "assertResponse", check: "jsonPath", path: word(r), ...(r() < 0.7 ? { expected: scalar(r) } : {}), ...n };
            case 4: return { action: "assertResponse", check: "jsonType", ...(r() < 0.5 ? { path: word(r) } : {}), expected: word(r), ...n };
            case 5: return { action: "assertResponse", check: "header", path: word(r), expected: scalar(r), ...n };
            case 6: return { action: "assertResponse", check: "matchesSchema", schema: Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, (_, i) => [`s${i}`, json(r)])), ...n };
            case 7: return { action: "assertResponse", check: pick(r, ["cookieFlags", "corsPolicy", "noExposedFiles", "noInfoDisclosure"]), ...n };
            default: return { action: "assertResponse", check: pick(r, ["securityHeaders", "tlsCertificate", "latency", "load", "statusDenied"]), ...(r() < 0.5 ? { expected: word(r) } : {}), ...n };
        }
    };

    for (const kind of ["web", "api"] as const) {
        it(`${kind}: 300 random tests print, read back the same and print the same again`, () => {
            let checked = 0;
            for (let seed = 1; seed <= 300; seed++) {
                const r = rng(seed * 7919 + (kind === "api" ? 13 : 0));
                const steps = Array.from({ length: 1 + Math.floor(r() * 6) }, () => (kind === "web" ? webStep(r) : apiStep(r)));
                const parsed = TestSpecSchema.safeParse({
                    testId: kind === "web" ? "WEB-001" : "API-001",
                    title: `Random ${seed} ${word(r)}`.slice(0, 160),
                    description: word(r),
                    kind,
                    category: `C${word(r)}`.slice(0, 80),
                    type: pick(r, ["functional", "security", "smoke"]),
                    priority: pick(r, ["critical", "medium", "low"]),
                    preconditions: r() < 0.3 ? [word(r)] : [],
                    expectedResults: r() < 0.3 ? [word(r), word(r)] : [],
                    tags: r() < 0.3 ? [word(r)] : [],
                    testData: r() < 0.3 ? { a: word(r), b_2: word(r) } : {},
                    steps,
                });
                if (!parsed.success) continue; // an invalid random step is not what this proves
                const spec = parsed.data;
                const out = printSpec(spec);
                // Anything the printer declares expressible must read back exactly. Most random tests are expressible: that is checked below.
                if (!out.expressible) continue;
                const back = parseDsl(out.text);
                expect(back.diagnostics, `seed ${seed}\n${out.text}`).toEqual([]);
                expect(comparableSpec(back.spec!), `seed ${seed}\n${out.text}`).toBe(comparableSpec(spec));
                expect(printSpec(back.spec!).text, `seed ${seed}`).toBe(out.text);
                checked++;
            }
            expect(checked, "most random tests should be expressible").toBeGreaterThan(200);
        });
    }
});
