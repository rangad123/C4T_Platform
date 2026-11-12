/**
 * Judging: turns what the passive assessment observed (responses as received) into raw results for FIND's `ingest`, using the very same
 * judging logic and wording as the platform's read-only security checks (src/engine/security/checks.ts). Nothing here sends a request:
 * the one check that would make its own connection (the TLS handshake) is given an observation the assessment made through the scope
 * guard instead, and judged by that check's pure function.
 *
 * Each check runs per observed response, so every problem line is tied to the address it was seen on.
 */
import type * as tls from "node:tls";
import { evaluateSecurity, loadSecurityRuntime, SECURITY_FAILURE_PREFIX, TLS_WARN_DAYS, type SecurityCall, type SecurityCheck } from "../../engine/security/checks.js";
import { fromCheckFailure, type RawResult } from "../findings/normalize.js";

/** The problem part of a line ("- [low] X is missing, so ... Add X." → "x is missing"), digits folded so day counts do not matter. */
export function lineKey(check: string, line: string): string {
    const text = line.replace(/^-\s*\[\w+\]\s*/, "");
    return `${check}|${text.split(/[.,(]/)[0]!.toLowerCase().replace(/\d+/g, "#").trim()}`;
}

async function judgeEach(check: SecurityCheck, calls: SecurityCall[], expected?: (c: SecurityCall) => string | undefined): Promise<RawResult[]> {
    const out: RawResult[] = [];
    for (const call of calls) {
        const message = await evaluateSecurity(check, [call], expected?.(call));
        if (message?.startsWith(SECURITY_FAILURE_PREFIX)) out.push(...fromCheckFailure(check, message, call));
    }
    return out;
}

/**
 * Browser security headers, judged on each HTML page that loaded (HSTS only on https, as the check says). FIND's ingest groups the same
 * problem seen on several pages into one site-wide finding with a "seen on" list, so every page's result is handed over.
 */
export const judgeHeaders = (pages: SecurityCall[]) =>
    judgeEach("securityHeaders", pages, (c) => (/^https:/i.test(c.url) ? "csp,frame,nosniff,referrer,hsts" : "csp,frame,nosniff,referrer"));

/** Session-looking cookies without HttpOnly / Secure (https only) / SameSite: each cookie once, from the first answer that set it. */
export async function judgeCookies(calls: SecurityCall[]): Promise<RawResult[]> {
    const out: RawResult[] = [];
    const seen = new Set<string>();
    for (const call of calls) {
        for (const raw of call.setCookies ?? []) {
            const name = raw.split(";")[0]!.split("=")[0]!.trim();
            if (!name || seen.has(name)) continue;
            const single = { ...call, setCookies: [raw] };
            const message = await evaluateSecurity("cookieFlags", [single], /^https:/i.test(call.url) ? "httponly,secure,samesite" : "httponly,samesite");
            if (!message) continue;
            seen.add(name);
            out.push(...fromCheckFailure("cookieFlags", message, single));
        }
    }
    return out;
}

/** Answers to ordinary GETs sent with a made-up Origin (never contacted). */
export const judgeCors = (probes: SecurityCall[]) => judgeEach("corsPolicy", probes);

/** Files that should not be public: a hit needs the file's real content signature (a page answered for every path is no hit). */
export const judgeExposedFiles = (calls: SecurityCall[]) => judgeEach("noExposedFiles", calls);

/** Version banners (once per site and banner) and directory listings (per folder). */
export async function judgeDisclosure(calls: SecurityCall[]): Promise<RawResult[]> {
    const results = await judgeEach("noInfoDisclosure", calls);
    const seen = new Set<string>();
    return results.filter((r) => {
        const listing = /lists the files in a folder/.test(r.line ?? "");
        const key = listing ? `${r.url.split(/[?#]/)[0]}|listing` : lineKey(r.check, r.line ?? "");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** What one TLS handshake reported (made by the assessment through the scope guard). */
export interface TlsObservation {
    url: string;
    host: string;
    cert: Partial<tls.PeerCertificate> & { valid_to: string };
    authError?: { code?: string; message?: string };
}

/** The certificate, judged by the existing check's own pure function. */
export function judgeTls(obs: TlsObservation, nowMs = Date.now()): RawResult[] {
    const lines = loadSecurityRuntime().secCertLines({ cert: obs.cert, authError: obs.authError }, obs.host, nowMs, TLS_WARN_DAYS);
    const names = String(obs.cert.subjectaltname || obs.cert.subject?.CN || "").slice(0, 300);
    const note = `Certificate presented by ${obs.host}: valid until ${obs.cert.valid_to}${names ? `; names: ${names}` : ""}${obs.authError ? `; trust check: ${obs.authError.code ?? obs.authError.message ?? "failed"}` : ""}.`;
    return lines.map((line) => ({ check: "tlsCertificate" as const, line, url: obs.url, note }));
}
