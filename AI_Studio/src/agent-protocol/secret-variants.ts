/**
 * The forms a secret usually takes inside text, so masking catches more than the exact string: URL-encoded (as in a sign-in address),
 * form-encoded (an HTML form's body or `URLSearchParams`: `!'()~` escaped too and `+` for spaces), the strict RFC 3986 form many HTTP
 * libraries send (`!'()*` escaped), each also with lower-case hex escapes, JSON-escaped (as inside a quoted JSON body), `encodeURI`'s
 * form, and base64 (standard, without its padding, and URL-safe: a share link or a token that carries the secret encoded). A base64 copy
 * is found only when the secret starts the encoded text (base64 of a longer text holding it elsewhere differs throughout). Shared by the platform's scrub (agent-routing.ts), the runner's log (src/agent/log.ts) and failure traces
 * (engine/evidence/trace-scrub.ts). The failure evidence helper pasted into every script (engine/evidence/capture.ts, evidenceSecrets)
 * keeps its own shorter copy. Values shorter than 4 characters are never returned: masking them would shred every line.
 */
export function secretVariants(secret: string): string[] {
    if (typeof secret !== "string" || secret.length < 4) return [];
    const out = new Set<string>([secret]);
    // A "Name: value" header: the value alone must not survive either.
    const header = /^[A-Za-z][\w-]*:\s*(.{4,})$/.exec(secret);
    if (header) out.add(header[1]!);
    const lowerHex = (v: string): string => v.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase());
    try {
        const enc = encodeURIComponent(secret);
        out.add(enc);
        out.add(enc.replace(/%20/g, "+"));
        out.add(lowerHex(enc));
        // RFC 3986 strict (qs, axios and others): encodeURIComponent leaves !'()* as they are.
        const strict = enc.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        out.add(strict);
        out.add(lowerHex(strict));
    } catch {
        /* an unpaired surrogate: the other forms still apply */
    }
    // application/x-www-form-urlencoded, as a browser sends a form and URLSearchParams writes it: only A-Z a-z 0-9 * - . _ stay, a space is "+".
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    out.add(form);
    out.add(lowerHex(form));
    out.add(JSON.stringify(secret).slice(1, -1));
    try {
        out.add(encodeURI(secret));
    } catch {
        /* as above */
    }
    const b64 = Buffer.from(secret, "utf8").toString("base64");
    out.add(b64);
    out.add(b64.replace(/=+$/, ""));
    out.add(Buffer.from(secret, "utf8").toString("base64url"));
    return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}
