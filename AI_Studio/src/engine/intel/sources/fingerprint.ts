/**
 * Source fingerprints: sha256 of a source's normalised content, so an unchanged source is recognised and not processed again. Formatting
 * that does not change meaning (JSON key order and spacing, line endings, trailing spaces) does not change the fingerprint.
 */
import { createHash } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted at every level; arrays keep their order. */
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) out[k] = canonical((value as Record<string, unknown>)[k]);
        return out;
    }
    return value;
}

/** A parsed JSON or YAML document (an OpenAPI document). */
export const fingerprintJson = (value: unknown): string => sha256("json:" + JSON.stringify(canonical(value)));

/** A text file (a schema file, a document, a test): line endings and trailing spaces ignored. */
export function fingerprintText(text: string): string {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return sha256("text:" + lines.join("\n"));
}

/** A repository at a commit. */
export const fingerprintCommit = (commit: string): string => sha256("commit:" + commit.trim().toLowerCase());
