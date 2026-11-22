/**
 * API endpoints → multi-request workflow test specifications.
 *
 * Chain detection is a TypeScript port of ai-testing-agent's `chain_detector.py` and the id/token
 * threading of `chain_test_generator.py` (MIT, Copyright (c) 2026 dannicolau7,
 * https://github.com/dannicolau7/ai-testing-agent): resource naming, consumer detection
 * (`/things` → `/things/{thingId}`), CRUD chains ordered GET → PUT → PATCH → DELETE, login → secured
 * endpoint chains (≤2 per login endpoint, GET / short paths first), nested-resource chains, id and
 * token fields read from 2xx response schemas, and the "GET returns the created id" round-trip check.
 * Differences: chains are emitted as canonical specs (request `extract` + `{{var}}`) instead of pytest
 * source; a safe list → detail chain is added; generic `{id}` path params, wrapped responses
 * ({ data: { id } }, { items: [...] }), `<resource>Id` fields and creator paths that themselves
 * contain captured ids are handled; refresh tokens are never used as bearer tokens.
 *
 * SAFETY: list → detail only issues GETs and is always generated. Chains that create, update or
 * delete data (and login chains, which POST) are generated only when `allowMutating` is enabled.
 */
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import { freshAccountSteps, referenceIds, signUpOf, type DraftSpec } from "./test-specs.js";
import { backendOpsChains } from "./backend-ops.js";

export interface WorkflowGenOptions {
    allowMutating: boolean;
    maxWorkflows: number;
}

export interface WorkflowGenResult {
    specs: DraftSpec[];
    skippedMutating: number;
}

type Schema = Record<string, any>;
type RequestStep = Extract<Step, { action: "request" }>;
type Method = RequestStep["method"];

const CATEGORY = "API · Workflows";
// chain_detector.py `_AUTH_PATH`
export const AUTH_PATH = /\/(auth|login|signin|sign-in|token|oauth|session)(\/|$)/i;
// chain_detector.py `_TOKEN_FIELDS`, ordered, minus refresh tokens (not valid as a bearer credential).
const TOKEN_FIELDS = ["access_token", "accessToken", "token", "jwt", "id_token", "idToken"];
/** Path params that name "the id" without saying of what — chain_detector.py rejected these. */
const GENERIC_PARAMS = new Set(["id", "uuid", "slug", "key"]);
/** Common envelope properties around the real payload. */
const WRAPPERS = ["data", "item", "result", "results", "items", "records", "content", "payload", "rows"];

export interface Chain {
    name: string;
    mutating: boolean;
    spec: DraftSpec;
}

// ── Resource naming (chain_detector.py helpers) ─────────────────────────────

function singular(word: string): string {
    const w = word.toLowerCase();
    if (w.endsWith("ies") && w.length > 3) return w.slice(0, -3) + "y";
    if (/(sh|ch|x|z|ss)es$/.test(w)) return w.slice(0, -2);
    if (/(ss|us|is)$/.test(w)) return w;
    return w.endsWith("s") && w.length > 1 ? w.slice(0, -1) : w;
}

/** `_resource_name`: /api/v1/users → user, /pets/{petId} → pet. */
export function resourceName(path: string): string {
    const parts = path.split("/").filter((p) => p && !p.includes("{"));
    return parts.length ? singular(parts[parts.length - 1]!) : "resource";
}

/** `_strip_id_suffix`: petId → pet, user_id → user. */
export function stripIdSuffix(param: string): string {
    for (const suffix of ["_id", "Id", "ID", "_uuid", "Uuid", "UUID"]) {
        if (param.endsWith(suffix) && param.length > suffix.length) return param.slice(0, -suffix.length).toLowerCase();
    }
    return param.toLowerCase();
}

/** `_find_consumers` relation test (3-char prefix), extended to accept generic {id}-style params. */
function relates(param: string, resource: string): boolean {
    if (GENERIC_PARAMS.has(param.toLowerCase())) return true;
    const n = stripIdSuffix(param);
    return n.startsWith(resource.slice(0, 3)) || resource.startsWith(n.slice(0, 3));
}

/** `_find_creator_for_resource` relation: shared 3-char prefix either way. */
function sameResource(a: string, b: string): boolean {
    return a.startsWith(b.slice(0, 3)) || b.startsWith(a.slice(0, 3));
}

function camel(s: string): string {
    const parts = s.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase())).join("") || "item";
}

export const varFor = (resource: string) => `${camel(resource)}Id`;
const pathParams = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
export const trimSlash = (p: string) => p.replace(/\/+$/, "");
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// ── Schema inspection (`_get_id_field` / `_get_token_field`) ─────────────────

/** 2xx response schemas, 200/201 first (chain_detector only looked at those two). */
export function okSchemas(ep: ApiEndpointModel): Schema[] {
    if (ep.spec) {
        return ep.spec.responses
            .filter((r) => /^2/.test(r.status) && r.schema)
            .sort((a, b) => Number(!["200", "201"].includes(a.status)) - Number(!["200", "201"].includes(b.status)))
            .map((r) => r.schema as Schema);
    }
    return ep.responseSchema ? [ep.responseSchema as Schema] : [];
}

export function propsOf(schema: Schema | undefined): Record<string, Schema> {
    if (!schema || typeof schema !== "object") return {};
    const out: Record<string, Schema> = { ...(schema.properties ?? {}) };
    for (const part of schema.allOf ?? []) Object.assign(out, part?.properties ?? {});
    return out;
}

/** Pick the id property of a resource: id, <resource>Id, <resource>_id, the path param name, uuid, slug. */
function idFieldIn(props: Record<string, Schema>, resource: string, hint?: string): string | undefined {
    const r = camel(resource);
    const candidates = ["id", `${r}Id`, `${resource}_id`, `${r}ID`, ...(hint && !GENERIC_PARAMS.has(hint) ? [hint] : []), "uuid", "slug", `${r}Uuid`];
    const hit = candidates.find((c) => c in props);
    if (hit) return hit;
    // Last resort: any fooId / foo_id whose prefix names this resource.
    return Object.keys(props).find((k) => /(Id|_id|ID)$/.test(k) && relates(k, resource));
}

/** Dot path to the id of a single-resource response (top level or inside one envelope). */
export function idPathIn(schema: Schema | undefined, resource: string, hint?: string): string | undefined {
    const props = propsOf(schema);
    const direct = idFieldIn(props, resource, hint);
    if (direct) return direct;
    for (const w of WRAPPERS) {
        const inner = props[w];
        if (inner?.type === "object" || inner?.properties) {
            const f = idFieldIn(propsOf(inner), resource, hint);
            if (f) return `${w}.${f}`;
        }
    }
    return undefined;
}

/** Dot path to the id of the FIRST item of a collection response: `0.id` or `items.0.id`. */
export function listItemIdPath(schema: Schema | undefined, resource: string, hint?: string): string | undefined {
    if (!schema) return undefined;
    if (schema.type === "array" || schema.items) {
        const f = idPathIn(schema.items as Schema | undefined, resource, hint);
        return f ? `0.${f}` : undefined;
    }
    const props = propsOf(schema);
    const arrays = Object.keys(props).filter((k) => props[k]?.type === "array" || props[k]?.items);
    arrays.sort((a, b) => Number(!WRAPPERS.includes(a)) - Number(!WRAPPERS.includes(b)));
    for (const k of arrays) {
        const f = idPathIn(props[k]!.items as Schema | undefined, resource, hint);
        if (f) return `${k}.0.${f}`;
    }
    return undefined;
}

function tokenPathIn(schema: Schema | undefined): string | undefined {
    const props = propsOf(schema);
    const direct = TOKEN_FIELDS.find((f) => f in props);
    if (direct) return direct;
    for (const w of WRAPPERS) {
        const inner = propsOf(props[w]);
        const f = TOKEN_FIELDS.find((t) => t in inner);
        if (f) return `${w}.${f}`;
    }
    return undefined;
}

const first = <T>(xs: Schema[], fn: (s: Schema) => T | undefined): T | undefined => {
    for (const s of xs) {
        const v = fn(s);
        if (v !== undefined) return v;
    }
    return undefined;
};

// ── Request data ─────────────────────────────────────────────────────────────

/** Known concrete values for path params: OpenAPI example/enum, or aligned from an observed URL. */
function paramValues(ep: ApiEndpointModel): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of ep.spec?.parameters ?? []) {
        if (p.location !== "path") continue;
        const v = p.example ?? p.enum?.[0];
        if (v !== undefined) out[p.name] = String(v);
    }
    if (ep.examplePath) {
        const tpl = ep.path.split("/");
        const real = ep.examplePath.split("?")[0]!.split("/");
        if (tpl.length === real.length) {
            tpl.forEach((seg, i) => {
                const m = /^\{([^}]+)\}$/.exec(seg);
                if (m && real[i] && !(m[1]! in out)) out[m[1]!] = decodeURIComponent(real[i]!);
            });
        }
    }
    return out;
}

function fillPath(path: string, values: Record<string, string>): string | null {
    let ok = true;
    const out = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const v = values[name];
        if (v === undefined) ok = false;
        return v ?? "";
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

const USERNAME_FIELD = /^(email|e-?mail|username|user_?name|user|login)$/i;
const PASSWORD_FIELD = /^(password|pass|passwd|pwd)$/i;

/**
 * Example value for a body field — schema first, then chain_test_generator.py `_example_value`
 * name heuristics (email, password, name, tag, url, phone). Values carry {{unique}} where a server
 * might enforce uniqueness, so repeated runs do not collide.
 */
function sample(schema: Schema | undefined, name: string, credentials: boolean, depth = 0): unknown {
    if (credentials && USERNAME_FIELD.test(name)) return "{{credentials.username}}";
    if (credentials && PASSWORD_FIELD.test(name)) return "{{credentials.password}}";
    if (!schema || depth > 4) return `${name}-{{unique}}`;
    if (schema.example !== undefined) return schema.example;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    const type = schema.type ?? (schema.properties ? "object" : schema.items ? "array" : "string");
    switch (type) {
        case "integer":
            return schema.minimum ?? 1;
        case "number":
            return schema.minimum ?? 1.5;
        case "boolean":
            return true;
        case "array":
            return [sample(schema.items, name, credentials, depth + 1)];
        case "object": {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(propsOf(schema))) {
                // Server-assigned fields (id, createdAt...) do not belong in a create/update body.
                if (v?.readOnly) continue;
                out[k] = sample(v, k, credentials, depth + 1);
            }
            return out;
        }
        default: {
            const n = name.toLowerCase();
            if (schema.format === "email" || n.includes("email")) return "qa+{{unique}}@example.com";
            if (n.includes("password") || n.includes("pass")) return "Pa55word-{{unique}}";
            if (schema.format === "date-time") return "2030-01-01T00:00:00Z";
            if (schema.format === "date") return "2030-01-01";
            if (schema.format === "uuid") return "123e4567-e89b-12d3-a456-426614174000";
            if (schema.format === "uri" || n.includes("url")) return "https://example.com";
            if (n.includes("phone")) return "+15550000001";
            if (n.includes("tag")) return "test";
            if (n.includes("name")) return `Test ${name} {{unique}}`;
            return `test-${name}-{{unique}}`;
        }
    }
}

function bodyFor(ep: ApiEndpointModel, credentials = false): unknown {
    const schema = ep.spec?.requestBody?.schema as Schema | undefined;
    if (schema) return sample(schema, "body", credentials);
    const observed = ep.sampleRequestBody;
    if (credentials && observed && typeof observed === "object" && !Array.isArray(observed)) {
        // Observed login bodies are redacted; swap the credential fields for the configured ones.
        return Object.fromEntries(
            Object.entries(observed as Record<string, unknown>).map(([k, v]) => [k, USERNAME_FIELD.test(k) || PASSWORD_FIELD.test(k) ? sample(undefined, k, true) : v]),
        );
    }
    return observed;
}

const hasBody = (m: string) => m === "POST" || m === "PUT" || m === "PATCH";

// ── Read-back (C9) helpers ───────────────────────────────────────────────────

const SIGN_UP = /\/(?:register|sign-?up)(?:\/|$)/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The same values with a different {{unique}} ("{{unique}}w"), so a second write is told apart from the first one. */
export function marked(body: unknown, mark: string): unknown {
    return body === undefined ? undefined : JSON.parse(JSON.stringify(body).replaceAll("{{unique}}", `{{unique}}${mark}`));
}

/** A write's body with real ids for its reference fields (productId from GET /products), and the steps that take them. */
export function writeBody(ep: ApiEndpointModel, endpoints: ApiEndpointModel[], mark = ""): { before: Step[]; body: unknown } {
    const body = marked(bodyFor(ep), mark);
    const props = propsOf(ep.spec?.requestBody?.schema as Schema | undefined);
    const refs = referenceIds(props, endpoints).filter((r): r is { field: string; step: Step } => r.step !== undefined);
    if (!refs.length || !body || typeof body !== "object") return { before: [], body };
    return { before: refs.map((r) => r.step), body: { ...(body as object), ...Object.fromEntries(refs.map((r) => [r.field, `{{${r.field}}}`])) } };
}

/**
 * What a write needs first, as its documented refusals say ("Cart empty or no address"): for each word of a 4xx answer that names
 * another documented POST (cart → POST /cart/items, address → POST /checkout/address), that write, sent with a documented or observed
 * body. At most 3, in the order the words come.
 */
export function setupFor(target: ApiEndpointModel, endpoints: ApiEndpointModel[]): Step[] {
    const refusals = (target.spec?.responses ?? []).filter((r) => /^4/.test(r.status)).map((r) => r.description ?? "").join(" ");
    const words = [...new Set((refusals.toLowerCase().match(/[a-z]+/g) ?? []).map(singular))];
    const segs = (e: ApiEndpointModel) => trimSlash(e.path).split("/").filter(Boolean).map(singular);
    const steps: Step[] = [];
    const used = new Set<ApiEndpointModel>();
    for (const w of words) {
        if (used.size >= 3) break;
        const candidates = endpoints.filter(
            (e) => e.method === "POST" && e !== target && !used.has(e) && !e.path.includes("{") && !AUTH_PATH.test(e.path) && !SIGN_UP.test(e.path) && segs(e).includes(w) && bodyFor(e) !== undefined,
        );
        // The write the word names most directly: its last path part, then one with a documented body.
        candidates.sort((a, b) => Number(segs(b).at(-1) === w) - Number(segs(a).at(-1) === w) || Number(Boolean(b.spec?.requestBody)) - Number(Boolean(a.spec?.requestBody)));
        const pick = candidates[0];
        if (!pick) continue;
        used.add(pick);
        const { before, body } = writeBody(pick, endpoints);
        steps.push(...before, req("POST", trimSlash(pick.path), { query: queryFor(pick), body }, `Set up what the write needs: POST ${pick.path}`), resp("statusClass", "2xx", undefined, `POST ${pick.path} is accepted`));
    }
    return steps;
}

const PASSWORDISH = /pass|secret|token/i;

/** One check per written scalar field the read answer documents: the read returns what was written. */
export function writtenChecks(body: unknown, read: ApiEndpointModel, what: string): Step[] {
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    const props = first(okSchemas(read), (s) => (Object.keys(propsOf(s)).length ? propsOf(s) : undefined)) ?? {};
    return Object.entries(body as Record<string, unknown>)
        .filter(([k, v]) => k in props && !props[k]!.writeOnly && !PASSWORDISH.test(k) && ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => resp("jsonPath", v as string | number | boolean, k, `${what} returns the written ${k}`));
}

/** "orders.0.id" → "orders[*].id": the ids of every listed record, as a relation path; undefined if a part is not a plain name. */
function listIdsPath(itemPath: string): string | undefined {
    const parts = itemPath.split(".");
    const i = parts.indexOf("0");
    if (i < 0 || parts.some((p, j) => j !== i && !NAME.test(p))) return undefined;
    return parts.map((p, j) => (j === i ? "[*]" : j ? `.${p}` : p)).join("");
}

// ── Spec builders ────────────────────────────────────────────────────────────

export const req = (method: string, path: string, extra: Partial<RequestStep>, description: string): Step => ({
    action: "request",
    method: method as Method,
    path,
    auth: "default",
    description,
    ...extra,
});
export const resp = (check: Extract<Step, { action: "assertResponse" }>["check"], expected: string | number | boolean | undefined, path: string | undefined, description: string): Step => ({
    action: "assertResponse",
    check,
    expected,
    path,
    description,
});

function originOf(eps: ApiEndpointModel[]): NonNullable<TestSpec["source"]>["origin"] {
    if (eps.every((e) => e.source === "openapi")) return "openapi";
    if (eps.every((e) => e.source === "documentation")) return "documentation";
    return "network";
}

export function draft(
    eps: ApiEndpointModel[],
    title: string,
    description: string,
    priority: TestSpec["priority"],
    preconditions: string[],
    steps: Step[],
    expected: string[],
    tags: string[],
): DraftSpec {
    return {
        title,
        description,
        kind: "api",
        category: CATEGORY,
        type: "workflow",
        priority,
        preconditions: [...preconditions, ...(eps.some((e) => e.requiresAuth) ? ["A valid API credential is configured (API_TOKEN)"] : [])],
        steps,
        expectedResults: expected,
        testData: {},
        tags: ["api", "workflow", ...tags],
        source: { origin: originOf(eps) },
    };
}

/** GET /things/{param} consumer of a collection path — `_find_consumers` for one method. */
function consumersOf(base: string, resource: string, endpoints: ApiEndpointModel[]): Array<{ ep: ApiEndpointModel; param: string }> {
    const out: Array<{ ep: ApiEndpointModel; param: string }> = [];
    for (const ep of endpoints) {
        const p = trimSlash(ep.path);
        if (!p.startsWith(base + "/")) continue;
        const m = /^\/\{([^/}]+)\}$/.exec(p.slice(base.length));
        if (m && relates(m[1]!, resource)) out.push({ ep, param: m[1]! });
    }
    return out;
}

/** SAFE: GET /things → capture first id → GET /things/{id} → same id comes back. */
function listDetailChains(endpoints: ApiEndpointModel[]): Chain[] {
    const chains: Chain[] = [];
    for (const list of endpoints) {
        if (list.method !== "GET" || /\}\/?$/.test(list.path)) continue;
        const base = trimSlash(list.path);
        const resource = resourceName(base);
        const detail = consumersOf(base, resource, endpoints).find((c) => c.ep.method === "GET");
        if (!detail) continue;
        const itemPath = first(okSchemas(list), (s) => listItemIdPath(s, resource, detail.param));
        if (!itemPath) continue;
        const values = { ...paramValues(detail.ep), ...paramValues(list) };
        const listPath = fillPath(list.path, values);
        const v = varFor(resource);
        const detailPath = fillPath(detail.ep.path, { ...values, [detail.param]: `{{${v}}}` });
        if (!listPath || !detailPath) continue;

        const idField = itemPath.split(".").pop()!;
        const detailSchemas = okSchemas(detail.ep);
        // Only assert the round-trip when the detail schema exposes the same id field.
        const found = first(detailSchemas, (s) => idPathIn(s, resource, detail.param));
        const detailIdPath = found && found.split(".").pop() === idField ? found : undefined;
        const steps: Step[] = [
            req("GET", listPath, { query: queryFor(list), extract: { [v]: itemPath } }, `List ${resource} items and capture the first ${idField} as {{${v}}}`),
            resp("statusClass", "2xx", undefined, "List request succeeds"),
            req("GET", detailPath, { query: queryFor(detail.ep) }, `Fetch the captured ${resource} by ${detail.param}`),
            resp("statusClass", "2xx", undefined, "Detail request succeeds"),
        ];
        if (detailSchemas[0]?.type === "object") steps.push(resp("jsonType", "object", undefined, "Detail is a JSON object"));
        if (detailIdPath) steps.push(resp("jsonPath", `{{${v}}}`, detailIdPath, `Detail returns the same ${resource} that was listed`));
        chains.push({
            name: `list_detail_${slug(base)}`,
            mutating: false,
            spec: draft(
                [list, detail.ep],
                `Workflow: list → detail (GET ${list.path} → GET ${detail.ep.path})`,
                `Picks the first ${resource} from the collection and reads it back by its ${idField}.`,
                "high",
                [`${list.path} returns at least one ${resource}`],
                steps,
                [`The listed ${resource} can be fetched individually and has the same ${idField}`],
                ["list-detail"],
            ),
        });
    }
    return chains;
}

/**
 * MUTATING: `_detect_crud_chains` — POST → GET → PUT/PATCH → DELETE → GET expects 4xx, with C9 read-back (Phase 4): on a fresh account
 * where the application has a sign-up, after what the create's refusals say it needs; the read returns the written fields; a second
 * create, then the list holds both new ids (so a list that drops its newest record is caught); after the update, the read returns the
 * updated fields.
 */
function crudChains(endpoints: ApiEndpointModel[]): Chain[] {
    const chains: Chain[] = [];
    const order: Record<string, number> = { GET: 0, PUT: 1, PATCH: 2, DELETE: 3 };
    const signUp = signUpOf(endpoints);
    for (const creator of endpoints) {
        if (creator.method !== "POST") continue;
        const base = trimSlash(creator.path);
        const resource = resourceName(base);
        const consumers = consumersOf(base, resource, endpoints)
            .filter((c) => c.ep.method in order)
            .sort((a, b) => order[a.ep.method]! - order[b.ep.method]!);
        if (!consumers.length) continue;
        const idPath = first(okSchemas(creator), (s) => idPathIn(s, resource, consumers[0]!.param));
        if (!idPath) continue;
        const values = paramValues(creator);
        const createPath = fillPath(creator.path, values);
        if (!createPath) continue;
        const v = varFor(resource);
        const idField = idPath.split(".").pop()!;
        const byMethod = (m: string) => consumers.find((c) => c.ep.method === m);
        const pathOf = (c: { ep: ApiEndpointModel; param: string }) => fillPath(c.ep.path, { ...values, [c.param]: `{{${v}}}` });
        const read = byMethod("GET");
        const update = byMethod("PUT") ?? byMethod("PATCH");
        const del = byMethod("DELETE");
        const setup = setupFor(creator, endpoints);
        const create = (mark: string, into: string): Step[] => {
            const { before, body } = writeBody(creator, endpoints, mark);
            return [
                ...setup,
                ...before,
                req("POST", createPath, { query: queryFor(creator), body, extract: { [into]: idPath } }, `Create a ${resource} and capture its ${idField} as {{${into}}}`),
                resp("statusClass", "2xx", undefined, `${resource} is created`),
            ];
        };

        const steps: Step[] = [...(signUp && creator !== signUp ? freshAccountSteps(endpoints) : []), ...create("", v)];
        const used = [creator];
        const readPath = read && pathOf(read);
        if (read && readPath) {
            used.push(read.ep);
            const readIdPath = first(okSchemas(read.ep), (s) => idPathIn(s, resource, read.param));
            steps.push(req("GET", readPath, { query: queryFor(read.ep) }, `Read the created ${resource}`), resp("statusClass", "2xx", undefined, `Created ${resource} is readable`));
            // chain_test_generator.py round-trip: the GET returns the id we created.
            if (readIdPath) steps.push(resp("jsonPath", `{{${v}}}`, readIdPath, `Read returns the created ${resource}`));
            steps.push(...writtenChecks(writeBody(creator, endpoints).body, read.ep, "The read"));
        }
        // C9: the collection lists every new record. Two are created, so a list that drops its newest record is caught too.
        // shortcut: a string id made only of digits reads as a number in a relation and would not match; such lists need a text compare.
        const list = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === base);
        const listItem = list && first(okSchemas(list), (s) => listItemIdPath(s, resource, consumers[0]!.param));
        const ids = listItem && listIdsPath(listItem);
        if (list && ids) {
            const v2 = `${v}2`;
            steps.push(
                ...create("b", v2),
                req("GET", base, { query: queryFor(list) }, `List ${resource} items`),
                resp("statusClass", "2xx", undefined, "List request succeeds"),
                { action: "assertResponse", check: "relation", expression: `contains(${ids}, $${v}) and contains(${ids}, $${v2})`, description: `The list holds both new ${resource} records` },
            );
        }
        const updatePath = update && pathOf(update);
        if (update && updatePath) {
            used.push(update.ep);
            // An update that documents no body of its own takes the create's fields (a bodiless PUT is refused by any app that validates it).
            const body = marked(bodyFor(update.ep) ?? bodyFor(creator), "u");
            steps.push(
                req(update.ep.method, updatePath, { query: queryFor(update.ep), ...(body !== undefined ? { body } : {}) }, `Update the created ${resource}`),
                resp("statusClass", "2xx", undefined, `${resource} is updated`),
            );
            const back = read && readPath ? writtenChecks(body, read.ep, "The read after the update") : [];
            if (back.length) steps.push(req("GET", readPath!, { query: queryFor(read!.ep) }, `Read the updated ${resource} back`), resp("statusClass", "2xx", undefined, `Updated ${resource} is readable`), ...back);
        }
        const delPath = del && pathOf(del);
        if (del && delPath) {
            used.push(del.ep);
            steps.push(req("DELETE", delPath, { query: queryFor(del.ep) }, `Delete the created ${resource}`), resp("statusClass", "2xx", undefined, `${resource} is deleted`));
            if (read && readPath) {
                steps.push(req("GET", readPath, { query: queryFor(read.ep) }, `Read the deleted ${resource} again`), resp("statusClass", "4xx", undefined, `Deleted ${resource} is no longer found`));
            }
        }
        if (used.length < 2) continue;
        const methods = used.map((e) => e.method).concat(del && read && readPath ? ["GET"] : []);
        chains.push({
            name: `crud_${slug(base)}`,
            mutating: true,
            spec: draft(
                used,
                `Workflow: ${resource} lifecycle (${methods.join(" → ")} ${creator.path})`,
                `CRUD chain for ${resource}: ${methods.join(" → ")}; the id returned by the create call is reused by every later request.`,
                "high",
                ["Mutating API tests are allowed — this test creates" + (del ? " and deletes" : "") + " data"],
                steps,
                [`A created ${resource} can be read${update ? ", updated" : ""}${del ? " and deleted, and is gone afterwards" : ""}`],
                ["crud", "mutating", "readback"],
            ),
        });
    }
    return chains;
}

/** MUTATING, C9: PUT/PATCH a record that has a GET at the same path (/profile), then read it back: the written fields are stored. */
function writeReadChains(endpoints: ApiEndpointModel[]): Chain[] {
    const chains: Chain[] = [];
    const signUp = signUpOf(endpoints);
    for (const ep of endpoints) {
        if (ep.method !== "PUT" && ep.method !== "PATCH") continue;
        const read = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === trimSlash(ep.path));
        const path = read && fillPath(ep.path, { ...paramValues(read), ...paramValues(ep) });
        if (!read || !path) continue;
        const { before, body } = writeBody(ep, endpoints, "w");
        const back = writtenChecks(body, read, "The read");
        if (!back.length) continue;
        chains.push({
            name: `readback_${slug(ep.method + "_" + ep.path)}`,
            mutating: true,
            spec: draft(
                [ep, read],
                `Workflow: what is written is read back (${ep.method} ${ep.path} → GET ${read.path})`,
                `Writes new values with ${ep.method} ${ep.path} and reads ${read.path} back: the read returns what was written.`,
                "high",
                ["Mutating API tests are allowed — this test changes data"],
                [
                    ...(signUp ? freshAccountSteps(endpoints) : []),
                    ...setupFor(ep, endpoints),
                    ...before,
                    req(ep.method, path, { query: queryFor(ep), body }, `Write new values with ${ep.method}`),
                    resp("statusClass", "2xx", undefined, "The write is accepted"),
                    req("GET", path, { query: queryFor(read) }, "Read the same record back"),
                    resp("statusClass", "2xx", undefined, "The read succeeds"),
                    ...back,
                ],
                ["The written values are stored: the read returns them"],
                ["readback", "mutating"],
            ),
        });
    }
    return chains;
}

/** MUTATING (POSTs credentials): `_detect_auth_chains` — login → capture token → secured call with it. */
function authChains(endpoints: ApiEndpointModel[]): Chain[] {
    const chains: Chain[] = [];
    const logins = endpoints.filter((e) => e.method === "POST" && AUTH_PATH.test(e.path) && first(okSchemas(e), tokenPathIn));
    const protectedEps = endpoints
        .filter((e) => (e.requiresAuth || (e.spec?.security.length ?? 0) > 0) && ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(e.method) && !AUTH_PATH.test(e.path))
        .sort((a, b) => Number(a.method !== "GET") - Number(b.method !== "GET") || a.path.length - b.path.length);
    for (const login of logins) {
        const tokenPath = first(okSchemas(login), tokenPathIn)!;
        const loginPath = fillPath(login.path, paramValues(login));
        const body = bodyFor(login, true);
        if (!loginPath || body === undefined) continue;
        let made = 0;
        for (const target of protectedEps) {
            if (made >= 2) break; // chain_detector caps at 2 chains per auth endpoint
            const targetPath = fillPath(target.path, paramValues(target));
            if (!targetPath) continue;
            const targetBody = hasBody(target.method) ? bodyFor(target) : undefined;
            made++;
            chains.push({
                name: `auth_${slug(login.path)}_then_${slug(target.method + "_" + target.path)}`,
                mutating: true,
                spec: draft(
                    [login, target],
                    `Workflow: log in, then call a secured endpoint (POST ${login.path} → ${target.method} ${target.path})`,
                    `Logs in with the configured test account, captures the token from "${tokenPath}" and sends it as a Bearer credential.`,
                    "critical",
                    ["TEST_USERNAME / TEST_PASSWORD hold a valid account"],
                    [
                        req("POST", loginPath, { auth: "none", body, extract: { token: tokenPath } }, "Log in and capture the access token as {{token}}"),
                        resp("statusClass", "2xx", undefined, "Login succeeds"),
                        req(
                            target.method,
                            targetPath,
                            { auth: "none", query: queryFor(target), headers: { Authorization: "Bearer {{token}}" }, ...(targetBody !== undefined ? { body: targetBody } : {}) },
                            "Call the secured endpoint with the captured token only",
                        ),
                        resp("statusClass", "2xx", undefined, "Token is accepted"),
                    ],
                    ["The token issued by the login endpoint grants access to the secured endpoint"],
                    ["auth", "mutating"],
                ),
            });
        }
    }
    return chains;
}

/** MUTATING: `_detect_nested_chains` — create every parent, then call the nested endpoint with all ids. */
function nestedChains(endpoints: ApiEndpointModel[]): Chain[] {
    const chains: Chain[] = [];
    for (const ep of endpoints) {
        const params = pathParams(ep.path);
        if (params.length < 2) continue;
        const segs = ep.path.split("/");
        const steps: Step[] = [];
        const used: ApiEndpointModel[] = [];
        const vars: Record<string, string> = {};
        let ok = true;
        for (const param of params) {
            // Generic {id}: name the resource after the collection segment just before it.
            const idx = segs.indexOf(`{${param}}`);
            const resource = GENERIC_PARAMS.has(param.toLowerCase()) ? resourceName(segs.slice(0, idx).join("/")) : stripIdSuffix(param);
            // The creator's own path params must already be captured (e.g. POST /users/{userId}/posts).
            const creator = endpoints.find(
                (c) => c.method === "POST" && c !== ep && !/\}\/?$/.test(c.path) && sameResource(resourceName(c.path), resource) &&
                    pathParams(c.path).every((p) => p in vars) && first(okSchemas(c), (s) => idPathIn(s, resource, param)),
            );
            if (!creator) {
                ok = false;
                break;
            }
            const idPath = first(okSchemas(creator), (s) => idPathIn(s, resource, param))!;
            const v = Object.values(vars).includes(varFor(resource)) ? `${varFor(resource)}${params.indexOf(param)}` : varFor(resource);
            const creatorPath = fillPath(creator.path, Object.fromEntries(Object.entries(vars).map(([p, name]) => [p, `{{${name}}}`])));
            if (!creatorPath) {
                ok = false;
                break;
            }
            steps.push(
                req("POST", creatorPath, { query: queryFor(creator), body: bodyFor(creator), extract: { [v]: idPath } }, `Create a ${resource} and capture its id as {{${v}}}`),
                resp("statusClass", "2xx", undefined, `${resource} is created`),
            );
            used.push(creator);
            vars[param] = v;
        }
        if (!ok || used.length < 2) continue;
        const finalPath = fillPath(ep.path, Object.fromEntries(Object.entries(vars).map(([p, name]) => [p, `{{${name}}}`])))!;
        const body = hasBody(ep.method) ? bodyFor(ep) : undefined;
        steps.push(
            req(ep.method, finalPath, { query: queryFor(ep), ...(body !== undefined ? { body } : {}) }, `${ep.method} the nested resource using the captured ids`),
            resp("statusClass", "2xx", undefined, "Nested request succeeds"),
        );
        const lastParam = params[params.length - 1]!;
        const finalIdPath = ep.method === "GET" ? first(okSchemas(ep), (s) => idPathIn(s, resourceName(ep.path), lastParam)) : undefined;
        if (finalIdPath) steps.push(resp("jsonPath", `{{${vars[lastParam]}}}`, finalIdPath, "Nested resource is the one that was created"));
        chains.push({
            name: `nested_${slug(ep.method + "_" + ep.path)}`,
            mutating: true,
            spec: draft(
                [...used, ep],
                `Workflow: nested resources (${used.map((u) => `POST ${u.path}`).join(" → ")} → ${ep.method} ${ep.path})`,
                `Creates each parent resource, threading the captured ids into ${ep.method} ${ep.path}.`,
                "medium",
                ["Mutating API tests are allowed — this test creates data"],
                steps,
                ["Nested resources can be addressed with the ids returned when their parents were created"],
                ["nested", "mutating"],
            ),
        });
    }
    return chains;
}

/**
 * Detect multi-request workflows across `endpoints` and turn them into canonical API specs.
 * Safe list → detail chains come first; mutating chains are counted in `skippedMutating` instead
 * of being generated unless `opts.allowMutating`.
 */
export function generateApiWorkflowSpecs(endpoints: ApiEndpointModel[], opts: WorkflowGenOptions): WorkflowGenResult {
    const all = [...listDetailChains(endpoints), ...crudChains(endpoints), ...writeReadChains(endpoints), ...backendOpsChains(endpoints), ...authChains(endpoints), ...nestedChains(endpoints)];
    // Deduplicate by name (same resource may match several heuristics) — as chain_detector does.
    const seen = new Set<string>();
    const unique = all.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
    const allowed = unique.filter((c) => !c.mutating || opts.allowMutating);
    return {
        specs: allowed.slice(0, Math.max(0, opts.maxWorkflows)).map((c) => c.spec),
        skippedMutating: unique.length - allowed.length,
    };
}
