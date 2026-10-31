/**
 * Text tests, step 3: read one step line with the grammar table. Pure and deterministic: a fixed set of phrases, no model, no network.
 *
 * The matcher tries every phrase (and alias) against the tokens of a line. It remembers how far the best attempt got and what it
 * expected there, so a mistake is reported at the place it happened ("Expected the word "to" here").
 */
import { compileTemplate, FRAME_LEAD, HTTP_METHODS, PHRASES, POPUP_SUFFIX, RESERVED_ROLE_WORDS, headWords, type El, type PhraseDef, type SlotType } from "./grammar.js";
import { editDistance, scanJsonEnd, type Token } from "./lexer.js";

export type Slots = Record<string, unknown>;

/** Tracks the furthest point any attempt reached. */
export class Furthest {
    ti = -1;
    expected = new Set<string>();
    literals = new Set<string>();
    phrase: PhraseDef | undefined;
    note: string | undefined;
    current: PhraseDef | undefined;
    fail(ti: number, expected: string, literal?: string, note?: string): null {
        if (ti > this.ti) {
            this.ti = ti;
            this.expected = new Set();
            this.literals = new Set();
            this.phrase = this.current;
            this.note = undefined;
        }
        if (ti === this.ti) {
            this.expected.add(expected);
            if (literal) this.literals.add(literal);
            if (note) this.note = note;
        }
        return null;
    }
}

interface SlotRead {
    value: unknown;
    next: number;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
/** Longest JSON value a step carries (the same number as the builder's JSON cap). */
export const JSON_MAX = 20_000;

/** A key that could change an object's prototype when a value is copied later; text tests never carry one (Fastify's JSON parser refuses the same). */
export function unsafeJsonKey(v: unknown): string | undefined {
    const stack: Array<[unknown, number]> = [[v, 0]];
    while (stack.length) {
        const [x, depth] = stack.pop()!;
        if (depth > 64) return "nested too deeply";
        if (Array.isArray(x)) for (const y of x) stack.push([y, depth + 1]);
        else if (x && typeof x === "object") {
            for (const k of Object.keys(x)) {
                if (k === "__proto__") return "__proto__";
                const val = (x as Record<string, unknown>)[k];
                if (k === "constructor" && val && typeof val === "object" && "prototype" in (val as object)) return "constructor.prototype";
                stack.push([val, depth + 1]);
            }
        }
    }
    return undefined;
}

const lower = (t: Token | undefined) => (t && t.kind === "word" ? t.value.toLowerCase() : undefined);

/** Reads `the ...` as a locator. Returns null (and records what was expected) when it is not one. */
function readLocator(toks: Token[], ti: number, fx: Furthest): SlotRead | null {
    const WANT = 'an element such as the "Email" field';
    if (lower(toks[ti]) !== "the") return fx.fail(ti, WANT, "the");
    const t1 = toks[ti + 1];
    let loc: Record<string, unknown>;
    let next: number;
    const text = (at: number, label: string): Token | null => {
        const t = toks[at];
        if (t && t.kind === "str" && !t.glued) return t;
        if (t && t.kind === "str") fx.fail(at, "a space before the quote");
        else fx.fail(at, label);
        return null;
    };
    const w1 = lower(t1);
    if (w1 === "shared") {
        if (lower(toks[ti + 2]) !== "element") return fx.fail(ti + 2, '"element"', "element");
        const s = text(ti + 3, "the name of the shared element in double quotes");
        if (!s) return null;
        // A shared element is only its name: the project's object list decides the rest, so no exact/number can go with it.
        return { value: { ref: s.value }, next: ti + 4 };
    }
    if (w1 === "element") {
        const s = text(ti + 2, "a CSS selector in double quotes");
        if (!s) return null;
        loc = { by: "css", value: s.value };
        next = ti + 3;
    } else if (w1 === "test") {
        if (lower(toks[ti + 2]) !== "id") return fx.fail(ti + 2, '"id"', "id");
        const s = text(ti + 3, "the test id in double quotes");
        if (!s) return null;
        loc = { by: "testId", value: s.value };
        next = ti + 4;
    } else if (w1 === "text") {
        const s = text(ti + 2, "the text in double quotes");
        if (!s) return null;
        loc = { by: "text", value: s.value };
        next = ti + 3;
    } else if (w1 === "role") {
        // `the role "status"`: an element with that role and no name (the short form `the button` cannot be used for a role whose word the grammar also uses).
        const s = text(ti + 2, 'a role in double quotes, such as the role "status"');
        if (!s) return null;
        if (!/^[a-z][a-z0-9-]*$/.test(s.value)) return fx.fail(ti + 2, 'a role such as "status" or "button"');
        loc = { by: "role", role: s.value };
        next = ti + 3;
    } else if (t1 && t1.kind === "str") {
        if (t1.glued) return fx.fail(ti + 1, "a space before the quote");
        const noun = lower(toks[ti + 2]);
        if (noun === undefined) return fx.fail(ti + 2, 'what it is, such as field, button or link');
        if (noun === "field") loc = { by: "label", value: t1.value };
        else if (noun === "placeholder") loc = { by: "placeholder", value: t1.value };
        else if (!/^[a-z][a-z0-9-]*$/.test(noun)) return fx.fail(ti + 2, 'what it is, such as field, button or link');
        else loc = { by: "role", role: noun, value: t1.value };
        next = ti + 3;
    } else if (w1 !== undefined && !RESERVED_ROLE_WORDS.has(w1) && /^[a-z][a-z0-9-]*$/.test(w1)) {
        // `the button`: any element with that role, no name.
        loc = { by: "role", role: w1 };
        next = ti + 2;
    } else {
        return fx.fail(ti + 1, WANT);
    }
    const w = lower(toks[next]);
    if (w === "exactly") {
        loc.exact = true;
        next++;
    } else if (w === "loosely") {
        loc.exact = false;
        next++;
    }
    if (lower(toks[next]) === "number") {
        const n = toks[next + 1];
        if (!n || n.kind !== "word" || !/^\d+$/.test(n.value) || Number(n.value) < 1 || Number(n.value) > 1000) return fx.fail(next + 1, "a position from 1, such as number 2");
        loc.nth = Number(n.value) - 1;
        next += 2;
    }
    // `inside the frame "checkout"` (by name), `inside the frame titled "Payment"`, `inside the frame at "pay.example.com"`: the inner frame first.
    const frames: Array<{ by: string; value: string }> = [];
    while (lower(toks[next]) === "inside") {
        if (lower(toks[next + 1]) !== "the") return fx.fail(next + 1, '"the"', "the");
        if (lower(toks[next + 2]) !== "frame") return fx.fail(next + 2, '"frame"', "frame");
        let at = next + 3;
        let by = "name";
        for (const [k, words] of Object.entries(FRAME_LEAD)) {
            if (words.length && lower(toks[at]) === words[0]) {
                by = k;
                at++;
            }
        }
        const s = text(at, `the frame's ${by === "name" ? "name" : by === "title" ? "title" : "address part"} in double quotes`);
        if (!s) return null;
        if (frames.length >= MAX_FRAMES) return fx.fail(next, "the end of the element", undefined, `An element can be at most ${MAX_FRAMES} frames deep.`);
        frames.push({ by, value: s.value });
        next = at + 1;
    }
    if (frames.length) loc.frame = frames.reverse();
    return { value: loc, next };
}

/** Frames inside frames that a text test can name (the schema's MAX_FRAME_DEPTH). */
const MAX_FRAMES = 3;

/** A step line that ends with `in the popup`: the words before it, and whether it did. */
export function splitPopup(toks: Token[], src: string): { used: Token[]; inPopup: boolean; text: string } {
    const n = POPUP_SUFFIX.length;
    if (toks.length > n && POPUP_SUFFIX.every((w, i) => lower(toks[toks.length - n + i]) === w)) {
        return { used: toks.slice(0, -n), inPopup: true, text: src.slice(0, toks[toks.length - n]!.start) };
    }
    return { used: toks, inPopup: false, text: src };
}

function readJson(toks: Token[], ti: number, src: string, fx: Furthest, label: string): SlotRead | null {
    const t = toks[ti];
    if (!t) return fx.fail(ti, label);
    if (t.kind === "str") {
        if (t.glued) return fx.fail(ti, "a space before the quote");
        return { value: t.value, next: ti + 1 };
    }
    if (t.kind === "bad") return fx.fail(ti, label);
    const first = t.value[0];
    if (first === "{" || first === "[") {
        const end = scanJsonEnd(src, t.start);
        if (end < 0) return fx.fail(ti, label, undefined, "This JSON is not closed (or is nested too deeply).");
        if (end - t.start > JSON_MAX) return fx.fail(ti, label, undefined, `This JSON is longer than ${JSON_MAX} characters.`);
        let value: unknown;
        try {
            value = JSON.parse(src.slice(t.start, end));
        } catch (e) {
            return fx.fail(ti, label, undefined, `This is not valid JSON (${e instanceof Error ? e.message.replace(/^.*?:\s*/, "").slice(0, 80) : "it cannot be read"}). Keys and texts need double quotes.`);
        }
        const bad = unsafeJsonKey(value);
        if (bad) return fx.fail(ti, label, undefined, bad === "nested too deeply" ? "This JSON is nested too deeply." : `The key ${bad} is not allowed.`);
        let next = ti;
        while (next < toks.length && toks[next]!.start < end) next++;
        // The closing bracket must be followed by a space (or the end), not by more text.
        if (toks[next - 1] && toks[next - 1]!.end > end) return fx.fail(next - 1, "a space after the JSON");
        return { value, next };
    }
    if (/^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)$/.test(t.value)) return { value: JSON.parse(t.value), next: ti + 1 };
    return fx.fail(ti, label);
}

function readScalar(toks: Token[], ti: number, fx: Furthest): SlotRead | null {
    const t = toks[ti];
    const WANT = "text in double quotes or a number";
    if (!t) return fx.fail(ti, WANT);
    if (t.kind === "str") return t.glued ? fx.fail(ti, "a space before the quote") : { value: t.value, next: ti + 1 };
    if (t.kind === "word") {
        if (NUMBER.test(t.value)) return { value: Number(t.value), next: ti + 1 };
        if (t.value === "true" || t.value === "false") return { value: t.value === "true", next: ti + 1 };
    }
    return fx.fail(ti, WANT);
}

function readSlot(type: SlotType, toks: Token[], ti: number, src: string, fx: Furthest): SlotRead | null {
    const t = toks[ti];
    switch (type) {
        case "str":
            if (t && t.kind === "str") return t.glued ? fx.fail(ti, "a space before the quote") : { value: t.value, next: ti + 1 };
            return fx.fail(ti, "text in double quotes");
        case "url":
            if (t && t.kind === "str") return t.glued ? fx.fail(ti, "a space before the quote") : { value: t.value, next: ti + 1 };
            if (t && t.kind === "word") return { value: t.value, next: ti + 1 };
            return fx.fail(ti, "an address or a path, such as /login");
        case "int":
            if (t && t.kind === "word" && /^\d{1,9}$/.test(t.value)) return { value: Number(t.value), next: ti + 1 };
            return fx.fail(ti, "a whole number");
        case "scalar":
            return readScalar(toks, ti, fx);
        case "loc":
            return readLocator(toks, ti, fx);
        case "json":
            return readJson(toks, ti, src, fx, "a JSON value such as {\"id\":1}");
        case "method": {
            const w = t && t.kind === "word" ? t.value.toUpperCase() : "";
            if ((HTTP_METHODS as readonly string[]).includes(w)) return { value: w, next: ti + 1 };
            return fx.fail(ti, "GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS");
        }
        case "args":
            return readArgs(toks, ti, fx);
        case "reqopts":
            return readRequestOptions(toks, ti, src, fx);
    }
}

/** `item = "Mug" and qty = "2"`. */
function readArgs(toks: Token[], ti: number, fx: Furthest): SlotRead | null {
    const out = new Map<string, string>();
    let i = ti;
    for (;;) {
        const name = toks[i];
        if (!name || name.kind !== "word" || !PARAM_NAME.test(name.value)) return fx.fail(i, "a value name, such as item");
        if (name.value === "__proto__") return fx.fail(i, "a value name, such as item", undefined, "That name is not allowed.");
        if (out.has(name.value)) return fx.fail(i, "a value name that is not used yet", undefined, `The value ${name.value} is given twice.`);
        if (toks[i + 1]?.kind !== "word" || toks[i + 1]!.value !== "=") return fx.fail(i + 1, '"="');
        const v = toks[i + 2];
        if (!v || v.kind !== "str") return fx.fail(i + 2, "the value in double quotes");
        out.set(name.value, v.value);
        i += 3;
        if (lower(toks[i]) === "and") {
            i++;
            continue;
        }
        break;
    }
    return { value: Object.fromEntries(out), next: i };
}

/** The options of a request: with the query / header / body, without signing in, and remember. Any order, each part once per name. */
function readRequestOptions(toks: Token[], ti: number, src: string, fx: Furthest): SlotRead | null {
    const query = new Map<string, string>();
    const headers = new Map<string, string>();
    const extract = new Map<string, string>();
    let body: { v: unknown } | undefined;
    let auth: "none" | undefined;
    let i = ti;
    const START = 'with the query / header / body, "without signing in" or "and remember"';
    for (;;) {
        let j = i;
        if (lower(toks[j]) === "and") j++;
        const w = lower(toks[j]);
        if (w === "with") {
            if (lower(toks[j + 1]) !== "the") return fx.fail(j + 1, '"the"', "the");
            const what = lower(toks[j + 2]);
            if (what === "query" || what === "header") {
                const k = toks[j + 3];
                if (!k || k.kind !== "str") return fx.fail(j + 3, `the ${what} name in double quotes`);
                if (toks[j + 4]?.kind !== "word" || toks[j + 4]!.value !== "=") return fx.fail(j + 4, '"="');
                const v = toks[j + 5];
                if (!v || v.kind !== "str") return fx.fail(j + 5, `the ${what} value in double quotes`);
                const target = what === "query" ? query : headers;
                if (k.value === "__proto__") return fx.fail(j + 3, `the ${what} name in double quotes`, undefined, "That name is not allowed.");
                if (target.has(k.value)) return fx.fail(j + 3, `a ${what} name that is not used yet`, undefined, `The ${what} ${k.value} is given twice.`);
                target.set(k.value, v.value);
                i = j + 6;
                continue;
            }
            if (what === "body") {
                if (body) return fx.fail(j + 2, START, undefined, "The body is given twice.");
                const r = readJson(toks, j + 3, src, fx, "the body as JSON, such as {\"name\":\"Mug\"}");
                if (!r) return null;
                body = { v: r.value };
                i = r.next;
                continue;
            }
            return fx.fail(j + 2, '"query", "header" or "body"', what ?? undefined);
        }
        if (w === "without") {
            if (lower(toks[j + 1]) !== "signing" || lower(toks[j + 2]) !== "in") return fx.fail(j + 1, '"signing in"', "signing");
            auth = "none";
            i = j + 3;
            continue;
        }
        if (w === "remember" && j > i) {
            const k = toks[j + 1];
            if (!k || k.kind !== "str") return fx.fail(j + 1, "the name to remember in double quotes");
            if (lower(toks[j + 2]) !== "from") return fx.fail(j + 2, '"from"', "from");
            const p = toks[j + 3];
            if (!p || p.kind !== "str") return fx.fail(j + 3, "the path into the answer in double quotes, such as items.0.id");
            if (k.value === "__proto__") return fx.fail(j + 1, "the name to remember in double quotes", undefined, "That name is not allowed.");
            if (extract.has(k.value)) return fx.fail(j + 1, "a name that is not used yet", undefined, `The name ${k.value} is remembered twice.`);
            extract.set(k.value, p.value);
            i = j + 4;
            continue;
        }
        if (j > i) return fx.fail(j, '"remember"', "remember");
        fx.fail(i, START);
        break;
    }
    const value: Slots = {};
    if (query.size) value.query = Object.fromEntries(query);
    if (headers.size) value.headers = Object.fromEntries(headers);
    if (body) value.body = body.v;
    if (auth) value.auth = auth;
    if (extract.size) value.extract = Object.fromEntries(extract);
    return { value, next: i };
}

// ── matching a line ─────────────────────────────────────────────────────

export interface LineMatch {
    phrase: PhraseDef;
    slots: Slots;
}

type Done = (ti: number, slots: Slots) => LineMatch | null;

function walk(els: El[], i: number, toks: Token[], ti: number, slots: Slots, src: string, fx: Furthest, done: Done): ReturnType<Done> {
    if (i === els.length) return done(ti, slots);
    const el = els[i]!;
    if (el.t === "lit") {
        const t = toks[ti];
        if (t && t.kind === "word" && t.value.toLowerCase() === el.w.toLowerCase()) return walk(els, i + 1, toks, ti + 1, slots, src, fx, done);
        return fx.fail(ti, `"${el.w}"`, el.w);
    }
    if (el.t === "slot") {
        const r = readSlot(el.type, toks, ti, src, fx);
        if (!r) return null;
        return walk(els, i + 1, toks, r.next, { ...slots, [el.name]: r.value }, src, fx, done);
    }
    // An optional part: try it, then try without it.
    const withIt = walk(el.els, 0, toks, ti, slots, src, fx, (t2, s2) => walk(els, i + 1, toks, t2, s2, src, fx, done));
    if (withIt) return withIt;
    return walk(els, i + 1, toks, ti, slots, src, fx, done);
}

/** Every phrase that reads the whole line (usually one). `fx` learns where the best attempt stopped. */
export function matchAll(toks: Token[], src: string, fx: Furthest, only?: (p: PhraseDef) => boolean): LineMatch[] {
    const found: LineMatch[] = [];
    for (const phrase of PHRASES) {
        if (only && !only(phrase)) continue;
        fx.current = phrase;
        for (const template of [phrase.template, ...(phrase.aliases ?? [])]) {
            const hit = walk(compileTemplate(template), 0, toks, 0, {}, src, fx, (ti, slots) => {
                if (ti === toks.length) return { phrase, slots };
                fx.fail(ti, "the end of the line");
                return null;
            });
            if (hit) {
                found.push(hit);
                break;
            }
        }
    }
    return found;
}

/** The step fields a read phrase gives (before the note and the schema's defaults). */
export function buildStep(m: LineMatch): Record<string, unknown> {
    const step: Record<string, unknown> = { ...m.phrase.fixed };
    for (const [name, value] of Object.entries(m.slots)) {
        if (name === "opts") Object.assign(step, value as Slots);
        else step[name] = value;
    }
    return step;
}

/** For a line nothing could read: the phrase whose first words are closest to what was typed. */
export function nearestPhrase(toks: Token[]): { phrase: PhraseDef; distance: number } | undefined {
    const typed = toks.filter((t) => t.kind === "word").slice(0, 4).map((t) => t.value.toLowerCase());
    if (!typed.length) return undefined;
    let best: { phrase: PhraseDef; distance: number } | undefined;
    for (const phrase of PHRASES) {
        for (const template of [phrase.template, ...(phrase.aliases ?? [])]) {
            const head = headWords(template);
            if (!head.length) continue;
            const a = typed.slice(0, head.length).join("");
            const b = head.join("");
            const d = editDistance(a, b);
            const limit = Math.max(1, Math.min(3, Math.floor(b.length / 3)));
            if (d <= limit && (!best || d < best.distance)) best = { phrase, distance: d };
        }
    }
    return best;
}
