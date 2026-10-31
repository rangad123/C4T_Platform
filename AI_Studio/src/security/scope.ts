/**
 * The scope guard: every request a security assessment sends goes through here (plain HTTP and the browser alike).
 *
 * Stable API (RUN uses it for every request):
 *   createScopeSession(app, options)      one per assessment: holds the rate limit, the request and byte caps, and the stop switch
 *   sessionOptionsFrom(settings)          the options that follow the platform settings (settings.ts)
 *   checkUrl(url, app, options?)          may this URL be requested? Resolves DNS; the answer carries the address to connect to
 *   guardedFetch(session, url, init?)     GET / HEAD / OPTIONS only, connects to the checked address (no second lookup), re-checks every
 *                                         redirect hop, waits for the rate limit, counts against the caps, reads at most N bytes
 *   browserRouteGuard(sessionOrApp, opts) a Playwright `context.route("**\/*", …)` handler: out-of-scope or non-read requests are aborted,
 *                                         in-scope ones are fetched by guardedFetch (pinned, rate-limited, counted) and fulfilled
 *   inScope(url, app)                     the scope rules alone (no DNS), for links found on pages
 *   addressClass(ip)                      "loopback" | "private" | "link-local" | "cgnat" | "multicast" | "cloud-metadata" | … or null (public)
 *   ScopeError                            what a refused request throws (`code` + a plain `message`)
 *
 * Rules: only http/https, no user:password in the address; the host must be the target's own origin or match a scope entry (an origin
 * "https://api.example.com", a host "api.example.com" or "api.example.com:8443", or a pattern "*.example.com" for its subdomains; host
 * and pattern entries cover the default port only); excluded path prefixes are never requested (compared without case, decoded and
 * with doubled slashes collapsed). DNS is resolved and EVERY answer must be allowed: loopback, private, link-local, CGNAT, multicast,
 * unspecified and reserved ranges are refused unless SECURITY_ALLOW_PRIVATE_TARGETS=true, and cloud metadata addresses and names are
 * refused always. The connection goes to the address that was checked.
 *
 * Not covered: the browser's own WebSocket connections and service-worker fetches are not routed through Playwright handlers (RUN blocks
 * service workers on its context); after a redirect the guard followed, the page's address stays the first one. Proxies (HTTPS_PROXY) are not
 * used by guardedFetch unless SECURITY_USE_PROXY is on (`proxy` option, ./proxy.ts): every address is still checked here first, but the
 * proxy resolves the name itself, so the pinning then depends on the proxy.
 */
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import type { Request as PwRequest, Route } from "playwright";
import type { SecurityApplication } from "./contract.js";
import type { SecuritySettings } from "./settings.js";

// ── refusals ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ScopeRefusal =
    | "bad-url"
    | "scheme"
    | "credentials"
    | "out-of-scope"
    | "excluded-path"
    | "blocked-address"
    | "cloud-metadata"
    | "dns-failed"
    | "method"
    | "request-limit"
    | "byte-limit"
    | "stopped"
    | "proxy";

export class ScopeError extends Error {
    constructor(
        readonly code: ScopeRefusal,
        message: string,
        readonly url?: string,
    ) {
        super(message);
        this.name = "ScopeError";
    }
}

// ── address classes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type AddressClass = "loopback" | "private" | "link-local" | "cgnat" | "multicast" | "unspecified" | "reserved" | "broadcast" | "cloud-metadata";

export const ADDRESS_WORDS: Record<AddressClass, string> = {
    loopback: "a loopback address (this computer)",
    private: "a private network address",
    "link-local": "a link-local address",
    cgnat: "a carrier-grade NAT address",
    multicast: "a multicast address",
    unspecified: "an unspecified address",
    reserved: "a reserved address",
    broadcast: "a broadcast address",
    "cloud-metadata": "a cloud metadata address",
};

/** Cloud provider instance-metadata endpoints (AWS, ECS, GCP, Azure, Alibaba, Oracle). Refused always. */
const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "169.254.169.253", "100.100.100.200", "192.0.0.192"]);
const METADATA_V6 = ["fd00:ec2::254", "fd00:ec2::23"];
/** Names that reach metadata services without DNS (or through a cloud's own DNS). Compared lowercased, trailing dot removed. */
export const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata", "instance-data", "instance-data.ec2.internal", "metadata.azure.internal", "metadata.tencentyun.com"]);

function v4Class(ip: string): AddressClass | null {
    if (METADATA_V4.has(ip)) return "cloud-metadata";
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    if (ip === "255.255.255.255") return "broadcast";
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 169 && b === 254) return "link-local";
    if (a === 100 && b >= 64 && b <= 127) return "cgnat";
    if (a >= 224 && a <= 239) return "multicast";
    if (a >= 240) return "reserved";
    // IETF protocol assignments, documentation (TEST-NET-1/2/3), benchmarking.
    if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "reserved";
    return null;
}

/** The eight 16-bit groups of an IPv6 address (with an embedded dotted IPv4 tail), or undefined when it is not one. */
export function expandIPv6(ip: string): number[] | undefined {
    let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const zone = s.indexOf("%");
    if (zone >= 0) s = s.slice(0, zone);
    if (!net.isIPv6(s)) return undefined;
    const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (tail) {
        const [p, q, r, t] = tail[1]!.split(".").map(Number) as [number, number, number, number];
        s = s.slice(0, -tail[1]!.length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
    }
    const [head, rest] = s.split("::") as [string, string | undefined];
    const left = head ? head.split(":") : [];
    const right = rest !== undefined && rest !== "" ? rest.split(":") : [];
    const fill = rest !== undefined ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array(Math.max(0, fill)).fill("0"), ...right].map((g) => parseInt(g || "0", 16));
    return groups.length === 8 ? groups : undefined;
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function v6Class(ip: string): AddressClass | null {
    const g = expandIPv6(ip);
    if (!g) return "reserved";
    for (const m of METADATA_V6) if (expandIPv6(m)!.every((x, i) => x === g[i])) return "cloud-metadata";
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    if (zeros(8)) return "unspecified";
    if (zeros(7) && g[7] === 1) return "loopback";
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d, deprecated), NAT64 (64:ff9b::a.b.c.d): judge the IPv4 inside.
    if (zeros(5) && g[5] === 0xffff) return v4Class(v4From(g[6]!, g[7]!));
    if (zeros(6)) return v4Class(v4From(g[6]!, g[7]!)) ?? "reserved";
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Class(v4From(g[6]!, g[7]!));
    // 6to4 (2002:AABB:CCDD::): the IPv4 is in groups 1-2.
    if (g[0] === 0x2002) {
        const inner = v4Class(v4From(g[1]!, g[2]!));
        if (inner) return inner;
    }
    const first = g[0]!;
    if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
    if ((first & 0xffc0) === 0xfec0) return "private"; // fec0::/10 site-local (deprecated)
    if ((first & 0xff00) === 0xff00) return "multicast"; // ff00::/8
    if (first === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation
    if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return "reserved"; // discard prefix
    return null;
}

/** The class of a literal IP address, or null for a public one (and for something that is not an IP address). */
export function addressClass(ip: string): AddressClass | null {
    const h = ip.replace(/^\[|\]$/g, "");
    if (net.isIPv4(h)) return v4Class(h);
    if (net.isIPv6(h.replace(/%.*$/, ""))) return v6Class(h);
    return null;
}

/** Why a name or address may not be reached at all (metadata), or under the private-target setting; undefined when it may. */
function addressProblem(hostOrIp: string, allowPrivate: boolean): { code: ScopeRefusal; reason: string } | undefined {
    const cls = addressClass(hostOrIp);
    if (!cls) return undefined;
    if (cls === "cloud-metadata") return { code: "cloud-metadata", reason: `${hostOrIp} is ${ADDRESS_WORDS[cls]}; it is never requested.` };
    if (allowPrivate) return undefined;
    return { code: "blocked-address", reason: `${hostOrIp} is ${ADDRESS_WORDS[cls]}. Private targets are refused unless the platform setting SECURITY_ALLOW_PRIVATE_TARGETS is on.` };
}

const bareHost = (u: URL) => u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

/**
 * Checks a target address without DNS (when an application is registered): scheme, no credentials, and literal addresses or names that
 * are never allowed. Undefined when nothing is wrong; DNS is checked again at every request.
 */
export function staticTargetProblem(raw: string, allowPrivate: boolean): string | undefined {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "That is not a web address. Use one like https://shop.example.com.";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http and https addresses can be assessed.";
    if (u.username || u.password) return "Remove the user name and password from the address.";
    const host = bareHost(u);
    if (METADATA_HOSTS.has(host)) return `${host} is a cloud metadata service; it is never assessed.`;
    const p = addressProblem(host, allowPrivate);
    if (p) return p.reason;
    if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) return `${host} is this computer. Private targets are refused unless the platform setting SECURITY_ALLOW_PRIVATE_TARGETS is on.`;
    return undefined;
}

// ── scope rules ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type ScopeApp = Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths">;

const defaultPort = (protocol: string) => (protocol === "https:" ? "443" : "80");
const portOf = (u: URL) => u.port || defaultPort(u.protocol);

/** One scope entry as written by a person: an origin, a host (optionally with a port), or "*.example.com". */
function entryMatches(entry: string, u: URL): boolean {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.includes("://")) {
        try {
            return new URL(e).origin === u.origin;
        } catch {
            return false;
        }
    }
    const host = bareHost(u);
    if (e.startsWith("*.")) {
        const base = e.slice(2).replace(/\.$/, "");
        return base.includes(".") && host.endsWith(`.${base}`) && portOf(u) === defaultPort(u.protocol);
    }
    // "host:port" (not an IPv6 literal) or a bare host on the default port.
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(e);
    if (!m) return false;
    const eh = m[1]!.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (eh !== host) return false;
    return m[2] ? m[2] === portOf(u) : portOf(u) === defaultPort(u.protocol);
}

/** Lowercased, decoded (as far as it decodes) path with doubled slashes collapsed. */
function pathForms(u: URL): string[] {
    const raw = u.pathname.toLowerCase();
    let decoded = raw;
    for (let i = 0; i < 3; i++) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    const collapse = (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    return [...new Set([collapse(raw), collapse(decoded)])];
}

export function excludedBy(u: URL, excludedPaths: readonly string[]): string | undefined {
    const forms = pathForms(u);
    for (const prefix of excludedPaths) {
        const p = prefix.trim().toLowerCase().replace(/\/{2,}/g, "/");
        if (p && forms.some((f) => f.startsWith(p))) return prefix;
    }
    return undefined;
}

export type ScopeVerdict = { ok: true; url: URL } | { ok: false; code: ScopeRefusal; reason: string };

/** The scope rules without DNS: scheme, credentials, host in scope, not excluded. */
export function inScope(raw: string | URL, app: ScopeApp): ScopeVerdict {
    let u: URL;
    try {
        u = typeof raw === "string" ? new URL(raw) : new URL(raw.href);
    } catch {
        return { ok: false, code: "bad-url", reason: "That is not a web address." };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, code: "scheme", reason: `Only http and https addresses are requested (this one is ${u.protocol.replace(/:$/, "")}).` };
    if (u.username || u.password) return { ok: false, code: "credentials", reason: "Addresses with a user name or password in them are not requested." };
    u.hash = "";
    let target: URL | undefined;
    try {
        target = new URL(app.targetUrl);
    } catch {
        target = undefined;
    }
    const inTarget = target !== undefined && target.origin === u.origin;
    if (!inTarget && !app.scope.some((e) => entryMatches(e, u))) return { ok: false, code: "out-of-scope", reason: `${u.origin} is outside the authorized scope.` };
    const ex = excludedBy(u, app.excludedPaths);
    if (ex) return { ok: false, code: "excluded-path", reason: `${u.pathname} is under the excluded path ${ex}.` };
    return { ok: true, url: u };
}

// ── DNS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Resolver = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export interface ScopeOptions {
    /** SECURITY_ALLOW_PRIVATE_TARGETS (default false). Cloud metadata stays refused either way. */
    allowPrivate?: boolean;
    /** Name lookup; the system resolver by default (tests pass their own to simulate DNS answers). */
    resolver?: Resolver;
}

export type ScopeDecision =
    | { allowed: true; url: URL; host: string; address: string; family: 4 | 6 }
    | { allowed: false; url: string; code: ScopeRefusal; reason: string };

/** The scope rules, then DNS: every address the name resolves to must be allowed. The answer names the address to connect to. */
export async function checkUrl(raw: string | URL, app: ScopeApp, opts: ScopeOptions = {}): Promise<ScopeDecision> {
    const href = typeof raw === "string" ? raw : raw.href;
    const v = inScope(raw, app);
    if (!v.ok) return { allowed: false, url: href, code: v.code, reason: v.reason };
    const u = v.url;
    const host = bareHost(u);
    const allowPrivate = opts.allowPrivate === true;
    const refuse = (code: ScopeRefusal, reason: string): ScopeDecision => ({ allowed: false, url: u.href, code, reason });
    if (METADATA_HOSTS.has(host)) return refuse("cloud-metadata", `${host} is a cloud metadata service; it is never requested.`);
    if (net.isIP(host)) {
        const p = addressProblem(host, allowPrivate);
        if (p) return refuse(p.code, p.reason);
        return { allowed: true, url: u, host, address: host, family: net.isIPv6(host) ? 6 : 4 };
    }
    if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) return refuse("blocked-address", `${host} is this computer. Private targets are refused unless the platform setting SECURITY_ALLOW_PRIVATE_TARGETS is on.`);
    let answers: Array<{ address: string; family: 4 | 6 }>;
    try {
        answers = await (opts.resolver ?? systemResolver)(host);
    } catch {
        answers = [];
    }
    if (!answers.length) return refuse("dns-failed", `The address of ${host} could not be found.`);
    for (const a of answers) {
        const p = addressProblem(a.address, allowPrivate);
        if (p) return refuse(p.code, `${host} resolves to ${p.reason}`);
    }
    const first = answers[0]!;
    return { allowed: true, url: u, host, address: first.address, family: first.family };
}

// ── the per-assessment session ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type ReadMethod = "GET" | "HEAD" | "OPTIONS";
const READ_METHODS = new Set<string>(["GET", "HEAD", "OPTIONS"]);

export type ScopeEvent =
    | { type: "request"; url: string; method: ReadMethod; status: number; via: "fetch" | "redirect" | "browser"; bytes: number }
    | { type: "blocked"; url: string; code: ScopeRefusal; reason: string; via: "fetch" | "redirect" | "browser" }
    | { type: "error"; url: string; message: string; via: "fetch" | "redirect" | "browser" };

export interface ScopeSessionOptions extends ScopeOptions {
    /** Most requests this session may send (SECURITY_MAX_REQUESTS, default 2000). */
    maxRequests?: number;
    /** Most bytes read from one response (default 5 MB); the rest is not read and the response says `truncated`. */
    maxResponseBytes?: number;
    /** Most bytes read across the session (default 100 MB). */
    maxTotalBytes?: number;
    /** Time limit of one request in ms (default 20 s). */
    timeoutMs?: number;
    /** Stops the session (cancel, emergency stop, time limit). */
    signal?: AbortSignal;
    /** For tests: a clock for the rate limit. */
    clock?: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
    /** Told about every request sent, refused or failed (RUN keeps out-of-scope links for coverage; never log headers or bodies). */
    onEvent?: (e: ScopeEvent) => void;
    userAgent?: string;
    /** The company proxy (SECURITY_USE_PROXY, ./proxy.ts). Absent: every request connects directly to the checked address. */
    proxy?: ScopeProxy;
}

/**
 * A way out through a company proxy (implemented in ./proxy.ts). The guard still checks every address first; the proxy only changes how
 * the connection is made, and it resolves the name itself (so the pinning then depends on the proxy: see the docs).
 */
export interface ScopeProxy {
    /** Checks the proxy itself once (set, readable, not a forbidden address); throws a plain Error when it may not be used. */
    ready(): Promise<void>;
    /** Why an address that passed the scope rules may still not be requested (it is the proxy itself), or undefined. */
    targetProblem(d: Extract<ScopeDecision, { allowed: true }>): Promise<string | undefined>;
    /** How to send one request through the proxy, or undefined to connect directly (NO_PROXY, this computer). */
    route(d: Extract<ScopeDecision, { allowed: true }>, o: { signal: AbortSignal; timeoutMs: number; allowInvalidCertificate: boolean }): Promise<ProxiedRequest | undefined>;
}

export interface ProxiedRequest {
    lib: typeof http | typeof https;
    /** Where to connect and the request path, replacing the direct connection's (method and headers are added by the session). */
    options: http.RequestOptions & { servername?: string };
    /** Headers added to the request (Host of the site, Proxy-Authorization). */
    headers: Record<string, string>;
    /** Recognises an answer that is the proxy's own refusal rather than the site's (plain-http requests): the plain reason, or undefined. */
    checkAnswer?(status: number, headers: Record<string, string>): string | undefined;
}

export interface FetchInit {
    method?: ReadMethod;
    /** Extra request headers (an Origin header for the CORS check, the browser's own headers). Host is always the URL's. */
    headers?: Record<string, string>;
    /** Follow redirects (default true, at most `maxRedirects`), each hop checked again. */
    followRedirects?: boolean;
    maxRedirects?: number;
    /** Bytes to read from the body (default the session's per-response cap, never more). */
    maxBytes?: number;
    /** Accept an invalid TLS certificate (to report on it); the answer says it was not valid. Default false. */
    allowInvalidCertificate?: boolean;
}

export interface TlsInfo {
    protocol: string | null;
    cipher: string | null;
    authorized: boolean;
    authorizationError: string | null;
    subject: string | null;
    issuer: string | null;
    validFrom: string | null;
    validTo: string | null;
}

export interface GuardedResponse {
    /** The address of the last response (after redirects that were followed). */
    url: string;
    status: number;
    /** Lowercased header names; repeated headers joined with ", " except set-cookie (see `setCookies`). */
    headers: Record<string, string>;
    setCookies: string[];
    body: Buffer;
    truncated: boolean;
    /** Every redirect hop that was followed, in order. */
    redirects: Array<{ url: string; status: number; location: string }>;
    /** A redirect that was NOT followed because its target is out of scope or not allowed. The 3xx itself is the response. */
    blockedRedirect: { url: string; code: ScopeRefusal; reason: string } | null;
    /** The address connected to (the one that was checked). */
    address: string;
    tls: TlsInfo | null;
    timeMs: number;
}

const realClock = {
    now: () => Date.now(),
    sleep: (ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(new ScopeError("stopped", "The assessment was stopped."));
            const t = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(t);
                reject(new ScopeError("stopped", "The assessment was stopped."));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
        }),
};

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; Crowd4Test-SecurityAssessment/1.0; passive read-only assessment)";

export class ScopeSession {
    readonly stats = { requests: 0, blocked: 0, bytes: 0 };
    private tokens: number;
    private last: number;
    private queue: Promise<void> = Promise.resolve();
    private readonly ctl = new AbortController();
    private stopReason: string | null = null;
    private readonly inflight = new Set<http.ClientRequest>();
    readonly options: Required<Pick<ScopeSessionOptions, "maxRequests" | "maxResponseBytes" | "maxTotalBytes" | "timeoutMs" | "userAgent">> & ScopeSessionOptions;
    private readonly clock: NonNullable<ScopeSessionOptions["clock"]>;

    constructor(
        readonly app: Pick<SecurityApplication, "targetUrl" | "scope" | "excludedPaths" | "maxRequestsPerSecond"> & Partial<SecurityApplication>,
        opts: ScopeSessionOptions = {},
    ) {
        this.options = {
            maxRequests: 2000,
            maxResponseBytes: 5 * 1024 * 1024,
            maxTotalBytes: 100 * 1024 * 1024,
            timeoutMs: 20_000,
            userAgent: DEFAULT_USER_AGENT,
            ...opts,
        };
        this.clock = opts.clock ?? realClock;
        this.tokens = this.rate;
        this.last = this.clock.now();
        if (opts.signal) {
            if (opts.signal.aborted) this.stop("The assessment was stopped.");
            else opts.signal.addEventListener("abort", () => this.stop("The assessment was stopped."), { once: true });
        }
    }

    /** Requests per second (1-10, from the application). */
    get rate(): number {
        return Math.max(1, Math.min(10, Math.floor(this.app.maxRequestsPerSecond || 1)));
    }

    get stopped(): boolean {
        return this.stopReason !== null;
    }

    /** No more requests: waiting ones fail, requests on the wire are torn down. */
    stop(reason = "The assessment was stopped."): void {
        if (this.stopReason !== null) return;
        this.stopReason = reason;
        this.ctl.abort();
        for (const r of this.inflight) r.destroy(new ScopeError("stopped", reason));
        this.inflight.clear();
    }

    emit(e: ScopeEvent): void {
        if (e.type === "blocked") this.stats.blocked++;
        try {
            this.options.onEvent?.(e);
        } catch {
            /* a listener's problem is not the request's */
        }
    }

    async checkUrl(raw: string | URL): Promise<ScopeDecision> {
        const d = await checkUrl(raw, this.app, { allowPrivate: this.options.allowPrivate === true, ...(this.options.resolver ? { resolver: this.options.resolver } : {}) });
        // Through a company proxy the address is still checked here first; the proxy itself is never a target.
        if (d.allowed && this.options.proxy) {
            const why = await this.options.proxy.targetProblem(d);
            if (why) return { allowed: false, url: d.url.href, code: "proxy", reason: why };
        }
        return d;
    }

    private assertLive(): void {
        if (this.stopReason !== null) throw new ScopeError("stopped", this.stopReason);
    }

    /** Takes one request from the cap and one token from the rate limit (waiting for it). In order of arrival. */
    async take(): Promise<void> {
        this.assertLive();
        const turn = this.queue.then(async () => {
            this.assertLive();
            if (this.stats.requests >= this.options.maxRequests) throw new ScopeError("request-limit", `The request limit of this assessment (${this.options.maxRequests}) is reached.`);
            if (this.stats.bytes >= this.options.maxTotalBytes) throw new ScopeError("byte-limit", "The amount of data this assessment may read is reached.");
            for (;;) {
                const now = this.clock.now();
                this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
                this.last = now;
                if (this.tokens >= 1) {
                    this.tokens -= 1;
                    this.stats.requests++;
                    return;
                }
                await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000), this.ctl.signal);
                this.assertLive();
            }
        });
        // The next caller waits for this one whether it succeeded or not.
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    /** One request to an address that already passed `checkUrl` (pinned to its address). No redirect handling. */
    async sendChecked(decision: Extract<ScopeDecision, { allowed: true }>, init: FetchInit = {}): Promise<Omit<GuardedResponse, "redirects" | "blockedRedirect">> {
        const method = (init.method ?? "GET").toUpperCase();
        if (!READ_METHODS.has(method)) throw new ScopeError("method", `Only GET, HEAD and OPTIONS requests are sent (not ${method}).`, decision.url.href);
        await this.take();
        const maxBytes = Math.min(init.maxBytes ?? this.options.maxResponseBytes, this.options.maxResponseBytes);
        const u = decision.url;
        const headers: Record<string, string> = { "user-agent": this.options.userAgent, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" };
        for (const [k, v] of Object.entries(init.headers ?? {})) {
            const key = k.toLowerCase();
            if (key === "host" || key === "content-length" || key === "transfer-encoding" || key === "connection" || key.startsWith(":")) continue;
            headers[key] = v;
        }
        const started = this.clock.now();
        // Company proxy (SECURITY_USE_PROXY): the address was checked above; the proxy makes the connection (it resolves the name itself).
        const via = this.options.proxy ? await this.options.proxy.route(decision, { signal: this.ctl.signal, timeoutMs: this.options.timeoutMs, allowInvalidCertificate: init.allowInvalidCertificate === true }) : undefined;
        if (via) Object.assign(headers, via.headers);
        const lib = via?.lib ?? (u.protocol === "https:" ? https : http);
        // The checked address is the only one this connection may use: the lookup answers with it, whatever DNS would say now.
        const pinned = decision.address;
        const family = decision.family;
        const lookup = (_h: string, o: { all?: boolean } | number | undefined, cb: (...args: unknown[]) => void) => {
            if (typeof o === "object" && o?.all) cb(null, [{ address: pinned, family }]);
            else cb(null, pinned, family);
        };
        return await new Promise((resolve, reject) => {
            const req = lib.request(
                via ? { ...via.options, method, headers } : {
                    protocol: u.protocol,
                    hostname: decision.host,
                    port: u.port || undefined,
                    path: `${u.pathname}${u.search}`,
                    method,
                    headers,
                    agent: false,
                    lookup: lookup as never,
                    ...(u.protocol === "https:" ? { rejectUnauthorized: init.allowInvalidCertificate !== true, ...(net.isIP(decision.host) ? {} : { servername: decision.host }) } : {}),
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    let truncated = false;
                    const sock = res.socket as TLSSocket | null;
                    const tls = u.protocol === "https:" && sock && typeof sock.getPeerCertificate === "function" ? tlsInfo(sock) : null;
                    const finish = () => {
                        this.inflight.delete(req);
                        clearTimeout(timer);
                        this.stats.bytes += size;
                        const { headers: hs, setCookies } = flatHeaders(res.headers);
                        const proxyProblem = via?.checkAnswer?.(res.statusCode ?? 0, hs);
                        if (proxyProblem) return reject(new Error(proxyProblem));
                        resolve({ url: u.href, status: res.statusCode ?? 0, headers: hs, setCookies, body: Buffer.concat(chunks), truncated, address: pinned, tls, timeMs: this.clock.now() - started });
                    };
                    res.on("data", (c: Buffer) => {
                        if (truncated) return;
                        const room = maxBytes - size;
                        if (c.length > room) {
                            if (room > 0) chunks.push(c.subarray(0, room));
                            size += Math.max(0, room);
                            truncated = true;
                            res.destroy();
                            finish();
                            return;
                        }
                        chunks.push(c);
                        size += c.length;
                    });
                    res.on("end", () => {
                        if (!truncated) finish();
                    });
                    res.on("error", (e) => {
                        if (!truncated) {
                            this.inflight.delete(req);
                            clearTimeout(timer);
                            reject(e);
                        }
                    });
                },
            );
            this.inflight.add(req);
            const timer = setTimeout(() => req.destroy(new Error(`No answer from ${u.origin} within ${Math.round(this.options.timeoutMs / 1000)} seconds.`)), this.options.timeoutMs);
            req.on("error", (e) => {
                this.inflight.delete(req);
                clearTimeout(timer);
                reject(e);
            });
            req.end();
        });
    }
}

function flatHeaders(h: http.IncomingHttpHeaders): { headers: Record<string, string>; setCookies: string[] } {
    const out: Record<string, string> = {};
    let setCookies: string[] = [];
    for (const [k, v] of Object.entries(h)) {
        if (v === undefined) continue;
        if (k === "set-cookie") {
            setCookies = Array.isArray(v) ? v : [v];
            continue;
        }
        out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return { headers: out, setCookies };
}

function tlsInfo(sock: TLSSocket): TlsInfo {
    let cert: ReturnType<TLSSocket["getPeerCertificate"]> | undefined;
    try {
        cert = sock.getPeerCertificate();
    } catch {
        cert = undefined;
    }
    const name = (o: unknown) => {
        if (!o || typeof o !== "object") return null;
        const r = o as Record<string, unknown>;
        return String(r.CN ?? r.O ?? "") || null;
    };
    const err = (sock as unknown as { authorizationError?: unknown }).authorizationError;
    return {
        protocol: sock.getProtocol?.() ?? null,
        cipher: sock.getCipher?.()?.name ?? null,
        authorized: sock.authorized === true,
        authorizationError: err ? String(err) : null,
        subject: cert && Object.keys(cert).length ? name(cert.subject) : null,
        issuer: cert && Object.keys(cert).length ? name(cert.issuer) : null,
        validFrom: cert?.valid_from ?? null,
        validTo: cert?.valid_to ?? null,
    };
}

/** Options that follow the platform settings (SECURITY_ALLOW_PRIVATE_TARGETS, SECURITY_MAX_REQUESTS, SECURITY_MAX_RESPONSE_BYTES). */
export function sessionOptionsFrom(s: SecuritySettings): ScopeSessionOptions {
    return { allowPrivate: s.allowPrivateTargets, maxRequests: s.maxRequestsPerAssessment, maxResponseBytes: s.maxResponseBytes, maxTotalBytes: s.maxTotalBytes };
}

export function createScopeSession(app: ScopeSession["app"], opts: ScopeSessionOptions = {}): ScopeSession {
    return new ScopeSession(app, opts);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A read-only request through the guard. Throws ScopeError when the address itself is refused (or a cap or the stop switch says no),
 * and the network's own error when the request fails. A redirect to a refused address is not followed: the 3xx is returned with
 * `blockedRedirect` set.
 */
export async function guardedFetch(session: ScopeSession, raw: string | URL, init: FetchInit = {}): Promise<GuardedResponse> {
    const first = await session.checkUrl(raw);
    if (!first.allowed) {
        session.emit({ type: "blocked", url: first.url, code: first.code, reason: first.reason, via: "fetch" });
        throw new ScopeError(first.code, first.reason, first.url);
    }
    return fetchChecked(session, first, init, "fetch");
}

/** Credentials a browser or caller attached for one origin are not carried to another origin by a redirect. */
const ORIGIN_BOUND_HEADERS = ["cookie", "authorization", "proxy-authorization"];

/** From an address that passed the check: the request, then each redirect hop checked again (see guardedFetch). */
async function fetchChecked(session: ScopeSession, first: Extract<ScopeDecision, { allowed: true }>, init: FetchInit, via: "fetch" | "browser"): Promise<GuardedResponse> {
    const follow = init.followRedirects !== false;
    const maxRedirects = Math.max(0, Math.min(10, init.maxRedirects ?? 5));
    const redirects: GuardedResponse["redirects"] = [];
    const hopCookies: string[] = [];
    let decision: Extract<ScopeDecision, { allowed: true }> = first;
    let method: ReadMethod = init.method ?? "GET";
    let headers = init.headers;
    for (let hop = 0; ; hop++) {
        let res: Awaited<ReturnType<ScopeSession["sendChecked"]>>;
        try {
            res = await session.sendChecked(decision, { ...init, method, ...(headers ? { headers } : {}) });
        } catch (e) {
            if (!(e instanceof ScopeError)) session.emit({ type: "error", url: decision.url.href, message: e instanceof Error ? e.message : String(e), via: hop ? "redirect" : via });
            throw e;
        }
        session.emit({ type: "request", url: res.url, method, status: res.status, via: hop ? "redirect" : via, bytes: res.body.length });
        const location = res.headers.location;
        if (!follow || !REDIRECTS.has(res.status) || !location || hop >= maxRedirects) return { ...res, setCookies: [...hopCookies, ...res.setCookies], redirects, blockedRedirect: null };
        let next: URL;
        try {
            next = new URL(location, res.url);
        } catch {
            return { ...res, redirects, blockedRedirect: { url: location.slice(0, 500), code: "bad-url", reason: "The redirect points to something that is not a web address." } };
        }
        const d = await session.checkUrl(next);
        if (!d.allowed) {
            session.emit({ type: "blocked", url: d.url, code: d.code, reason: d.reason, via: "redirect" });
            return { ...res, redirects, blockedRedirect: { url: d.url, code: d.code, reason: d.reason } };
        }
        redirects.push({ url: res.url, status: res.status, location: next.href });
        hopCookies.push(...res.setCookies);
        if (res.status === 303) method = "GET";
        if (headers && d.url.origin !== decision.url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !ORIGIN_BOUND_HEADERS.includes(k.toLowerCase())));
        decision = d;
    }
}

// ── the browser ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The guard fetches each in-scope request itself (pinned address, rate limit, caps) and hands the answer to the browser. Redirects are
 * followed by the guard, every hop checked, and the browser gets the final answer (with the cookies the hops set): the page's address
 * then stays the one the browser asked for. A redirect is never handed to the browser as a 3xx, because a browser follows those without
 * calling route handlers again (Playwright: "the handler will only be called for the first url if the response is a redirect"); and
 * letting the browser fetch on its own (`route.continue()`) is never done for the same reason, and because its DNS lookup is not pinned.
 */
export interface BrowserGuardOptions extends ScopeSessionOptions {
    /** Resource types never requested (default image, media, font: a passive assessment does not need them and they cost requests). */
    skipResourceTypes?: string[];
    /** Told about every answer handed to the browser (headers, cookies and body as received), for the checks to judge. */
    onResponse?: (res: GuardedResponse, request: PwRequest) => void;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "proxy-connection", "upgrade", "te", "trailer"]);

/**
 * A Playwright route handler: `await context.route("**\/*", browserRouteGuard(session))`. Out-of-scope, excluded, private or
 * non-read requests are aborted (and reported through the session's onEvent with via "browser").
 */
export function browserRouteGuard(sessionOrApp: ScopeSession | ScopeSession["app"], opts: BrowserGuardOptions = {}): (route: Route, request: PwRequest) => Promise<void> {
    const session = sessionOrApp instanceof ScopeSession ? sessionOrApp : new ScopeSession(sessionOrApp, opts);
    const skip = new Set(opts.skipResourceTypes ?? ["image", "media", "font"]);
    const abort = async (route: Route, reason: "blockedbyclient" | "failed" = "blockedbyclient") => {
        try {
            await route.abort(reason);
        } catch {
            /* the page or context is already gone */
        }
    };
    return async (route, request) => {
        const url = request.url();
        const method = request.method().toUpperCase();
        if (session.stopped) return abort(route);
        if (skip.has(request.resourceType())) return abort(route);
        if (!READ_METHODS.has(method)) {
            session.emit({ type: "blocked", url, code: "method", reason: `A ${method} request was not sent: the assessment only reads.`, via: "browser" });
            return abort(route);
        }
        const d = await session.checkUrl(url);
        if (!d.allowed) {
            session.emit({ type: "blocked", url: d.url, code: d.code, reason: d.reason, via: "browser" });
            return abort(route);
        }
        let res: GuardedResponse;
        try {
            const hs = await request.allHeaders().catch(() => request.headers());
            res = await fetchChecked(session, d, { method: method as ReadMethod, headers: hs }, "browser");
        } catch {
            // fetchChecked already reported it (a cap, the stop switch, or the network's own error)
            return abort(route, "failed");
        }
        if (res.blockedRedirect || REDIRECTS.has(res.status)) {
            // Out of scope, or too many hops: the browser must not follow it on its own.
            if (!res.blockedRedirect) session.emit({ type: "blocked", url: res.headers.location ?? url, code: "out-of-scope", reason: "Too many redirects; the last one was not followed.", via: "browser" });
            return abort(route);
        }
        if (res.truncated) {
            session.emit({ type: "blocked", url, code: "byte-limit", reason: "The answer was larger than the per-response limit and was not passed to the browser.", via: "browser" });
            return abort(route, "failed");
        }
        try {
            opts.onResponse?.(res, request);
        } catch {
            /* a listener's problem is not the page's */
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
        // Playwright splits set-cookie on newlines, so each cookie reaches the browser as its own header.
        if (res.setCookies.length) headers["set-cookie"] = res.setCookies.join("\n");
        try {
            await route.fulfill({ status: res.status, headers, body: res.body });
        } catch {
            /* the page or context is already gone */
        }
    };
}
