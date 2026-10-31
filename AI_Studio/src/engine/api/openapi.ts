/**
 * OpenAPI 3.x / Swagger 2.x ingestion.
 *
 * TypeScript port of ai-testing-agent's `spec_ingestion.py` (MIT, Copyright (c) 2026 dannicolau7,
 * https://github.com/dannicolau7/ai-testing-agent). Same behaviour: local `$ref` resolution,
 * path-level + operation-level parameter merging, OpenAPI 3 `requestBody` and Swagger 2 body
 * parameters, per-status response schemas, security scheme resolution, base URL from
 * `servers` / `host+basePath`. Differences: operates on already-fetched JSON/YAML text, returns
 * the platform's `ApiEndpointModel`, and adds probing of well-known spec URLs.
 */
import { parse as parseYaml } from "yaml";
import type { APIRequestContext } from "playwright";
import type { ApiEndpointModel, OpenApiOperation, OpenApiParameter } from "../understanding/app-model.js";

type Json = Record<string, any>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export interface ParsedOpenApi {
    version: string;
    title: string;
    baseUrl: string;
    operations: ApiEndpointModel[];
}

export function parseSpecText(text: string): Json {
    const trimmed = text.trim();
    const doc = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseYaml(trimmed);
    if (!doc || typeof doc !== "object") throw new Error("Spec did not parse to an object");
    return doc as Json;
}

function resolveRef(spec: Json, ref: string): Json {
    if (!ref.startsWith("#/")) return {};
    let node: any = spec;
    for (const raw of ref.slice(2).split("/")) {
        const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        node = node && typeof node === "object" ? node[part] : undefined;
        if (node === undefined) return {};
    }
    return node && typeof node === "object" ? node : {};
}

export function resolveObj(spec: Json, obj: any): Json {
    if (obj && typeof obj === "object" && "$ref" in obj) return resolveRef(spec, obj.$ref);
    return obj && typeof obj === "object" ? obj : {};
}

/** Fully dereference a schema to a bounded depth (guards circular refs), keeping `required`. */
export function deref(spec: Json, schema: any, depth = 0): Json {
    if (!schema || typeof schema !== "object") return {};
    if (depth > 4) return { type: schema.type ?? "object" };
    const s = resolveObj(spec, schema);
    const out: Json = { ...s };
    delete out.$ref;
    if (s.allOf) {
        const merged: Json = { type: "object", properties: {}, required: [] };
        for (const part of s.allOf) {
            const d = deref(spec, part, depth + 1);
            Object.assign(merged.properties, d.properties ?? {});
            merged.required.push(...(d.required ?? []));
        }
        return { ...out, ...merged, allOf: undefined };
    }
    if (s.oneOf || s.anyOf) {
        const first = (s.oneOf ?? s.anyOf)[0];
        // Only the first alternative is kept, so a response may legitimately match another one: flag it so contract
        // checks skip this node instead of raising a false alarm.
        return { ...deref(spec, first, depth + 1), ...(s.description ? { description: s.description } : {}), "x-aitp-lossy": true };
    }
    if (s.properties) {
        out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, deref(spec, v, depth + 1)]));
    }
    if (s.items) out.items = deref(spec, s.items, depth + 1);
    return out;
}

function mergeParameters(spec: Json, pathParams: any[], opParams: any[]): Json[] {
    const op = opParams.map((p) => resolveObj(spec, p)).filter((p) => p.name);
    const keys = new Set(op.map((p) => `${p.name}:${p.in}`));
    const path = pathParams.map((p) => resolveObj(spec, p)).filter((p) => p.name && !keys.has(`${p.name}:${p.in}`));
    return [...path, ...op];
}

function parseParameters(spec: Json, params: Json[]): OpenApiParameter[] {
    return params
        .filter((p) => p.in !== "body" && p.in !== "formData")
        .map((raw) => {
            const schema = deref(spec, raw.schema ?? {});
            return {
                name: raw.name,
                location: raw.in ?? "query",
                required: Boolean(raw.required) || raw.in === "path",
                type: schema.type ?? raw.type ?? "string",
                enum: schema.enum ?? raw.enum,
                example: schema.example ?? raw.example ?? schema.default ?? raw.default,
            };
        });
}

function parseRequestBody(spec: Json, op: Json, params: Json[]): OpenApiOperation["requestBody"] {
    const rb = op.requestBody ? resolveObj(spec, op.requestBody) : undefined;
    if (rb?.content) {
        const entries = Object.entries<Json>(rb.content);
        const preferred = entries.find(([ct]) => ct.includes("json")) ?? entries[0];
        if (preferred && preferred[1]?.schema) {
            return { required: Boolean(rb.required), contentType: preferred[0], schema: deref(spec, preferred[1].schema) };
        }
    }
    const bodyParam = params.find((p) => p.in === "body");
    if (bodyParam) {
        return { required: Boolean(bodyParam.required), contentType: "application/json", schema: deref(spec, bodyParam.schema ?? {}) };
    }
    return undefined;
}

function parseResponses(spec: Json, op: Json): OpenApiOperation["responses"] {
    return Object.entries<any>(op.responses ?? {}).map(([status, raw]) => {
        const r = resolveObj(spec, raw);
        let schema: Json | undefined;
        for (const media of Object.values<Json>(r.content ?? {})) {
            if (media?.schema) {
                schema = deref(spec, media.schema);
                break;
            }
        }
        if (!schema && r.schema) schema = deref(spec, r.schema);
        return { status: String(status), description: r.description ?? "", schema };
    });
}

function securityNames(op: Json, global: any[]): string[] {
    const reqs = op.security ?? global ?? [];
    return reqs.flatMap((r: any) => (r && typeof r === "object" ? Object.keys(r) : []));
}

function baseUrlOf(spec: Json, specUrl: string): string {
    const server = Array.isArray(spec.servers) ? spec.servers[0]?.url : undefined;
    if (server) {
        try {
            return new URL(server, specUrl).toString().replace(/\/$/, "");
        } catch {
            /* fall through */
        }
    }
    if (spec.host) {
        const scheme = spec.schemes?.[0] ?? "https";
        return `${scheme}://${spec.host}${spec.basePath ?? ""}`.replace(/\/$/, "");
    }
    return new URL(specUrl).origin;
}

export function parseOpenApi(spec: Json, specUrl: string): ParsedOpenApi {
    const version = spec.openapi ? `openapi ${spec.openapi}` : spec.swagger ? `swagger ${spec.swagger}` : "unknown";
    const baseUrl = baseUrlOf(spec, specUrl);
    const origin = new URL(baseUrl).origin;
    const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
    const operations: ApiEndpointModel[] = [];

    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
        if (!item || typeof item !== "object") continue;
        for (const method of HTTP_METHODS) {
            const raw = item[method];
            if (!raw || typeof raw !== "object") continue;
            const op = resolveObj(spec, raw);
            const merged = mergeParameters(spec, item.parameters ?? [], op.parameters ?? []);
            const requestBody = parseRequestBody(spec, op, merged);
            const detail: OpenApiOperation = {
                operationId: op.operationId,
                tags: op.tags ?? [],
                parameters: parseParameters(spec, merged),
                requestBody,
                responses: parseResponses(spec, op),
                security: securityNames(op, spec.security),
            };
            operations.push({
                method: method.toUpperCase(),
                path: basePath + path,
                origin,
                statuses: detail.responses.map((r) => Number(r.status)).filter((n) => Number.isFinite(n)),
                queryParams: detail.parameters.filter((p) => p.location === "query").map((p) => p.name),
                requiresAuth: detail.security.length > 0,
                source: "openapi",
                summary: op.summary ?? op.description,
                spec: detail,
                usedIn: [],
            });
        }
    }
    return { version, title: spec.info?.title ?? "API", baseUrl, operations };
}

const CANDIDATE_PATHS = [
    "/openapi.json",
    "/openapi.yaml",
    "/swagger.json",
    "/swagger.yaml",
    "/v3/api-docs",
    "/v2/api-docs",
    "/api-docs",
    "/api/openapi.json",
    "/api/swagger.json",
    "/api/v1/openapi.json",
    "/docs/openapi.json",
    "/.well-known/openapi.json",
];

/** Try an explicit spec URL first, then well-known locations. Returns the first valid spec found. */
export async function probeOpenApi(
    request: APIRequestContext,
    origin: string,
    explicitUrl?: string,
): Promise<{ url: string; parsed: ParsedOpenApi } | null> {
    const candidates = explicitUrl ? [explicitUrl] : CANDIDATE_PATHS.map((p) => origin + p);
    for (const url of candidates) {
        try {
            const res = await request.get(url, { timeout: 6_000, failOnStatusCode: false });
            if (!res.ok()) continue;
            const doc = parseSpecText(await res.text());
            if (!doc.openapi && !doc.swagger) continue;
            if (!doc.paths || Object.keys(doc.paths).length === 0) continue;
            return { url, parsed: parseOpenApi(doc, url) };
        } catch {
            /* not a spec at this URL */
        }
    }
    return null;
}
