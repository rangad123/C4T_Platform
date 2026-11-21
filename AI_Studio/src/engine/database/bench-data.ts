/**
 * D-a (spec 4.4): the benchmark apps' read-only data routes, GET /__bench/schema and GET /__bench/data, as a `DatabaseProbe`. Benchmark
 * mode only. The harness starts each app with a random per-trial token and hands the engine a probe for the app's origin
 * (registerBenchProbe); the token lives only in that probe's closure, so it reaches no prompt, log, test or stored result, and no error
 * message names it.
 */
import { cleanSchema, newEvidenceKey, type DatabaseProbe, type DbSchema } from "./probe.js";
import { runOnRows, validateCheck } from "./templates.js";

/** The most a data route may answer (the bench apps hold a few hundred rows). */
const MAX_BYTES = 20 * 1024 * 1024;

export interface BenchDataAccess {
    /** The app's origin, loopback only (http://127.0.0.1:<port>). */
    url: string;
    token: string;
    evidenceKey?: Buffer;
    fetch?: typeof fetch;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

export function benchDataProbe(access: BenchDataAccess): DatabaseProbe {
    const origin = access.url.replace(/\/+$/, "");
    if (!LOOPBACK.test(origin)) throw new Error("the bench data back end reads loopback benchmark apps only (http://127.0.0.1:<port>)");
    if (!access.token) throw new Error("the bench data back end needs the trial's data token");
    const token = access.token;
    const evidenceKey = access.evidenceKey ?? newEvidenceKey();
    const get = async (what: "schema" | "data"): Promise<unknown> => {
        const res = await (access.fetch ?? fetch)(`${origin}/__bench/${what}`, { headers: { "x-bench-data": token }, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (res.status !== 200) throw new Error(`the bench app's ${what} route answered HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error(`the bench app's ${what} route answered more than ${MAX_BYTES} bytes`);
        return JSON.parse(text);
    };
    const schema = async (): Promise<DbSchema> => cleanSchema(await get("schema"));
    return {
        schema,
        async check(template, params) {
            const v = validateCheck(template, params, await schema());
            const raw = (await get("data")) as { tables?: unknown } | null;
            const tables = raw && typeof raw.tables === "object" && raw.tables !== null ? (raw.tables as Record<string, unknown>) : {};
            const rows = (name: string) => (Array.isArray(tables[name]) ? (tables[name] as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : []);
            return runOnRows(v, { [v.table.name]: rows(v.table.name), ...(v.parent ? { [v.parent.name]: rows(v.parent.name) } : {}) }, evidenceKey);
        },
    };
}

/**
 * The probes the benchmark harness set up for this process's trials, by app origin. The engine asks for its target's probe; nothing is
 * kept beyond the process and nothing is serialised.
 * shortcut: in-process only (the benchmark runs its platform in-process); a remote platform would need its own hand-over channel.
 */
const benchProbes = new Map<string, DatabaseProbe>();
const originOf = (url: string) => {
    try {
        return new URL(url).origin;
    } catch {
        return "";
    }
};
export function registerBenchProbe(appUrl: string, probe: DatabaseProbe): () => void {
    const o = originOf(appUrl);
    benchProbes.set(o, probe);
    return () => {
        if (benchProbes.get(o) === probe) benchProbes.delete(o);
    };
}
export const benchProbeFor = (appUrl: string): DatabaseProbe | undefined => benchProbes.get(originOf(appUrl));
