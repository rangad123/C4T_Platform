/**
 * Round 20 (SIGN): an uploaded API document (OpenAPI 3 or Swagger 2, JSON or YAML, at most 2 MB), read only.
 *
 * It is parsed to list its operations as coverage. Of those, only GET operations WITHOUT required parameters (no path parameter, no
 * required query/header/cookie parameter, no required body) may be requested, and only through the scope guard (in scope, not excluded,
 * not a sensitive workflow, not a sign-out address); everything else is listed with the plain reason it was not called. Nothing in the
 * document is ever sent as a value: no examples, no parameters, no bodies.
 *
 * Stable API:
 *   readApiDocument(text, fileName)          { format, title, version, doc } or throws ApiDocumentError (plain message)
 *   planOperations(doc, targetUrl)           { operations: PlannedOperation[], total, requestable, baseUrl }
 *   API_DOCUMENT_MAX_REQUESTS                the most operations one assessment requests
 */
import { parseSpecText } from "../engine/api/openapi.js";
import { isSignOut } from "./signin.js";

export const API_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
/** Operations requested by one assessment at most (the request budget applies as well). */
export const API_DOCUMENT_MAX_REQUESTS = 50;
/** Operations listed at most (a document with more is still read; the count says how many there are). */
export const API_DOCUMENT_MAX_LISTED = 2000;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export class ApiDocumentError extends Error {}

type Json = Record<string, unknown>;

export interface ReadApiDocument {
    format: "json" | "yaml";
    title: string | null;
    version: string | null;
    doc: Json;
}

const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Parses the document; refuses anything that is not an OpenAPI 3 / Swagger 2 document with a `paths` object. */
export function readApiDocument(text: string, fileName = ""): ReadApiDocument {
    if (Buffer.byteLength(text, "utf8") > API_DOCUMENT_MAX_BYTES) throw new ApiDocumentError(`The API document is larger than ${API_DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`);
    if (!text.trim()) throw new ApiDocumentError("The API document is empty.");
    const format: "json" | "yaml" = text.trim().startsWith("{") || /\.json$/i.test(fileName) ? "json" : "yaml";
    let doc: Json;
    try {
        const parsed = parseSpecText(text);
        if (!isObj(parsed)) throw new Error("not an object");
        doc = parsed;
    } catch {
        throw new ApiDocumentError(format === "json" ? "The API document is not valid JSON." : "The API document is not valid JSON or YAML.");
    }
    if (!(typeof doc.openapi === "string" || typeof doc.swagger === "string")) throw new ApiDocumentError("This is not an OpenAPI or Swagger document (it has no “openapi” or “swagger” version line).");
    if (!isObj(doc.paths)) throw new ApiDocumentError("The API document has no “paths”, so it lists no operations.");
    const info = isObj(doc.info) ? doc.info : {};
    return { format, title: str(info.title), version: str(info.version, 60), doc };
}

/** One operation of the document and whether an assessment may request it. */
export interface PlannedOperation {
    method: string;
    path: string;
    /** The address it would be requested at (GET operations without required parameters only). */
    url: string | null;
    /** True when it may be requested (the scope guard still decides at the time of the assessment). */
    request: boolean;
    /** Why it is not requested (plain), or null. */
    reason: string | null;
    /** The same, as a code for counting: request | not-get | needs-values | sign-out | bad-path (and refused: outside the scope or excluded, in the preview). */
    kind: "request" | "not-get" | "needs-values" | "sign-out" | "bad-path" | "refused";
}

export interface OperationPlan {
    operations: PlannedOperation[];
    total: number;
    requestable: number;
    /** Where the document says the API is, resolved against the application's address. */
    baseUrl: string;
}

function resolveRef(doc: Json, v: unknown): Json | undefined {
    if (!isObj(v)) return undefined;
    if (typeof v.$ref !== "string") return v;
    if (!v.$ref.startsWith("#/")) return undefined;
    let node: unknown = doc;
    for (const raw of v.$ref.slice(2).split("/")) {
        const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        node = isObj(node) ? node[part] : undefined;
        if (node === undefined) return undefined;
    }
    return isObj(node) ? node : undefined;
}

/** The API's base address: OpenAPI 3 `servers[0].url` (variables filled with their defaults), Swagger 2 `schemes/host/basePath`, else the target. */
export function baseUrlOf(doc: Json, targetUrl: string): string {
    const target = new URL(targetUrl);
    try {
        if (Array.isArray(doc.servers) && isObj(doc.servers[0]) && typeof doc.servers[0].url === "string") {
            const s = doc.servers[0];
            const vars = isObj(s.variables) ? s.variables : {};
            const url = String(s.url).replace(/\{([^}]+)\}/g, (_m, name: string) => {
                const v = vars[name];
                return isObj(v) && typeof v.default === "string" ? v.default : "";
            });
            return new URL(url, target).href.replace(/\/+$/, "");
        }
        if (typeof doc.swagger === "string") {
            const scheme = Array.isArray(doc.schemes) && typeof doc.schemes[0] === "string" ? doc.schemes[0] : target.protocol.replace(/:$/, "");
            const host = typeof doc.host === "string" && doc.host ? doc.host : target.host;
            const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
            return new URL(`${scheme}://${host}${basePath.startsWith("/") || !basePath ? basePath : `/${basePath}`}`).href.replace(/\/+$/, "");
        }
    } catch {
        /* fall back to the target */
    }
    return target.origin;
}

/** Why a GET operation cannot be requested without inventing values, or undefined when it can. */
function needsValues(doc: Json, path: string, pathItem: Json, op: Json): string | undefined {
    if (/\{[^}]*\}/.test(path)) return "It needs values in its address (path parameters), so it is not called.";
    const params = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
    const required: string[] = [];
    for (const raw of params) {
        const p = resolveRef(doc, raw);
        if (!p) return "One of its parameters could not be read, so it is not called.";
        if (p.required === true || p.in === "path") required.push(String(p.name ?? "?").slice(0, 40));
        if (p.in === "body" && p.required === true) return "It needs a request body, so it is not called.";
    }
    if (required.length) return `It needs parameters (${required.slice(0, 5).join(", ")}${required.length > 5 ? ", …" : ""}), so it is not called.`;
    const body = op.requestBody === undefined ? undefined : resolveRef(doc, op.requestBody);
    if (op.requestBody !== undefined && (!body || body.required === true)) return "It needs a request body, so it is not called.";
    return undefined;
}

/** Lists the document's operations and decides which may be requested (GET without required parameters, not a sign-out address). */
export function planOperations(doc: Json, targetUrl: string): OperationPlan {
    const baseUrl = baseUrlOf(doc, targetUrl);
    const operations: PlannedOperation[] = [];
    let total = 0;
    let requestable = 0;
    const paths = isObj(doc.paths) ? doc.paths : {};
    for (const [path, rawItem] of Object.entries(paths)) {
        const item = resolveRef(doc, rawItem);
        if (!item) continue;
        for (const m of METHODS) {
            const op = item[m];
            if (!isObj(op)) continue;
            total++;
            const method = m.toUpperCase();
            const cleanPath = path.slice(0, 500);
            let reason: string | undefined;
            let kind: PlannedOperation["kind"] = "request";
            let url: string | null = null;
            if (m !== "get") reason = m === "head" || m === "options" ? `Only GET operations are requested; ${method} is not called.` : `${method} could change data, so it is never called.`;
            else if (!path.startsWith("/")) reason = "Its path does not start with /, so it is not called.";
            else reason = needsValues(doc, path, item, op);
            if (reason) kind = m !== "get" ? "not-get" : path.startsWith("/") ? "needs-values" : "bad-path";
            if (!reason) {
                try {
                    url = new URL(baseUrl + path).href;
                } catch {
                    reason = "Its address could not be made from the document, so it is not called.";
                    kind = "bad-path";
                }
            }
            if (!reason && url && isSignOut(url)) {
                reason = "It looks like a sign-out address, so it is never called.";
                kind = "sign-out";
            }
            if (!reason) requestable++;
            if (operations.length < API_DOCUMENT_MAX_LISTED) operations.push({ method, path: cleanPath, url: reason ? null : url, request: !reason, reason: reason ?? null, kind });
        }
    }
    return { operations, total, requestable, baseUrl };
}
