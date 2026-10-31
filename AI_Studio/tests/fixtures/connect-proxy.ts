/**
 * A small company proxy for the company-network tests, plain Node `http`: it answers CONNECT (the tunnel https and Node's fetch use)
 * and absolute-form requests (plain http through a proxy), optionally asks for a user name and password (407), and can refuse a host
 * (403, like a company filter). Every name is mapped to 127.0.0.1, so a test can use names such as platform.test that only "exist"
 * behind the proxy: a connection that reaches them went through it. It records what it was asked, never forwards anywhere else.
 */
import http from "node:http";
import net from "node:net";

export interface ProxyHit {
    method: string;
    /** host:port of a CONNECT, or the absolute URL of a plain request. */
    target: string;
    /** The Proxy-Authorization header as sent ("" when none). */
    auth: string;
}

export class ConnectProxy {
    readonly hits: ProxyHit[] = [];
    private server?: http.Server;
    private readonly sockets = new Set<net.Socket>();

    constructor(
        readonly port: number,
        private readonly opts: { user?: string; password?: string; refuse?: string[] } = {},
    ) {}

    get url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    private allowed(auth: string): boolean {
        if (this.opts.user === undefined) return true;
        return auth === `Basic ${Buffer.from(`${this.opts.user}:${this.opts.password ?? ""}`).toString("base64")}`;
    }

    start(): Promise<void> {
        const server = http.createServer((req, res) => {
            const auth = String(req.headers["proxy-authorization"] ?? "");
            this.hits.push({ method: req.method ?? "", target: req.url ?? "", auth });
            if (!this.allowed(auth)) return void res.writeHead(407, { "proxy-authenticate": 'Basic realm="test proxy"' }).end();
            let u: URL;
            try {
                u = new URL(req.url ?? "");
            } catch {
                return void res.writeHead(400).end();
            }
            if (this.opts.refuse?.includes(u.hostname)) return void res.writeHead(403, { "content-type": "text/html" }).end("<html><body>Blocked by policy</body></html>");
            const headers = { ...req.headers };
            delete headers["proxy-authorization"];
            const up = http.request({ host: "127.0.0.1", port: Number(u.port || 80), method: req.method, path: `${u.pathname}${u.search}`, headers }, (r) => {
                res.writeHead(r.statusCode ?? 502, r.headers);
                r.pipe(res);
            });
            up.on("error", () => res.headersSent ? res.end() : res.writeHead(502).end());
            req.pipe(up);
        });
        server.on("connect", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("error", () => undefined);
            const auth = String(req.headers["proxy-authorization"] ?? "");
            const target = req.url ?? "";
            this.hits.push({ method: "CONNECT", target, auth });
            if (!this.allowed(auth)) return void socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test proxy"\r\nContent-Length: 0\r\n\r\n');
            const m = /^(.+):(\d+)$/.exec(target);
            if (!m) return void socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
            if (this.opts.refuse?.includes(m[1]!.replace(/^\[|\]$/g, ""))) return void socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
            const up = net.connect(Number(m[2]), "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) up.write(head);
                up.pipe(socket);
                socket.pipe(up);
            });
            this.sockets.add(up);
            up.on("close", () => this.sockets.delete(up));
            up.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
        });
        this.server = server;
        return new Promise((resolve) => server.listen(this.port, "127.0.0.1", () => resolve()));
    }

    stop(): Promise<void> {
        const s = this.server;
        this.server = undefined;
        for (const so of this.sockets) so.destroy();
        return new Promise((resolve) => {
            if (!s) return resolve();
            s.closeAllConnections();
            s.close(() => resolve());
        });
    }
}

/**
 * An https front with the TEST-ONLY company certificate (tests/fixtures/tls/company): it decrypts and forwards every connection to a
 * plain http server on `toPort`, the way a company security tool presents its own certificate. It sends the leaf and the test root,
 * so an untrusting client sees SELF_SIGNED_CERT_IN_CHAIN.
 */
export async function tlsFront(port: number, toPort: number, cert: { cert: string; key: string }): Promise<{ stop(): Promise<void> }> {
    const tls = await import("node:tls");
    const sockets = new Set<net.Socket>();
    const server = tls.createServer({ cert: cert.cert, key: cert.key }, (clear) => {
        sockets.add(clear);
        clear.on("close", () => sockets.delete(clear));
        clear.on("error", () => undefined);
        const up = net.connect(toPort, "127.0.0.1");
        sockets.add(up);
        up.on("close", () => sockets.delete(up));
        up.on("error", () => clear.destroy());
        clear.pipe(up);
        up.pipe(clear);
    });
    server.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    return {
        stop: () =>
            new Promise<void>((resolve) => {
                for (const s of sockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}
