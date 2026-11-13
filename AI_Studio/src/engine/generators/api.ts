/**
 * Spec → API test (Playwright `APIRequestContext`).
 *
 * Test scenarios themselves come from the OpenAPI/network pipeline in ../api. This renderer
 * deliberately targets Playwright's request fixture instead of pytest (used by ai-testing-agent)
 * so web and API tests run on the single Node validator with one toolchain.
 *
 * Multi-request workflows: a request step's `extract` stores response values in the script's
 * `data` object, so later `{{name}}` placeholders (paths, query, headers, bodies and assertion
 * expectations) resolve to them at runtime.
 */
import { describeStep, placeholdersIn, type Step, type TestSpec } from "../spec/schema.js";
import type { RenderContext, RenderedScript, ScriptGenerator } from "./types.js";
import { knownBugLine, testDetails } from "./playwright.js";
import { dataDeclaration, dataRowsFor, dataSetDeclaration, expr, fileHeader, lit, ROW_SETUP, rowTitle, scriptFilename } from "./render-utils.js";
import { CLEANUP_HELPER_SOURCE, canCreateRecords, cleanupScriptSource, deleteOperationsOfSpec, mergeOperations } from "../cleanup/helper.js";
import { CONTRACT_HELPER_SOURCE } from "../contracts/check.js";
import { DRIFT_HELPER_SOURCE } from "../contracts/drift.js";
import { ACCESS_API_HELPER_SOURCE } from "../identity/access.js";
import { LATENCY_HELPER_SOURCE } from "../performance/latency.js";
import { isLoadStep, LOAD_CALL_SOURCE, LOAD_HELPER_SOURCE, normalizeLoadBudgets } from "../performance/load.js";
import { SECURITY_HELPER_SOURCE, isSecurityCheck } from "../security/checks.js";
import { assertCredentialsStayHome, CREDENTIAL_ORIGIN_HELPER_SOURCE } from "../spec/credential-origin.js";
import { RUN_ADDRESS_HELPER_SOURCE, RUN_ADDRESS_IMPORT } from "../spec/run-address.js";

const HELPERS = `
${CREDENTIAL_ORIGIN_HELPER_SOURCE}
${RUN_ADDRESS_HELPER_SOURCE}
type Call = { status: number; headers: Record<string, string>; text: string; json: unknown; url: string; sent: Record<string, string>; setCookies: string[] };

/** Every response is recorded and attached to the report, so failures can be classified factually. */
const responses: Array<{ method: string; path: string; status: number }> = [];
/** Full responses, in order: the passive security checks judge every response a test received. */
const calls: Call[] = [];
test.afterEach(async ({}, testInfo) => {
    await testInfo.attach("responses", { body: JSON.stringify(responses), contentType: "application/json" });
});

async function call(
    request: APIRequestContext,
    method: string,
    path: string,
    opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown; auth: boolean },
): Promise<Call> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const target = await allowedAddress(path, API_BASE_URL);
    if (opts.auth) {
        // The stored token and header only ever go to the API's own site (a redirect or a changed address cannot send them elsewhere).
        assertOwnOrigin(target, API_BASE_URL);
        if (process.env.API_TOKEN) headers["Authorization"] = \`Bearer \${process.env.API_TOKEN}\`;
        if (process.env.API_AUTH_HEADER) {
            const i = process.env.API_AUTH_HEADER.indexOf(":");
            if (i > 0) headers[process.env.API_AUTH_HEADER.slice(0, i).trim()] = process.env.API_AUTH_HEADER.slice(i + 1).trim();
        }
    }
    const res = await request.fetch(target, {
        method,
        headers,
        params: opts.query,
        data: opts.body === undefined ? undefined : (opts.body as object),
        failOnStatusCode: false,
        maxRedirects: 0,
        ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    // Drift: only the SHAPE of a successful GET body (types, never values) is attached; other methods report their status alone.
    responses.push({ method, path, status: res.status(), ...(DRIFT_OBSERVE ? { obs: method.toUpperCase() === "GET" && res.status() >= 200 && res.status() < 300 ? driftObserve(json) : null } : {}) });
    const out: Call = {
        status: res.status(),
        headers: res.headers(),
        text,
        json,
        url: target,
        sent: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
        setCookies: res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value),
    };
    calls.push(out);
    return out;
}

function at(json: unknown, path: string): unknown {
    return path.split(".").filter(Boolean).reduce<unknown>((acc, key) => {
        if (acc === null || acc === undefined) return undefined;
        return (acc as Record<string, unknown>)[key];
    }, json);
}

function typeOf(v: unknown): string {
    return Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
}

/** Workflow capture: keep a response value for later {{name}} placeholders; fail loudly if it is absent. */
function capture(res: Call, name: string, path: string): string {
    const v = at(res.json, path);
    if (v === undefined || v === null || v === "") {
        throw new Error(\`Could not capture "\${name}": no value at "\${path}" in the HTTP \${res.status} response: \${res.text.slice(0, 300)}\`);
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Never send a request built from a value no earlier step captured (e.g. /things/undefined). */
function need(...names: string[]): void {
    const missing = names.filter((n) => data[n] === undefined);
    if (missing.length) throw new Error(\`No value for \${missing.map((n) => "{{" + n + "}}").join(", ")}: no earlier step captured it (extract) and testData does not define it\`);
}`;

/**
 * A script that can POST also notes the records it creates (see ../cleanup/helper.ts): `call()` reports every response to
 * `cleanupObserve`. Scripts that cannot create records are byte-for-byte what they were before this feature.
 */
function withCleanupHook(helpers: string): string {
    const anchor = "    calls.push(out);\n    return out;";
    if (!helpers.includes(anchor)) throw new Error("The API script helpers changed: update the cleanup hook in generators/api.ts");
    return helpers.replace(anchor, () => "    calls.push(out);\n    cleanupObserve(method, path, out);\n    return out;");
}

/** Interpolate {{vars}} inside an arbitrary JSON body into a JS expression. */
export function jsonExpr(value: unknown): string {
    if (typeof value === "string") return expr(value);
    if (Array.isArray(value)) return `[${value.map(jsonExpr).join(", ")}]`;
    if (value && typeof value === "object") {
        return `{ ${Object.entries(value as Record<string, unknown>)
            .map(([k, v]) => `${lit(k)}: ${jsonExpr(v)}`)
            .join(", ")} }`;
    }
    return JSON.stringify(value) ?? "undefined";
}

export function recordExpr(rec: Record<string, string> | undefined): string {
    if (!rec) return "undefined";
    return `{ ${Object.entries(rec)
        .map(([k, v]) => `${lit(k)}: ${expr(v)}`)
        .join(", ")} }`;
}

/** Every string inside a request (path, query, headers, body), for placeholder scanning. */
function requestStrings(step: Extract<Step, { action: "request" }>): string[] {
    const out = [step.path, ...Object.values(step.query ?? {}), ...Object.values(step.headers ?? {})];
    const walk = (v: unknown): void => {
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(step.body);
    return out;
}

const hasPlaceholder = (v: unknown): v is string => typeof v === "string" && placeholdersIn(v).length > 0;

/** Placeholders that only exist once a step has captured them (not builtins, not declared testData). */
const isRuntimeVar = (name: string, declared: Set<string>) => name !== "unique" && !name.startsWith("credentials.") && !name.startsWith("env.") && !declared.has(name);

/** The `call(...)` expression of a request step (also used to repeat it for latency measurements). */
function callExpr(step: Extract<Step, { action: "request" }>): string {
    return `call(request, ${lit(step.method)}, ${expr(step.path)}, { query: ${recordExpr(step.query)}, headers: ${recordExpr(step.headers)}, body: ${step.body === undefined ? "undefined" : jsonExpr(step.body)}, auth: ${step.auth === "default"} })`;
}

/** `declared` = the spec's testData keys (always present in `data`); `prev` = the nearest earlier request step. */
function renderStep(step: Step, declared: Set<string>, prev?: Extract<Step, { action: "request" }>): string {
    switch (step.action) {
        case "request": {
            const uses = [...new Set(requestStrings(step).flatMap(placeholdersIn))].filter((n) => isRuntimeVar(n, declared));
            const guard = uses.length ? `need(${uses.map(lit).join(", ")});\n        ` : "";
            const extract = Object.entries(step.extract ?? {})
                .map(([name, path]) => `\n        data[${lit(name)}] = capture(last, ${lit(name)}, ${lit(path)});`)
                .join("");
            return `${guard}last = await call(request, ${lit(step.method)}, ${expr(step.path)}, { query: ${recordExpr(step.query)}, headers: ${recordExpr(step.headers)}, body: ${
                step.body === undefined ? "undefined" : jsonExpr(step.body)
            }, auth: ${step.auth === "default"} });${extract}`;
        }
        case "assertResponse": {
            const exp = step.expected;
            // Expectations may reference captured values ({{productId}}); expr() resolves them at runtime.
            const text = (v: typeof exp) => expr(String(v ?? ""));
            switch (step.check) {
                case "status":
                    return `expect(last.status).toBe(${Number(exp)});`;
                case "statusClass":
                    return `expect(Math.floor(last.status / 100)).toBe(${Number(String(exp).charAt(0))});`;
                case "jsonPath":
                    if (exp === undefined) return `expect(at(last.json, ${lit(step.path ?? "")})).toBeDefined();`;
                    // Captured values are strings while the JSON value may be a number: compare as text.
                    if (hasPlaceholder(exp)) return `expect(String(at(last.json, ${lit(step.path ?? "")}))).toBe(${expr(exp)});`;
                    return `expect(at(last.json, ${lit(step.path ?? "")})).toEqual(${JSON.stringify(exp)});`;
                case "jsonType": {
                    const target = step.path ? `at(last.json, ${lit(step.path)})` : "last.json";
                    return `expect(typeOf(${target})).toBe(${lit(String(exp))});`;
                }
                case "header":
                    return `expect(last.headers[${lit((step.path ?? "").toLowerCase())}] ?? "").toContain(${text(exp)});`;
                case "bodyContains":
                    return `expect(last.text).toContain(${text(exp)});`;
                case "statusBelow":
                    return `expect(last.status).toBeLessThan(${Number(exp)});`;
                case "bodyNotContains":
                    return `expect(last.text).not.toContain(${text(exp)});`;
                case "statusDenied":
                    return `accessStatusAssert(last, ${lit(typeof exp === "string" ? exp : "{}")});`;
                case "latency":
                    if (!prev) throw new Error("A latency check needs a request step before it");
                    return `await latencyAssert(() => ${callExpr(prev)}, ${lit(typeof exp === "string" ? exp : "")}, (name, body) => test.info().attach(name, { body, contentType: "application/json" }));`;
                case "load":
                    // Load checks only ever send GET, and the numbers are clamped here too (the helper clamps them again when it runs).
                    if (!prev || prev.method !== "GET") throw new Error("A load check needs a GET request step before it (load checks never send anything else)");
                    return `await loadAssert(() => loadCall(request, ${expr(prev.path)}, { query: ${recordExpr(prev.query)}, headers: ${recordExpr(prev.headers)}, auth: ${prev.auth === "default"} }), ${lit(normalizeLoadBudgets(exp))}, (name, body) => test.info().attach(name, { body, contentType: "application/json" }), last.status, { lockKey: new URL(API_BASE_URL).host });`;
                case "matchesSchema":
                    return `contractAssert(last.json, ${JSON.stringify(step.schema ?? {})});`;
                case "securityHeaders":
                case "cookieFlags":
                case "corsPolicy":
                case "noExposedFiles":
                case "noInfoDisclosure":
                case "tlsCertificate":
                    // Judged over every response of the test (`calls`), see ../security/checks.ts.
                    return `await secAssert(calls, ${lit(step.check)}, ${exp === undefined ? "undefined" : lit(String(exp))});`;
            }
            return "";
        }
        default:
            throw new Error(`Step "${step.action}" is not valid in an API test`);
    }
}

export const apiGenerator: ScriptGenerator = {
    framework: "playwright-api",
    kind: "api",
    executable: true,
    render(spec: TestSpec, ctx: RenderContext): RenderedScript {
        // A data-driven spec (testData.dataSet) is rendered once per row: the row's columns are values of `data` too.
        const dataRows = dataRowsFor(spec, ctx);
        // A load check is bounded per test: one load step, and never once per data row (that would multiply the requests).
        const hasLoad = spec.steps.some(isLoadStep);
        if (spec.steps.filter(isLoadStep).length > 1) throw new Error("A test can contain only one load check (each one sends up to 300 requests)");
        if (hasLoad && dataRows) throw new Error("A load check cannot be data-driven (it would be repeated for every row)");
        const declared = new Set([...Object.keys(spec.testData), ...(dataRows?.columns ?? [])]);
        // Stored sign-in details only go to the API's own site. Refused here too, so no path (import, recording, plain English, generation)
        // can render a script that sends them anywhere else.
        assertCredentialsStayHome(spec, ctx);
        const steps = spec.steps
            .map((step, i) => {
                const title = `${i + 1}. ${describeStep(step)}`;
                const prev = spec.steps.slice(0, i).reverse().find((s): s is Extract<Step, { action: "request" }> => s.action === "request");
                return `    await test.step(${lit(title)}, async () => {\n        ${renderStep(step, declared, prev)}\n    });`;
            })
            .join("\n");
        // Passive security checks look at the application's own origin (BASE_URL, not a separate API base), and
        // accept a bad certificate so one broken certificate does not hide every other finding: the TLS check reports it.
        const passive = spec.source.origin === "security-check";
        const security = spec.steps.some((s) => s.action === "assertResponse" && isSecurityCheck(s.check));
        // Data-changing tests remove what they create (the DELETE operations come from the API description and from the test itself).
        const cleanup = canCreateRecords(spec);
        const helpers = cleanup ? withCleanupHook(HELPERS) : HELPERS;
        const content = `${fileHeader(spec, "Playwright API")}
import { test, expect, type APIRequestContext } from "@playwright/test";
${RUN_ADDRESS_IMPORT}${security ? 'import * as tls from "node:tls";\n' : ""}${cleanup ? 'import * as cleanupFs from "node:fs";\nimport * as cleanupPath from "node:path";\n' : ""}
const API_BASE_URL = ${passive ? `process.env.BASE_URL ?? ${lit(ctx.baseUrl)}` : `process.env.API_BASE_URL ?? ${lit(ctx.apiBaseUrl ?? ctx.baseUrl)}`};
const IGNORE_HTTPS_ERRORS = ${passive};
const DRIFT_OBSERVE = ${!passive};
${dataRows ? dataSetDeclaration(spec, dataRows) : dataDeclaration(spec)}
${helpers}
${DRIFT_HELPER_SOURCE}${security ? `\n${SECURITY_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assertResponse" && s.check === "matchesSchema") ? `\n${CONTRACT_HELPER_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assertResponse" && s.check === "latency") ? `\n${LATENCY_HELPER_SOURCE}` : ""}${hasLoad ? `\n${LOAD_HELPER_SOURCE}${LOAD_CALL_SOURCE}` : ""}${spec.steps.some((s) => s.action === "assertResponse" && s.check === "statusDenied") ? `\n${ACCESS_API_HELPER_SOURCE}` : ""}${cleanup ? `\n${CLEANUP_HELPER_SOURCE}${cleanupScriptSource({ testId: spec.testId, ops: mergeOperations(ctx.deleteOps, deleteOperationsOfSpec(spec)) })}` : ""}

${dataRows ? "for (const [rowIndex, row] of ROWS.entries()) {\n" : ""}test(${dataRows ? rowTitle(spec) : lit(`${spec.testId}: ${spec.title}`)}, ${testDetails(spec)}, async ({ request }) => {
${knownBugLine(spec, ctx)}${dataRows ? `    ${ROW_SETUP}\n    // Each row is judged on its own responses.\n    responses.length = 0;\n    calls.length = 0;\n` : ""}    ${hasLoad ? "// A load check runs for about 10 seconds (twice at most), may wait its turn behind another load check, and waits for slow answers: far more than the default time limit.\n    test.setTimeout(180_000);\n    " : ""}let last!: Call;
${steps}
});
${dataRows ? "}\n" : ""}`;
        return { framework: "playwright-api", filename: scriptFilename(spec), content, language: "typescript" };
    },
};
