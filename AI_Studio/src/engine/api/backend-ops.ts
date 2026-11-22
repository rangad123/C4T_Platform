/**
 * C6 backend operations (Phase 4 T15): deterministic chains from the API document, generated only with data changes on (they are
 * mutating workflows, see generateApiWorkflowSpecs).
 *
 * Duplicate: repeat the identical write. A write that documents 409 expects it the second time; one that documents an Idempotency-Key
 * header sends the same key twice and expects the same id. Either way the list read back holds exactly one record more.
 * Transaction: a valid write first (so there is state to keep), then the same write with one documented rule broken. It must be
 * refused with the documented status, and the affected record (the write's own path or its nearest parent with a GET) reads the same
 * before and after.
 */
import type { Step } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import { freshAccountSteps, signUpOf, violations } from "./test-specs.js";
import { AUTH_PATH, draft, listItemIdPath, okSchemas, propsOf, queryFor, req, resourceName, resp, setupFor, slug, trimSlash, writeBody, type Chain } from "./workflows.js";

type Schema = Record<string, any>;
const SIGN_UP = /\/(?:register|sign-?up)(?:\/|$)/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DUPLICATES = 4;
const MAX_TRANSACTIONS = 6;
/** Fields compared before and after a refused write (one relation each). */
const MAX_FIELDS = 12;

const documents = (ep: ApiEndpointModel, status: string) => ep.spec?.responses.some((r) => r.status === status) ?? false;
const writable = (ep: ApiEndpointModel) => ["POST", "PUT", "PATCH"].includes(ep.method) && !ep.path.includes("{") && !AUTH_PATH.test(ep.path) && !SIGN_UP.test(ep.path);
const relation = (expression: string, description: string): Step => ({ action: "assertResponse", check: "relation", expression, description });

/** "orders.0.id" → the list itself as an extract path ("orders") and as a relation path; "0.id" → the whole answer ("", "[*]"). */
function listOf(itemPath: string): { extract: string; expr: string } | undefined {
    const parts = itemPath.split(".");
    const i = parts.indexOf("0");
    if (i < 0 || parts.slice(0, i).some((p) => !NAME.test(p))) return undefined;
    const extract = parts.slice(0, i).join(".");
    return { extract, expr: extract || "[*]" };
}

function duplicateChains(endpoints: ApiEndpointModel[], fresh: Step[]): Chain[] {
    const chains: Chain[] = [];
    for (const ep of endpoints) {
        if (ep.method !== "POST" || !writable(ep)) continue;
        const keyParam = ep.spec?.parameters.find((p) => p.location === "header" && /^idempotency-key$/i.test(p.name));
        if (!documents(ep, "409") && !keyParam) continue;
        const base = trimSlash(ep.path);
        const list = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === base);
        const item = list && listItemIdPath(okSchemas(list)[0], resourceName(base));
        const listed = item && listOf(item);
        if (!list || !listed) continue;
        const idField = item!.split(".").pop()!;
        const idPath = okSchemas(ep).map((s) => (propsOf(s)[idField] ? idField : undefined)).find(Boolean);
        const { before, body } = writeBody(ep, endpoints);
        const headers = keyParam ? { [keyParam.name]: "c6-{{unique}}" } : undefined;
        const write = (description: string, extract?: Record<string, string>) => req("POST", base, { query: queryFor(ep), ...(headers ? { headers } : {}), ...(body !== undefined ? { body } : {}), ...(extract ? { extract } : {}) }, description);
        const again: Step[] = documents(ep, "409")
            ? [resp("status", 409, undefined, "The repeat is refused with the documented HTTP 409")]
            : [resp("statusClass", "2xx", undefined, "The repeat is accepted (same idempotency key)"), ...(idPath ? [resp("jsonPath", "{{firstId}}", idPath, "The repeat answers with the same id")] : [])];
        chains.push({
            name: `duplicate_${slug(base)}`,
            mutating: true,
            spec: draft(
                [ep, list],
                `Backend: the same write twice makes one record (POST ${ep.path})`,
                `Sends the identical POST ${ep.path} twice; the second is ${documents(ep, "409") ? "refused as documented (409)" : "answered with the same id (idempotency key)"}, and GET ${list.path} holds one record more, not two.`,
                "high",
                ["Mutating API tests are allowed — this test creates data"],
                [
                    ...fresh,
                    ...setupFor(ep, endpoints),
                    ...before,
                    req("GET", base, { query: queryFor(list), extract: { listBefore: listed.extract } }, `Read GET ${list.path} before`),
                    resp("statusClass", "2xx", undefined, "The list is readable"),
                    write("Send the write", idPath ? { firstId: idPath } : undefined),
                    resp("statusClass", "2xx", undefined, "The first one is accepted"),
                    write("Send the identical write again"),
                    ...again,
                    req("GET", base, { query: queryFor(list) }, `Read GET ${list.path} after`),
                    resp("statusClass", "2xx", undefined, "The list is readable"),
                    relation(`count(${listed.expr}) == count($listBefore) + 1`, "Exactly one record was added"),
                ],
                ["A repeated identical write makes no second record"],
                ["backend", "duplicate", "mutating"],
            ),
        });
        if (chains.length >= MAX_DUPLICATES) break;
    }
    return chains;
}

/** One documented rule of the body broken: a constraint (max+1, minLength−1...), else a field the refusal names, sent unknown. */
function brokenBody(ep: ApiEndpointModel, body: Record<string, unknown>, status: string): { field: string; value: unknown } | undefined {
    const props = propsOf(ep.spec?.requestBody?.schema as Schema | undefined);
    for (const [field, schema] of Object.entries(props)) {
        const v = violations(schema)[0];
        if (v && field in body) return { field, value: v.value };
    }
    const said = (ep.spec?.responses.find((r) => r.status === status)?.description ?? "").toLowerCase();
    const named = Object.entries(props).find(([k, s]) => s.type === "string" && !s.enum && k in body && new RegExp(`\\b${k.toLowerCase()}\\b`).test(said));
    return named ? { field: named[0], value: `not-a-${named[0]}-{{unique}}` } : undefined;
}

function transactionChains(endpoints: ApiEndpointModel[], fresh: Step[]): Chain[] {
    const chains: Chain[] = [];
    for (const ep of endpoints) {
        if (!writable(ep) || !ep.spec?.requestBody) continue;
        const status = ["400", "422"].find((s) => documents(ep, s));
        if (!status) continue;
        // The affected record: the write's own path or its nearest parent that can be read.
        const parts = trimSlash(ep.path).split("/");
        let affected: ApiEndpointModel | undefined;
        for (let n = parts.length; n > 1 && !affected; n--) affected = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === parts.slice(0, n).join("/"));
        const fields = Object.keys(propsOf(affected ? okSchemas(affected)[0] : undefined)).filter((k) => NAME.test(k)).slice(0, MAX_FIELDS);
        const { before, body } = writeBody(ep, endpoints);
        if (!affected || !fields.length || !body || typeof body !== "object") continue;
        const broken = brokenBody(ep, body as Record<string, unknown>, status);
        if (!broken) continue;
        const path = trimSlash(ep.path);
        const read = (when: string, extract?: Record<string, string>) => [req("GET", trimSlash(affected!.path), { query: queryFor(affected!), ...(extract ? { extract } : {}) }, `Read GET ${affected!.path} ${when}`), resp("statusClass", "2xx", undefined, "The record is readable")];
        chains.push({
            name: `transaction_${slug(ep.method + "_" + ep.path)}`,
            mutating: true,
            spec: draft(
                [ep, affected],
                `Backend: a refused write changes nothing (${ep.method} ${ep.path}, "${broken.field}" broken)`,
                `After a valid ${ep.method} ${ep.path}, the same write with "${broken.field}" breaking a documented rule is refused (HTTP ${status}), and GET ${affected.path} reads exactly as before.`,
                "high",
                ["Mutating API tests are allowed — this test changes data"],
                [
                    ...fresh,
                    ...setupFor(ep, endpoints),
                    ...before,
                    req(ep.method, path, { query: queryFor(ep), body }, "A valid write first, so there is state to keep"),
                    resp("statusClass", "2xx", undefined, "The valid write is accepted"),
                    ...read("before", { recordBefore: "" }),
                    req(ep.method, path, { query: queryFor(ep), body: { ...(body as object), [broken.field]: broken.value } }, `Send it again with "${broken.field}" breaking a documented rule`),
                    resp("status", Number(status), undefined, `Refused with the documented HTTP ${status}`),
                    ...read("after"),
                    ...fields.map((f) => relation(`${f} == $recordBefore.${f}`, `"${f}" is unchanged by the refused write`)),
                ],
                [`A refused ${ep.method} ${ep.path} leaves GET ${affected.path} as it was`],
                ["backend", "transaction", "mutating"],
            ),
        });
        if (chains.length >= MAX_TRANSACTIONS) break;
    }
    return chains;
}

/** C6 chains: duplicates, then transactions; each runs on a fresh account where the application has a sign-up. */
export function backendOpsChains(endpoints: ApiEndpointModel[]): Chain[] {
    const fresh = signUpOf(endpoints) ? freshAccountSteps(endpoints) : [];
    return [...duplicateChains(endpoints, fresh), ...transactionChains(endpoints, fresh)];
}
