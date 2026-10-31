/**
 * SCANNING: the same few read-only GETs the platform's security checks make (src/engine/security/specs.ts: the file and folder paths,
 * an ordinary request carrying a made-up Origin, the TLS certificate), all through the scope guard, then the checks' own judging over
 * everything seen (./judge.ts). No payloads, no form submissions, nothing but GET (and one TLS handshake with the site itself).
 */
import * as tls from "node:tls";
import { EXPOSED_FILE_GROUPS, LISTING_PATHS, PROBE_ORIGIN, type SecurityCall } from "../../engine/security/checks.js";
import type { RawResult } from "../findings/ingest.js";
import { isExcluded } from "./discover.js";
import { judgeCookies, judgeCors, judgeDisclosure, judgeExposedFiles, judgeHeaders, judgeTls, type TlsObservation } from "./judge.js";
import { RefusedError, RequestCapError, type DiscoveryResult, type Guard, type GuardFetchInit } from "./types.js";

/** One step of the scan, for progress and for the "what was not inspected" list. */
export interface ScanStepOutcome {
    step: string;
    ok: boolean;
    /** Plain reason when it did not complete. */
    reason?: string;
}

export interface ScanResult {
    results: RawResult[];
    outcomes: ScanStepOutcome[];
    /** Addresses the scan asked for (for the coverage text and tests). */
    requested: string[];
    /** Set when the request budget ran out: the scan stopped there. */
    capReached: boolean;
}

export interface ScanOptions {
    signal: AbortSignal;
    excludedPaths: string[];
    onProgress?: (done: number, total: number, text: string) => void;
    /** Retries of a transient network error (0-3, default 2). */
    retries?: number;
    /** For a retest: only these addresses are requested again (the original's open findings). */
    only?: { urls: string[]; categories: string[] };
}

/** Errors worth one more try: the connection dropped or timed out, or the server said it is busy for a moment. */
export function isTransient(e: unknown): boolean {
    const text = `${(e as { code?: string })?.code ?? ""} ${(e as { cause?: { code?: string } })?.cause?.code ?? ""} ${e instanceof Error ? e.message : String(e)}`;
    return /ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|socket hang up|other side closed|fetch failed/i.test(text);
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

/** A guarded GET with a bounded retry of transient errors (and of 502/503/504 answers). */
export async function fetchWithRetry(guard: Guard, url: string, init: GuardFetchInit, retries: number, signal: AbortSignal): Promise<SecurityCall> {
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal.aborted) throw new Error("Assessment cancelled");
        try {
            const a = await guard.fetch(url, { ...init, signal });
            if ([502, 503, 504].includes(a.status) && attempt < retries) {
                await sleep(400 * (attempt + 1), signal);
                continue;
            }
            const sent = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
            return { status: a.status, headers: a.headers, text: a.text, url: a.url, setCookies: a.setCookies, sent };
        } catch (e) {
            if (e instanceof RefusedError || e instanceof RequestCapError || signal.aborted || !isTransient(e)) throw e;
            last = e;
            await sleep(400 * (attempt + 1), signal);
        }
    }
    throw last;
}

const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 200);

/** The certificate the site presents, read with one TLS handshake to the address the guard checked (no second DNS lookup). */
export async function observeTls(guard: Guard, url: string, signal: AbortSignal): Promise<TlsObservation> {
    const u = new URL(url);
    const refusal = await guard.refusal(url);
    if (refusal) throw new RefusedError(url, refusal);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const address = (await guard.pinnedAddress?.(url)) ?? host;
    await guard.take?.();
    const isIp = /^[\d.]+$|:/.test(host);
    // Through the company proxy (SECURITY_USE_PROXY) the handshake goes through a CONNECT tunnel; otherwise straight to the checked address.
    const tunnel = await guard.tunnel?.(url, signal);
    return new Promise<TlsObservation>((resolve, reject) => {
        const socket = tls.connect({ ...(tunnel ? { socket: tunnel } : { host: address, port: Number(u.port) || 443 }), servername: isIp ? undefined : host, rejectUnauthorized: false, timeout: 10_000 }, () => {
            const cert = socket.getPeerCertificate();
            const authError = socket.authorized ? undefined : socket.authorizationError;
            socket.end();
            resolve({ url, host, cert: cert as TlsObservation["cert"], authError: authError ? { code: String((authError as { code?: string }).code ?? authError.message ?? authError) } : undefined });
        });
        const stop = () => (socket.destroy(), reject(new Error("Assessment cancelled")));
        signal.addEventListener("abort", stop, { once: true });
        socket.on("close", () => signal.removeEventListener("abort", stop));
        socket.on("timeout", () => (socket.destroy(), reject(new Error(`The TLS handshake with ${host} timed out.`))));
        socket.on("error", reject);
    });
}

/** The site's own home: the first page that loaded, else the target. */
function homeOf(d: DiscoveryResult): string {
    const ok = d.pages.find((p) => p.status >= 200 && p.status < 400);
    return (ok?.url ?? d.startUrl).split("#")[0]!;
}

const isHtml = (c: SecurityCall) => /text\/html|application\/xhtml/i.test(c.headers["content-type"] ?? "");

/**
 * Run the read-only probes and judge everything. Steps that fail are recorded (the assessment is then PARTIALLY_COMPLETED); a cancel
 * throws; the request budget running out stops the scan and is reported in `capReached`.
 */
export async function scan(guard: Guard, d: DiscoveryResult, opts: ScanOptions): Promise<ScanResult> {
    const retries = Math.max(0, Math.min(3, opts.retries ?? 2));
    const home = homeOf(d);
    const origin = new URL(home).origin;
    const outcomes: ScanStepOutcome[] = [];
    const requested: string[] = [];
    let capReached = false;
    const retest = opts.only;
    const wants = (category: string) => !retest || retest.categories.includes(category);

    const filePaths = [...EXPOSED_FILE_GROUPS.secrets, ...EXPOSED_FILE_GROUPS.other];
    const apiGets = [
        ...new Set(
            d.apiCalls
                .filter((k) => k.startsWith("GET /") && !k.includes("{"))
                .map((k) => k.slice(4))
                .slice(0, 3),
        ),
    ];
    // The work list: [label, url, init, kind]. A retest asks only for the addresses its findings were seen on.
    type Kind = "file" | "listing" | "cors" | "page";
    const work: Array<{ label: string; url: string; init: GuardFetchInit; kind: Kind }> = [];
    if (retest) {
        for (const url of retest.urls) {
            const path = new URL(url).pathname;
            if ((filePaths as readonly string[]).some((p) => p.toLowerCase() === path.toLowerCase())) work.push({ label: `Re-checking ${path}`, url, init: { headers: { Range: "bytes=0-4095" }, maxBytes: 4096 }, kind: "file" });
            else work.push({ label: `Re-checking ${path}`, url, init: { maxBytes: 64_000 }, kind: "page" });
            if (wants("cors")) work.push({ label: `Re-checking cross-origin answers of ${path}`, url, init: { headers: { Origin: PROBE_ORIGIN }, maxBytes: 4096 }, kind: "cors" });
        }
    } else {
        for (const p of filePaths) work.push({ label: `Checking that ${p} cannot be downloaded`, url: origin + p, init: { headers: { Range: "bytes=0-4095" }, maxBytes: 4096 }, kind: "file" });
        for (const p of LISTING_PATHS) work.push({ label: `Checking ${p} for a file listing`, url: origin + p, init: { maxBytes: 64_000 }, kind: "listing" });
        for (const p of [new URL(home).pathname, ...apiGets]) work.push({ label: `Checking cross-origin answers of ${p}`, url: origin + p, init: { headers: { Origin: PROBE_ORIGIN }, maxBytes: 4096 }, kind: "cors" });
    }

    const got: Record<Kind, SecurityCall[]> = { file: [], listing: [], cors: [], page: [] };
    const skipped: string[] = [];
    const total = work.length + 2;
    for (let i = 0; i < work.length; i++) {
        if (opts.signal.aborted) throw new Error("Assessment cancelled");
        const w = work[i]!;
        opts.onProgress?.(i, total, w.label);
        if (isExcluded(w.url, opts.excludedPaths)) {
            skipped.push(new URL(w.url).pathname);
            continue;
        }
        try {
            requested.push(w.url);
            got[w.kind].push(await fetchWithRetry(guard, w.url, { method: "GET", ...w.init }, retries, opts.signal));
        } catch (e) {
            if (opts.signal.aborted) throw new Error("Assessment cancelled");
            if (e instanceof RequestCapError) {
                capReached = true;
                outcomes.push({ step: w.label, ok: false, reason: "The most requests one assessment may send was reached, so the remaining checks were not made." });
                break;
            }
            if (e instanceof RefusedError) skipped.push(`${new URL(w.url).pathname} (${e.reason})`);
            else outcomes.push({ step: w.label, ok: false, reason: `The request failed: ${first(e)}` });
        }
    }
    if (skipped.length) outcomes.push({ step: "Excluded or refused addresses", ok: true, reason: `Not requested: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""}.` });

    let tlsObs: TlsObservation | undefined;
    if (/^https:/i.test(home) && !capReached && wants("tls")) {
        opts.onProgress?.(work.length, total, "Reading the HTTPS certificate");
        try {
            tlsObs = await observeTls(guard, home, opts.signal);
        } catch (e) {
            if (opts.signal.aborted) throw new Error("Assessment cancelled");
            outcomes.push({ step: "Reading the HTTPS certificate", ok: false, reason: `The certificate could not be read: ${first(e)}` });
        }
    }

    opts.onProgress?.(work.length + 1, total, "Judging what was seen");
    const pages = retest ? got.page.filter(isHtml) : d.documents.filter((c) => c.status >= 200 && c.status < 300 && isHtml(c));
    const everything = retest ? [...got.page, ...got.file, ...got.cors] : [...d.documents, ...d.apiAnswers, ...got.listing, ...got.cors];
    const results: RawResult[] = [];
    if (wants("headers")) results.push(...(await judgeHeaders(pages)));
    if (wants("cookies")) results.push(...(await judgeCookies(everything)));
    if (wants("cors")) results.push(...(await judgeCors(got.cors)));
    if (wants("exposed-files")) results.push(...(await judgeExposedFiles(got.file)));
    if (wants("information-disclosure")) results.push(...(await judgeDisclosure(retest ? got.page : [...d.documents, ...d.apiAnswers, ...got.listing])));
    if (tlsObs) results.push(...judgeTls(tlsObs));
    return { results, outcomes, requested, capReached };
}
