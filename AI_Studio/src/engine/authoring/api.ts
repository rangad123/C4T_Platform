/**
 * Plain-English test authoring, part 2: a sentence about an API call becomes a canonical API spec.
 *
 * The model only CHOOSES: which of the application's known operations the sentence is about, the values to send and what the
 * answer should contain. Everything that ends up in the spec is built here from that choice and checked against the known
 * operations, so the model can never invent an endpoint, a method or a path. Only calls that read (GET, HEAD, OPTIONS) are built
 * unless the project switched on tests that change data.
 */
import { z } from "zod";
import { fillPath, queryFor } from "../api/test-specs.js";
import type { LlmClient } from "../llm/provider.js";
import type { Step } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import { expectedOf, namesPath, PLAIN_CATEGORY, PLAIN_ORIGIN, titleOf } from "./describe.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_OPERATIONS_LISTED = 80;
const MAX_BODY_CHARS = 4000;

const Scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

export const ApiPlanSchema = z.object({
    operation: z.string().nullable().describe('One line from the list of operations, copied exactly ("GET /products/{id}"), or null if none of them fits the description'),
    explanation: z.string().max(400).describe("One plain sentence: why this operation, or why none fits"),
    pathValues: z.record(z.string(), Scalar).default({}).describe('Values for {placeholders} in the path, e.g. {"id": "1"}'),
    query: z.record(z.string(), Scalar).default({}).describe("Query parameters to send"),
    body: z.record(z.string(), z.unknown()).optional().describe("JSON body, only for operations that send data"),
    expect: z
        .object({
            status: z.number().int().min(100).max(599).optional().describe("Exact HTTP status the description expects; leave out for plain success"),
            fields: z
                .array(
                    z.object({
                        path: z.string().max(100).describe('Dot path into the JSON answer, e.g. "name" or "items.0.price"'),
                        equals: Scalar.optional().describe("Exact value the description expects, if it says one"),
                        type: z.enum(["string", "number", "boolean", "array", "object"]).optional().describe("Expected type, if the description says one"),
                    }),
                )
                .max(8)
                .default([]),
            bodyContains: z.array(z.string().max(200)).max(4).default([]).describe("Text the answer must contain"),
        })
        .default({ fields: [], bodyContains: [] }),
});
export type ApiPlan = z.infer<typeof ApiPlanSchema>;

const SYSTEM = `You turn a plain-English description of an API check into a precise plan. You are given the list of operations the application is known to have.
- Choose exactly one operation from the list, copying its first line exactly. If none fits, set operation to null and explain why in one sentence. Never invent an operation.
- Fill {placeholders} in the path with concrete values from the description, or from the examples given. Use only values the description or the list supports.
- Say what the answer should contain, using only what the description states. Do not add expectations the description does not ask for.
- Never choose an operation that changes data unless the description explicitly asks for that call.`;

/** One line per known operation, with what the model needs to fill in values. */
export function operationList(apis: ApiEndpointModel[]): string {
    return apis
        .slice(0, MAX_OPERATIONS_LISTED)
        .map((a) => {
            const params = (a.spec?.parameters ?? []).map((p) => `${p.name} (${p.location}${p.required ? ", required" : ""}${p.example !== undefined ? `, e.g. ${String(p.example)}` : ""})`);
            return `${a.method} ${a.path}${a.summary ? ` - ${a.summary.slice(0, 120)}` : ""}${params.length ? `\n    parameters: ${params.join("; ")}` : ""}`;
        })
        .join("\n");
}

export type ApiBuild =
    | { ok: true; ep: ApiEndpointModel; steps: Step[]; explanation: string }
    | { ok: false; reason: string; /** The operation the description pointed at, when it was found: shown with the kept test. */ ep?: ApiEndpointModel; steps: Step[] };

const SAFE_VALUE = /^[A-Za-z0-9_.~:@-]{1,100}$/;
const SAFE_KEY = /^[A-Za-z0-9_.\-[\]]{1,40}$/;

const req = (ep: ApiEndpointModel, path: string, extra: Partial<Extract<Step, { action: "request" }>>): Step => ({
    action: "request",
    method: ep.method as Extract<Step, { action: "request" }>["method"],
    path,
    auth: "default",
    description: `Send ${ep.method} ${ep.path}`,
    ...extra,
});

/** A request that is stored with a test that could not be built, so the spec stays valid. It asserts nothing and is never run. */
export function placeholderRequest(): Step {
    return { action: "request", method: "GET", path: "/", auth: "default", description: "Placeholder: the description could not be turned into a call" };
}

/** Turn the model's plan into steps, or say plainly why not. Pure: no network. */
export function buildApiSteps(plan: ApiPlan, apis: ApiEndpointModel[], opts: { allowChanges: boolean }): ApiBuild {
    const none = (reason: string, ep?: ApiEndpointModel): ApiBuild => ({ ok: false, reason, ep, steps: [placeholderRequest()] });
    if (!plan.operation) return none(plan.explanation?.trim() || "None of the known API operations fits this description.");
    const m = /^\s*([A-Za-z]+)\s+(\S+)/.exec(plan.operation);
    const ep = m ? apis.find((a) => a.method.toUpperCase() === m[1]!.toUpperCase() && a.path === m[2]) : undefined;
    if (!ep) return none(`“${plan.operation.slice(0, 120)}” is not one of the operations this application is known to have. Run an analysis with the API description (OpenAPI) so it can be found.`);
    if (!SAFE.has(ep.method.toUpperCase()) && !opts.allowChanges) {
        return none(`${ep.method} ${ep.path} changes data, and tests that change data are switched off for this project. Switch them on when you analyze the application, or describe a call that only reads.`, ep);
    }

    // Path: values from the plan (checked), else the documented examples; a placeholder without any value cannot be called.
    const given = new Map(Object.entries(plan.pathValues).map(([k, v]) => [k, String(v)]));
    const bad = [...given.entries()].find(([, v]) => !SAFE_VALUE.test(v));
    if (bad) return none(`The value “${bad[1].slice(0, 40)}” for ${bad[0]} cannot be sent in an address. Use letters, digits, dots, dashes or underscores.`, ep);
    let path = fillPath(ep.path, ep, (name) => given.get(name));
    if (path === null && ep.source !== "openapi" && ep.examplePath && given.size === 0) path = ep.examplePath;
    if (path === null) {
        const missing = [...ep.path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]!).filter((n) => !given.has(n));
        return none(`${ep.method} ${ep.path} needs a value for ${missing.map((n) => `{${n}}`).join(", ")}, and the description doesn’t give one. Say which one to use (for example “product 1”).`, ep);
    }

    const query: Record<string, string> = { ...(queryFor(ep) ?? {}) };
    for (const [k, v] of Object.entries(plan.query).slice(0, 8)) {
        if (!SAFE_KEY.test(k)) return none(`The query name “${k.slice(0, 40)}” is not allowed.`, ep);
        query[k] = String(v).slice(0, 200);
    }
    const hasBody = plan.body !== undefined && !SAFE.has(ep.method.toUpperCase());
    if (hasBody && JSON.stringify(plan.body).length > MAX_BODY_CHARS) return none("The body in the description is too large for a test.", ep);

    const steps: Step[] = [req(ep, path, { ...(Object.keys(query).length ? { query } : {}), ...(hasBody ? { body: plan.body } : {}) })];
    const { expect } = plan;
    if (expect.status !== undefined) steps.push({ action: "assertResponse", check: "status", expected: expect.status, description: `Answers with HTTP ${expect.status}` });
    else steps.push({ action: "assertResponse", check: "statusClass", expected: "2xx", description: "Request succeeds" });
    for (const f of expect.fields.slice(0, 8)) {
        if (f.equals !== undefined) steps.push({ action: "assertResponse", check: "jsonPath", path: f.path, expected: f.equals, description: `“${f.path}” is ${String(f.equals)}` });
        else if (f.type) steps.push({ action: "assertResponse", check: "jsonType", path: f.path, expected: f.type, description: `“${f.path}” is a ${f.type}` });
        else steps.push({ action: "assertResponse", check: "jsonPath", path: f.path, description: `The answer contains “${f.path}”` });
    }
    for (const text of expect.bodyContains.slice(0, 4)) steps.push({ action: "assertResponse", check: "bodyContains", expected: text, description: `The answer contains “${text}”` });
    return { ok: true, ep, steps, explanation: plan.explanation };
}

/** Ask the model which operation the description is about. Throws the client's own error when no model is set up. */
export async function planApiCall(llm: LlmClient, description: string, apis: ApiEndpointModel[]): Promise<ApiPlan> {
    // Operations the sentence names by path come first so a long API cannot push the right one out of the list.
    const tokens = [...description.matchAll(/(\/[A-Za-z0-9_\-./{}]*[A-Za-z0-9_}])/g)].map((m) => m[1]!);
    const named = apis.filter((a) => tokens.some((t) => namesPath(t, a.path)));
    const ordered = [...named, ...apis.filter((a) => !named.includes(a))];
    return llm.object({
        system: SYSTEM,
        prompt: `Description:\n${description}\n\nKnown operations:\n${operationList(ordered)}`,
        schema: ApiPlanSchema,
        maxOutputTokens: 1500,
        purpose: "plain",
    });
}

/** The draft of an API spec (everything but the id), for a plan that was built or for the placeholder kept with the explanation. */
export function apiDraft(description: string, build: ApiBuild, requiresAuth: boolean) {
    return {
        title: titleOf(description),
        description: description.trim(),
        kind: "api" as const,
        category: PLAIN_CATEGORY,
        type: "functional" as const,
        priority: "medium" as const,
        preconditions: requiresAuth ? ["A valid API credential is configured (API_TOKEN)"] : [],
        steps: build.steps,
        expectedResults: expectedOf(description),
        testData: {},
        tags: ["plain-english", "api"],
        source: { origin: PLAIN_ORIGIN },
    };
}
