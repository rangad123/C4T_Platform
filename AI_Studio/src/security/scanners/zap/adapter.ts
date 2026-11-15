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
 *   - `conservative-active` is driven like `passive`: ZAP's active rules send crafted requests and submit forms, which is not
 *     conservative.
 *   - Only `advanced`, with a recorded approval, runs `ascan/action/scan`, and only on each in-scope address the run was given, without
 *     recursion (`recurse: false`): a scan from the origin with recursion attacks every page ZAP ever saw there, forms included. ZAP's own
 *     scan policy decides which rules run; the platform narrows it further by turning the daemon down (see `applyLimits`) first.
 *   - A saved sign-in is presented through a Replacer rule (`replacer/action/addRule`, request header) named for this run, limited to
 *     the target's own origin (the rule's `url` pattern, read back before any request is made) and removed when the run ends; its value
 *     is never logged. The daemon is shared between applications, so every run first removes any sign-in rule an earlier run left
 *     behind (a restart mid-run, a removal that timed out) and refuses to go on when that cannot be confirmed.
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
import { randomBytes } from "node:crypto";
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
/** Most alerts ZAP is asked to raise for one rule. */
export const ZAP_MAX_ALERTS_PER_RULE = 50;

/** One ZAP alert, as `/JSON/alert/view/alerts/` returns it. */
export interface ZapAlert {
    /** ZAP's own id for the alert row. */
    id?: string | number;
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
    readonly capabilities = { progress: true, cancel: true, sharedDaemon: true, specDriven: false, aiDriven: false, egressProxy: true };

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
        // ZAP's active scanner crafts requests: only an approved advanced profile may run it, and only on each address's GET message
        // (`method: "GET"`). That narrows what it starts from; it does not stop an active rule sending another method of its own, and the
        // platform does not see ZAP's traffic. Known gap: the advanced profile stays off (SECURITY_ACTIVE_PROFILES) until that is closed.
        const active = profile === "advanced";
        if (active && !options.approval) throw new ScannerError("profile_unsupported", this.id, "ZAP's active scan needs a recorded approval.", "Run the assessment at the passive profile, or record an approved advanced profile for a non-production environment first.");
        if (options.approval && options.approval.profile !== profile) throw new ScannerError("invalid_config", this.id, "The recorded approval is for a different profile than this run.", `The approval covers ${options.approval.profile}; this run is ${profile}.`);

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
        const limits = await applyLimits(base, apiKey, target, options, this.call);
        // The saved sign-in, as a request header ZAP adds to this run's requests to the target's origin only. It is added inside the try
        // block below (after any rule an earlier run left behind is gone) and removed again in its finally block.
        const auth = target.authHeader?.name && target.authHeader.value ? target.authHeader : null;
        // The rule's name carries when it was made and this platform process's id, so another process sharing the daemon can tell a
        // live run's rule from one left behind (removeSigninRules).
        const authRule = auth ? `${contextName}-${ZAP_PROCESS_ID}-signin` : null;
        const ruleAge = { now: () => this.now().getTime(), maxAgeMs: this.settings.runTimeoutMs + SIGNIN_RULE_MARGIN_MS };
        // Clearing up must still reach the daemon after a cancel, so these calls do not carry the run's signal.
        const steady = (component: string, operation: "view" | "action" | "other", name: string, query: ZapOptions["query"] = {}) => this.call(base, component, operation, name, { apiKey, query });
        let signinLeft: ScannerError | null = null;

        let percent = 0;
        let message = "ZAP is starting.";
        const findings: ScannerFinding[] = [];
        let coverage: ScanResultSet["coverage"] = { inspected: [], notInspected: [] };

        let releaseGuard: (() => Promise<void>) | null = null;
        try {
            // The platform's request guard, when the run has one: ZAP's own traffic goes through it as ZAP's upstream proxy. Set first,
            // read back, and restored in the finally block below; a ZAP that cannot be pointed at it is refused, never run without it.
            if (target.egress) releaseGuard = await useEgressGuard(base, apiKey, target.egress.proxyUrl, options, this.call);
            // No sign-in of another application may still be switched on in this shared daemon when this run's first request leaves.
            await removeSigninRules(steady, ruleAge);
            if (auth && authRule) {
                const url = signinRuleUrl(target.origin);
                await call("replacer", "action", "addRule", { description: authRule, enabled: "true", matchType: "REQ_HEADER", matchRegex: "false", matchString: auth.name, replacement: auth.value, initiators: "", url }).catch(() => {
                    throw new ScannerError("invalid_config", this.id, "ZAP could not be given the saved sign-in.", "Install ZAP's Replacer add-on (it ships with ZAP), or run without a saved sign-in.");
                });
                // Read back: a Replacer that ignored the address pattern would add the sign-in to requests for every host.
                const stored = (await readReplacerRules(steady)).find((rule) => rule.description === authRule);
                if (!stored || stored.url !== url)
                    throw new ScannerError("invalid_config", this.id, "ZAP did not confirm that the saved sign-in is limited to this application's own address, so the scan was refused.", "Update ZAP's Replacer add-on, or run without a saved sign-in.");
            }
            // Only THIS run's alerts are reported. ZAP keeps one alert table for the whole daemon, so alerts an earlier run raised at the
            // same addresses would otherwise come back as this run's (even for a run whose every request was refused). The target's
            // old alerts are deleted first; whatever is still there afterwards (an older ZAP without that action) is remembered and
            // left out of the result.
            // ZAP lists one alert per rule and page and keeps repeats of it hidden; deleting removes only the listed rows and the
            // hidden ones take their place. So the deletion is repeated until nothing is listed. Alerts that are still there after
            // that would make this run's repeats of them invisible, so the run fails instead of reporting less than it found.
            // Only a daemon that does not have the action at all (its first call answers bad_action/bad_view/no_implementor) falls back
            // to leaving the earlier alerts out; any other failure, in any round, fails the run.
            let before = await this.readAlerts(base, apiKey, target.origin, options);
            let canDelete = true;
            for (let round = 0; round < ZAP_DELETE_ROUNDS && before.length > 0 && canDelete; round++) {
                await call("alert", "action", "deleteAlerts", { baseurl: target.origin }).catch((e: unknown) => {
                    if (options.signal.aborted) throw e;
                    if (round === 0 && lacksAction(e)) return void (canDelete = false);
                    throw new ScannerError("tool_failed", this.id, "ZAP could not delete the alerts an earlier run left for this application, so this run's findings could not be told apart from an earlier run's. Nothing was requested.", `${(e as Error).message.split("\n")[0]!.slice(0, 200)} Check that the ZAP daemon is running and not busy, then run again.`);
                });
                if (canDelete) before = await this.readAlerts(base, apiKey, target.origin, options);
            }
            if (canDelete && before.length > 0)
                throw new ScannerError("tool_failed", this.id, "ZAP still held alerts for this application after they were deleted, so this run's findings could not be told apart from an earlier run's. Nothing was requested.", `${before.length} alert${before.length === 1 ? "" : "s"} remained after ${ZAP_DELETE_ROUNDS} deletions. Restart the ZAP daemon or start a new ZAP session, then run again.`);
            const earlier = new Set(before.map(alertKey));
            if (!active) {
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
                // One scan per in-scope address, without recursion: never the whole site tree from the origin.
                const urls = scope.allowed.slice(0, 50);
                for (const [i, url] of urls.entries()) {
                    if (options.signal.aborted || stopped) break;
                    const before = new Set(((await call("ascan", "view", "scans")) as { scan?: string[] }).scan ?? []);
                    const answer = (await call("ascan", "action", "scan", { url, recurse: false, inScopeOnly: true, method: "GET", contextName })) as { scan?: unknown };
                    const started = typeof answer?.scan === "string" || typeof answer?.scan === "number" ? String(answer.scan) : ((((await call("ascan", "view", "scans")) as { scan?: string[] }).scan ?? []).filter((x) => !before.has(x)).pop() ?? null);
                    scanId = started;
                    if (!scanId) throw new ScannerError("tool_failed", this.id, "ZAP accepted the scan but reported no scan id, so its progress cannot be followed.");
                    let one = 0;
                    while (one < 100) {
                        if (options.signal.aborted || stopped) break;
                        const status = String(((await call("ascan", "view", "status", { scanId })) as { status?: unknown }).status ?? "0");
                        one = Math.max(0, Number(status) || 0);
                        percent = Math.min(99, Math.floor(((i + Math.min(one, 100) / 100) / urls.length) * 100));
                        message = `ZAP's active scan is ${percent}% done (${i + 1} of ${urls.length} addresses).`;
                        options.onProgress?.({ percent, message, done: false });
                        if (one >= 100) break;
                        await this.sleep(ZAP_POLL_MS, options.signal);
                    }
                }
            }

            // Alerts for this target only, and for the addresses THIS run was given. ZAP consolidates passive and active alerts in the same
            // view, and that view spans the whole daemon's history, so it is filtered rather than trusted.
            const held = await this.readAlerts(base, apiKey, target.origin, options);
            const alerts = held.filter((alert) => !earlier.has(alertKey(alert)));
            const mine = alerts.filter((alert) => alertIsInScope(String(alert.url ?? ""), scope.allowed));
            for (const alert of mine) findings.push(zapAlertToFinding(alert, target.origin));
            options.log?.("alerts", { scanner: this.id, alerts: alerts.length, earlier: held.length - alerts.length, inScope: mine.length, kept: findings.length });
            coverage = zapCoverage(profile, scope.allowed.length, alerts.length, findings.length, limits, alerts.length - mine.length, held.length - alerts.length);
            percent = 100;
            message = "ZAP finished.";
            options.onProgress?.({ percent, message, done: true });
        } finally {
            if (scanId) await call("ascan", "action", "stop", { scanId }).catch(() => undefined);
            await call("context", "action", "removeContext", { contextName }).catch(() => undefined);
            // This run's sign-in, and any other platform sign-in rule, must be gone before the daemon is handed to the next run.
            signinLeft = await removeSigninRules(steady, ruleAge).then(
                () => null,
                (e) => (e instanceof ScannerError ? e : new ScannerError("tool_failed", this.id, SIGNIN_NOT_REMOVED, (e as Error).message)),
            );
            if (signinLeft) options.log?.("signin-rule-left", { scanner: this.id, error: signinLeft.message });
            await limits.restore().catch(() => undefined);
            if (lastMode) await this.call(base, "core", "action", "setMode", { apiKey, query: { mode: lastMode } }).catch(() => undefined);
            if (releaseGuard) await releaseGuard();
        }
        // A sign-in that may still be switched on in the shared daemon is not a finished run, whatever it found.
        if (signinLeft) throw signinLeft;

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

/** Every sign-in rule this platform adds to ZAP's Replacer is named like this (`<run's context name>-<process id>-signin`). */
export const ZAP_SIGNIN_RULE = /^freit-.*-signin$/;
/** This platform process's id in the names of its sign-in rules. */
export const ZAP_PROCESS_ID = randomBytes(4).toString("hex");
/** A rule of another process counts as left behind once it is older than the longest run time plus this. */
const SIGNIN_RULE_MARGIN_MS = 10 * 60_000;

/** Did ZAP answer that it has no such action at all (an older daemon), rather than failing to do it? */
const lacksAction = (e: unknown): boolean => /\b(?:bad_action|bad_view|no_implementor)\b/i.test(`${(e as Error)?.message ?? ""} ${e instanceof ZapApiError ? `${e.code} ${e.detail ?? ""}` : ""}`);

/**
 * May this platform process remove the sign-in rule of that name? Its own process's rules (only one of its runs holds the daemon at a
 * time), and any rule older than the longest run (left behind by a process that stopped). Never a younger rule of another process:
 * that is another platform process's live run. A name without a readable time is not one of this version's and is removed.
 */
export function signinRuleRemovable(description: string, at: { now: number; maxAgeMs: number; processId?: string }): boolean {
    if (!ZAP_SIGNIN_RULE.test(description)) return false;
    const m = /^freit-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-(?:([0-9a-f]{8})-)?signin$/.exec(description);
    if (!m) return true;
    if (m[7] && m[7] === (at.processId ?? ZAP_PROCESS_ID)) return true;
    const made = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
    return !(at.now - made <= at.maxAgeMs);
}
/** How often leftover sign-in rules are removed and looked for again before the run is refused. */
export const ZAP_SIGNIN_REMOVE_ROUNDS = 3;
/** How often an origin's alerts are deleted to get below the repeats ZAP keeps hidden, before the run is refused. */
export const ZAP_DELETE_ROUNDS = 50;
const SIGNIN_NOT_REMOVED = "ZAP could not confirm that no saved sign-in is left switched on in it, so the scan was stopped: a sign-in left behind would be sent with the next application's requests.";

/** The address pattern of a sign-in rule: the target's own origin and what is under it, never a longer host that starts the same. */
export const signinRuleUrl = (origin: string): string => `^${escapeRegex(origin)}(?:[/?#].*)?$`;

type ZapCall = (component: string, operation: "view" | "action" | "other", name: string, query?: ZapOptions["query"]) => Promise<Record<string, unknown>>;

/** The Replacer's rules (`replacer/view/rules`). A daemon without the Replacer add-on has none; any other failure is thrown. */
async function readReplacerRules(call: ZapCall): Promise<Array<{ description: string; url: string }>> {
    let answer: Record<string, unknown>;
    try {
        answer = await call("replacer", "view", "rules");
    } catch (e) {
        if (e instanceof ZapApiError && /no_implementor/i.test(`${e.code} ${e.detail ?? ""}`)) return [];
        throw e;
    }
    const rules = Array.isArray(answer.rules) ? answer.rules : [];
    return rules.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object").map((r) => ({ description: String(r.description ?? ""), url: String(r.url ?? "") }));
}

/**
 * Remove every sign-in rule the platform ever added to this daemon, and confirm by reading the rules again. Throws when they cannot
 * be read or one is still there: the caller must not make (or report) requests through a daemon that may add another application's
 * session to them. Rule values are never read into a message or a log.
 */
export async function removeSigninRules(call: ZapCall, age: { now: () => number; maxAgeMs: number; processId?: string } = { now: Date.now, maxAgeMs: 0 }): Promise<void> {
    const refuse = (detail: string): never => {
        throw new ScannerError("tool_failed", "zap", SIGNIN_NOT_REMOVED, `${detail} Restart the ZAP daemon, or remove the rules named freit-...-signin in ZAP's Replacer options.`);
    };
    for (let round = 0; ; round++) {
        const at = { now: age.now(), maxAgeMs: age.maxAgeMs, ...(age.processId ? { processId: age.processId } : {}) };
        const left = (await readReplacerRules(call).catch((e) => refuse(`ZAP's Replacer rules could not be read (${(e as Error).message.split("\n")[0]}).`))).filter((rule) => signinRuleRemovable(rule.description, at));
        if (!left.length) return;
        if (round >= ZAP_SIGNIN_REMOVE_ROUNDS) refuse(`${left.length} sign-in rule${left.length === 1 ? " was" : "s were"} still there after ${ZAP_SIGNIN_REMOVE_ROUNDS} removals.`);
        for (const description of new Set(left.map((rule) => rule.description))) await call("replacer", "action", "removeRule", { description }).catch(() => undefined);
    }
}

/** One ZAP run at a time may hold the daemon's upstream proxy: a second run restoring it mid-scan would let the first one go direct. */
let zapGuardTurn: Promise<void> = Promise.resolve();

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Does this answer name an HTTP proxy exclusion that is switched on (a host ZAP would reach without its upstream proxy)? */
export function hasActiveExclusion(answer: unknown): boolean {
    const walk = (v: unknown): boolean => {
        if (Array.isArray(v)) return v.some((x) => (x && typeof x === "object" ? String((x as { enabled?: unknown }).enabled ?? "true") !== "false" : Boolean(x)) || walk(x));
        if (v && typeof v === "object") return Object.values(v).some((x) => Array.isArray(x) && walk(x));
        return false;
    };
    return walk(answer);
}

/**
 * Point the daemon's upstream proxy at the request guard (ZAP's Network add-on API, ZAP 2.12 and later), read it back, refuse when an
 * exclusion would let a host bypass it, and hand back how to restore the previous setting. The daemon must run on this machine: the
 * guard listens on 127.0.0.1 only, and a daemon elsewhere would either fail every request or, worse, keep its own route out.
 */
export async function useEgressGuard(base: string, apiKey: string, proxyUrl: string, options: StartOptions, fetcher: typeof fetchJson = fetchJson): Promise<() => Promise<void>> {
    const refuse = (message: string, detail?: string): never => {
        throw new ScannerError("invalid_config", "zap", message, detail);
    };
    if (!LOOPBACK.has(new URL(base).hostname)) refuse("ZAP runs on another machine, so it cannot be sent through the platform's request guard. The scan was refused.", "Run the ZAP daemon on the platform's own machine (SECURITY_ZAP_URL=http://127.0.0.1:<port>).");
    const guard = new URL(proxyUrl);
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = zapGuardTurn;
    zapGuardTurn = before.then(() => mine);
    await before;
    const call = (name: string, operation: "view" | "action", query: ZapOptions["query"] = {}) => fetcher(base, "network", operation, name, { apiKey, signal: options.signal, query });
    let previous: { host: string; port: string; enabled: boolean } | null = null;
    const restore = async () => {
        try {
            if (previous?.enabled && previous.host && previous.port) {
                await call("setHttpProxy", "action", { host: previous.host, port: previous.port }).catch(() => undefined);
                await call("setHttpProxyEnabled", "action", { enabled: true }).catch(() => undefined);
            } else await call("setHttpProxyEnabled", "action", { enabled: false }).catch(() => undefined);
        } finally {
            release();
        }
    };
    try {
        try {
            const p = (await call("getHttpProxy", "view")) as Record<string, unknown>;
            const e = (await call("isHttpProxyEnabled", "view")) as Record<string, unknown>;
            const inner = (p.httpProxy ?? p) as Record<string, unknown>;
            previous = { host: String(inner.host ?? ""), port: String(inner.port ?? ""), enabled: /true/i.test(JSON.stringify(e)) };
        } catch {
            previous = null;
        }
        await call("setHttpProxy", "action", { host: guard.hostname, port: guard.port }).catch((e) =>
            refuse("ZAP could not be pointed at the platform's request guard, so the scan was refused.", `Needs ZAP 2.12 or later with the Network add-on. ${(e as Error).message}`),
        );
        await call("setHttpProxyEnabled", "action", { enabled: true }).catch((e) => refuse("ZAP could not be pointed at the platform's request guard, so the scan was refused.", (e as Error).message));
        const set = JSON.stringify(await call("getHttpProxy", "view").catch(() => ({})));
        const on = JSON.stringify(await call("isHttpProxyEnabled", "view").catch(() => ({})));
        if (!set.includes(guard.port) || !/true/i.test(on)) refuse("ZAP did not confirm that it uses the platform's request guard, so the scan was refused.");
        const exclusions = await call("getHttpProxyExclusions", "view").catch((e) => refuse("ZAP's proxy exclusions could not be read, so it cannot be shown that every request goes through the request guard. The scan was refused.", (e as Error).message));
        if (hasActiveExclusion(exclusions)) refuse("ZAP has proxy exclusions switched on, which would let requests bypass the platform's request guard. The scan was refused.", "Remove the HTTP proxy exclusions in ZAP's Network options.");
        options.log?.("egress", { scanner: "zap", guard: true });
        return restore;
    } catch (e) {
        await restore();
        throw e;
    }
}

/** The rate limit and scan ceiling applied before an active scan, and how to undo them. */
interface ZapLimits {
    restore: () => Promise<void>;
    note: string;
    /** A limit the daemon did not accept, in plain words for the coverage. */
    gap?: string;
}

/**
 * Turn the daemon down to what the client agreed to, in the daemon's own configuration rather than only in the platform's: a rate
 * limit rule that matches only the target host, the alert cap, and the scan duration. Every value comes from the ScanTarget, which
 * the platform built from the application's own settings, so a client cannot raise them through the interface.
 */
async function applyLimits(base: string, apiKey: string, target: ScanTarget, options: StartOptions, fetcher: typeof fetchJson = fetchJson): Promise<ZapLimits> {
    const call = (component: string, operation: "view" | "action" | "other", name: string, query: ZapOptions["query"] = {}) => fetcher(base, component, operation, name, { apiKey, signal: options.signal, query });
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
    // ZAP 2.17 has this as the passive scanner's `setMaxAlertsPerRule`; older daemons had it as a core option. A daemon that takes
    // neither keeps its own setting, and the coverage says so instead of claiming a cap that was never set.
    const alertCap = await call("pscan", "action", "setMaxAlertsPerRule", { maxAlerts: ZAP_MAX_ALERTS_PER_RULE }).then(
        () => true,
        () =>
            call("core", "action", "setOptionMaxAlertsPerRule", { maxAlerts: ZAP_MAX_ALERTS_PER_RULE }).then(
                () => true,
                () => false,
            ),
    );
    options.log?.("limits", { scanner: "zap", rps: target.maxRequestsPerSecond, minutes, alertCap });
    return {
        note: `ZAP was limited to ${target.maxRequestsPerSecond} requests a second for this host and ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        ...(alertCap ? {} : { gap: `ZAP did not accept the limit of ${ZAP_MAX_ALERTS_PER_RULE} alerts for each rule, so it kept its own setting for this run. The platform still keeps at most ${ZAP_MAX_ALERTS} alerts.` }),
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

/** What tells one alert row from another: ZAP's own id, or (a daemon that gives none) everything that makes the alert what it is. */
export const alertKey = (alert: ZapAlert): string =>
    alert.id !== undefined && alert.id !== null && String(alert.id) !== ""
        ? `id:${String(alert.id)}`
        : JSON.stringify([alert.pluginId, alert.url, alert.method, alert.param, alert.evidence, alert.attack, alert.messageId]);

export function zapCoverage(profile: ScanIntensity, requested: number, alerts: number, kept: number, limits: ZapLimits, outOfScope = 0, earlier = 0): ScanResultSet["coverage"] {
    // Only an approved advanced run uses ZAP's active rules.
    const passive = profile !== "advanced";
    return {
        inspected: [
            `ZAP received ${requested} address${requested === 1 ? "" : "es"} in scope and its ${passive ? "passive" : "active and passive"} rules ran over what came back.`,
            limits.note,
            `ZAP reported ${alerts} alert${alerts === 1 ? "" : "s"} for this origin in this run; ${kept} became findings.`,
        ],
        notInspected: [
            ...(limits.gap ? [limits.gap] : []),
            "ZAP only reports what its own scan rules look for. It does not look for broken access control between users, business-logic problems, or anything a person has to reason about.",
            ...(passive ? ["Only passive rules ran: nothing crafted was sent, so problems that need a crafted request (cross-site scripting, injection, path traversal) were not looked for."] : ["The active rules ZAP's scan policy enables ran. Rules that policy leaves out, and add-ons that are not installed, were not run."]),
            "An alert is what a rule matched. Whether it matters in this application is for a person to judge; the platform does not mark it confirmed.",
            ...(outOfScope > 0
                ? [`${outOfScope} alert${outOfScope === 1 ? "" : "s"} ZAP still held for this origin ${outOfScope === 1 ? "was" : "were"} left out: ZAP keeps one alert table for the whole daemon, so it can answer with alerts from an earlier run, and those belong to addresses this run was never given.`]
                : []),
            ...(earlier > 0
                ? [`${earlier} alert${earlier === 1 ? "" : "s"} ZAP already held for this origin before this run started ${earlier === 1 ? "was" : "were"} left out: ${earlier === 1 ? "it comes" : "they come"} from an earlier run, not from this one. If ZAP attached a repeat of ${earlier === 1 ? "it" : "them"} to the old record instead of raising it again, this run does not show it.`]
                : []),
            ...(alerts - kept - outOfScope > 0 ? [`${alerts - kept - outOfScope} alert${alerts - kept - outOfScope === 1 ? "" : "s"} were folded into other findings or left out because this run keeps at most ${ZAP_MAX_ALERTS}.`] : []),
        ],
    };
}

export { notInstalledReason };
