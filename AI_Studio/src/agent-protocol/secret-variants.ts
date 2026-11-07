/**
 * The forms a secret usually takes inside text, so masking catches more than the exact string: URL-encoded (as in a sign-in address or a
 * form body), with `+` for spaces, with lower-case hex escapes, JSON-escaped (as inside a quoted JSON body), and `encodeURI`'s form. The
 * same list the failure evidence uses (engine/evidence/capture.ts, evidenceSecrets), shared by the platform's scrub (agent-routing.ts) and
 * the runner's log (src/agent/log.ts). Values shorter than 4 characters are never returned: masking them would shred every line.
 */
export function secretVariants(secret: string): string[] {
    if (typeof secret !== "string" || secret.length < 4) return [];
    const out = new Set<string>([secret]);
    // A "Name: value" header: the value alone must not survive either.
    const header = /^[A-Za-z][\w-]*:\s*(.{4,})$/.exec(secret);
    if (header) out.add(header[1]!);
    try {
        const enc = encodeURIComponent(secret);
        out.add(enc);
        out.add(enc.replace(/%20/g, "+"));
        out.add(enc.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()));
    } catch {
        /* an unpaired surrogate: the other forms still apply */
    }
    out.add(JSON.stringify(secret).slice(1, -1));
    try {
        out.add(encodeURI(secret));
    } catch {
        /* as above */
    }
    return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}
