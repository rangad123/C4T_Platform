/**
 * Failure traces without the run's secrets.
 *
 * A Playwright trace of a failed test keeps what the test typed and what the browser sent and received: the password of a `fill` (in the
 * action log, its call log and the page snapshot's input value), form bodies, request and response headers (an Authorization header,
 * cookies), response bodies, console lines and the error-context attachment. Taqwright's trace is one HTML file with the same kind of
 * content. Everything in a trace that is text is masked here with every known secret of the run, in the forms text carries it in; a part
 * that is not text (a screenshot, a font) is kept as it is, unless the secret is found in it, and then the whole trace is refused: a file
 * that cannot be cleaned safely is not sent or kept at all.
 *
 * Used where a trace leaves the computer that ran the test (the runner, before upload: src/agent/task-runner.ts), where the platform takes
 * it from a runner (agent-services.ts, collect, for runners that do not clean it yet), and after a run on the platform itself
 * (validation/runner.ts). The trace still opens in Playwright's viewer. Playwright names a resource after the sha1 of its content
 * (`resources/<sha1>.dat`), so a part that is masked gets the sha1 of its cleaned content as its new name, and every reference to the old
 * name in the trace's text is rewritten in the same pass: an old name would let anyone with the trace test a guessed password with one
 * hash. While masking, the references to the trace's own parts (resource sha1s, screencast frame names) are set aside, so a short secret
 * that happens to match inside one does not break it.
 *
 * A value is replaced by "[hidden]", in one pass (a value inside "[hidden]" itself, such as `hidden`, does not stop the cleaning). A value
 * made only of digits is replaced by as many 9s instead, so a number in the trace's JSON stays a number and the viewer still opens it.
 *
 * The work does not hold up the process that does it (on the platform, the one process that also answers the website): the archive is read
 * from its central directory, each part is unpacked and packed again by node:zlib on its thread pool, and the masking yields to other work
 * every few milliseconds. Unpacking is bounded by the sizes the archive declares and checked against what really comes out (a part bigger
 * or smaller than it says, or with the wrong checksum, refuses the trace). Only the parts that changed are packed again; the others keep
 * their original bytes. One trace is cleaned at a time per process.
 *
 * Limits: masking is by known value (at least 4 characters). A value the test made itself (a code generated from an authenticator secret,
 * a password a code script holds in its own source), a secret transformed some other way, and anything inside a compressed part (a zip or
 * gzip body the application served) are not found. Screenshots and the video are pictures: a password field is drawn as dots, but a secret
 * shown as text on the page stays visible in them. Environment variables are plain settings, not secrets: only those whose name says they
 * are one (`DB_PASSWORD`, `API_KEY`, `..._TOKEN`) are masked like an account's password. A secret that looks like a number but is not
 * only digits (`-1234`, `12.50`), or one equal to a JSON word (`true`, `null`), becomes "[hidden]" where it stands outside a string too,
 * so that JSON line no longer parses (the trace still opens; that step's details do not). A value made of digits also changes the numbers
 * it is part of (a timestamp, a size).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { webcrypto } from "node:crypto";
import zlib from "node:zlib";
import { secretVariants } from "../../agent-protocol/secret-variants.js";
import { parseStorageState, secretValuesOf } from "../auth/storage-state.js";

/**
 * What a trace may hold before it is refused unread. A failure trace is mostly screenshots, page snapshots and the bodies the page loaded:
 * tens of MB unpacked for a long test. The limits leave room for that and bound what one upload makes the platform unpack (it cleans every
 * trace a runner sends again); a bigger trace is not a normal failure trace, and refusing it is the safe answer.
 */
export const TRACE_LIMITS = { maxEntries: 20_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 } as const;
const HIDDEN = "[hidden]";
/** Stands for a masked value until every value is masked: text parts hold no NUL (asText), so no later value can match across it. */
const MASK = "\0";

/** The sentence a run shows when a trace was held back. */
export const TRACE_WITHHELD = "The trace was not attached: it could not be cleaned of the run's passwords and tokens safely";

/** Every secret of a run's environment, as exact strings: accounts, tokens, an auth header and its value, a Basic sign-in's base64, a saved sign-in's values. */
export function traceSecretsOfRun(env: {
    credentials?: { username?: string; password?: string; totpSecret?: string } | undefined;
    roles?: Array<{ username?: string; password?: string; totpSecret?: string; apiToken?: string }> | undefined;
    apiToken?: string | undefined;
    apiAuthHeader?: string | undefined;
    storageState?: string | undefined;
    vars?: Record<string, string> | undefined;
}): string[] {
    const out: Array<string | undefined> = [env.credentials?.password, env.credentials?.totpSecret, env.apiToken, env.apiAuthHeader];
    for (const r of env.roles ?? []) out.push(r.password, r.totpSecret, r.apiToken);
    // An environment's variables are plain settings; one named like a secret is treated as one.
    for (const [name, value] of Object.entries(env.vars ?? {})) if (SECRET_VAR_NAME.test(name)) out.push(value);
    for (const c of [env.credentials, ...(env.roles ?? [])]) {
        if (!c?.password || c.password.length < 4) continue;
        const b64 = Buffer.from(`${c.username ?? ""}:${c.password}`, "utf8").toString("base64");
        out.push(b64, b64.replace(/=+$/, ""));
    }
    if (env.storageState) {
        try {
            out.push(...secretValuesOf(parseStorageState(env.storageState)));
        } catch {
            /* a saved sign-in that does not parse was not used by the run */
        }
    }
    return out.filter((s): s is string => typeof s === "string" && s.length >= 4);
}

/** An environment variable whose name says it holds a secret (DB_PASSWORD, API_KEY, STRIPE_TOKEN, ...). */
const SECRET_VAR_NAME = /(?:pass(?:word|code|phrase)?|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|totp|auth[_-]?header|credentials?)$/i;

/** The secrets in a test process's environment (TEST_PASSWORD, TEST_<NAME>_API_TOKEN, API_AUTH_HEADER, TEST_ENV_<SECRET-LIKE NAME> ...): for runners that only have that. */
export function traceSecretsOfChildEnv(env: NodeJS.ProcessEnv): string[] {
    return Object.entries(env)
        .filter(([k, v]) => typeof v === "string" && v.length >= 4 && (/(?:^|_)(?:PASSWORD|SECRET|TOKEN|AUTH_HEADER)$/.test(k) || (k.startsWith("TEST_ENV_") && SECRET_VAR_NAME.test(k.slice(9)))))
        .map(([, v]) => v as string);
}

const htmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const jsonInner = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * The forms a secret takes inside a trace: the shared ones (secret-variants.ts: exact, URL-encoded, form-encoded, JSON-escaped, `encodeURI`),
 * plus HTML escaping (a page snapshot, an HTML trace), JSON escaped twice (a title quoted inside a JSON string) and plain base64. Longest
 * first.
 */
export function traceSecretForms(secrets: readonly string[]): string[] {
    const out = new Set<string>();
    for (const s of secrets) {
        if (typeof s !== "string" || s.length < 4) continue;
        for (const v of secretVariants(s)) {
            out.add(v);
            out.add(htmlEscape(v));
            out.add(jsonInner(v));
        }
        out.add(jsonInner(jsonInner(s)));
        const b64 = Buffer.from(s, "utf8").toString("base64");
        out.add(b64);
        out.add(b64.replace(/=+$/, ""));
    }
    return [...out].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
}

export type TraceScrubResult = { ok: true; data: Uint8Array; masked: number } | { ok: false; reason: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });
const startsWith = (b: Uint8Array, sig: number[], at = 0): boolean => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const isZip = (b: Uint8Array): boolean => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]);
/** Pictures, fonts and films: never text. */
function isMedia(b: Uint8Array): boolean {
    return (
        startsWith(b, [0xff, 0xd8, 0xff]) || // JPEG
        startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || // PNG
        startsWith(b, [0x47, 0x49, 0x46, 0x38]) || // GIF
        (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) || // WebP
        startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) || // WebM
        startsWith(b, [0x66, 0x74, 0x79, 0x70], 4) // MP4
    );
}

/** Text: valid UTF-8 without a NUL byte (UTF-16 text has NULs and is checked as bytes instead). */
function asText(b: Uint8Array): string | undefined {
    if (b.includes(0)) return undefined;
    try {
        return utf8.decode(b);
    } catch {
        return undefined;
    }
}

/** Yields to the event loop when the work has held it for a few milliseconds (other requests are answered in between). */
type Pace = () => Promise<void>;
function pacer(sliceMs = 8): Pace {
    let since = performance.now();
    return async () => {
        if (performance.now() - since < sliceMs) return;
        await new Promise<void>((r) => setImmediate(r));
        since = performance.now();
    };
}

/** The forms, ready to search for: as text, and as the bytes of UTF-8 and UTF-16 text. */
interface Needles {
    forms: readonly string[];
    bytes: Buffer[];
}
const needlesOf = (forms: readonly string[]): Needles => ({ forms, bytes: forms.flatMap((f) => [Buffer.from(f, "utf8"), Buffer.from(f, "utf16le")]) });

/** Stand for the digits of a masked number until the end: they become 9s (8s for a value that is all 9s), so a JSON number stays one. */
const NINE = "\u0001";
const EIGHT = "\u0002";
const digitsMask = (form: string, sentinels: boolean): string => {
    const nines = /^9+$/.test(form);
    return (sentinels ? (nines ? EIGHT : NINE) : nines ? "8" : "9").repeat(form.length);
};

/**
 * The trace's references to its own parts: `keys` are the sha1s and frame names that the parts' names hold (`resources/<sha1>.dat`,
 * `screencast/page@<id>-<time>.jpeg`); `renamed` maps the sha1 of a resource that was masked to the sha1 of its cleaned content.
 */
interface Refs {
    keys: ReadonlySet<string>;
    renamed: ReadonlyMap<string, string>;
}
/** A run of hex that may be a part's name: a sha1, or a frame's page id with its time. */
const REF = /[0-9a-f]{32,}(?:-\d+)?/g;
/** A reference set aside while masking: U+0003, its number in U+E000-U+E00F digits, U+0004 (characters a trace's text does not hold). */
const SET_ASIDE = /[\u0003\u0004\uE000-\uE00F]/;
const setAside = (i: number): string => `\u0003${[...i.toString(16)].map((d) => String.fromCharCode(0xe000 + parseInt(d, 16))).join("")}\u0004`;
const SET_ASIDE_REF = /\u0003([\uE000-\uE00F]+)\u0004/g;
const setAsideIndex = (code: string): number => parseInt([...code].map((c) => (c.charCodeAt(0) - 0xe000).toString(16)).join(""), 16);

/**
 * Mask every form in a text, longest first, in one pass: a masked value becomes a stand-in that no form can match across, so no form is
 * left in what was the original text afterwards, and "[hidden]" (or the 9s) go in only at the end: a form inside them, such as `hidden`
 * or `9999`, is not matched again. A value made only of digits is masked digit for digit. With `refs`, the references to the trace's own
 * parts are set aside first (a short secret inside a sha1 is not masked there) and put back afterwards under the parts' new names.
 */
async function maskText(text: string, n: Needles, pace: Pace, refs?: Refs): Promise<{ text: string; masked: number; changed: boolean }> {
    // The digit stand-ins are control characters; in the rare text that already has them, the digits go in directly.
    const sentinels = !text.includes(NINE) && !text.includes(EIGHT);
    let out = text;
    let masked = 0;
    let remapped = 0;
    const asideKeys: string[] = [];
    const aside = refs !== undefined && refs.keys.size > 0 && !SET_ASIDE.test(text);
    if (refs && refs.keys.size > 0) {
        await pace();
        const index = new Map<string, number>();
        out = out.replace(REF, (m) => {
            if (!refs.keys.has(m)) return m;
            if (!aside) {
                // No stand-in possible: the new name goes in now (a short secret inside it may still be masked).
                const to = refs.renamed.get(m);
                if (to) remapped++;
                return to ?? m;
            }
            let i = index.get(m);
            if (i === undefined) index.set(m, (i = asideKeys.push(m) - 1));
            return setAside(i);
        });
    }
    for (const f of n.forms) {
        await pace();
        if (f.includes(MASK) || (sentinels && (f.includes(NINE) || f.includes(EIGHT))) || (aside && SET_ASIDE.test(f)) || !out.includes(f)) continue;
        const parts = out.split(f);
        masked += parts.length - 1;
        out = parts.join(/^\d+$/.test(f) ? digitsMask(f, sentinels) : MASK);
    }
    if (aside && asideKeys.length > 0) {
        await pace();
        out = out.replace(SET_ASIDE_REF, (_, code: string) => {
            const key = asideKeys[setAsideIndex(code)]!;
            const to = refs!.renamed.get(key);
            if (to) remapped++;
            return to ?? key;
        });
    }
    if (masked === 0 && remapped === 0) return { text, masked: 0, changed: false };
    if (masked > 0) {
        out = out.replaceAll(MASK, HIDDEN);
        if (sentinels) out = out.replaceAll(NINE, "9").replaceAll(EIGHT, "8");
    }
    return { text: out, masked, changed: true };
}

/** Does a secret appear in these bytes (as UTF-8 or UTF-16 text)? */
async function holdsSecret(b: Uint8Array, n: Needles, pace: Pace): Promise<boolean> {
    const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    for (const needle of n.bytes) {
        await pace();
        if (buf.includes(needle)) return true;
    }
    return false;
}

/** One part of a trace (or a whole non-zip trace): masked text, unchanged bytes, or undefined when it cannot be cleaned. */
async function scrubPart(b: Uint8Array, n: Needles, pace: Pace, refs?: Refs): Promise<{ data: Uint8Array; masked: number; changed: boolean } | undefined> {
    const text = isMedia(b) ? undefined : asText(b);
    if (text === undefined) return (await holdsSecret(b, n, pace)) ? undefined : { data: b, masked: 0, changed: false };
    await pace();
    const m = await maskText(text, n, pace, refs);
    return { data: m.changed ? Buffer.from(m.text, "utf8") : b, masked: m.masked, changed: m.changed };
}

/** A resource Playwright named after the sha1 of its content. */
const RESOURCE = /^resources\/([0-9a-f]{40})(\.[A-Za-z0-9]+)?$/;
const sha1Hex = async (b: Uint8Array): Promise<string> => Buffer.from(await webcrypto.subtle.digest("SHA-1", b)).toString("hex");

// ── zip, read from its central directory and written again with node:zlib (its work runs on the thread pool) ──────────────────────────

interface ZipEntry {
    name: string;
    nameBytes: Buffer;
    madeBy: number;
    flags: number;
    method: number;
    time: number;
    date: number;
    crc: number;
    size: number;
    originalSize: number;
    attrs: number;
    dataStart: number;
}

/** The entries of a zip in their order, or undefined when it is not one this reader takes (broken, zip64, split, encrypted, out of bounds). */
function readZip(b: Buffer): ZipEntry[] | undefined {
    let eocd = -1;
    for (let i = b.length - 22, min = Math.max(0, b.length - 22 - 0xffff); i >= min; i--) {
        if (b.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) return undefined;
    const count = b.readUInt16LE(eocd + 10);
    const cdSize = b.readUInt32LE(eocd + 12);
    const cdOffset = b.readUInt32LE(eocd + 16);
    if (b.readUInt16LE(eocd + 4) !== 0 || b.readUInt16LE(eocd + 6) !== 0 || b.readUInt16LE(eocd + 8) !== count) return undefined;
    if (count === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocd) return undefined;
    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > cdOffset + cdSize || b.readUInt32LE(p) !== 0x02014b50) return undefined;
        const flags = b.readUInt16LE(p + 8);
        const size = b.readUInt32LE(p + 20);
        const originalSize = b.readUInt32LE(p + 24);
        const nameLen = b.readUInt16LE(p + 28);
        const next = p + 46 + nameLen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
        const local = b.readUInt32LE(p + 42);
        if (next > cdOffset + cdSize || flags & 1 || size === 0xffffffff || originalSize === 0xffffffff) return undefined;
        if (local + 30 > cdOffset || b.readUInt32LE(local) !== 0x04034b50) return undefined;
        const dataStart = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
        if (dataStart + size > cdOffset) return undefined;
        const nameBytes = b.subarray(p + 46, p + 46 + nameLen);
        entries.push({
            name: nameBytes.toString(flags & 0x0800 ? "utf8" : "latin1"),
            nameBytes,
            madeBy: b.readUInt16LE(p + 4),
            flags,
            method: b.readUInt16LE(p + 10),
            time: b.readUInt16LE(p + 12),
            date: b.readUInt16LE(p + 14),
            crc: b.readUInt32LE(p + 16),
            size,
            originalSize,
            attrs: b.readUInt32LE(p + 38),
            dataStart,
        });
        p = next;
    }
    return entries;
}

const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
/** CRC-32 of a zip entry (node:zlib's from Node 22.2 on; the same sum in JavaScript before that). */
function crc32(b: Uint8Array): number {
    if (typeof zlib.crc32 === "function") return zlib.crc32(b) >>> 0;
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const inflateRaw = (b: Uint8Array, max: number): Promise<Buffer> => new Promise((resolve, reject) => zlib.inflateRaw(b, { maxOutputLength: max }, (e, out) => (e ? reject(e) : resolve(out))));
const deflateRaw = (b: Uint8Array): Promise<Buffer> => new Promise((resolve, reject) => zlib.deflateRaw(b, { level: 6 }, (e, out) => (e ? reject(e) : resolve(out))));

/** An entry's content, unpacked no further than it declares and checked against its size and checksum; undefined when it does not match. */
async function contentOf(b: Buffer, e: ZipEntry): Promise<Buffer | undefined> {
    const stored = b.subarray(e.dataStart, e.dataStart + e.size);
    let out: Buffer;
    if (e.method === 0) out = stored;
    else if (e.method === 8) {
        try {
            out = await inflateRaw(stored, Math.max(1, e.originalSize));
        } catch {
            return undefined; // broken, or it unpacks to more than it says
        }
    } else return undefined;
    return out.length === e.originalSize && crc32(out) === e.crc ? out : undefined;
}

interface ZipOut {
    entry: ZipEntry;
    /** As stored: the original packed bytes of an unchanged part, or the masked text packed again. */
    data: Uint8Array;
    method: number;
    crc: number;
    originalSize: number;
}

/** A zip of these parts, names and times kept, without data descriptors, extra fields or comments. */
function writeZip(parts: ZipOut[]): Buffer {
    const body: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    let centralSize = 0;
    for (const { entry, data, method, crc, originalSize } of parts) {
        const flags = entry.flags & 0x0800; // the name is UTF-8
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(entry.time, 10);
        local.writeUInt16LE(entry.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(originalSize, 22);
        local.writeUInt16LE(entry.nameBytes.length, 26);
        const head = Buffer.alloc(46);
        head.writeUInt32LE(0x02014b50, 0);
        head.writeUInt16LE(entry.madeBy, 4);
        head.writeUInt16LE(20, 6);
        head.writeUInt16LE(flags, 8);
        head.writeUInt16LE(method, 10);
        head.writeUInt16LE(entry.time, 12);
        head.writeUInt16LE(entry.date, 14);
        head.writeUInt32LE(crc, 16);
        head.writeUInt32LE(data.length, 20);
        head.writeUInt32LE(originalSize, 24);
        head.writeUInt16LE(entry.nameBytes.length, 28);
        head.writeUInt32LE(entry.attrs, 38);
        head.writeUInt32LE(offset, 42);
        body.push(local, entry.nameBytes, data);
        central.push(head, entry.nameBytes);
        offset += 30 + entry.nameBytes.length + data.length;
        centralSize += 46 + entry.nameBytes.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(parts.length, 8);
    end.writeUInt16LE(parts.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...body, ...central, end]);
}

/**
 * The trace's bytes with every form of every secret masked, or a reason it cannot be cleaned (it is then not to be kept). `forms` comes
 * from traceSecretForms. A zip is refused unread past TRACE_LIMITS (as its central directory declares them) and written again in the same
 * order: every name is kept except a masked resource's, which becomes the sha1 of its cleaned content (and every reference to it follows).
 * The resources are cleaned first, so their new names are known when the action and network logs are. A trace with nothing to mask comes
 * back as it was.
 */
export async function scrubTraceBytes(data: Uint8Array, forms: readonly string[]): Promise<TraceScrubResult> {
    if (forms.length === 0) return { ok: true, data, masked: 0 };
    const n = needlesOf(forms);
    const pace = pacer();
    if (!isZip(data)) {
        // A one-file trace (Taqwright's HTML, with its pictures inside) is one text part, bounded like a whole archive.
        if (data.length > TRACE_LIMITS.maxTotalBytes) return { ok: false, reason: "the trace is too large to be cleaned" };
        const part = await scrubPart(data, n, pace);
        return part ? { ok: true, data: part.data, masked: part.masked } : { ok: false, reason: "a secret is in a part of the trace that is not text" };
    }
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const entries = readZip(b);
    if (!entries) return { ok: false, reason: "the trace could not be read" };
    let total = 0;
    for (const e of entries) total += e.originalSize;
    if (entries.length > TRACE_LIMITS.maxEntries || total > TRACE_LIMITS.maxTotalBytes || entries.some((e) => e.originalSize > TRACE_LIMITS.maxEntryBytes)) {
        return { ok: false, reason: "the trace is too large to be cleaned" };
    }
    // The names the parts' references use, and the new sha1 of each resource that is masked.
    const keys = new Set<string>();
    for (const e of entries) for (const k of path.posix.basename(e.name).match(REF) ?? []) keys.add(k);
    const renamed = new Map<string, string>();
    const refs: Refs = { keys, renamed };
    const names = new Set(entries.map((e) => e.name));
    const out: Array<ZipOut | undefined> = new Array(entries.length);
    // Resources first: the logs that point at them are cleaned once their new names are known.
    const order = [...entries.keys()].sort((x, y) => Number(!RESOURCE.test(entries[x]!.name)) - Number(!RESOURCE.test(entries[y]!.name)));
    let masked = 0;
    for (const i of order) {
        const entry = entries[i]!;
        await pace();
        const content = await contentOf(b, entry);
        if (!content) return { ok: false, reason: "the trace could not be read" };
        const part = await scrubPart(content, n, pace, refs);
        if (!part) return { ok: false, reason: `a secret is in ${path.posix.basename(entry.name)}, which is not text` };
        if (!part.changed) {
            out[i] = { entry, data: b.subarray(entry.dataStart, entry.dataStart + entry.size), method: entry.method, crc: entry.crc, originalSize: entry.originalSize };
            continue;
        }
        masked += part.masked;
        let named = entry;
        const resource = RESOURCE.exec(entry.name);
        if (resource) {
            const hex = await sha1Hex(part.data);
            renamed.set(resource[1]!, hex);
            const name = `resources/${hex}${resource[2] ?? ""}`;
            // A part with this content is in the trace already (two bodies that differed only by a secret): one copy is enough.
            if (names.has(name)) continue;
            names.add(name);
            named = { ...entry, name, nameBytes: Buffer.from(name, "utf8") };
        }
        try {
            out[i] = { entry: named, data: await deflateRaw(part.data), method: 8, crc: crc32(part.data), originalSize: part.data.length };
        } catch {
            return { ok: false, reason: "the cleaned trace could not be written" };
        }
    }
    if (masked === 0) return { ok: true, data, masked: 0 };
    try {
        return { ok: true, data: writeZip(out.filter((o): o is ZipOut => o !== undefined)), masked };
    } catch {
        return { ok: false, reason: "the cleaned trace could not be written" };
    }
}

/** One trace at a time per process: a few traces at once would hold several archives in memory and fill the thread pool. */
let cleaning: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const run = cleaning.then(work, work);
    cleaning = run.catch(() => undefined);
    return run;
}

/**
 * Clean a trace file in place (written to a temporary file and renamed over it). `secrets` are exact values (traceSecretsOfRun and any
 * others); their forms are worked out here. On `ok: false` the file is left as it was and must not be kept or sent.
 */
export function scrubTraceFile(file: string, secrets: readonly string[]): Promise<{ ok: true; masked: number } | { ok: false; reason: string }> {
    const forms = traceSecretForms(secrets);
    if (forms.length === 0) return Promise.resolve({ ok: true, masked: 0 });
    return oneAtATime(async () => {
        let data: Buffer;
        try {
            const st = await fs.stat(file);
            if (!st.isFile()) return { ok: false, reason: "the trace is not a file" };
            if (st.size > TRACE_LIMITS.maxTotalBytes) return { ok: false, reason: "the trace is too large to be cleaned" };
            data = await fs.readFile(file);
        } catch {
            return { ok: false, reason: "the trace could not be read" };
        }
        const r = await scrubTraceBytes(data, forms);
        if (!r.ok) return r;
        if (r.masked === 0) return { ok: true, masked: 0 };
        const tmp = `${file}.${process.pid}.clean`;
        try {
            await fs.writeFile(tmp, r.data);
            await fs.rename(tmp, file);
        } catch {
            await fs.rm(tmp, { force: true }).catch(() => undefined);
            return { ok: false, reason: "the cleaned trace could not be written" };
        }
        return { ok: true, masked: r.masked };
    });
}

/**
 * After a run: clean every trace the runs name, and drop (and delete) a trace that cannot be cleaned, with a note on its run. Returns how
 * many traces were dropped. Used by the platform's own runs (validation/runner.ts); a runner does the same before it uploads.
 */
export async function scrubRunTraces(runs: Array<{ artifacts: Array<{ kind: string; path: string }>; notes?: string[] }>, secrets: readonly string[]): Promise<number> {
    if (traceSecretForms(secrets).length === 0) return 0;
    let dropped = 0;
    for (const run of runs) {
        const keep: typeof run.artifacts = [];
        for (const a of run.artifacts) {
            if (a.kind !== "trace") {
                keep.push(a);
                continue;
            }
            const r = await scrubTraceFile(a.path, secrets);
            if (r.ok) keep.push(a);
            else {
                dropped++;
                await fs.rm(a.path, { force: true }).catch(() => undefined);
                run.notes = [...(run.notes ?? []), `${TRACE_WITHHELD} (${r.reason}).`];
            }
        }
        run.artifacts = keep;
    }
    return dropped;
}
