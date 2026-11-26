/**
 * API endpoints → canonical API test specifications.
 *
 * The scenario matrix (happy path, missing required fields, wrong types, unauthenticated access,
 * unknown / malformed path ids, boundary strings, SQL-injection and XSS payloads) is ported from
 * ai-testing-agent (MIT, Copyright (c) 2026 dannicolau7 — `request_body_handler.py`
 * `generate_edge_case_tests` and the per-endpoint templates), re-expressed as framework-independent
 * specs instead of pytest source so they flow through the same render/validate pipeline as web tests.
 *
 * Generation is deterministic from the OpenAPI document / observed traffic; the LLM is only used
 * afterwards, to analyse and repair failing expectations.
 *
 * SAFETY: requests are executed against the live application during validation, so methods that
 * change state (POST/PUT/PATCH/DELETE) are only generated when `allowMutating` is enabled.
 */
import { CONTRACT_MAX_SCHEMA_BYTES } from "../contracts/check.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import { answersJson, happyStatus, streamingReason } from "./documented-status.js";
import { repeatAdds } from "./stated-source.js";
import { resourceName, stripIdSuffix } from "./workflows.js";

export type DraftSpec = Omit<TestSpec, "testId">;

export interface ApiGenOptions {
    allowMutating: boolean;
    /** Check real responses against the documented schema (default true). */
    contractChecks?: boolean;
    maxPerEndpoint: number;
    /** The project's requirements document: a line saying emails ignore letter case makes the case-folded duplicate a stated expectation. */
    requirementsText?: string;
}

export interface ApiGenResult {
    specs: DraftSpec[];
    skippedMutating: number;
    /** Calls given no request test, and why (a WebSocket upgrade, an event stream). */
    skipped: Array<{ endpoint: string; reason: string }>;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const SQLI = "' OR '1'='1' --";
const XSS = "<script>alert(1)</script>";

type Schema = Record<string, any>;
/** A field that repeats a password: confirmPassword, password_confirmation, repeatPassword, password2, passwordAgain. */
const CONFIRMS = /confirm|repeat|retype|again|verif|2$/i;

export function sample(schema: Schema | undefined, name = "value", depth = 0): unknown {
    if (!schema || depth > 4) return "test";
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    switch (schema.type) {
        case "integer":
            return schema.minimum ?? 1;
        case "number":
            return schema.minimum ?? 1.5;
        case "boolean":
            return true;
        case "array":
            return [sample(schema.items, name, depth + 1)];
        case "object": {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries<Schema>(schema.properties ?? {})) out[k] = sample(v, k, depth + 1);
            // A confirmation field repeats the password it confirms (the new one where there are two), else the body is refused.
            const passwords = Object.keys(out).filter((k) => /pass/i.test(k));
            const confirms = passwords.filter((k) => CONFIRMS.test(k) && typeof out[k] === "string");
            const pw = passwords.find((k) => !confirms.includes(k) && /new/i.test(k)) ?? passwords.find((k) => !confirms.includes(k));
            if (pw) for (const k of confirms) out[k] = out[pw];
            return out;
        }
        default: {
            if (schema.format === "email" || /email/i.test(name)) return "qa+{{unique}}@example.com";
            if (schema.format === "date-time") return "2030-01-01T00:00:00Z";
            if (schema.format === "date") return "2030-01-01";
            if (schema.format === "uuid") return "123e4567-e89b-12d3-a456-426614174000";
            if (schema.format === "uri" || /url/i.test(name)) return "https://example.com";
            return `test-${name}-{{unique}}`;
        }
    }
}

function wrongTypeFor(schema: Schema): unknown {
    switch (schema.type) {
        case "integer":
        case "number":
            return "not-a-number";
        case "boolean":
            return "not-a-boolean";
        case "array":
            return "not-an-array";
        case "object":
            return "not-an-object";
        default:
            return 12345;
    }
}

export function fillPath(path: string, ep: ApiEndpointModel, override?: (name: string) => string | undefined): string | null {
    let ok = true;
    const out = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const o = override?.(name);
        if (o !== undefined) return o;
        const p = ep.spec?.parameters.find((x) => x.name === name && x.location === "path");
        const v = p?.example ?? p?.enum?.[0];
        if (v === undefined) ok = false;
        return String(v ?? "");
    });
    return ok ? out : null;
}

export function queryFor(ep: ApiEndpointModel): Record<string, string> | undefined {
    const q: Record<string, string> = {};
    for (const p of ep.spec?.parameters ?? []) {
        if (p.location !== "query" || !p.required) continue;
        q[p.name] = String(p.example ?? p.enum?.[0] ?? (p.type === "integer" || p.type === "number" ? 1 : "test"));
    }
    return Object.keys(q).length ? q : undefined;
}

const req = (ep: ApiEndpointModel, path: string, extra: Partial<Extract<Step, { action: "request" }>> = {}, description = ""): Step => ({
    action: "request",
    method: ep.method as Extract<Step, { action: "request" }>["method"],
    path,
    auth: "default",
    description,
    ...extra,
});
const resp = (check: Extract<Step, { action: "assertResponse" }>["check"], expected?: string | number | boolean, path?: string, description = ""): Step => ({
    action: "assertResponse",
    check,
    expected,
    path,
    description,
});

function category(ep: ApiEndpointModel): string {
    const tag = ep.spec?.tags[0];
    if (tag) return `API · ${tag}`;
    const seg = ep.path.split("/").filter((s) => s && !s.startsWith("{") && !/^(api|v\d+)$/i.test(s))[0];
    return `API · ${seg ? seg[0]!.toUpperCase() + seg.slice(1) : "General"}`;
}

// ── Documented cases (C2) ────────────────────────────────────────────────────

/** Most documented cases per endpoint. They have their own cap, so the generic cases above stay exactly as they were. */
const MAX_DOCUMENTED = 6;
/** A body field that names another record: productId, owner_id. */
const REFERENCE = /^[a-z][a-zA-Z0-9]*(?:Id|_id)$/;
const SIGN_UP = /\/(?:register|sign-?up)(?:\/|$)/i;
const SIGN_IN_LIKE = /\/(?:auth|login|signin|sign-in|token|oauth|session|logout|signout|sign-out)(?:\/|$)/i;

/** The first of these statuses the endpoint documents. */
const documentedStatus = (ep: ApiEndpointModel, ...codes: string[]): string | undefined => codes.find((c) => ep.spec?.responses.some((r) => r.status === c));
const responseOf = (ep: ApiEndpointModel, status: string) => ep.spec?.responses.find((r) => r.status === status);

/** Where a list answer holds its first record's id ("0.id", or "<the one array property>.0.id"), from the documented 2xx schema. */
function firstIdPath(ep: ApiEndpointModel): string | undefined {
    const s = ep.spec?.responses.find((r) => /^2/.test(r.status))?.schema as Schema | undefined;
    const withId = (items: Schema | undefined) => items?.type === "object" && items.properties?.id !== undefined;
    if (s?.type === "array") return withId(s.items) ? "0.id" : undefined;
    const arrays = Object.entries<Schema>(s?.type === "object" ? (s.properties ?? {}) : {}).filter(([, v]) => v.type === "array" && withId(v.items));
    return arrays.length === 1 ? `${arrays[0]![0]}.0.id` : undefined;
}

/** A request step that takes a real record id from a documented list endpoint into {{name}}. */
function idFromList(list: ApiEndpointModel, idPath: string, name: string): Step {
    return req(list, list.path, { query: queryFor(list), extract: { [name]: idPath } }, `Take a real id from GET ${list.path}`);
}

/**
 * The reference fields of a body, each with a step that takes a real id for it (productId → the first record of GET /products) when a
 * list endpoint documents its ids. Without one the field keeps a made-up value, which the application would refuse as unknown.
 */
export function referenceIds(props: Record<string, Schema>, endpoints: ApiEndpointModel[]): Array<{ field: string; step?: Step }> {
    const out: Array<{ field: string; step?: Step }> = [];
    for (const [field, schema] of Object.entries(props)) {
        if (!REFERENCE.test(field) || (schema.type !== undefined && schema.type !== "string") || schema.enum || schema.example !== undefined) continue;
        const resource = stripIdSuffix(field);
        const list = endpoints.find((e) => e.method === "GET" && !e.path.includes("{") && resourceName(e.path) === resource && firstIdPath(e));
        out.push({ field, ...(list ? { step: idFromList(list, firstIdPath(list)!, field) } : {}) });
    }
    return out;
}

/** The path of a record endpoint (/orders/{id}) with a real id from its own collection's list (GET /orders), when that documents its ids. */
function pathFromList(ep: ApiEndpointModel, endpoints: ApiEndpointModel[]): { path: string; step: Step } | undefined {
    const m = /^(.*)\/\{([^}]+)\}$/.exec(ep.path);
    if (!m || m[1]!.includes("{")) return undefined;
    const list = endpoints.find((e) => e.method === "GET" && e.path === m[1] && firstIdPath(e));
    return list ? { path: `${m[1]}/{{${m[2]}}}`, step: idFromList(list, firstIdPath(list)!, m[2]!) } : undefined;
}

/** Values that break one documented constraint of a field, with what they break. */
export function violations(schema: Schema): Array<{ what: string; value: unknown }> {
    const out: Array<{ what: string; value: unknown }> = [];
    if (schema.type === "integer" || schema.type === "number") {
        if (typeof schema.maximum === "number") out.push({ what: `above its maximum (${schema.maximum})`, value: schema.maximum + 1 });
        if (typeof schema.minimum === "number") out.push({ what: `below its minimum (${schema.minimum})`, value: schema.minimum - 1 });
    }
    if (schema.type === "string" && !schema.enum) {
        if (typeof schema.minLength === "number" && schema.minLength > 0) out.push({ what: schema.minLength === 1 ? "empty" : `shorter than ${schema.minLength} characters`, value: "a".repeat(schema.minLength - 1) });
        if (typeof schema.maxLength === "number" && schema.maxLength <= 10_000) out.push({ what: `longer than ${schema.maxLength} characters`, value: "a".repeat(schema.maxLength + 1) });
        if (schema.format === "email") out.push({ what: "not an email address", value: "not-an-email" });
    }
    return out;
}

/** Words saying letter case does not matter ("not case-sensitive", "whatever the letter case", "differs only in letter case"). */
const IGNORES_CASE = /\b(?:not|in)[- ]?case[- ]?(?:sensitive|insensitive)|\bcase[- ]insensitive|\b(?:any|whatever the|regardless of(?: the)?|ignor\w*(?: the)?) letter case|\bonly in letter case/i;
/** Emails ignore letter case only where the API document (this endpoint, its conflict answer) or a requirement line about emails says so. */
const emailCaseStated = (ep: ApiEndpointModel, conflict: string, requirements = "") =>
    IGNORES_CASE.test(`${ep.summary ?? ""}\n${responseOf(ep, conflict)?.description ?? ""}`) || requirements.split(/\n/).some((line) => /e-?mail/i.test(line) && IGNORES_CASE.test(line));

/** The same address in other letter case, placeholders kept as they are. */
const otherCase = (v: string) => v.split(/(\{\{[^}]+\}\})/).map((part, i) => (i % 2 ? part : part.toUpperCase())).join("");

/** The application's sign-up endpoint: a documented POST to /register or /signup with a body that has a password. */
export function signUpOf(endpoints: ApiEndpointModel[]): ApiEndpointModel | undefined {
    return endpoints.find((e) => {
        const props = (e.spec?.requestBody?.schema as Schema | undefined)?.properties ?? {};
        return e.method === "POST" && SIGN_UP.test(e.path) && Object.keys(props).some((k) => /pass/i.test(k)) && e.spec!.responses.some((r) => /^2/.test(r.status));
    });
}

/** Steps that create and sign in a fresh account through the application's sign-up, or none when it has no documented one. */
export function freshAccountSteps(endpoints: ApiEndpointModel[]): Step[] {
    const signUp = signUpOf(endpoints);
    return signUp
        ? [req(signUp, signUp.path, { body: sample(signUp.spec!.requestBody!.schema as Schema) }, "Create a fresh account for this check"), resp("statusClass", "2xx", undefined, "The fresh account is created")]
        : [];
}

export function generateApiSpecs(endpoints: ApiEndpointModel[], opts: ApiGenOptions): ApiGenResult {
    const specs: DraftSpec[] = [];
    let skippedMutating = 0;
    const skipped: ApiGenResult["skipped"] = [];
    // Documented cases run on an account of their own where the application has a sign-up, so leftovers of other tests cannot hide a defect.
    const signUp = signUpOf(endpoints);
    const freshSteps = freshAccountSteps(endpoints);

    for (const ep of endpoints) {
        if (!SAFE.has(ep.method) && !opts.allowMutating) {
            skippedMutating++;
            continue;
        }
        const label = `${ep.method} ${ep.path}`;
        const streaming = streamingReason(ep);
        if (streaming) {
            skipped.push({ endpoint: label, reason: streaming });
            continue;
        }
        const cat = category(ep);
        const origin = ep.source === "openapi" ? ("openapi" as const) : ("network" as const);
        const body = ep.spec?.requestBody;
        const bodySchema = body?.schema as Schema | undefined;
        const props: Record<string, Schema> = bodySchema?.properties ?? {};
        const required: string[] = bodySchema?.required ?? [];
        const validBody = bodySchema ? (sample(bodySchema) as Record<string, unknown>) : ep.sampleRequestBody;
        const hasBody = ep.method !== "GET" && ep.method !== "HEAD" && validBody !== undefined;
        const filledPath = ep.source === "openapi" ? fillPath(ep.path, ep) : (ep.examplePath ?? ep.path);
        const queryObj = queryFor(ep);
        const make = (title: string, type: TestSpec["type"], priority: TestSpec["priority"], steps: Step[], expected: string[], tags: string[]): DraftSpec => ({
            title: `${label}: ${title}`,
            description: ep.summary ?? "",
            kind: "api",
            category: cat,
            type,
            priority,
            preconditions: ep.requiresAuth ? ["A valid API credential is configured (API_TOKEN)"] : [],
            steps,
            expectedResults: expected,
            testData: {},
            tags: ["api", ...tags],
            source: { origin },
        });
        const local: DraftSpec[] = [];

        // Real ids instead of made-up ones: reference fields of the body, and a record path's id, from documented list endpoints.
        const references = hasBody ? referenceIds(props, endpoints) : [];
        const refs = references.filter((r): r is { field: string; step: Step } => r.step !== undefined);
        const unresolved = references.filter((r) => !r.step).map((r) => r.field);
        const realBody = refs.length && typeof validBody === "object" && validBody ? { ...(validBody as object), ...Object.fromEntries(refs.map((r) => [r.field, `{{${r.field}}}`])) } : validBody;
        // A record path only for reads: a write would change (or delete) a record this test did not create.
        const listed = filledPath || !SAFE.has(ep.method) ? undefined : pathFromList(ep, endpoints);
        const happyPath = filledPath ?? listed?.path;

        // 1 ── Happy path
        if (happyPath) {
            const documented2xx = ep.spec?.responses.find((r) => /^2/.test(r.status));
            const okSchema = documented2xx?.schema as Schema | undefined;
            const steps: Step[] = [
                ...(listed ? [listed.step] : []),
                ...refs.map((r) => r.step),
                req(ep, happyPath, { query: queryObj, ...(hasBody ? { body: realBody } : {}) }, `Send a valid ${ep.method} request`),
                // The document's answer: a success, or the one status a call that never succeeds lists (documented-status.ts).
                ...[happyStatus(ep)].map((h) => resp(h.check, h.expected, undefined, h.check === "status" ? `Answers ${h.expected}, as documented` : "Request succeeds")),
            ];
            if (okSchema?.type === "object" || okSchema?.type === "array") {
                // The documented schema is the contract: when it can be attached, the real response is validated against it
                // as a whole. That supersedes the generic "is an object" / "contains <key>" steps, which would otherwise stop the
                // test with a bare message before the contract check can explain every difference (and rate it).
                const contract = opts.contractChecks !== false && ep.source === "openapi" && JSON.stringify(okSchema).length <= CONTRACT_MAX_SCHEMA_BYTES;
                if (contract) {
                    steps.push({ action: "assertResponse", check: "matchesSchema", schema: okSchema, description: "Response matches the documented schema" });
                } else {
                    steps.push(resp("jsonType", okSchema.type, undefined, `Response body is a JSON ${okSchema.type}`));
                    for (const key of (okSchema.required ?? []).slice(0, 4)) {
                        steps.push(resp("jsonPath", undefined, key, `Response contains "${key}"`));
                    }
                }
            } else if (ep.source === "network" && ep.responseSchema && (ep.responseSchema as Schema).type) {
                steps.push(resp("jsonType", (ep.responseSchema as Schema).type, undefined, "Response keeps its observed JSON shape"));
            }
            const h = happyStatus(ep);
            local.push(
                h.check === "status"
                    ? make(`answers its documented ${h.expected}`, "functional", "high", steps, [`Answers HTTP ${h.expected}, the only answer the API document lists`], ["happy-path"])
                    : make("succeeds with a valid request", "functional", "high", steps, ["Returns a successful response matching the documented contract"], ["happy-path"]),
            );
        }

        // 2 ── Unauthenticated access
        if (ep.requiresAuth && filledPath) {
            local.push(
                make(
                    "rejects requests without credentials",
                    "security",
                    "high",
                    [
                        req(ep, filledPath, { auth: "none", query: queryObj, ...(hasBody ? { body: validBody } : {}) }, "Send the request without credentials"),
                        resp("statusClass", "4xx", undefined, "Request is rejected"),
                    ],
                    ["401/403 style rejection when no credentials are supplied"],
                    ["auth"],
                ),
            );
        }

        // 3 ── Missing required body fields
        if (hasBody && filledPath && required.length && typeof validBody === "object" && validBody) {
            for (const field of required.slice(0, 2)) {
                const partial = { ...(validBody as Record<string, unknown>) };
                delete partial[field];
                local.push(
                    make(
                        `rejects a body missing required field "${field}"`,
                        "negative",
                        "medium",
                        [req(ep, filledPath, { query: queryObj, body: partial }, `Omit "${field}"`), resp("statusClass", "4xx", undefined, "Validation error")],
                        ["Validation error (4xx) when a required field is absent"],
                        ["validation"],
                    ),
                );
            }
        }

        // 4 ── Wrong types
        if (hasBody && filledPath && typeof validBody === "object" && validBody) {
            const typed = Object.entries(props).filter(([, s]) => s.type).slice(0, 2);
            for (const [field, schema] of typed) {
                local.push(
                    make(
                        `rejects an invalid type for "${field}"`,
                        "negative",
                        "medium",
                        [
                            req(ep, filledPath, { query: queryObj, body: { ...(validBody as object), [field]: wrongTypeFor(schema) } }, `Send ${JSON.stringify(wrongTypeFor(schema))} for ${field}`),
                            resp("statusClass", "4xx", undefined, "Validation error"),
                        ],
                        ["Type validation error (4xx)"],
                        ["validation"],
                    ),
                );
            }
        }

        // 5 ── Boundary + injection on the first string field (body) or string/query param
        const strField = Object.entries(props).find(([, s]) => s.type === "string" && !s.enum && !s.format);
        const strQuery = ep.spec?.parameters.find((p) => p.location === "query" && p.type === "string" && !p.enum);
        if (filledPath && (strField || strQuery) && hasBody === Boolean(strField)) {
            const withValue = (value: string): Partial<Extract<Step, { action: "request" }>> =>
                strField
                    ? { query: queryObj, body: { ...(validBody as object), [strField[0]]: value } }
                    : { query: { ...(queryObj ?? {}), [strQuery!.name]: value } };
            const name = strField?.[0] ?? strQuery!.name;
            local.push(
                make(
                    `handles boundary values for "${name}" without a server error`,
                    "boundary",
                    "low",
                    [
                        req(ep, filledPath, withValue(""), "Empty string"),
                        resp("statusBelow", 500, undefined, "No server error"),
                        req(ep, filledPath, withValue("A".repeat(5000)), "5,000 character string"),
                        resp("statusBelow", 500, undefined, "No server error"),
                    ],
                    ["Server rejects or accepts boundary input gracefully (never 5xx)"],
                    ["boundary"],
                ),
                make(
                    `handles injection payloads in "${name}" safely`,
                    "security",
                    "medium",
                    [
                        req(ep, filledPath, withValue(SQLI), "SQL injection payload"),
                        resp("statusBelow", 500, undefined, "No server error"),
                        req(ep, filledPath, withValue(XSS), "XSS payload"),
                        resp("statusBelow", 500, undefined, "No server error"),
                        // A payload echoed inside a JSON answer is data, not markup: the reflection check is for answers that may be HTML.
                        ...(answersJson(ep) ? [] : [resp("bodyNotContains", XSS, undefined, "Payload is not reflected unescaped")]),
                    ],
                    [answersJson(ep) ? "No 5xx for injection payloads" : "No 5xx and no unescaped reflection of injection payloads"],
                    ["security", "injection"],
                ),
            );
        }

        // 6 ── Unknown / malformed path ids
        const pathParams = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
        if (pathParams.length) {
            const target = pathParams[0]!;
            const pSpec = ep.spec?.parameters.find((p) => p.name === target);
            const missing = fillPath(ep.path, ep, (n) => (n === target ? (pSpec?.type === "string" ? "does-not-exist-000" : "999999999") : undefined));
            if (missing) {
                local.push(
                    make(
                        `returns 4xx for an unknown "${target}"`,
                        "negative",
                        "medium",
                        [req(ep, missing, { query: queryObj }, `Use a non-existent ${target}`), resp("statusClass", "4xx", undefined, "Not found / rejected")],
                        ["404-style response for an id that does not exist"],
                        ["not-found"],
                    ),
                );
            }
            if (pSpec && (pSpec.type === "integer" || pSpec.type === "number")) {
                const bad = fillPath(ep.path, ep, (n) => (n === target ? "abc" : undefined));
                if (bad) {
                    local.push(
                        make(
                            `rejects a non-numeric "${target}"`,
                            "negative",
                            "low",
                            [req(ep, bad, { query: queryObj }, `Use "abc" for ${target}`), resp("statusClass", "4xx", undefined, "Rejected")],
                            ["Malformed ids are rejected with 4xx"],
                            ["validation"],
                        ),
                    );
                }
            }
        }

        specs.push(...local.slice(0, opts.maxPerEndpoint));

        // 7 ── Documented cases (C2): each request breaks one documented rule and expects the status the API document gives for it.
        // Only on endpoints that change data (they all send a body), so none runs with data changes off.
        if (SAFE.has(ep.method) || !filledPath || !hasBody || typeof realBody !== "object" || !realBody) continue;
        const documentedCases: DraftSpec[] = [];
        const before: Step[] = [...(ep === signUp || SIGN_IN_LIKE.test(ep.path) ? [] : freshSteps), ...refs.map((r) => r.step)];
        const expectStatus = (status: string): Step[] => {
            const schema = responseOf(ep, status)?.schema as Schema | undefined;
            const contract = opts.contractChecks !== false && ep.source === "openapi" && (schema?.type === "object" || schema?.type === "array") && JSON.stringify(schema).length <= CONTRACT_MAX_SCHEMA_BYTES;
            return [resp("status", Number(status), undefined, `Answered with the documented HTTP ${status}`), ...(contract ? [{ action: "assertResponse" as const, check: "matchesSchema" as const, schema, description: "The answer matches the documented schema" }] : [])];
        };
        const documentedCase = (title: string, status: string, steps: Step[]) =>
            make(title, "negative", "medium", [...before, ...steps, ...expectStatus(status)], [`HTTP ${status}${responseOf(ep, status)?.description ? ` (${responseOf(ep, status)!.description})` : ""}, as the API document says`], ["validation", "documented"]);
        // A made-up reference would be refused as unknown before the rule is checked: those cases wait for a real id.
        const invalid = unresolved.length ? undefined : documentedStatus(ep, "400", "422");
        if (invalid) {
            for (const [field, schema] of Object.entries(props)) {
                for (const v of violations(schema)) {
                    documentedCases.push(documentedCase(`rejects "${field}" ${v.what}`, invalid, [req(ep, filledPath, { query: queryObj, body: { ...realBody, [field]: v.value } }, `Send ${JSON.stringify(v.value).slice(0, 40)} for ${field}`)]));
                }
            }
        }
        const notFound = documentedStatus(ep, "404", "422");
        if (notFound) {
            for (const { field } of references.filter((r) => unresolved.every((u) => u === r.field))) {
                documentedCases.push(documentedCase(`rejects an unknown "${field}"`, notFound, [req(ep, filledPath, { query: queryObj, body: { ...realBody, [field]: "does-not-exist-000" } }, `Use a ${field} that does not exist`)]));
            }
        }
        // A write whose document says a repeat adds to what is there (the cart's "adds to the line") accepts the repeat: no duplicate case.
        const conflict = ep.method === "POST" && !unresolved.length && !repeatAdds(ep.summary) ? documentedStatus(ep, "409") : undefined;
        if (conflict) {
            const first = [req(ep, filledPath, { query: queryObj, body: realBody }, "Send a valid request"), resp("statusClass", "2xx", undefined, "The first one is accepted")];
            documentedCases.push(documentedCase("rejects the same request twice (a duplicate)", conflict, [...first, req(ep, filledPath, { query: queryObj, body: realBody }, "Send the same request again")]));
            const email = Object.entries(props).find(([k, v]) => v.type === "string" && (v.format === "email" || /email/i.test(k)) && typeof (realBody as Record<string, unknown>)[k] === "string");
            if (email && emailCaseStated(ep, conflict, opts.requirementsText)) {
                const again = { ...realBody, [email[0]]: otherCase((realBody as Record<string, string>)[email[0]]!) };
                documentedCases.push(documentedCase(`rejects an "${email[0]}" already used, in other letter case`, conflict, [...first, req(ep, filledPath, { query: queryObj, body: again }, `Send it again with "${email[0]}" in capitals`)]));
            }
        }
        specs.push(...documentedCases.slice(0, MAX_DOCUMENTED));
    }
    return { specs, skippedMutating, skipped };
}
