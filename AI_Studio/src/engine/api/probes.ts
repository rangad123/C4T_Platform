/**
 * C5 invariant probe (Phase 4 T13): each kept invariant (../validation/invariants.ts) is tried on the live application before a test is
 * saved. On a fresh account (the documented sign-up), the setup runs once, then fast-check generates up to 12 writes (references from the
 * documented list endpoints, numbers within their documented range) and the relation is checked after each accepted write. Constants of
 * the expression are aimed at first (a cart of exactly $50.00 from the listed prices). A failing case is shrunk by fast-check to a smaller
 * one, with at most 20 extra requests.
 *
 * The saved test is the concrete case (the minimal failing one, or the case that held) with its seed: it needs no fast-check to run, and
 * the same seed gives the same case. How often the relation held before it failed is reported only; it never demotes a finding.
 * Nothing runs with data changes off.
 */
import fc from "fast-check";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { Step } from "../spec/schema.js";
import { checkRelation } from "../validation/relation.js";
import type { Invariant } from "../validation/invariants.js";
import { sample, signUpOf, type DraftSpec } from "./test-specs.js";
import { resourceName, stripIdSuffix } from "./workflows.js";

export const MAX_PROBE_WRITES = 12;
export const MAX_SHRINK_REQUESTS = 20;

export interface ProbeAnswer {
    status: number;
    json: unknown;
}
/** One session with the application: requests go to its own origin only, and it keeps the cookies it is given (a sign-up's session). */
export interface ProbeHttp {
    send(method: string, path: string, body?: unknown): Promise<ProbeAnswer>;
    close?(): Promise<void>;
}
export interface ProbeEnv {
    apis: readonly ApiEndpointModel[];
    dataChanges: boolean;
    /**
     * A new session with no cookies. `credential`: it also sends the run's API token or header. That is only asked for when the API
     * documents no sign-up: on a fresh account only that account's session is sent.
     */
    newClient(credential: boolean): Promise<ProbeHttp>;
}

/**
 * A session over fetch for the probes: paths on the API's own origin only, no redirects followed, a 10-second limit per request, and the
 * cookies the application sets kept for the next request (a sign-up's session).
 * shortcut: one cookie jar per origin by name only (no path, expiry or domain rules); enough for a session cookie, use a real jar if an app scopes cookies by path.
 */
export function fetchClient(apiBaseUrl: string, headers: Record<string, string> = {}, doFetch: typeof fetch = fetch): ProbeHttp {
    const base = new URL(apiBaseUrl);
    const jar = new Map<string, string>();
    return {
        async send(method, path, body) {
            if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`The probe sends only paths on the application (${path.slice(0, 80)})`);
            const url = new URL(path, base);
            if (url.origin !== base.origin) throw new Error("The probe sends only to the application's own origin");
            const h: Record<string, string> = { accept: "application/json", ...headers };
            if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
            if (body !== undefined) h["content-type"] = "application/json";
            const res = await doFetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000) });
            for (const c of res.headers.getSetCookie()) {
                const [pair] = c.split(";");
                const i = pair!.indexOf("=");
                const [k, v] = [pair!.slice(0, i).trim(), pair!.slice(i + 1).trim()];
                if (i > 0 && v) jar.set(k, v);
                else if (i > 0) jar.delete(k);
            }
            const text = await res.text();
            let json: unknown;
            try {
                json = JSON.parse(text);
            } catch {
                json = undefined;
            }
            return { status: res.status, json };
        },
    };
}

/** A signed-in browser session's request context as a probe session: GET only (the project's account's lists are only read). */
export function requesterClient(request: { get(url: string, opts: { headers: Record<string, string>; failOnStatusCode: false; maxRedirects: 0; timeout: number }): Promise<{ status(): number; text?(): Promise<string> }> }, apiBaseUrl: string): ProbeHttp {
    const base = new URL(apiBaseUrl);
    return {
        async send(method, path) {
            const url = new URL(path, base);
            if (method !== "GET" || !path.startsWith("/") || path.startsWith("//") || url.origin !== base.origin) throw new Error("The project's account is only read, on the application's own origin");
            const res = await request.get(url.href, { headers: { accept: "application/json" }, failOnStatusCode: false, maxRedirects: 0, timeout: 10_000 });
            let json: unknown;
            try {
                json = JSON.parse((await res.text?.()) ?? "");
            } catch {
                json = undefined;
            }
            return { status: res.status(), json };
        },
    };
}

type Schema = Record<string, any>;
type Body = Record<string, unknown>;
export interface ProbeWrite {
    path: string;
    body?: Body;
    /** The values the write sends ($name in the expression): its body fields and path parameters. */
    vars: Record<string, unknown>;
}
export interface ProbeResult {
    requirementId: string;
    expression: string;
    seed: number;
    outcome: "failed" | "held" | "skipped";
    reason?: string;
    /** Checks that held before the failure (or in all, when it held). Reported only. */
    held: number;
    writes: number;
    requests: number;
    /** The saved case: the minimal failing one, or the case that held. */
    case: ProbeWrite[];
    message?: string;
    spec?: DraftSpec;
}

const SIGN_IN = /\/(?:login|log-in|signin|sign-in|session|sessions)(?:\/|$)/i;
const REFERENCE = /^[a-z][a-zA-Z0-9]*(?:Id|_id)$/;
const tmpl = (p: string) => p.replace(/\{[^}]*\}/g, "{}");
const is2xx = (s: number) => s >= 200 && s < 300;

/** "POST /api/cart" (or an absolute address) to the operation; the proposal was validated already, so this only looks it up. */
function endpointOf(text: string, apis: readonly ApiEndpointModel[]): ApiEndpointModel | undefined {
    const m = /^\s*([A-Z]+)\s+(\S+)\s*$/i.exec(text);
    if (!m) return undefined;
    const path = m[2]!.startsWith("/") ? m[2]! : new URL(m[2]!).pathname;
    return apis.find((a) => a.method.toUpperCase() === m[1]!.toUpperCase() && tmpl(a.path) === tmpl(path));
}
export const bodySchema = (ep: ApiEndpointModel): Schema | undefined => (ep.spec?.requestBody?.schema ?? ep.requestSchema) as Schema | undefined;

/** The records of a list answer: the array itself, or the one array of objects it holds ({ products: [...] }). */
export function recordsOf(json: unknown): Body[] {
    const objects = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Body => Boolean(x) && typeof x === "object" && !Array.isArray(x)) : []);
    if (Array.isArray(json)) return objects(json);
    const arrays = json && typeof json === "object" ? Object.values(json).filter((v) => objects(v).length) : [];
    return arrays.length === 1 ? objects(arrays[0]) : [];
}

/** The documented list endpoint for a reference field or path parameter (productId → GET /api/products). */
export function listFor(name: string, apis: readonly ApiEndpointModel[]): ApiEndpointModel | undefined {
    const resource = stripIdSuffix(name);
    return apis.find((e) => e.method.toUpperCase() === "GET" && !e.path.includes("{") && resourceName(e.path) === resource);
}

/** Replace {{unique}} for a request sent now (the saved test keeps the placeholder, so each replay signs up anew). */
export const uniqueNow = (v: unknown, tag: string): unknown => JSON.parse(JSON.stringify(v ?? null).replaceAll("{{unique}}", tag));

interface Plan {
    write: ApiEndpointModel;
    read?: ApiEndpointModel;
    setup: Array<{ ep: ApiEndpointModel; body?: unknown }>;
    signUp?: { ep: ApiEndpointModel; body: unknown };
    /** Reference values per field or path parameter, from the list endpoints; and the listed records (boundary aim). */
    refs: Map<string, { values: unknown[]; records: Body[] }>;
    /** Numeric body fields with their documented range. */
    numbers: Array<{ field: string; min: number; max: number; integer: boolean }>;
    others: Map<string, unknown>;
}

/** The arbitrary of one write: references from the lists, numbers in their documented range, every other field its sample value. */
export function writeArbitrary(plan: Pick<Plan, "write" | "refs" | "numbers" | "others">): fc.Arbitrary<ProbeWrite> {
    const fields: Record<string, fc.Arbitrary<unknown>> = {};
    const props: Record<string, Schema> = bodySchema(plan.write)?.properties ?? {};
    for (const name of Object.keys(props)) {
        const ref = plan.refs.get(name);
        const num = plan.numbers.find((n) => n.field === name);
        const s = props[name]!;
        fields[name] = ref?.values.length
            ? fc.constantFrom(...ref.values)
            : num
              ? num.integer
                  ? fc.integer({ min: num.min, max: num.max })
                  : fc.double({ min: num.min, max: num.max, noNaN: true })
              : Array.isArray(s.enum) && s.enum.length
                ? fc.constantFrom(...s.enum)
                : s.type === "boolean"
                  ? fc.boolean()
                  : fc.constant(plan.others.get(name));
    }
    const params = [...plan.write.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const paramArbs = Object.fromEntries(params.map((p) => [p, fc.constantFrom(...(plan.refs.get(p)?.values ?? ["1"]))]));
    const hasBody = Object.keys(props).length > 0;
    return fc.record({ body: fc.record(fields), params: fc.record(paramArbs) }).map(({ body, params: pv }) => ({
        path: plan.write.path.replace(/\{([^}]+)\}/g, (_m, p: string) => encodeURIComponent(String(pv[p]))),
        ...(hasBody ? { body } : {}),
        vars: { ...body, ...pv },
    }));
}

/** The same seed gives the same case: `n` writes generated from it. */
export function generateCase(plan: Pick<Plan, "write" | "refs" | "numbers" | "others">, seed: number, n: number): ProbeWrite[] {
    if (n <= 0) return [];
    return fc.sample(fc.array(writeArbitrary(plan), { minLength: n, maxLength: n }), { seed, numRuns: 1 })[0]!;
}

/** Numbers the expression compares with (5000 in "subtotal - discount >= 5000"), outside quoted text; 0, 1 and fractions are not aims. */
export function expressionConstants(expression: string): number[] {
    const bare = expression.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    return [...new Set([...bare.matchAll(/(?<![\w.$])\d+(?:\.\d+)?(?![\w.])/g)].map((m) => Number(m[0])))].filter((n) => Number.isInteger(n) && n > 1);
}

/**
 * Boundary aim: writes whose listed amounts make exactly the constant: one record times a quantity in range, or two records.
 * shortcut: one reference field and one numeric field, at most two writes; widen when an application needs a third line to reach a stated amount.
 */
export function aimedCases(plan: Pick<Plan, "write" | "refs" | "numbers" | "others">, constants: readonly number[]): ProbeWrite[][] {
    const props: Record<string, Schema> = bodySchema(plan.write)?.properties ?? {};
    const refField = Object.keys(props).find((k) => plan.refs.get(k)?.records.length);
    const qty = plan.numbers.find((n) => n.integer);
    if (!refField || !qty || plan.write.path.includes("{")) return [];
    const records = plan.refs.get(refField)!.records;
    const amountKeys = [...new Set(records.flatMap((r) => Object.keys(r).filter((k) => typeof r[k] === "number" && k !== "id")))];
    const write = (rec: Body, q: number): ProbeWrite => {
        const body: Body = { ...Object.fromEntries(Object.keys(props).map((k) => [k, plan.others.get(k)])), [refField]: rec.id, [qty.field]: q };
        for (const n of plan.numbers) if (n.field !== qty.field) body[n.field] = n.min;
        return { path: plan.write.path, body, vars: body };
    };
    const out: ProbeWrite[][] = [];
    for (const c of constants) {
        let found: ProbeWrite[] | undefined;
        for (const key of amountKeys) {
            for (const r of records) for (let q = qty.min; q <= qty.max && !found; q++) if ((r[key] as number) * q === c) found = [write(r, q)];
            for (let i = 0; i < records.length && !found; i++)
                for (let j = i + 1; j < records.length && !found; j++)
                    for (let a = qty.min; a <= qty.max && !found; a++) {
                        const rest = c - (records[i]![key] as number) * a;
                        const b = rest / (records[j]![key] as number);
                        if (Number.isInteger(b) && b >= qty.min && b <= qty.max) found = [write(records[i]!, a), write(records[j]!, b)];
                    }
            if (found) break;
        }
        if (found) out.push(found);
    }
    return out;
}

/**
 * The expression with each $name replaced by the value the write sent, for the saved test (its `data` holds no per-write values).
 * A text value with a placeholder ("test-title-{{unique}}") is resolved only when the script runs: `bind` names the test value that
 * holds it, and the expression refers to that name instead of the unresolved text.
 */
export function withValues(expression: string, vars: Record<string, unknown>, bind?: (name: string, value: string) => string): string {
    return expression
        .split(/("(?:[^"\\]|\\.)*")/)
        .map((part, i) =>
            i % 2
                ? part
                : part.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => {
                      const v = vars[name];
                      if (typeof v === "number" && Number.isFinite(v)) return `(${v})`;
                      if (typeof v === "string") return bind && v.includes("{{") ? "$" + bind(name, v) : JSON.stringify(v);
                      return m;
                  }),
        )
        .join("");
}

type CaseOutcome = { failed: false; held: number; requests: number; accepted: boolean[] } | { failed: true; held: number; requests: number; accepted: boolean[]; message: string; at: number };
class OverBudget extends Error {}

/** Runs one case on a fresh account. `allow(n)` is asked before each request; false ends the case as "held" (the budget is spent). */
async function runCase(plan: Plan, inv: Invariant, writes: readonly ProbeWrite[], env: ProbeEnv, allow: () => boolean): Promise<CaseOutcome & { setupFailed?: string }> {
    const client = await env.newClient(!plan.signUp);
    let requests = 0;
    const send = async (method: string, path: string, body?: unknown) => {
        if (!allow()) throw new OverBudget();
        requests++;
        return client.send(method, path, body);
    };
    const accepted: boolean[] = [];
    let held = 0;
    try {
        const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        if (plan.signUp) {
            const r = await send("POST", plan.signUp.ep.path, uniqueNow(plan.signUp.body, tag));
            if (!is2xx(r.status)) return { failed: false, held, requests, accepted, setupFailed: `the sign-up ${plan.signUp.ep.path} answered HTTP ${r.status}` };
        }
        for (const s of plan.setup) {
            const r = await send(s.ep.method.toUpperCase(), s.ep.path, s.body === undefined ? undefined : uniqueNow(s.body, tag));
            if (!is2xx(r.status)) return { failed: false, held, requests, accepted, setupFailed: `the setup ${s.ep.method.toUpperCase()} ${s.ep.path} answered HTTP ${r.status}` };
        }
        for (let i = 0; i < writes.length; i++) {
            const w = writes[i]!;
            const r = await send(plan.write.method.toUpperCase(), w.path, w.body === undefined ? undefined : uniqueNow(w.body, tag));
            accepted.push(is2xx(r.status));
            if (!is2xx(r.status)) continue;
            const checked = plan.read ? await send("GET", plan.read.path) : r;
            const v = checkRelation(inv.expression, { body: checked.json, vars: uniqueNow(w.vars, tag) as Record<string, unknown> }, inv.requirementId);
            if (!v.held) return { failed: true, held, requests, accepted, message: v.message, at: i };
            held++;
        }
        return { failed: false, held, requests, accepted };
    } catch (e) {
        if (e instanceof OverBudget) return { failed: false, held, requests, accepted };
        throw e;
    } finally {
        await client.close?.().catch(() => undefined);
    }
}

/**
 * The session the reference lists are read with: a fresh account of its own when the API documents a sign-up (so a list that needs
 * sign-in still gives ids, and the run's token is never sent), else the run's credential.
 */
export async function listSession(env: ProbeEnv, signUp: ApiEndpointModel | undefined): Promise<ProbeHttp> {
    const client = await env.newClient(!signUp);
    if (signUp) await client.send("POST", signUp.path, uniqueNow(sample(bodySchema(signUp)), `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`));
    return client;
}

/** What the probe needs from the API document for one invariant, or why it cannot run. */
async function planOf(inv: Invariant, env: ProbeEnv): Promise<Plan | string> {
    const write = endpointOf(inv.write, env.apis);
    if (!write) return `${inv.write} is not a documented operation`;
    const read = inv.read ? endpointOf(inv.read, env.apis) : undefined;
    const setup: Plan["setup"] = [];
    const up = signUpOf([...env.apis]);
    for (const [i, text] of inv.setup.entries()) {
        const ep = endpointOf(text, env.apis);
        if (!ep || ep.path.includes("{")) return `the setup ${text.slice(0, 80)} cannot be sent (it is not documented, or needs an id)`;
        // The probe signs up its fresh account itself: a setup that names the sign-up again would register the same account twice (HTTP 409).
        if (ep === up) continue;
        // Nor is a sign-in sent: the probe's session is signed in already (its fresh account by the sign-up, else the run's credential),
        // and the probe knows no password to send (paid shop-4/-5: "the setup POST /api/login answered HTTP 401" stopped every probe).
        if (ep.method.toUpperCase() === "POST" && SIGN_IN.test(ep.path)) continue;
        const schema = bodySchema(ep);
        setup.push({ ep, body: inv.setupBodies?.[i] ?? (schema ? sample(schema) : undefined) });
    }
    const signUp = up ? { ep: up, body: sample(bodySchema(up)) } : undefined;
    const props: Record<string, Schema> = bodySchema(write)?.properties ?? {};
    // An integer id is a reference too (the practice store's productId): drawn from the listed records, never guessed from its range.
    const names = [...Object.keys(props).filter((k) => REFERENCE.test(k) && ["string", "integer"].includes(String(props[k]!.type ?? "string")) && !props[k]!.enum), ...[...write.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)];
    const refs: Plan["refs"] = new Map();
    const lists = new Map<string, ApiEndpointModel>();
    for (const n of names) {
        const l = listFor(n, env.apis);
        if (l) lists.set(n, l);
    }
    if (lists.size) {
        const client = await listSession(env, signUp?.ep);
        try {
            for (const [n, l] of lists) {
                const records = recordsOf((await client.send("GET", l.path)).json);
                refs.set(n, { values: records.map((r) => r.id).filter((v) => typeof v === "string" || typeof v === "number"), records });
            }
        } finally {
            await client.close?.().catch(() => undefined);
        }
    }
    const numbers: Plan["numbers"] = [];
    const others = new Map<string, unknown>();
    for (const [k, s] of Object.entries(props)) {
        if (s.type === "integer" || s.type === "number") {
            const min = typeof s.minimum === "number" ? s.minimum : 0;
            numbers.push({ field: k, min, max: typeof s.maximum === "number" ? s.maximum : min + 9, integer: s.type === "integer" });
        } else others.set(k, sample(s, k));
    }
    return { write, ...(read ? { read } : {}), setup, ...(signUp ? { signUp } : {}), refs, numbers, others };
}

/** Probe one invariant. Never throws for an application's answer; a transport error is the caller's to report. */
export async function probeInvariant(inv: Invariant, env: ProbeEnv, opts: { seed?: number } = {}): Promise<ProbeResult> {
    const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const base = { requirementId: inv.requirementId, expression: inv.expression, seed, held: 0, writes: 0, requests: 0, case: [] as ProbeWrite[] };
    if (!env.dataChanges) return { ...base, outcome: "skipped", reason: "data changes are off, so the probe sends no write" };
    const plan = await planOf(inv, env);
    if (typeof plan === "string") return { ...base, outcome: "skipped", reason: plan };
    let writes = 0;
    let requests = 0;
    let failing: { writes: ProbeWrite[]; message: string; held: number } | undefined;
    let heldCase: { writes: ProbeWrite[]; held: number } | undefined;
    const run = async (c: ProbeWrite[]) => {
        writes += c.length;
        const r = await runCase(plan, inv, c, env, () => true);
        requests += r.requests;
        if (r.setupFailed) return r.setupFailed;
        const kept = c.slice(0, r.failed ? r.at + 1 : c.length).filter((_, i) => r.accepted[i]);
        if (r.failed) failing = { writes: kept, message: r.message, held: r.held };
        else if (!heldCase || r.held > heldCase.held) heldCase = { writes: kept, held: r.held };
        return undefined;
    };
    // Boundary aim first, then fast-check's writes with what is left of the 12.
    for (const c of aimedCases(plan, expressionConstants(inv.expression))) {
        if (failing || writes + c.length > MAX_PROBE_WRITES) break;
        const why = await run(c);
        if (why) return { ...base, outcome: "skipped", reason: why, writes, requests };
    }
    if (!failing && writes < MAX_PROBE_WRITES) {
        const why = await run(generateCase(plan, seed, MAX_PROBE_WRITES - writes));
        if (why) return { ...base, outcome: "skipped", reason: why, writes, requests };
    }
    if (failing) {
        // Shrinking: fast-check tries smaller cases from the failing one; once 20 extra requests are spent every further try counts as held.
        let extra = 0;
        let first = true;
        await fc.check(
            fc.asyncProperty(fc.array(writeArbitrary(plan), { minLength: 1, maxLength: failing.writes.length }), async (c) => {
                // The first value is the failing case itself (the example), known to fail: it is not sent again.
                if (first) return (first = false);
                const r = await runCase(plan, inv, c, env, () => extra < MAX_SHRINK_REQUESTS && ++extra > 0);
                if (!r.failed) return true;
                const kept = c.slice(0, r.at + 1).filter((_, i) => r.accepted[i]);
                if (kept.length <= failing!.writes.length) failing = { writes: kept, message: r.message, held: r.held };
                return false;
            }),
            { seed, numRuns: 1, examples: [[failing.writes]] },
        );
        requests += extra;
        const f = failing as { writes: ProbeWrite[]; message: string; held: number };
        return { ...base, outcome: "failed", held: f.held, writes, requests, case: f.writes, message: f.message, spec: specOf(inv, plan, f.writes, seed, { held: f.held, failed: true }) };
    }
    if (!heldCase || !(heldCase as { held: number }).held) return { ...base, outcome: "skipped", reason: `none of the ${writes} writes was accepted`, writes, requests };
    const h = heldCase as { writes: ProbeWrite[]; held: number };
    return { ...base, outcome: "held", held: h.held, writes, requests, case: h.writes, spec: specOf(inv, plan, h.writes, seed, { held: h.held, failed: false }) };
}

/** The saved test: the fresh account, the setup, and the concrete writes, each followed by the relation with the values it sent. */
function specOf(inv: Invariant, plan: Plan, writes: readonly ProbeWrite[], seed: number, o: { held: number; failed: boolean }): DraftSpec {
    // On a fresh account the script sends only that account's session (auth "none"), never the run's token or the project's sign-in.
    const auth = plan.signUp ? ("none" as const) : ("default" as const);
    const call = (ep: ApiEndpointModel, path: string, body: unknown, description: string): Step => ({ action: "request", method: ep.method.toUpperCase() as Extract<Step, { action: "request" }>["method"], path, auth, description, ...(body === undefined ? {} : { body }) });
    const ok = (description: string): Step => ({ action: "assertResponse", check: "statusClass", expected: "2xx", description });
    const steps: Step[] = [];
    const bound: Record<string, string> = {};
    if (plan.signUp) steps.push(call(plan.signUp.ep, plan.signUp.ep.path, plan.signUp.body, "Create a fresh account for this check"), ok("The fresh account is created"));
    for (const s of plan.setup) steps.push(call(s.ep, s.ep.path, s.body, `Setup: ${s.ep.method.toUpperCase()} ${s.ep.path}`), ok("The setup is accepted"));
    writes.forEach((w, i) => {
        steps.push(call(plan.write, w.path, w.body, `Write ${i + 1} of ${writes.length}${w.body ? `: ${JSON.stringify(w.body).slice(0, 80)}` : ""}`), ok("The write is accepted"));
        if (plan.read) steps.push(call(plan.read, plan.read.path, undefined, "Read the result back"));
        steps.push({ action: "assertResponse", check: "relation", expression: withValues(inv.expression, w.vars, (name, v) => ((bound[`write${i + 1}_${name}`] = v), `write${i + 1}_${name}`)), source: inv.requirementId, description: `Requirement ${inv.requirementId} holds` });
    });
    const label = `${plan.write.method.toUpperCase()} ${plan.write.path}`;
    return {
        title: `${label}: requirement ${inv.requirementId} holds after each write (${inv.expression.slice(0, 80)})`,
        description: `A property probe (fast-check seed ${seed}) on ${plan.signUp ? "a fresh account" : "the project's account"}: ${o.failed ? `the smallest failing case found, ${writes.length} write${writes.length === 1 ? "" : "s"}; the relation held ${o.held} time${o.held === 1 ? "" : "s"} before it failed` : `the relation held after all ${o.held} accepted writes`}.`,
        kind: "api",
        category: "API · Invariants",
        type: "functional",
        priority: o.failed ? "high" : "medium",
        preconditions: [],
        steps,
        expectedResults: [`${inv.expression} (requirement ${inv.requirementId})`],
        testData: { ...bound, probeSeed: String(seed) },
        tags: ["api", "invariant", "probe"],
        source: { origin: "requirements", requirements: [inv.requirementId] },
    };
}
