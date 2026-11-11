/**
 * Deterministic passive-security specs (no LLM): a small group of GET-only API-style specs against the
 * application's own origin (headers, cookies, CORS, exposed files, information disclosure and, on https,
 * the TLS certificate). Also classifies a failed security run as an application finding.
 *
 * Read-only by construction: GET requests only, no credentials sent, no payloads, no state changes.
 * The one unusual request carries a made-up `Origin` header (CORS) and the file probes ask for just the
 * first 4 KB (`Range`) so a real backup archive is never downloaded in full.
 */
import type { DraftSpec } from "../api/test-specs.js";
import type { Step, TestSpec } from "../spec/schema.js";
import type { AppModel } from "../understanding/app-model.js";
import type { ScriptRun } from "../validation/runner.js";
import { EXPOSED_FILE_GROUPS, LISTING_PATHS, PROBE_ORIGIN, SECURITY_FAILURE_PREFIX, TLS_WARN_DAYS, isSecurityCheck, securityCheckOf, type SecurityCheck } from "./checks.js";
import { worstTag } from "../health/checks.js";

export interface SecurityGenOptions {
    /** Most API endpoints (GET, same origin) added to the CORS probe. */
    maxCorsEndpoints?: number;
}

/** The page the headers are judged on: the first page the crawl loaded successfully, else "/". */
function homePath(model: AppModel): string {
    const home = model.pages.find((p) => {
        try {
            return new URL(p.url).origin === model.origin && (p.status === 0 || (p.status >= 200 && p.status < 300)) && p.type !== "error";
        } catch {
            return false;
        }
    });
    const path = home?.path?.split("#")[0];
    return path && path.startsWith("/") ? path : "/";
}

const get = (path: string, description: string, headers?: Record<string, string>): Step => ({ action: "request", method: "GET", path, headers, auth: "none", description });
const check = (c: SecurityCheck, description: string, expected?: string | number): Step => ({ action: "assertResponse", check: c, expected, description });

interface Draft {
    title: string;
    description: string;
    priority: TestSpec["priority"];
    steps: Step[];
    expected: string[];
}

export function generateSecuritySpecs(model: AppModel, opts: SecurityGenOptions = {}): DraftSpec[] {
    const https = new URL(model.origin).protocol === "https:";
    const home = homePath(model);
    const apiGets = [...new Set(model.apis.filter((a) => a.method === "GET" && a.origin === model.origin && !a.path.includes("{") && !a.path.includes("?")).map((a) => a.path))].slice(0, opts.maxCorsEndpoints ?? 2);
    const drafts: Draft[] = [];

    drafts.push({
        title: `Browser security headers are set (${home})`,
        description: `Reads the response headers of ${home} and checks the ones that switch on browser protections: Content-Security-Policy, framing protection, X-Content-Type-Options and Referrer-Policy${
            https ? ", plus Strict-Transport-Security" : ". Strict-Transport-Security is not checked because this site uses plain http, which cannot have it"
        }. Read-only: one GET request.`,
        priority: "medium",
        steps: [get(home, `Request ${home} (read-only)`), check("securityHeaders", "Security headers are present", https ? "csp,frame,nosniff,referrer,hsts" : "csp,frame,nosniff,referrer")],
        expected: ["Content-Security-Policy is set", "Framing is restricted (X-Frame-Options or frame-ancestors)", "X-Content-Type-Options is nosniff", "Referrer-Policy is set", ...(https ? ["Strict-Transport-Security is set"] : [])],
    });
    drafts.push({
        title: `Session cookies are protected (${home})`,
        description: `Looks at the cookies ${home} sets and checks that session-looking ones carry HttpOnly${https ? ", Secure" : ""} and SameSite. Cookies are only inspected, never reused. Read-only: one GET request.`,
        priority: "medium",
        steps: [get(home, `Request ${home} (read-only)`), check("cookieFlags", "Session cookies have the protective flags", https ? "httponly,secure,samesite" : "httponly,samesite")],
        expected: ["Session cookies are HttpOnly", ...(https ? ["Session cookies are Secure"] : []), "Session cookies have a SameSite setting"],
    });
    drafts.push({
        title: "Cross-origin access (CORS) is not wide open",
        description: `Sends a harmless made-up Origin (${PROBE_ORIGIN}, never contacted) with GET requests to ${[home, ...apiGets].join(", ")} and checks the site does not echo it back or allow any website to use visitors' credentials. Read-only.`,
        priority: "high",
        steps: [
            ...[home, ...apiGets].map((p) => get(p, `Request ${p} from another origin (read-only)`, { Origin: PROBE_ORIGIN })),
            check("corsPolicy", "The made-up origin is not trusted"),
        ],
        expected: ["The server does not echo an unknown Origin back", "Credentials are not allowed for every website"],
    });
    for (const [group, title, description] of [
        ["secrets", "Secret and source-control files cannot be downloaded", "configuration and source-control files (.env, .git, .svn, wp-config backups, .htpasswd)"],
        ["other", "Backups and server diagnostic pages cannot be downloaded", "backup archives, .DS_Store, /server-status and phpinfo pages"],
    ] as const) {
        const paths = EXPOSED_FILE_GROUPS[group];
        drafts.push({
            title,
            description: `Asks for ${description} and flags a path only when the response has that file's real content signature (for example .git/HEAD starting with "ref:"); an application that answers every path with its home page is not a finding. Read-only: ${paths.length} GET requests, first 4 KB only.`,
            priority: group === "secrets" ? "critical" : "high",
            steps: [...paths.map((p) => get(p, `Request ${p} (read-only)`, { Range: "bytes=0-4095" })), check("noExposedFiles", "None of these files can be read")],
            expected: paths.map((p) => `${p} cannot be downloaded`),
        });
    }
    drafts.push({
        title: "The server does not reveal software versions or list folders",
        description: `Checks the Server and X-Powered-By headers for version banners and a few common folders (${LISTING_PATHS.join(", ")}) for directory listings. Read-only: ${LISTING_PATHS.length + 1} GET requests.`,
        priority: "low",
        steps: [get(home, `Request ${home} (read-only)`), ...LISTING_PATHS.map((p) => get(p, `Request ${p} (read-only)`)), check("noInfoDisclosure", "No version banners or directory listings")],
        expected: ["No software version in the Server / X-Powered-By headers", "No folder shows a file listing"],
    });
    if (https) {
        drafts.push({
            title: "The HTTPS certificate is valid and not about to expire",
            description: `Connects to ${new URL(model.origin).host} over TLS and checks the certificate is trusted, matches the host name, is not expired and is not expiring within ${TLS_WARN_DAYS} days. Only the site itself is contacted.`,
            priority: "high",
            steps: [get(home, `Request ${home} (read-only)`), check("tlsCertificate", `Certificate is valid for at least ${TLS_WARN_DAYS} more days`, TLS_WARN_DAYS)],
            expected: ["The certificate is trusted and matches the host name", `The certificate is valid for at least ${TLS_WARN_DAYS} more days`],
        });
    }

    return drafts.map((d) => ({
        title: d.title,
        description: d.description,
        kind: "api" as const,
        category: "Security checks",
        type: "security" as const,
        priority: d.priority,
        preconditions: [],
        steps: d.steps,
        expectedResults: d.expected,
        testData: {},
        tags: ["security", "passive"],
        source: { origin: "security-check" as const },
    }));
}

/**
 * When `run` failed *because a security check found a problem* (the failing step is one of the security
 * asserts and its error is the check's own message) return that message; otherwise undefined: a
 * request that could not be made (connection refused, timeout) is an ordinary validation failure.
 */
export function securityFinding(spec: TestSpec, run: ScriptRun): string | undefined {
    if (run.status !== "failed") return undefined;
    const isSecurityStep = (s: Step | undefined) => s?.action === "assertResponse" && isSecurityCheck(s.check);
    const failed = run.steps.find((s) => s.status === "failed");
    const text = failed ? (isSecurityStep(spec.steps[failed.index]) ? failed.error : undefined) : run.steps.length === 0 && spec.steps.some(isSecurityStep) ? run.error : undefined;
    const at = (text ?? "").indexOf(SECURITY_FAILURE_PREFIX);
    if (!text || at < 0) return undefined;
    const lines = text.slice(at).split("\n");
    const end = lines.findIndex((l, i) => i > 0 && !l.startsWith("- "));
    return lines
        .slice(0, end < 0 ? lines.length : end)
        .join("\n")
        .trim()
        .slice(0, 1500);
}

/** Worst severity tag and the check behind a security finding reason (undefined fields if it is not one). */
export function parseSecurityReason(reason: string): { check?: SecurityCheck; severity?: ReturnType<typeof worstTag> } {
    if (!reason.includes(SECURITY_FAILURE_PREFIX)) return {};
    const [head = "", ...rest] = reason.split("\n");
    return { check: securityCheckOf(head), severity: worstTag(rest.join("\n")) };
}
