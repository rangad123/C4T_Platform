/**
 * A tiny SMTP server for tests: speaks just enough of RFC 5321 (EHLO, AUTH PLAIN / LOGIN, MAIL, RCPT, DATA, QUIT) to receive
 * mail from nodemailer on a local port, with no TLS. It records every accepted message together with the login used, and can be
 * told to demand a login, refuse a recipient, or answer a number of messages with a temporary failure.
 */
import net from "node:net";

export interface ReceivedMail {
    from: string;
    to: string[];
    /** The raw message (headers and body). */
    data: string;
    user?: string;
    pass?: string;
}

export interface FakeSmtp {
    mails: ReceivedMail[];
    /** Every command line received (for asserting what was never sent). */
    commands: string[];
    connections: number;
    /** Demand this login before MAIL FROM. */
    requireAuth?: { user: string; pass: string };
    /** Refuse recipients for which this returns true (answers 550). */
    rejectRcpt?: (address: string) => boolean;
    /** Answer this many upcoming DATA commands with a temporary failure (451). */
    failNext: number;
    close(): Promise<void>;
}

export async function startFakeSmtp(port: number): Promise<FakeSmtp> {
    const smtp: FakeSmtp = {
        mails: [],
        commands: [],
        connections: 0,
        failNext: 0,
        close: () => new Promise((resolve) => (sockets.forEach((x) => x.destroy()), server.close(() => resolve()))),
    };
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
        smtp.connections++;
        sockets.add(sock);
        sock.on("close", () => sockets.delete(sock));
        let buf = "";
        let mode: "commands" | "data" | "auth-plain" | "auth-user" | "auth-pass" = "commands";
        let from = "";
        let to: string[] = [];
        let user: string | undefined;
        let pass: string | undefined;
        let authed = false;
        const reply = (line: string) => sock.write(`${line}\r\n`);
        const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
        const finishAuth = (u: string, p: string) => {
            if (smtp.requireAuth && (u !== smtp.requireAuth.user || p !== smtp.requireAuth.pass)) return reply("535 5.7.8 Authentication credentials invalid");
            [user, pass, authed] = [u, p, true];
            reply("235 2.7.0 Authentication successful");
        };

        const handle = (line: string) => {
            if (mode === "auth-plain") {
                mode = "commands";
                const [, u = "", p = ""] = b64(line).split("\0");
                return finishAuth(u, p);
            }
            if (mode === "auth-user") {
                user = b64(line);
                mode = "auth-pass";
                return reply("334 UGFzc3dvcmQ6");
            }
            if (mode === "auth-pass") {
                mode = "commands";
                return finishAuth(user ?? "", b64(line));
            }
            smtp.commands.push(line);
            const [verb = "", ...rest] = line.split(" ");
            switch (verb.toUpperCase()) {
                case "EHLO":
                    return sock.write(`250-fake.test\r\n${smtp.requireAuth ? "250-AUTH PLAIN LOGIN\r\n" : ""}250 8BITMIME\r\n`);
                case "HELO":
                    return reply("250 fake.test");
                case "AUTH": {
                    if (rest[0]?.toUpperCase() === "PLAIN") {
                        if (rest[1]) {
                            const [, u = "", p = ""] = b64(rest[1]).split("\0");
                            return finishAuth(u, p);
                        }
                        mode = "auth-plain";
                        return reply("334 ");
                    }
                    mode = "auth-user";
                    return reply("334 VXNlcm5hbWU6");
                }
                case "MAIL":
                    if (smtp.requireAuth && !authed) return reply("530 5.7.0 Authentication required");
                    from = /<([^>]*)>/.exec(line)?.[1] ?? "";
                    to = [];
                    return reply("250 OK");
                case "RCPT": {
                    const addr = /<([^>]*)>/.exec(line)?.[1] ?? "";
                    if (smtp.rejectRcpt?.(addr)) return reply("550 5.1.1 Mailbox unavailable");
                    to.push(addr);
                    return reply("250 OK");
                }
                case "DATA":
                    mode = "data";
                    return reply("354 End data with <CR><LF>.<CR><LF>");
                case "RSET":
                case "NOOP":
                    return reply("250 OK");
                case "QUIT":
                    reply("221 Bye");
                    return void sock.end();
                default:
                    return reply("502 Command not implemented");
            }
        };

        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            for (;;) {
                if (mode === "data") {
                    const end = buf.indexOf("\r\n.\r\n");
                    if (end < 0) return;
                    const data = buf.slice(0, end).replace(/^\./gm, "");
                    buf = buf.slice(end + 5);
                    mode = "commands";
                    if (smtp.failNext > 0) {
                        smtp.failNext--;
                        reply("451 4.3.0 Try again later");
                    } else {
                        smtp.mails.push({ from, to, data, user, pass });
                        reply("250 OK queued");
                    }
                    continue;
                }
                const nl = buf.indexOf("\r\n");
                if (nl < 0) return;
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                handle(line);
            }
        });
        sock.on("error", () => undefined);
        reply("220 fake.test ESMTP ready");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    return smtp;
}

/** Decode a quoted-printable body (nodemailer uses it for text longer than a line). */
export function decodeQuotedPrintable(s: string): string {
    return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export interface ParsedMail {
    headers: Record<string, string>;
    text: string;
    html: string;
}

const decodeWords = (v: string) =>
    v.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, body: string) =>
        enc.toUpperCase() === "B" ? Buffer.from(body, "base64").toString("utf8") : Buffer.from(body.replace(/_/g, " ").replace(/=([0-9A-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"),
    );

/** Headers, plain-text body and HTML body of a received message (multipart/alternative, any transfer encoding nodemailer picks). */
export function parseMail(data: string): ParsedMail {
    const split = (raw: string) => {
        const i = raw.indexOf("\r\n\r\n");
        const head = i < 0 ? raw : raw.slice(0, i);
        const headers: Record<string, string> = {};
        for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
            const c = line.indexOf(":");
            if (c > 0) headers[line.slice(0, c).toLowerCase()] = decodeWords(line.slice(c + 1).trim());
        }
        return { headers, body: i < 0 ? "" : raw.slice(i + 4) };
    };
    const out: ParsedMail = { headers: {}, text: "", html: "" };
    const walk = (raw: string, top: boolean) => {
        const { headers, body } = split(raw);
        if (top) out.headers = headers;
        const type = headers["content-type"] ?? "text/plain";
        const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
        if (boundary) {
            for (const part of body.split(`--${boundary}`).slice(1)) if (!part.startsWith("--")) walk(part.replace(/^\r\n/, ""), false);
            return;
        }
        const cte = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
        const decoded = cte === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") : cte === "quoted-printable" ? Buffer.from(decodeQuotedPrintable(body), "latin1").toString("utf8") : body;
        if (/text\/html/i.test(type)) out.html = decoded;
        else if (/text\/plain/i.test(type)) out.text = decoded;
    };
    walk(data, true);
    return out;
}
