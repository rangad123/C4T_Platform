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

export type DraftSpec = Omit<TestSpec, "testId">;

export interface ApiGenOptions {
    allowMutating: boolean;
    /** Check real responses against the documented schema (default true). */
    contractChecks?: boolean;
    maxPerEndpoint: number;
}

export interface ApiGenResult {
    specs: DraftSpec[];
    skippedMutating: number;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const SQLI = "' OR '1'='1' --";
const XSS = "<script>alert(1)</script>";

type Schema = Record<string, any>;

function sample(schema: Schema | undefined, name = "value", depth = 0): unknown {
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

export function generateApiSpecs(endpoints: ApiEndpointModel[], opts: ApiGenOptions): ApiGenResult {
    const specs: DraftSpec[] = [];
    let skippedMutating = 0;

    for (const ep of endpoints) {
        if (!SAFE.has(ep.method) && !opts.allowMutating) {
            skippedMutating++;
            continue;
        }
        const label = `${ep.method} ${ep.path}`;
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

        // 1 ── Happy path
        if (filledPath) {
            const documented2xx = ep.spec?.responses.find((r) => /^2/.test(r.status));
            const okSchema = documented2xx?.schema as Schema | undefined;
            const steps: Step[] = [
                req(ep, filledPath, { query: queryObj, ...(hasBody ? { body: validBody } : {}) }, `Send a valid ${ep.method} request`),
                resp(
                    "statusClass",
                    ep.source === "network" ? `${String(ep.statuses[0] ?? 200).charAt(0)}xx` : "2xx",
                    undefined,
                    "Request succeeds",
                ),
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
            local.push(make("succeeds with a valid request", "functional", "high", steps, ["Returns a successful response matching the documented contract"], ["happy-path"]));
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
                        resp("bodyNotContains", XSS, undefined, "Payload is not reflected unescaped"),
                    ],
                    ["No 5xx and no unescaped reflection of injection payloads"],
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
    }
    return { specs, skippedMutating };
}
