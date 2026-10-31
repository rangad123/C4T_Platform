/**
 * Emailed codes and magic links: reading a message and taking the code or the link out of it.
 *
 * Messages come from the test mailbox (an IMAP mailbox the platform reads, or mail forwarded to the platform's inbound address; see
 * src/platform/mailbox/*). This file is pure: a small MIME reader (headers, multipart, quoted-printable, base64, the common charsets) with
 * caps on size and nesting, and the extraction rules, which are deliberately plain so a person can predict them:
 *
 *  - a CODE is 4 to 8 digits (or 6 to 8 capital letters and digits containing at least one digit) that follows one of the words code,
 *    verification, verify, one-time, OTP, passcode, PIN or token within a short distance; failing that, the first number of exactly six
 *    digits. With `after`, the first such token after that text instead. Years, prices and times are not codes.
 *  - a LINK is the first http(s) link on the application's own site that is not an unsubscribe, privacy or image link; with `after`, the
 *    first link whose address or text contains that text. A link to another site is never opened.
 */

export const MAX_MAIL_BYTES = 1_000_000;
const MAX_PARTS = 40;
const MAX_DEPTH = 5;

export interface MailMessage {
    /** Lower-cased recipient addresses (To, Cc, Delivered-To, X-Original-To). */
    to: string[];
    from: string;
    subject: string;
    /** When the mailbox received it (ms since 1970). */
    receivedAt: number;
    text: string;
    html: string;
}

/** What a waiting step asks for. */
export interface MailQuery {
    to: string;
    use: "code" | "link";
    after?: string;
    /** Only messages received at or after this moment (ms) count; a small allowance for clock differences is applied by the source. */
    since: number;
    /** The application's origin: links elsewhere are not opened. */
    origin: string;
}

/** Where messages come from: the newest message to `to` received at or after `since` (undefined while there is none yet). */
export type MailSource = (q: { to: string; since: number }) => Promise<MailMessage | undefined>;

// ── MIME ─────────────────────────────────────────────────────────────────────

function splitHeaderBody(raw: string): { head: string; body: string } {
    const m = /\r?\n\r?\n/.exec(raw);
    if (!m) return { head: raw, body: "" };
    return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

export function parseHeaders(head: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i <= 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const list = out.get(k) ?? [];
        list.push(line.slice(i + 1).trim());
        out.set(k, list);
    }
    return out;
}

function param(value: string, name: string): string | undefined {
    const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, "i").exec(value);
    return m ? (m[2] ?? m[1]) : undefined;
}

function decodeCharset(buf: Buffer, charset: string | undefined): string {
    const cs = (charset ?? "utf-8").toLowerCase();
    try {
        return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(buf);
    } catch {
        return buf.toString("utf8");
    }
}

function decodeQuotedPrintable(s: string): Buffer {
    const bytes: number[] = [];
    const text = s.replace(/=\r?\n/g, "");
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            for (const b of Buffer.from(c, "utf8")) bytes.push(b);
        }
    }
    return Buffer.from(bytes);
}

/** RFC 2047 encoded words in a header (=?utf-8?B?...?= and =?utf-8?Q?...?=). */
export function decodeWords(s: string): string {
    return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
        const buf = enc.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQuotedPrintable(data.replace(/_/g, " "));
        return decodeCharset(buf, cs);
    });
}

function addresses(values: string[] | undefined): string[] {
    const out: string[] = [];
    for (const v of values ?? []) for (const m of v.matchAll(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.push(m[0].toLowerCase());
    return out;
}

/** Text and HTML bodies of a (possibly multipart) entity, depth- and count-limited. */
function collectBodies(raw: string, depth: number, acc: { text: string[]; html: string[]; parts: number }): void {
    if (depth > MAX_DEPTH || acc.parts >= MAX_PARTS) return;
    acc.parts++;
    const { head, body } = splitHeaderBody(raw);
    const h = parseHeaders(head);
    const type = (h.get("content-type")?.[0] ?? "text/plain").toLowerCase();
    const ctype = type.split(";")[0]!.trim();
    if (ctype.startsWith("multipart/")) {
        const boundary = param(h.get("content-type")?.[0] ?? "", "boundary");
        if (!boundary) return;
        const sections = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
        for (const s of sections) if (s.trim()) collectBodies(s, depth + 1, acc);
        return;
    }
    if (ctype !== "text/plain" && ctype !== "text/html") return;
    if (/attachment/i.test(h.get("content-disposition")?.[0] ?? "")) return;
    const enc = (h.get("content-transfer-encoding")?.[0] ?? "7bit").toLowerCase();
    const buf = enc === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : enc === "quoted-printable" ? decodeQuotedPrintable(body) : Buffer.from(body, "utf8");
    const text = decodeCharset(buf, param(h.get("content-type")?.[0] ?? "", "charset"));
    (ctype === "text/html" ? acc.html : acc.text).push(text);
}

/** A raw RFC 822 message. `receivedAt` is when the mailbox got it (the IMAP INTERNALDATE, or the moment it was forwarded). */
export function parseRawMail(raw: string, receivedAt: number): MailMessage {
    const capped = raw.length > MAX_MAIL_BYTES ? raw.slice(0, MAX_MAIL_BYTES) : raw;
    const { head } = splitHeaderBody(capped);
    const h = parseHeaders(head);
    const acc = { text: [] as string[], html: [] as string[], parts: 0 };
    collectBodies(capped, 0, acc);
    return {
        to: [...new Set(addresses([...(h.get("to") ?? []), ...(h.get("cc") ?? []), ...(h.get("delivered-to") ?? []), ...(h.get("x-original-to") ?? [])]))],
        from: addresses(h.get("from"))[0] ?? "",
        subject: decodeWords(h.get("subject")?.[0] ?? "").slice(0, 300),
        receivedAt,
        text: acc.text.join("\n").slice(0, MAX_MAIL_BYTES),
        html: acc.html.join("\n").slice(0, MAX_MAIL_BYTES),
    };
}

/** A message given as fields (the JSON an inbound-mail forwarder posts). */
export function mailFromFields(f: { to: string | string[]; from?: string; subject?: string; text?: string; html?: string }, receivedAt: number): MailMessage {
    const to = Array.isArray(f.to) ? f.to : [f.to];
    return {
        to: [...new Set(addresses(to))],
        from: addresses([f.from ?? ""])[0] ?? "",
        subject: (f.subject ?? "").slice(0, 300),
        receivedAt,
        text: (f.text ?? "").slice(0, MAX_MAIL_BYTES),
        html: (f.html ?? "").slice(0, MAX_MAIL_BYTES),
    };
}

// ── extraction ───────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const unescapeHtml = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
});

/** The words a person reads in the message: the plain text, or the HTML without its tags, scripts and styles. */
export function readableText(m: MailMessage): string {
    const fromHtml = m.html
        ? unescapeHtml(m.html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " "))
        : "";
    return `${m.subject}\n${m.text || fromHtml}`.replace(/[ \t ]+/g, " ");
}

const CODE_WORDS = /(code|verification|verify|one[- ]time|otp|passcode|pin|token|security number)/i;
const TOKEN = /(?<![\w/:$£€-]|\d\.)(\d{4,8}|(?=[A-Z0-9]*\d)[A-Z0-9]{6,8})(?![\w/:%-]|\.\d)/g;

function looksLikeNotACode(tok: string, text: string, at: number): boolean {
    if (/^(19|20)\d{2}$/.test(tok)) return true; // a year
    const before = text.slice(Math.max(0, at - 2), at);
    return /[$£€#]\s?$/.test(before);
}

/** The code in a message, or undefined. */
export function extractCode(m: MailMessage, after?: string): string | undefined {
    const text = readableText(m);
    if (after) {
        const i = text.toLowerCase().indexOf(after.toLowerCase());
        if (i < 0) return undefined;
        const rest = text.slice(i + after.length);
        for (const t of rest.matchAll(TOKEN)) if (!looksLikeNotACode(t[1]!, rest, t.index!)) return t[1];
        return undefined;
    }
    // A token close after one of the code words.
    for (const w of text.matchAll(new RegExp(CODE_WORDS.source, "gi"))) {
        const window = text.slice(w.index! + w[0].length, w.index! + w[0].length + 60);
        for (const t of window.matchAll(TOKEN)) if (!looksLikeNotACode(t[1]!, window, t.index!)) return t[1];
    }
    // Otherwise the first number of exactly six digits.
    for (const t of text.matchAll(TOKEN)) if (/^\d{6}$/.test(t[1]!) && !looksLikeNotACode(t[1]!, text, t.index!)) return t[1];
    return undefined;
}

const SKIP_LINK = /unsubscribe|opt-?out|privacy|preferences|\.(png|jpe?g|gif|svg|webp)(\?|$)/i;

/** Every http(s) link of a message with the words it is shown with, in order (HTML anchors first, then bare addresses in the text). */
export function linksOf(m: MailMessage): Array<{ href: string; text: string }> {
    const out: Array<{ href: string; text: string }> = [];
    for (const a of m.html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
        out.push({ href: unescapeHtml((a[2] ?? a[3] ?? "").trim()), text: unescapeHtml(a[4]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() });
        if (out.length > 200) break;
    }
    for (const u of `${m.text}`.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
        out.push({ href: u[0].replace(/[.,;:!?]+$/, ""), text: "" });
        if (out.length > 400) break;
    }
    return out.filter((l) => /^https?:\/\//i.test(l.href));
}

/** The link to open, or a plain reason why there is none. Only links on the application's own site qualify. */
export function extractLink(m: MailMessage, origin: string, after?: string): { link: string } | { error: string } {
    const links = linksOf(m);
    const candidates = links.filter((l) => !SKIP_LINK.test(l.href) && (!after || l.href.toLowerCase().includes(after.toLowerCase()) || l.text.toLowerCase().includes(after.toLowerCase())));
    const own = candidates.find((l) => {
        try {
            return new URL(l.href).origin === origin;
        } catch {
            return false;
        }
    });
    if (own) return { link: own.href };
    if (candidates.length) {
        let host = "another site";
        try {
            host = new URL(candidates[0]!.href).host;
        } catch {
            /* keep the words */
        }
        return { error: `The email's link goes to ${host}, not to the application's own site (${origin}), so it was not opened.` };
    }
    return { error: after ? `The email has no link containing “${after}”.` : "The email has no link to open." };
}

/** What a waiting step gets from a message: the code or the link, or the reason it cannot. */
export function answerFrom(m: MailMessage, q: Pick<MailQuery, "use" | "after" | "origin">): { value: string } | { error: string } {
    if (q.use === "code") {
        const code = extractCode(m, q.after);
        return code ? { value: code } : { error: q.after ? `The email has no code after “${q.after}”.` : "The email has no code (4 to 8 digits after a word such as code or verification)." };
    }
    const r = extractLink(m, q.origin, q.after);
    return "link" in r ? { value: r.link } : r;
}

/** Is this message addressed to `to` (exact address, case-insensitive)? */
export const isAddressedTo = (m: MailMessage, to: string): boolean => m.to.includes(to.trim().toLowerCase());

export const EMAIL_ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
