/**
 * Platform settings of the Security Assessment module, read from the environment (.env) through the platform config.
 *
 * Stable API: `securitySettings(config)` -> SecuritySettings. Every value is a plain string in the config (src/config.ts) and parsed
 * here leniently: an empty line or a typo keeps the default, so a bad .env line never stops the platform.
 *
 *   SECURITY_ASSESSMENT              on | off (default on). Off: every /api/v1/security route except GET /status answers 404; the UI hides it.
 *   SECURITY_ALLOW_PRIVATE_TARGETS   true lets assessments reach loopback/private/link-local/CGNAT addresses (default off). Cloud metadata
 *                                    addresses stay refused even then.
 *   SECURITY_RETENTION_DAYS          finished assessments and their per-assessment evidence are removed after this many days (1-3650, default 365).
 *   SECURITY_MAX_REQUESTS            most requests one assessment may send (10-100000, default 2000).
 *   SECURITY_MAX_RESPONSE_BYTES      most bytes read from one response (16 KB - 50 MB, default 5 MB).
 *   SECURITY_ASSESSMENT_MINUTES      time limit of one assessment (1-600, default 30; RUN enforces it).
 *   SECURITY_USE_PROXY               on: assessment requests go through the company proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY, the same
 *                                    variables the platform's other outbound calls use). Default off (direct, address pinned). See ./proxy.ts.
 *   SECURITY_PROXY_ALLOW_PRIVATE     true lets that proxy be on a loopback or private address (most company proxies are). Default off.
 */
export interface SecuritySettings {
    enabled: boolean;
    allowPrivateTargets: boolean;
    retentionDays: number;
    maxRequestsPerAssessment: number;
    maxResponseBytes: number;
    /** Total bytes one assessment may read across all responses (50 x the per-response cap, at least 100 MB). */
    maxTotalBytes: number;
    assessmentMinutes: number;
    /** SECURITY_USE_PROXY=on (default off). */
    useProxy?: boolean;
    /** SECURITY_PROXY_ALLOW_PRIVATE=true (default off). */
    allowPrivateProxy?: boolean;
}

type Source = Partial<
    Record<
        "SECURITY_ASSESSMENT" | "SECURITY_ALLOW_PRIVATE_TARGETS" | "SECURITY_RETENTION_DAYS" | "SECURITY_MAX_REQUESTS" | "SECURITY_MAX_RESPONSE_BYTES" | "SECURITY_ASSESSMENT_MINUTES" | "SECURITY_USE_PROXY" | "SECURITY_PROXY_ALLOW_PRIVATE",
        string | undefined
    >
>;

const int = (raw: string | undefined, min: number, max: number, dflt: number): number => {
    const t = (raw ?? "").trim().replace(/[_,]/g, "");
    if (!t) return dflt;
    const n = Number(t);
    return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

export const SECURITY_DEFAULTS = { retentionDays: 365, maxRequestsPerAssessment: 2000, maxResponseBytes: 5 * 1024 * 1024, assessmentMinutes: 30 } as const;

export function securitySettings(src: Source): SecuritySettings {
    const flag = (v: string | undefined) => (v ?? "").trim().toLowerCase();
    const maxResponseBytes = int(src.SECURITY_MAX_RESPONSE_BYTES, 16 * 1024, 50 * 1024 * 1024, SECURITY_DEFAULTS.maxResponseBytes);
    return {
        // Default on; only an explicit "off"/"false"/"0" turns it off.
        enabled: !["off", "false", "0", "no"].includes(flag(src.SECURITY_ASSESSMENT)),
        allowPrivateTargets: flag(src.SECURITY_ALLOW_PRIVATE_TARGETS) === "true",
        retentionDays: int(src.SECURITY_RETENTION_DAYS, 1, 3650, SECURITY_DEFAULTS.retentionDays),
        maxRequestsPerAssessment: int(src.SECURITY_MAX_REQUESTS, 10, 100_000, SECURITY_DEFAULTS.maxRequestsPerAssessment),
        maxResponseBytes,
        maxTotalBytes: Math.max(100 * 1024 * 1024, maxResponseBytes * 50),
        assessmentMinutes: int(src.SECURITY_ASSESSMENT_MINUTES, 1, 600, SECURITY_DEFAULTS.assessmentMinutes),
        // Default off; only an explicit on/true/1/yes sends assessments through the proxy.
        useProxy: ["on", "true", "1", "yes"].includes(flag(src.SECURITY_USE_PROXY)),
        allowPrivateProxy: flag(src.SECURITY_PROXY_ALLOW_PRIVATE) === "true",
    };
}
