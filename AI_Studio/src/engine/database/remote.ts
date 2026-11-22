/**
 * D-c (spec 4.4): the customer's database probe (examples/db-probe) as a `DatabaseProbe`. The project keeps only the probe's address and
 * its token (platform/db-probe-store.ts); the database credentials never leave the customer. The token lives in this probe's closure: it
 * reaches no prompt, log, test or stored result, and no error message names it.
 *
 * What the probe answers is checked as untrusted: the schema through cleanSchema, a result field by field (a count, fingerprints as hex,
 * examples only in the masked form), so a probe that misbehaves cannot make the engine keep row contents.
 */
import { z } from "zod";
import { cleanSchema, DB_RESULT_KEYS_MAX, DatabaseCheckRefused, type DatabaseProbe, type DbCheckResult } from "./probe.js";
import { DbTemplateSchema, type DbParams, type DbTemplate } from "./templates.js";

/** The most a probe may answer (a schema of a few hundred tables). */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export interface RemoteProbeAccess {
    /** The probe's address: https://, or http:// on a loopback address (a local trial or the customer's own TLS proxy on this machine). */
    url: string;
    token: string;
    /** The platform passes its guarded fetch (no redirects, private addresses refused where the server blocks them). */
    fetch?: typeof fetch;
}

/** Why a probe address is not accepted, or undefined when it is. Also used by the settings route. */
export function probeUrlProblem(url: string): string | undefined {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return "The probe address is not a web address.";
    }
    if (u.username || u.password || u.search || u.hash) return "The probe address has no user name, password, query or fragment in it.";
    if (u.protocol === "https:") return undefined;
    if (u.protocol === "http:" && /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname)) return undefined;
    return "The probe address starts with https:// (plain http:// only on this computer's own address).";
}

const ResultSchema = z.object({
    kind: z.enum(["exists", "count", "orphans", "duplicates", "relation"]),
    table: z.string().max(63),
    count: z.number().int().min(0),
    ids: z.array(z.string().regex(/^[0-9a-f]{16,64}$/)).max(DB_RESULT_KEYS_MAX),
    // Only the masked form: a probe that sent key values would be refused here.
    examples: z.array(z.string().regex(/^•{1,6} \(\d{1,6} characters\)$/)).max(DB_RESULT_KEYS_MAX),
}).strict();

export function remoteDbProbe(access: RemoteProbeAccess): DatabaseProbe {
    const problem = probeUrlProblem(access.url);
    if (problem) throw new Error(problem);
    if (!access.token) throw new Error("The database probe needs its token.");
    const base = access.url.replace(/\/+$/, "");
    const token = access.token;
    const call = async (path: "/schema" | "/check", body?: unknown): Promise<{ status: number; json: unknown }> => {
        let res: Response;
        try {
            res = await (access.fetch ?? fetch)(`${base}${path}`, {
                method: body === undefined ? "GET" : "POST",
                headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                redirect: "error",
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            throw new Error(`the database probe could not be reached (${e instanceof Error ? e.name : "error"})`);
        }
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error(`the database probe answered more than ${MAX_BYTES} bytes`);
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(`the database probe answered HTTP ${res.status} without JSON`);
        }
        return { status: res.status, json };
    };
    const reason = (json: unknown) => String((json as { error?: unknown } | null)?.error ?? "").slice(0, 200);
    return {
        rowRelations: false,
        async schema() {
            const r = await call("/schema");
            if (r.status !== 200) throw new Error(`the database probe answered HTTP ${r.status}${reason(r.json) ? `: ${reason(r.json)}` : ""}`);
            return cleanSchema(r.json);
        },
        async check(template: DbTemplate, params?: DbParams): Promise<DbCheckResult> {
            // The engine's own grammar first: nothing outside it is sent.
            const t = DbTemplateSchema.parse(template);
            if (t.kind === "relation") throw new DatabaseCheckRefused("relation checks over rows are not run through a database probe");
            const r = await call("/check", { template: t, params: params ?? {} });
            // The probe refused the check (its allow-list or limits): a refusal with the probe's rule.
            if (r.status === 400 || r.status === 413 || r.status === 504) throw new DatabaseCheckRefused(`the database probe refused it: ${reason(r.json) || `HTTP ${r.status}`}`);
            if (r.status !== 200) throw new Error(`the database probe answered HTTP ${r.status}${reason(r.json) ? `: ${reason(r.json)}` : ""}`);
            const ok = ResultSchema.safeParse(r.json);
            if (!ok.success || ok.data.kind !== t.kind || ok.data.table !== t.table) throw new Error("the database probe's answer is not a check result (counts, fingerprints and masked keys only)");
            return ok.data;
        },
    };
}
