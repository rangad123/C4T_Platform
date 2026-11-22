/**
 * C7 stateful sequences (Phase 4 T16). The state model of a record comes from the API document and the application model:
 *   - its states are the documented values of the record's status field (Order.status: placed, paid, shipped, cancelled);
 *   - an action (POST /orders/{id}/cancel) documents a conflict (409); the states it names ("Shipped or already cancelled") refuse the
 *     action, else the states its summary names ("Pay a placed order") are the only ones that allow it; the application model's stated
 *     transitions (from, to, trigger) add to that;
 *   - creating one (POST /orders) needs the operations its summary and conflict name ("needs a delivery address", "Cart empty or no
 *     address"): POST /cart/items and POST /checkout/address. Without one of them the documented conflict is expected.
 * On a fresh account, fast-check `commands` generate sequences of at most 8 steps (at most 6 sequences, the precondition skips
 * first: every needed operation but one, then the create, which must be refused: BS-10). Each step's expected status comes from the
 * model, and each step records its request, the answer's status and a summary of the state. A failure is shrunk to a smaller sequence.
 * States a fresh account never reaches (an order the warehouse shipped) are checked on records of the project's account that are in
 * them: the action must get the documented conflict (BS-05). Nothing runs with data changes off.
 */
import fc from "fast-check";
import type { ApiEndpointModel } from "../understanding/app-model.js";
import type { Step } from "../spec/schema.js";
import { bodySchema, listFor, listSession, recordsOf, uniqueNow, type ProbeEnv, type ProbeHttp } from "./probes.js";
import { sample, signUpOf, type DraftSpec } from "./test-specs.js";

export const MAX_SEQUENCES = 6;
export const MAX_SEQUENCE_STEPS = 8;
/** Requests shrinking may spend on top of the sequences: about six tries of a sequence of 8 with its sign-up (9 requests each). */
export const MAX_SEQUENCE_SHRINK_REQUESTS = 60;
const MAX_STATE_CHECKS = 4;

type Schema = Record<string, any>;
type Method = Extract<Step, { action: "request" }>["method"];
export interface Transition {
    entity: string;
    from: string;
    to: string;
    trigger: string;
}
export interface StateAction {
    ep: ApiEndpointModel;
    verb: string;
    allowed: string[];
    refused: string[];
    /** The documented conflict status (409). */
    conflict: number;
    /** The state a stated transition goes to; without one, the answer's status field says. */
    to?: string;
}
export interface Needed {
    ep: ApiEndpointModel;
    label: string;
    body?: unknown;
}
export interface StateModel {
    entity: string;
    list?: ApiEndpointModel;
    record: ApiEndpointModel;
    field: string;
    states: string[];
    create?: { ep: ApiEndpointModel; needs: Needed[]; conflict?: number };
    actions: StateAction[];
}

const SIGN_UP_OR_IN = /\/(?:register|sign-?up|auth|login|signin|sign-in|token|oauth|session|logout|signout|sign-out)(?:\/|$)/i;
const segments = (path: string) => path.split("/").filter((s) => s && !s.startsWith("{") && !/^(api|v\d+)$/i.test(s)).map((s) => s.toLowerCase());
const okSchema = (ep: ApiEndpointModel): Schema | undefined => (ep.spec?.responses.find((r) => /^2/.test(r.status) && r.schema)?.schema ?? ep.responseSchema) as Schema | undefined;
const documents = (ep: ApiEndpointModel, status: number) => ep.spec?.responses.find((r) => r.status === String(status));
const stateIn = (text: string, s: string) => new RegExp(`\\b${s.replace(/[^a-z0-9]/gi, "")}\\b`, "i").test(text);
const negated = (text: string, s: string) => new RegExp(`\\b(?:not|never|no|n't)\\s+(?:\\w+\\s+){0,2}${s.replace(/[^a-z0-9]/gi, "")}\\b`, "i").test(text);

/** Which states allow and refuse an action: the conflict's named states refuse it; else the summary's named states are the only ones allowed. */
function rule(ep: ApiEndpointModel, verb: string, states: string[], transitions: readonly Transition[], entity: string): Pick<StateAction, "allowed" | "refused" | "to"> | undefined {
    const conflict = documents(ep, 409)?.description ?? "";
    const summary = ep.summary ?? "";
    let refused = states.filter((s) => stateIn(conflict, s));
    let allowed = refused.length ? states.filter((s) => !refused.includes(s)) : states.filter((s) => stateIn(summary, s) && !negated(summary, s));
    if (!refused.length) refused = allowed.length ? states.filter((s) => !allowed.includes(s)) : states.filter((s) => negated(summary, s));
    if (!allowed.length && refused.length) allowed = states.filter((s) => !refused.includes(s));
    const stated = transitions.filter((t) => t.entity.toLowerCase().replace(/s$/, "") === entity.replace(/s$/, "") && t.trigger.toLowerCase().includes(verb));
    for (const t of stated) {
        const from = t.from.toLowerCase();
        if (states.includes(from) && !allowed.includes(from)) allowed.push(from);
        refused = refused.filter((s) => s !== from);
    }
    const to = stated.map((t) => t.to.toLowerCase()).find((s) => states.includes(s));
    return allowed.length || refused.length ? { allowed, refused, ...(to ? { to } : {}) } : undefined;
}

/**
 * The operations a create needs: for each word of its summary and conflict, the documented POST without an id whose path has it, the
 * last path segment first, then one that documents a body.
 * shortcut: word matching on paths; read the application model's workflow steps instead when a create's needs are not named in its own text.
 */
function needsOf(create: ApiEndpointModel, apis: readonly ApiEndpointModel[]): ApiEndpointModel[] {
    const own = segments(create.path)[0];
    const text = `${create.summary ?? ""} ${documents(create, 409)?.description ?? ""}`.toLowerCase();
    const words = [...new Set(text.match(/[a-z]{4,}/g) ?? [])].filter((w) => w !== own && `${w}s` !== own);
    const candidates = apis.filter((e) => e.method.toUpperCase() === "POST" && e !== create && !e.path.includes("{") && !SIGN_UP_OR_IN.test(e.path) && segments(e.path)[0] !== own);
    const out: ApiEndpointModel[] = [];
    for (const w of words) {
        const rank = (e: ApiEndpointModel) => {
            const segs = segments(e.path);
            const hit = segs.findIndex((s) => s === w || s === `${w}s`);
            return hit < 0 ? 0 : (hit === segs.length - 1 ? 2 : 1) + (bodySchema(e)?.properties ? 0.5 : 0);
        };
        const best = candidates.filter((e) => rank(e) > 0).sort((a, b) => rank(b) - rank(a))[0];
        if (best && !out.includes(best)) out.push(best);
    }
    return out;
}

/** The state models of an API document: one per record with a documented status field and actions that document a conflict. */
export function stateModels(apis: readonly ApiEndpointModel[], transitions: readonly Transition[] = []): StateModel[] {
    const out: StateModel[] = [];
    for (const record of apis) {
        const m = /^(.*)\/\{([^}]+)\}$/.exec(record.path);
        if (record.method.toUpperCase() !== "GET" || !m || m[1]!.includes("{")) continue;
        const props: Record<string, Schema> = okSchema(record)?.properties ?? {};
        const field = ["status", "state"].find((k) => Array.isArray(props[k]?.enum) && props[k]!.enum.length > 1);
        if (!field) continue;
        const states = (props[field]!.enum as unknown[]).map((s) => String(s).toLowerCase());
        const entity = segments(m[1]!).at(-1) ?? "record";
        const actions: StateAction[] = [];
        for (const ep of apis) {
            const a = new RegExp(`^${m[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\{[^}]+\\}/([a-z][\\w-]*)$`, "i").exec(ep.path);
            if (!a || ep.method.toUpperCase() === "GET" || !documents(ep, 409)) continue;
            const r = rule(ep, a[1]!.toLowerCase(), states, transitions, entity);
            if (r) actions.push({ ep, verb: a[1]!.toLowerCase(), conflict: 409, ...r });
        }
        if (!actions.length) continue;
        const create = apis.find((e) => e.method.toUpperCase() === "POST" && e.path === m[1] && e.spec?.responses.some((r) => /^2/.test(r.status)));
        const list = apis.find((e) => e.method.toUpperCase() === "GET" && e.path === m[1]);
        out.push({
            entity,
            record,
            field,
            states,
            actions,
            ...(list ? { list } : {}),
            ...(create ? { create: { ep: create, needs: needsOf(create, apis).map((ep) => ({ ep, label: `${ep.method.toUpperCase()} ${ep.path}` })), ...(documents(create, 409) ? { conflict: 409 } : {}) } } : {}),
        });
    }
    return out;
}

// ── sequences ────────────────────────────────────────────────────────────────

type Have = "absent" | "present" | "unknown";
interface Model {
    needs: Have[];
    /** Created records: their state, when the model knows it. */
    records: Array<string | undefined>;
}
export interface LoggedStep {
    request: string;
    status: number;
    expected?: string;
    state: string;
}
interface Real {
    /** "none" on a fresh account: the saved steps send only its session. */
    auth: "none" | "default";
    send(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
    ids: string[];
    log: LoggedStep[];
    steps: Step[];
    seen: Set<string>;
}
class Mismatch extends Error {}
class OverBudget extends Error {}

const is2xx = (s: number) => s >= 200 && s < 300;
const matches = (status: number, expected: number | "2xx") => (expected === "2xx" ? is2xx(status) : status === expected);
function summary(sm: StateModel, m: Model): string {
    const needs = sm.create?.needs.map((n, i) => `${n.label}: ${m.needs[i] === "present" ? "done" : m.needs[i] === "absent" ? "not done" : "not known"}`) ?? [];
    const recs = m.records.map((s, i) => `${sm.entity} ${i + 1}: ${s ?? "not known"}`);
    return [...needs, ...recs].join("; ") || "nothing yet";
}

/** One step: send it, judge it against the model's expectation, record it, and move the model on. */
async function step(sm: StateModel, m: Model, r: Real, o: { method: string; path: string; scriptPath: string; body?: unknown; expected?: number | "2xx"; extract?: string; label: string }, after: (status: number, json: unknown) => void) {
    const before = summary(sm, m);
    const res = await r.send(o.method, o.path, o.body);
    const json = res.json as Record<string, unknown> | undefined;
    after(res.status, json);
    const state = summary(sm, m);
    const exp = o.expected === undefined ? undefined : o.expected === "2xx" ? "2xx" : `HTTP ${o.expected}`;
    r.log.push({ request: `${o.method} ${o.path}`, status: res.status, ...(exp ? { expected: exp } : {}), state });
    // A create the model expects refused gets no capture: at replay the refusal is checked, not a missing id.
    const extract = o.extract && is2xx(res.status) && typeof o.expected !== "number" ? { extract: { [o.extract]: "id" } } : {};
    r.steps.push({ action: "request", method: o.method as Method, path: o.scriptPath, auth: r.auth, description: o.label, ...(o.body === undefined ? {} : { body: o.body }), ...extract });
    if (o.expected !== undefined)
        r.steps.push(o.expected === "2xx" ? { action: "assertResponse", check: "statusClass", expected: "2xx", description: `Accepted (before: ${before})`.slice(0, 300) } : { action: "assertResponse", check: "status", expected: o.expected, description: `Refused with the documented HTTP ${o.expected} (before: ${before})`.slice(0, 300) });
    if (o.expected !== undefined && !matches(res.status, o.expected)) throw new Mismatch(`${o.method} ${o.path} answered HTTP ${res.status}, but the documented state model expects ${exp}`);
}

type Cmd = fc.AsyncCommand<Model, Real, boolean>;
function needCmd(sm: StateModel, i: number): Cmd {
    const n = sm.create!.needs[i]!;
    return {
        check: () => true,
        run: (m, r) =>
            step(sm, m, r, { method: n.ep.method.toUpperCase(), path: n.ep.path, scriptPath: n.ep.path, body: n.body, expected: "2xx", label: `Step: ${n.label}` }, (status) => {
                if (is2xx(status)) m.needs[i] = "present";
            }),
        toString: () => n.label,
    };
}
function createCmd(sm: StateModel): Cmd {
    const c = sm.create!;
    return {
        check: () => true,
        run: (m, r) => {
            const missing = m.needs.some((h) => h === "absent");
            const expected = missing ? c.conflict : m.needs.every((h) => h === "present") ? ("2xx" as const) : undefined;
            const name = `${sm.entity.replace(/s$/, "")}${m.records.length + 1}`;
            return step(sm, m, r, { method: "POST", path: c.ep.path, scriptPath: c.ep.path, expected, extract: name, label: `Create a ${sm.entity.replace(/s$/, "")}${missing ? ` without ${c.needs.filter((_, i) => m.needs[i] === "absent").map((n) => n.label).join(" and ")}` : ""}` }, (status, json) => {
                if (!is2xx(status)) return;
                const id = (json as Record<string, unknown> | undefined)?.id;
                const s = String((json as Record<string, unknown> | undefined)?.[sm.field] ?? "").toLowerCase();
                r.ids.push(typeof id === "string" || typeof id === "number" ? String(id) : "");
                m.records.push(sm.states.includes(s) ? s : undefined);
                if (s) r.seen.add(s);
                // What a create consumes is not documented in a form the model can read: from here on it is not known.
                m.needs = m.needs.map(() => "unknown");
            });
        },
        toString: () => `create ${sm.entity}`,
    };
}
function actionCmd(sm: StateModel, a: StateAction, pick: number): Cmd {
    return {
        check: (m) => m.records.length > 0,
        run: (m, r) => {
            const k = pick % m.records.length;
            const id = r.ids[k];
            if (!id) throw new Mismatch(`the created ${sm.entity} has no id to ${a.verb}`);
            const s = m.records[k];
            const expected = s === undefined ? undefined : a.allowed.includes(s) ? ("2xx" as const) : a.refused.includes(s) ? a.conflict : undefined;
            const path = a.ep.path.replace(/\{[^}]+\}/, encodeURIComponent(id));
            const scriptPath = a.ep.path.replace(/\{[^}]+\}/, `{{${sm.entity.replace(/s$/, "")}${k + 1}}}`);
            return step(sm, m, r, { method: a.ep.method.toUpperCase(), path, scriptPath, expected, label: `${a.verb[0]!.toUpperCase()}${a.verb.slice(1)} ${sm.entity.replace(/s$/, "")} ${k + 1} (${s ?? "state not known"})` }, (status, json) => {
                if (!is2xx(status)) return;
                const next = String((json as Record<string, unknown> | undefined)?.[sm.field] ?? "").toLowerCase();
                m.records[k] = a.to ?? (sm.states.includes(next) ? next : undefined);
                if (m.records[k]) r.seen.add(m.records[k]!);
            });
        },
        toString: () => `${a.verb} ${sm.entity}[${pick}]`,
    };
}

export interface SequenceResult {
    entity: string;
    seed: number;
    outcome: "failed" | "held" | "skipped";
    reason?: string;
    sequences: number;
    requests: number;
    /** The saved sequence's log: each step's request, answer status, expectation and state summary. */
    log: LoggedStep[];
    message?: string;
    /** States the sequences reached. */
    seen: string[];
    spec?: DraftSpec;
}

/** The sequences for one state model: the precondition skips, then fast-check's, then shrinking of a failure. */
export async function runSequences(sm: StateModel, env: ProbeEnv, opts: { seed?: number; /** What is left of the run's 6. */ maxSequences?: number } = {}): Promise<SequenceResult> {
    const max = Math.min(opts.maxSequences ?? MAX_SEQUENCES, MAX_SEQUENCES);
    const seed = opts.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const base = { entity: sm.entity, seed, sequences: 0, requests: 0, log: [] as LoggedStep[], seen: [] as string[] };
    if (!env.dataChanges) return { ...base, outcome: "skipped", reason: "data changes are off, so no sequence is sent" };
    if (!sm.create) return { ...base, outcome: "skipped", reason: `no documented operation creates a ${sm.entity.replace(/s$/, "")}` };
    const up = signUpOf([...env.apis]);
    // The needed operations' bodies: their documented body, else the fields their answer documents; references take a listed id.
    const ids = new Map<string, unknown>();
    const probe = await listSession(env, up);
    try {
        for (const n of sm.create.needs) {
            const schema = bodySchema(n.ep)?.properties ? bodySchema(n.ep) : okSchema(n.ep);
            const body = schema ? (sample(schema) as Record<string, unknown>) : undefined;
            for (const k of Object.keys(body ?? {}).filter((k) => /^[a-z][a-zA-Z0-9]*(?:Id|_id)$/.test(k))) {
                const l = listFor(k, env.apis);
                if (l && !ids.has(k)) ids.set(k, recordsOf((await probe.send("GET", l.path)).json)[0]?.id);
                if (ids.get(k) !== undefined) body![k] = ids.get(k);
            }
            n.body = body;
        }
    } finally {
        await probe.close?.().catch(() => undefined);
    }
    let requests = 0;
    let sequences = 0;
    const seen = new Set<string>();
    let failure: { log: LoggedStep[]; steps: Step[]; message: string } | undefined;
    let first: { log: LoggedStep[]; steps: Step[] } | undefined;
    const runOne = async (cmds: Iterable<Cmd>, allow: () => boolean): Promise<boolean> => {
        const client = await env.newClient(!up);
        const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        const real: Real = {
            auth: up ? "none" : "default",
            ids: [],
            log: [],
            steps: [],
            seen,
            send: async (method, path, body) => {
                if (!allow()) throw new OverBudget();
                requests++;
                return client.send(method, path, body === undefined ? undefined : uniqueNow(body, tag));
            },
        };
        try {
            if (up) {
                const body = sample(bodySchema(up));
                const r = await real.send("POST", up.path, body);
                real.steps.push({ action: "request", method: "POST", path: up.path, auth: "none", body, description: "Create a fresh account for this sequence" }, { action: "assertResponse", check: "statusClass", expected: "2xx", description: "The fresh account is created" });
                if (!is2xx(r.status)) throw new OverBudget();
            }
            await fc.asyncModelRun(() => ({ model: { needs: sm.create!.needs.map(() => "absent" as Have), records: [] }, real }), cmds);
            first ??= { log: real.log, steps: real.steps };
            return true;
        } catch (e) {
            if (e instanceof OverBudget) return true;
            if (!(e instanceof Mismatch)) throw e;
            failure = { log: real.log, steps: real.steps, message: e.message };
            return false;
        } finally {
            await client.close?.().catch(() => undefined);
        }
    };
    const unlimited = () => true;
    // Precondition skips: every needed operation but one, then the create.
    const needs = sm.create.needs;
    for (let skip = 0; skip < needs.length && sequences < max && !failure; skip++) {
        sequences++;
        await runOne([...needs.map((_, i) => i).filter((i) => i !== skip).map((i) => needCmd(sm, i)), createCmd(sm)], unlimited);
    }
    if (!failure && sequences < max) {
        const arb = fc.commands([...needs.map((_, i) => fc.constant(needCmd(sm, i))), fc.constant(createCmd(sm)), ...sm.actions.map((a) => fc.nat(3).map((n) => actionCmd(sm, a, n)))], { maxCommands: MAX_SEQUENCE_STEPS });
        let extra = 0;
        let shrinking = false;
        const checked = await fc.check(
            fc.asyncProperty(arb, async (cmds) => {
                if (!shrinking) sequences++;
                const held = await runOne(cmds, () => !shrinking || (extra < MAX_SEQUENCE_SHRINK_REQUESTS && ++extra > 0));
                if (!held) shrinking = true;
                return held;
            }),
            { seed, numRuns: max - sequences },
        );
        // Anything but a step the model judged (a transport error) is the caller's to report, not a finding.
        if (checked.failed && !failure) throw checked.errorInstance instanceof Error ? checked.errorInstance : new Error(String(checked.errorInstance));
    }
    const out = { ...base, sequences, requests, seen: [...seen] };
    if (failure) return { ...out, outcome: "failed", log: failure.log, message: failure.message, spec: sequenceSpec(sm, failure, seed, true) };
    if (!first) return { ...out, outcome: "skipped", reason: "no sequence could be run (the sign-up was refused)" };
    return { ...out, outcome: "held", log: first.log, spec: sequenceSpec(sm, first, seed, false) };
}

const logText = (log: readonly LoggedStep[]) => log.map((s, i) => `${i + 1}. ${s.request} -> HTTP ${s.status}${s.expected ? ` (expected ${s.expected})` : ""}; state: ${s.state}`).join("\n");

function sequenceSpec(sm: StateModel, run: { log: LoggedStep[]; steps: Step[]; message?: string }, seed: number, failed: boolean): DraftSpec {
    return {
        title: `${sm.entity[0]!.toUpperCase()}${sm.entity.slice(1)}: a sequence of ${run.log.length} step${run.log.length === 1 ? "" : "s"} follows the documented states`,
        description: `A stateful sequence (fast-check seed ${seed}) on a fresh account${failed ? `; ${run.message}` : ""}. Sequence log:\n${logText(run.log)}`.slice(0, 4000),
        kind: "api",
        category: "API · States",
        type: "functional",
        priority: failed ? "high" : "medium",
        preconditions: [],
        steps: run.steps,
        expectedResults: [`Each step gets the status the documented states give (${sm.states.join(", ")})`],
        testData: { sequenceSeed: String(seed) },
        // "documented": a documented refusal the API accepted is a finding without AI (validation/validator.ts apiFinding).
        tags: ["api", "stateful", "sequence", "documented"],
        source: { origin: "openapi" },
    };
}

/**
 * States a fresh account never reached, checked on the project's account: a record of its list in such a state, then the action, which
 * must get the documented conflict (a Shipped order cannot be cancelled). The record's state is checked first, so a record that moved on
 * fails there, not at the oracle.
 */
export async function stateCheckSpecs(sm: StateModel, main: ProbeHttp, reached: readonly string[], dataChanges: boolean): Promise<DraftSpec[]> {
    if (!dataChanges || !sm.list) return [];
    const records = recordsOf((await main.send("GET", sm.list.path)).json);
    const out: DraftSpec[] = [];
    for (const a of sm.actions) {
        for (const s of a.refused.filter((x) => !reached.includes(x))) {
            const rec = records.find((r) => String(r[sm.field] ?? "").toLowerCase() === s && (typeof r.id === "string" || typeof r.id === "number"));
            if (!rec || out.length >= MAX_STATE_CHECKS) continue;
            const id = String(rec.id);
            const path = a.ep.path.replace(/\{[^}]+\}/, encodeURIComponent(id));
            const recordPath = sm.record.path.replace(/\{[^}]+\}/, encodeURIComponent(id));
            const doc = documents(a.ep, a.conflict)?.description;
            out.push({
                title: `${a.ep.method.toUpperCase()} ${a.ep.path}: a ${s} ${sm.entity.replace(/s$/, "")} is refused with HTTP ${a.conflict}`,
                description: `${sm.entity.replace(/s$/, "")} ${id} of the project's account is ${s}, a state a new account cannot reach; the API document says ${a.verb} is refused there${doc ? ` ("${doc}")` : ""}. Known limit (data changes are on): if the application wrongly allows it, ${id} leaves the ${s} state, so a rerun stops at the state check instead of the refusal.`,
                kind: "api",
                category: "API · States",
                type: "negative",
                priority: "high",
                preconditions: [`${sm.entity.replace(/s$/, "")} ${id} is ${s}`],
                steps: [
                    { action: "request", method: "GET", path: recordPath, auth: "default", description: `Read ${sm.entity.replace(/s$/, "")} ${id}` },
                    { action: "assertResponse", check: "jsonPath", path: sm.field, expected: String(rec[sm.field]), description: `It is still ${s}` },
                    { action: "request", method: a.ep.method.toUpperCase() as Method, path, auth: "default", description: `${a.verb[0]!.toUpperCase()}${a.verb.slice(1)} it` },
                    { action: "assertResponse", check: "status", expected: a.conflict, description: `Refused with the documented HTTP ${a.conflict}` },
                ],
                expectedResults: [`HTTP ${a.conflict}${doc ? ` (${doc})` : ""}, as the API document says`],
                testData: {},
                tags: ["api", "stateful", "documented"],
                source: { origin: "openapi" },
            });
        }
    }
    return out;
}
