/**
 * Settings of the external scanner layer, read from the environment through the platform config (additive keys in src/config.ts).
 *
 * Parsed leniently like ../settings.ts: an empty line or a typo keeps the default and never stops the platform.
 *
 *   SECURITY_SCANNERS                comma list of the scanners that may run at all ("zap,nuclei"). Default: none. Installing a
 *                                    scanner on the machine does not enable it; somebody must name it here.
 *   SECURITY_SCANNER_MAX_MINUTES     time limit of one scanner run (1-600, default 20). The assessment's own time limit still applies.
 *   SECURITY_SCANNER_REQUEST_BUDGET  most requests one scanner run may send (10-200000, default 3000), across every tool in the run.
 *   SECURITY_SCANNER_MAX_RPS         hard ceiling for the request rate handed to a tool (1-50, default 5). A tool is always also
 *                                    limited by the application's own maxRequestsPerSecond, whichever is smaller.
 *   SECURITY_SCANNER_BIN_DIRS        where to look for scanner binaries when no explicit path is set (":" or ";" separated).
 *   SECURITY_ZAP_URL                 base address of the ZAP daemon ("http://127.0.0.1:8090"). ZAP is a separate service.
 *   SECURITY_ZAP_API_KEY             the ZAP API key. Server-side only: it is never returned by the API and never sent to the browser.
 *   SECURITY_NUCLEI_PATH             path to the nuclei binary.
 *   SECURITY_NUCLEI_TEMPLATES        path to the reviewed template directory. Nuclei templates are chosen from this directory only.
 *   SECURITY_NUCLEI_CONCURRENCY      how many templates at once (1-50, default 5).
 *   SECURITY_SCHEMATHESIS_PATH       path to the schemathesis command.
 *   SECURITY_PROMPTFOO_PATH          path to the promptfoo command.
 *
 * The only secret here is the ZAP API key, and the only reader of this object (./zap/adapter.ts) keeps it to itself. The API and the
 * settings view only ever see `scannerSettingsPublic()`, which reports a key as present or absent, never shown.
 */
import { SCANNER_IDS, type ScannerId } from "./contract.js";

export interface ScannerSettings {
    /** The scanners an administrator has switched on. Everything else is `not_configured`, whatever is installed. */
    enabled: ScannerId[];
    /** Time limit of one scanner run in ms. */
    runTimeoutMs: number;
    /** Most requests one scanner run may send, across every tool. */
    requestBudget: number;
    /** Hard ceiling for the request rate given to a tool. */
    maxRequestsPerSecond: number;
    /** Extra directories searched for scanner binaries (an explicit path always wins). */
    binDirs: string[];
    zap: { baseUrl: string; apiKey: string };
    nuclei: { path: string; templatesDir: string; concurrency: number };
    schemathesis: { path: string };
    promptfoo: { path: string };
}

type Source = Partial<Record<string, string | undefined>>;

const int = (raw: string | undefined, min: number, max: number, dflt: number): number => {
    const t = (raw ?? "").trim().replace(/[_,]/g, "");
    if (!t) return dflt;
    const n = Number(t);
    return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

export const SCANNER_SETTINGS_DEFAULTS = { runMinutes: 20, requestBudget: 3000, maxRps: 5, nucleiConcurrency: 5 } as const;

/** The scanners named in SECURITY_SCANNERS, keeping the canonical order and dropping anything unknown. */
export function enabledScanners(raw: string | undefined): ScannerId[] {
    const named = new Set(
        (raw ?? "")
            .split(/[,\s;]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );
    return SCANNER_IDS.filter((id) => named.has(id));
}

/** A ZAP base address with no trailing slash and only http/https, or "" when it is not one. */
export function zapBaseUrl(raw: string | undefined): string {
    const t = (raw ?? "").trim().replace(/\/+$/, "");
    if (!t) return "";
    try {
        const u = new URL(t);
        return u.protocol === "http:" || u.protocol === "https:" ? u.origin + u.pathname.replace(/\/+$/, "") : "";
    } catch {
        return "";
    }
}

export function scannerSettings(src: Source): ScannerSettings {
    const dirSep = process.platform === "win32" ? ";" : ":";
    return {
        enabled: enabledScanners(src.SECURITY_SCANNERS),
        runTimeoutMs: int(src.SECURITY_SCANNER_MAX_MINUTES, 1, 600, SCANNER_SETTINGS_DEFAULTS.runMinutes) * 60_000,
        requestBudget: int(src.SECURITY_SCANNER_REQUEST_BUDGET, 10, 200_000, SCANNER_SETTINGS_DEFAULTS.requestBudget),
        maxRequestsPerSecond: int(src.SECURITY_SCANNER_MAX_RPS, 1, 50, SCANNER_SETTINGS_DEFAULTS.maxRps),
        binDirs: (src.SECURITY_SCANNER_BIN_DIRS ?? "")
            .split(dirSep)
            .map((d) => d.trim())
            .filter(Boolean),
        zap: { baseUrl: zapBaseUrl(src.SECURITY_ZAP_URL), apiKey: (src.SECURITY_ZAP_API_KEY ?? "").trim() },
        nuclei: {
            path: (src.SECURITY_NUCLEI_PATH ?? "").trim(),
            templatesDir: (src.SECURITY_NUCLEI_TEMPLATES ?? "").trim(),
            concurrency: int(src.SECURITY_NUCLEI_CONCURRENCY, 1, 50, SCANNER_SETTINGS_DEFAULTS.nucleiConcurrency),
        },
        schemathesis: { path: (src.SECURITY_SCHEMATHESIS_PATH ?? "").trim() },
        promptfoo: { path: (src.SECURITY_PROMPTFOO_PATH ?? "").trim() },
    };
}

/** True when the administrator has not switched this scanner on at all. Every adapter reports `not_configured` in that case. */
export const isSwitchedOn = (s: ScannerSettings, id: ScannerId): boolean => s.enabled.includes(id);

/** Why a scanner is not switched on, in one sentence for the scanner health page. */
export function notEnabledReason(id: ScannerId): { reason: string; remedy: string } {
    return {
        reason: `${id} is not switched on for this platform.`,
        remedy: `Add ${id} to SECURITY_SCANNERS in the environment file and restart the platform. Nothing runs a scanner that is not named there.`,
    };
}

/** What the API and the settings view may show. Never a key, never a path that would help an outsider: only present or absent. */
export function scannerSettingsPublic(s: ScannerSettings): Record<string, unknown> {
    return {
        enabled: s.enabled,
        runMinutes: Math.round(s.runTimeoutMs / 60_000),
        requestBudget: s.requestBudget,
        maxRequestsPerSecond: s.maxRequestsPerSecond,
        zap: { configured: Boolean(s.zap.baseUrl), apiKeySet: Boolean(s.zap.apiKey) },
        nuclei: { pathSet: Boolean(s.nuclei.path), templatesDirSet: Boolean(s.nuclei.templatesDir), concurrency: s.nuclei.concurrency },
        schemathesis: { pathSet: Boolean(s.schemathesis.path) },
        promptfoo: { pathSet: Boolean(s.promptfoo.path) },
    };
}

/** The default settings, used by tests and by the standalone worker when no config is at hand. */
export const defaultScannerSettings = (): ScannerSettings => scannerSettings({});

/** Only used by tests that need an enabled scanner without touching the environment. */
export function withEnabled(base: ScannerSettings, ...ids: ScannerId[]): ScannerSettings {
    return { ...base, enabled: [...new Set([...base.enabled, ...ids])] };
}
