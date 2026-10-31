/**
 * Company networks: proxies and company certificates. Shared by the runner (src/agent/net.ts) and the platform server
 * (src/platform/outbound-network.ts).
 *
 * Built only on what Node.js itself offers, no proxy library: `http.setGlobalProxyFromEnv` (Node 24.14+) sends `fetch` and
 * `http(s).request` through the proxy, `tls.getCACertificates` / `tls.setDefaultCACertificates` (Node 24.5+) add the computer's own
 * certificate store and a company certificate file to the ones Node trusts. On an older Node.js each is skipped with a plain note.
 *
 * A proxy address may carry a user name and password (`http://maya:secret@proxy:8080`). That password is a secret: nothing here
 * ever puts it into a message. `display` is the redacted form (`http://maya:***@proxy:8080`), and `redactCredentials` masks any
 * `scheme://user:password@` in a text, in case one arrives inside another library's error.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";

/** Always reached directly, whatever the proxy settings say: this computer itself. Both spellings of ::1 (fetch and http.request read it differently). */
export const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "::1", "[::1]"];
export const MAX_PROXY_URL_LENGTH = 500;
const MAX_BYPASS_LENGTH = 4000;
const MAX_BYPASS_ENTRIES = 200;
/** A certificate file bigger than this is not a list of company certificates. */
export const MAX_CA_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CA_CERTS = 500;

export interface ProxyAddress {
    /** The address to use, credentials included (secret when it has a password). */
    url: string;
    protocol: "http:" | "https:";
    hostname: string;
    port: number;
    /** host:port, never the user name or password. */
    host: string;
    username: string;
    password: string;
    /** For messages: the address with the password replaced by ***. */
    display: string;
}

export type ProxyParse = { ok: true; proxy: ProxyAddress } | { ok: false; message: string };

/**
 * Read a proxy address: `http://host:port`, `https://host:port`, `http://user:password@host:port`, or a bare `host:port` (taken as http).
 * The message of a refusal never repeats the address (it may hold a password).
 */
export function parseProxyAddress(raw: string): ProxyParse {
    const text = raw.trim();
    if (!text) return { ok: false, message: "The proxy address is empty." };
    if (text.length > MAX_PROXY_URL_LENGTH) return { ok: false, message: `The proxy address is longer than ${MAX_PROXY_URL_LENGTH} characters.` };
    if (/[\u0000- \u007f]/.test(text)) return { ok: false, message: "The proxy address contains spaces or control characters." };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let u: URL;
    try {
        u = new URL(withScheme);
    } catch {
        return { ok: false, message: "The proxy address could not be read. Write it like http://proxy.example.com:8080." };
    }
    if (/^socks/i.test(u.protocol)) return { ok: false, message: "SOCKS proxies are not supported. Use the company's http proxy (http://host:port)." };
    if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "The proxy address must start with http:// or https://." };
    if (!u.hostname) return { ok: false, message: "The proxy address has no host name. Write it like http://proxy.example.com:8080." };
    if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { ok: false, message: "The proxy address must be only a host and a port (http://proxy.example.com:8080), without a path. Automatic proxy scripts (PAC files) are not supported." };
    const protocol = u.protocol;
    const port = u.port ? Number(u.port) : protocol === "https:" ? 443 : 80;
    let username = "";
    let password = "";
    try {
        username = decodeURIComponent(u.username);
        password = decodeURIComponent(u.password);
    } catch {
        return { ok: false, message: "The user name or password in the proxy address could not be read. Write special characters with %-codes (for example @ as %40)." };
    }
    const host = `${u.hostname}:${port}`;
    const display = `${protocol}//${u.username ? `${u.username}${u.password ? ":***" : ""}@` : ""}${host}`;
    const url = `${protocol}//${u.username ? `${u.username}${u.password ? `:${u.password}` : ""}@` : ""}${host}`;
    return { ok: true, proxy: { url, protocol, hostname: u.hostname, port, host, username, password, display } };
}

/** `scheme://user:password@` anywhere in a text becomes `scheme://user:***@`. */
export function redactCredentials(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/]*)@/gi, (_m, scheme: string, user: string) => `${scheme}${user}:***@`);
}

/** The redacted form of an address for a message; never the password, even when the address does not parse. */
export function redactProxyUrl(raw: string): string {
    const p = parseProxyAddress(raw);
    return p.ok ? p.proxy.display : redactCredentials(raw).slice(0, 120);
}

/** The values a proxy address can give away when it shows up in some text: the password (raw and %-encoded) and the whole address. */
export function proxySecrets(p: ProxyAddress | undefined): string[] {
    if (!p?.password) return [];
    const out = new Set([p.password, encodeURIComponent(p.password), p.url]);
    return [...out].filter((s) => s.length >= 4);
}

export interface ProxyEnv {
    https?: string;
    http?: string;
    noProxy?: string;
}

const first = (env: NodeJS.ProcessEnv, names: string[]): string | undefined => {
    for (const n of names) {
        const v = env[n];
        if (v !== undefined && v.trim()) return v.trim();
    }
    return undefined;
};

/** The proxy variables of an environment. The lower-case name wins over the upper-case one, as in curl and in Node's own fetch. */
export function proxyEnvOf(env: NodeJS.ProcessEnv): ProxyEnv {
    const https = first(env, ["https_proxy", "HTTPS_PROXY"]);
    const httpP = first(env, ["http_proxy", "HTTP_PROXY"]);
    const noProxy = first(env, ["no_proxy", "NO_PROXY"]);
    return { ...(https ? { https } : {}), ...(httpP ? { http: httpP } : {}), ...(noProxy ? { noProxy } : {}) };
}

/** Split a NO_PROXY list (commas or spaces) into entries, capped. */
export function bypassEntries(list: string | undefined): string[] {
    return (list ?? "")
        .slice(0, MAX_BYPASS_LENGTH)
        .split(/[\s,]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_BYPASS_ENTRIES);
}

/** The list with this computer's own addresses added (they are never sent to a proxy). */
export function withLoopbackBypass(list: string | undefined): string {
    const entries = bypassEntries(list);
    for (const l of LOOPBACK_BYPASS) if (!entries.includes(l)) entries.push(l);
    return entries.join(",");
}

/**
 * Does a NO_PROXY list send this host straight, without the proxy? The rules both of Node's proxy implementations (fetch and
 * http.request) agree on: `*` is everything; `name` is that name; `name:port` is that name on that port; `.example.com` is
 * example.com and every name below it; `*.example.com` every name below it. Names compare without case.
 */
export function bypassMatches(hostname: string, port: number, list: string | undefined): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    for (const raw of bypassEntries(list)) {
        if (raw === "*") return true;
        let entry = raw;
        let entryPort: number | undefined;
        const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
        const hostPort = /^([^:]+):(\d+)$/.exec(raw);
        if (bracketed) {
            entry = bracketed[1]!;
            if (bracketed[2]) entryPort = Number(bracketed[2]);
        } else if (hostPort) {
            entry = hostPort[1]!;
            entryPort = Number(hostPort[2]);
        }
        if (entryPort !== undefined && entryPort !== port) continue;
        if (entry.startsWith("*.")) {
            if (host.endsWith(entry.slice(1))) return true;
        } else if (entry.startsWith(".")) {
            if (host === entry.slice(1) || host.endsWith(entry)) return true;
        } else if (host === entry) return true;
    }
    return false;
}

/** The proxy Node's fetch uses for a target (https falls back to the http proxy, as Node's fetch does), or undefined for "direct". */
export function proxyForTarget(target: URL, p: ProxyEnv): string | undefined {
    const chosen = target.protocol === "https:" ? (p.https ?? p.http) : target.protocol === "http:" ? p.http : undefined;
    if (!chosen) return undefined;
    const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    return bypassMatches(target.hostname, port, p.noProxy) ? undefined : chosen;
}

/**
 * Write proxy settings into an environment so programs started from it (npm, Playwright's browser download, the runner's own helpers)
 * use them too. Windows has one variable per name whatever its case, so only the upper-case names are written there (and lower-case
 * copies in a plain object are removed, so a child never gets two different values); elsewhere both spellings are written.
 */
export function exportProxyEnv(target: NodeJS.ProcessEnv, p: ProxyEnv, platform: NodeJS.Platform = process.platform): void {
    const set = (upper: string, value: string | undefined) => {
        const lower = upper.toLowerCase();
        if (value === undefined) return;
        target[upper] = value;
        if (platform === "win32") {
            if (Object.prototype.hasOwnProperty.call(target, lower) && target !== process.env) delete target[lower];
        } else target[lower] = value;
    };
    set("HTTPS_PROXY", p.https);
    set("HTTP_PROXY", p.http);
    set("NO_PROXY", p.noProxy);
}

export type Applied = { ok: true } | { ok: false; note: string };

/** Send this process's fetch and http(s).request through the proxy (Node's built-in support). */
export function applyGlobalProxy(p: ProxyEnv): Applied {
    const fn = (http as unknown as { setGlobalProxyFromEnv?: (env: NodeJS.ProcessEnv) => () => void }).setGlobalProxyFromEnv;
    if (typeof fn !== "function") return { ok: false, note: `This Node.js (${process.version}) cannot send its own connections through a proxy (that needs Node.js 24.14 or newer), so they go directly. Update Node.js, or use the complete download, which brings its own.` };
    fn({ ...(p.https ? { HTTPS_PROXY: p.https } : {}), ...(p.http ? { HTTP_PROXY: p.http } : {}), ...(p.noProxy ? { NO_PROXY: p.noProxy } : {}) });
    return { ok: true };
}

export type CertificateFile = { ok: true; pems: string[] } | { ok: false; message: string };

/**
 * Read a company certificate file: one or more PEM certificates (`-----BEGIN CERTIFICATE-----`), or one DER certificate (a binary
 * .cer/.crt). Every certificate is parsed before it is accepted, so a wrong file is refused at start, not at the first connection.
 */
export function readCertificateFile(file: string): CertificateFile {
    let bytes: Buffer;
    try {
        const st = fs.statSync(file);
        if (!st.isFile()) return { ok: false, message: "The certificate file is not a file." };
        if (st.size > MAX_CA_FILE_BYTES) return { ok: false, message: `The certificate file is larger than ${MAX_CA_FILE_BYTES / 1024 / 1024} MB, so it is not a list of certificates.` };
        bytes = fs.readFileSync(file);
    } catch {
        return { ok: false, message: "The certificate file could not be read. Check the path." };
    }
    const text = bytes.toString("latin1");
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    const pems: string[] = [];
    try {
        if (blocks.length === 0) {
            if (/-----BEGIN /.test(text)) return { ok: false, message: "The certificate file holds no certificate (only a key or another kind of PEM block). Use the company's root certificate." };
            pems.push(new crypto.X509Certificate(bytes).toString());
        } else {
            for (const b of blocks.slice(0, MAX_CA_CERTS)) pems.push(new crypto.X509Certificate(b).toString());
        }
    } catch {
        return { ok: false, message: "The certificate file could not be read as certificates (PEM or DER). Ask IT for the company's root certificate as a .pem or .crt file." };
    }
    return { ok: true, pems };
}

export interface TrustResult {
    /** Certificates from this computer's store that were added. */
    system: number;
    /** Certificates from the company file that were added. */
    file: number;
    /** NODE_EXTRA_CA_CERTS was set (Node already trusts its certificates). */
    extra: boolean;
    notes: string[];
}

/**
 * Trust, for this process's https connections, Node's own list plus (optionally) the computer's certificate store and the certificates
 * of a company file. NODE_EXTRA_CA_CERTS is part of Node's own list already.
 */
export function applyTrust(opts: { system: boolean; pems: string[] }): TrustResult {
    const t = tls as unknown as { getCACertificates?: (kind?: string) => string[]; setDefaultCACertificates?: (certs: string[]) => void };
    const extra = Boolean(process.env.NODE_EXTRA_CA_CERTS);
    if (!opts.system && opts.pems.length === 0) return { system: 0, file: 0, extra, notes: [] };
    if (typeof t.getCACertificates !== "function" || typeof t.setDefaultCACertificates !== "function") {
        return { system: 0, file: 0, extra, notes: [`This Node.js (${process.version}) cannot add certificates while it runs (that needs Node.js 24.5 or newer), so this computer's certificate store${opts.pems.length ? " and the certificate file" : ""} are not used. Set NODE_EXTRA_CA_CERTS to the company's certificate file before starting, or update Node.js.`] };
    }
    const notes: string[] = [];
    const base = t.getCACertificates("default");
    const seen = new Set(base.map((c) => c.trim()));
    const all = [...base];
    const add = (list: string[]): number => {
        let n = 0;
        for (const c of list) {
            const k = c.trim();
            if (seen.has(k)) continue;
            seen.add(k);
            all.push(c);
            n++;
        }
        return n;
    };
    let system = 0;
    if (opts.system) {
        try {
            system = add(t.getCACertificates("system"));
        } catch {
            notes.push("This computer's certificate store could not be read, so only Node.js's own certificates are trusted.");
        }
    }
    const file = add(opts.pems);
    t.setDefaultCACertificates(all);
    return { system, file, extra, notes };
}

/** One link of an error's cause chain, as far as it helps to explain a network failure. */
interface Link {
    code?: string;
    message: string;
    address?: string;
    port?: number;
    hostname?: string;
}

function chain(e: unknown): Link[] {
    const out: Link[] = [];
    const visit = (v: unknown, depth: number) => {
        if (!v || typeof v !== "object" || depth > 6 || out.length > 12) return;
        const o = v as { code?: unknown; message?: unknown; address?: unknown; port?: unknown; hostname?: unknown; cause?: unknown; errors?: unknown };
        out.push({
            ...(typeof o.code === "string" ? { code: o.code } : {}),
            message: typeof o.message === "string" ? o.message : "",
            ...(typeof o.address === "string" ? { address: o.address } : {}),
            ...(typeof o.port === "number" ? { port: o.port } : {}),
            ...(typeof o.hostname === "string" ? { hostname: o.hostname } : {}),
        });
        visit(o.cause, depth + 1);
        if (Array.isArray(o.errors)) for (const x of o.errors.slice(0, 4)) visit(x, depth + 1);
    };
    visit(e, 0);
    return out;
}

export type NetworkProblemKind = "proxy-auth" | "proxy-refused" | "proxy-unreachable" | "certificate" | "dns" | "refused" | "timeout" | "reset" | "stopped" | "other";

export interface NetworkProblem {
    kind: NetworkProblemKind;
    /** Starts in lower case, no full stop: "the proxy … asks for a user name and password (HTTP 407)". */
    reason: string;
    /** What to do, one or two sentences (may be empty). */
    advice: string;
}

const CERT_UNTRUSTED = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "CERT_UNTRUSTED", "CERT_SIGNATURE_FAILURE"]);

/** How to say where the proxy setting came from, for advice. */
export const PROXY_SOURCE_WORDS: Record<string, string> = {
    flag: "--proxy",
    env: "the HTTPS_PROXY / HTTP_PROXY variables",
    file: "\"proxy\" in runner.json",
    windows: "the Windows proxy setting",
};

/**
 * Explain a failed connection in words, with what to do. `target` is the host:port the connection was for; `proxy` the proxy that
 * was used for it (undefined when the connection went directly). Never includes a request, a header or a password.
 */
export function describeNetworkError(e: unknown, ctx: { target: string; proxy?: ProxyAddress; proxySource?: string }): NetworkProblem {
    const links = chain(e);
    const codes = links.map((l) => l.code).filter((c): c is string => Boolean(c));
    const text = links.map((l) => l.message).join(" | ");
    const p = ctx.proxy;
    const where = p ? `the proxy ${p.display}` : "";
    const from = ctx.proxySource ? ` (set by ${PROXY_SOURCE_WORDS[ctx.proxySource] ?? ctx.proxySource})` : "";
    const name = (e as { name?: unknown } | undefined)?.name;
    if (name === "TimeoutError") return { kind: "timeout", reason: p ? `the platform did not answer in time (through ${where})` : "the platform did not answer in time", advice: "" };
    if (name === "AbortError" && !/Proxy response|tunnel/i.test(text)) return { kind: "stopped", reason: "the request was stopped", advice: "" };

    // The proxy answered the tunnel request with something other than "connected".
    const status = /Proxy response \((\d{3})\)/.exec(text)?.[1] ?? (/tunnel[^|]*HTTP\/1\.[01] (\d{3})/i.exec(text)?.[1] ?? undefined);
    if (p && status) {
        const s = Number(status);
        if (s === 407) {
            return p.username
                ? { kind: "proxy-auth", reason: `${where} did not accept the user name and password (HTTP 407)`, advice: "Check them. Special characters in a password must be written with %-codes, for example @ as %40. The password is never shown or sent to the platform." }
                : {
                      kind: "proxy-auth",
                      reason: `${where} asks for a user name and password (HTTP 407)`,
                      advice: `Add them to the proxy address, for example --proxy http://user:password@${p.host}. The password is never shown or sent to the platform.${ctx.proxySource === "windows" ? " If the proxy accepts only your Windows sign-in (NTLM or Kerberos), the runner cannot use it: ask IT for a proxy address that accepts a user name and password." : ""}`,
                  };
        }
        if (s === 403) return { kind: "proxy-refused", reason: `${where} refused the connection to ${ctx.target} (HTTP 403)`, advice: `The company network may block this address. Ask IT to allow ${ctx.target}.` };
        return { kind: "proxy-refused", reason: `${where} could not open a connection to ${ctx.target} (HTTP ${s})`, advice: "Check the platform address. If it is right, ask IT whether the proxy can reach it, or add it to NO_PROXY if it must be reached directly." };
    }

    const certCode = codes.find((c) => CERT_UNTRUSTED.has(c));
    if (certCode) {
        return {
            kind: "certificate",
            reason: `the platform's certificate was not accepted (${certCode}): the connection is signed by a certificate this computer does not trust`,
            advice: "A company security tool that inspects https traffic usually causes this. Ask IT for the company's root certificate (a .pem or .crt file) and start the runner with --ca-file <file>, or install it in this computer's certificate store.",
        };
    }
    const otherCert = codes.find((c) => /CERT|SSL|TLS/.test(c));
    if (otherCert) {
        if (otherCert === "CERT_HAS_EXPIRED") return { kind: "certificate", reason: `the platform's certificate was not accepted (${otherCert})`, advice: "The certificate has expired, or this computer's date and time are wrong. Check the clock." };
        if (otherCert === "ERR_TLS_CERT_ALTNAME_INVALID") return { kind: "certificate", reason: `the platform's certificate was not accepted (${otherCert}): it is made out for another name`, advice: "Check the platform address. A company security tool may also present its own certificate." };
        return { kind: "certificate", reason: `the platform's certificate was not accepted (${otherCert})`, advice: "" };
    }

    const withAddr = links.find((l) => l.code && (l.address || l.hostname));
    const atProxy = (l: Link | undefined): boolean => Boolean(p && l && ((l.port === p.port && l.address !== undefined) || (l.hostname !== undefined && l.hostname.toLowerCase() === p.hostname.toLowerCase())));
    const code = codes[0];
    if (p && (atProxy(withAddr) || (code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code) && !withAddr))) {
        const why = code === "ENOTFOUND" || code === "EAI_AGAIN" ? "its name could not be found" : code === "ECONNREFUSED" ? "the connection was refused" : "it did not answer";
        return { kind: "proxy-unreachable", reason: `${where} could not be reached (${why})`, advice: `Check the proxy address${from}. If this network needs no proxy, start the runner with --proxy none.` };
    }
    if (code === "ECONNREFUSED") return { kind: "refused", reason: "the connection was refused (is the platform running, and is the address right?)", advice: "" };
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { kind: "dns", reason: "the address could not be found (check --url and the network)", advice: p ? "" : "On a company network the platform may only be reachable through a proxy: start the runner with --proxy http://host:port." };
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return { kind: "timeout", reason: "the connection did not get through", advice: p ? "" : "A firewall may block it. On a company network you may need a proxy: start the runner with --proxy http://host:port." };
    if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") return { kind: "reset", reason: "the connection was cut", advice: p ? "" : "If this keeps happening, a firewall or security tool may be blocking it." };
    return { kind: "other", reason: code ? `network error ${code}` : "network error", advice: "" };
}

/** "<lead>: <reason>." plus the advice: the whole sentence for a log line or an error. */
export function problemSentence(lead: string, pr: NetworkProblem): string {
    return `${lead}: ${pr.reason}.${pr.advice ? ` ${pr.advice}` : ""}`;
}
