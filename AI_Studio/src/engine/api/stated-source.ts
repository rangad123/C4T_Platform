/**
 * The stated source of a generated test's checks (lead decision, eng-all; Phase 5 classify.ts and confidence read it). A check whose
 * expectation is the application's own API document (a documented status, the documented response schema, a documented refusal) names
 * it as `API document: <METHOD> <path> <status>`. A requirement id on the test (spec.source.requirements, as Phase 3 row 175 decided for
 * scenarios) is carried onto its checks that name nothing. Nothing else gets a source: a status only seen on the wire, a status class or
 * a behaviour rule stays inferred. A source a check already names is kept. Mutates the spec's steps.
 */
import type { TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";

type Documented = Pick<ApiEndpointModel, "method" | "path" | "spec">;

/** The documented endpoint a request path is a call of: the template with each `{param}` matching one path part (a value or `{{var}}`). */
function endpointOf(apis: readonly Documented[], method: string, rawPath: string): Documented | undefined {
    const p = rawPath.split("?")[0]!.replace(/\/+$/, "") || "/";
    return apis.find((a) => {
        if (!a.spec?.responses?.length || a.method.toUpperCase() !== method.toUpperCase()) return false;
        const re = new RegExp(`^${a.path.replace(/\/+$/, "").split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`);
        return re.test(p);
    });
}

const documentedStatus = (ep: Documented, status: string) => ep.spec!.responses.some((r) => r.status === status);

export function withStatedSources(spec: TestSpec, apis: readonly Documented[]): void {
    const reqIds = (spec.source.requirements ?? []).filter((r) => r.trim());
    let last: { method: string; path: string } | undefined;
    for (const step of spec.steps as Array<Record<string, unknown>>) {
        if (step.action === "request") {
            last = { method: String(step.method), path: String(step.path) };
            continue;
        }
        if ((step.action !== "assertResponse" && step.action !== "assert") || step.source) continue;
        let doc: string | undefined;
        if (step.action === "assertResponse" && last) {
            const ep = endpointOf(apis, last.method, last.path);
            if (ep && step.check === "status" && documentedStatus(ep, String(step.expected))) doc = `${ep.method.toUpperCase()} ${ep.path} ${String(step.expected)}`;
            if (ep && step.check === "matchesSchema") {
                const ok = ep.spec!.responses.find((r) => /^2/.test(r.status));
                if (ok) doc = `${ep.method.toUpperCase()} ${ep.path} ${ok.status}`;
            }
        }
        if (step.action === "assert" && step.check === "accessDenied" && typeof step.expected === "string") {
            let a: { path?: unknown; method?: unknown; documented?: unknown } = {};
            try {
                a = JSON.parse(step.expected) as typeof a;
            } catch {
                /* not an access check's payload */
            }
            const ep = typeof a.path === "string" ? endpointOf(apis, typeof a.method === "string" ? a.method : "GET", a.path) : undefined;
            const statuses = typeof a.documented === "string" ? a.documented.match(/\d{3}/g) ?? [] : [];
            if (ep && statuses.some((s) => documentedStatus(ep, s))) doc = `${ep.method.toUpperCase()} ${ep.path} ${String(a.documented)}`;
        }
        if (doc) step.source = `API document: ${doc}`;
        else if (reqIds.length) step.source = reqIds.join(", ");
    }
}
