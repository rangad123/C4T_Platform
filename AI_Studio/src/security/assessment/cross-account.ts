/**
 * Read-only cross-account checks: can test account A read what belongs to test account B?
 *
 * The person names two of the project's test accounts (each with a saved sign-in) and the resources whose owner they know: an item, a
 * nested item, a list or a search, owned by A, by B, shared between them, or public. For each one the check requests the address as B (the
 * owner's view), as A and signed out, through the assessment's scope guard, and compares what came back:
 *
 *   own-access        A reading its own (or a shared, or a public) resource: expected, never a finding
 *   protected         A asked for B's resource and got a refusal, or an answer that holds none of B's data
 *   unauthorized-read A got an answer that holds B's data (at least two of B's distinctive values, or B's id in the ownership field)
 *   visitor-read      a signed-out visitor got B's data
 *   inconclusive      what B's resource holds could not be established (B could not read it, nothing distinctive in it, a list
 *                     without an ownership field), or A's answer holds a single one of B's values: never reported as a vulnerability
 *
 * An HTTP 200 alone is never a finding: only B's own data in A's answer is. "B's data" means values from B's answer that are long enough
 * to identify something (strings of 6 or more characters, numbers of 5 or more digits) and that A's own, shared and public resources do
 * not also show. Findings keep no response body: only the address, the accounts' names, the status codes, which fields held B's values
 * and how many. Every request is a GET through the guard (which itself refuses anything but GET, HEAD and OPTIONS); a designated address
 * that names a GraphQL mutation or a sign-out is refused before anything is sent.
 *
 * This file sends nothing itself: the caller gives it one fetch per identity (runner.ts, with one guard each).
 */
import { z } from "zod";
import type { RawResult } from "../findings/normalize.js";
import { isSignOut } from "../signin-rules.js";
import type { GuardedAnswer } from "./types.js";

export const CROSS_ACCOUNT_LIMITS = { resources: 50, pathMax: 500, labelMax: 120, fieldMax: 80, valueMax: 200, listItems: 500 } as const;

export const OWNERS = ["A", "B", "shared", "public"] as const;
export const KINDS = ["item", "nested", "list", "search"] as const;
export type ResourceOwner = (typeof OWNERS)[number];
export type ResourceKind = (typeof KINDS)[number];

/** An address relative to the application (it must start with "/"): no scheme, host, fragment or whitespace. */
const Path = z
    .string()
    .trim()
    .min(1)
    .max(CROSS_ACCOUNT_LIMITS.pathMax)
    .regex(/^\/[^\s#]*$/, "Give the address as a path of the application, starting with “/” (for example /api/notes/42).");

export const DesignationSchema = z
    .object({
        accountA: z.string().trim().min(1).max(60),
        accountB: z.string().trim().min(1).max(60),
        resources: z
            .array(
                z
                    .object({
                        path: Path,
                        kind: z.enum(KINDS),
                        owner: z.enum(OWNERS),
                        label: z.string().trim().max(CROSS_ACCOUNT_LIMITS.labelMax).optional(),
                    })
                    .strict(),
            )
            .min(1, "Name at least one resource.")
            .max(CROSS_ACCOUNT_LIMITS.resources, `At most ${CROSS_ACCOUNT_LIMITS.resources} resources.`),
        /** The field of a list item (or an item) that names its owner, e.g. "ownerId". Dotted paths are allowed ("owner.id"). */
        ownerField: z.string().trim().min(1).max(CROSS_ACCOUNT_LIMITS.fieldMax).regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/).optional(),
        /** What that field holds for B's resources (and for A's), as the application writes it. */
        ownerValueB: z.string().trim().min(1).max(CROSS_ACCOUNT_LIMITS.valueMax).optional(),
        ownerValueA: z.string().trim().min(1).max(CROSS_ACCOUNT_LIMITS.valueMax).optional(),
    })
    .strict()
    .refine((d) => d.accountA !== d.accountB, { message: "Choose two different test accounts." })
    .refine((d) => !d.ownerValueA || !d.ownerValueB || d.ownerValueA !== d.ownerValueB, { message: "A and B cannot have the same owner value." });

export type Designation = z.infer<typeof DesignationSchema>;
export type DesignatedResource = Designation["resources"][number];

/** Why a designated address is never requested, or undefined. Checked before any request (the scope guard checks again). */
export function refusalOf(path: string): string | undefined {
    if (isSignOut(path)) return "It looks like a sign-out address, so it is never requested.";
    let u: URL;
    try {
        u = new URL(path, "http://placeholder.invalid");
    } catch {
        return "It is not a valid address.";
    }
    // A GraphQL operation sent with GET: only a query may be sent, never a mutation or a subscription.
    const q = (u.searchParams.get("query") ?? "") + " " + (u.searchParams.get("operationName") ?? "");
    if (/(^|[\s{(])(mutation|subscription)\b/i.test(q)) return "It names a GraphQL mutation or subscription, which could change data, so it is never requested.";
    return undefined;
}

/** Environments an application may be marked with in which cross-account checks run. Production and "other" never. */
export const CROSS_ACCOUNT_ENVIRONMENTS: readonly string[] = ["development", "staging"];

/** Why the checks may not run against this application's environment, or undefined. */
export function environmentProblem(environment: string): string | undefined {
    if (CROSS_ACCOUNT_ENVIRONMENTS.includes(environment)) return undefined;
    return `Cross-account checks were not made: they run only against an application marked as development or staging, and this one is marked “${environment}”.`;
}

/** The coverage sentence on a platform whose assessments run on runners (the checks are not available there yet). */
export const CROSS_ACCOUNT_NOT_ON_RUNNER = "Cross-account checks were not made: on this platform assessments run on your runner, where they are not available yet.";

export type Classification = "own-access" | "protected" | "unauthorized-read" | "visitor-read" | "inconclusive";

export interface CheckOutcome {
    path: string;
    kind: ResourceKind;
    owner: ResourceOwner;
    label?: string;
    classification: Classification;
    confidence?: "high" | "medium";
    /** One plain sentence: what was seen and why it is classified so (no values of the answers). */
    reason: string;
    status: { a?: number; b?: number; visitor?: number };
    /** Where B's values showed up in A's (or the visitor's) answer: field names only. */
    fields?: string[];
    matched?: number;
}

export type Identity = "A" | "B" | "visitor";
export type FetchAs = (who: Identity, path: string) => Promise<GuardedAnswer>;

// ── reading answers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const parseJson = (a: GuardedAnswer): unknown => {
    const type = a.headers["content-type"] ?? "";
    if (!/json/i.test(type) && !/^\s*[[{]/.test(a.text)) return undefined;
    try {
        return JSON.parse(a.text);
    } catch {
        return undefined;
    }
};

/** Leaf values of a JSON answer that can identify something, with the field they were in (dotted, array indexes dropped). */
export function distinctiveValues(v: unknown, field = "", out: Map<string, Set<string>> = new Map(), depth = 0): Map<string, Set<string>> {
    if (depth > 12 || out.size > 2_000) return out;
    const add = (value: string) => {
        let s = out.get(value);
        if (!s) out.set(value, (s = new Set()));
        if (s.size < 5) s.add(field || "(answer)");
    };
    if (typeof v === "string") {
        const t = v.trim();
        if (t.length >= 6 && !/^(?:true|false|null|undefined|active|inactive|pending|enabled|disabled|private|public|shared)$/i.test(t)) add(t);
    } else if (typeof v === "number" && Number.isInteger(v) && Math.abs(v) >= 10_000) add(String(v));
    else if (Array.isArray(v)) for (const x of v.slice(0, CROSS_ACCOUNT_LIMITS.listItems)) distinctiveValues(x, field, out, depth + 1);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) distinctiveValues(x, field ? `${field}.${k}` : k, out, depth + 1);
    return out;
}

/** The values of an answer as plain text, for answers that are not JSON (and for JSON too: a value may appear inside a string). */
const textOf = (a: GuardedAnswer): string => a.text;

const getPath = (o: unknown, dotted: string): unknown => dotted.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), o);

/** The items of a list answer: the answer itself when it is an array, else the first array under a usual key. */
export function itemsOf(json: unknown): unknown[] | undefined {
    if (Array.isArray(json)) return json;
    if (json && typeof json === "object") {
        for (const k of ["items", "data", "results", "records", "rows", "list", "entries", "content"]) {
            const v = (json as Record<string, unknown>)[k];
            if (Array.isArray(v)) return v;
        }
        const arrays = Object.values(json).filter(Array.isArray);
        if (arrays.length === 1) return arrays[0] as unknown[];
    }
    return undefined;
}

const ok = (a: GuardedAnswer | undefined): a is GuardedAnswer => Boolean(a) && a!.status >= 200 && a!.status < 300 && !a!.blockedRedirect;
const refused = (a: GuardedAnswer | undefined) => !a || a.status >= 300;
const statusOf = (a: GuardedAnswer | undefined): string => (a ? String(a.status) : "no answer");

// ── one resource ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Answers {
    a?: GuardedAnswer;
    b?: GuardedAnswer;
    visitor?: GuardedAnswer;
}

/** The judgement for one designated resource, from the three answers. Pure: no request, no clock. `aOwn`: values seen in A's own resources. */
export function classify(r: DesignatedResource, x: Answers, d: Pick<Designation, "ownerField" | "ownerValueA" | "ownerValueB">, aOwn: ReadonlySet<string>): CheckOutcome {
    const base = { path: r.path, kind: r.kind, owner: r.owner, ...(r.label ? { label: r.label } : {}), status: { ...(x.a ? { a: x.a.status } : {}), ...(x.b ? { b: x.b.status } : {}), ...(x.visitor ? { visitor: x.visitor.status } : {}) } };
    const out = (classification: Classification, reason: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ ...base, classification, reason, ...extra });

    if (r.owner !== "B") {
        const who = r.owner === "A" ? "A's own resource" : r.owner === "shared" ? "a resource shared with A" : "a public resource";
        if (r.owner === "public" && x.visitor && refused(x.visitor)) return out("own-access", `Designated as public, but a signed-out visitor was refused (${x.visitor.status}); check the designation.`);
        if (r.owner !== "public" && x.a && refused(x.a)) return out("own-access", `A was refused (${x.a.status}) on ${who}; check the designation or A's saved sign-in.`);
        return out("own-access", `A read ${who}, as expected.`);
    }

    // B's resource: what B itself sees is the reference.
    if (!ok(x.b)) return out("inconclusive", `B could not read its own resource (${statusOf(x.b)}), so what it holds is unknown.`);
    const bJson = parseJson(x.b);

    if (r.kind === "list" || r.kind === "search") return classifyList(r, x, d, bJson, out);

    if (bJson === undefined) {
        // Not JSON: only an identical, non-empty answer counts, and only when a visitor does not get the same.
        const same = (y?: GuardedAnswer) => ok(y) && y.text.length >= 20 && y.text === x.b!.text;
        if (same(x.visitor)) return out("visitor-read", "A signed-out visitor got exactly B's answer.", { confidence: "medium" });
        if (same(x.a)) return out("unauthorized-read", "A got exactly B's answer.", { confidence: "medium" });
        if (ok(x.a)) return out("inconclusive", "The answer is not JSON and A's answer differs from B's, so whether it holds B's data cannot be told.");
        return out("protected", `A was refused (${statusOf(x.a)}).`);
    }

    const bValues = distinctiveValues(bJson);
    // Values A's own, shared or public resources also show (the site's name, shared lookups) say nothing about B.
    const markers = [...bValues.keys()].filter((v) => !aOwn.has(v) && v !== d.ownerValueA);
    const ownerHit = (j: unknown) => Boolean(d.ownerField && d.ownerValueB && String(getPath(j, d.ownerField) ?? "") === d.ownerValueB);
    if (!markers.length && !ownerHit(bJson)) return out("inconclusive", "B's answer holds nothing that identifies B's data (everything in it is also public or also in A's own resources).");

    const found = (y: GuardedAnswer) => {
        const text = textOf(y);
        const hits = markers.filter((m) => text.includes(m));
        return { hits, fields: [...new Set(hits.flatMap((m) => [...(bValues.get(m) ?? [])]))].slice(0, 10), owner: ownerHit(parseJson(y)) };
    };
    if (x.visitor && ok(x.visitor)) {
        const f = found(x.visitor);
        if (f.owner || f.hits.length >= 2) return out("visitor-read", `A signed-out visitor got ${f.hits.length} of B's values${f.owner ? " and B's owner id" : ""}.`, { confidence: f.owner || f.hits.length >= 3 ? "high" : "medium", fields: f.fields, matched: f.hits.length });
    }
    if (!x.a || refused(x.a)) return out("protected", `A was refused (${statusOf(x.a)}).`);
    const f = found(x.a);
    if (f.owner || f.hits.length >= 2)
        return out("unauthorized-read", `A got ${f.hits.length} of B's values${f.owner ? " and B's owner id" : ""} (status ${x.a.status}).`, { confidence: f.owner || f.hits.length >= 3 ? "high" : "medium", fields: f.fields, matched: f.hits.length });
    if (f.hits.length === 1) return out("inconclusive", `A's answer (status ${x.a.status}) holds one of B's values; one value is not enough to tell.`, { fields: f.fields, matched: 1 });
    return out("protected", `A got status ${x.a.status}, but none of B's data.`);
}

function classifyList(r: DesignatedResource, x: Answers, d: Pick<Designation, "ownerField" | "ownerValueA" | "ownerValueB">, bJson: unknown, out: (c: Classification, reason: string, extra?: Partial<CheckOutcome>) => CheckOutcome): CheckOutcome {
    if (!d.ownerField || !d.ownerValueB) return out("inconclusive", "A list can only be judged with the ownership field and B's value in it; neither was given.");
    const bItems = itemsOf(bJson);
    if (!bItems) return out("inconclusive", "B's answer is not a list.");
    const mine = (items: unknown[] | undefined) => (items ?? []).filter((i) => String(getPath(i, d.ownerField!) ?? "") === d.ownerValueB);
    if (!mine(bItems).length) return out("inconclusive", `B's own list shows no item whose ${d.ownerField} is B's, so nothing in it is known to be B's.`);
    const leak = (y: GuardedAnswer | undefined) => (y && ok(y) ? mine(itemsOf(parseJson(y))).length : 0);
    const v = leak(x.visitor);
    if (v) return out("visitor-read", `A signed-out visitor's list holds ${v} item${v === 1 ? "" : "s"} whose ${d.ownerField} is B's.`, { confidence: "high", fields: [d.ownerField], matched: v });
    if (!x.a || refused(x.a)) return out("protected", `A was refused (${statusOf(x.a)}).`);
    if (itemsOf(parseJson(x.a)) === undefined) return out("inconclusive", `A's answer (status ${x.a.status}) is not a list.`);
    const n = leak(x.a);
    if (n) return out("unauthorized-read", `A's list holds ${n} item${n === 1 ? "" : "s"} whose ${d.ownerField} is B's.`, { confidence: "high", fields: [d.ownerField], matched: n });
    return out("protected", `A's list holds none of B's items.`);
}

// ── running a designation ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CrossAccountRun {
    outcomes: CheckOutcome[];
    results: RawResult[];
    /** Plain sentences for the coverage list. */
    lines: string[];
}

const KIND_WORDS: Record<ResourceKind, string> = { item: "item", nested: "nested item", list: "list", search: "search" };

/** Run every designated resource (A's, shared and public ones first, so their values are known), then turn the outcomes into results. */
export async function runCrossAccount(i: { targetUrl: string; designation: Designation; labels: { A: string; B: string }; fetchAs: FetchAs; signal?: AbortSignal }): Promise<CrossAccountRun> {
    const { designation: d } = i;
    const outcomes: CheckOutcome[] = [];
    const lines: string[] = [];
    const aOwn = new Set<string>();
    const order = [...d.resources].sort((x, y) => Number(x.owner === "B") - Number(y.owner === "B"));
    const get = async (who: Identity, path: string): Promise<GuardedAnswer | undefined> => {
        try {
            return await i.fetchAs(who, path);
        } catch (e) {
            if (i.signal?.aborted) throw e;
            return undefined;
        }
    };
    for (const r of order) {
        if (i.signal?.aborted) break;
        const no = refusalOf(r.path);
        if (no) {
            lines.push(`Cross-account: ${r.path} was not requested. ${no}`);
            continue;
        }
        const x: Answers = {};
        if (r.owner === "B") {
            x.b = await get("B", r.path);
            x.visitor = await get("visitor", r.path);
            x.a = await get("A", r.path);
        } else {
            x.a = r.owner === "public" ? undefined : await get("A", r.path);
            if (r.owner === "public") x.visitor = await get("visitor", r.path);
            const own = x.a ?? x.visitor;
            if (own && ok(own)) for (const v of distinctiveValues(parseJson(own)).keys()) aOwn.add(v);
        }
        outcomes.push(classify(r, x, d, aOwn));
    }
    const counts = (c: Classification) => outcomes.filter((o) => o.classification === c).length;
    lines.push(
        `Cross-account (read-only, signed in as ${i.labels.A}, against resources of ${i.labels.B}): ${outcomes.length} of ${d.resources.length} designated resource${d.resources.length === 1 ? "" : "s"} checked; ${counts("unauthorized-read")} readable by ${i.labels.A}, ${counts("visitor-read")} readable signed out, ${counts("protected")} protected, ${counts("inconclusive")} inconclusive. Only GET requests were sent; no request was meant to change anything.`,
    );
    for (const o of outcomes) if (o.classification === "inconclusive") lines.push(`Cross-account, inconclusive: ${o.path}: ${o.reason}`);
    return { outcomes, results: outcomes.flatMap((o) => resultOf(o, i.targetUrl, i.labels)), lines };
}

/** A finding for an unauthorized read (by A or by a visitor); nothing for the other outcomes. No response body is kept. */
export function resultOf(o: CheckOutcome, targetUrl: string, labels: { A: string; B: string }): RawResult[] {
    if (o.classification !== "unauthorized-read" && o.classification !== "visitor-read") return [];
    const url = new URL(o.path, targetUrl).href;
    const what = `${o.label ? `“${o.label}” (${KIND_WORDS[o.kind]})` : `the ${KIND_WORDS[o.kind]}`} at ${o.path}`;
    const byVisitor = o.classification === "visitor-read";
    const reader = byVisitor ? "a signed-out visitor" : labels.A;
    const status = byVisitor ? o.status.visitor : o.status.a;
    return [
        {
            check: "other",
            url,
            custom: {
                key: byVisitor ? "cross-account-visitor-read" : "cross-account-read",
                title: byVisitor ? "Another account's data can be read without signing in" : "One account can read another account's data",
                category: "access-control",
                severity: "high",
                confidence: o.confidence ?? "medium",
                description: `${what} is designated as belonging to ${labels.B}. Requested by ${reader} with a GET, it answered ${status} with ${labels.B}'s data: ${o.reason}`,
                impact: byVisitor ? `Anyone can read ${labels.B}'s data at this address without an account.` : `Any signed-in user may be able to read other users' data by requesting its address (broken object-level authorization).`,
                remediation: "Check on the server, for every request, that the signed-in user may read this record (its owner, or someone it is shared with); answer 403 or 404 otherwise. Do not rely on the user interface hiding the link.",
                reproduction: `${byVisitor ? "Without signing in" : `Signed in as ${labels.A}`}, request GET ${o.path} (designated as ${labels.B}'s). Expected: a refusal or an answer without ${labels.B}'s data. Seen: status ${status}, ${o.matched ?? 0} of ${labels.B}'s values in the fields ${(o.fields ?? []).join(", ") || "of the answer"}.`,
            },
            response: { url, status: status ?? 0, headers: {} },
            note: `Fields holding ${labels.B}'s values: ${(o.fields ?? []).join(", ") || "(the whole answer)"}. ${o.matched ?? 0} value${o.matched === 1 ? "" : "s"} matched. The answer itself is not kept.`,
        },
    ];
}
