/**
 * A leak check that does not trust the cleaner's own list of forms (secret-variants.ts, trace-scrub.ts traceSecretForms): every part is
 * decoded the usual ways (percent and form decoding, HTML entities, JSON escapes once and twice, UTF-16) and the plain value is looked for
 * in what comes out, plus its base64. A form the cleaner does not know about is found here as long as one of these decodings undoes it.
 * Values are compared as bytes (latin1), so it is meant for ASCII secrets.
 */
const percent = (s: string, plusIsSpace: boolean): string => (plusIsSpace ? s.replace(/\+/g, " ") : s).replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
const entities = (s: string): string =>
    s
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
const unescapeJson = (s: string): string => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(["\\/'])/g, "$1");

/** The text of some bytes, decoded every way the check knows. */
function decodings(bytes: Uint8Array): string[] {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Set<string>();
    for (const raw of [buf.toString("latin1"), buf.toString("utf16le")]) {
        for (const a of [raw, unescapeJson(raw), unescapeJson(unescapeJson(raw))]) {
            for (const b of [a, entities(a)]) for (const c of [b, percent(b, false), percent(b, true)]) out.add(c).add(percent(c, false));
        }
    }
    return [...out];
}

/** Which of these secrets can still be read in which part ("Pa!s… in resources/x.dat"); empty when none can. */
export function readableSecrets(parts: Record<string, Uint8Array>, secrets: readonly string[]): string[] {
    const found: string[] = [];
    for (const [name, bytes] of Object.entries(parts)) {
        const texts = decodings(bytes);
        for (const secret of secrets) {
            const plain = Buffer.from(secret, "utf8").toString("latin1");
            const b64 = Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, "");
            if (texts.some((t) => t.includes(plain) || t.includes(b64))) found.push(`${secret.slice(0, 4)}… in ${name}`);
        }
    }
    return found;
}
