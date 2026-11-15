/**
 * The request guard for external scanners: a forward proxy on this machine that every scanner process is pointed at, and that refuses
 * every request it cannot show to be allowed.
 *
 * What it allows, request by request (not only the first one):
 *   - methods GET, HEAD and OPTIONS, without a request body;
 *   - addresses inside the application's authorized scope, outside its excluded paths, checked by the same scope guard the platform's
 *     own read-only checks use (../scope.ts): the name is resolved, every answer must be an allowed address, and the connection goes to
 *     the address that was checked. The application's rate limit and the scan's request budget apply as well.
 * What it refuses, with a plain reason, and records:
 *   - any other method, a body, an address outside the scope, an excluded path;
 *   - CONNECT tunnels (HTTPS through a proxy): inside a tunnel the guard cannot see the method or the path, and it does not decrypt
 *     traffic. An application served over HTTPS is therefore refused before any scanner starts (`egressTargetProblem`);
 *   - protocol upgrades (WebSockets) and requests that are not addressed to a proxy at all;
 *   - a `_method` query parameter naming anything but GET or HEAD. Method-override headers (X-HTTP-Method-Override and its
 *     spellings) are dropped rather than passed on.
 * Redirects are handed back to the scanner as they are; when it follows one, that is a new request and is checked again.
 *
 * The log: every request the guard sees gets one entry - time, method, host, path (never the query string, never headers or bodies),
 * verdict, status or reason, with the path and the reason passed through the shared redaction. The first MAX_LOG entries are kept with
 * the scan run; the counts always cover every request.
 */
import http from "node:http";
import type net from "node:net";
import type { Duplex } from "node:stream";
import { createScopeSession, guardedFetch, ScopeError, type Resolver, type ScopeSession, type ScopeSessionOptions } from "../scope.js";
import type { SecurityApplication } from "../contract.js";
import { redactText } from "../../shared/redact-text.js";
import { GUARD_MARK_HEADER, SOURCE_HEADER, type RequestLog } from "./request-log.js";

export const EGRESS_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const ALLOWED = new Set<string>(EGRESS_METHODS);
/** Most log entries kept per scanner run. */
export const MAX_LOG = 2_000;
/** Request headers never passed on: hop-by-hop ones and the proxy's own. */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "via"]);
/**
 * Method-override headers, never passed on: some frameworks treat a GET carrying `X-HTTP-Method-Override: DELETE` as a DELETE, which
 * would turn an allowed read into a write. The query-string spelling (`_method=`) is refused instead (see `methodOverrideProblem`).
 */
export const METHOD_OVERRIDE_HEADERS: readonly string[] = ["x-http-method-override", "x-http-method", "x-method-override"];
const OVERRIDE = new Set(METHOD_OVERRIDE_HEADERS);
/** Methods a `_method` query parameter may name and still be passed on. */
const OVERRIDE_OK = new Set(["GET", "HEAD"]);
/**
 * A header name as a server that maps headers CGI-style would read it: lower case, with `_` as `-` (`X_HTTP_Method_Override` reaches
 * such a server as HTTP_X_HTTP_METHOD_OVERRIDE, the same variable the hyphen spelling becomes).
 */
export const headerKey = (name: string): string => name.trim().toLowerCase().replace(/_/g, "-");
/** May this request header be passed on to the application? */
export const passesRequestHeader = (name: string): boolean => {
    const key = headerKey(name);
    return !(HOP.has(key) || OVERRIDE.has(key) || key === SOURCE_HEADER || key.startsWith("x-c4t-") || key.startsWith("proxy-"));
};
/**
 * May this header of the application's answer be passed back? The platform's own marks (`x-c4t-guard`, every `x-c4t-*`) are the
 * guard's voice: an application that sends one could otherwise have its own words read as the guard's refusal.
 */
export const passesResponseHeader = (name: string): boolean => {
    const key = name.toLowerCase();
    return !(HOP.has(key) || headerKey(name).startsWith("x-c4t-"));
};

/** Why this address is refused for asking the application to treat the request as another method (`?_method=DELETE`), or undefined. */
export function methodOverrideProblem(url: string): string | undefined {
    let params: URLSearchParams;
    try {
        params = new URL(url).searchParams;
    } catch {
        return undefined;
    }
    for (const [key, value] of params) {
        if (key.trim().toLowerCase() !== "_method") continue;
        if (!OVERRIDE_OK.has(value.trim().toUpperCase())) return "Requests that ask the application to treat them as another method (a _method query parameter other than GET or HEAD) are refused.";
    }
    return undefined;
}

export interface EgressEntry {
    at: string;
    /** Who sent it: "scanner:<id>" or "platform:<check family>" (see EgressOptions.source). */
    source?: string;
    method: string;
    host: string;
    /** The path only: a query string can carry secrets and is never logged. */
    path: string;
    verdict: "allowed" | "refused" | "failed";
    status?: number;
    reason?: string;
}

export interface EgressCounts {
    total: number;
    allowed: number;
    refused: number;
    failed: number;
    byMethod: Record<string, number>;
}

export interface EgressGuard {
    /** What a scanner is given as its proxy, e.g. http://127.0.0.1:41234 */
    readonly url: string;
    readonly port: number;
    entries(): EgressEntry[];
    counts(): EgressCounts;
    close(): Promise<void>;
}

export interface EgressOptions {
    /** The application whose scope decides what may be requested. */
    app: Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "maxRequestsPerSecond">;
    /** SECURITY_ALLOW_PRIVATE_TARGETS: the same answer the platform's own checks use. */
    allowPrivate?: boolean;
    /** Most requests the guard forwards (the scan's request budget). */
    maxRequests?: number;
    /** Stops forwarding (cancel, time limit). */
    signal?: AbortSignal;
    /** Port to listen on (0 = any free port). Always 127.0.0.1. */
    port?: number;
    /**
     * Listen on this Unix socket instead of a TCP port, so nothing on this machine's network can reach the guard: the isolated run
     * (isolation.ts) relays to it from inside a network namespace. `port` is then the port of that relay, inside the namespace.
     */
    socketPath?: string;
    /** For tests: name lookup. */
    resolver?: Resolver;
    /**
     * Who the requests come from, on every entry ("scanner:nuclei", "platform"). A request may name itself more precisely with the
     * SOURCE_HEADER header, only below this prefix ("platform:discovery"); the header is never passed on.
     */
    source?: string;
    /** A log shared with other senders (./request-log.ts): every entry is added to it as well. */
    log?: RequestLog;
    /** Accept an invalid TLS certificate of the target (the platform's own checks report on it). Default false. */
    allowInvalidCertificate?: boolean;
    /** The guard's own requests: the company proxy (SECURITY_USE_PROXY) and the response size caps of the platform's settings. */
    session?: Pick<ScopeSessionOptions, "proxy" | "maxResponseBytes" | "maxTotalBytes">;
}

/**
 * Why no scanner may run against this target through the guard, or undefined. HTTPS is the case: the guard would only see a tunnel.
 * The dependency-free alternative (a TLS-intercepting proxy with a per-run certificate authority the scanner trusts) needs certificate
 * generation that node:crypto does not offer, so it is not built.
 */
export function egressTargetProblem(target: { origin: string; urls: readonly string[] }): string | undefined {
    const https = [target.origin, ...target.urls].some((u) => /^https:/i.test(u));
    if (!https) return undefined;
    return "The application is served over HTTPS. The platform's request guard cannot see the method or the address of a request inside an HTTPS connection without decrypting it, which it does not do, so it cannot guarantee that every scanner request stays within GET, HEAD and OPTIONS on in-scope addresses. The external scanners were not run.";
}

/** The environment that points a scanner process at the guard, every common spelling, with nothing exempted. */
export function egressEnv(proxyUrl: string): Record<string, string> {
    return { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" };
}

/** Start the guard on 127.0.0.1. Rejects (and the scan is refused) when it cannot listen. */
export async function startEgressGuard(options: EgressOptions): Promise<EgressGuard> {
    const session: ScopeSession = createScopeSession(options.app, {
        ...options.session,
        allowPrivate: options.allowPrivate === true,
        ...(options.maxRequests ? { maxRequests: options.maxRequests } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.resolver ? { resolver: options.resolver } : {}),
    });
    const log: EgressEntry[] = [];
    const counts: EgressCounts = { total: 0, allowed: 0, refused: 0, failed: 0, byMethod: {} };
    const record = (e: Omit<EgressEntry, "at" | "source">, claimed?: string) => {
        const source = options.source && claimed?.startsWith(`${options.source}:`) ? claimed.slice(0, 80) : options.source;
        counts.total++;
        counts[e.verdict]++;
        counts.byMethod[e.method] = (counts.byMethod[e.method] ?? 0) + 1;
        // The log is kept with the scan run and shown to its viewers: paths (reset or invite tokens, signed paths) and reasons (which can
        // quote an address) go through the shared redaction first.
        const entry: EgressEntry = { at: new Date().toISOString(), ...(source ? { source } : {}), ...e, host: e.host.slice(0, 255), path: redactText(e.path.slice(0, 500), 500), ...(e.reason ? { reason: redactText(e.reason.slice(0, 300), 300) } : {}) };
        if (log.length < MAX_LOG) log.push(entry);
        options.log?.add(entry);
    };
    const refuseSocket = (socket: Duplex, status: number, reason: string) => {
        try {
            socket.end(`HTTP/1.1 ${status} ${status === 405 ? "Method Not Allowed" : "Forbidden"}\r\n${GUARD_MARK_HEADER}: refused\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
        } catch {
            socket.destroy();
        }
    };

    const server = http.createServer((req, res) => {
        void handle(req, res);
    });
    const sockets = new Set<net.Socket>();
    server.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    });
    server.on("connect", (req, socket) => {
        const reason = "HTTPS tunnels (CONNECT) are refused: inside a tunnel the request guard cannot see the method or the address.";
        record({ method: "CONNECT", host: String(req.url ?? ""), path: "", verdict: "refused", status: 403, reason });
        refuseSocket(socket, 403, reason);
    });
    server.on("upgrade", (req, socket) => {
        const { host, path } = where(req.url);
        const reason = "Protocol upgrades (WebSockets) are refused by the request guard.";
        record({ method: String(req.method ?? "").toUpperCase(), host, path, verdict: "refused", status: 403, reason });
        refuseSocket(socket, 403, reason);
    });
    server.on("clientError", (_e, socket) => socket.destroy());

    async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const method = String(req.method ?? "").toUpperCase();
        const { host, path, url } = where(req.url);
        const claimed = String(req.headers[SOURCE_HEADER] ?? "");
        const refuse = (status: number, reason: string) => {
            record({ method, host, path, verdict: "refused", status, reason }, claimed);
            req.resume();
            if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close", [GUARD_MARK_HEADER]: "refused" });
            res.end(reason);
        };
        if (!url) return refuse(403, "The request was not addressed through a proxy (no absolute http address), so it was refused.");
        if (!ALLOWED.has(method)) return refuse(405, `Only GET, HEAD and OPTIONS requests are allowed (this one is ${method || "unnamed"}).`);
        if (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"]) return refuse(403, "Requests with a body are refused.");
        const override = methodOverrideProblem(url);
        if (override) return refuse(403, override);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
            const key = k.toLowerCase();
            if (!passesRequestHeader(k) || v === undefined) continue;
            headers[key] = Array.isArray(v) ? v.join(", ") : v;
        }
        headers.via = "1.1 c4t-request-guard";
        try {
            const answer = await guardedFetch(session, url, { method: method as (typeof EGRESS_METHODS)[number], headers, followRedirects: false, allowInvalidCertificate: options.allowInvalidCertificate === true });
            record({ method, host, path, verdict: "allowed", status: answer.status }, claimed);
            const out: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(answer.headers)) if (passesResponseHeader(k) && k !== "set-cookie") out[k] = v;
            if (answer.setCookies.length) out["set-cookie"] = answer.setCookies;
            out["content-length"] = String(answer.body.length);
            res.writeHead(answer.status, out);
            res.end(method === "HEAD" ? undefined : answer.body);
        } catch (e) {
            if (e instanceof ScopeError) return refuse(e.code === "request-limit" ? 429 : 403, e.message);
            const reason = `The request could not be completed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200)}`;
            record({ method, host, path, verdict: "failed", status: 502, reason }, claimed);
            if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8", [GUARD_MARK_HEADER]: "failed" });
            res.end(reason);
        }
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        const listening = () => {
            server.off("error", reject);
            resolve();
        };
        if (options.socketPath) server.listen(options.socketPath, listening);
        else server.listen(options.port ?? 0, "127.0.0.1", listening);
    });
    const port = options.socketPath ? (options.port ?? 0) : (server.address() as net.AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        entries: () => log.slice(),
        counts: () => ({ ...counts, byMethod: { ...counts.byMethod } }),
        close: () =>
            new Promise<void>((resolve) => {
                session.stop("The scan ended.");
                for (const s of sockets) s.destroy();
                server.close(() => resolve());
            }),
    };
}

/** Host and path of a proxy request line, and the absolute address when it is one. Never the query string. */
function where(raw: string | undefined): { host: string; path: string; url?: string } {
    const text = String(raw ?? "");
    try {
        const u = new URL(text);
        if (u.protocol !== "http:" && u.protocol !== "https:") return { host: u.host, path: u.pathname };
        return { host: u.host, path: u.pathname, url: u.href };
    } catch {
        return { host: "", path: text.split("?")[0]!.slice(0, 500) };
    }
}

/** The guard's record as coverage lines for the scan run and the report. */
export function egressCoverage(scanner: string, guard: Pick<EgressGuard, "counts" | "entries">): { inspected: string[]; notInspected: string[]; requestLog: EgressEntry[] } {
    const c = guard.counts();
    const methods = Object.entries(c.byMethod).map(([m, n]) => `${m} ${n}`).join(", ");
    const inspected = [`Request guard: ${scanner} sent ${c.total} request${c.total === 1 ? "" : "s"} through it${methods ? ` (${methods})` : ""}; ${c.allowed} allowed, ${c.refused} refused, ${c.failed} failed.`];
    const reasons = new Map<string, number>();
    for (const e of guard.entries()) if (e.verdict === "refused" && e.reason) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
    const notInspected = [...reasons].slice(0, 5).map(([reason, n]) => `Request guard refused ${n} ${scanner} request${n === 1 ? "" : "s"}: ${reason}`);
    if (c.total > MAX_LOG) notInspected.push(`Request guard: only the first ${MAX_LOG} of ${c.total} requests are listed in the run's request log.`);
    return { inspected, notInspected, requestLog: guard.entries() };
}
