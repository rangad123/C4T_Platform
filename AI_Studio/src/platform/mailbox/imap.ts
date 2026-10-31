/**
 * A minimal IMAP reader for the test mailbox (RFC 3501, only what reading the newest message needs): LOGIN, EXAMINE (read-only, nothing
 * is marked as read or deleted), UID SEARCH SINCE <day> TO <address>, UID FETCH (INTERNALDATE BODY.PEEK[]) of the newest few, LOGOUT.
 * Node's `tls` (or `net` for plain IMAP on this computer or a private network only), no dependency. Every read is capped (size, time),
 * the password is sent as a quoted string and never logged, and server text in errors is cut short.
 */
import net from "node:net";
import tls from "node:tls";
import { isAddressedTo, parseRawMail, type MailMessage, type MailSource } from "../../engine/auth/mail.js";
import { isPrivateHost } from "../net-guard.js";
import type { ImapConfig } from "../session-store.js";

export const IMAP_TIMEOUT_MS = 20_000;
const MAX_LITERAL = 1_000_000;
const MAX_READ = 6_000_000;
/** How many of the newest matching messages are fetched per look. */
const FETCH_NEWEST = 5;
/** IMAP servers keep their own clock (and INTERNALDATE has whole seconds): a message this much older than the step still counts. */
export const IMAP_CLOCK_ALLOWANCE_MS = 60_000;

export class ImapError extends Error {}

/** A quoted IMAP string. Line breaks cannot be sent this way (and have no place in a user name, password or address). */
function quote(s: string): string {
    if (/[\r\n\0]/.test(s)) throw new ImapError("The mailbox settings contain a line break, which IMAP cannot send.");
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** IMAP's date for SEARCH SINCE (a day; the server compares whole days). One day earlier, so a time-zone difference cannot hide a message. */
export function imapSinceDate(ms: number): string {
    const d = new Date(ms - 24 * 60 * 60 * 1000);
    return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/** "17-Oct-2026 10:00:00 +0200" → ms. */
export function parseInternalDate(s: string): number | undefined {
    const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(s);
    if (!m) return undefined;
    const month = MONTHS.indexOf(m[2]!.slice(0, 1).toUpperCase() + m[2]!.slice(1).toLowerCase());
    if (month < 0) return undefined;
    const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
    const off = (Number(m[8]) * 60 + Number(m[9])) * 60_000 * (m[7] === "-" ? -1 : 1);
    return utc - off;
}

/** One parsed response line with the literals that followed it, e.g. a FETCH and its message text. */
interface ImapLine {
    text: string;
    literals: Buffer[];
}

/** A connection that reads complete responses (lines plus their {n} literals) off the socket. */
class Conn {
    private buf = Buffer.alloc(0);
    private read = 0;
    private waiter?: () => void;
    private failure?: Error;
    private n = 0;

    constructor(private readonly socket: net.Socket) {
        socket.on("data", (d: Buffer) => {
            this.read += d.length;
            if (this.read > MAX_READ) return this.fail(new ImapError("The mailbox sent more data than expected."));
            this.buf = Buffer.concat([this.buf, d]);
            this.waiter?.();
        });
        socket.on("error", (e) => this.fail(e));
        socket.on("close", () => this.fail(new ImapError("The mailbox closed the connection.")));
    }

    private fail(e: Error) {
        this.failure ??= e;
        this.waiter?.();
    }

    /** The next complete response line, or undefined when more data is needed. */
    private take(): ImapLine | undefined {
        let pos = 0;
        let text = "";
        const literals: Buffer[] = [];
        for (;;) {
            const eol = this.buf.indexOf("\r\n", pos);
            if (eol < 0) return undefined;
            const line = this.buf.subarray(pos, eol).toString("utf8");
            text += line;
            pos = eol + 2;
            const lit = /\{(\d+)\}$/.exec(line);
            if (!lit) break;
            const size = Number(lit[1]);
            if (size > MAX_LITERAL) throw new ImapError("A message in the mailbox is too large to read.");
            if (this.buf.length < pos + size) return undefined;
            literals.push(this.buf.subarray(pos, pos + size));
            pos += size;
        }
        this.buf = this.buf.subarray(pos);
        return { text, literals };
    }

    async next(): Promise<ImapLine> {
        for (;;) {
            const l = this.take();
            if (l) return l;
            if (this.failure) throw this.failure;
            await new Promise<void>((r) => (this.waiter = r));
            this.waiter = undefined;
        }
    }

    /** Sends a command and collects its untagged answers until the tagged one. A NO or BAD becomes an error (server text cut short). */
    async command(cmd: string, what: string): Promise<ImapLine[]> {
        const tag = `W${++this.n}`;
        this.socket.write(`${tag} ${cmd}\r\n`);
        const out: ImapLine[] = [];
        for (;;) {
            const l = await this.next();
            if (l.text.startsWith(`${tag} `)) {
                if (/^OK\b/i.test(l.text.slice(tag.length + 1))) return out;
                throw new ImapError(`${what} (the mailbox said: ${l.text.slice(tag.length + 1).replace(/[^\x20-\x7e]/g, "").slice(0, 120)})`);
            }
            out.push(l);
        }
    }

    close() {
        this.socket.destroy();
    }
}

export interface ImapOptions {
    /** Extra TLS options (tests pass their own certificate authority). */
    tlsOptions?: tls.ConnectionOptions;
    timeoutMs?: number;
}

function connect(cfg: ImapConfig, o: ImapOptions): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const onError = (e: Error) => reject(new ImapError(`The mailbox at ${cfg.host}:${cfg.port} could not be reached (${e.message.slice(0, 120)}).`));
        const socket = cfg.tls ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...o.tlsOptions }, () => resolve(socket)) : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(socket));
        socket.once("error", onError);
    });
}

/** Plain IMAP sends the password unencrypted: only allowed to this computer or a private network. */
export function plainImapProblem(cfg: Pick<ImapConfig, "host" | "tls">): string | undefined {
    return !cfg.tls && !isPrivateHost(cfg.host) ? "Plain IMAP (without TLS) would send the mailbox password unencrypted, so it is only allowed for a mail server on this computer or a private network. Turn on TLS." : undefined;
}

/** The newest messages to `to` received at or after `since` (ms), newest first. Opens and closes one connection. */
export async function imapNewest(cfg: ImapConfig, to: string, since: number, o: ImapOptions = {}): Promise<MailMessage[]> {
    const problem = plainImapProblem(cfg);
    if (problem) throw new ImapError(problem);
    const socket = await connect(cfg, o);
    const conn = new Conn(socket);
    const timer = setTimeout(() => socket.destroy(new ImapError("The mailbox took too long to answer.")), o.timeoutMs ?? IMAP_TIMEOUT_MS);
    try {
        const greeting = await conn.next();
        if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new ImapError("The server did not greet like an IMAP mailbox.");
        if (!/^\* PREAUTH/i.test(greeting.text)) await conn.command(`LOGIN ${quote(cfg.user)} ${quote(cfg.password)}`, "The mailbox refused the user name or password");
        await conn.command(`EXAMINE ${quote(cfg.mailbox ?? "INBOX")}`, `The mailbox has no folder “${cfg.mailbox ?? "INBOX"}”`);
        const found = await conn.command(`UID SEARCH SINCE ${imapSinceDate(since)} TO ${quote(to)}`, "The mailbox could not search its messages");
        const uids = found
            .filter((l) => /^\* SEARCH/i.test(l.text))
            .flatMap((l) => l.text.slice(8).trim().split(/\s+/))
            .filter((x) => /^\d+$/.test(x))
            .map(Number)
            .sort((a, b) => a - b)
            .slice(-FETCH_NEWEST);
        if (!uids.length) {
            await conn.command("LOGOUT", "").catch(() => undefined);
            return [];
        }
        const fetched = await conn.command(`UID FETCH ${uids.join(",")} (INTERNALDATE BODY.PEEK[])`, "The mailbox could not hand over its messages");
        await conn.command("LOGOUT", "").catch(() => undefined);
        const out: MailMessage[] = [];
        for (const l of fetched) {
            if (!/^\* \d+ FETCH/i.test(l.text) || !l.literals.length) continue;
            const date = /INTERNALDATE "([^"]+)"/i.exec(l.text)?.[1];
            const at = date ? parseInternalDate(date) : undefined;
            if (at === undefined || at < since - IMAP_CLOCK_ALLOWANCE_MS) continue;
            const m = parseRawMail(l.literals[0]!.toString("utf8"), at);
            if (isAddressedTo(m, to)) out.push(m);
        }
        return out.sort((a, b) => b.receivedAt - a.receivedAt);
    } finally {
        clearTimeout(timer);
        conn.close();
    }
}

/** The project's IMAP mailbox as a source for email steps. */
export function imapSource(cfg: ImapConfig, o: ImapOptions = {}): MailSource {
    return async ({ to, since }) => (await imapNewest(cfg, to, since, o))[0];
}

/** "Test the mailbox": logs in and opens the folder, nothing else. Undefined = fine; otherwise a plain sentence. */
export async function testImap(cfg: ImapConfig, o: ImapOptions = {}): Promise<string | undefined> {
    try {
        await imapNewest(cfg, "nobody@invalid.example", Date.now(), o);
        return undefined;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
