/**
 * Passive security checks: read-only HTTP looks at an application's own origin, judged deterministically
 * (no LLM, no attack payloads, no state changes: GET requests only, plus one TLS handshake).
 *
 * One source of truth, like ../health/checks.ts: `SECURITY_HELPER_SOURCE` is plain JavaScript. The API
 * generator pastes it verbatim into every script that uses a security check, and `loadSecurityRuntime()`
 * compiles the very same text for tests, so a script and the engine cannot disagree about a message.
 *
 * Every check inspects *all responses received so far in the test* (`calls`), so one spec can probe
 * several paths and report every hit:
 *  - securityHeaders    expected = "csp,frame,nosniff,referrer,hsts". HSTS is only judged on https
 *                       responses: a plain-http site cannot have it and is never flagged for it.
 *  - cookieFlags        session-looking cookies (name contains sess/sid/auth/token/jwt/login/sso; CSRF
 *                       cookies are exempt because scripts must read them) need HttpOnly, Secure (on https
 *                       only) and SameSite.
 *  - corsPolicy         responses to a request with a made-up Origin: wildcard / "null" / the echoed
 *                       origin together with Allow-Credentials, or an echoed origin without credentials.
 *  - noExposedFiles     a probed path counts only when the body has that file's *content signature*
 *                       (".git/HEAD starts with ref:", ".env has KEY=value lines and is not HTML"...). Many
 *                       single-page apps answer 200 + HTML to every path; that is never a hit.
 *  - noInfoDisclosure   Server / X-Powered-By style version banners and "Index of /" directory listings.
 *  - tlsCertificate     https only: trusted, matches the host, not expired, not expiring within N days.
 * Failure messages: "<prefix> <headline>" then "- [severity] problem. How to fix." lines (max 5).
 */
import * as tls from "node:tls";

/** First words of every security failure; securityFinding keys on it. */
export const SECURITY_FAILURE_PREFIX = "Security check failed:";

export const SECURITY_CHECKS = ["securityHeaders", "cookieFlags", "corsPolicy", "noExposedFiles", "noInfoDisclosure", "tlsCertificate"] as const;
export type SecurityCheck = (typeof SECURITY_CHECKS)[number];
export const isSecurityCheck = (c: string): c is SecurityCheck => (SECURITY_CHECKS as readonly string[]).includes(c);

export const SECURITY_MAX_LINES = 5;
export const TLS_WARN_DAYS = 14;
/** The made-up origin sent to see whether the server echoes it back. It is never contacted. */
export const PROBE_ORIGIN = "https://untrusted-origin.example";

/** Paths probed for sensitive files, with the content signature that proves a real hit. */
export const EXPOSED_FILE_GROUPS = {
    secrets: ["/.env", "/.git/HEAD", "/.git/config", "/.svn/entries", "/wp-config.php.bak", "/.htpasswd"],
    other: ["/backup.zip", "/.DS_Store", "/server-status", "/phpinfo.php"],
} as const;

/** Folders probed for directory listings. */
export const LISTING_PATHS = ["/uploads/", "/files/", "/backup/", "/images/", "/assets/"] as const;

/**
 * Self-contained, dependency-free (apart from `tls`) helper. Keep it free of backticks and "${": it lives
 * in a template literal and is evaluated with `new Function`.
 */
export const SECURITY_HELPER_SOURCE = String.raw`const SEC_PREFIX = ${JSON.stringify(SECURITY_FAILURE_PREFIX)};
const SEC_MAX_LINES = ${SECURITY_MAX_LINES};
const SEC_PROBE_ORIGIN = ${JSON.stringify(PROBE_ORIGIN)};

function secClip(s, n) {
    const t = String(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 3) + "..." : t;
}
function secPlural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
function secPath(url) { try { const u = new URL(url); return u.pathname + u.search; } catch (e) { return String(url); } }
function secIsHtml(call) { return /text\/html/i.test(call.headers["content-type"] || "") || /^\s*<(?:!doctype|html|\?xml)/i.test(call.text); }

/** One failure: a headline plus at most SEC_MAX_LINES "- [severity] problem. Fix." lines. */
function secFail(headline, lines) {
    const shown = lines.slice(0, SEC_MAX_LINES);
    if (lines.length > shown.length) shown.push("- ...and " + (lines.length - shown.length) + " more");
    throw new Error(SEC_PREFIX + " " + headline + "\n" + shown.join("\n"));
}

function secHeaders(calls, expected) {
    const want = new Set(String(expected || "csp,frame,nosniff,referrer,hsts").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const c = calls[calls.length - 1];
    if (!c) throw new Error("No response to check: the test sent no request");
    const h = c.headers;
    const csp = String(h["content-security-policy"] || "").trim();
    const lines = [];
    if (want.has("csp") && !csp) lines.push("- [medium] Content-Security-Policy is missing, so the browser has no allow-list for scripts. Add a Content-Security-Policy header (start with default-src 'self').");
    if (want.has("frame") && !h["x-frame-options"] && !/(?:^|;)\s*frame-ancestors\s/i.test(csp)) lines.push("- [low] Other sites can show this page in a frame (clickjacking). Add X-Frame-Options: DENY or a CSP frame-ancestors rule.");
    if (want.has("nosniff") && String(h["x-content-type-options"] || "").trim().toLowerCase() !== "nosniff") lines.push("- [low] X-Content-Type-Options: nosniff is missing, so browsers may guess file types. Add the header.");
    if (want.has("referrer") && (!String(h["referrer-policy"] || "").trim() || /unsafe-url/i.test(h["referrer-policy"]))) lines.push("- [low] Referrer-Policy is missing or unsafe, so full page addresses may leak. Add Referrer-Policy: strict-origin-when-cross-origin.");
    // Plain http cannot have HSTS, so it is only judged on https responses.
    if (want.has("hsts") && /^https:/i.test(c.url)) {
        const hsts = String(h["strict-transport-security"] || "");
        const age = /max-age\s*=\s*(\d+)/i.exec(hsts);
        if (!hsts.trim()) lines.push("- [low] Strict-Transport-Security is missing on this https site, so browsers may try plain http. Add Strict-Transport-Security: max-age=31536000.");
        else if (!age || Number(age[1]) < 15552000) lines.push("- [low] Strict-Transport-Security lasts under 6 months, which weakens it. Use max-age=31536000 or more.");
    }
    if (lines.length === 0) return;
    secFail(secPlural(lines.length, "browser security header") + " missing or weak", lines);
}

const SEC_SESSION_COOKIE = /sess|(?:^|[_.-])(?:sid|auth|token|jwt|login|sso)(?:$|[_.-])|connect\.sid/i;
function secCookies(calls, expected) {
    const want = new Set(String(expected || "httponly,secure,samesite").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    const lines = [];
    const seen = new Set();
    for (const c of calls) {
        for (const raw of c.setCookies || []) {
            const parts = String(raw).split(";").map((s) => s.trim());
            const eq = parts[0].indexOf("=");
            const name = eq > 0 ? parts[0].slice(0, eq) : parts[0];
            if (!SEC_SESSION_COOKIE.test(name) || /csrf|xsrf/i.test(name) || seen.has(name)) continue;
            seen.add(name);
            const flags = parts.slice(1).map((p) => p.toLowerCase());
            const sameSite = flags.find((f) => f.startsWith("samesite="));
            const secure = flags.includes("secure");
            const missing = [];
            let severity = "low";
            if (want.has("httponly") && !flags.includes("httponly")) { missing.push("HttpOnly (page scripts can read it)"); severity = "medium"; }
            if (want.has("secure") && /^https:/i.test(c.url) && !secure) { missing.push("Secure (it can travel over plain http)"); severity = "medium"; }
            if (want.has("samesite") && !sameSite) missing.push("SameSite (other sites can trigger requests with it)");
            else if (want.has("samesite") && sameSite === "samesite=none" && !secure) { missing.push("Secure, which SameSite=None needs"); severity = "medium"; }
            if (missing.length) lines.push("- [" + severity + '] Cookie "' + secClip(name, 40) + '" is missing ' + missing.join(", ") + ". Add the flag(s) where the cookie is set.");
        }
    }
    if (lines.length === 0) return;
    secFail(secPlural(lines.length, "session cookie") + " not fully protected", lines);
}

function secCors(calls) {
    const lines = [];
    for (const c of calls) {
        const sent = (c.sent && c.sent.origin) || "";
        if (!sent) continue;
        const allow = String(c.headers["access-control-allow-origin"] || "").trim();
        const creds = String(c.headers["access-control-allow-credentials"] || "").trim().toLowerCase() === "true";
        const where = secClip(secPath(c.url), 60);
        if (allow === "*" && creds) lines.push("- [high] " + where + " allows any website to send logged-in requests (Allow-Origin * with Allow-Credentials). Allow only your own origins.");
        else if (allow === sent && creds) lines.push("- [high] " + where + " echoes back any Origin and allows credentials, so any website can read logged-in responses. Check the Origin against an allow-list.");
        else if (allow === "null" && creds) lines.push("- [high] " + where + " trusts the 'null' origin with credentials. Remove it from the allow-list.");
        else if (allow === sent) lines.push("- [medium] " + where + " echoes back any Origin in Access-Control-Allow-Origin. Allow only known origins.");
    }
    if (lines.length === 0) return;
    secFail(secPlural(lines.length, "permissive cross-origin (CORS) setting"), lines);
}

// What a real hit looks like, per path. A bare HTTP 200 proves nothing: single-page apps answer 200 + HTML for everything.
const SEC_EXPOSED = {
    "/.env": ["critical", "it holds secret settings", (c) => !secIsHtml(c) && /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.]*[ \t]*=[ \t]*\S/m.test(c.text)],
    "/.git/head": ["critical", "it is the site's source-control data", (c) => /^ref:\s*refs\//.test(c.text.trim()) || /^[0-9a-f]{40}$/.test(c.text.trim())],
    "/.git/config": ["critical", "it is the site's source-control data", (c) => /\[core\]/.test(c.text) && /repositoryformatversion|\[remote /.test(c.text)],
    "/.svn/entries": ["high", "it is the site's source-control data", (c) => /^\d+\s*\r?\n(?:\s*\r?\n)?dir\b/.test(c.text)],
    "/wp-config.php.bak": ["critical", "it holds the database password", (c) => /DB_PASSWORD|DB_NAME|AUTH_KEY/.test(c.text)],
    "/.htpasswd": ["high", "it holds password hashes", (c) => /^[^\s:]+:(?:\$apr1\$|\$2[aby]\$|\{SHA\}|\$1\$|\$5\$|\$6\$)/m.test(c.text)],
    "/backup.zip": ["high", "it is a downloadable backup", (c) => c.text.startsWith("PK\u0003\u0004")],
    "/.ds_store": ["low", "it lists the names of files on the server", (c) => c.text.startsWith("\u0000\u0000\u0000\u0001Bud1")],
    "/server-status": ["medium", "it shows live server internals", (c) => /Apache Server Status|Server Version:/i.test(c.text)],
    "/phpinfo.php": ["high", "it shows the server's PHP setup", (c) => /<title>phpinfo\(\)<\/title>|PHP Version \d/i.test(c.text)],
};
function secExposed(calls) {
    const lines = [];
    const seen = new Set();
    for (const c of calls) {
        if (c.status !== 200 && c.status !== 206) continue;
        let pathname;
        try { pathname = new URL(c.url).pathname; } catch (e) { continue; }
        const rule = SEC_EXPOSED[pathname.toLowerCase()];
        if (!rule || seen.has(pathname) || !rule[2](c)) continue;
        seen.add(pathname);
        lines.push("- [" + rule[0] + "] " + pathname + " can be downloaded by anyone (" + rule[1] + "). Remove it from the web server's public folder or block it in the server settings.");
    }
    if (lines.length === 0) return;
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    lines.sort((a, b) => rank[/\[(\w+)\]/.exec(a)[1]] - rank[/\[(\w+)\]/.exec(b)[1]]);
    secFail(secPlural(lines.length, "sensitive file") + (lines.length === 1 ? " is" : " are") + " publicly readable", lines);
}

function secDisclosure(calls) {
    const lines = [];
    const seen = new Set();
    const add = (key, line) => { if (!seen.has(key)) { seen.add(key); lines.push(line); } };
    for (const c of calls) {
        const server = String(c.headers["server"] || "");
        if (/\d+\.\d+/.test(server)) add("server:" + server, '- [low] The Server header reveals the software version ("' + secClip(server, 50) + '"), which helps attackers pick known exploits. Hide the version in the server settings.');
        const powered = String(c.headers["x-powered-by"] || "");
        if (powered) add("powered:" + powered, '- [low] The X-Powered-By header reveals the technology ("' + secClip(powered, 50) + '"). Remove the header.');
        for (const name of ["x-aspnet-version", "x-aspnetmvc-version"]) {
            if (c.headers[name]) add(name, "- [low] The " + name + " header reveals the framework version. Remove it.");
        }
        if (/<title>\s*Index of \/|<h1>\s*Index of \//i.test(c.text)) add("listing:" + secPath(c.url), "- [medium] " + secClip(secPath(c.url), 60) + " lists the files in a folder (directory listing). Turn off directory listing in the server settings.");
    }
    if (lines.length === 0) return;
    const rank = { medium: 0, low: 1 };
    lines.sort((a, b) => rank[/\[(\w+)\]/.exec(a)[1]] - rank[/\[(\w+)\]/.exec(b)[1]]);
    secFail(secPlural(lines.length, "detail") + " about the server " + (lines.length === 1 ? "is" : "are") + " exposed", lines);
}

/** Pure judgement of a certificate (what Node's TLS socket reported); testable without a network. */
function secCertLines(info, host, now, warnDays) {
    const lines = [];
    const validTo = Date.parse(info.cert.valid_to);
    const when = Number.isFinite(validTo) ? new Date(validTo).toISOString().slice(0, 10) : "an unknown date";
    if (Number.isFinite(validTo) && validTo < now) lines.push("- [high] The HTTPS certificate expired on " + when + ", so browsers show a full-page warning. Renew it.");
    else if (Number.isFinite(validTo) && validTo - now <= warnDays * 86400000) lines.push("- [medium] The HTTPS certificate expires on " + when + " (in " + Math.max(0, Math.ceil((validTo - now) / 86400000)) + " days). Renew it before then.");
    const mismatch = tls.checkServerIdentity(host, info.cert);
    if (mismatch) lines.push("- [high] The HTTPS certificate is not valid for " + secClip(host, 60) + " (it is issued for " + secClip((info.cert.subjectaltname || (info.cert.subject && info.cert.subject.CN) || "another name").replace(/DNS:|IP Address:/g, ""), 60) + "). Get a certificate that covers this address.");
    const code = info.authError ? String(info.authError.code || info.authError.message || info.authError) : "";
    if (code && !/EXPIRED|ALTNAME|HOSTNAME/i.test(code)) lines.push("- [medium] The HTTPS certificate is not trusted (" + secClip(code, 50).toLowerCase().replace(/_/g, " ") + "), so browsers show a warning. Use a certificate from a trusted authority.");
    return lines;
}

async function secTls(calls, expected) {
    const c = calls[calls.length - 1];
    if (!c) throw new Error("No response to check: the test sent no request");
    const url = new URL(c.url);
    if (url.protocol !== "https:") return;
    const warnDays = Number.isFinite(Number(expected)) && String(expected).trim() !== "" ? Number(expected) : ${TLS_WARN_DAYS};
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const info = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port: Number(url.port) || 443, servername: /^[\d.]+$|:/.test(host) ? undefined : host, rejectUnauthorized: false, timeout: 10000 }, () => {
            const cert = socket.getPeerCertificate();
            const authError = socket.authorized ? undefined : socket.authorizationError;
            socket.end();
            resolve({ cert, authError });
        });
        socket.on("timeout", () => { socket.destroy(); reject(new Error("TLS handshake with " + host + " timed out")); });
        socket.on("error", reject);
    });
    const lines = secCertLines(info, host, Date.now(), warnDays);
    if (lines.length === 0) return;
    secFail(secPlural(lines.length, "problem") + " with the HTTPS certificate", lines);
}

/** Run one security check over every response received so far. Throws "<prefix> ..." when it fails. */
async function secAssert(calls, check, expected) {
    if (check === "securityHeaders") return secHeaders(calls, expected);
    if (check === "cookieFlags") return secCookies(calls, expected);
    if (check === "corsPolicy") return secCors(calls);
    if (check === "noExposedFiles") return secExposed(calls);
    if (check === "noInfoDisclosure") return secDisclosure(calls);
    if (check === "tlsCertificate") return secTls(calls, expected);
    throw new Error("Unknown security check: " + check);
}
`;

/** One recorded HTTP response, as the generated API script keeps it. */
export interface SecurityCall {
    status: number;
    /** Lower-case header names. */
    headers: Record<string, string>;
    text: string;
    url: string;
    /** Request headers that were sent (lower-case names). */
    sent?: Record<string, string>;
    setCookies?: string[];
}

export interface SecurityRuntime {
    secAssert(calls: SecurityCall[], check: SecurityCheck, expected?: string | number): Promise<void>;
    secCertLines(info: { cert: Partial<tls.PeerCertificate> & { valid_to: string }; authError?: { code?: string; message?: string } }, host: string, now: number, warnDays: number): string[];
}

let runtime: SecurityRuntime | undefined;

/** The exact helper the generated scripts carry, compiled for use in tests and tooling. */
export function loadSecurityRuntime(): SecurityRuntime {
    runtime ??= new Function("tls", `${SECURITY_HELPER_SOURCE}\nreturn { secAssert, secCertLines };`)(tls) as SecurityRuntime;
    return runtime;
}

/** Run a check and return its failure message (undefined = passed). Other errors propagate. */
export async function evaluateSecurity(check: SecurityCheck, calls: SecurityCall[], expected?: string | number): Promise<string | undefined> {
    try {
        await loadSecurityRuntime().secAssert(calls, check, expected);
        return undefined;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.startsWith(SECURITY_FAILURE_PREFIX)) return message;
        throw e;
    }
}

/** What each check protects, shown next to the severity. */
export const SECURITY_BASIS: Record<SecurityCheck, string> = {
    securityHeaders: "browser security headers missing",
    cookieFlags: "session cookie not fully protected",
    corsPolicy: "permissive cross-origin (CORS) setting",
    noExposedFiles: "sensitive file readable by anyone",
    noInfoDisclosure: "server reveals technical details",
    tlsCertificate: "problem with the HTTPS certificate",
};

/** Which check a failure message came from, judged by its headline. */
export function securityCheckOf(message: string): SecurityCheck | undefined {
    if (/browser security headers? missing or weak/.test(message)) return "securityHeaders";
    if (/session cookies? not fully protected/.test(message)) return "cookieFlags";
    if (/permissive cross-origin \(CORS\) settings?/.test(message)) return "corsPolicy";
    if (/sensitive files? (?:is|are) publicly readable/.test(message)) return "noExposedFiles";
    if (/details? about the server (?:is|are) exposed/.test(message)) return "noInfoDisclosure";
    if (/problems? with the HTTPS certificate/.test(message)) return "tlsCertificate";
    return undefined;
}
