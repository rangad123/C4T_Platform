/**
 * Manual test cases, browser-free and database-free:
 *  - validation of a case (every limit at the boundary, control characters, defaults);
 *  - CSV reading and writing (quotes, newlines, CRLF, byte-order mark, formula injection, round trip, caps);
 *  - JSON import shapes;
 *  - the roll-up and the sign-off rules as tables (every block and every warning, boundaries), the override comment and the sentence.
 */
import { describe, expect, it } from "vitest";
import { ManualCaseInputSchema, MAX_CASES, MAX_STEPS, MAX_TITLE, ResultInputSchema } from "../src/engine/manual/cases.js";
import { casesToCsv, casesToJson, ManualImportError, parseCsv, parseCsvCases, parseImport, parseJsonCases, parseSteps, protectCell } from "../src/engine/manual/csv.js";
import { evaluateSignoff, OVERRIDE_MIN_COMMENT, overrideCommentOk, releaseSentence, rollup, SIGNOFF_RULES, type AutomatedState, type RollupItem } from "../src/engine/manual/signoff.js";

const ok = (v: unknown) => ManualCaseInputSchema.safeParse(v);
const base = { title: "Check the invoice PDF" };

describe("a manual case", () => {
    it("fills in the defaults", () => {
        expect(ManualCaseInputSchema.parse(base)).toEqual({ title: "Check the invoice PDF", steps: [], area: "General", priority: "medium", linkedTestIds: [], requirement: "" });
    });

    it("cuts surrounding space and control characters but keeps line breaks in steps", () => {
        const c = ManualCaseInputSchema.parse({ title: "  Print\u0000 it\u0007  ", steps: [{ action: "Open\u001b the page\nthen print", expected: " a page " }] });
        expect(c.title).toBe("Print it");
        expect(c.steps[0]).toEqual({ action: "Open the page\nthen print", expected: "a page" });
    });

    it("keeps markup as plain text (it is escaped when shown, never interpreted)", () => {
        const c = ManualCaseInputSchema.parse({ title: "<script>alert(1)</script>" });
        expect(c.title).toBe("<script>alert(1)</script>");
    });

    it.each([
        ["an empty title", { title: "" }, false],
        ["a title of only spaces", { title: "   " }, false],
        ["a title of 160 characters", { title: "x".repeat(MAX_TITLE) }, true],
        ["a title of 161 characters", { title: "x".repeat(MAX_TITLE + 1) }, false],
        ["a missing title", {}, false],
        ["a title that is not text", { title: 5 }, false],
        ["30 steps", { ...base, steps: Array.from({ length: MAX_STEPS }, () => ({ action: "a", expected: "b" })) }, true],
        ["31 steps", { ...base, steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ action: "a", expected: "b" })) }, false],
        ["a step of 500 characters", { ...base, steps: [{ action: "a".repeat(500), expected: "b".repeat(500) }] }, true],
        ["an action of 501 characters", { ...base, steps: [{ action: "a".repeat(501), expected: "" }] }, false],
        ["an expected result of 501 characters", { ...base, steps: [{ action: "a", expected: "b".repeat(501) }] }, false],
        ["a step with no action", { ...base, steps: [{ action: " ", expected: "x" }] }, false],
        ["a step with no expected result", { ...base, steps: [{ action: "a" }] }, true],
        ["an area of 80 characters", { ...base, area: "a".repeat(80) }, true],
        ["an area of 81 characters", { ...base, area: "a".repeat(81) }, false],
        ["priority critical", { ...base, priority: "critical" }, true],
        ["an unknown priority", { ...base, priority: "urgent" }, false],
        ["a requirement of 500 characters", { ...base, requirement: "r".repeat(500) }, true],
        ["a requirement of 501 characters", { ...base, requirement: "r".repeat(501) }, false],
        ["50 linked tests", { ...base, linkedTestIds: Array.from({ length: 50 }, (_, i) => `t${i}`) }, true],
        ["51 linked tests", { ...base, linkedTestIds: Array.from({ length: 51 }, (_, i) => `t${i}`) }, false],
    ])("%s", (_name, input, valid) => {
        expect(ok(input).success).toBe(valid);
    });

    it("treats an empty area as General", () => {
        expect(ManualCaseInputSchema.parse({ ...base, area: "   " }).area).toBe("General");
    });

    it("checks a result: five values, a note of at most 1000 characters", () => {
        for (const result of ["not_run", "passed", "failed", "blocked", "skipped"]) expect(ResultInputSchema.safeParse({ result }).success).toBe(true);
        expect(ResultInputSchema.safeParse({ result: "done" }).success).toBe(false);
        expect(ResultInputSchema.safeParse({ result: "passed", note: "n".repeat(1000) }).success).toBe(true);
        expect(ResultInputSchema.safeParse({ result: "passed", note: "n".repeat(1001) }).success).toBe(false);
        expect(ResultInputSchema.safeParse({ result: "passed", by: "b".repeat(81) }).success).toBe(false);
    });
});

describe("reading CSV", () => {
    it("reads plain rows, CRLF and a final newline", () => {
        expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
        expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
        expect(parseCsv("a,b\r1,2\r")).toEqual([["a", "b"], ["1", "2"]]);
    });

    it("reads quotes, doubled quotes, commas and line breaks inside a cell", () => {
        expect(parseCsv('t,s\n"He said ""hi"", twice","line1\nline2"\n')).toEqual([["t", "s"], ['He said "hi", twice', "line1\nline2"]]);
    });

    it("drops a byte-order mark and keeps empty cells", () => {
        expect(parseCsv("﻿a,b,c\n1,,3\n")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
    });

    it("refuses a quote that is never closed", () => {
        expect(() => parseCsv('a,b\n"open,2')).toThrow(ManualImportError);
    });

    it("splits steps into action and expected result on the first arrow", () => {
        expect(parseSteps("Open the page => It loads\nClick Pay\n\n  Check => a => b  ")).toEqual([
            { action: "Open the page", expected: "It loads" },
            { action: "Click Pay", expected: "" },
            { action: "Check", expected: "a => b" },
        ]);
    });
});

describe("importing CSV", () => {
    const csv = (rows: string[]) => ["title,area,priority,steps", ...rows].join("\n");

    it("builds cases from the four columns, in any column order, ignoring unknown columns", () => {
        const r = parseCsvCases('steps,extra,title,priority\n"Open => Loads",x,Open the page,HIGH\n');
        expect(r.skipped).toEqual([]);
        expect(r.cases).toEqual([{ title: "Open the page", area: "General", priority: "high", steps: [{ action: "Open", expected: "Loads" }], linkedTestIds: [], requirement: "" }]);
    });

    it("needs a title column", () => {
        expect(() => parseCsvCases("name,area\nx,y")).toThrow(/“title” column/);
        expect(() => parseCsvCases("")).toThrow(/empty/);
    });

    it("skips bad rows with their row number and a plain reason, and imports the rest", () => {
        const r = parseCsvCases(csv(["Good,Billing,low,", ",Billing,low,", `${"t".repeat(161)},Billing,low,`, "Odd priority,Billing,urgent,", "Fine,Billing,,"]));
        expect(r.cases.map((c) => c.title)).toEqual(["Good", "Fine"]);
        expect(r.skipped).toEqual([
            { row: 3, reason: "The title is required" },
            { row: 4, reason: "The title can be at most 160 characters" },
            { row: 5, reason: expect.stringContaining("Priority “urgent” is not one of") },
        ]);
    });

    it("skips a row with more than 30 steps", () => {
        const steps = Array.from({ length: MAX_STEPS + 1 }, (_, i) => `s${i} => ok`).join("\n");
        const r = parseCsvCases(`title,steps\nToo long,"${steps}"\n`);
        expect(r.cases).toEqual([]);
        expect(r.skipped[0]).toEqual({ row: 2, reason: "A case can have at most 30 steps" });
    });

    it("ignores blank lines from a spreadsheet", () => {
        const r = parseCsvCases("title,area\nA,x\n,\n\nB,y\n");
        expect(r.cases.map((c) => c.title)).toEqual(["A", "B"]);
        expect(r.skipped).toEqual([]);
    });

    it("accepts exactly 500 cases and refuses 501", () => {
        const rows = (n: number) => `title\n${Array.from({ length: n }, (_, i) => `Case ${i}`).join("\n")}\n`;
        expect(parseCsvCases(rows(MAX_CASES)).cases).toHaveLength(MAX_CASES);
        expect(() => parseCsvCases(rows(MAX_CASES + 1))).toThrow(/at most 500/);
    });

    it("refuses a file that is far too large", () => {
        expect(() => parseCsvCases(`title\n${"x".repeat(2_000_001)}`)).toThrow(/too large/);
    });

    it("keeps a formula-looking title as plain text", () => {
        const r = parseCsvCases('title\n"=HYPERLINK(""http://evil.test"")"\n');
        expect(r.cases[0]!.title).toBe('=HYPERLINK("http://evil.test")');
    });
});

describe("exporting CSV", () => {
    const one = (over: Record<string, unknown>) => ({ title: "T", area: "A", priority: "medium" as const, steps: [], ...over });

    it.each(["=", "+", "-", "@"])("puts a quote in front of a cell that starts with %s", (ch) => {
        const csv = casesToCsv([one({ title: `${ch}cmd|' /C calc'!A0`, area: `${ch}area` })]);
        const lines = csv.trim().split("\r\n");
        expect(lines[1]!.startsWith(`'${ch}cmd`)).toBe(true);
        expect(lines[1]).toContain(`,'${ch}area,`);
        expect(protectCell(`${ch}x`)).toBe(`'${ch}x`);
    });

    it("leaves ordinary cells alone, including a dash inside the text", () => {
        expect(protectCell("Pay - confirm")).toBe("Pay - confirm");
        expect(protectCell("")).toBe("");
    });

    it("protects a steps cell that starts with a dash", () => {
        const csv = casesToCsv([one({ steps: [{ action: "-5 degrees", expected: "works" }] })]);
        expect(csv).toContain("'-5 degrees => works");
    });

    it("writes the header, quotes cells with commas, quotes and line breaks, and ends each line with CRLF", () => {
        const csv = casesToCsv([one({ title: 'A "quoted", title', steps: [{ action: "Open", expected: "Loads" }, { action: "Click", expected: "" }] })]);
        expect(csv).toBe('title,area,priority,steps\r\n"A ""quoted"", title",A,medium,"Open => Loads\nClick"\r\n');
    });

    it("survives a round trip, formula protection included", () => {
        const cases = [
            one({ title: '=SUM(A1) "x", y', area: "Pay, billing", priority: "critical", steps: [{ action: "-1 step", expected: "multi\nline" }, { action: "Open", expected: "" }] }),
            one({ title: "Plain", area: "+Area" }),
        ];
        const back = parseCsvCases(casesToCsv(cases)).cases;
        expect(back.map((c) => [c.title, c.area, c.priority])).toEqual([
            ['=SUM(A1) "x", y', "Pay, billing", "critical"],
            ["Plain", "+Area", "medium"],
        ]);
        // a line break inside a step becomes a space so that one step stays one line
        expect(back[0]!.steps).toEqual([{ action: "-1 step", expected: "multi line" }, { action: "Open", expected: "" }]);
    });

    it("writes the JSON export that the JSON import reads back", () => {
        const c = { id: "i", number: 1, ref: "TC-001", automation: "automated" as const, requirementId: null, createdAt: "x", updatedAt: "x", title: "T", area: "A", priority: "low" as const, steps: [{ action: "a", expected: "b" }], linkedTestIds: ["t1"], requirement: "R-1" };
        const text = casesToJson([c], new Date("2026-10-08T00:00:00Z"));
        expect(JSON.parse(text).exportedAt).toBe("2026-10-08T00:00:00.000Z");
        expect(parseJsonCases(text).cases).toEqual([{ title: "T", area: "A", priority: "low", automation: "automated", steps: [{ action: "a", expected: "b" }], linkedTestIds: ["t1"], requirement: "R-1" }]);
    });
});

describe("importing JSON", () => {
    it("takes a list, or an object with a cases list, or text of either", () => {
        const item = { title: "A" };
        expect(parseJsonCases([item]).cases).toHaveLength(1);
        expect(parseJsonCases({ cases: [item, item] }).cases).toHaveLength(2);
        expect(parseJsonCases(JSON.stringify([item])).cases).toHaveLength(1);
    });

    it("reports bad items by position and refuses other shapes", () => {
        const r = parseJsonCases([{ title: "A" }, { title: "" }, "text", { title: "B", priority: "nope" }]);
        expect(r.cases.map((c) => c.title)).toEqual(["A"]);
        expect(r.skipped.map((s) => s.row)).toEqual([2, 3, 4]);
        expect(() => parseJsonCases({ nope: 1 })).toThrow(/list of cases/);
        expect(() => parseJsonCases("{not json")).toThrow(/not valid JSON/);
        expect(() => parseJsonCases(Array.from({ length: MAX_CASES + 1 }, () => ({ title: "x" })))).toThrow(/at most 500/);
    });

    it("tells step errors by step number", () => {
        const r = parseJsonCases([{ title: "A", steps: [{ action: "ok" }, { action: "" }] }]);
        expect(r.skipped[0]!.reason).toBe("Step 2: A step’s action is required");
    });

    it("chooses JSON or CSV by the text when no format is given", () => {
        expect(parseImport('[{"title":"A"}]').cases).toHaveLength(1);
        expect(parseImport("title\nA\nB").cases).toHaveLength(2);
        expect(parseImport("title\nA", "csv").cases).toHaveLength(1);
        expect(() => parseImport([{ title: "A" }], "csv")).toThrow(/as text/);
    });
});

// ── sign-off rules ──────────────────────────────────────────────────────────

const item = (priority: RollupItem["priority"], result: RollupItem["result"]): RollupItem => ({ priority, result });
const auto = (state: AutomatedState, reasons: string[] = []) => ({ state, reasons: reasons.map((text) => ({ text })) });

describe("roll-up", () => {
    it("counts every result and what is left", () => {
        const r = rollup([item("low", "passed"), item("low", "failed"), item("low", "blocked"), item("low", "skipped"), item("low", "not_run"), item("high", "not_run")]);
        expect(r).toEqual({ total: 6, passed: 1, failed: 1, blocked: 1, skipped: 1, notRun: 2, left: 3, done: 3 });
    });
    it("is all zeros for nothing", () => {
        expect(rollup([])).toEqual({ total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, notRun: 0, left: 0, done: 0 });
    });
});

describe("sign-off rules", () => {
    // name, automated, items, blocking codes, warning codes
    const table: Array<[string, ReturnType<typeof auto> | null, RollupItem[], string[], string[]]> = [
        ["everything done and ready", auto("ready"), [item("critical", "passed"), item("low", "passed")], [], []],
        ["no manual checks and ready", auto("ready"), [], [], []],
        ["automated blocked", auto("blocked", ["1 critical finding"]), [], ["automated-blocked"], []],
        ["a failed manual check", auto("ready"), [item("low", "failed")], ["manual-failed"], []],
        ["a critical check not run", auto("ready"), [item("critical", "not_run")], ["important-unfinished"], []],
        ["a high check blocked", auto("ready"), [item("high", "blocked")], ["important-unfinished"], []],
        ["a high check skipped is a decision, not a block", auto("ready"), [item("high", "skipped")], [], []],
        ["a medium check not run is only a warning", auto("ready"), [item("medium", "not_run")], [], ["other-unfinished"]],
        ["a low check blocked is only a warning", auto("ready"), [item("low", "blocked")], [], ["other-unfinished"]],
        ["a low check failed still blocks", auto("ready"), [item("low", "failed")], ["manual-failed"], []],
        ["automated needs attention is a warning", auto("needs-attention", ["2 tests failing in the last run"]), [], [], ["automated-attention"]],
        ["automated unknown is a warning", auto("unknown"), [], [], ["automated-unknown"]],
        ["no automated information at all is a warning", null, [], [], ["automated-unknown"]],
        [
            "everything wrong at once, in rule order",
            auto("blocked"),
            [item("critical", "failed"), item("high", "not_run"), item("medium", "not_run")],
            ["automated-blocked", "manual-failed", "important-unfinished"],
            ["other-unfinished"],
        ],
        ["needs attention with a failed check", auto("needs-attention"), [item("medium", "failed")], ["manual-failed"], ["automated-attention"]],
    ];
    it.each(table)("%s", (_name, automated, items, blocking, warnings) => {
        const e = evaluateSignoff({ automated, items });
        expect(e.blocking.map((x) => x.code)).toEqual(blocking);
        expect(e.warnings.map((x) => x.code)).toEqual(warnings);
        expect(e.canApprove).toBe(blocking.length === 0);
    });

    it("says why in plain words, with counts", () => {
        const e = evaluateSignoff({
            automated: auto("blocked", ["1 critical finding", "2 high-severity findings", "third reason"]),
            items: [item("critical", "failed"), item("low", "failed"), item("high", "not_run"), item("critical", "blocked"), item("low", "not_run")],
        });
        expect(e.blocking.map((b) => b.text)).toEqual([
            "The automated tests are blocked: 1 critical finding; 2 high-severity findings",
            "2 manual checks failed",
            "2 critical or high-priority manual checks not finished (not run or blocked)",
        ]);
        expect(e.warnings.map((b) => b.text)).toEqual(["1 medium or low-priority manual check not finished"]);
        expect(evaluateSignoff({ automated: auto("ready"), items: [item("low", "failed")] }).blocking[0]!.text).toBe("1 manual check failed");
    });

    it("needs an override comment of at least 10 characters after trimming", () => {
        expect(OVERRIDE_MIN_COMMENT).toBe(10);
        expect(overrideCommentOk("123456789")).toBe(false);
        expect(overrideCommentOk("1234567890")).toBe(true);
        expect(overrideCommentOk("   123456789   ")).toBe(false);
        expect(overrideCommentOk("")).toBe(false);
        expect(overrideCommentOk(undefined)).toBe(false);
    });

    it("publishes its rules in words", () => {
        expect(SIGNOFF_RULES.blocking).toHaveLength(3);
        expect(SIGNOFF_RULES.warnings).toHaveLength(3);
        expect(SIGNOFF_RULES.override).toMatch(/10 characters/);
    });
});

describe("the sentence", () => {
    const r = (left: number, total: number) => ({ ...rollup([]), total, left });
    it.each([
        [3, 14, "ready", "Release 2.4: 3 of 14 manual checks left, automated tests ready"],
        [1, 1, "needs-attention", "Release 2.4: 1 of 1 manual check left, automated tests need attention"],
        [0, 5, "blocked", "Release 2.4: all 5 manual checks done, automated tests blocked"],
        [0, 1, "ready", "Release 2.4: the manual check is done, automated tests ready"],
        [0, 0, "unknown", "Release 2.4: no manual checks, automated state unknown"],
    ] as const)("%i of %i, %s", (left, total, state, text) => {
        expect(releaseSentence("2.4", r(left, total), state)).toBe(text);
    });
    it("treats a missing automated state as unknown", () => {
        expect(releaseSentence("x", r(0, 0), null)).toBe("Release x: no manual checks, automated state unknown");
    });
});
