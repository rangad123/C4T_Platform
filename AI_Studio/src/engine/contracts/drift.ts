/**
 * API drift: did a live API change shape between two runs, without any API description to compare with? (no LLM)
 *
 * Each run keeps, per operation (`GET /api/users/{}`), the HTTP statuses it answered and, for successful GET requests,
 * the SHAPE of the JSON body: field names and inferred types only. Response values, headers and tokens are never kept —
 * `driftShape` (below) runs inside the generated script and returns only type names, so a value cannot leak into a
 * snapshot, and the platform re-validates whatever a script attached before it stores anything (`sanitizeShape`).
 *
 * `DRIFT_HELPER_SOURCE` is plain JavaScript pasted verbatim into every generated API script (so a downloaded script
 * runs on its own); `loadDriftRuntime()` compiles the same text for the engine, so the script and the platform agree.
 *
 * Shape node (compact, because it is stored per run):
 *   t  sorted union of the types seen: string number boolean null object array
 *   f  object: field name -> node            r  object: the fields present in EVERY observed object
 *   e  array: node of the elements (absent = never saw an element: an empty list says nothing about its items)
 *   x  truncated (too deep, too many or data-like keys): never compared inside
 */
import { template, type ApiChange, type ApiDiff } from "./diff.js";

/** Deepest container level that is described; deeper containers are recorded as "truncated". */
export const DRIFT_MAX_DEPTH = 4;
export const DRIFT_MAX_KEYS = 40;
/** Per operation, as attached by a script and as stored. */
export const DRIFT_MAX_SHAPE_BYTES = 8_000;
/** Everything one test attaches. */
export const DRIFT_MAX_TEST_BYTES = 60_000;

export const DRIFT_HELPER_SOURCE = String.raw`const DRIFT_MAX_DEPTH = ${DRIFT_MAX_DEPTH};
const DRIFT_MAX_KEYS = ${DRIFT_MAX_KEYS};
const DRIFT_MAX_SHAPE_BYTES = ${DRIFT_MAX_SHAPE_BYTES};
const DRIFT_MAX_TEST_BYTES = ${DRIFT_MAX_TEST_BYTES};
let driftSpent = 0;
/** A key that is really data (an id, an e-mail address, a token) is not a field name: such an object is not described. */
function driftDataLike(key) {
    return key === "__proto__" || key.length > 64 || /^\d+$/.test(key) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) || /^[0-9a-f]{24,}$/i.test(key) || key.indexOf("@") >= 0 || key.indexOf("eyJ") === 0;
}
function driftMerge(a, b) {
    const out = { t: Array.from(new Set(a.t.concat(b.t))).sort() };
    if (a.x || b.x) out.x = true;
    if (a.f || b.f) {
        const af = a.f || {};
        const bf = b.f || {};
        const f = {};
        for (const k of Object.keys(af)) f[k] = Object.prototype.hasOwnProperty.call(bf, k) ? driftMerge(af[k], bf[k]) : af[k];
        for (const k of Object.keys(bf)) if (!Object.prototype.hasOwnProperty.call(af, k)) f[k] = bf[k];
        out.f = f;
        out.r = a.f && b.f ? a.r.filter((k) => b.r.indexOf(k) >= 0) : (a.f ? a.r : b.r);
    }
    if (a.e || b.e) out.e = a.e && b.e ? driftMerge(a.e, b.e) : (a.e || b.e);
    return out;
}
function driftNode(v, depth, maxDepth) {
    if (v === null) return { t: ["null"] };
    if (Array.isArray(v)) {
        if (depth >= maxDepth) return { t: ["array"], x: true };
        const node = { t: ["array"] };
        for (const el of v.slice(0, 20)) {
            const s = driftNode(el, depth + 1, maxDepth);
            node.e = node.e ? driftMerge(node.e, s) : s;
        }
        return node;
    }
    if (typeof v === "object") {
        const keys = Object.keys(v);
        if (depth >= maxDepth || keys.length > DRIFT_MAX_KEYS || keys.some(driftDataLike)) return { t: ["object"], x: true };
        const f = {};
        for (const k of keys) f[k] = driftNode(v[k], depth + 1, maxDepth);
        return { t: ["object"], f, r: keys.slice().sort() };
    }
    return { t: [typeof v === "number" || typeof v === "boolean" ? typeof v : "string"] };
}
/** The shape of a parsed JSON body (never its values), or null when there is no body. Shrinks until it fits the cap. */
function driftShape(json) {
    if (json === undefined) return null;
    for (let d = DRIFT_MAX_DEPTH; d >= 0; d--) {
        const s = driftNode(json, 0, d);
        if (JSON.stringify(s).length <= DRIFT_MAX_SHAPE_BYTES) return s;
    }
    return null;
}
/** What a script attaches for one response: the shape, until the test's total budget is used up. */
function driftObserve(json) {
    const s = driftShape(json);
    if (!s) return null;
    const n = JSON.stringify(s).length;
    if (driftSpent + n > DRIFT_MAX_TEST_BYTES) return null;
    driftSpent += n;
    return s;
}
`;

export type ShapeType = "string" | "number" | "boolean" | "null" | "object" | "array";
export interface Shape {
    t: ShapeType[];
    f?: Record<string, Shape>;
    r?: string[];
    e?: Shape;
    x?: true;
}

interface DriftRuntime {
    driftShape(json: unknown): Shape | null;
    driftMerge(a: Shape, b: Shape): Shape;
}

let runtime: DriftRuntime | undefined;
/** The exact helper the generated scripts carry, compiled for the engine and for tests. */
export function loadDriftRuntime(): DriftRuntime {
    runtime ??= new Function(`${DRIFT_HELPER_SOURCE}\nreturn { driftShape, driftMerge };`)() as DriftRuntime;
    return runtime;
}

// ── what a snapshot holds ───────────────────────────────────────────────────

export interface OpObservation {
    /** Every HTTP status the operation answered during the run (any test, any attempt), ascending. */
    statuses: number[];
    /** Merged shape of its successful JSON responses (GET only). */
    shape?: Shape;
}

export interface ApiSnapshot {
    jobId: string;
    at: string;
    /** False when the run covered only some of the project's API tests: then an operation that is not seen proves nothing. */
    complete: boolean;
    operations: Record<string, OpObservation>;
}

/** What a script reports per response: `obs` is present (a shape or null) for every response that takes part in drift. */
export interface ObservedResponse {
    method: string;
    path: string;
    status: number;
    obs?: unknown;
}

const MAX_OPERATIONS = 300;
const MAX_STATUSES = 8;
const TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "null", "object", "array"]);

/** The same test as the script's `driftDataLike`, for shapes that arrive from a script (untrusted). */
const dataLike = (k: string) => k === "__proto__" || k.length > 64 || /^\d+$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[0-9a-f]{24,}$/i.test(k) || k.includes("@") || k.startsWith("eyJ");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rebuild a shape from untrusted JSON: only known type names, bounded depth and key counts, no value-like keys.
 * A script is generated from untrusted input, so nothing it attaches is stored as it came.
 */
export function sanitizeShape(raw: unknown, depth = 0): Shape | null {
    if (!isObj(raw) || depth > DRIFT_MAX_DEPTH + 1 || !Array.isArray(raw.t)) return null;
    const t = [...new Set(raw.t.filter((x): x is ShapeType => typeof x === "string" && TYPES.has(x)))].sort();
    if (t.length === 0) return null;
    const out: Shape = { t };
    if (raw.x === true) out.x = true;
    if (isObj(raw.f)) {
        const f: Record<string, Shape> = {};
        const keys = Object.keys(raw.f);
        if (keys.length > DRIFT_MAX_KEYS || keys.some(dataLike)) return { t, x: true };
        for (const k of keys) {
            const child = sanitizeShape(raw.f[k], depth + 1);
            if (child) f[k] = child;
        }
        out.f = f;
        out.r = Array.isArray(raw.r) ? raw.r.filter((k): k is string => typeof k === "string" && Object.hasOwn(f, k)).sort() : [];
    }
    if (raw.e !== undefined) {
        const e = sanitizeShape(raw.e, depth + 1);
        if (e) out.e = e;
    }
    return out;
}

/** `/users/42`, `/users/{id}` and `/users/7f3c…` are the same endpoint: ids become `{}` (same convention as the OpenAPI diff). */
export function templatePath(raw: string): string {
    let p = raw.split("#")[0]!.split("?")[0]!;
    if (/^https?:\/\//i.test(p)) {
        try {
            p = new URL(p).pathname;
        } catch {
            /* keep as is */
        }
    }
    p = template(p.slice(0, 300));
    const segments = p.split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || /^(?=.*\d)(?=.*[a-z])[a-z0-9]{12,}$/i.test(s) ? "{}" : s));
    const joined = segments.join("/");
    return joined.length > 1 ? joined.replace(/\/+$/, "") : joined || "/";
}

export const operationKey = (method: string, path: string): string => `${method.toUpperCase()} ${templatePath(path)}`;

/** Fold a test's responses into a run's operations. Mutates `ops`. Only responses that carry `obs` take part. */
export function addObservations(ops: Record<string, OpObservation>, responses: ObservedResponse[]): void {
    const { driftMerge } = loadDriftRuntime();
    for (const r of responses) {
        if (!r || typeof r.method !== "string" || typeof r.path !== "string" || !Number.isInteger(r.status) || r.status < 100 || r.status > 599) continue;
        if (!("obs" in r) || !/^[A-Za-z]{3,7}$/.test(r.method)) continue;
        const key = operationKey(r.method, r.path);
        if (!Object.hasOwn(ops, key) && Object.keys(ops).length >= MAX_OPERATIONS) continue;
        const op = (ops[key] ??= { statuses: [] });
        if (!op.statuses.includes(r.status) && op.statuses.length < MAX_STATUSES) op.statuses = [...op.statuses, r.status].sort((a, b) => a - b);
        // Bodies are only ever kept for safe reads: a mutating call contributes its status and nothing else.
        if (r.method.toUpperCase() === "GET" && r.status >= 200 && r.status < 300) {
            const shape = sanitizeShape(r.obs);
            if (shape) op.shape = op.shape ? driftMerge(op.shape, shape) : shape;
        }
    }
}

// ── the comparison ──────────────────────────────────────────────────────────

const healthy = (o: OpObservation) => o.statuses.some((s) => s >= 200 && s < 300);
const GONE = new Set([404, 405, 410]);
const nonNull = (s: Shape) => s.t.filter((x) => x !== "null");
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const typeText = (t: string[]) => t.join(" or ");
const child = (where: string, key: string) => (where ? `${where}.${key}` : key);

function diffShape(a: Shape, b: Shape, where: string, op: string, out: ApiChange[], depth = 0): void {
    if (depth > DRIFT_MAX_DEPTH + 1) return;
    const label = where ? `response field ${where}` : "the response body";
    const ta = nonNull(a);
    const tb = nonNull(b);
    // Only nulls seen on one side say nothing about the type; a field that was never null and is now only null does.
    if (ta.length && tb.length && !sameSet(ta, tb)) {
        out.push({ breaking: true, operation: op, message: `${label} changed type from ${typeText(ta)} to ${typeText(tb)}` });
        return;
    }
    if (ta.length && !tb.length && !a.t.includes("null")) {
        out.push({ breaking: true, operation: op, message: `${label} is now always null (it used to be ${typeText(ta)})` });
        return;
    }
    if (a.x || b.x) return;
    if (a.t.includes("object") && b.t.includes("object") && a.f && b.f) {
        const ra = new Set(a.r ?? []);
        const rb = new Set(b.r ?? []);
        for (const name of Object.keys(a.f)) {
            const at = child(where, name);
            if (!Object.hasOwn(b.f, name)) {
                // A field that was only sometimes there may simply not have been sampled this time: not evidence of removal.
                if (ra.has(name)) out.push({ breaking: true, operation: op, message: `response field ${at} was removed` });
                continue;
            }
            if (ra.has(name) && !rb.has(name)) out.push({ breaking: true, operation: op, message: `response field ${at} is no longer always present` });
            diffShape(a.f[name]!, b.f[name]!, at, op, out, depth + 1);
        }
        for (const name of Object.keys(b.f)) if (!Object.hasOwn(a.f, name)) out.push({ breaking: false, operation: op, message: `new response field ${child(where, name)}` });
    }
    // An empty list in either run has no element shape: nothing to compare through.
    if (a.t.includes("array") && b.t.includes("array") && a.e && b.e) diffShape(a.e, b.e, `${where}[]`, op, out, depth + 1);
}

/**
 * What changed between two runs of the same API: breaking = a client written against the older run can stop working.
 * Operations are matched by method and templated path. Field comparisons only happen for operations that answered
 * successfully in both runs, so an endpoint that errored says nothing about its fields.
 */
export function diffSnapshots(previous: ApiSnapshot, latest: ApiSnapshot): ApiDiff {
    const out: ApiChange[] = [];
    for (const [key, before] of Object.entries(previous.operations)) {
        const after = Object.hasOwn(latest.operations, key) ? latest.operations[key]! : undefined;
        if (!after) {
            // A run that covered only some tests cannot tell "gone" from "not tried".
            if (latest.complete && healthy(before)) out.push({ breaking: true, operation: key, message: "this operation was removed (it is no longer reached)" });
            continue;
        }
        if (healthy(before) && !healthy(after)) {
            const first = Math.min(...before.statuses.filter((s) => s >= 200 && s < 300));
            out.push({
                breaking: true,
                operation: key,
                message: after.statuses.every((s) => GONE.has(s))
                    ? `this operation no longer exists: it now answers HTTP ${after.statuses.join(", ")} instead of ${first}`
                    : `a request that used to succeed (HTTP ${first}) now fails with HTTP ${after.statuses.join(", ")}`,
            });
            continue;
        }
        if (!healthy(before) && healthy(after)) {
            out.push({ breaking: false, operation: key, message: `this operation now succeeds (HTTP ${Math.min(...after.statuses.filter((s) => s >= 200 && s < 300))}); it used to answer ${before.statuses.join(", ")}` });
            continue;
        }
        if (healthy(before) && healthy(after) && before.shape && after.shape) diffShape(before.shape, after.shape, "", key, out);
    }
    // A new operation that only errors is usually a test probing an invented path (unique ids), not a new endpoint.
    for (const [key, after] of Object.entries(latest.operations)) if (!Object.hasOwn(previous.operations, key) && healthy(after)) out.push({ breaking: false, operation: key, message: "new operation" });

    const order = (a: ApiChange, b: ApiChange) => a.operation.localeCompare(b.operation) || a.message.localeCompare(b.message);
    return { breaking: out.filter((c) => c.breaking).sort(order), nonBreaking: out.filter((c) => !c.breaking).sort(order) };
}
