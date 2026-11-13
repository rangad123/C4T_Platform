/**
 * Text tests, step 5: the printer. A TestSpec in, text out, from the same grammar table the parser reads.
 *
 * The rule that protects people's tests: every line the printer writes is read back by the parser and must give the same step. A step
 * that does not (a setting no phrase can show, an odd character) is not written; the answer says the test is "not fully expressible in
 * text" and why, and the platform refuses to save the text view of such a test, so a save can never lose data silently.
 */
import { isLocatorRef, StoredStepSchema, describeStep, type Step, type TestSpec } from "../spec/schema.js";
import { compileTemplate, FRAME_LEAD, HTTP_METHODS, PHRASES, RESERVED_ROLE_WORDS, slotsOf, type El, type PhraseDef } from "./grammar.js";
import { quote } from "./lexer.js";
import { parseDsl, readStepLine } from "./parser.js";

export interface PrintResult {
    text: string;
    /** False when some part of the test has no text form. Saving the text would then lose it, so it is refused. */
    expressible: boolean;
    reasons: string[];
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const REQUEST_FIELDS = ["query", "headers", "body", "auth", "extract"];

class Unwritable extends Error {}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The text that stands for a locator, or throws Unwritable. */
function writeLocator(l: unknown): string {
    if (!record(l)) throw new Unwritable();
    if (isLocatorRef(l)) {
        if (Object.keys(l).some((k) => k !== "ref")) throw new Unwritable();
        return `the shared element ${quote(String(l.ref))}`;
    }
    const { frame, ...rest } = l;
    if (frame === undefined) return writePlainLocator(rest);
    // Frames follow the element, inner one first: the "Pay" button inside the frame "card" inside the frame "checkout".
    if (!Array.isArray(frame) || frame.length === 0 || frame.length > 3) throw new Unwritable();
    const words = [...frame].reverse().map((f: unknown) => {
        if (!record(f) || typeof f.value !== "string" || !(f.by === "name" || f.by === "title" || f.by === "url") || Object.keys(f).length !== 2) throw new Unwritable();
        return `inside the frame ${[...FRAME_LEAD[f.by], quote(f.value)].join(" ")}`;
    });
    return `${writePlainLocator(rest)} ${words.join(" ")}`;
}

function writePlainLocator(l: Record<string, unknown>): string {
    const extra = (): string => {
        const parts: string[] = [];
        if (l.exact === true) parts.push("exactly");
        else if (l.exact === false) parts.push("loosely");
        if (l.nth !== undefined) {
            if (typeof l.nth !== "number" || !Number.isInteger(l.nth) || l.nth < 0 || l.nth > 999) throw new Unwritable();
            parts.push(`number ${l.nth + 1}`);
        }
        return parts.length ? ` ${parts.join(" ")}` : "";
    };
    const value = l.value;
    switch (l.by) {
        case "role": {
            const role = l.role;
            if (typeof role !== "string" || !/^[a-z][a-z0-9-]*$/.test(role)) throw new Unwritable();
            // With no name a role is written as one word (the button); a role whose word the grammar also uses is written the role "status".
            if (value === undefined) return RESERVED_ROLE_WORDS.has(role) ? `the role ${quote(role)}${extra()}` : `the ${role}${extra()}`;
            if (typeof value !== "string") throw new Unwritable();
            return `the ${quote(value)} ${role}${extra()}`;
        }
        case "label":
        case "placeholder":
        case "text":
        case "testId":
        case "css": {
            if (typeof value !== "string" || l.role !== undefined) throw new Unwritable();
            const lead = l.by === "label" ? null : l.by === "placeholder" ? null : l.by === "text" ? "the text" : l.by === "testId" ? "the test id" : "the element";
            if (lead) return `${lead} ${quote(value)}${extra()}`;
            return `the ${quote(value)} ${l.by === "label" ? "field" : "placeholder"}${extra()}`;
        }
        default:
            throw new Unwritable();
    }
}

function writeUrl(v: unknown): string {
    if (typeof v !== "string") throw new Unwritable();
    return v !== "" && /^[^\s"]+$/.test(v) && !/[\u2028\u2029]/.test(v) ? v : quote(v);
}

function writeScalar(v: unknown): string {
    if (typeof v === "string") return quote(v);
    if (typeof v === "number" && Number.isFinite(v) && NUMBER.test(String(v))) return String(v);
    if (typeof v === "boolean") return String(v);
    throw new Unwritable();
}

function writeJson(v: unknown): string {
    if (typeof v === "string") return quote(v);
    const s = JSON.stringify(v);
    if (s === undefined) throw new Unwritable();
    return s;
}

function writeStringMap(v: unknown): Array<[string, string]> {
    if (!record(v)) throw new Unwritable();
    return Object.entries(v).map(([k, x]) => {
        if (typeof x !== "string") throw new Unwritable();
        return [k, x];
    });
}

/** The options of a request, in a fixed order, from the step's own fields. */
function writeRequestOptions(step: Record<string, unknown>): string {
    const out: string[] = [];
    if (step.query !== undefined) for (const [k, v] of writeStringMap(step.query)) out.push(`with the query ${quote(k)} = ${quote(v)}`);
    if (step.headers !== undefined) for (const [k, v] of writeStringMap(step.headers)) out.push(`with the header ${quote(k)} = ${quote(v)}`);
    if (step.body !== undefined) out.push(`with the body ${writeJson(step.body)}`);
    if (step.auth === "none") out.push("without signing in");
    else if (step.auth !== undefined && step.auth !== "default") throw new Unwritable();
    if (step.extract !== undefined) for (const [k, v] of writeStringMap(step.extract)) out.push(`and remember ${quote(k)} from ${quote(v)}`);
    return out.join(" ");
}

function writeSlot(type: string, name: string, step: Record<string, unknown>): string {
    if (type === "reqopts") return writeRequestOptions(step);
    const v = step[name];
    switch (type) {
        case "str":
            if (typeof v !== "string") throw new Unwritable();
            return quote(v);
        case "url":
            return writeUrl(v);
        case "int":
            if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 999_999_999) throw new Unwritable();
            return String(v);
        case "scalar":
            return writeScalar(v);
        case "loc":
            return writeLocator(v);
        case "json":
            return writeJson(v);
        case "method":
            if (typeof v !== "string" || !(HTTP_METHODS as readonly string[]).includes(v)) throw new Unwritable();
            return v;
        case "args": {
            const entries = writeStringMap(v);
            if (!entries.length) throw new Unwritable();
            return entries
                .map(([k, x]) => {
                    if (!PARAM_NAME.test(k)) throw new Unwritable();
                    return `${k} = ${quote(x)}`;
                })
                .join(" and ");
        }
    }
    throw new Unwritable();
}

const emptyRecord = (v: unknown) => record(v) && Object.keys(v).length === 0;

/** The step's fields that count (empty records are the same as missing ones for the fields where an empty record means nothing). */
function liveFields(step: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step)) {
        if (v === undefined) continue;
        if ((k === "query" || k === "headers" || k === "extract" || k === "args") && emptyRecord(v)) continue;
        if (k === "description" && v === "") continue;
        // "Not in a popup" and "opens no popup" are what a missing field says too.
        if ((k === "inPopup" || k === "opensPopup") && v === false) continue;
        out[k] = v;
    }
    return out;
}

function describes(p: PhraseDef, step: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(p.fixed)) if (step[k] !== v) return false;
    for (const k of p.absent ?? []) if (step[k] !== undefined) return false;
    const slots = slotsOf(p.template);
    const allowed = new Set<string>(["description", ...Object.keys(p.fixed)]);
    for (const s of slots) {
        if (s.type === "reqopts") for (const f of REQUEST_FIELDS) allowed.add(f);
        else allowed.add(s.name);
        if (!s.optional && s.type !== "reqopts" && step[s.name] === undefined) return false;
    }
    for (const k of Object.keys(step)) if (!allowed.has(k)) return false;
    return true;
}

function writeTemplate(els: El[], step: Record<string, unknown>): string[] {
    const parts: string[] = [];
    for (const el of els) {
        if (el.t === "lit") parts.push(el.w);
        else if (el.t === "slot") {
            const w = writeSlot(el.type, el.name, step);
            if (w !== "") parts.push(w);
        } else {
            // An optional part is written only when all of its slots have a value.
            const names = el.els.filter((x): x is Extract<El, { t: "slot" }> => x.t === "slot");
            if (names.every((s) => step[s.name] !== undefined)) parts.push(...writeTemplate(el.els, step));
        }
    }
    return parts;
}

/** Normal form of a step, for comparing: schema defaults applied, empty maps dropped, keys sorted. */
export function normalizeStep(step: unknown): string {
    const parsed = StoredStepSchema.safeParse(step);
    const base = parsed.success ? (parsed.data as unknown as Record<string, unknown>) : record(step) ? step : {};
    return stable(liveFields(base));
}

function stable(v: unknown): string {
    const walk = (x: unknown): unknown => (Array.isArray(x) ? x.map(walk) : record(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])])) : x);
    return JSON.stringify(walk(v));
}

/** One step as a line of text, or undefined when no phrase can show it exactly. */
export function printStep(step: Step): string | undefined {
    // Defaults the schema fills in (a box is ticked unless said otherwise) are part of the step before it is written.
    const parsed = StoredStepSchema.safeParse(step);
    const { inPopup, ...live } = liveFields((parsed.success ? parsed.data : step) as unknown as Record<string, unknown>);
    if (inPopup !== undefined && inPopup !== true) return undefined;
    const want = normalizeStep(step);
    for (const phrase of PHRASES) {
        if (phrase.for === "desktop" || !describes(phrase, live)) continue;
        let line: string;
        try {
            line = writeTemplate(compileTemplate(phrase.template), live).join(" ");
            if (inPopup) line += " in the popup";
            const note = live.description;
            if (note !== undefined) {
                if (typeof note !== "string") continue;
                line += ` note ${quote(note)}`;
            }
        } catch (e) {
            if (e instanceof Unwritable) continue;
            throw e;
        }
        // Proof that it reads back the same.
        const back = readStepLine(line);
        if (back && normalizeStep(back.step) === want) return line;
    }
    return undefined;
}

// ── headers ─────────────────────────────────────────────────────────────

/** A header value as text: plain when that reads back exactly, in quotes otherwise. */
function headerValue(v: string): string {
    return v === "" || /^"|^\s|\s$|[\u0000-\u001f\u2028\u2029]/.test(v) ? quote(v) : v;
}

/** The parts of a spec the text carries, as one string (what the round trip must keep). */
export function comparableSpec(spec: TestSpec): string {
    return stable({
        title: spec.title,
        description: spec.description,
        kind: spec.kind,
        category: spec.category,
        type: spec.type,
        priority: spec.priority,
        ...(spec.pinnedTime !== undefined ? { pinnedTime: spec.pinnedTime } : {}),
        preconditions: spec.preconditions,
        expectedResults: spec.expectedResults,
        testData: spec.testData,
        tags: spec.tags,
        steps: spec.steps.map((s) => JSON.parse(normalizeStep(s))),
    });
}

export function printSpec(spec: TestSpec): PrintResult {
    const reasons: string[] = [];
    const out: string[] = [];
    if (spec.kind !== "web" && spec.kind !== "api") reasons.push(`${spec.kind[0]!.toUpperCase()}${spec.kind.slice(1)} tests cannot be written as text yet.`);
    if (spec.desktop !== undefined) reasons.push("This test names a Windows application, which text cannot show.");
    if (spec.platform !== undefined) reasons.push("This test is for a specific phone platform, which text cannot show.");

    out.push(`Test: ${headerValue(spec.title)}`);
    out.push(`Kind: ${spec.kind}`);
    out.push(`Category: ${headerValue(spec.category)}`);
    if (spec.type !== "functional") out.push(`Type: ${spec.type}`);
    if (spec.priority !== "medium") out.push(`Priority: ${spec.priority}`);
    if (spec.description !== "") out.push(`Description: ${headerValue(spec.description)}`);
    if (spec.pinnedTime !== undefined) out.push(`Date: ${headerValue(spec.pinnedTime)}`);
    for (const t of spec.tags) out.push(`Tag: ${headerValue(t)}`);
    for (const p of spec.preconditions) out.push(`Precondition: ${headerValue(p)}`);
    for (const r of spec.expectedResults) out.push(`Result: ${headerValue(r)}`);
    for (const [k, v] of Object.entries(spec.testData)) out.push(`Data: ${k} = ${quote(v)}`);
    out.push("");

    spec.steps.forEach((step, i) => {
        const line = printStep(step);
        if (line !== undefined) out.push(line);
        else {
            const what = oneLine(describeStep(step));
            reasons.push(`Step ${i + 1} (${what}) has settings that text cannot show.`);
            out.push(`# not expressible: step ${i + 1}, ${what}`);
        }
    });

    let text = out.join("\n") + "\n";
    // Last proof, for the parts the line checks do not cover (the header lines and the order): the whole text must read back as the test.
    if (!reasons.length) {
        const back = parseDsl(text);
        if (!back.spec || comparableSpec(back.spec) !== comparableSpec(spec)) reasons.push("The text does not read back as exactly the same test (for example a header with an unusual character or too many entries).");
    }
    if (reasons.length) text = text.replace(/\n$/, "") + "\n";
    return { text, expressible: reasons.length === 0, reasons };
}

const oneLine = (s: string, n = 70) => (s.replace(/\s+/g, " ").length > n ? `${s.replace(/\s+/g, " ").slice(0, n - 1)}…` : s.replace(/\s+/g, " "));
