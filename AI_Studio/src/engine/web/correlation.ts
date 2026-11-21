/**
 * UI–API correlation while a web test is written (testing-engine Phase 4 C4): what the page's own API answered to each action, a
 * read-back of a successful write through the documented GET, and the page claiming success while that API failed. Each check is the
 * saved test's own check, judged here first: a read-back builds the relation the saved test will carry and evaluates it on the real
 * answers (../validation/relation.ts), so authoring and the saved test cannot disagree. No AI calls; the browser work is in ./author.ts.
 */
import { checkRelation } from "../validation/relation.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { Step } from "../spec/schema.js";
import type { FINDING_LAYERS } from "../explore/finding.js";

/** At most this much of an answer is kept (bytes of text); a longer answer is kept cut and is not compared. */
export const CAPTURE_MAX = 8 * 1024;
/** At most this many answers are captured in one authoring session. */
export const CALLS_MAX = 200;

/** One own-origin answer an action caused, as kept in memory while authoring (raw: never stored or shown). */
export interface RawCall {
    /** The recorded step whose acting window it came in (its index among the recorded steps). */
    step: number;
    method: string;
    /** The address without the origin (path and query). */
    path: string;
    status: number;
    /** The request's JSON body, when it had one. */
    sent?: unknown;
    /** The answer's JSON body (absent when it is not JSON or was cut). */
    json?: unknown;
    /** The answer's text, cut at CAPTURE_MAX. */
    text: string;
    /** The engine's own read-back GET, not the page's. */
    readBack?: boolean;
}

/** One captured answer as it leaves authoring (`AuthorOutcome.calls`): masked, cut, tied to the saved test's step. */
export interface CapturedCall {
    /** 0-based index of the saved step that caused it; absent when that step is not in the saved test. */
    step?: number;
    method: string;
    path: string;
    status: number;
    /** The body, masked (the run's secrets, secret-named fields, e-mail addresses) and cut at CAPTURE_MAX. */
    body: string;
    readBack?: boolean;
}

/** A layer's account of what happened, for the finding's evidence. */
export interface LayerSays {
    layer: (typeof FINDING_LAYERS)[number];
    observed: string;
}

/** A disagreement between layers at one action: the saved check that shows it, and what each layer said. */
export interface Disagreement {
    kind: "readBack" | "error" | "displayed";
    /** Steps that go right after the action in the saved test; the last one is the check, given the stated source. */
    steps: (source: string) => Step[];
    /** One sentence: which layers disagreed and how. */
    explanation: string;
    /** How the check failed while authoring (the relation's message, or the shown text). */
    observed: string;
    layers: LayerSays[];
    /** "METHOD path answered N" lines (the finding's request evidence). */
    requests: string[];
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;
const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const pathOnly = (p: string) => p.split(/[?#]/)[0]!;
/** What a captured value becomes in the test data (the interpreter's and the script's capture). */
const asData = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
export const answered = (c: Pick<RawCall, "method" | "path" | "status">) => `${c.method} ${pathOnly(c.path)} answered ${c.status}`;

/** Does a concrete path fit a documented template (`/api/orders/{id}`)? */
export function fitsTemplate(template: string, path: string): boolean {
    const t = pathOnly(template).split("/");
    const p = pathOnly(path).split("/");
    return t.length === p.length && t.every((s, i) => (/^\{[^}]+\}$/.test(s) ? p[i] !== "" : s === p[i]));
}

/**
 * The read-back of a successful write, when the application documents (or was seen to answer) a GET of the same path: a PUT or PATCH
 * reads back the fields it wrote, a POST that returned an id reads back the list that must hold it. Undefined: nothing to read back.
 */
export function readBackOf(call: RawCall, apis: readonly Pick<ApiEndpointModel, "method" | "path">[]): { path: string } | undefined {
    if (call.status < 200 || call.status > 299 || !isObject(call.json) || !["PUT", "PATCH", "POST"].includes(call.method)) return undefined;
    if (call.method === "POST" && !isScalar(call.json.id)) return undefined;
    const path = pathOnly(call.path);
    return apis.some((a) => a.method.toUpperCase() === "GET" && fitsTemplate(a.path, path)) ? { path } : undefined;
}

/**
 * The saved read-back check, judged on the read-back's answer: wait for the write's answer and keep its values, GET the same path, then a
 * relation over the GET's body. Built only from values that compare as themselves (a relation over the write's own answer holds), so a
 * stored write passes. Undefined when there is nothing to compare.
 */
export function readBackCheck(call: RawCall, got: { status: number; json: unknown }): { held: boolean; disagreement?: Disagreement } | undefined {
    const wrote = call.json as Record<string, unknown>;
    const path = pathOnly(call.path);
    let expression: string;
    let extract: Record<string, string>;
    let vars: Record<string, string>;
    let sane: unknown;
    if (call.method === "POST") {
        // The list the GET returns: the body itself, or its first field that is a list of records.
        const key = Array.isArray(got.json) ? "" : isObject(got.json) ? Object.keys(got.json).find((k) => FIELD.test(k) && Array.isArray((got.json as Record<string, unknown>)[k])) : undefined;
        if (key === undefined) return undefined;
        expression = `contains(${key}[*].id, $created_id)`;
        extract = { created_id: "id" };
        vars = { created_id: asData(wrote.id) };
        sane = key ? { [key]: [{ id: wrote.id }] } : [{ id: wrote.id }];
    } else {
        // The fields this write sent that its answer echoes, compared with what the GET reads.
        const sent = isObject(call.sent) ? call.sent : {};
        const fields = Object.keys(sent)
            .filter((f) => FIELD.test(f) && isScalar(wrote[f]) && isObject(got.json) && f in got.json)
            .slice(0, 4);
        if (!fields.length) return undefined;
        expression = fields.map((f) => `${f} == $sent_${f}`).join(" and ");
        extract = Object.fromEntries(fields.map((f) => [`sent_${f}`, f]));
        vars = Object.fromEntries(fields.map((f) => [`sent_${f}`, asData(wrote[f])]));
        sane = wrote;
    }
    // A value that would not compare as itself (a number-like text read back as a number) is no check to keep.
    if (!checkRelation(expression, { body: sane, vars }).held) return undefined;
    const r = checkRelation(expression, { body: got.json, vars });
    if (r.held) return { held: true };
    const steps = (source: string): Step[] => [
        { action: "wait", ms: 0, until: "response", value: path, extract, description: `Keep the answer of ${call.method} ${path}` },
        { action: "request", method: "GET", path, auth: "default", description: `Read back ${path}` },
        { action: "assertResponse", check: "relation", expression, source, description: call.method === "POST" ? `The list holds what ${call.method} ${path} created` : `${path} keeps what was written` },
    ];
    const explanation =
        call.method === "POST"
            ? `${call.method} ${path} answered ${call.status} with a new id, but a read-back of GET ${path} does not list it: the API says it was created, the stored data does not hold it.`
            : `${call.method} ${path} answered ${call.status} with the values written, but a read-back of GET ${path} reads other values: the API says it was saved, the stored data does not hold it.`;
    return {
        held: false,
        disagreement: {
            kind: "readBack",
            steps,
            explanation,
            observed: r.message,
            layers: [
                { layer: "api", observed: `${call.method} ${path} answered ${call.status}` },
                { layer: "stored data", observed: `GET ${path} answered ${got.status}: ${r.message}` },
            ],
            requests: [answered(call), `GET ${path} answered ${got.status}`],
        },
    };
}

/**
 * The page shows success (a status message) while the action's write answered 4xx or 5xx. The saved check is that the success message is
 * not shown: on an application that reports the failure, it passes.
 */
export function errorShown(call: RawCall, shown: string): Disagreement {
    const path = pathOnly(call.path);
    return {
        kind: "error",
        steps: (source) => [{ action: "assert", check: "hidden", locator: { by: "text", value: shown, exact: true }, source, description: `"${shown}" is not shown when ${call.method} ${path} fails` }],
        explanation: `The page says "${shown}" while ${call.method} ${path} answered ${call.status}: the page reports success, the API refused or failed.`,
        observed: `"${shown}" is shown`,
        layers: [
            { layer: "page", observed: `shows "${shown}" (a status message)` },
            { layer: "api", observed: `${call.method} ${path} answered ${call.status}` },
        ],
        requests: [answered(call)],
    };
}
