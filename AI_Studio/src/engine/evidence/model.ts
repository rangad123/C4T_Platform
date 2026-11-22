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
import { maskText } from "../../platform/redact-text.js";
import { runSecretValues, type RunSecretsEnv } from "./secret-policy.js";

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
    /** One allow-listed correlation header of the response, "name: value", masked and capped (newer scripts only). */
    corr: z.string().max(160).optional(),
});
const ConsoleSchema = z.object({
    t: num,
    step: z.number().int().min(0).max(10_000),
    type: z.string().max(16),
    text: z.string().max(EVIDENCE_MAX_TEXT + 8),
    loc: z.string().max(300).optional(),
    /** A page error's first stack frames, masked (newer scripts only). */
    stack: z.string().max(1600).optional(),
});
const StepSchema = z.object({
    n: z.number().int().min(0).max(10_000),
    t: num,
    ms: z.number().finite().min(0).max(86_400_000).optional(),
    /** Where the page was when the step began: path (and host when it is not the application's own), masked (newer scripts only). */
    url: z.string().max(520).optional(),
    title: z.string().max(130).optional(),
});
const FootprintPageSchema = z.object({ path: z.string().max(260), step: z.number().int().min(0).max(10_000) });
const FootprintEndpointSchema = z.object({
    method: z.string().max(12),
    host: z.string().max(120).optional(),
    path: z.string().max(260),
    step: z.number().int().min(0).max(10_000),
    n: z.number().int().min(1).max(1_000_000),
    statuses: z.array(z.number().int().min(0).max(999)).max(4),
    ms: num.optional(),
    /** Not fetch/XHR: a form sent to the server ("document"), a WebSocket, an EventSource stream, a beacon (newer scripts only). */
    type: z.enum(["document", "websocket", "eventsource", "beacon"]).optional(),
});
/** Footprint caps: what does not fit is left out and the footprint says "truncated". */
export const FOOTPRINT_MAX_PAGES = 40;
export const FOOTPRINT_MAX_ENDPOINTS = 80;
/**
 * What a test touched (pages, also routes reached inside the page, endpoints): the compact record a passing run keeps instead of full
 * evidence, and a section of full evidence too. `unclassified`: requests of a kind it does not map; `truncated`: something was left out.
 */
const FootprintSchema = z.object({
    pages: z.array(z.unknown()).max(200),
    endpoints: z.array(z.unknown()).max(400),
    unclassified: z.number().int().min(0).optional(),
    truncated: z.boolean().optional(),
});
export interface EvidenceFootprint {
    pages: Array<z.infer<typeof FootprintPageSchema>>;
    endpoints: Array<z.infer<typeof FootprintEndpointSchema>>;
    unclassified?: number;
    truncated?: true;
}
const EvidenceSchema = z.object({
    v: z.literal(1),
    durationMs: num,
    counts: z.object({ requests: z.number().int().min(0), requestsKept: z.number().int().min(0), console: z.number().int().min(0), consoleKept: z.number().int().min(0) }),
    steps: z.array(z.unknown()).max(500),
    requests: z.array(z.unknown()).max(5000),
    console: z.array(z.unknown()).max(5000),
    footprint: FootprintSchema.optional(),
    captcha: z.unknown().optional(),
});
/** A captcha a person could see when the test failed (auth/captcha.ts CAPTCHA_PROBE_SOURCE). */
const CaptchaSchema = z.object({
    kind: z.enum(["reCAPTCHA", "hCaptcha", "Turnstile"]),
    w: z.number().int().min(0).max(100_000),
    h: z.number().int().min(0).max(100_000),
    inForm: z.boolean(),
    form: z.string().max(80).optional(),
    path: z.string().max(260),
});

export type EvidenceRequest = z.infer<typeof RequestSchema>;
export type EvidenceConsoleLine = z.infer<typeof ConsoleSchema>;
export interface Evidence {
    v: 1;
    durationMs: number;
    counts: { requests: number; requestsKept: number; console: number; consoleKept: number };
    /** `ms`: how long the step took, from the test runner's report (added by the platform; older evidence has none). */
    steps: Array<{ n: number; t: number; ms?: number; url?: string; title?: string }>;
    requests: EvidenceRequest[];
    console: EvidenceConsoleLine[];
    /** Present on a passing run's record (requests and console are then empty). */
    footprint?: EvidenceFootprint;
    /** A failed run: the captcha widget a person could see on the page when it failed. */
    captcha?: z.infer<typeof CaptchaSchema>;
}

/**
 * Every secret of the run, as exact strings, in the forms the evidence helper masks (the platform knows them; the script masks them again
 * from its environment). The same list as the failure traces (secret-policy.ts): accounts, tokens, the auth header, a Basic sign-in's
 * base64, the saved sign-in's values and secret-named settings.
 */
export function secretsOfRun(env: RunSecretsEnv): string[] {
    return loadEvidenceRuntime().evidenceSecrets(runSecretValues(env));
}

/**
 * The evidence as it may be stored, or undefined when the attachment is not evidence. `secrets` are the exact credentials of
 * the run (see secretsOfRun). Idempotent: sanitizing stored evidence again changes nothing.
 */
export function sanitizeEvidence(raw: unknown, secrets: string[] = []): Evidence | undefined {
    const top = EvidenceSchema.safeParse(raw);
    if (!top.success) return undefined;
    const rt = loadEvidenceRuntime();
    // The shared redaction too (e-mails also URL-encoded, phone numbers, addresses, cards, `bearer:` lines, secret query values once
    // decoded): the script's own rules are a smaller set it carries with it.
    const mask = (s: string, max: number) => rt.evidenceText(maskText(s, secrets), secrets, max);
    // A stored path goes through the same address cleaning as a live request (sensitive query values, tokens), not just the text rules.
    // A step's address is a path, or host + path for another site's page: cleaned like a request's.
    const cleanStepUrl = (u: string) => (u.startsWith("/") ? cleanPath(u) : mask(u, 500));
    const cleanPath = (path: string) => maskText(rt.evidenceSplitUrl(`http://placeholder.invalid${path.startsWith("/") ? "" : "/"}${path}`, "placeholder.invalid", secrets).path, secrets);

    const requests: EvidenceRequest[] = [];
    for (const r of top.data.requests) {
        const p = RequestSchema.safeParse(r);
        if (!p.success) continue;
        const { host, failed, corr, ...rest } = p.data;
        requests.push({
            ...rest,
            method: mask(p.data.method, 12),
            type: mask(p.data.type, 24),
            path: cleanPath(p.data.path),
            ...(host ? { host: mask(host, 100) } : {}),
            ...(failed ? { failed: mask(failed, 120) } : {}),
            ...(corr ? { corr: mask(corr, 150) } : {}),
        });
    }
    const lines: EvidenceConsoleLine[] = [];
    for (const c of top.data.console) {
        const p = ConsoleSchema.safeParse(c);
        if (!p.success) continue;
        lines.push({ ...p.data, type: mask(p.data.type, 16), text: mask(p.data.text, EVIDENCE_MAX_TEXT), ...(p.data.loc ? { loc: mask(p.data.loc, 300) } : {}), ...(p.data.stack ? { stack: mask(p.data.stack, 1500) } : {}) });
    }
    const steps: Evidence["steps"] = [];
    for (const s of top.data.steps) {
        const p = StepSchema.safeParse(s);
        if (!p.success) continue;
        const { url, title, ...rest } = p.data;
        steps.push({ ...rest, ...(url ? { url: cleanStepUrl(url) } : {}), ...(title ? { title: mask(title, 120) } : {}) });
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
    const captcha = CaptchaSchema.safeParse(top.data.captcha);
    if (captcha.success) out.captcha = { ...captcha.data, path: cleanPath(captcha.data.path).split("?")[0]!.slice(0, 200), ...(captcha.data.form ? { form: mask(captcha.data.form, 60) } : {}) };
    if (top.data.footprint) {
        const fp = top.data.footprint;
        // An entry that does not fit the schema or the caps is left out, and then the footprint is no longer the whole story.
        let truncated = fp.truncated === true;
        // A page keeps its hash route ("/app#/cart/7"): the route is cleaned as a path of its own (the address cleaning drops fragments).
        const cleanPage = (path: string) => {
            const at = path.indexOf("#");
            const base = cleanStepUrl(at >= 0 ? path.slice(0, at) : path);
            const route = at >= 0 ? path.slice(at + 1).split("?")[0]! : "";
            return (route.startsWith("/") ? `${base}#${cleanPath(route).split("?")[0]!.slice(0, 120)}` : base).slice(0, 200);
        };
        const pages: EvidenceFootprint["pages"] = [];
        for (const x of fp.pages) {
            const p = FootprintPageSchema.safeParse(x);
            if (p.success && pages.length < FOOTPRINT_MAX_PAGES) pages.push({ ...p.data, path: cleanPage(p.data.path) });
            else truncated = true;
        }
        const endpoints: EvidenceFootprint["endpoints"] = [];
        for (const x of fp.endpoints) {
            const p = FootprintEndpointSchema.safeParse(x);
            if (!p.success || endpoints.length >= FOOTPRINT_MAX_ENDPOINTS) {
                truncated = true;
                continue;
            }
            const { host, ...e } = p.data;
            endpoints.push({ ...e, method: mask(e.method, 12), path: cleanPath(e.path).split("?")[0]!.slice(0, 200), ...(host ? { host: mask(host, 100) } : {}) });
        }
        out.footprint = { pages, endpoints, ...(fp.unclassified ? { unclassified: fp.unclassified } : {}), ...(truncated ? { truncated: true as const } : {}) };
    }
    // A last guard on the stored size: shorten every console line until it fits.
    for (const max of [1000, 400, 120]) {
        if (JSON.stringify(out).length <= EVIDENCE_MAX_BYTES) break;
        out.console = out.console.map((l) => ({ ...l, text: l.text.slice(0, max), ...(l.stack ? { stack: l.stack.slice(0, max) } : {}) }));
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
