/**
 * The shape of stored failure evidence, and the one function that decides what may be stored: `sanitizeEvidence`.
 *
 * A script attached the evidence, and scripts come from untrusted input (page content, imported specs, model output), so
 * nothing in it is trusted: it is parsed against a strict schema, every string is masked again with the same functions the
 * script used (plus the credentials of this run, which only the platform knows for sure), every list is capped, and what does
 * not fit the schema is dropped. Nothing else ever reads the raw attachment.
 */
import { z } from "zod";
import { EVIDENCE_MAX_CONSOLE, EVIDENCE_MAX_REQUESTS, EVIDENCE_MAX_TEXT, loadEvidenceRuntime } from "./capture.js";

/** The stored file may not be larger than this (it is far below it unless every console line is huge). */
export const EVIDENCE_MAX_BYTES = 600_000;

const num = z.number().finite();
const RequestSchema = z.object({
    t: num,
    step: z.number().int().min(0).max(10_000),
    method: z.string().max(12),
    type: z.string().max(24),
    path: z.string().max(500),
    host: z.string().max(120).optional(),
    status: z.number().int().min(0).max(999).optional(),
    ms: num.optional(),
    size: num.optional(),
    failed: z.string().max(200).optional(),
    aborted: z.boolean().optional(),
    pending: z.boolean().optional(),
});
const ConsoleSchema = z.object({
    t: num,
    step: z.number().int().min(0).max(10_000),
    type: z.string().max(16),
    text: z.string().max(EVIDENCE_MAX_TEXT + 8),
    loc: z.string().max(300).optional(),
});
const EvidenceSchema = z.object({
    v: z.literal(1),
    durationMs: num,
    counts: z.object({ requests: z.number().int().min(0), requestsKept: z.number().int().min(0), console: z.number().int().min(0), consoleKept: z.number().int().min(0) }),
    steps: z.array(z.unknown()).max(500),
    requests: z.array(z.unknown()).max(5000),
    console: z.array(z.unknown()).max(5000),
});

export type EvidenceRequest = z.infer<typeof RequestSchema>;
export type EvidenceConsoleLine = z.infer<typeof ConsoleSchema>;
export interface Evidence {
    v: 1;
    durationMs: number;
    counts: { requests: number; requestsKept: number; console: number; consoleKept: number };
    steps: Array<{ n: number; t: number }>;
    requests: EvidenceRequest[];
    console: EvidenceConsoleLine[];
}

/** Every credential the run used, as exact strings (the platform knows them; the script masks them again from its environment). */
export function secretsOfRun(env: {
    credentials?: { password?: string; totpSecret?: string };
    roles?: Array<{ password?: string; totpSecret?: string; apiToken?: string }>;
    apiToken?: string;
    apiAuthHeader?: string;
}): string[] {
    const list = [env.credentials?.password, env.credentials?.totpSecret, env.apiToken, env.apiAuthHeader, ...(env.roles ?? []).flatMap((r) => [r.password, r.totpSecret, r.apiToken])];
    return loadEvidenceRuntime().evidenceSecrets(list.filter((s): s is string => typeof s === "string" && s.length >= 4));
}

/**
 * The evidence as it may be stored, or undefined when the attachment is not evidence. `secrets` are the exact credentials of
 * the run (see secretsOfRun). Idempotent: sanitizing stored evidence again changes nothing.
 */
export function sanitizeEvidence(raw: unknown, secrets: string[] = []): Evidence | undefined {
    const top = EvidenceSchema.safeParse(raw);
    if (!top.success) return undefined;
    const rt = loadEvidenceRuntime();
    const mask = (s: string, max: number) => rt.evidenceText(s, secrets, max);
    // A stored path goes through the same address cleaning as a live request (sensitive query values, tokens), not just the text rules.
    const cleanPath = (path: string) => rt.evidenceSplitUrl(`http://placeholder.invalid${path.startsWith("/") ? "" : "/"}${path}`, "placeholder.invalid", secrets).path;

    const requests: EvidenceRequest[] = [];
    for (const r of top.data.requests) {
        const p = RequestSchema.safeParse(r);
        if (!p.success) continue;
        const { host, failed, ...rest } = p.data;
        requests.push({
            ...rest,
            method: mask(p.data.method, 12),
            type: mask(p.data.type, 24),
            path: cleanPath(p.data.path),
            ...(host ? { host: mask(host, 100) } : {}),
            ...(failed ? { failed: mask(failed, 120) } : {}),
        });
    }
    const lines: EvidenceConsoleLine[] = [];
    for (const c of top.data.console) {
        const p = ConsoleSchema.safeParse(c);
        if (!p.success) continue;
        lines.push({ ...p.data, type: mask(p.data.type, 16), text: mask(p.data.text, EVIDENCE_MAX_TEXT), ...(p.data.loc ? { loc: mask(p.data.loc, 300) } : {}) });
    }
    const steps: Evidence["steps"] = [];
    for (const s of top.data.steps) {
        const p = z.object({ n: z.number().int().min(0).max(10_000), t: num }).safeParse(s);
        if (p.success) steps.push(p.data);
    }

    const keptRequests = capKeepingErrors(requests, EVIDENCE_MAX_REQUESTS, (r) => r.status === undefined || r.status >= 400 || Boolean(r.failed));
    const keptLines = capKeepingErrors(lines, EVIDENCE_MAX_CONSOLE, (l) => l.type === "error" || l.type === "pageerror" || l.type === "warning");
    const out: Evidence = {
        v: 1,
        durationMs: top.data.durationMs,
        // The totals are the script's count of what really happened; kept honest but never smaller than what is listed.
        counts: {
            requests: Math.max(top.data.counts.requests, keptRequests.length),
            requestsKept: keptRequests.length,
            console: Math.max(top.data.counts.console, keptLines.length),
            consoleKept: keptLines.length,
        },
        steps: steps.slice(-200),
        requests: keptRequests,
        console: keptLines,
    };
    // A last guard on the stored size: shorten every console line until it fits.
    for (const max of [1000, 400, 120]) {
        if (JSON.stringify(out).length <= EVIDENCE_MAX_BYTES) break;
        out.console = out.console.map((l) => ({ ...l, text: l.text.slice(0, max) }));
    }
    return JSON.stringify(out).length <= EVIDENCE_MAX_BYTES ? out : undefined;
}

/** Keep at most `max` entries, dropping the oldest uninteresting ones first. */
function capKeepingErrors<T>(list: T[], max: number, interesting: (x: T) => boolean): T[] {
    if (list.length <= max) return list;
    const out = [...list];
    while (out.length > max) {
        let at = out.findIndex((x) => !interesting(x));
        if (at < 0) at = 0;
        out.splice(at, 1);
    }
    return out;
}

/** Parse a stored (or attached) JSON text. Undefined when it is not valid evidence. */
export function parseEvidence(text: string, secrets: string[] = []): Evidence | undefined {
    if (text.length > 4_000_000) return undefined;
    try {
        return sanitizeEvidence(JSON.parse(text) as unknown, secrets);
    } catch {
        return undefined;
    }
}
