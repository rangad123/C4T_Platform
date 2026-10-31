/**
 * The OWASP ZAP adapter (https://www.zaproxy.org/docs/api/), driving a ZAP daemon over its documented JSON API.
 *
 * ZAP is a separate service, not a library: an administrator runs it (`zap.sh -daemon -config api.key=<key>`) and points this
 * platform at it with SECURITY_ZAP_URL and SECURITY_ZAP_API_KEY. The key never leaves the server: it is sent as the documented
 * `X-ZAP-API-Key` header, it is never written to a finding, never logged and never returned by the API.
 *
 * Passive and active are separate code paths, not one switch:
 *   - `passive` uses only what a visitor's browser would do: `core/action/accessUrl` for each in-scope address, then waits for the
 *     passive scanner queue to drain (`pscan/view/recordsToScan`) and reads the alerts it raised. No request is crafted.
 *   - `conservative-active` and `advanced` additionally run `ascan/action/scan`. ZAP's own scan policy decides which rules run;
 *     the platform narrows it further by turning the daemon down (see `applyLimits`) before the scan starts.
 *
 * Scope and safety, enforced here and not only in the interface:
 *   - Alerts are read for the target's own origin only (`baseurl`), never for another site the same daemon may have visited.
 *   - A rate-limit rule matching only the target is added before an active scan, so the load cannot exceed what the client agreed to.
 *   - `ascan/setOptionMaxScanDurationInMins` and the platform's own time limit both stop the scan; whichever comes first.
 *   - The daemon's scan mode is set to `protect` while a scan runs and restored afterwards, so nothing outside the scope is attacked.
 *   - Cancelling calls `ascan/action/stop` and stops polling. `cleanup()` always runs, restores the mode and never throws.
 *
 * One thing to know before writing a caller: `start()` is EAGER. It runs the whole scan before it returns a handle, so `results()` is
 * already computed by the time you have it, and a cancellation surfaces as `start()` rejecting rather than as `results()` rejecting.
 * Anything that wants to cancel mid-scan has to arm its signal BEFORE awaiting `start()`; awaiting it first lets the scan finish and
 * then cancels nothing. Verified against a real 2.17.0 daemon (tests/security-zap-daemon-live.test.ts).
 *
 * What a ZAP run does NOT prove: a scan finds what its rules look for. Missing headers, cookie flags and disclosure are found well by
 * ZAP's passive rules; broken access control, business logic and anything needing a real person's judgement are not. The coverage the
 * adapter returns says so in those words.
 */
import { ScannerError, type ConfigCheck, type ScanHandle, type ScanIntensity, type ScanResultSet, type ScannerAdapter, type ScannerAvailability, type ScannerFinding, type ScannerScopeCheck, type ScanTarget, type StartOptions } from "../contract.js";
import { notConfiguredReason, notInstalledReason } from "../binaries.js";
import { isSwitchedOn, notEnabledReason, type ScannerSettings } from "../settings.js";
import { categoryFor, severityOf } from "../normalize.js";
import { zapBaseUrl } from "../settings.js";

/** How long one ZAP API call may take before it is treated as unreachable. */
export const ZAP_CALL_TIMEOUT_MS = 30_000;
/** How often the scan status is read while a scan runs. */
export const ZAP_POLL_MS = 5_000;
/** Most alerts one run reads from one host, in pages. */
export const ZAP_ALERT_PAGE = 500;
/** Most alerts one run keeps, so one noisy site cannot fill the database. */
export const ZAP_MAX_ALERTS = 2_000;
/** How much of ZAP's own evidence is kept per alert (before redaction). */
export const ZAP_MAX_EVIDENCE = 1_200;

/** One ZAP alert, as `/JSON/alert/view/alerts/` returns it. */
export interface ZapAlert {
    pluginId?: string;
    alert?: string;
    risk?: string;
    confidence?: string;
    riskcode?: number | string;
    desc?: string;
    instances?: number;
    solution?: string;
    evidence?: string;
    cweid?: string | number;
    wascid?: string | number;
    reference?: string;
    messageId?: string | number;
    url?: string;
    method?: string;
    param?: string;
    attack?: string;
    confidenceId?: string | number;
}

export interface ZapAdapterOptions {
    settings: ScannerSettings;
    /** Overridable for tests: how the daemon is reached. Never takes an address from a request. */
    fetchJson?: typeof fetchJson;
    now?: () => Date;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ZapOptions {
    /** Extra query parameters, already URL-encoded by `zapUrl`. */
    query?: Record<string, string | number | boolean | undefined | null>;
    /** POST instead of GET (ZAP accepts both; the platform uses GET, which is what its documentation shows). */
    method?: "GET" | "POST";
    /** The API key. Sent as the documented header; never part of a URL that could be logged. */
    apiKey?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export class ZapApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly detail?: string,
    ) {
        super(message);
        this.name = "ZapApiError";
    }
}

/** Build one ZAP API URL. Only http/https, never a credential in the URL, and the key never goes into the query string. */
export function zapUrl(base: string, component: string, operation: "view" | "action" | "other", name: string, query: Record<string, string | number | boolean | undefined | null> = {}): string {
    const base1 = base.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base1)) throw new ScannerError("invalid_config", "zap", "The ZAP address is not an http or https address.");
    const url = new URL(`${base1}/JSON/${component}/${operation}/${name}/`);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        // The API key is sent as the documented X-ZAP-API-Key header and must never end up in a URL: a URL reaches access logs, proxy
        // logs and browser history. ZAP's own API also accepts the key as a parameter, so this is a real possibility, not an imagined
        // one - so building such a URL here is refused rather than returned.
        if (/api[-_]?key|^key$|token|secret|password/i.test(key))
            throw new ScannerError("invalid_config", "zap", `The ZAP API key cannot be put in a request URL (${key}). It is sent as the X-ZAP-API-Key header instead.`);
        url.searchParams.set(key, String(value));
    }
    return url.toString();
}

/**
 * Why a call to ZAP did not get an answer, in the two shapes an operator actually has to tell apart.
 *
 *   nothing-listening  nothing is bound to the address at all. ZAP is not running, or SECURITY_ZAP_URL names another port or host.
 *   connection-dropped something IS listening and closed the connection without answering. This is what a ZAP daemon does when its
 *                      API is closed or the caller is not one of the addresses it permits: it accepts the socket and hangs up, so the
 *                      address is right and the diagnosis "ZAP is not running" sends the reader the wrong way. Verified on ZAP 2.17.0,
 *                      which answers every /JSON request with exactly this while its API stays closed.
 *
 * Anything else (a timeout, a TLS mismatch) is left to the caller's own wording rather than guessed at here.
 */
export type ZapReachability = "nothing-listening" | "connection-dropped" | "other";

export function zapReachability(e: unknown): ZapReachability {
    // Follow the cause chain: an adapter that already rewrote the failure in the platform's words still has to be able to tell which of
    // the two problems it was, and the code that knows lives further down.
    let cursor: unknown = e;
    for (let depth = 0; depth < 5 && cursor; depth++) {
        const code = String((cursor as { code?: string }).code ?? "");
        if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "nothing-listening";
        if (code === "UND_ERR_SOCKET" || code === "ECONNRESET" || code === "EPIPE") return "connection-dropped";
        cursor = (cursor as { cause?: unknown }).cause;
    }
    return "other";
}

/** One call to the ZAP API. Never throws for a tool that is down: it throws `ScannerError`, which the run records in plain words. */
export async function fetchJson(base: string, component: string, operation: "view" | "action" | "other", name: string, options: ZapOptions = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ZAP_CALL_TIMEOUT_MS);
    try {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (options.apiKey) headers["X-ZAP-API-Key"] = options.apiKey;
        const response = await fetch(zapUrl(base, component, operation, name, options.query), {
            method: options.method ?? "GET",
            headers,
            signal: controller.signal,
            redirect: "error",
        });
        const text = await response.text();
        if (!response.ok) throw new ZapApiError(response.status, "http_error", `ZAP answered ${response.status} for ${component}/${operation}/${name}.`, text.slice(0, 200));
        let json: Record<string, unknown>;
        try {
            json = JSON.parse(text) as Record<string, unknown>;
        } catch {
            throw new ZapApiError(response.status, "not_json", `ZAP did not answer JSON for ${component}/${operation}/${name}. It may be closed without an API key, or the address may not be a ZAP daemon.`, text.slice(0, 200));
        }
        if (json.code && json.code !== "OK" && String(json.code) !== "1000") {
            throw new ZapApiError(response.status, String(json.code), String(json.message ?? "ZAP refused the request."), typeof json.detail === "string" ? json.detail : undefined);
        }
        return json;
    } catch (e) {
        if (e instanceof ZapApiError) throw e;
        const reach = zapReachability(e);
        const message =
            (e as Error).name === "AbortError"
                ? `ZAP did not answer ${component}/${operation}/${name} in time.`
                : reach === "connection-dropped"
                  ? "ZAP closed the connection without answering. The daemon is running but its API is closed to this address."
                  : `ZAP could not be reached: ${(e as Error).message.split("\n")[0]}`;
        // The cause travels with the error: the message above says what happened, and the cause still says which of the two very
        // different problems it was, so the health view can give the operator the fix that matches.
        throw new ScannerError(e instanceof ScannerError ? e.code : "tool_failed", "zap", message, (e as Error).message, { cause: e });
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
    }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

export class ZapAdapter implements ScannerAdapter {
    readonly id = "zap" as const;
    readonly name = "OWASP ZAP";
    readonly documentationUrl = "https://www.zaproxy.org/docs/api/";
    readonly description = "A separate ZAP service the platform drives over its documented API. Installed and started by an administrator; it is only used when SECURITY_SCANNERS names it and SECURITY_ZAP_URL points at a running daemon.";
    readonly capabilities = { progress: true, cancel: true, sharedDaemon: true, specDriven: false, aiDriven: false };

    private readonly settings: ScannerSettings;
    private readonly call: typeof fetchJson;
    private readonly now: () => Date;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

    constructor(options: ZapAdapterOptions) {
        this.settings = options.settings;
        this.call = options.fetchJson ?? fetchJson;
        this.now = options.now ?? (() => new Date());
        this.sleep = options.sleep ?? defaultSleep;
    }

    private base(): string {
        return zapBaseUrl(this.settings.zap.baseUrl);
    }

    private apiKey(): string {
        return this.settings.zap.apiKey;
    }

    async available(signal?: AbortSignal): Promise<ScannerAvailability> {
        const at = this.now().toISOString();
        if (!isSwitchedOn(this.settings, this.id)) return { scanner: this.id, state: "not_configured", checkedAt: at, ...notEnabledReason(this.id) };
        const base = this.base();
        if (!base) return { scanner: this.id, state: "not_configured", checkedAt: at, ...notConfiguredReason("No ZAP address is set", "SECURITY_ZAP_URL") };
        if (!this.apiKey()) return { scanner: this.id, state: "not_configured", checkedAt: at, reason: "No ZAP API key is set, and ZAP refuses API actions without one.", remedy: "Start ZAP with an API key (zap.sh -daemon -config api.key=<key>) and set SECURITY_ZAP_API_KEY to the same value." };
        const startedAt = Date.now();
        try {
            const answer = await this.call(base, "core", "view", "version", { apiKey: this.apiKey(), signal, timeoutMs: 15_000 });
            const version = String(answer.version ?? "").trim();
            if (!version) return { scanner: this.id, state: "unknown", checkedAt: at, reason: "The ZAP service at the configured address answered, but not with a version.", remedy: "Check that SECURITY_ZAP_URL points at a ZAP daemon and not at something else.", tookMs: Date.now() - startedAt };
            return { scanner: this.id, state: "available", version, checkedAt: at, tookMs: Date.now() - startedAt };
        } catch (e) {
            const refusedKey = /code|API key|not allowed|forbidden/i.test((e as Error).message);
            const closed = zapReachability(e) === "connection-dropped";
            // A daemon that hangs up without answering is a different problem from a daemon that is not running, and it has a different
            // fix. Saying "check that ZAP is running" when ZAP is running and its API is closed wastes an operator's afternoon.
            const remedy = refusedKey
                ? "Check that SECURITY_ZAP_API_KEY matches the key ZAP was started with, and that this machine is in ZAP's allowed addresses."
                : closed
                  ? "ZAP is listening but hung up without answering, and it does that for two different reasons the socket cannot tell apart. Check the API key FIRST - it is the more common cause: SECURITY_ZAP_API_KEY must equal the key ZAP was started with. If the key is right, ZAP's API is probably closed; start the daemon with it open (zap.bat -daemon -config api.enabled=true -host 127.0.0.1 -port 8090 -config api.secure=false). Use -host and -port, NOT -config api.addrs.* : that form writes a string into a boolean option, which makes ZAP throw while loading its own settings and leaves the API shut with no error of its own."
                  : "Check that ZAP is running and that SECURITY_ZAP_URL points at it.";
            return {
                scanner: this.id,
                state: refusedKey ? "misconfigured" : "unavailable",
                checkedAt: at,
                reason: refusedKey
                    ? "ZAP refused the API key the platform was given."
                    : closed
                      ? `ZAP is listening at ${base} but closed the connection without answering. That is what ZAP does both when its API is closed and when the API key does not match.`
                      : `ZAP could not be reached at ${base}: ${(e as Error).message.split("\n")[0]}`,
                remedy,
                tookMs: Date.now() - startedAt,
            };
        }
    }

    async validateConfig(signal?: AbortSignal): Promise<ConfigCheck> {
        const problems: string[] = [];
        const checked: string[] = [];
        if (!isSwitchedOn(this.settings, this.id)) problems.push(notEnabledReason(this.id).reason);
        const base = this.base();
        if (!base) problems.push(notConfiguredReason("No ZAP address is set", "SECURITY_ZAP_URL").reason);
        else checked.push(`ZAP address set (${base.replace(/:\d+$/, ":<port>")}).`);
        if (!this.apiKey()) problems.push("No ZAP API key is set. ZAP refuses API actions without one.");
        else checked.push("An API key is set (its value is never shown).");
        if (base) {
            const availability = await this.available(signal);
            checked.push(`ZAP answered as ${availability.state}${availability.version ? `, version ${availability.version}` : ""}.`);
            if (availability.state !== "available") problems.push(availability.reason ?? `ZAP is ${availability.state}.`);
        }
        return { ok: problems.length === 0, problems, checked };
    }

    supports(profile: ScanIntensity): boolean {
        // ZAP has a passive mode and an active scanner; both are within what this platform offers. Which rules run is ZAP's own scan
        // policy plus the limits applied in `applyLimits`.
        return profile === "passive" || profile === "conservative-active" || profile === "advanced";
    }

    async validateScope(target: ScanTarget): Promise<ScannerScopeCheck> {
        const allowed: string[] = [];
        const refused: ScannerScopeCheck["refused"] = [];
        for (const url of target.urls) {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                refused.push({ url, code: "unsupported-scheme", reason: "It is not an address ZAP can request." });
                continue;
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                refused.push({ url, code: "unsupported-scheme", reason: `ZAP requests http and https only, and this is ${parsed.protocol}` });
                continue;
            }
            // ZAP's spider follows links; the context below keeps it inside the target's own origin, and anything else is refused here.
            if (parsed.origin !== target.origin) {
                refused.push({ url, code: "out-of-scope", reason: "It is not on the application's own origin, and ZAP is only pointed at that origin." });
                continue;
            }
            const path = parsed.pathname;
            if (target.excludedPaths.some((prefix) => prefix && (path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))) {
                refused.push({ url, code: "excluded-path", reason: "It is under an excluded path or a sensitive workflow." });
                continue;
            }
            allowed.push(url);
        }
        // ZAP needs a base URL even when no address is left: the one under the application's own origin.
        return { ok: allowed.length > 0, allowed, refused };
    }

    async start(target: ScanTarget, profile: ScanIntensity, options: StartOptions): Promise<ScanHandle> {
        if (!this.supports(profile)) throw new ScannerError("profile_unsupported", this.id, `ZAP is not used at the ${profile} profile.`);
        const base = this.base();
        if (!base) throw new ScannerError("not_configured", this.id, "No ZAP address is set, so nothing can be asked of it.");
        const apiKey = this.apiKey();
        if (!apiKey) throw new ScannerError("invalid_config", this.id, "No ZAP API key is set. ZAP refuses API actions without one.");

        const scope = await this.validateScope(target);
        if (!scope.ok) throw new ScannerError("out_of_scope", this.id, "None of this assessment's addresses may be requested by ZAP.", scope.refused.map((r) => `${r.url}: ${r.reason}`).join("; "));

        const startedAt = Date.now();
        const contextName = `freit-${this.now().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
        let scanId: string | null = null;
        let stopped = false;
        let lastMode: string | null = null;
        const call = (component: string, operation: "view" | "action" | "other", name: string, query: ZapOptions["query"] = {}) => this.call(base, component, operation, name, { apiKey, signal: options.signal, query });

        // A context keeps the spider and the active scanner inside the target's own origin, and the excluded paths stay out.
        await call("context", "action", "newContext", { contextName });
        await call("context", "action", "includeInContext", { contextName, regex: `${escapeRegex(target.origin)}.*` });
        for (const excluded of [...new Set([...target.excludedPaths, ...scope.refused.filter((r) => r.code === "excluded-path").map((r) => new URL(r.url).pathname)])]) {
            if (!excluded) continue;
            await call("context", "action", "excludeFromContext", { contextName, regex: `${escapeRegex(target.origin)}${escapeRegex(excluded)}.*` }).catch(() => undefined);
        }
        const limits = await applyLimits(base, apiKey, target, options);

        let percent = 0;
        let message = "ZAP is starting.";
        const findings: ScannerFinding[] = [];
        let coverage: ScanResultSet["coverage"] = { inspected: [], notInspected: [] };

        try {
            if (profile === "passive") {
                // Ordinary requests only: exactly what a visitor's browser would do, one per in-scope address.
                for (const url of scope.allowed.slice(0, 50)) {
                    if (options.signal.aborted) throw new ScannerError("cancelled", this.id, "The ZAP scan was cancelled.");
                    await call("core", "action", "accessUrl", { url, contextName }).catch((e) => options.log?.("access-failed", { scanner: this.id, url: new URL(url).pathname, error: (e as Error).message.slice(0, 120) }));
                }
                await this.drainPassiveQueue(base, apiKey, options, (p, note) => {
                    percent = p;
                    message = note;
                    options.onProgress?.({ percent, message, done: false });
                });
            } else {
                lastMode = await this.enterProtectedMode(base, apiKey, options);
                await call("ascan", "action", "scan", { url: target.origin, recurse: true, inScopeOnly: true, contextName });
                const answer = (await call("ascan", "view", "scans")) as { scan?: string[] };
                const started = answer.scan ?? [];
                scanId = started.length ? started[started.length - 1]! : null;
                if (!scanId) throw new ScannerError("tool_failed", this.id, "ZAP accepted the scan but reported no scan id, so its progress cannot be followed.");
                while (percent < 100) {
                    if (options.signal.aborted || stopped) break;
                    const status = String(((await call("ascan", "view", "status", { scanId })) as { status?: unknown }).status ?? "0");
                    percent = Math.min(99, Math.max(0, Number(status) || 0));
                    message = `ZAP's active scan is ${percent}% done.`;
                    options.onProgress?.({ percent, message, done: false });
                    if (percent >= 100) break;
                    await this.sleep(ZAP_POLL_MS, options.signal);
                }
            }

            // Alerts for this target only, and for the addresses THIS run was given. ZAP consolidates passive and active alerts in the same
            // view, and that view spans the whole daemon's history, so it is filtered rather than trusted.
            const alerts = await this.readAlerts(base, apiKey, target.origin, options);
            const mine = alerts.filter((alert) => alertIsInScope(String(alert.url ?? ""), scope.allowed));
            for (const alert of mine) findings.push(zapAlertToFinding(alert, target.origin));
            options.log?.("alerts", { scanner: this.id, alerts: alerts.length, inScope: mine.length, kept: findings.length });
            coverage = zapCoverage(profile, scope.allowed.length, alerts.length, findings.length, limits, alerts.length - mine.length);
            percent = 100;
            message = "ZAP finished.";
            options.onProgress?.({ percent, message, done: true });
        } finally {
            if (scanId) await call("ascan", "action", "stop", { scanId }).catch(() => undefined);
            await call("context", "action", "removeContext", { contextName }).catch(() => undefined);
            await limits.restore().catch(() => undefined);
            if (lastMode) await this.call(base, "core", "action", "setMode", { apiKey, query: { mode: lastMode } }).catch(() => undefined);
        }

        return {
            scanner: this.id,
            reference: scanId,
            progress: async () => ({ percent, message, done: percent >= 100 }),
            cancel: async () => {
                stopped = true;
                if (scanId) await call("ascan", "action", "stop", { scanId }).catch(() => undefined);
            },
            results: async (): Promise<ScanResultSet> => ({ findings, coverage, reference: scanId }),
            cleanup: async () => {
                /* the context, the limits and the mode were restored in the finally block above */
            },
        };
    }

    /** ZAP passively scans in the background; a run is not finished until its queue is empty (or the time limit passes). */
    private async drainPassiveQueue(base: string, apiKey: string, options: StartOptions, report: (percent: number, note: string) => void): Promise<void> {
        const deadline = this.now().getTime() + Math.max(30_000, Math.min(options.signal ? 600_000 : 0, 600_000));
        let seen = 0;
        for (let i = 0; i < 200; i++) {
            if (options.signal.aborted) throw new ScannerError("cancelled", this.id, "The ZAP scan was cancelled.");
            const left = String(((await this.call(base, "pscan", "view", "recordsToScan", { apiKey, signal: options.signal, query: {} })) as { recordsToScan?: unknown }).recordsToScan ?? "0");
            const remaining = Number(left) || 0;
            const percent = seen > 0 ? Math.min(99, Math.round((seen / (seen + remaining)) * 100)) : remaining > 0 ? 5 : 99;
            report(percent, remaining > 0 ? `ZAP is passively checking what it received (${remaining} left).` : "ZAP's passive checks are done.");
            if (remaining <= 0) return;
            seen = Math.max(seen, 1);
            if (this.now().getTime() > deadline) return;
            await this.sleep(2_000, options.signal);
        }
    }

    /** Read this origin's alerts, page by page, and never more than `ZAP_MAX_ALERTS` of them. */
    private async readAlerts(base: string, apiKey: string, baseurl: string, options: StartOptions): Promise<ZapAlert[]> {
        const out: ZapAlert[] = [];
        for (let start = 0; start < ZAP_MAX_ALERTS; start += ZAP_ALERT_PAGE) {
            const answer = (await this.call(base, "alert", "view", "alerts", { apiKey, signal: options.signal, query: { baseurl, start, count: ZAP_ALERT_PAGE } })) as { alerts?: ZapAlert[] };
            const page = Array.isArray(answer.alerts) ? answer.alerts : [];
            out.push(...page);
            if (page.length < ZAP_ALERT_PAGE) break;
        }
        return out;
    }

    /** `protect` mode makes ZAP only act on what is in scope. The mode it replaces is restored by `cleanup`. */
    private async enterProtectedMode(base: string, apiKey: string, options: StartOptions): Promise<string | null> {
        const answer = (await this.call(base, "core", "view", "mode", { apiKey, signal: options.signal, query: {} })) as { mode?: unknown };
        const before = typeof answer.mode === "string" ? answer.mode : null;
        await this.call(base, "core", "action", "setMode", { apiKey, signal: options.signal, query: { mode: "protect" } });
        return before;
    }
}

/** The rate limit and scan ceiling applied before an active scan, and how to undo them. */
interface ZapLimits {
    restore: () => Promise<void>;
    note: string;
}

/**
 * Turn the daemon down to what the client agreed to, in the daemon's own configuration rather than only in the platform's: a rate
 * limit rule that matches only the target host, the alert cap, and the scan duration. Every value comes from the ScanTarget, which
 * the platform built from the application's own settings, so a client cannot raise them through the interface.
 */
async function applyLimits(base: string, apiKey: string, target: ScanTarget, options: StartOptions): Promise<ZapLimits> {
    const call = (component: string, operation: "view" | "action" | "other", name: string, query: ZapOptions["query"] = {}) => fetchJson(base, component, operation, name, { apiKey, signal: options.signal, query });
    const description = `freit-${target.applicationId}-${Math.max(1, target.maxRequestsPerSecond)}rps`;
    const host = new URL(target.origin).host;
    let addedRule = false;
    try {
        await call("network", "action", "addRateLimitRule", { description, enabled: true, matchRegex: false, matchString: host, requestsPerSecond: Math.max(1, target.maxRequestsPerSecond), groupBy: "host" });
        addedRule = true;
    } catch {
        /* an older ZAP may not have this component; the platform's own caps still apply */
    }
    const minutes = Math.max(1, Math.round(target.timeoutMs / 60_000));
    await call("ascan", "action", "setOptionMaxScanDurationInMins", { Integer: minutes }).catch(() => undefined);
    await call("core", "action", "setOptionMaxAlertsPerRule", { maxAlerts: 50 }).catch(() => undefined);
    options.log?.("limits", { scanner: "zap", rps: target.maxRequestsPerSecond, minutes });
    return {
        note: `ZAP was limited to ${target.maxRequestsPerSecond} requests a second for this host and ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        restore: async () => {
            if (addedRule) await call("network", "action", "removeRateLimitRule", { description }).catch(() => undefined);
        },
    };
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ZAP's own alert as a platform finding. ZAP's wording, evidence and links are kept (and redacted by the findings pipeline). */
export function zapAlertToFinding(alert: ZapAlert, baseurl: string): ScannerFinding {
    const title = String(alert.alert ?? "ZAP alert").trim();
    const pluginId = String(alert.pluginId ?? "0");
    const cwe = alert.cweid === undefined || alert.cweid === null || alert.cweid === "" ? undefined : `CWE-${String(alert.cweid).replace(/^CWE-/i, "")}`;
    const url = String(alert.url ?? baseurl).startsWith("http") ? String(alert.url) : `${baseurl}${String(alert.url ?? "")}`;
    const evidence = [
        { kind: "note" as const, label: "What ZAP matched on", value: String(alert.evidence ?? "").slice(0, ZAP_MAX_EVIDENCE) },
        ...(alert.attack ? [{ kind: "body-excerpt" as const, label: "Request ZAP sent", value: `${alert.method ?? "GET"} ${url}${alert.param ? ` (parameter: ${alert.param})` : ""}\n${String(alert.attack).slice(0, ZAP_MAX_EVIDENCE)}` }] : []),
        {
            kind: "note" as const,
            label: "ZAP's own record",
            value: `alert ${pluginId}, risk ${String(alert.risk ?? "?")}, confidence ${String(alert.confidence ?? "?")}${alert.instances ? `, ${alert.instances} occurrence${Number(alert.instances) === 1 ? "" : "s"}` : ""}${cwe ? `, ${cwe}` : ""}`,
        },
    ];
    return {
        scannerRuleId: `zap:${pluginId}`,
        title,
        severity: severityOf(alert.risk ?? alert.riskcode),
        category: categoryFor({ scannerRuleId: pluginId, title, description: String(alert.desc ?? ""), ...(cwe ? { cwe } : {}) }),
        url,
        description: String(alert.desc ?? "").trim() || `ZAP's rule ${pluginId} matched at this address.`,
        evidence,
        ...(alert.solution ? { remediation: String(alert.solution) } : {}),
        ...(typeof alert.reference === "string" && alert.reference.trim() ? { references: alert.reference.split(/\s{2,}|\n/).map((r) => r.trim()).filter(Boolean).slice(0, 5) } : {}),
        confidence: zapConfidenceOf(alert.confidence ?? alert.confidenceId),
        ...(cwe ? { cwe } : {}),
    };
}

const zapConfidenceOf = (value: unknown): "high" | "medium" | "low" => {
    const s = String(value ?? "").trim().toLowerCase();
    if (s === "high" || s === "3") return "high";
    if (s === "medium" || s === "2") return "medium";
    return "low";
};

/** What one ZAP run looked at, in the plain words a report needs. */
/**
 * ZAP keeps ONE alert table per daemon and `core/view/alerts` returns everything it has ever raised, not only what this run produced.
 * Asking it for the target's origin therefore still returns alerts for pages this assessment never visited, which would put evidence against
 * addresses that were never in scope (verified on 2.17.0: a run given a single address was handed alerts for three, while its own coverage
 * line said one address was in scope). An alert is therefore only kept when its own address is one this run was actually given.
 */
export function alertIsInScope(alertUrl: string, allowed: readonly string[]): boolean {
    if (!allowed.length) return false;
    return allowed.some((url) => {
        if (url === alertUrl) return true;
        // An in-scope address covers what sits under it, but only on a whole path boundary: /books must not quietly cover /books-private.
        return alertUrl.startsWith(`${url}/`) || alertUrl.startsWith(`${url}?`) || alertUrl.startsWith(`${url}#`);
    });
}

export function zapCoverage(profile: ScanIntensity, requested: number, alerts: number, kept: number, limits: ZapLimits, outOfScope = 0): ScanResultSet["coverage"] {
    const passive = profile === "passive";
    return {
        inspected: [
            `ZAP received ${requested} address${requested === 1 ? "" : "es"} in scope and its ${passive ? "passive" : "active and passive"} rules ran over what came back.`,
            limits.note,
            `ZAP reported ${alerts} alert${alerts === 1 ? "" : "s"} for this origin; ${kept} became findings.`,
        ],
        notInspected: [
            "ZAP only reports what its own scan rules look for. It does not look for broken access control between users, business-logic problems, or anything a person has to reason about.",
            ...(passive ? ["Only passive rules ran: nothing crafted was sent, so problems that need a crafted request (cross-site scripting, injection, path traversal) were not looked for."] : ["The active rules ZAP's scan policy enables ran. Rules that policy leaves out, and add-ons that are not installed, were not run."]),
            "An alert is what a rule matched. Whether it matters in this application is for a person to judge; the platform does not mark it confirmed.",
            ...(outOfScope > 0
                ? [`${outOfScope} alert${outOfScope === 1 ? "" : "s"} ZAP still held for this origin ${outOfScope === 1 ? "was" : "were"} left out: ZAP keeps one alert table for the whole daemon, so it can answer with alerts from an earlier run, and those belong to addresses this run was never given.`]
                : []),
            ...(alerts - kept - outOfScope > 0 ? [`${alerts - kept - outOfScope} alert${alerts - kept - outOfScope === 1 ? "" : "s"} were folded into other findings or left out because this run keeps at most ${ZAP_MAX_ALERTS}.`] : []),
        ],
    };
}

export { notInstalledReason };
