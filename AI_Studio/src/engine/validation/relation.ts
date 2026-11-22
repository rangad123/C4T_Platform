/**
 * Relation checks (Phase 4 C5): a restricted expression over an API answer and the test's own values, such as
 * `discount == round(subtotal * 0.10)` or `(subtotal - discount >= 5000) implies shipping == 0`.
 *
 * Grammar (lowest precedence first):
 *   expr    := or ( "implies" or )?
 *   or      := and ( "or" and )*
 *   and     := cmp ( "and" cmp )*
 *   cmp     := sum ( ("==" | "!=" | "<" | "<=" | ">" | ">=") sum )?
 *   sum     := prod ( ("+" | "-") prod )*
 *   prod    := unary ( ("*" | "/") unary )*
 *   unary   := "-" unary | primary
 *   primary := number | "text" | true | false | null
 *            | $name suffix*          a test value ({{name}}): number text reads as a number, JSON object or array text as JSON
 *            | name suffix* | suffix+ a path into the latest answer's JSON body
 *            | round(x[, digits]) | sum(list) | count(list) | contains(textOrList, value)
 *            | number(textOrNumber)   the first amount in a text a page shows ("−$62.75" is -62.75, "$1,234.50" is 1234.5)
 *            | "(" expr ")"
 *   suffix  := "." name | "[" digits "]" | "[*]"     ([*] maps the rest of the path over every element; nested ones flatten)
 *
 * Arithmetic and < > need numbers, == and != compare JSON values exactly, and / or / implies need true or false (and short-circuit).
 * Caps: 300 characters, 120 tokens, nesting 20, 12 path parts, 1000 list elements. Only own properties of the data are read.
 *
 * Like ../contracts/check.ts, the checker is plain JavaScript text: scripts carry it verbatim (so a downloaded script runs on its
 * own), and the engine compiles the same constant text once. The expression itself is only ever tokenised, parsed into a tree and
 * walked: it is never evaluated as code.
 */

export const RELATION_MAX_CHARS = 300;
/** First words of every relation failure; the finding classifier can key on it. */
export const RELATION_FAILURE_PREFIX = "Relation check failed";

export const RELATION_HELPER_SOURCE = String.raw`const RELATION_PREFIX = ${JSON.stringify(RELATION_FAILURE_PREFIX)};
const RELATION_CAPS = { chars: ${RELATION_MAX_CHARS}, tokens: 120, depth: 20, parts: 12, list: 1000 };
const RELATION_FNS = { round: [1, 2], sum: [1, 1], count: [1, 1], contains: [2, 2], number: [1, 1] };
const RELATION_WORDS = ["and", "or", "implies", "true", "false", "null"];
const relationOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function relationLex(text) {
    if (typeof text !== "string") throw new Error("the expression must be text");
    if (text.length > RELATION_CAPS.chars) throw new Error("the expression is longer than " + RELATION_CAPS.chars + " characters");
    const toks = [];
    const digit = (c) => c >= "0" && c <= "9";
    const letter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
        const s = i;
        if (digit(c)) {
            while (digit(text[i] || "")) i++;
            if (text[i] === "." && digit(text[i + 1] || "")) { i++; while (digit(text[i] || "")) i++; }
            toks.push({ k: "num", v: Number(text.slice(s, i)), s: s, e: i });
        } else if (c === '"') {
            let v = "";
            i++;
            for (;;) {
                if (i >= text.length) throw new Error("the text in double quotes at position " + (s + 1) + " is not closed");
                const d = text[i];
                if (d === '"') { i++; break; }
                if (d === "\\") {
                    const n = text[i + 1];
                    if (n !== '"' && n !== "\\") throw new Error("only \\\" and \\\\ may follow a backslash (position " + (i + 1) + ")");
                    v += n;
                    i += 2;
                    continue;
                }
                v += d;
                i++;
            }
            toks.push({ k: "str", v: v, s: s, e: i });
        } else if (letter(c) || c === "$") {
            i++;
            while (letter(text[i] || "") || digit(text[i] || "")) i++;
            const w = text.slice(s, i);
            if (w === "$") throw new Error("a name must follow $ (position " + (s + 1) + ")");
            if (c === "$" && digit(w[1])) throw new Error("a name after $ starts with a letter (position " + (s + 1) + ")");
            toks.push({ k: c === "$" ? "var" : "name", v: c === "$" ? w.slice(1) : w, s: s, e: i });
        } else {
            const two = text.slice(i, i + 2);
            if (two === "==" || two === "!=" || two === "<=" || two === ">=") { toks.push({ k: "op", v: two, s: s, e: i + 2 }); i += 2; }
            else if ("<>+-*/()[].,".indexOf(c) >= 0) { toks.push({ k: "op", v: c, s: s, e: i + 1 }); i++; }
            else throw new Error("the character " + JSON.stringify(c) + " at position " + (i + 1) + " is not part of the grammar");
        }
        if (toks.length > RELATION_CAPS.tokens) throw new Error("the expression has more than " + RELATION_CAPS.tokens + " parts");
    }
    if (!toks.length) throw new Error("the expression is empty");
    return toks;
}
function relationParseTree(text) {
    const toks = relationLex(text);
    let p = 0;
    let depth = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].k === "op" && toks[p].v === v;
    const isWord = (v) => toks[p] && toks[p].k === "name" && toks[p].v === v;
    const where = () => (toks[p] ? "at position " + (toks[p].s + 1) : "at the end");
    const expect = (v) => {
        if (!isOp(v)) throw new Error("expected " + JSON.stringify(v) + " " + where());
        return toks[p++];
    };
    const node = (n, s, e) => { n.s = s; n.e = e; return n; };
    const deeper = (f) => {
        if (++depth > RELATION_CAPS.depth) throw new Error("the expression is nested more than " + RELATION_CAPS.depth + " deep");
        const r = f();
        depth--;
        return r;
    };
    const binary = (next, ops, words) => () => {
        let l = next();
        for (;;) {
            const t = peek();
            const hit = t && ((t.k === "op" && ops.indexOf(t.v) >= 0) || (t.k === "name" && words.indexOf(t.v) >= 0));
            if (!hit) return l;
            p++;
            const r = next();
            l = node({ t: "bin", op: t.v, l: l, r: r }, l.s, r.e);
        }
    };
    const suffixes = (n) => {
        for (;;) {
            if (isOp(".")) {
                p++;
                const t = peek();
                if (!t || t.k !== "name") throw new Error("expected a field name after . " + where());
                p++;
                n.parts.push({ k: "key", v: t.v });
            } else if (isOp("[")) {
                p++;
                if (isOp("*")) { p++; n.parts.push({ k: "all" }); }
                else {
                    const t = peek();
                    if (!t || t.k !== "num" || !Number.isInteger(t.v)) throw new Error("expected a whole number or * inside [ ] " + where());
                    p++;
                    n.parts.push({ k: "idx", v: t.v });
                }
                n.e = expect("]").e;
                continue;
            } else return n;
            n.e = toks[p - 1].e;
            if (n.parts.length > RELATION_CAPS.parts) throw new Error("a path has more than " + RELATION_CAPS.parts + " parts");
        }
    };
    const primary = () => {
        const t = peek();
        if (!t) throw new Error("the expression ends too early");
        if (t.k === "num") { p++; return node({ t: "lit", v: t.v }, t.s, t.e); }
        if (t.k === "str") { p++; return node({ t: "lit", v: t.v }, t.s, t.e); }
        if (t.k === "var") { p++; return suffixes(node({ t: "path", root: "var", name: t.v, parts: [] }, t.s, t.e)); }
        if (t.k === "name") {
            if (t.v === "true" || t.v === "false") { p++; return node({ t: "lit", v: t.v === "true" }, t.s, t.e); }
            if (t.v === "null") { p++; return node({ t: "lit", v: null }, t.s, t.e); }
            if (RELATION_WORDS.indexOf(t.v) >= 0) throw new Error("unexpected " + JSON.stringify(t.v) + " " + where());
            p++;
            if (isOp("(")) {
                if (!relationOwn(RELATION_FNS, t.v)) throw new Error("unknown function " + JSON.stringify(t.v) + " (round, sum, count, contains and number exist)");
                p++;
                const args = [deeper(expr)];
                while (isOp(",")) { p++; args.push(deeper(expr)); }
                const close = expect(")");
                const arity = RELATION_FNS[t.v];
                if (args.length < arity[0] || args.length > arity[1]) throw new Error(t.v + "() takes " + (arity[0] === arity[1] ? arity[0] : arity[0] + " or " + arity[1]) + " value" + (arity[1] > 1 ? "s" : ""));
                return node({ t: "fn", name: t.v, args: args }, t.s, close.e);
            }
            return suffixes(node({ t: "path", root: "body", parts: [{ k: "key", v: t.v }] }, t.s, t.e));
        }
        if (isOp("[")) return suffixes(node({ t: "path", root: "body", parts: [] }, t.s, t.s));
        if (isOp("(")) {
            p++;
            const inner = deeper(expr);
            const close = expect(")");
            return node({ t: "group", x: inner }, t.s, close.e);
        }
        if (isOp("-")) {
            p++;
            const x = deeper(unary);
            return node({ t: "neg", x: x }, t.s, x.e);
        }
        throw new Error("unexpected " + JSON.stringify(t.k === "op" ? t.v : String(t.v)) + " " + where());
    };
    const unary = () => primary();
    const prod = binary(unary, ["*", "/"], []);
    const sum = binary(prod, ["+", "-"], []);
    const cmp = () => {
        const l = sum();
        const t = peek();
        if (t && t.k === "op" && ["==", "!=", "<", "<=", ">", ">="].indexOf(t.v) >= 0) {
            p++;
            const r = sum();
            return node({ t: "bin", op: t.v, l: l, r: r }, l.s, r.e);
        }
        return l;
    };
    const and = binary(cmp, [], ["and"]);
    const or = binary(and, [], ["or"]);
    const expr = () => {
        const l = or();
        if (isWord("implies")) {
            p++;
            const r = or();
            return node({ t: "bin", op: "implies", l: l, r: r }, l.s, r.e);
        }
        return l;
    };
    const tree = expr();
    if (p < toks.length) throw new Error("unexpected " + JSON.stringify(String(toks[p].v)) + " " + where());
    return tree;
}
function relationShow(v) {
    // 8500 * 0.1 is 850.0000000000001 in floating point: shown as 850.
    const s = JSON.stringify(typeof v === "number" ? Number(v.toPrecision(12)) : v);
    const t = s === undefined ? String(v) : s;
    return t.length > 60 ? t.slice(0, 57) + "..." : t;
}
function relationValue(raw) {
    if (typeof raw !== "string") return raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^\s*[\[{]/.test(raw)) { try { return JSON.parse(raw); } catch (e) { return raw; } }
    return raw;
}
function relationSame(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => relationOwn(b, k) && relationSame(a[k], b[k]));
}
function relationRun(tree, text, body, vars, seen) {
    const src = (n) => text.slice(n.s, n.e).trim();
    const note = (n, v) => { const k = src(n); if (!seen.some((x) => x[0] === k)) seen.push([k, v]); return v; };
    const num = (n, v) => {
        if (typeof v !== "number" || !isFinite(v)) throw new Error(src(n) + " is not a number (it is " + relationShow(v) + ")");
        return v;
    };
    const bool = (n, v) => {
        if (typeof v !== "boolean") throw new Error(src(n) + " is not true or false (it is " + relationShow(v) + ")");
        return v;
    };
    const path = (n) => {
        let cur;
        if (n.root === "var") {
            if (!vars || typeof vars !== "object" || !relationOwn(vars, n.name)) throw new Error("the test has no value $" + n.name);
            cur = [relationValue(vars[n.name])];
        } else cur = [body];
        let many = false;
        for (const part of n.parts) {
            const next = [];
            for (const v of cur) {
                if (part.k === "all") {
                    if (!Array.isArray(v)) throw new Error("no list at " + src(n) + " (found " + relationShow(v) + ")");
                    for (const x of v) next.push(x);
                } else if (part.k === "idx") {
                    if (!Array.isArray(v) || part.v >= v.length) throw new Error("no value at " + src(n));
                    next.push(v[part.v]);
                } else {
                    if (v === null || typeof v !== "object" || Array.isArray(v) || !relationOwn(v, part.v)) throw new Error("no value at " + src(n));
                    next.push(v[part.v]);
                }
                if (next.length > RELATION_CAPS.list) throw new Error(src(n) + " has more than " + RELATION_CAPS.list + " values");
            }
            if (part.k === "all") many = true;
            cur = next;
        }
        return many ? cur : cur[0];
    };
    const list = (n, v) => {
        if (!Array.isArray(v)) throw new Error(src(n) + " is not a list (it is " + relationShow(v) + ")");
        return v;
    };
    const ev = (n) => {
        switch (n.t) {
            case "lit": return n.v;
            case "group": return ev(n.x);
            case "path": return note(n, path(n));
            case "neg": return note(n, -num(n.x, ev(n.x)));
            case "fn": {
                const a = n.args;
                if (n.name === "round") {
                    const x = num(a[0], ev(a[0]));
                    const d = a[1] ? num(a[1], ev(a[1])) : 0;
                    if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error("round() keeps 0 to 6 digits");
                    const f = Math.pow(10, d);
                    return note(n, Math.round(x * f) / f);
                }
                if (n.name === "sum") return note(n, list(a[0], ev(a[0])).reduce((t, x) => t + num(a[0], x), 0));
                if (n.name === "count") return note(n, list(a[0], ev(a[0])).length);
                if (n.name === "number") {
                    const x = ev(a[0]);
                    if (typeof x === "number") return note(n, num(a[0], x));
                    if (typeof x !== "string") throw new Error(src(a[0]) + " is not text or a number (it is " + relationShow(x) + ")");
                    const m = /(-)?[^\d-]{0,3}?(\d+(?:\.\d+)?)/.exec(x.replace(/\u2212/g, "-").replace(/(\d),(?=\d{3}(?!\d))/g, "$1"));
                    if (!m) throw new Error(src(a[0]) + " holds no number (it is " + relationShow(x) + ")");
                    return note(n, (m[1] ? -1 : 1) * Number(m[2]));
                }
                const hay = ev(a[0]);
                const needle = ev(a[1]);
                if (typeof hay === "string") {
                    if (typeof needle !== "string") throw new Error(src(a[1]) + " is not text (it is " + relationShow(needle) + ")");
                    return note(n, hay.indexOf(needle) >= 0);
                }
                return note(n, list(a[0], hay).some((x) => relationSame(x, needle)));
            }
            case "bin": {
                const op = n.op;
                if (op === "and") return bool(n.l, ev(n.l)) ? bool(n.r, ev(n.r)) : false;
                if (op === "or") return bool(n.l, ev(n.l)) ? true : bool(n.r, ev(n.r));
                if (op === "implies") return bool(n.l, ev(n.l)) ? bool(n.r, ev(n.r)) : true;
                const l = ev(n.l);
                const r = ev(n.r);
                if (op === "==") return relationSame(l, r);
                if (op === "!=") return !relationSame(l, r);
                const x = num(n.l, l);
                const y = num(n.r, r);
                if (op === "<") return x < y;
                if (op === "<=") return x <= y;
                if (op === ">") return x > y;
                if (op === ">=") return x >= y;
                if (op === "/" && y === 0) throw new Error(src(n.r) + " is 0, so " + src(n) + " has no value");
                const v = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y;
                return note(n, num(n, v));
            }
        }
        throw new Error("unknown part of the expression");
    };
    return ev(tree);
}
function relationRefs(tree, out) {
    if (tree.t === "path") {
        const key = (tree.root === "var" ? "$" + tree.name : "") + tree.parts.map((x) => (x.k === "key" ? "." + x.v : x.k === "idx" ? "[" + x.v + "]" : "[*]")).join("");
        const list = tree.root === "var" ? out.vars : out.paths;
        const k = tree.root === "var" ? tree.name : key.replace(/^\./, "");
        if (list.indexOf(k) < 0) list.push(k);
    }
    for (const c of [tree.x, tree.l, tree.r].concat(tree.args || [])) if (c) relationRefs(c, out);
    return out;
}
function relationParse(text) {
    try {
        const tree = relationParseTree(text);
        return { ok: true, refs: relationRefs(tree, { paths: [], vars: [] }) };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}
function relationEval(text, body, vars, source) {
    const seen = [];
    const head = RELATION_PREFIX + (source ? " (" + source + ")" : "") + ": " + String(text).trim();
    const shown = () => (seen.length ? " Values: " + seen.slice(0, 8).map((x) => x[0] + " = " + relationShow(x[1])).join(", ") + (seen.length > 8 ? ", ..." : "") + "." : "");
    try {
        const v = relationRun(relationParseTree(text), text, body, vars, seen);
        if (typeof v !== "boolean") return { held: false, values: seen, message: head + ". It must give true or false, but gave " + relationShow(v) + "." + shown() };
        return v ? { held: true, values: seen } : { held: false, values: seen, message: head + "." + shown() };
    } catch (e) {
        return { held: false, values: seen, message: head + ". " + (e && e.message ? e.message : String(e)) + "." + shown() };
    }
}
function relationAssert(text, body, vars, source) {
    const r = relationEval(text, body, vars, source);
    if (!r.held) throw new Error(r.message);
}
`;

export type RelationParse = { ok: true; refs: { paths: string[]; vars: string[] } } | { ok: false; error: string };
export type RelationResult = { held: true; values: Array<[string, unknown]> } | { held: false; values: Array<[string, unknown]>; message: string };

interface RelationRuntime {
    relationParse(text: string): RelationParse;
    relationEval(text: string, body: unknown, vars: Record<string, unknown>, source?: string): RelationResult;
}

let runtime: RelationRuntime | undefined;
/** The exact helper the scripts carry, compiled once from its constant text (never from an expression). */
function relationRuntime(): RelationRuntime {
    runtime ??= new Function(`${RELATION_HELPER_SOURCE}\nreturn { relationParse, relationEval };`)() as RelationRuntime;
    return runtime;
}

/** Is the text inside the grammar? On success, the body paths and the test values ($names) it reads (for checking the names exist). */
export function parseRelation(text: string): RelationParse {
    return relationRuntime().relationParse(text);
}

/**
 * Judges a relation against an answer body and the test's values. Never throws: an expression outside the grammar, a missing value or
 * a wrong type is `held: false` with a message that names the expression, the values it read and the source.
 */
export function checkRelation(text: string, input: { body: unknown; vars?: Record<string, unknown> }, source?: string): RelationResult {
    return relationRuntime().relationEval(text, input.body, input.vars ?? {}, source);
}
