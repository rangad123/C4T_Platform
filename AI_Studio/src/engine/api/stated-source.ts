/**
 * The stated source of a generated test's checks (lead decision, eng-all; Phase 5 classify.ts and confidence read it). A check whose
 * expectation is the application's own API document (a documented status, the documented response schema, a documented refusal) names
 * it as `API document: <METHOD> <path> <status>`. A requirement id on the test (spec.source.requirements, as Phase 3 row 175 decided for
 * scenarios) is carried onto its checks that name nothing. A check of one of the STANDARD_RULES (lead decision) names it as
 * `standard rule: <name>`. Nothing else gets a source: a status only seen on the wire, a status class or any other behaviour check stays
 * inferred. A source a check already names is kept. Mutates the spec's steps.
 */
import type { TestSpec } from "../spec/schema.js";
import type { ApiEndpointModel } from "../understanding/app-model.js";

type Documented = Pick<ApiEndpointModel, "method" | "path" | "spec">;

/** The fixed list of behaviour rules that count as stated (lead decision, eng-all); nothing outside it does. */
export const STANDARD_RULES = {
    readBack: "read-back equals what was written",
    refusedWrite: "a refused write changes nothing",
    once: "one request acts once",
    owner: "a non-owner cannot read or write",
    session: "a session ends on sign-out",
    revoke: "a revoked share is gone",
} as const;

/** Which standard rule a check proves, read from the check itself (and, for read-back, the test's `readback` tag). */
function standardRule(step: Record<string, unknown>, tags: readonly string[], afterParallel: boolean): string | undefined {
    if (step.action === "assert" && step.check === "accessDenied" && typeof step.expected === "string") {
        let a: { sessionEnd?: unknown; identityWrite?: unknown; of?: unknown } = {};
        try {
            a = JSON.parse(step.expected) as typeof a;
        } catch {
            return undefined;
        }
        if (a.sessionEnd === true) return STANDARD_RULES.session;
        if (a.identityWrite === "revoke") return STANDARD_RULES.revoke;
        if (a.identityWrite === "owner" || (a.identityWrite === undefined && typeof a.of === "string")) return STANDARD_RULES.owner;
        return undefined;
    }
    if (step.action !== "assertResponse") return undefined;
    const expr = typeof step.expression === "string" ? step.expression : "";
    if (step.check === "relation" && expr.includes("$recordBefore")) return STANDARD_RULES.refusedWrite;
    if (step.check === "relation" && (afterParallel || /count\(\$listBefore\)\s*\+\s*1\b/.test(expr))) return STANDARD_RULES.once;
    if (tags.includes("readback") && (step.check === "jsonPath" || step.check === "relation" || (step.check === "dbCheck" && /^exists\b/.test(String(step.name ?? ""))))) return STANDARD_RULES.readBack;
    return undefined;
}

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
    let afterParallel = false;
    for (const step of spec.steps as Array<Record<string, unknown>>) {
        if (step.action === "request") {
            last = { method: String(step.method), path: String(step.path) };
            afterParallel = typeof step.parallel === "number";
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
        const rule = doc ? undefined : standardRule(step, spec.tags, afterParallel);
        if (doc) step.source = `API document: ${doc}`;
        else if (rule) step.source = `standard rule: ${rule}`;
        else if (reqIds.length) step.source = reqIds.join(", ");
    }
}
