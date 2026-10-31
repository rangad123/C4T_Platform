/**
 * OpenAPI diff: what changed between two versions of an API description, and which changes break existing clients.
 *
 * Works on the documents alone (no running application). Conventions, stated so results are predictable:
 *  - breaking = a client written against the OLD description can stop working;
 *  - request side (what clients send): a new required parameter/field, a removed or retyped one, a narrowed enum;
 *  - response side (what clients read): a removed or retyped field, a field that stopped being guaranteed, a success status
 *    that disappeared, a widened enum (clients may not handle the new value);
 *  - an operation that disappeared, or that now needs authentication, is breaking;
 *  - everything that only adds capability (new operation, new optional input, new response field) is non-breaking.
 */
import { deref, resolveObj } from "../api/openapi.js";

type Json = Record<string, any>;

export interface ApiChange {
    breaking: boolean;
    /** Operation, e.g. "GET /users/{}". */
    operation: string;
    /** Plain-language description. */
    message: string;
}

export interface ApiDiff {
    breaking: ApiChange[];
    nonBreaking: ApiChange[];
}

const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const JSON_TYPE = /json/i;

/** `/users/{id}` and `/users/{userId}` are the same endpoint. */
export const template = (p: string) => p.replace(/\{[^}]*\}/g, "{}");

interface Op {
    params: Map<string, Json>;
    body?: { required: boolean; schema: Json };
    responses: Map<string, Json | undefined>;
    auth: boolean;
}

function collect(doc: Json): Map<string, Op> {
    const ops = new Map<string, Op>();
    for (const [rawPath, item] of Object.entries<Json>(doc.paths ?? {})) {
        if (!item || typeof item !== "object") continue;
        for (const m of METHODS) {
            const op = item[m];
            if (!op || typeof op !== "object") continue;
            const key = `${m.toUpperCase()} ${template(rawPath)}`;
            const params = new Map<string, Json>();
            const allParams = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((x: unknown) => resolveObj(doc, x));
            for (const p of allParams) {
                if (p.name && p.in && p.in !== "body") params.set(`${p.in}:${p.name}`, { ...p, schema: deref(doc, p.schema ?? { type: p.type, enum: p.enum, format: p.format }) });
            }
            let body: Op["body"];
            const rb = op.requestBody ? resolveObj(doc, op.requestBody) : undefined;
            const content = rb?.content ? (Object.entries<Json>(rb.content).find(([t]) => JSON_TYPE.test(t))?.[1] ?? Object.values<Json>(rb.content)[0]) : undefined;
            if (rb && content?.schema) body = { required: Boolean(rb.required), schema: deref(doc, content.schema) };
            const swaggerBody = allParams.find((p) => p.in === "body");
            if (swaggerBody?.schema) body = { required: Boolean(swaggerBody.required), schema: deref(doc, swaggerBody.schema) };

            const responses = new Map<string, Json | undefined>();
            for (const [status, raw] of Object.entries<Json>(op.responses ?? {})) {
                const r = resolveObj(doc, raw);
                const c = r.content ? Object.entries<Json>(r.content).find(([t]) => JSON_TYPE.test(t))?.[1] : undefined;
                const schema = c?.schema ?? r.schema;
                responses.set(status, schema ? deref(doc, schema) : undefined);
            }
            const security = op.security ?? doc.security;
            const auth = Array.isArray(security) && security.length > 0 && !security.some((s: Json) => Object.keys(s).length === 0);
            ops.set(key, { params, body, responses, auth });
        }
    }
    return ops;
}

const typeOf = (s: Json): string => {
    const t = Array.isArray(s.type) ? s.type.filter((x: string) => x !== "null").join("|") : s.type;
    return t || (s.properties ? "object" : s.items ? "array" : "any");
};

/** Compare two schemas; `side` decides which direction of a change breaks clients. */
function diffSchema(a: Json, b: Json, where: string, side: "request" | "response", op: string, out: ApiChange[], depth = 0): void {
    if (depth > 5) return;
    const ta = typeOf(a);
    const tb = typeOf(b);
    if (ta !== "any" && tb !== "any" && ta !== tb) {
        out.push({ breaking: true, operation: op, message: `${side} ${where ? where.replace(/\.$/, "") : "body"} changed type from ${ta} to ${tb}` });
        return;
    }
    if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
        const added = b.enum.filter((v: unknown) => !a.enum.includes(v));
        const removed = a.enum.filter((v: unknown) => !b.enum.includes(v));
        const label = `${side} ${where ? where.replace(/\.$/, "") : "value"}`;
        if (side === "request" && removed.length) out.push({ breaking: true, operation: op, message: `${label} no longer accepts ${removed.map(String).join(", ")}` });
        if (side === "request" && added.length) out.push({ breaking: false, operation: op, message: `${label} now also accepts ${added.map(String).join(", ")}` });
        if (side === "response" && added.length) out.push({ breaking: true, operation: op, message: `${label} can now also be ${added.map(String).join(", ")}, which existing clients may not handle` });
        if (side === "response" && removed.length) out.push({ breaking: false, operation: op, message: `${label} can no longer be ${removed.map(String).join(", ")}` });
    }
    if (a.properties || b.properties) {
        const pa: Json = a.properties ?? {};
        const pb: Json = b.properties ?? {};
        const reqA = new Set<string>(a.required ?? []);
        const reqB = new Set<string>(b.required ?? []);
        for (const name of Object.keys(pa)) {
            if (!(name in pb)) {
                // Removing an input a client may still send is harmless to the server; removing an output breaks readers.
                out.push({ breaking: side === "response", operation: op, message: `${side} field ${where}${name} was removed` });
                continue;
            }
            if (side === "response" && reqA.has(name) && !reqB.has(name)) out.push({ breaking: true, operation: op, message: `response field ${where}${name} is no longer always present` });
            if (side === "request" && !reqA.has(name) && reqB.has(name)) out.push({ breaking: true, operation: op, message: `request field ${where}${name} is now required` });
            diffSchema(pa[name], pb[name], `${where}${name}.`, side, op, out, depth + 1);
        }
        for (const name of Object.keys(pb)) {
            if (name in pa) continue;
            if (side === "request" && reqB.has(name)) out.push({ breaking: true, operation: op, message: `new required request field ${where}${name}` });
            else out.push({ breaking: false, operation: op, message: `new ${side} field ${where}${name}` });
        }
    }
    if (a.items && b.items) diffSchema(a.items, b.items, `${where}[].`, side, op, out, depth + 1);
}

export function diffOpenApi(oldDoc: Json, newDoc: Json): ApiDiff {
    const a = collect(oldDoc);
    const b = collect(newDoc);
    const changes: ApiChange[] = [];

    for (const [key, oa] of a) {
        const ob = b.get(key);
        if (!ob) {
            changes.push({ breaking: true, operation: key, message: "this operation was removed" });
            continue;
        }
        for (const [pk, pa] of oa.params) {
            const pb = ob.params.get(pk);
            const name = `${pa.in} parameter "${pa.name}"`;
            if (!pb) {
                changes.push({ breaking: true, operation: key, message: `${name} was removed` });
                continue;
            }
            if (!pa.required && pb.required) changes.push({ breaking: true, operation: key, message: `${name} is now required` });
            diffSchema(pa.schema ?? {}, pb.schema ?? {}, `${pa.name}.`, "request", key, changes);
        }
        for (const [pk, pb] of ob.params) {
            if (oa.params.has(pk)) continue;
            const name = `${pb.in} parameter "${pb.name}"`;
            changes.push(pb.required ? { breaking: true, operation: key, message: `new required ${name}` } : { breaking: false, operation: key, message: `new optional ${name}` });
        }
        if (!oa.body && ob.body) changes.push(ob.body.required ? { breaking: true, operation: key, message: "a request body is now required" } : { breaking: false, operation: key, message: "a request body is now accepted" });
        if (oa.body && !ob.body) changes.push({ breaking: false, operation: key, message: "the request body is no longer used" });
        if (oa.body && ob.body) {
            if (!oa.body.required && ob.body.required) changes.push({ breaking: true, operation: key, message: "the request body is now required" });
            diffSchema(oa.body.schema, ob.body.schema, "", "request", key, changes);
        }
        for (const [status, sa] of oa.responses) {
            if (!ob.responses.has(status)) {
                changes.push({ breaking: /^2/.test(status), operation: key, message: `${/^2/.test(status) ? "success response" : "response"} ${status} is no longer documented` });
                continue;
            }
            const sb = ob.responses.get(status);
            if (sa && sb && /^2/.test(status)) diffSchema(sa, sb, "", "response", key, changes);
            if (sa && !sb && /^2/.test(status)) changes.push({ breaking: true, operation: key, message: `response ${status} no longer describes a body` });
        }
        for (const status of ob.responses.keys()) if (!oa.responses.has(status)) changes.push({ breaking: false, operation: key, message: `new response ${status}` });
        if (!oa.auth && ob.auth) changes.push({ breaking: true, operation: key, message: "authentication is now required" });
        if (oa.auth && !ob.auth) changes.push({ breaking: false, operation: key, message: "authentication is no longer required" });
    }
    for (const key of b.keys()) if (!a.has(key)) changes.push({ breaking: false, operation: key, message: "new operation" });

    return { breaking: changes.filter((c) => c.breaking), nonBreaking: changes.filter((c) => !c.breaking) };
}

/** Markdown rendering shared by the CLI and the API. */
export function renderDiffMarkdown(d: ApiDiff): string {
    const section = (title: string, items: ApiChange[]) =>
        items.length ? `### ${title} (${items.length})\n\n${items.map((c) => `- \`${c.operation}\`: ${c.message}`).join("\n")}\n` : `### ${title}\n\nNone.\n`;
    return `# API changes\n\n${section("Breaking changes", d.breaking)}\n${section("Other changes", d.nonBreaking)}`;
}
