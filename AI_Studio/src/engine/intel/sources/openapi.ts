/**
 * An OpenAPI (or Swagger) document as a source of application knowledge, without AI: every operation becomes a documented endpoint with
 * the document's path as evidence, component schemas become entities (and, without a schema of that name, a collection a path addresses
 * by id becomes an inferred one), `$ref`s between schemas become relationships, and the request
 * chains the API test generator detects (list -> detail, create -> read...) become workflows. Nothing is requested from the application.
 */
import { parseOpenApi, parseSpecText } from "../../api/openapi.js";
import { generateApiWorkflowSpecs } from "../../api/workflows.js";
import type { ModelFragment } from "../fragment.js";
import { AppModelSchema, endpointKey, type AppModel, type Endpoint, type Evidence } from "../model.js";
import { fingerprintJson, fingerprintText } from "./fingerprint.js";
import { hideSecrets } from "./hide-secrets.js";

type Json = Record<string, any>;

const MAX_ENDPOINTS = 2000;
const MAX_ENTITIES = 500;
const MAX_FIELDS = 100;
const MAX_WORKFLOWS = 50;
/** Request chains are looked for among this many operations (the detection compares operations pairwise). */
const MAX_CHAIN_OPERATIONS = 500;
/** The largest OpenAPI text read (the repository finder reads files up to the same size). */
export const MAX_OPENAPI_TEXT = 2 * 1024 * 1024;
/** Any URL works: parseOpenApi needs one to resolve relative server addresses; nothing is fetched. */
const PLACEHOLDER_URL = "http://openapi.invalid/";

const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);
/** A JSON pointer segment (`/` and `~` escaped). */
const seg = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const evidence = (ref: string, pointer: string): Evidence => ({ kind: "openapi", ref: cut(`${ref}#${pointer}`, 500) });
const refName = (ref: unknown) => (typeof ref === "string" && ref.startsWith("#/") ? ref.split("/").pop()! : undefined);

function emptyFragment(ref: string, fingerprint: string, now: string, error: string): ModelFragment {
    return { source: { kind: "openapi", ref: cut(ref, 500), fingerprint, status: "failed", processedAt: now, error: cut(error, 500) }, model: AppModelSchema.parse({}), rules: [], notes: [] };
}

/** The `$ref` of the first JSON schema of a request body or response (`#/components/schemas/Order`), when it has one. */
function schemaRef(holder: Json | undefined): string | undefined {
    if (!holder || typeof holder !== "object") return undefined;
    if (holder.schema?.$ref) return cut(holder.schema.$ref, 300); // Swagger 2
    for (const media of Object.values<Json>(holder.content ?? {})) {
        const s = media?.schema;
        if (typeof s?.$ref === "string") return cut(s.$ref, 300);
        if (typeof s?.items?.$ref === "string") return cut(s.items.$ref, 300);
    }
    return undefined;
}

function fieldType(s: Json): string | undefined {
    const named = refName(s?.$ref);
    if (named) return named;
    if (s?.type === "array") {
        const inner = refName(s.items?.$ref) ?? (typeof s.items?.type === "string" ? s.items.type : undefined);
        return inner ? `${inner}[]` : "array";
    }
    return typeof s?.type === "string" ? s.type : undefined;
}

function constraints(s: Json, required: boolean): string[] {
    const out: string[] = [];
    if (required) out.push("required");
    if (typeof s.format === "string") out.push(`format ${s.format}`);
    for (const k of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const) if (typeof s[k] === "number") out.push(`${k} ${s[k]}`);
    if (typeof s.pattern === "string") out.push(`pattern ${s.pattern}`);
    if (Array.isArray(s.enum)) out.push(`one of: ${s.enum.map(String).join(", ")}`);
    return out.map((c) => hideSecrets(c, { max: 200 })).slice(0, 20);
}

/** Entities from component schemas and relationships from `$ref`s between them (only there: a field that merely names another entity is not one). */
function entitiesOf(spec: Json, ref: string, model: AppModel, notes: string[]) {
    const [schemas, base] = spec.components?.schemas ? [spec.components.schemas as Json, "/components/schemas"] : [(spec.definitions ?? {}) as Json, "/definitions"];
    const names = Object.keys(schemas);
    if (names.length > MAX_ENTITIES) notes.push(`Only the first ${MAX_ENTITIES} schemas were read as entities.`);
    for (const name of names.slice(0, MAX_ENTITIES)) {
        const s = schemas[name];
        if (!s || typeof s !== "object") continue;
        const pointer = `${base}/${seg(name)}`;
        const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
        const props = Object.entries<Json>(s.properties ?? {});
        model.entities.push({
            id: cut(name, 100),
            name: cut(name, 100),
            sourceType: "openapi",
            explicitness: "explicit",
            fields: props.slice(0, MAX_FIELDS).map(([field, p]) => ({ name: cut(field, 100), ...(fieldType(p) ? { type: cut(fieldType(p), 50) } : {}), constraints: constraints(p ?? {}, required.has(field)) })),
            evidence: [evidence(ref, pointer)],
        });
        for (const [field, p] of props) {
            const one = refName(p?.$ref);
            const many = p?.type === "array" ? refName(p.items?.$ref) : undefined;
            const to = one ?? many;
            if (!to || !(to in schemas) || model.relationships.length >= 2000) continue;
            model.relationships.push({ from: cut(name, 100), to: cut(to, 100), kind: many ? "has_many" : "references", evidence: [evidence(ref, `${pointer}/properties/${seg(field)}`)] });
        }
    }
}

/** "orders" -> "order", "categories" -> "category"; a word that is not plural (status, address, news is not checked) gives undefined. */
function singular(word: string): string | undefined {
    const w = word.toLowerCase();
    if (!/^[a-z][a-z0-9_-]*s$/.test(w) || /(ss|us|is)$/.test(w)) return undefined;
    if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
    if (/(ches|shes|xes)$/.test(w)) return w.slice(0, -2);
    return w.slice(0, -1);
}
const isParam = (s: string | undefined) => !!s && /^\{[^}]+\}$/.test(s);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The inline object schema of a request body or response (not a `$ref`: a schema it names is already an entity). */
function inlineObject(holder: Json | undefined): Json | undefined {
    if (!holder || typeof holder !== "object") return undefined;
    const schemas = [holder.schema, ...Object.values<Json>(holder.content ?? {}).map((m) => m?.schema)];
    return schemas.find((x) => x && typeof x === "object" && !x.$ref && x.properties && typeof x.properties === "object");
}

/**
 * Entities inferred from paths, for a document without a schema of that name: a plural segment followed by a parameter
 * (`/api/orders/{id}`) addresses records of a collection, "order". Under a segment that is itself a documented path (`/api/cart`), the
 * name carries it ("cart item"). Its fields are those of the inline request bodies that create or change one (POST on the collection,
 * PUT or PATCH on one) and of the inline answer for one (GET). Each is inferred: the document addresses the collection, it does not
 * declare an entity.
 */
function pathEntitiesOf(spec: Json, ref: string, model: AppModel) {
    const paths = spec.paths as Json;
    const documented = new Set(Object.keys(paths).map((p) => p.replace(/\/+$/, "")));
    const stated = new Set(model.entities.map((e) => squash(e.name)));
    const found = new Map<string, AppModel["entities"][number]>();
    for (const docPath of Object.keys(paths)) {
        const parts = docPath.split("/");
        for (let i = 1; i + 1 < parts.length; i++) {
            const one = singular(parts[i]!);
            if (!one || !isParam(parts[i + 1])) continue;
            const prev = parts[i - 1];
            const parent = prev && !isParam(prev) && documented.has(parts.slice(0, i).join("/")) ? (singular(prev) ?? prev.toLowerCase()) : undefined;
            const name = cut(parent ? `${parent} ${one}` : one, 100);
            if (stated.has(squash(name)) || found.has(name) || found.size + model.entities.length >= MAX_ENTITIES) continue;
            const collection = parts.slice(0, i + 1).join("/");
            const item = parts.slice(0, i + 2).join("/");
            const entity = { id: cut(name.replace(/\s+/g, "-"), 100), name, fields: [] as AppModel["entities"][number]["fields"], sourceType: "inferred" as const, explicitness: "inferred" as const, evidence: [evidence(ref, `/paths/${seg(item in paths ? item : docPath)}`)] };
            const bodies: [string, string, Json | undefined][] = [
                [collection, "post", paths[collection]?.post],
                [item, "put", paths[item]?.put],
                [item, "patch", paths[item]?.patch],
                [item, "get", paths[item]?.get],
            ];
            for (const [p, method, op] of bodies) {
                if (!op || typeof op !== "object") continue;
                const fromBody = method !== "get";
                const holder = fromBody ? (op.requestBody ?? (Array.isArray(op.parameters) ? op.parameters.find((x: Json) => x?.in === "body") : undefined)) : Object.entries<Json>(op.responses ?? {}).find(([status]) => /^2/.test(status))?.[1];
                const schema = inlineObject(holder);
                if (!schema) continue;
                const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
                for (const [field, f] of Object.entries<Json>(schema.properties)) {
                    if (entity.fields.length >= MAX_FIELDS || entity.fields.some((x) => x.name === field)) continue;
                    entity.fields.push({ name: cut(field, 100), ...(fieldType(f) ? { type: cut(fieldType(f), 50) } : {}), constraints: constraints(f ?? {}, required.has(field)) });
                }
                if (entity.evidence.length < 20) entity.evidence.push(evidence(ref, `/paths/${seg(p)}/${method}/${fromBody ? "requestBody" : "responses"}`));
            }
            found.set(name, entity);
        }
    }
    model.entities.push(...found.values());
}

/** The documented endpoint a chain's request goes to: same method, same segments, a `{param}` matching any one segment. */
function endpointFor(method: string, path: string, endpoints: Endpoint[]): Endpoint | undefined {
    const parts = path.split("?")[0]!.split("/");
    let best: { e: Endpoint; params: number } | undefined;
    for (const e of endpoints) {
        if (e.method !== method) continue;
        const ep = e.path.split("/");
        if (ep.length !== parts.length) continue;
        let params = 0;
        if (!ep.every((p, i) => (p.startsWith("{") ? (params++, true) : p === parts[i]))) continue;
        if (!best || params < best.params) best = { e, params };
    }
    return best?.e;
}

export function openApiFragment(spec: Json, opts: { ref: string; now?: string }): ModelFragment {
    const now = opts.now ?? new Date().toISOString();
    const ref = cut(opts.ref, 400);
    let fingerprint: string;
    try {
        fingerprint = fingerprintJson(spec);
    } catch {
        // A document nested deeper than the call stack allows: that source fails, nothing else does.
        return emptyFragment(opts.ref, "", now, "The OpenAPI document is nested too deeply to be read.");
    }
    if (!spec || typeof spec !== "object" || (!spec.openapi && !spec.swagger) || typeof spec.paths !== "object") {
        return emptyFragment(opts.ref, fingerprint, now, "This is not an OpenAPI or Swagger document (no openapi or swagger version and paths).");
    }
    const specUrl = /^https?:\/\//.test(opts.ref) ? opts.ref : PLACEHOLDER_URL;
    let parsed;
    let trimmed = false;
    try {
        // Only the first paths are parsed, so a huge document costs no more than one at the cap.
        const pathItems = Object.entries<unknown>(spec.paths);
        parsed = parseOpenApi(pathItems.length > MAX_ENDPOINTS ? { ...spec, paths: Object.fromEntries(pathItems.slice(0, MAX_ENDPOINTS)) } : spec, specUrl);
        trimmed = pathItems.length > MAX_ENDPOINTS;
    } catch {
        return emptyFragment(opts.ref, fingerprint, now, "The OpenAPI document could not be read: its server address or paths are not valid.");
    }
    const notes: string[] = [];
    const model = AppModelSchema.parse({ contextSources: ["openapi"] });
    const basePath = new URL(parsed.baseUrl).pathname.replace(/\/$/, "");
    if (trimmed || parsed.operations.length > MAX_ENDPOINTS) notes.push(`Only the first ${MAX_ENDPOINTS} operations were read.`);
    for (const op of parsed.operations.slice(0, MAX_ENDPOINTS)) {
        const docPath = op.path.slice(basePath.length) || "/";
        const raw: Json = spec.paths?.[docPath]?.[op.method.toLowerCase()] ?? {};
        const responses = op.spec?.responses ?? [];
        const ok = Object.entries<Json>(raw.responses ?? {}).find(([status]) => /^2/.test(status));
        const requestSchema = schemaRef(raw.requestBody) ?? schemaRef((Array.isArray(raw.parameters) ? raw.parameters : []).find((p: Json) => p?.in === "body"));
        const responseSchema = ok ? schemaRef(ok[1]) : undefined;
        model.endpoints.push({
            method: op.method,
            path: cut(op.path, 500),
            origin: "documented",
            parameters: (op.spec?.parameters ?? []).slice(0, 100).map((p) => ({ name: cut(p.name, 100), in: p.location, required: !!p.required, type: cut(p.type, 50) })),
            ...(requestSchema ? { requestSchema } : {}),
            ...(responseSchema ? { responseSchema } : {}),
            // Only when the document says (a security list on the operation or the whole document); otherwise unknown.
            ...(raw.security !== undefined || spec.security !== undefined ? { requiresAuth: !!op.requiresAuth } : {}),
            errors: responses
                .filter((r) => /^[45]/.test(r.status) || r.status === "default")
                .slice(0, 30)
                .map((r) => ({ status: cut(r.status, 10), description: hideSecrets(cut(r.description, 600), { max: 300 }) })),
            evidence: [evidence(ref, `/paths/${seg(docPath)}/${op.method.toLowerCase()}`)],
        });
    }
    entitiesOf(spec, ref, model, notes);
    pathEntitiesOf(spec, ref, model);
    const chains = generateApiWorkflowSpecs(parsed.operations.slice(0, MAX_CHAIN_OPERATIONS), { allowMutating: true, maxWorkflows: MAX_WORKFLOWS }).specs;
    const usedIds = new Set<string>();
    for (const chain of chains) {
        const steps = chain.steps.flatMap((s) => (s.action === "request" ? [endpointFor(s.method, basePath + (s.path.startsWith("/") ? "" : "/") + s.path, model.endpoints) ?? endpointFor(s.method, s.path, model.endpoints)] : []));
        if (steps.length < 2 || steps.some((e) => !e)) continue;
        let id = cut(`openapi-${chain.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`, 90);
        for (let n = 2; usedIds.has(id); n++) id = `${id.slice(0, 90)}-${n}`;
        usedIds.add(id);
        model.workflows.push({
            id,
            name: cut(chain.title, 200),
            steps: steps.map((e, i) => ({ order: i, action: cut(`${endpointKey(e!)}`, 500), endpoint: cut(endpointKey(e!), 300) })),
            preconditions: [],
            postconditions: [],
            roles: [],
            sourceType: "openapi",
            evidence: [...new Map(steps.map((e) => [e!.evidence[0]!.ref, e!.evidence[0]!])).values()].slice(0, 20),
        });
    }
    return { source: { kind: "openapi", ref: cut(opts.ref, 500), fingerprint, status: "processed", processedAt: now }, model, rules: [], notes };
}

/** The same from the document's text (JSON or YAML); text that does not parse fails the source with a sentence. */
export function openApiFragmentFromText(text: string, opts: { ref: string; now?: string }): ModelFragment {
    if (text.length > MAX_OPENAPI_TEXT) return emptyFragment(opts.ref, fingerprintText(text), opts.now ?? new Date().toISOString(), "The OpenAPI document is larger than 2 MB, so it was not read.");
    let spec: Json;
    try {
        spec = parseSpecText(text);
    } catch {
        return emptyFragment(opts.ref, fingerprintText(text), opts.now ?? new Date().toISOString(), "The OpenAPI document is not valid JSON or YAML.");
    }
    return openApiFragment(spec, opts);
}
