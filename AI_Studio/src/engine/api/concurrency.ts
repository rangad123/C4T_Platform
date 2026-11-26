/**
 * C8 controlled concurrency (Phase 4 T24): writes that create or consume (a documented create endpoint, or a workflow step such as
 * pay, place or book) are sent k times at once, identically, in a saved API script (the request step's `parallel`).
 *
 * Oracle: documented uniqueness. The write documents 409, so exactly one of the k succeeds and the others are refused. Then a read-back:
 * the list holds one record more, or the record the step acted on still reads.
 *
 * Guards, all of them hard:
 *   - the gate: data changes on, and either a current client authorization, or a bench or fixture application on this computer
 *     (loopback) (Q4); without it nothing is generated and the reason is given;
 *   - k is 3 by default and at most 5;
 *   - at most 10 requests at once in one test, counted by the pasted helper before anything is sent;
 *   - at most 3 checks a run, one per endpoint (a workflow step and the create endpoint of the same record may both be checked).
 */
import type { Step } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import { freshAccountSteps, signUpOf, type DraftSpec } from "./test-specs.js";
import { draft, idPathIn, listItemIdPath, okSchemas, queryFor, req, resourceName, resp, setupFor, trimSlash, varFor, writeBody } from "./workflows.js";

export const CONCURRENCY_DEFAULT_K = 3;
export const PARALLEL_MAX = 5;
export const PARALLEL_MAX_PER_TEST = 10;
export const CONCURRENCY_MAX_CHECKS = 3;

/** Who may run C8: the bench or fixture flag (the application must answer on loopback), or a current client authorization. */
export type ConcurrencyGate = "bench" | "fixture" | "authorization";

/**
 * The pasted helper of a request step with `parallel` (plain JavaScript, so a downloaded script runs on its own). The caps are
 * constants here: a spec or an edited script text cannot ask for more. The answer it gives the checks that follow is a summary,
 * { ok, refused, failed, statuses }, for a relation such as `ok == 1 and refused == 2`.
 */
export const PARALLEL_HELPER_SOURCE = String.raw`const PARALLEL_MAX = ${PARALLEL_MAX};
const PARALLEL_MAX_PER_TEST = ${PARALLEL_MAX_PER_TEST};
let parallelSent = 0;
async function parallelCall(k, send) {
    const n = Math.floor(Number(k));
    if (!(n >= 2 && n <= PARALLEL_MAX)) throw new Error("A request is sent 2 to " + PARALLEL_MAX + " times at once, not " + k + ". Nothing was sent.");
    if (parallelSent + n > PARALLEL_MAX_PER_TEST) throw new Error("A test sends at most " + PARALLEL_MAX_PER_TEST + " requests at once in all. Nothing more was sent.");
    parallelSent += n;
    const all = await Promise.all(Array.from({ length: n }, () => send()));
    const statuses = all.map((c) => c.status);
    const json = { ok: statuses.filter((s) => s >= 200 && s < 300).length, refused: statuses.filter((s) => s >= 400 && s < 500).length, failed: statuses.filter((s) => s >= 500).length, statuses: statuses };
    const first = all.find((c) => c.status >= 200 && c.status < 300) || all[0];
    return Object.assign({}, first, { json: json, text: JSON.stringify(json) });
}
`;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The gate for a run's risky checks: a client authorization covers the authorized application's own address, so it holds only when the
 * checks' API host is that origin (an API on another host, from the job's options or the API description, is not covered).
 */
export function riskyGateFor(gate: ConcurrencyGate | undefined, appOrigin: string, apiBaseUrl: string): ConcurrencyGate | undefined {
    if (gate !== "authorization") return gate;
    try {
        return new URL(apiBaseUrl).origin === new URL(appOrigin).origin ? gate : undefined;
    } catch {
        return undefined;
    }
}

/** Whether C8 may run here, and the reason when it may not (for the layer report). */
export function concurrencyAllowed(o: { dataChanges: boolean; appUrl: string; gate?: ConcurrencyGate }): { allowed: true } | { allowed: false; reason: string } {
    if (!o.dataChanges) return { allowed: false, reason: "not checked: data changes are off" };
    if (o.gate === "authorization") return { allowed: true };
    if (o.gate === "bench" || o.gate === "fixture") {
        let host = "";
        try {
            host = new URL(o.appUrl).hostname;
        } catch {
            /* not an address: refused below */
        }
        return LOOPBACK.has(host) ? { allowed: true } : { allowed: false, reason: "not checked: a bench or fixture application must answer on this computer (loopback)" };
    }
    return { allowed: false, reason: "not checked: needs the client's authorization" };
}

const ACTION = /^(pay|place|book|reserve|purchase|redeem|checkout|claim|confirm|submit)$/i;
const documents409 = (ep: ApiEndpointModel) => ep.spec?.responses.some((r) => r.status === "409") ?? false;
const relation = (expression: string, description: string): Step => ({ action: "assertResponse", check: "relation", expression, description });

/**
 * C8 checks for these endpoints, or none with the reason when the gate is shut. Workflow steps (POST /orders/{id}/pay) come first, then
 * create endpoints (POST /orders); at most CONCURRENCY_MAX_CHECKS, k clamped to 2..PARALLEL_MAX.
 */
export function generateConcurrencySpecs(
    endpoints: ApiEndpointModel[],
    o: { dataChanges: boolean; appUrl: string; gate?: ConcurrencyGate; k?: number },
): { specs: DraftSpec[]; refused?: string } {
    const gate = concurrencyAllowed(o);
    if (!gate.allowed) return { specs: [], refused: gate.reason };
    const k = Math.max(2, Math.min(PARALLEL_MAX, Math.floor(o.k ?? CONCURRENCY_DEFAULT_K)));
    const fresh = signUpOf(endpoints) ? freshAccountSteps(endpoints) : [];
    const specs: DraftSpec[] = [];
    /** The k-at-once request's options: the endpoint's own body, the same for every copy. */
    const once = (ep: ApiEndpointModel, body: unknown) => ({ query: queryFor(ep), parallel: k, ...(body !== undefined ? { body } : {}) });
    const uniqueness = relation(`ok == 1 and refused == ${k - 1}`, `One of the ${k} succeeds; the others are refused (409 is documented)`);

    // Workflow steps on a record: create the record first, then send the step k times at once.
    for (const ep of endpoints) {
        const m = /^(.*)\/\{([^}/]+)\}\/([A-Za-z-]+)$/.exec(trimSlash(ep.path));
        if (specs.length >= CONCURRENCY_MAX_CHECKS || ep.method !== "POST" || !m || m[1]!.includes("{") || !ACTION.test(m[3]!) || !documents409(ep)) continue;
        const base = m[1]!;
        const resource = resourceName(base);
        const creator = endpoints.find((e) => e.method === "POST" && trimSlash(e.path) === base);
        const idPath = creator && okSchemas(creator).map((s) => idPathIn(s, resource, m[2])).find(Boolean);
        if (!creator || !idPath) continue;
        const v = varFor(resource);
        const { before, body } = writeBody(creator, endpoints);
        const action = writeBody(ep, endpoints);
        const detail = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === `${base}/{${m[2]}}`);
        const path = `${base}/{{${v}}}/${m[3]}`;
        specs.push(
            draft(
                [creator, ep, ...(detail ? [detail] : [])],
                `Concurrency: ${m[3]} sent ${k} times at once succeeds once (POST ${ep.path})`,
                `Creates a ${resource}, then sends the identical POST ${ep.path} ${k} times at the same moment: one succeeds and the others get the documented 409.`,
                "critical",
                ["Mutating API tests are allowed", "A bench or fixture application, or the client's current authorization (concurrency checks)"],
                [
                    ...fresh,
                    ...setupFor(creator, endpoints),
                    ...before,
                    ...action.before,
                    req("POST", base, { query: queryFor(creator), ...(body !== undefined ? { body } : {}), extract: { [v]: idPath } }, `Create a ${resource} and capture its id as {{${v}}}`),
                    resp("statusClass", "2xx", undefined, `${resource} is created`),
                    req("POST", path, once(ep, action.body), `Send POST ${ep.path} ${k} times at once`),
                    uniqueness,
                    ...(detail ? [req("GET", `${base}/{{${v}}}`, { query: queryFor(detail) }, `Read the ${resource} back`), resp("statusClass", "2xx", undefined, `The ${resource} still reads`)] : []),
                ],
                [`Exactly one of ${k} identical POST ${ep.path} sent at once succeeds`],
                ["concurrency", "mutating"],
            ),
        );
    }

    // Create endpoints: k identical creates at once make one record.
    for (const ep of endpoints) {
        if (specs.length >= CONCURRENCY_MAX_CHECKS) break;
        const base = trimSlash(ep.path);
        if (ep.method !== "POST" || base.includes("{") || !documents409(ep) || signUpOf([ep]) === ep || /\/(auth|login|signin|sign-in|token|oauth|session)(\/|$)/i.test(base)) continue;
        const resource = resourceName(base);
        const list = endpoints.find((e) => e.method === "GET" && trimSlash(e.path) === base);
        const item = list && listItemIdPath(okSchemas(list)[0], resource);
        const parts = item?.split(".") ?? [];
        const at = parts.indexOf("0");
        if (!list || at < 0 || parts.slice(0, at).some((p) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) continue;
        const listPath = parts.slice(0, at).join(".");
        const { before, body } = writeBody(ep, endpoints);
        specs.push(
            draft(
                [ep, list],
                `Concurrency: ${k} identical creates at once make one record (POST ${ep.path})`,
                `Sends the identical POST ${ep.path} ${k} times at the same moment: one succeeds, the others get the documented 409, and GET ${list.path} holds one record more.`,
                "critical",
                ["Mutating API tests are allowed", "A bench or fixture application, or the client's current authorization (concurrency checks)"],
                [
                    ...fresh,
                    ...setupFor(ep, endpoints),
                    ...before,
                    req("GET", base, { query: queryFor(list), extract: { listBefore: listPath } }, `Read GET ${list.path} before`),
                    resp("statusClass", "2xx", undefined, "The list is readable"),
                    req("POST", base, once(ep, body), `Send POST ${ep.path} ${k} times at once`),
                    uniqueness,
                    req("GET", base, { query: queryFor(list) }, `Read GET ${list.path} after`),
                    resp("statusClass", "2xx", undefined, "The list is readable"),
                    relation(`count(${listPath || "[*]"}) == count($listBefore) + 1`, "Exactly one record was added"),
                ],
                [`Exactly one of ${k} identical POST ${ep.path} sent at once succeeds`],
                ["concurrency", "mutating"],
            ),
        );
    }
    return { specs };
}
