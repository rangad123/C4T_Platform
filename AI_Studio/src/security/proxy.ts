/**
 * Assessments through the company proxy (SECURITY_USE_PROXY=on, default off).
 *
 * The proxy is the one the platform's other outbound calls use (HTTPS_PROXY / HTTP_PROXY / NO_PROXY, see src/platform/outbound-network.ts
 * and docs/features/company-networks.md), chosen the same way: an https address uses HTTPS_PROXY (else HTTP_PROXY), an http address uses
 * HTTP_PROXY, and an address in NO_PROXY (or this computer's own: localhost, 127.0.0.1, ::1) is reached directly.
 *
 * What stays the same with a proxy: every address is still checked by the scope guard first, on the platform, with its DNS answers
 * (scope.ts `checkUrl`): out-of-scope, excluded, private (unless allowed) and cloud metadata addresses are refused before anything is sent.
 * What changes: the proxy connects to the site, and **the proxy resolves the name itself**. The guard's pinning ("connect to the address
 * that was checked") then cannot be enforced: if the proxy's DNS answers differently from the platform's, the proxy decides where the
 * request goes, so the private-address protection also depends on the proxy. That is why it is off by default.
 *
 * Refused (the assessment fails at start with the reason, or the request is refused):
 *   - SECURITY_USE_PROXY=on but no proxy is set, or its address cannot be read;
 *   - a proxy on a cloud metadata address (always), or on a loopback/private/link-local address unless SECURITY_PROXY_ALLOW_PRIVATE=true;
 *   - an address that is the proxy itself (the same host name, or the proxy's address and port): an assessment never assesses the proxy.
 *
 * How: https addresses go through a CONNECT tunnel (the TLS session is end to end, so the certificate seen is the site's own); http
 * addresses are sent to the proxy in absolute form (`GET http://host/path`), as Node's own proxy support does. The proxy's sign-in
 * (user:password in the proxy address) is sent as Proxy-Authorization and never shown: messages use `http://user:***@host:port`.
 * The connection to the proxy itself goes to the proxy address that was checked (resolved once per assessment).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { bypassMatches, parseProxyAddress, proxyEnvOf, withLoopbackBypass, type ProxyAddress, type ProxyEnv } from "../engine/net/company-network.js";
import { ADDRESS_WORDS, addressClass, METADATA_HOSTS, ScopeError, systemResolver, type ProxiedRequest, type Resolver, type ScopeDecision, type ScopeProxy } from "./scope.js";
import type { SecuritySettings } from "./settings.js";

type Allowed = Extract<ScopeDecision, { allowed: true }>;

/** The most a proxy's answer to CONNECT may be before its blank line (a real one is a few hundred bytes). */
const MAX_CONNECT_HEAD = 16 * 1024;

/** A problem with the proxy itself (not with the site): the assessment says it in these words. */
export class ProxyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProxyError";
    }
}

interface CheckedProxy {
    proxy: ProxyAddress;
    /** The address the platform connects to for this proxy (checked once). */
    address: string;
    /** Every address the proxy's name resolved to (for "is the target the proxy itself?"). */
    addresses: string[];
}

const bare = (h: string) => h.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
const targetPort = (u: URL) => Number(u.port) || (u.protocol === "https:" ? 443 : 80);
const hostPort = (host: string, port: number) => `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;

export interface SecurityProxyOptions {
    /** SECURITY_PROXY_ALLOW_PRIVATE (default false). Cloud metadata addresses are refused either way. */
    allowPrivateProxy?: boolean;
    /** For tests: the name lookup for the proxy's own host name. */
    resolver?: Resolver;
}

/**
 * The proxy an assessment uses, or undefined when SECURITY_USE_PROXY is off. Built from the environment the platform started with
 * (the same variables as its other outbound calls). A missing or unreadable proxy is not an error here: `ready()` says so, so the
 * assessment fails with the reason instead of quietly going direct.
 */
export function securityProxyFor(settings: Pick<SecuritySettings, "useProxy" | "allowPrivateProxy">, env: NodeJS.ProcessEnv = process.env, opts: Omit<SecurityProxyOptions, "allowPrivateProxy"> = {}): SecurityProxy | undefined {
    if (!settings.useProxy) return undefined;
    return new SecurityProxy(proxyEnvOf(env), { ...opts, allowPrivateProxy: settings.allowPrivateProxy === true });
}

export class SecurityProxy implements ScopeProxy {
    private readonly https?: ProxyAddress;
    private readonly http?: ProxyAddress;
    private readonly noProxy: string;
    private readonly problem?: string;
    private checked?: Promise<Map<string, CheckedProxy>>;

    constructor(
        env: ProxyEnv,
        private readonly opts: SecurityProxyOptions = {},
    ) {
        let unreadable: string | undefined;
        const read = (raw: string | undefined, name: string): ProxyAddress | undefined => {
            if (!raw) return undefined;
            const p = parseProxyAddress(raw);
            if (p.ok) return p.proxy;
            unreadable ??= `${name} could not be used for assessments: ${p.message}`;
            return undefined;
        };
        this.https = read(env.https, "HTTPS_PROXY");
        this.http = read(env.http, "HTTP_PROXY");
        this.noProxy = withLoopbackBypass(env.noProxy);
        if (unreadable) this.problem = unreadable;
        else if (!this.https && !this.http) this.problem = "SECURITY_USE_PROXY is on, but no company proxy is set. Set HTTPS_PROXY (and HTTP_PROXY for plain http sites) on the platform server, or turn SECURITY_USE_PROXY off.";
    }

    /** The proxy addresses as shown to people (never a password). */
    get display(): string[] {
        return [...new Set([this.https?.display, this.http?.display].filter((x): x is string => Boolean(x)))];
    }

    /** The proxy for one address, or undefined when it is reached directly (NO_PROXY, this computer). Same choice as Node's fetch. */
    proxyFor(u: URL): ProxyAddress | undefined {
        const chosen = u.protocol === "https:" ? (this.https ?? this.http) : u.protocol === "http:" ? this.http : undefined;
        if (!chosen) return undefined;
        return bypassMatches(u.hostname, targetPort(u), this.noProxy) ? undefined : chosen;
    }

    /**
     * Checks the proxy itself, once per assessment: it is set and readable, its name resolves, and none of its addresses is a cloud
     * metadata address (never) or a private one (unless allowed). Throws a ProxyError with the plain reason.
     */
    ready(): Promise<void> {
        return this.check().then(() => undefined);
    }

    private check(): Promise<Map<string, CheckedProxy>> {
        this.checked ??= (async () => {
            if (this.problem) throw new ProxyError(this.problem);
            const out = new Map<string, CheckedProxy>();
            for (const p of [this.https, this.http]) {
                if (!p || out.has(p.host)) continue;
                const host = bare(p.hostname);
                if (METADATA_HOSTS.has(host)) throw new ProxyError(`The company proxy ${p.display} is a cloud metadata service, so assessments never use it.`);
                let addresses: string[];
                if (net.isIP(host)) addresses = [host];
                else {
                    try {
                        addresses = (await (this.opts.resolver ?? systemResolver)(host)).map((a) => a.address);
                    } catch {
                        addresses = [];
                    }
                    if (!addresses.length) throw new ProxyError(`The address of the company proxy ${p.display} could not be found. Check HTTPS_PROXY on the platform server.`);
                }
                for (const a of addresses) {
                    const cls = addressClass(a);
                    if (cls === "cloud-metadata") throw new ProxyError(`The company proxy ${p.display} resolves to ${ADDRESS_WORDS[cls]}, so assessments never use it.`);
                    if (cls && !this.opts.allowPrivateProxy)
                        throw new ProxyError(`The company proxy ${p.display} is on ${ADDRESS_WORDS[cls]}. Set SECURITY_PROXY_ALLOW_PRIVATE=true on the platform server to let assessments use it, or turn SECURITY_USE_PROXY off.`);
                }
                out.set(p.host, { proxy: p, address: addresses[0]!, addresses });
            }
            return out;
        })();
        return this.checked;
    }

    /** Why this address may not be requested through the proxy (it is the proxy itself), or undefined. Needs `ready()` first. */
    async targetProblem(d: Allowed): Promise<string | undefined> {
        const checked = await this.check();
        const port = targetPort(d.url);
        for (const c of checked.values()) {
            // The proxy's name on any port; its address (a literal one too) on the proxy's own port.
            const sameName = !net.isIP(bare(c.proxy.hostname)) && bare(d.host) === bare(c.proxy.hostname);
            if (sameName || (c.addresses.includes(d.address) && port === c.proxy.port)) {
                return `${d.url.origin} is the company proxy itself (${c.proxy.display}); an assessment never assesses the proxy.`;
            }
        }
        return undefined;
    }

    /** The request through the proxy for an address that passed the guard, or undefined to connect directly (pinned). */
    async route(d: Allowed, o: { signal: AbortSignal; timeoutMs: number; allowInvalidCertificate: boolean }): Promise<ProxiedRequest | undefined> {
        const p = this.proxyFor(d.url);
        if (!p) return undefined;
        const c = (await this.check()).get(p.host)!;
        const auth = proxyAuthorization(p);
        if (d.url.protocol === "http:") {
            // Absolute form: the proxy fetches the address. The Host header is the site's.
            const target = new URL(d.url.href);
            target.hash = "";
            return {
                lib: p.protocol === "https:" ? https : http,
                options: { protocol: p.protocol, hostname: c.address, port: p.port, path: target.href, agent: false, ...(p.protocol === "https:" && !net.isIP(bare(p.hostname)) ? { servername: bare(p.hostname) } : {}) },
                headers: { host: d.url.host, ...(auth ? { "proxy-authorization": auth } : {}) },
                checkAnswer: (status, headers) => proxyAnswerProblem(p, d.url, status, headers),
            };
        }
        const tunnel = await openTunnel(c, d.host, targetPort(d.url), o.signal, o.timeoutMs);
        const secure = tls.connect({ socket: tunnel, ...(net.isIP(d.host) ? {} : { servername: d.host }), rejectUnauthorized: !o.allowInvalidCertificate, ALPNProtocols: ["http/1.1"] });
        secure.on("close", () => tunnel.destroy());
        return {
            lib: https,
            // No agent: the request uses the TLS session made inside the tunnel (createConnection), not a pool or the global proxy agent.
            options: { protocol: "https:", hostname: d.host, port: targetPort(d.url), path: `${d.url.pathname}${d.url.search}`, agent: undefined, createConnection: () => secure },
            headers: {},
        };
    }

    /** A raw connection to an https address through the proxy (for the one TLS handshake the scan makes), or undefined to go direct. */
    async tunnel(d: Allowed, signal: AbortSignal, timeoutMs = 20_000): Promise<net.Socket | undefined> {
        const p = this.proxyFor(d.url);
        if (!p) return undefined;
        const c = (await this.check()).get(p.host)!;
        return openTunnel(c, d.host, targetPort(d.url), signal, timeoutMs);
    }
}

function proxyAuthorization(p: ProxyAddress): string | undefined {
    if (!p.username) return undefined;
    return `Basic ${Buffer.from(`${p.username}:${p.password}`).toString("base64")}`;
}

/** The proxy's own refusal of a plain-http request, recognised by a 407 or an RFC 9209 Proxy-Status error, in plain words. */
function proxyAnswerProblem(p: ProxyAddress, u: URL, status: number, headers: Record<string, string>): string | undefined {
    if (status === 407) return proxyStatusWords(p, u.host, 407);
    const ps = headers["proxy-status"];
    if (ps && /error\s*=/i.test(ps)) return `The company proxy ${p.display} could not fetch ${u.host} (HTTP ${status}, ${ps.slice(0, 120)}).`;
    return undefined;
}

function proxyStatusWords(p: ProxyAddress, target: string, status: number): string {
    if (status === 407) {
        return p.username
            ? `The company proxy ${p.display} did not accept the user name and password (HTTP 407). Check them in HTTPS_PROXY on the platform server.`
            : `The company proxy ${p.display} asks for a user name and password (HTTP 407). Add them to the proxy address, for example http://user:password@proxy:8080.`;
    }
    if (status === 403) return `The company proxy ${p.display} refused the connection to ${target} (HTTP 403). The company network may block this address; ask IT to allow it.`;
    return `The company proxy ${p.display} could not connect to ${target} (HTTP ${status}).`;
}

/** Connects to the proxy's checked address (TLS for an https proxy), then asks it for a tunnel to host:port. */
function openTunnel(c: CheckedProxy, host: string, port: number, signal: AbortSignal, timeoutMs: number): Promise<net.Socket> {
    const p = c.proxy;
    const target = hostPort(host, port);
    return new Promise<net.Socket>((resolve, reject) => {
        if (signal.aborted) return reject(new ScopeError("stopped", "The assessment was stopped."));
        let settled = false;
        const sock: net.Socket =
            p.protocol === "https:"
                ? tls.connect({ host: c.address, port: p.port, ...(net.isIP(bare(p.hostname)) ? {} : { servername: bare(p.hostname) }) })
                : net.connect({ host: c.address, port: p.port });
        const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            sock.removeListener("readable", onReadable);
            if (err) {
                sock.destroy();
                reject(err);
            } else resolve(sock);
        };
        const onAbort = () => done(new ScopeError("stopped", "The assessment was stopped."));
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => done(new ProxyError(`The company proxy ${p.display} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
        let head = Buffer.alloc(0);
        // Read in paused mode (never "data"), so nothing after the proxy's answer is lost before TLS takes the socket over.
        const onReadable = () => {
            let chunk: Buffer | null;
            while (!settled && (chunk = sock.read() as Buffer | null) !== null) {
                head = Buffer.concat([head, chunk]);
                const end = head.indexOf("\r\n\r\n");
                if (end < 0) {
                    if (head.length > MAX_CONNECT_HEAD) done(new ProxyError(`The company proxy ${p.display} sent an answer that is not a proxy's.`));
                    continue;
                }
                const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1] ?? 0);
                if (status !== 200) return done(new ProxyError(status ? proxyStatusWords(p, target, status) : `The company proxy ${p.display} sent an answer that is not a proxy's.`));
                // Bytes after the blank line belong to the tunnel (a well-behaved proxy sends none before the client speaks).
                const rest = head.subarray(end + 4);
                if (rest.length) sock.unshift(rest);
                return done();
            }
        };
        sock.on("readable", onReadable);
        sock.once("error", (e: NodeJS.ErrnoException) => done(new ProxyError(`The company proxy ${p.display} could not be reached (${e.code ?? "connection failed"}).`)));
        sock.once("close", () => done(new ProxyError(`The company proxy ${p.display} closed the connection before the tunnel to ${target} was open.`)));
        const connected = p.protocol === "https:" ? "secureConnect" : "connect";
        sock.once(connected, () => {
            const auth = proxyAuthorization(p);
            sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
        });
    });
}
