/**
 * A tiny IMAP server for tests: speaks just enough of RFC 3501 for the test mailbox reader (LOGIN, EXAMINE, UID SEARCH ... TO, UID FETCH
 * (INTERNALDATE BODY.PEEK[]), LOGOUT), plain or over TLS. It holds a list of raw messages with their arrival time, records every command
 * line (so a test can check what was sent and that nothing was changed), and refuses a wrong login.
 */
import net from "node:net";
import tls from "node:tls";

export interface FakeMessage {
    uid: number;
    raw: string;
    /** When the mailbox received it (ms). */
    at: number;
}

export interface FakeImap {
    port: number;
    messages: FakeMessage[];
    commands: string[];
    connections: number;
    add(raw: string, at?: number): void;
    close(): Promise<void>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");
const internalDate = (ms: number) => {
    const d = new Date(ms);
    return `${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
};
const unquote = (s: string) => s.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1");

export async function startFakeImap(o: { port: number; user: string; pass: string; tls?: { key: string; cert: string } }): Promise<FakeImap> {
    const state: FakeImap = {
        port: o.port,
        messages: [],
        commands: [],
        connections: 0,
        add(raw, at = Date.now()) {
            state.messages.push({ uid: state.messages.length + 1, raw, at });
        },
        close: async () => undefined,
    };
    const handle = (socket: net.Socket) => {
        state.connections++;
        let authed = false;
        let buf = "";
        socket.write("* OK fake IMAP ready\r\n");
        socket.on("data", (d) => {
            buf += d.toString("utf8");
            let i: number;
            while ((i = buf.indexOf("\r\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 2);
                state.commands.push(line);
                const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
                if (!m) continue;
                const [, tag, cmd0, rest = ""] = m;
                const cmd = cmd0!.toUpperCase();
                if (cmd === "LOGIN") {
                    const args = rest.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
                    if (unquote(args[0] ?? "") === o.user && unquote(args[1] ?? "") === o.pass) {
                        authed = true;
                        socket.write(`${tag} OK LOGIN completed\r\n`);
                    } else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
                } else if (cmd === "EXAMINE") {
                    if (!authed) socket.write(`${tag} BAD not authenticated\r\n`);
                    else socket.write(`* ${state.messages.length} EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
                } else if (cmd === "UID" && /^SEARCH /i.test(rest)) {
                    const to = unquote(/TO ("(?:[^"\\]|\\.)*"|\S+)/i.exec(rest)?.[1] ?? "").toLowerCase();
                    const hits = state.messages.filter((x) => x.raw.toLowerCase().includes(to)).map((x) => x.uid);
                    socket.write(`* SEARCH${hits.length ? " " + hits.join(" ") : ""}\r\n${tag} OK SEARCH completed\r\n`);
                } else if (cmd === "UID" && /^FETCH /i.test(rest)) {
                    const uids = rest.split(" ")[1]!.split(",").map(Number);
                    for (const u of uids) {
                        const msg = state.messages.find((x) => x.uid === u);
                        if (!msg) continue;
                        const body = Buffer.from(msg.raw, "utf8");
                        socket.write(`* ${u} FETCH (UID ${u} INTERNALDATE "${internalDate(msg.at)}" BODY[] {${body.length}}\r\n`);
                        socket.write(body);
                        socket.write(")\r\n");
                    }
                    socket.write(`${tag} OK FETCH completed\r\n`);
                } else if (cmd === "LOGOUT") {
                    socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
                    socket.end();
                } else socket.write(`${tag} BAD unknown command\r\n`);
            }
        });
        socket.on("error", () => undefined);
    };
    const server = o.tls ? tls.createServer({ key: o.tls.key, cert: o.tls.cert }, handle) : net.createServer(handle);
    await new Promise<void>((r) => server.listen(o.port, "127.0.0.1", () => r()));
    state.close = () => new Promise<void>((r) => server.close(() => r()));
    return state;
}

/** A raw RFC 822 message. */
export function rawMail(o: { to: string; subject: string; text?: string; html?: string; from?: string }): string {
    const head = [`From: ${o.from ?? "noreply@app.test"}`, `To: ${o.to}`, `Subject: ${o.subject}`, "MIME-Version: 1.0"];
    if (o.html && o.text) {
        const b = "b1_boundary";
        return [...head, `Content-Type: multipart/alternative; boundary="${b}"`, "", `--${b}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", o.text.replace(/=/g, "=3D"), `--${b}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", Buffer.from(o.html).toString("base64"), `--${b}--`, ""].join("\r\n");
    }
    return [...head, `Content-Type: ${o.html ? "text/html" : "text/plain"}; charset=utf-8`, "", o.html ?? o.text ?? "", ""].join("\r\n");
}
