/**
 * The address guard for a browser the platform drives (discovery, authoring, agent runs), when BLOCK_PRIVATE_TARGETS is on.
 *
 * A route handler sees only the first address of a request: Playwright follows redirect hops without asking, and a check made by name can be
 * answered differently when the browser looks the name up again (DNS rebinding). So the browser's traffic goes through this small proxy, which
 * looks every name up itself, refuses a private, loopback or link-local address, and connects to the address it checked. Every request type,
 * every frame and every redirect hop is a new request to the proxy, so all of them meet the rule.
 */
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { isPrivateHost } from "../../platform/net-guard.js";

/** Shown by the proxy in place of a refused page. */
export const PRIVATE_ADDRESS_REFUSED = "This address is private to the server's network, so the browser may not open it.";

/** The checked public address to connect to for a host, or undefined when the host is private or cannot be found. */
export async function publicAddressOf(host: string): Promise<string | undefined> {
    const h = host.replace(/^\[|\]$/g, "");
    if (!h || isPrivateHost(h)) return undefined;
    if (net.isIP(h)) return h;
    const all = await dns.lookup(h, { all: true }).catch(() => []);
    if (!all.length || all.some((a) => isPrivateHost(a.address))) return undefined;
    // Every address was checked; IPv4 first, since many servers have no IPv6 route.
    return (all.find((a) => a.family === 4) ?? all[0]!).address;
}

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "transfer-encoding", "upgrade"]);

export class GuardProxy {
    /** Hosts refused so far, for the record. */
    readonly refused: string[] = [];
    private readonly sockets = new Set<net.Socket>();
    private constructor(
        private readonly server: http.Server,
        private readonly trusted: ReadonlySet<string>,
        private readonly refusal: string = PRIVATE_ADDRESS_REFUSED,
    ) {}

    /**
     * `trust`: "host:port" pairs passed as they are. For tests only, where a local site stands in for a public one; the platform never sets it.
     * `refusal`: the text of a refused page (a runner's own guard, src/agent/address-guard.ts, words it for a person's computer). Default: the platform's.
     */
    static async start(opts: { trust?: string[]; refusal?: string } = {}): Promise<GuardProxy> {
        const server = http.createServer();
        const proxy = new GuardProxy(server, new Set(opts.trust ?? []), opts.refusal ?? PRIVATE_ADDRESS_REFUSED);
        server.on("connection", (s) => {
            proxy.sockets.add(s);
            s.on("close", () => proxy.sockets.delete(s));
        });
        server.on("request", (req, res) => void proxy.forward(req, res).catch(() => res.destroy()));
        server.on("connect", (req, socket: net.Socket, head: Buffer) => void proxy.tunnel(req, socket, head).catch(() => socket.destroy()));
        // A WebSocket over plain http is not needed by the pages under test here: refused rather than passed through unchecked.
        server.on("upgrade", (_req, socket: net.Socket) => socket.destroy());
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        return proxy;
    }

    /** What Playwright's `proxy.server` takes. */
    get address(): string {
        const a = this.server.address() as net.AddressInfo;
        return `http://127.0.0.1:${a.port}`;
    }

    private refuse(host: string): void {
        if (this.refused.length < 50) this.refused.push(host);
    }

    private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let u: URL;
        try {
            u = new URL(req.url ?? "");
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (u.protocol !== "http:") {
            res.writeHead(400).end();
            return;
        }
        const ip = this.trusted.has(`${u.hostname}:${u.port || 80}`) ? u.hostname : await publicAddressOf(u.hostname);
        if (!ip) {
            this.refuse(u.host);
            res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }).end(this.refusal);
            return;
        }
        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
        headers.host = u.host;
        const up = http.request({ host: ip, port: Number(u.port) || 80, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false }, (r) => {
            const out: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) out[k] = v;
            res.writeHead(r.statusCode ?? 502, out);
            r.pipe(res);
        });
        up.on("error", () => res.destroy());
        req.pipe(up);
    }

    private async tunnel(req: http.IncomingMessage, socket: net.Socket, head: Buffer): Promise<void> {
        socket.on("error", () => socket.destroy());
        const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
        const port = m ? Number(m[2]) : 0;
        const ip = m && port > 0 && port < 65_536 ? (this.trusted.has(`${m[1]}:${port}`) ? m[1]!.replace(/^\[|\]$/g, "") : await publicAddressOf(m[1]!)) : undefined;
        if (!ip) {
            this.refuse(req.url ?? "");
            socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        const up = net.connect(port, ip, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        this.sockets.add(up);
        up.on("close", () => this.sockets.delete(up));
        up.on("error", () => socket.destroy());
        socket.on("close", () => up.destroy());
    }

    async close(): Promise<void> {
        for (const s of this.sockets) s.destroy();
        await new Promise<void>((done) => this.server.close(() => done()));
    }
}

/** Is the guard on? The same switch as the platform's outbound guard (platform/net-guard.ts). */
export const privateTargetsBlocked = (): boolean => process.env.BLOCK_PRIVATE_TARGETS === "true";
