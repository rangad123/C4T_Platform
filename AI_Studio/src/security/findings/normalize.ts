/**
 * Turns one raw result of the passive assessment into a finding draft in the contract's shape.
 *
 * The judging and the wording of the problem come from the platform's existing read-only checks (src/engine/security/checks.ts): each
 * failure line there reads "- [severity] <problem>. <how to fix>." This module recognises those lines, keeps their severity and words,
 * and adds what a client report needs: a short title, the category, the impact, browser reproduction steps, the evidence as received
 * (redacted) and a stable fingerprint for deduplication.
 *
 * Where a finding lives (its location) follows where the setting lives: response headers, version banners, cookies and the certificate
 * are site-wide settings, so they are one finding per origin (the pages they were seen on are listed in the evidence); exposed files,
 * directory listings and CORS answers are one finding per path.
 */
import { createHash } from "node:crypto";
import { SECURITY_CHECKS, type SecurityCall, type SecurityCheck } from "../../engine/security/checks.js";
import { CATEGORIES, SEVERITIES, type Confidence, type Evidence, type FindingCategory, type Severity, type ValidationState } from "../contract.js";
import { redactEvidence, redactText } from "./redact.js";

/** What came back for the address a problem was seen on (header names lower-case). Values are redacted by ingest, not by the caller. */
export interface ObservedResponse {
    url: string;
    status: number;
    headers: Record<string, string>;
    setCookies?: string[];
    /** The first part of the body (ingest keeps at most 400 characters of it, redacted). */
    bodyExcerpt?: string;
    /** The Origin header the request carried, when one was sent (the CORS look). */
    sentOrigin?: string;
}

/** A problem that is not one of the existing checks' lines; everything a finding needs, in plain words. */
export interface CustomProblem {
    /** Short stable key of the kind of problem (part of the fingerprint), e.g. "mixed-content". */
    key: string;
    title: string;
    category: FindingCategory;
    severity: Severity;
    description: string;
    impact: string;
    remediation: string;
    reproduction?: string;
    /** "site" = one finding per origin, "path" (default) = one per address. */
    scope?: "site" | "path";
    confidence?: Confidence;
    /**
     * Additive (SCAN): the external tool that reported this problem, and the rule id it gave it. When this is present the finding's
     * `checkId` is the tool's id and its `rule` is `canonicalRule(...)`, so the rules of ONE tool that name one weakness class (two ZAP
     * rules sharing a CWE) land on one finding and the one that folded in keeps its evidence. Absent for the platform's own manual and
     * check-based findings.
     *
     * Two DIFFERENT tools reporting the same weakness class at the same address stay two findings, each carrying its own tool's id:
     * the fingerprint keys on the tool, so a client can see which tool said what, and closing one does not silently close the other.
     */
    scanner?: { id: string; ruleId: string; reference?: string | null };
}

/**
 * One raw result, as RUN hands it to `ingest`. Either a failure line of an existing check (`check` + `line`), or a `custom` problem
 * (`check: "other"`). `url` is where it was seen. Nothing in here needs to be redacted by the caller: ingest redacts everything.
 */
export interface RawResult {
    check: SecurityCheck | "other";
    /** One line of the check's failure message, e.g. "- [medium] Content-Security-Policy is missing, ... Add ...". */
    line?: string;
    custom?: CustomProblem;
    url: string;
    response?: ObservedResponse;
    /** ISO time it was observed (default: when ingest runs). */
    observedAt?: string;
    /** An extra plain observation kept as a "note" evidence item. */
    note?: string;
}

/** A finding draft: everything ingest stores, before the store adds ids and dates. */
export interface FindingDraft {
    fingerprint: string;
    check: string;
    rule: string;
    title: string;
    category: FindingCategory;
    severity: Severity;
    confidence: Confidence;
    location: string;
    /** The full address it was seen on (location may be the whole origin). */
    seenOn: string;
    description: string;
    impact: string;
    remediation: string;
    reproduction: string | null;
    evidence: Evidence[];
    /** Where a new finding starts: "probable" when the evidence is a direct observation, otherwise "needs-review". Never "confirmed". */
    initialValidation: Extract<ValidationState, "probable" | "needs-review">;
    /**
     * Additive (SCAN): where this problem came from. "external" when an outside tool reported it, so it is never stored as though the
     * platform's own checks had found it - the two carry different weight and the interface shows them differently. Manual findings do
     * not come through here at all (they are entered by a person and written by CORE's own service).
     */
    source: "built-in" | "external";
}

export const MAX_EXCERPT = 400;

/** Split a check's failure message into RawResults, one per problem line, for the response it was judged on. */
export function fromCheckFailure(check: SecurityCheck, message: string, call: SecurityCall, observedAt?: string): RawResult[] {
    const lines = message.split(/\r?\n/).slice(1).filter((l) => /^-\s*\[(critical|high|medium|low|info)\]/i.test(l.trim()));
    const response: ObservedResponse = {
        url: call.url,
        status: call.status,
        headers: call.headers,
        setCookies: call.setCookies,
        bodyExcerpt: (call.text ?? "").slice(0, MAX_EXCERPT * 2),
        sentOrigin: call.sent?.origin,
    };
    return lines.map((line) => ({ check, line: line.trim(), url: call.url, response, observedAt }));
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** Scheme + host (+ port when not the default), lower-case. */
export function originOf(url: string): string {
    try {
        return new URL(url).origin.toLowerCase();
    } catch {
        return redactText(url, 300);
    }
}

/** Origin + path, no query or fragment (they may hold secrets and vary per visit), no trailing slash except the root. */
export function normalizeLocation(url: string): string {
    try {
        const u = new URL(url);
        let path = u.pathname.replace(/\/{2,}/g, "/");
        if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
        return redactText(`${u.origin.toLowerCase()}${path}`, 500);
    } catch {
        return redactText(String(url).split(/[?#]/)[0]!.trim(), 500);
    }
}

export function fingerprintOf(category: FindingCategory, check: string, rule: string, location: string): string {
    return sha(`${category}|${check}|${rule}|${location}`);
}

interface Rule {
    /** Matches the problem text of one existing check line (after "- [severity] "). */
    re: RegExp;
    rule: (m: RegExpExecArray) => string;
    title: (m: RegExpExecArray) => string;
    category: FindingCategory;
    scope: "site" | "path";
    impact: string;
    confidence?: Confidence;
    /** What to show as evidence from the response. */
    evidence?: (r: ObservedResponse, m: RegExpExecArray, at: string) => Evidence[];
    repro: (url: string, m: RegExpExecArray) => string;
}

const DEVTOOLS = "Open the address in Chrome, Edge or Firefox, press F12 to open Developer tools, choose the Network tab and reload the page.";
const headerRepro = (name: string, expect: string) => (url: string) =>
    `1. ${DEVTOOLS.replace("the address", url)}\n2. Select the first request in the list (the page itself) and look under Response headers.\n3. ${expect.replace("{h}", name)}`;
const header = (name: string): Rule["evidence"] => (r, _m, at) => [{ kind: "response-header", label: name, value: r.headers[name.toLowerCase()] ?? "(not sent)", observedAt: at }];

const RULES: Record<SecurityCheck, Rule[]> = {
    securityHeaders: [
        {
            re: /^Content-Security-Policy is missing/i,
            rule: () => "csp",
            title: () => "Content-Security-Policy header missing",
            category: "headers",
            scope: "site",
            impact: "If any script injection exists elsewhere on the site, the browser has no allow-list to stop it, so a small bug can become account takeover or data theft.",
            evidence: header("Content-Security-Policy"),
            repro: headerRepro("Content-Security-Policy", "There is no {h} header."),
        },
        {
            re: /^Other sites can show this page in a frame/i,
            rule: () => "frame",
            title: () => "Pages can be shown in a frame by other sites",
            category: "headers",
            scope: "site",
            impact: "Another site can load these pages invisibly inside its own page and trick a signed-in visitor into clicking buttons (clickjacking).",
            evidence: (r, _m, at) => [
                { kind: "response-header", label: "X-Frame-Options", value: r.headers["x-frame-options"] ?? "(not sent)", observedAt: at },
                { kind: "response-header", label: "Content-Security-Policy", value: r.headers["content-security-policy"] ?? "(not sent)", observedAt: at },
            ],
            repro: headerRepro("X-Frame-Options", "There is no {h} header and the Content-Security-Policy (if any) has no frame-ancestors rule."),
        },
        {
            re: /^X-Content-Type-Options: nosniff is missing/i,
            rule: () => "nosniff",
            title: () => "X-Content-Type-Options header missing",
            category: "headers",
            scope: "site",
            impact: "Browsers may guess the type of a file and run an uploaded or mislabelled file as a script.",
            evidence: header("X-Content-Type-Options"),
            repro: headerRepro("X-Content-Type-Options", "There is no {h}: nosniff header."),
        },
        {
            re: /^Referrer-Policy is missing or unsafe/i,
            rule: () => "referrer",
            title: () => "Referrer-Policy missing or unsafe",
            category: "headers",
            scope: "site",
            impact: "Full page addresses, including any ids or tokens in them, can be sent to other sites the visitor goes to.",
            evidence: header("Referrer-Policy"),
            repro: headerRepro("Referrer-Policy", "The {h} header is missing or says unsafe-url."),
        },
        {
            re: /^Strict-Transport-Security is missing/i,
            rule: () => "hsts-missing",
            title: () => "Strict-Transport-Security header missing",
            category: "headers",
            scope: "site",
            impact: "A visitor who types the address without https can be redirected or intercepted on an untrusted network before the secure connection starts.",
            evidence: header("Strict-Transport-Security"),
            repro: headerRepro("Strict-Transport-Security", "There is no {h} header."),
        },
        {
            re: /^Strict-Transport-Security lasts under 6 months/i,
            rule: () => "hsts-short",
            title: () => "Strict-Transport-Security lasts too short",
            category: "headers",
            scope: "site",
            impact: "Browsers forget to insist on https soon after a visit, which leaves returning visitors open to interception on untrusted networks.",
            evidence: header("Strict-Transport-Security"),
            repro: headerRepro("Strict-Transport-Security", "The {h} header has a max-age under 15552000 seconds (6 months)."),
        },
    ],
    cookieFlags: [
        {
            re: /^Cookie "(.+?)" is missing (.+?)\. Add the flag/i,
            rule: (m) => `cookie:${m[1]}`,
            title: (m) => `Session cookie "${m[1]}" missing protective flags`,
            category: "cookies",
            scope: "site",
            impact: "A session cookie without these flags is easier to steal (by a page script, over plain http) or to send from another site, which can let someone act as the signed-in visitor.",
            evidence: (r, m, at) =>
                (r.setCookies ?? [])
                    .filter((c) => c.trim().startsWith(`${m[1]}=`))
                    .slice(0, 1)
                    .map((c) => ({ kind: "cookie" as const, label: `Set-Cookie (${m[1]})`, value: c, observedAt: at })),
            repro: (url, m) => `1. ${DEVTOOLS.replace("the address", url)}\n2. Choose the Application tab (Storage in Firefox), then Cookies, and select the site.\n3. Find the cookie "${m[1]}": the HttpOnly, Secure or SameSite column is empty for it.`,
        },
    ],
    corsPolicy: [
        {
            re: /^(\S+) allows any website to send logged-in requests/i,
            rule: () => "any-origin-credentials",
            title: () => "Any website can make signed-in requests (CORS)",
            category: "cors",
            scope: "path",
            impact: "Any website a signed-in visitor opens can call this address with their session.",
            repro: (url) => corsRepro(url, "Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true"),
        },
        {
            re: /^(\S+) echoes back any Origin and allows credentials/i,
            rule: () => "echo-credentials",
            title: () => "Any website can read signed-in answers (CORS)",
            category: "cors",
            scope: "path",
            impact: "Any website a signed-in visitor opens can read this address's answers with their session, including personal data.",
            repro: (url) => corsRepro(url, "Access-Control-Allow-Origin repeating the made-up origin, and Access-Control-Allow-Credentials: true"),
        },
        {
            re: /^(\S+) trusts the 'null' origin with credentials/i,
            rule: () => "null-credentials",
            title: () => "The 'null' origin is trusted with credentials (CORS)",
            category: "cors",
            scope: "path",
            impact: "Sandboxed pages and local files send the 'null' origin, so any site can use a sandboxed frame to read signed-in answers.",
            repro: (url) => corsRepro(url, "Access-Control-Allow-Origin: null and Access-Control-Allow-Credentials: true"),
        },
        {
            re: /^(\S+) echoes back any Origin in Access-Control-Allow-Origin/i,
            rule: () => "echo",
            title: () => "Any origin is allowed to read answers (CORS)",
            category: "cors",
            scope: "path",
            confidence: "medium",
            impact: "Any website can read this address's answers. That matters when the answers are not meant to be public.",
            repro: (url) => corsRepro(url, "Access-Control-Allow-Origin repeating the made-up origin"),
        },
    ],
    noExposedFiles: [
        {
            re: /^(\S+) can be downloaded by anyone \((.+?)\)/i,
            rule: (m) => `file:${m[1]!.toLowerCase()}`,
            title: (m) => `Sensitive file publicly readable: ${m[1]}`,
            category: "exposed-files",
            scope: "path",
            impact: "Anyone can download this file; files like this often hold passwords, keys or the site's source, which makes further attacks much easier.",
            evidence: (r, _m, at) => [
                { kind: "status", label: "Status", value: String(r.status), observedAt: at },
                { kind: "response-header", label: "Content-Type", value: r.headers["content-type"] ?? "(not sent)", observedAt: at },
                ...(r.bodyExcerpt ? [{ kind: "body-excerpt" as const, label: "Start of the file (values hidden)", value: r.bodyExcerpt.slice(0, MAX_EXCERPT), observedAt: at }] : []),
            ],
            repro: (url) => `1. Open ${url} in a private browser window (not signed in).\n2. The file is shown or downloaded instead of a "not found" page.`,
        },
    ],
    noInfoDisclosure: [
        {
            re: /^The Server header reveals the software version/i,
            rule: () => "server-banner",
            title: () => "Server header reveals the software version",
            category: "information-disclosure",
            scope: "site",
            impact: "Knowing the exact version helps an attacker pick known weaknesses of that version.",
            evidence: header("Server"),
            repro: headerRepro("Server", "The {h} header names the software with a version number."),
        },
        {
            re: /^The X-Powered-By header reveals the technology/i,
            rule: () => "powered-by",
            title: () => "X-Powered-By header reveals the technology",
            category: "information-disclosure",
            scope: "site",
            impact: "Naming the technology (and often its version) helps an attacker pick known weaknesses.",
            evidence: header("X-Powered-By"),
            repro: headerRepro("X-Powered-By", "The {h} header is present."),
        },
        {
            re: /^The (x-aspnet(?:mvc)?-version) header reveals/i,
            rule: (m) => `framework-header:${m[1]!.toLowerCase()}`,
            title: (m) => `${m[1]} header reveals the framework version`,
            category: "information-disclosure",
            scope: "site",
            impact: "Knowing the exact framework version helps an attacker pick known weaknesses of that version.",
            evidence: (r, m, at) => [{ kind: "response-header", label: m[1]!, value: r.headers[m[1]!.toLowerCase()] ?? "(not sent)", observedAt: at }],
            repro: (url, m) => headerRepro(m[1]!, "The {h} header is present.")(url),
        },
        {
            re: /^(\S+) lists the files in a folder/i,
            rule: () => "directory-listing",
            title: (m) => `Directory listing enabled: ${m[1]}`,
            category: "information-disclosure",
            scope: "path",
            impact: "Anyone can see and download every file in the folder, including files nobody linked to (backups, exports, uploads of other users).",
            evidence: (r, _m, at) => [
                { kind: "status", label: "Status", value: String(r.status), observedAt: at },
                ...(r.bodyExcerpt ? [{ kind: "body-excerpt" as const, label: "Start of the page", value: r.bodyExcerpt.slice(0, MAX_EXCERPT), observedAt: at }] : []),
            ],
            repro: (url) => `1. Open ${url} in a browser.\n2. The page is titled "Index of" and lists the folder's files.`,
        },
    ],
    tlsCertificate: [
        {
            re: /certificate expired on/i,
            rule: () => "cert-expired",
            title: () => "HTTPS certificate expired",
            category: "tls",
            scope: "site",
            impact: "Browsers show a full-page warning; visitors who click through can no longer tell the real site from an impostor.",
            repro: (url) => certRepro(url, "Chrome shows a warning page; the certificate's 'Valid to' date has passed."),
        },
        {
            re: /certificate expires on/i,
            rule: () => "cert-expiring",
            title: () => "HTTPS certificate expires soon",
            category: "tls",
            scope: "site",
            impact: "When it expires, browsers show a full-page warning and visitors cannot reach the site normally.",
            repro: (url) => certRepro(url, "The certificate's 'Valid to' date is within the next few days."),
        },
        {
            re: /certificate is not valid for/i,
            rule: () => "cert-name",
            title: () => "HTTPS certificate does not match the address",
            category: "tls",
            scope: "site",
            impact: "Browsers show a warning; visitors who click through can no longer tell the real site from an impostor.",
            repro: (url) => certRepro(url, "The names the certificate is issued for do not include this address."),
        },
        {
            re: /certificate is not trusted/i,
            rule: () => "cert-untrusted",
            title: () => "HTTPS certificate not trusted",
            category: "tls",
            scope: "site",
            confidence: "medium",
            impact: "Browsers show a warning; visitors who click through can no longer tell the real site from an impostor.",
            repro: (url) => certRepro(url, "The browser says the certificate is not trusted (it may be self-signed or its chain may be incomplete)."),
        },
    ],
};

function corsRepro(url: string, expect: string): string {
    return `1. Open any page of a different website in Chrome or Edge and press F12, then choose the Console tab.\n2. Paste: fetch(${JSON.stringify(url)}, { credentials: "include" }).then((r) => console.log(r.status))\n3. In the Network tab, select that request: the answer carries ${expect}, so the browser lets the other site read it.\nThe assessment sent the made-up origin https://untrusted-origin.example, which is never contacted.`;
}
function certRepro(url: string, expect: string): string {
    return `1. Open ${url} in Chrome or Edge.\n2. Click the icon left of the address, then "Connection" and "Certificate".\n3. ${expect}`;
}

const SEV_TAG = /^-?\s*\[(critical|high|medium|low|info)\]\s*/i;

/** "<problem>. <fix>." → problem and fix (the fix is the last sentence, as the checks write them). */
export function splitProblemFix(text: string): { problem: string; fix: string } {
    const t = text.trim();
    // The last sentence start: ". " followed by a capital letter, outside a quoted value.
    let cut = -1;
    const re = /\.\s+(?=[A-Z])/g;
    for (let m = re.exec(t); m; m = re.exec(t)) {
        const before = t.slice(0, m.index);
        if ((before.match(/"/g) ?? []).length % 2 === 0) cut = m.index;
    }
    if (cut < 0) return { problem: t, fix: "" };
    return { problem: t.slice(0, cut + 1).trim(), fix: t.slice(cut + 1).trim() };
}

const isSeverity = (s: string): s is Severity => (SEVERITIES as readonly string[]).includes(s);
const isCategory = (s: string): s is FindingCategory => (CATEGORIES as readonly string[]).includes(s);

/** One raw result → a finding draft, or undefined when the line is not a problem line (e.g. "- ...and 2 more"). Everything is redacted. */
export function normalize(raw: RawResult, now = new Date().toISOString()): FindingDraft | undefined {
    const at = raw.observedAt && !Number.isNaN(Date.parse(raw.observedAt)) ? new Date(raw.observedAt).toISOString() : now;
    const url = raw.url;
    const seenOn = normalizeLocation(url);
    const site = originOf(url);
    const extra: Evidence[] = raw.note ? [{ kind: "note", label: "Observation", value: raw.note, observedAt: at }] : [];
    const statusEv = (r?: ObservedResponse): Evidence[] => (r ? [{ kind: "status", label: `Status of ${normalizeLocation(r.url)}`, value: String(r.status), observedAt: at }] : []);

    if (raw.check === "other") {
        const c = raw.custom;
        if (!c || !isSeverity(c.severity) || !isCategory(c.category)) return undefined;
        const location = c.scope === "site" ? site : seenOn;
        const evidence = [...statusEv(raw.response), ...extra].map(redactEvidence);
        const confidence = c.confidence ?? "medium";
        // Additive (SCAN): an external tool's finding keeps its own tool id and rule id, so the stored check_id says where it came from.
        const checkKey = c.scanner ? redactText(c.scanner.id, 60) : "other";
        const ruleKey = c.key;
        return {
            fingerprint: fingerprintOf(c.category, checkKey, ruleKey, location),
            check: checkKey,
            rule: redactText(ruleKey, 100),
            title: redactText(c.title, 200),
            category: c.category,
            severity: c.severity,
            confidence,
            location,
            seenOn,
            description: redactText(c.description),
            impact: redactText(c.impact),
            remediation: redactText(c.remediation),
            reproduction: c.reproduction ? redactText(c.reproduction) : null,
            evidence,
            initialValidation: confidence === "high" && evidence.length > 0 ? "probable" : "needs-review",
            source: c.scanner ? "external" : "built-in",
        };
    }

    if (!(SECURITY_CHECKS as readonly string[]).includes(raw.check) || !raw.line) return undefined;
    const tag = SEV_TAG.exec(raw.line.trim());
    if (!tag) return undefined;
    const severity = tag[1]!.toLowerCase() as Severity;
    const text = raw.line.trim().slice(tag[0].length).trim();
    const { problem, fix } = splitProblemFix(text);
    const rules = RULES[raw.check];
    let rule: Rule | undefined;
    let m: RegExpExecArray | null = null;
    for (const r of rules) {
        m = r.re.exec(text);
        if (m) {
            rule = r;
            break;
        }
    }
    const category: FindingCategory = rule?.category ?? fallbackCategory(raw.check);
    const ruleKey = rule && m ? rule.rule(m) : `line:${sha(problem.toLowerCase())}`;
    const location = (rule?.scope ?? "path") === "site" ? site : seenOn;
    const r = raw.response;
    const specific = rule?.evidence && r && m ? rule.evidence(r, m, at) : [];
    const evidence = [...specific, ...(specific.some((e) => e.kind === "status") ? [] : statusEv(r)), ...corsEvidence(raw.check, r, at), ...extra].map(redactEvidence);
    const confidence: Confidence = rule?.confidence ?? (rule ? "high" : "medium");
    return {
        fingerprint: fingerprintOf(category, raw.check, ruleKey, location),
        check: raw.check,
        rule: redactText(ruleKey, 200),
        title: redactText(rule && m ? rule.title(m) : clipTitle(problem), 200),
        category,
        severity,
        confidence,
        location,
        seenOn,
        description: redactText(problem),
        impact: redactText(rule?.impact ?? "See the description."),
        remediation: redactText(fix || "Change the server setting described above."),
        reproduction: rule && m ? redactText(rule.repro(redactText(url, 500), m)) : null,
        evidence,
        initialValidation: confidence === "high" && evidence.length > 0 ? "probable" : "needs-review",
        source: "built-in",
    };
}

function corsEvidence(check: string, r: ObservedResponse | undefined, at: string): Evidence[] {
    if (check !== "corsPolicy" || !r) return [];
    return [
        { kind: "note", label: "Origin sent with the request", value: r.sentOrigin ?? "(none)", observedAt: at },
        { kind: "response-header", label: "Access-Control-Allow-Origin", value: r.headers["access-control-allow-origin"] ?? "(not sent)", observedAt: at },
        { kind: "response-header", label: "Access-Control-Allow-Credentials", value: r.headers["access-control-allow-credentials"] ?? "(not sent)", observedAt: at },
    ];
}

function fallbackCategory(check: SecurityCheck): FindingCategory {
    return ({ securityHeaders: "headers", cookieFlags: "cookies", corsPolicy: "cors", noExposedFiles: "exposed-files", noInfoDisclosure: "information-disclosure", tlsCertificate: "tls" } as const)[check];
}

function clipTitle(problem: string): string {
    const first = problem.split(/[,.(]/)[0]!.trim();
    return first.length > 90 ? `${first.slice(0, 87)}...` : first || "Configuration problem";
}
