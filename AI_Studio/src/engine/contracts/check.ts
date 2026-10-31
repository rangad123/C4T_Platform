/**
 * API contract checks: does a real response match what the API's own documentation says it returns? (no LLM)
 *
 * `CONTRACT_HELPER_SOURCE` is a small, dependency-free JSON-Schema-subset validator, plain JavaScript. The API
 * generator pastes it verbatim into every script that contains a `matchesSchema` check (so a downloaded script runs
 * on its own), and `loadContractRuntime()` compiles the same text for tests, so the script and the engine agree.
 *
 * Supported: type (incl. integer, and "null" / nullable), enum, required, properties, additionalProperties:false,
 * items, minimum / maximum, minLength / maxLength, pattern, format (date-time, date, email, uuid).
 * Not supported on purpose: a node the documentation expressed as oneOf / anyOf arrives marked "x-aitp-lossy" (the
 * parser kept only its first alternative), so it is skipped rather than judged — no false alarms.
 *
 * Severity per line: a missing required field or a wrong type breaks clients -> high; a value outside the documented
 * enum / length / range / pattern -> medium; a wrong format or an undocumented extra field (only when the schema
 * forbids them) -> low.
 */

/** First words of every contract failure; the finding classifier keys on it. */
export const CONTRACT_FAILURE_PREFIX = "API contract check failed:";

/** Schema nodes larger than this are not attached to a test (keeps stored specs and scripts small). */
export const CONTRACT_MAX_SCHEMA_BYTES = 20_000;
export const CONTRACT_MAX_LINES = 6;

export const CONTRACT_HELPER_SOURCE = String.raw`const CONTRACT_PREFIX = ${JSON.stringify(CONTRACT_FAILURE_PREFIX)};
const CONTRACT_MAX_LINES = ${CONTRACT_MAX_LINES};
const CONTRACT_FORMATS = {
    "date-time": /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/,
    "date": /^\d{4}-\d{2}-\d{2}$/,
    "email": /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    "uuid": /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};
function contractTypeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}
function contractShow(v) {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 37) + "..." : s;
}
function contractWalk(value, schema, path, out, depth) {
    if (!schema || typeof schema !== "object" || depth > 6 || schema["x-aitp-lossy"]) return;
    const t = contractTypeOf(value);
    const types = [].concat(schema.type || []).filter(Boolean);
    const nullable = schema.nullable === true || types.indexOf("null") >= 0;
    const named = types.filter((x) => x !== "null");
    if (value === null) {
        if (named.length && !nullable) out.push(["high", path + ": is null, but the documentation says " + named.join(" or ")]);
        return;
    }
    if (named.length && !named.some((x) => x === t || (x === "number" && t === "integer"))) {
        out.push(["high", path + ": expected " + named.join(" or ") + ", got " + t]);
        return;
    }
    if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
        out.push(["medium", path + ": " + contractShow(value) + " is not one of the documented values (" + schema.enum.map(String).join(", ") + ")"]);
    }
    if (t === "string") {
        if (typeof schema.minLength === "number" && value.length < schema.minLength) out.push(["medium", path + ": is shorter than the documented minimum of " + schema.minLength + " characters"]);
        if (typeof schema.maxLength === "number" && value.length > schema.maxLength) out.push(["medium", path + ": is longer than the documented maximum of " + schema.maxLength + " characters"]);
        if (typeof schema.pattern === "string") {
            let re = null;
            try { re = new RegExp(schema.pattern); } catch (e) { /* an invalid documented pattern says nothing about the response */ }
            if (re && !re.test(value)) out.push(["medium", path + ": " + contractShow(value) + " does not match the documented pattern"]);
        }
        const fmt = CONTRACT_FORMATS[schema.format];
        if (fmt && !fmt.test(value)) out.push(["low", path + ": " + contractShow(value) + " is not a valid " + schema.format]);
    }
    if (t === "integer" || t === "number") {
        if (typeof schema.minimum === "number" && value < schema.minimum) out.push(["medium", path + ": " + value + " is below the documented minimum of " + schema.minimum]);
        if (typeof schema.maximum === "number" && value > schema.maximum) out.push(["medium", path + ": " + value + " is above the documented maximum of " + schema.maximum]);
    }
    if (t === "array" && schema.items) {
        for (let i = 0; i < Math.min(value.length, 20); i++) contractWalk(value[i], schema.items, path + "[" + i + "]", out, depth + 1);
    }
    if (t === "object") {
        const props = schema.properties || {};
        for (const key of schema.required || []) {
            if (!(key in value)) out.push(["high", path + "." + key + ": is missing, but the documentation marks it required"]);
        }
        for (const key of Object.keys(props)) if (key in value) contractWalk(value[key], props[key], path + "." + key, out, depth + 1);
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) if (!(key in props)) out.push(["low", path + "." + key + ": is not documented (the documentation allows no extra fields)"]);
        }
    }
}

/** Validate a response body against its documented schema; throws one line per mismatch (worst first). */
function contractAssert(json, schema) {
    const out = [];
    if (json === undefined) out.push(["high", "response: the body is not JSON, but the documentation describes a JSON body"]);
    else contractWalk(json, schema, "response", out, 0);
    if (out.length === 0) return;
    // The same mismatch in every element of a list is one problem, not twenty.
    const seen = new Set();
    const unique = out.filter((o) => { const k = o[0] + o[1].replace(/\[\d+\]/g, "[]"); if (seen.has(k)) return false; seen.add(k); return true; });
    const rank = { high: 0, medium: 1, low: 2 };
    unique.sort((a, b) => rank[a[0]] - rank[b[0]]);
    const lines = unique.slice(0, CONTRACT_MAX_LINES).map((o) => "- [" + o[0] + "] " + o[1].replace(/\[\d+\]/g, "[]"));
    if (unique.length > CONTRACT_MAX_LINES) lines.push("- [low] ...and " + (unique.length - CONTRACT_MAX_LINES) + " more");
    throw new Error(CONTRACT_PREFIX + " " + unique.length + (unique.length === 1 ? " difference" : " differences") + " between the response and its documentation\n" + lines.join("\n"));
}
`;

export interface ContractRuntime {
    contractAssert(json: unknown, schema: unknown): void;
}

let runtime: ContractRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use inside the engine and in tests. */
export function loadContractRuntime(): ContractRuntime {
    runtime ??= new Function(`${CONTRACT_HELPER_SOURCE}\nreturn { contractAssert };`)() as ContractRuntime;
    return runtime;
}

/** How to fix, in plain words (appended to a finding's reason). */
export const CONTRACT_ADVICE =
    "Either change the API so its responses match the documentation, or update the documentation to describe what the API really returns. Clients written from the documentation break when they differ.";

export const CONTRACT_BASIS = "response differs from the API documentation";

/** Severity tag worst-first, e.g. "- [high] ..." -> "high". */
export function worstContractTag(text: string): "high" | "medium" | "low" | undefined {
    for (const s of ["high", "medium", "low"] as const) if (text.includes(`[${s}]`)) return s;
    return undefined;
}
