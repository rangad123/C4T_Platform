/**
 * Text tests, step 4: the parser. Text in, a canonical TestSpec (or plain-language problems with line and column) out.
 *
 * Nothing is evaluated: placeholders such as {{credentials.password}} stay text, there are no includes and no files or addresses are
 * read. A mistake on one line does not hide the others: every line is read on its own, up to 50 problems are reported.
 */
import { PRIORITIES, TEST_TYPES, TestSpecSchema, type TestSpec } from "../spec/schema.js";
import { editDistance, tokenize, type Token } from "./lexer.js";
import { HEADER_ALIASES, HEADER_KEYS, type HeaderKey, type PhraseDef } from "./grammar.js";
import { buildStep, Furthest, matchAll, nearestPhrase, splitPopup } from "./match.js";

export const DSL_LIMITS = { lines: 500, bytes: 50 * 1024, diagnostics: 50, lineLength: 25_000, title: [3, 160], category: 80, description: 2000, listItems: 20, listItemLength: 500, tag: 40, data: 30, dataValue: 500 } as const;

export interface DslDiagnostic {
    /** One-based. */
    line: number;
    column: number;
    endColumn: number;
    message: string;
    suggestion?: string;
}

export interface ParseResult {
    /** The test, or null when anything is wrong (nothing is guessed). */
    spec: TestSpec | null;
    diagnostics: DslDiagnostic[];
    /** True when there were more than 50 problems and only the first 50 are listed. */
    truncated: boolean;
    /** The line each step was written on (index = step number − 1). */
    stepLines: number[];
    /** Which optional header lines the text had (the platform fills in the others from the stored test or its defaults). */
    present: Partial<Record<HeaderKey, boolean>>;
}

const HEADER_RE = /^([A-Za-z][A-Za-z ]{0,24}?)\s*:(.*)$/;
const DATA_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/;
const VERBS = "Go to, Click, Type, Choose, Check, Press, Hover over, Upload, Drag, Wait, Expect, Send, Run";

const joinOr = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);
const oneLine = (s: string, n = 60) => (s.replace(/\s+/g, " ").length > n ? `${s.replace(/\s+/g, " ").slice(0, n - 1)}…` : s.replace(/\s+/g, " "));

export function parseDsl(input: string): ParseResult {
    const diagnostics: DslDiagnostic[] = [];
    let overflow = false;
    const add = (line: number, column: number, endColumn: number, message: string, suggestion?: string) => {
        if (diagnostics.length >= DSL_LIMITS.diagnostics) {
            overflow = true;
            return;
        }
        diagnostics.push({ line, column, endColumn: Math.max(endColumn, column + 1), message, ...(suggestion ? { suggestion } : {}) });
    };
    const fail = (): ParseResult => ({ spec: null, diagnostics, truncated: overflow, stepLines: [], present: {} });

    if (typeof input !== "string") {
        add(1, 1, 2, "There is no text to read.");
        return fail();
    }
    if (Buffer.byteLength(input, "utf8") > DSL_LIMITS.bytes) {
        add(1, 1, 2, `This text is larger than ${DSL_LIMITS.bytes / 1024} KB. Split it into smaller tests.`);
        return fail();
    }
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > DSL_LIMITS.lines) {
        add(DSL_LIMITS.lines + 1, 1, 2, `A text test can have at most ${DSL_LIMITS.lines} lines. Split it into smaller tests.`);
        return fail();
    }

    const present: ParseResult["present"] = {};
    const head: { title?: string; kind: "web" | "api"; category?: string; type?: string; priority?: string; description?: string; date?: string } = { kind: "web" };
    const tags: string[] = [];
    const preconditions: string[] = [];
    const results: string[] = [];
    const data = new Map<string, string>();
    const steps: Array<Record<string, unknown>> = [];
    const stepLines: number[] = [];
    let stepsStarted = false;

    for (let n = 0; n < lines.length; n++) {
        const raw = lines[n]!;
        const lineNo = n + 1;
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        if (raw.length > DSL_LIMITS.lineLength) {
            add(lineNo, 1, 2, `This line is longer than ${DSL_LIMITS.lineLength} characters.`);
            continue;
        }
        const indent = raw.length - raw.trimStart().length;
        const body = raw.trimEnd().slice(indent);
        const col = (offset: number) => indent + offset + 1;

        // ── header lines ───────────────────────────────────────────────
        const hm = HEADER_RE.exec(body);
        const typed = hm ? hm[1]!.trim().toLowerCase().replace(/\s+/g, " ") : undefined;
        const key = typed !== undefined ? (HEADER_ALIASES[typed] ?? typed) : undefined;
        if (hm && key && (HEADER_KEYS as readonly string[]).includes(key)) {
            const k = key as HeaderKey;
            const colon = body.indexOf(":");
            if (stepsStarted) {
                add(lineNo, col(0), col(colon), `Header lines such as ${k === "test" ? "Test:" : `${k[0]!.toUpperCase()}${k.slice(1)}:`} go before the first step. Move this line up.`);
                continue;
            }
            const restRaw = body.slice(colon + 1);
            const lead = restRaw.length - restRaw.trimStart().length;
            const valueStart = colon + 1 + lead;
            const rest = restRaw.trim();
            let value: string | undefined;
            if (rest.startsWith('"')) {
                const toks = tokenize(rest);
                const t = toks[0]!;
                if (t.kind === "bad") add(lineNo, col(valueStart + t.start), col(valueStart + t.end), t.error ?? "This text cannot be read.");
                else if (toks.length > 1) add(lineNo, col(valueStart + toks[1]!.start), col(valueStart + rest.length), "Nothing may follow the closing quote. Put the whole value in the quotes, or remove them.");
                else value = t.value;
            } else if (rest === "") {
                add(lineNo, col(colon), col(colon + 1), `${k === "test" ? "Test" : k[0]!.toUpperCase() + k.slice(1)}: needs a value after the colon.`);
            } else value = rest;
            if (value === undefined) continue;
            const range = [col(valueStart), col(valueStart + rest.length)] as const;
            const once = (name: string, set: () => void) => {
                if (present[k]) add(lineNo, col(0), col(colon), `${name} appears twice. A test has only one.`);
                else set();
                present[k] = true;
            };
            switch (k) {
                case "test":
                    once("Test:", () => {
                        head.title = value;
                        if (value.length < DSL_LIMITS.title[0] || value.length > DSL_LIMITS.title[1]) add(lineNo, ...range, `The title needs ${DSL_LIMITS.title[0]} to ${DSL_LIMITS.title[1]} characters.`);
                    });
                    break;
                case "kind": {
                    once("Kind:", () => {
                        const v = value.toLowerCase();
                        if (v === "web" || v === "api") head.kind = v;
                        else if (v === "mobile" || v === "desktop") add(lineNo, ...range, `${v[0]!.toUpperCase()}${v.slice(1)} tests cannot be written as text yet. Use web or api.`);
                        else add(lineNo, ...range, "The kind is web or api.", "Kind: web");
                    });
                    break;
                }
                case "category":
                    once("Category:", () => {
                        head.category = value;
                        if (value.length > DSL_LIMITS.category) add(lineNo, ...range, `The category can have at most ${DSL_LIMITS.category} characters.`);
                    });
                    break;
                case "type":
                    once("Type:", () => {
                        const v = value.toLowerCase();
                        if ((TEST_TYPES as readonly string[]).includes(v)) head.type = v;
                        else add(lineNo, ...range, `The type is one of ${TEST_TYPES.join(", ")}.`);
                    });
                    break;
                case "priority":
                    once("Priority:", () => {
                        const v = value.toLowerCase();
                        if ((PRIORITIES as readonly string[]).includes(v)) head.priority = v;
                        else add(lineNo, ...range, `The priority is one of ${PRIORITIES.join(", ")}.`);
                    });
                    break;
                case "date":
                    once("Date:", () => {
                        if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value))) head.date = value;
                        else add(lineNo, ...range, "The date is written like 2025-01-15 or 2025-01-15T12:00:00Z.");
                    });
                    break;
                case "description":
                    once("Description:", () => {
                        head.description = value;
                        if (value.length > DSL_LIMITS.description) add(lineNo, ...range, `The description can have at most ${DSL_LIMITS.description} characters.`);
                    });
                    break;
                case "tag":
                case "precondition":
                case "result": {
                    const list = k === "tag" ? tags : k === "precondition" ? preconditions : results;
                    const max = k === "tag" ? DSL_LIMITS.tag : DSL_LIMITS.listItemLength;
                    present[k] = true;
                    if (list.length >= DSL_LIMITS.listItems) add(lineNo, col(0), col(colon), `A test can have at most ${DSL_LIMITS.listItems} ${k === "tag" ? "tags" : k === "precondition" ? "preconditions" : "results"}.`);
                    else if (value.length > max) add(lineNo, ...range, `This is longer than ${max} characters.`);
                    else list.push(value);
                    break;
                }
                case "data": {
                    present.data = true;
                    const toks = tokenize(rest);
                    const bad = toks.find((t) => t.kind === "bad");
                    if (bad) add(lineNo, col(valueStart + bad.start), col(valueStart + bad.end), bad.error ?? "This text cannot be read.");
                    else if (toks.length !== 3 || toks[0]!.kind !== "word" || toks[1]!.kind !== "word" || toks[1]!.value !== "=" || toks[2]!.kind !== "str") add(lineNo, ...range, 'Write a test value as name = "value".', 'Data: name = "Ada"');
                    else if (!DATA_NAME.test(toks[0]!.value) || toks[0]!.value === "__proto__") add(lineNo, col(valueStart), col(valueStart + toks[0]!.end), "A value name uses letters, numbers, underscores, dots and dashes, and starts with a letter.");
                    else if (data.has(toks[0]!.value)) add(lineNo, col(valueStart), col(valueStart + toks[0]!.end), `The value ${toks[0]!.value} is given twice.`);
                    else if (data.size >= DSL_LIMITS.data) add(lineNo, col(0), col(colon), `A test can have at most ${DSL_LIMITS.data} test values.`);
                    else if (toks[2]!.value.length > DSL_LIMITS.dataValue) add(lineNo, col(valueStart + toks[2]!.start), col(valueStart + toks[2]!.end), `A value can have at most ${DSL_LIMITS.dataValue} characters.`);
                    else data.set(toks[0]!.value, toks[2]!.value);
                    break;
                }
            }
            continue;
        }
        if (hm && key && !stepsStarted) {
            // Something that looks like a header line but is not one we know: a typo such as "Tittle:".
            const near = [...HEADER_KEYS, ...Object.keys(HEADER_ALIASES)].map((h) => ({ h: HEADER_ALIASES[h] ?? h, d: editDistance(key, h) })).sort((a, b) => a.d - b.d)[0]!;
            if (near.d <= 2) {
                const colon = body.indexOf(":");
                add(lineNo, col(0), col(colon), `"${hm[1]!.trim()}:" is not a header line I know.`, `Did you mean "${near.h[0]!.toUpperCase()}${near.h.slice(1)}:"?`);
                continue;
            }
        }

        // ── a step ─────────────────────────────────────────────────────
        stepsStarted = true;
        const toks = tokenize(body);
        const bad = toks.find((t) => t.kind === "bad");
        if (bad) {
            add(lineNo, col(bad.start), col(bad.end), bad.error ?? "This text cannot be read.");
            continue;
        }
        // A trailing  note "why"  keeps the step's description.
        const { used, note, text: trimmedBody } = splitNote(toks, body);
        if (note !== undefined && note.length > 500) {
            add(lineNo, col(toks[toks.length - 1]!.start), col(toks[toks.length - 1]!.end), "A note can have at most 500 characters.");
            continue;
        }
        // A trailing  in the popup  does the step in the window an earlier click opened.
        const popup = splitPopup(used, trimmedBody);
        const fx = new Furthest();
        const found = matchAll(popup.used, popup.text, fx);
        if (!found.length) {
            explain(popup.used, fx, lineNo, col, add);
            continue;
        }
        const m = found[0]!;
        if (popup.inPopup && !popupStep(m.phrase)) {
            add(lineNo, col(toks[0]!.start), col(toks[toks.length - 1]!.end), "Only steps that work on a page can be done in the popup.");
            continue;
        }
        if (m.phrase.for === "desktop") {
            add(lineNo, col(toks[0]!.start), col(toks[toks.length - 1]!.end), "Windows desktop steps cannot be written as text yet.");
            continue;
        }
        if (m.phrase.for === "mobile") {
            add(lineNo, col(toks[0]!.start), col(toks[toks.length - 1]!.end), "This step is for phone tests, and phone tests cannot be written as text yet.");
            continue;
        }
        if (m.phrase.for !== "both" && m.phrase.for !== head.kind) {
            add(lineNo, col(toks[0]!.start), col(toks[toks.length - 1]!.end), m.phrase.for === "api" ? "This step calls an API, but the test says Kind: web. Change the Kind line to api (and use only API steps)." : "This step works on a page, but the test says Kind: api. Remove the Kind line (or write web) to test pages.");
            continue;
        }
        const step = buildStep(m);
        if (popup.inPopup) step.inPopup = true;
        if (note !== undefined) step.description = note;
        steps.push(step);
        stepLines.push(lineNo);
    }

    if (head.title === undefined && !present.test) add(1, 1, 2, "Start the test with a title line.", "Test: Sign in and see the dashboard");
    if (steps.length === 0 && diagnostics.length === 0) add(Math.max(1, lines.length), 1, 2, "A test needs at least one step.", 'Go to /');
    if (diagnostics.length) return { spec: null, diagnostics, truncated: overflow, stepLines, present };

    const parsed = TestSpecSchema.safeParse({
        testId: head.kind === "api" ? "API-000" : "WEB-000",
        title: head.title,
        kind: head.kind,
        ...(head.description !== undefined ? { description: head.description } : {}),
        ...(head.category !== undefined ? { category: head.category } : {}),
        ...(head.type !== undefined ? { type: head.type } : {}),
        ...(head.priority !== undefined ? { priority: head.priority } : {}),
        ...(head.date !== undefined ? { pinnedTime: head.date } : {}),
        preconditions,
        steps,
        expectedResults: results,
        testData: Object.fromEntries(data),
        tags,
        source: { origin: "manual" },
    });
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            const i = issue.path[0] === "steps" && typeof issue.path[1] === "number" ? issue.path[1] : undefined;
            const line = i !== undefined ? (stepLines[i] ?? 1) : 1;
            const field = issue.path[issue.path.length - 1];
            let message = issue.message;
            if (field === "ms") message = "Wait at most 10000 ms (10 seconds), and not a negative time. Use an expectation to wait for something.";
            else if (field === "block") message = "The reusable steps need a name of 1 to 80 characters.";
            else if (field === "ref") message = "The name of a shared element has 1 to 80 characters.";
            else if (issue.code === "too_big" && field === "args") message = "A value given to reusable steps can have at most 500 characters.";
            else if (typeof field === "string" && issue.path[issue.path.length - 2] === "args") message = "A value given to reusable steps can have at most 500 characters.";
            else message = `${issue.message}${/[.!?]$/.test(issue.message) ? "" : "."}`;
            add(line, 1, 2, message);
        }
        return { spec: null, diagnostics, truncated: overflow, stepLines, present };
    }
    return { spec: parsed.data, diagnostics: [], truncated: false, stepLines, present };
}

/** The step actions that can work in a popup window (the schema's web steps with `inPopup`). */
const POPUP_ACTIONS = new Set(["navigate", "click", "fill", "select", "check", "press", "hover", "upload", "drag", "dialog", "download", "assert"]);
const popupStep = (p: PhraseDef): boolean => p.for === "web" && POPUP_ACTIONS.has(String(p.fixed.action));

/** A step line may end with  note "why" : the text becomes the step's description. */
function splitNote(toks: Token[], body: string): { used: Token[]; note: string | undefined; text: string } {
    if (toks.length >= 2) {
        const last = toks[toks.length - 1]!;
        const before = toks[toks.length - 2]!;
        if (last.kind === "str" && before.kind === "word" && before.value.toLowerCase() === "note") return { used: toks.slice(0, -2), note: last.value, text: body.slice(0, before.start) };
    }
    return { used: toks, note: undefined, text: body };
}

/** Reads one step line on its own (the printer uses it to prove that what it wrote reads back the same). */
export function readStepLine(line: string): { step: Record<string, unknown>; phraseId: string } | undefined {
    const toks = tokenize(line);
    if (!toks.length || toks.some((t) => t.kind === "bad")) return undefined;
    const { used, note, text } = splitNote(toks, line);
    const popup = splitPopup(used, text);
    const found = matchAll(popup.used, popup.text, new Furthest());
    if (!found.length) return undefined;
    if (popup.inPopup && !popupStep(found[0]!.phrase)) return undefined;
    const step = buildStep(found[0]!);
    if (popup.inPopup) step.inPopup = true;
    if (note !== undefined) step.description = note;
    return { step, phraseId: found[0]!.phrase.id };
}

/** Plain words for "no phrase read this line". */
function explain(toks: Token[], fx: Furthest, lineNo: number, col: (o: number) => number, add: (line: number, c: number, e: number, m: string, s?: string) => void): void {
    const first = toks[0]!;
    const lastEnd = toks[toks.length - 1]!.end;
    if (fx.ti <= 0) {
        const near = nearestPhrase(toks);
        if (near) {
            add(lineNo, col(first.start), col(first.end), "I do not understand this step.", `Did you mean: ${near.phrase.example}`);
            return;
        }
        const quotesWrong = toks.find((t) => /[“”‘’]/.test(t.raw));
        if (quotesWrong) {
            add(lineNo, col(quotesWrong.start), col(quotesWrong.end), 'Use straight double quotes (") instead of curly ones.');
            return;
        }
        add(lineNo, col(first.start), col(first.end), `I do not understand this step. A step starts like one of: ${VERBS}.`);
        return;
    }
    const at = toks[fx.ti];
    const expected = [...fx.expected].filter((e) => e !== "the end of the line");
    const onlyEnd = expected.length === 0;
    let message: string;
    let c1: number;
    let c2: number;
    if (!at) {
        message = `This step is not finished: expected ${joinOr(expected.slice(0, 4))}.`;
        c1 = col(lastEnd - 1);
        c2 = col(lastEnd);
    } else if (onlyEnd) {
        message = "There is extra text at the end of this step.";
        c1 = col(at.start);
        c2 = col(lastEnd);
    } else {
        message = `Expected ${joinOr(expected.slice(0, 4))} here.`;
        c1 = col(at.start);
        c2 = col(at.end);
    }
    if (fx.note) message = fx.note;
    if (at && /[“”‘’]/.test(at.raw)) message = 'Use straight double quotes (") instead of curly ones.';
    else if (at && at.kind === "word" && at.raw.startsWith("'")) message = "Use double quotes (\"), not single quotes, around texts.";
    let suggestion: string | undefined;
    if (at && at.kind === "word") {
        const w = at.value.toLowerCase();
        const near = [...fx.literals].map((l) => ({ l, d: editDistance(w, l.toLowerCase()) })).filter((x) => x.d <= 2 && x.l.length >= 3).sort((a, b) => a.d - b.d)[0];
        if (near) suggestion = `Did you mean "${near.l}"?`;
    }
    if (!suggestion && fx.phrase) suggestion = `For example: ${oneLine(fx.phrase.example, 140)}`;
    add(lineNo, c1, c2, message, suggestion);
}
