/**
 * The `fetch` a client of an AI configuration uses (ai-config.ts). A configuration's address is typed by a customer, so its calls must
 * not become a way into the server's own network:
 *
 *  - No redirect is followed (as `redirect: "error"`): a 3xx answer fails the call, so a public address cannot send the key, or the
 *    request, on to a private one.
 *  - With BLOCK_PRIVATE_TARGETS=true the address is checked when the connection is made, on the addresses the name resolved to for that
 *    very connection (the `lookup` of the socket), so a name that resolves to a public address when saved and a private one later (DNS
 *    rebinding) is refused too. Loopback, private ranges and link-local (169.254.169.254) are refused (net-guard.ts, isPrivateHost).
 *
 * Built on node:http(s) because the platform's fetch takes no lookup of its own. Only what the AI SDK sends is supported: a string or
 * bytes body, headers, an abort signal.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { isPrivateHost } from "./net-guard.js";

/** The refusal of a private address. Its code makes the AI error classes read it as a network failure ("Address not reachable"). */
export class BlockedAddressError extends Error {
    readonly code = "ENETUNREACH";
    constructor() {
        super("This address is not reachable from AI Studio.");
        this.name = "BlockedAddressError";
    }
}

const blocking = () => process.env.BLOCK_PRIVATE_TARGETS === "true";

type LookupAll = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;
type LookupOne = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/** The socket's own name lookup, refusing private addresses: what is checked is what the connection then uses. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupAll | LookupOne): void {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return (callback as LookupAll)(err, []);
        const list = addresses as dns.LookupAddress[];
        if (blocking() && (isPrivateHost(hostname) || list.some((a) => isPrivateHost(a.address)))) return (callback as LookupAll)(new BlockedAddressError() as NodeJS.ErrnoException, []);
        if (options.all) return (callback as LookupAll)(null, list);
        const first = list[0];
        if (!first) return (callback as LookupOne)(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), "", 4);
        (callback as LookupOne)(null, first.address, first.family);
    });
}

function bodyOf(body: unknown): Buffer | undefined {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof URLSearchParams) return Buffer.from(body.toString());
    throw new TypeError("This request body is not supported here.");
}

/** The status of the redirect a guardedFetch call refused, else undefined. */
export const refusedRedirect = (e: unknown): number | undefined => {
    const s = (e as { cause?: { status?: unknown } } | null)?.cause?.status;
    return typeof s === "number" ? s : undefined;
};

/** A `fetch` that follows no redirect and, with BLOCK_PRIVATE_TARGETS on, connects only to public addresses. */
export const guardedFetch: typeof fetch = async (input, init) => {
    let url: URL;
    let method = init?.method ?? "GET";
    let headers = new Headers(init?.headers);
    let body = bodyOf(init?.body);
    if (input instanceof Request) {
        url = new URL(input.url);
        method = init?.method ?? input.method;
        if (!init?.headers) headers = new Headers(input.headers);
        if (body === undefined && input.body) body = Buffer.from(await input.arrayBuffer());
    } else url = new URL(String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Only http and https addresses can be used.");
    if (url.username || url.password) throw new TypeError("An address with a user name or password cannot be used.");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // An address written as a number never reaches the lookup.
    if (net.isIP(host) && blocking() && isPrivateHost(host)) throw new TypeError("fetch failed", { cause: new BlockedAddressError() });
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

    const out: Record<string, string> = {};
    headers.forEach((v, k) => (out[k] = v));
    // Only encodings this function can undo are asked for.
    out["accept-encoding"] = "gzip, deflate, br";
    if (body) out["content-length"] = String(body.length);

    return new Promise<Response>((resolve, reject) => {
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(url, { method, headers: out, lookup: guardedLookup as never, agent: false }, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                req.destroy();
                return reject(new TypeError("fetch failed", { cause: Object.assign(new Error("The address answered with a redirect, which is not followed."), { status }) }));
            }
            const h = new Headers();
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
            const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
            let stream: Readable = res;
            if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
            else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
            else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
            if (stream !== res) {
                h.delete("content-encoding");
                h.delete("content-length");
                res.on("error", (e) => stream.destroy(e));
            }
            const empty = status === 204 || status === 304 || method === "HEAD";
            if (empty) res.resume();
            resolve(new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: h }));
        });
        const onAbort = () => req.destroy(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal?.removeEventListener("abort", onAbort));
        req.on("error", (e) => reject(e instanceof DOMException ? e : new TypeError("fetch failed", { cause: e })));
        req.end(body);
    });
};
