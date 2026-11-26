/**
 * What the OpenAPI document says a call answers, for the API tests (sheet 28 follow-up). Three rules, all from the document, no AI:
 *   - streamingReason: a WebSocket upgrade (a documented 101) or an event stream (a text/event-stream answer) is not a request/response
 *     call: a request test would wait for an answer that never ends. Such a call gets no request test, with this reason.
 *   - happyStatus: the status a valid request expects: 2xx when the document lists a success, else the one status it lists (an address
 *     that always fails on purpose), else the class of the lowest status it lists.
 *   - answersJson: every documented answer of the call is JSON, so a payload echoed in it is data, not markup (no reflected-payload check).
 * documentedCallerStatus is the validator's rule for a valid call that this account is refused in a way the document lists for that call.
 */
import type { Step, TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel, OpenApiOperation } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";

export function streamingReason(ep: Pick<ApiEndpointModel, "spec">): string | undefined {
    const responses = ep.spec?.responses ?? [];
    if (responses.some((r) => r.status === "101")) return "a WebSocket upgrade: request tests cannot hold its connection, so it is not tested here";
    if (responses.some((r) => /^2/.test(r.status) && /^text\/event-stream/i.test(r.contentType ?? ""))) return "an event stream that never ends: a request test would only time out, so it is not tested here";
    return undefined;
}

/** The happy path's status check: `statusClass` 2xx (or the observed class), or the documented status when the call lists no success. */
export function happyStatus(ep: Pick<ApiEndpointModel, "spec" | "source" | "statuses">): { check: "status" | "statusClass"; expected: string | number } {
    if (ep.source === "network") return { check: "statusClass", expected: `${String(ep.statuses[0] ?? 200).charAt(0)}xx` };
    const listed = (ep.spec?.responses ?? []).map((r) => Number(r.status)).filter((n) => Number.isInteger(n) && n >= 100).sort((a, b) => a - b);
    if (!listed.length || listed.some((n) => n >= 200 && n < 300)) return { check: "statusClass", expected: "2xx" };
    if (listed.length === 1) return { check: "status", expected: listed[0]! };
    return { check: "statusClass", expected: `${String(listed[0]).charAt(0)}xx` };
}

/** Every answer the call documents with a body is JSON (an OpenAPI call), or it was seen answering JSON (an observed call). */
export function answersJson(ep: Pick<ApiEndpointModel, "spec" | "source" | "responseSchema">): boolean {
    if (ep.source === "network") return Boolean((ep.responseSchema as { type?: unknown } | undefined)?.type);
    const typed = (ep.spec?.responses ?? []).filter((r) => r.contentType);
    return typed.length > 0 && typed.every((r) => /json/i.test(r.contentType!));
}

interface EndpointDoc {
    path: string;
    spec?: OpenApiOperation;
}

/**
 * A happy-path API test that failed only because this account was answered a status the document lists for this call: 403 (the account
 * may not call it, e.g. an admin call with a customer's token), or 404 of an address without an id (the account has none of it yet).
 * Returns the test rewritten to expect that status, or undefined (it stays a failure: 401 means no usable token, a 404 for a record or
 * any undocumented status may be a defect).
 */
export function documentedCallerStatus(spec: TestSpec, run: ScriptRun, endpointDoc: unknown): { spec: TestSpec; reason: string } | undefined {
    const doc = endpointDoc as EndpointDoc | undefined;
    if (spec.kind !== "api" || !spec.tags.includes("happy-path") || !doc?.spec) return undefined;
    const at = spec.steps.findIndex((s) => s.action === "assertResponse" && s.check === "statusClass" && s.expected === "2xx");
    if (at < 0 || run.failedStepIndex !== at) return undefined;
    const got = run.responses.at(-1)?.status;
    if (got !== 403 && !(got === 404 && !doc.path.includes("{"))) return undefined;
    const listed = doc.spec.responses.find((r) => r.status === String(got));
    if (!listed) return undefined;
    const step: Step = { action: "assertResponse", check: "status", expected: got, description: `Answers ${got} for this account, as documented (${listed.description || "no description"})` };
    const label = spec.title.split(": ")[0];
    return {
        spec: { ...spec, title: `${label}: answers ${got} for this account, as documented`, steps: [...spec.steps.slice(0, at), step], expectedResults: [`HTTP ${got}: ${listed.description}`] },
        reason: `the API answered ${got} to this account, which the document lists for this call ("${listed.description}"): the test now expects it`,
    };
}
