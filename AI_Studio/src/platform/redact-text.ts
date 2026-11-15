/**
 * Masking on write for machine-written free text the platform keeps: job events, job errors, test validation reasons, agent run summaries
 * and steps. Two layers, in this order:
 *   1. the run's known secrets (passwords, authenticator secrets, API tokens) become `[hidden]` (scrubSecrets, agent-routing.ts);
 *   2. the shared pattern redaction (src/shared/redact-text.ts, also used by the security module): e-mail addresses, bearer/basic credentials, JWTs, secret query
 *      parameters, `key=value` secrets, long hex/base64. The rules live there only; this module does not copy them.
 * Record ids (UUIDs) are not secrets and the run log links by them, so one in plain text is kept; a UUID that is the value of a secret-named
 * parameter (`?token=<uuid>`) still goes.
 */
import { redactText } from "../shared/redact-text.js";
import { scrubSecrets } from "./agent-routing.js";

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
/** Stand-in for a UUID while the patterns run: letters only, so no pattern takes it unless it is the value of a secret-named key. */
const holder = (i: number) => `ZqxUuidHolder${String.fromCharCode(97 + (i % 26)).repeat(1 + Math.floor(i / 26))}Zqx`;
const HOLDER = /ZqxUuidHolder([a-z]+)Zqx/g;
/** Longer than anything the stores keep: the callers cut to their own sizes. */
const NO_CUT = 1_000_000;

/** One piece of text with the run's secrets and the shared patterns masked. */
export function maskText(input: string, secrets: readonly string[] = []): string {
    const known = scrubSecrets(String(input ?? ""), [...secrets]);
    const ids: string[] = [];
    const held = known.replace(UUID, (m) => holder(ids.push(m) - 1));
    if (ids.length === 0) return redactText(known, NO_CUT);
    return redactText(held, NO_CUT).replace(HOLDER, (_m, s: string) => ids[(s.length - 1) * 26 + (s.charCodeAt(0) - 97)] ?? "");
}

/** Same, for text that may be absent. */
export const maskOptional = <T extends string | null | undefined>(input: T, secrets: readonly string[] = []): T => (typeof input === "string" ? (maskText(input, secrets) as T) : input);

/** Every string inside a JSON-like value masked (keys stay); numbers, booleans and nulls are left as they are. */
export function maskValue<T>(value: T, secrets: readonly string[] = []): T {
    const walk = (v: unknown): unknown => {
        if (typeof v === "string") return maskText(v, secrets);
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(value) as T;
}
