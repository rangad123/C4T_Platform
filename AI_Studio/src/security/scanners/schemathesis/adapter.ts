/**
 * The Schemathesis adapter (https://github.com/schemathesis/schemathesis), driving an independently installed `schemathesis`
 * command against an OpenAPI document the client uploaded or published.
 *
 * Why Schemathesis: it validates a real API against its own contract rather than by guessing. It reads the document, generates test
 * data from the schema, and reports where the answer contradicts what the document promised. It is the only one of the reviewed
 * tools that can say "this endpoint does not do what its own specification says" with evidence, and it is a documented CLI, so the
 * platform drives it as a child process like nuclei rather than embedding it.
 *
 * How it is driven (every flag below is the platform's; nothing is ever taken from a request):
 *   schemathesis run <spec written to a secure temp file> --url <the scope-checked origin>
 *     --checks <a reviewed list> --include-method <safe methods only> --mode positive
 *     --max-examples <n> --workers 1 --rate-limit <n>/m --no-shrink (deliberately NOT --generation-deterministic: see below)
 *     --report ndjson,json --report-ndjson-path <temp> --report-json-path <temp>
 *     --output-sanitize true --max-time <seconds> --exclude-path-regex <each excluded prefix>
 *     [--config-file <temp>/schemathesis.toml, only when a saved sign-in is presented: its header value comes from the environment]
 *
 * The API document handed to it never holds an excluded operation: every operation under an excluded path or a sensitive workflow is
 * removed from the document before it is written out (`withoutExcludedOperations`), so Schemathesis cannot generate a request to one;
 * `--exclude-path-regex` repeats the rule as a second guard. A document that cannot be read while paths are excluded is refused.
 *
 * Check names depend on the installed version (`checksForVersion`): a check newer than the installed Schemathesis is left out and the
 * coverage says so, because the CLI refuses the whole run over one unknown name. Versions before 4.0 are refused: the report flags used
 * here exist from 4.0 on.
 *
 * Facts verified against schemathesis 4.32.4 on Windows, which this adapter depends on and its tests pin:
 *   - The child MUST be given PYTHONIOENCODING=utf-8 and PYTHONUTF8=1. Without them it dies with a UnicodeEncodeError while
 *     drawing its own header, because Windows consoles default to cp1252.
 *   - The specification MUST be written without a byte-order mark. A UTF-8 BOM makes it fail to load with "Unexpected UTF-8 BOM".
 *   - `--include-method` (repeatable) is the safe-method gate; without it state-changing operations would be generated too.
 *   - Per-case detail (the request sent, the answer received, the check that failed and its own severity) arrives in the NDJSON
 *     report; the JSON report carries the run counters and stop reason. Both are written into the secure temp directory and read
 *     back before it is removed.
 *
 * Safety rules kept here rather than in the interface:
 *   - Only the methods `--mode positive` and the reviewed check list allow are generated, and state-changing methods are excluded at
 *     EVERY profile, advanced included (no profile creates, updates, deletes or overwrites data; the coverage lists them as skipped).
 *   - `--rate-limit` is the application's own agreed rate, and `--workers 1` keeps the load to one request stream.
 *   - No state-changing operation is ever requested. POST/PUT/PATCH/DELETE are never passed to `--include-method`.
 *   - The base URL is the origin the scope guard already pinned. Schemathesis follows the document's own paths from there; a
 *     document naming a different server is rewritten by the adapter before it is written out.
 *
 * What a Schemathesis run does NOT prove: it tests what the document describes. An endpoint missing from the document is never
 * reached, and a mismatch between the document and the answer is a contradiction to investigate, not proof of an exploitable
 * vulnerability. The coverage the adapter returns says exactly that.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { ScannerError, type ConfigCheck, type ScanHandle, type ScanIntensity, type ScanResultSet, type ScannerAdapter, type ScannerAvailability, type ScannerFinding, type ScannerScopeCheck, type ScanTarget, type StartOptions } from "../contract.js";
import { notConfiguredReason, notInstalledReason, resolveExecutable } from "../binaries.js";
import { runProcess, withSecureTempDir, type SecureTempDir } from "../process.js";
import { egressEnv } from "../../egress/guard.js";
import { isolationFor } from "../../egress/isolation.js";
import { isSwitchedOn, notEnabledReason, type ScannerSettings } from "../settings.js";
import { categoryFor, MAX_SCANNER_EVIDENCE, severityOf } from "../normalize.js";
import { parse as parseYaml } from "yaml";

/** Most operations one run may generate cases for. Small on purpose: the tool is slow and the request budget is the real limit. */
export const SCHEMATHESIS_MAX_EXAMPLES = 5;
/** Methods that cannot change the application's state. The only ones any profile generates. */
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
/** Methods that may change data. Never generated, at any profile: operations using them are skipped and listed as skipped. */
export const STATE_CHANGING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
/**
 * The reviewed check list. Each one compares an answer against the document's own promise, which is why they are safe to run:
 * none of them creates, deletes or modifies anything on the server.
 */
export const REVIEWED_CHECKS = ["not_a_server_error", "status_code_conformance", "content_type_conformance", "response_headers_conformance", "response_schema_conformance", "missing_required_header", "allow_header_conformance"] as const;
/** Checks that need two identities with different roles, or that deliberately send broken input. Never run without an approval. */
export const ADVANCED_ONLY_CHECKS = ["negative_data_rejection", "positive_data_acceptance", "unsupported_method", "ignored_auth", "object_level_authorization", "ensure_resource_availability", "use_after_free"] as const;
/**
 * The first Schemathesis release with each check, where it is later than 4.0.0 (from its CHANGELOG.md and src/schemathesis/specs/openapi/
 * checks.py at v4.32.4). Every other check of the two lists exists from 4.0.0 on.
 */
export const CHECK_SINCE: Readonly<Record<string, string>> = { allow_header_conformance: "4.25.0", object_level_authorization: "4.31.0" };
/** The oldest Schemathesis this adapter drives: the NDJSON report and `--mode` came with 4.0. */
export const SCHEMATHESIS_MIN_VERSION = "4.0.0";

const versionNumber = (v: string): number[] => v.split(".").map((x) => Number.parseInt(x, 10) || 0);
/** a >= b for dotted versions. */
export function versionAtLeast(a: string, b: string): boolean {
    const x = versionNumber(a);
    const y = versionNumber(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0) return d > 0;
    }
    return true;
}

/** The checks a profile may run on this installed version, and the ones left out because the version does not know them yet. */
export function checksForVersion(profile: ScanIntensity, version: string | undefined): { checks: string[]; leftOut: string[] } {
    const all = checksFor(profile);
    if (!version) return { checks: all.filter((c) => !CHECK_SINCE[c]), leftOut: all.filter((c) => CHECK_SINCE[c]) };
    return { checks: all.filter((c) => !CHECK_SINCE[c] || versionAtLeast(version, CHECK_SINCE[c]!)), leftOut: all.filter((c) => CHECK_SINCE[c] && !versionAtLeast(version, CHECK_SINCE[c]!)) };
}

const underPrefix = (p: string, prefix: string): boolean => {
    if (!prefix) return false;
    const bare = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    // A whole path boundary, the same rule as the scope checks: /admin covers /admin/users, never /administer.
    return p === bare || p.startsWith(`${bare}/`);
};
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The API document without the operations under an excluded path or a sensitive workflow, as JSON. A path counts with and without
 * the document's own base path (OpenAPI `servers[0].url`, Swagger `basePath`). Unreadable while something must be excluded: refused.
 */
export function withoutExcludedOperations(text: string, excludedPaths: readonly string[]): { text: string; removed: string[] } | { refused: string } {
    const prefixes = excludedPaths.filter(Boolean);
    if (!prefixes.length) return { text, removed: [] };
    let doc: { paths?: Record<string, unknown>; servers?: Array<{ url?: unknown }>; basePath?: unknown } | null = null;
    try {
        doc = JSON.parse(stripBom(text));
    } catch {
        try {
            doc = parseYaml(stripBom(text)) as typeof doc;
        } catch {
            doc = null;
        }
    }
    if (!doc || typeof doc !== "object" || !doc.paths || typeof doc.paths !== "object")
        return { refused: "The API document could not be read, so the excluded paths could not be taken out of it: Schemathesis was not run." };
    const base = documentBasePath(doc);
    const removed: string[] = [];
    const paths: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc.paths)) {
        const full = `${base}${key.startsWith("/") ? "" : "/"}${key}`;
        if (prefixes.some((pre) => underPrefix(key, pre) || underPrefix(full, pre))) removed.push(key);
        else paths[key] = value;
    }
    return { text: JSON.stringify({ ...doc, paths }), removed };
}

/** `--exclude-path-regex` for each excluded prefix: the same rule again, inside Schemathesis. */
export function excludePathArgs(excludedPaths: readonly string[]): string[] {
    return excludedPaths.filter(Boolean).flatMap((pre) => ["--exclude-path-regex", `^${escapeRegex(pre.endsWith("/") ? pre.slice(0, -1) : pre)}(/|$)`]);
}

/** The environment variable that carries a saved sign-in's header value into the config file; the value itself never is in a file or an argument. */
export const AUTH_ENV = "AITP_SCAN_AUTH_VALUE";
/** The config file for a signed-in run: the header's name, and its value as an environment placeholder (Schemathesis `${VAR}`). */
export function authConfigToml(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9-]/g, "");
    return `headers = { "${safe}" = "\${${AUTH_ENV}}" }\n`;
}

export interface SchemathesisAdapterOptions {
    settings: ScannerSettings;
    /** Overridable for tests. Never takes a path from a request. */
    resolve?: typeof resolveExecutable;
    run?: typeof runProcess;
    now?: () => Date;
    /** For tests: read the two report files back. */
    readFile?: (file: string) => Promise<string>;
}

const versionOf = (stdout: string): string | undefined => {
    const m = /(\d+\.\d+\.\d+)/.exec(String(stdout ?? ""));
    return m ? m[1] : undefined;
};

/** The path (and query) of an address, without its scheme or host. */
export function pathOf(url: string): string {
    try {
        const u = new URL(url);
        return `${u.pathname}${u.search}`;
    } catch {
        return String(url ?? "");
    }
}

/** The document text, stripped of a byte-order mark. Schemathesis refuses to load a schema that starts with one. */
export function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Which checks may run at a profile. `advanced` adds the checks that need two identities or that send deliberately invalid data. */
export function checksFor(profile: ScanIntensity): string[] {
    return profile === "advanced" ? [...REVIEWED_CHECKS, ...ADVANCED_ONLY_CHECKS] : [...REVIEWED_CHECKS];
}

/** The methods a run may generate: the safe ones only, at every profile (no profile changes data). */
export function methodsFor(_profile: ScanIntensity): string[] {
    return [...SAFE_METHODS];
}

/** The child environment Schemathesis needs on Windows, plus nothing else: the platform's own secrets are not inherited. */
export function schemathesisEnv(extra: Record<string, string> = {}): Record<string, string> {
    return { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONIOENCODING_ERRORS: "strict", ...extra };
}

/** One failure as Schemathesis records it, read out of its NDJSON report. */
export interface SchemathesisFailure {
    check: string;
    code: string;
    title: string;
    severity: string;
    message: string;
    method: string;
    path: string;
    statusCode?: number;
    responseExcerpt?: string;
}

interface NdjsonScenario {
    phase?: string;
    status?: string;
    skip_reason?: string;
    recorder?: {
        label?: string;
        checks?: Record<string, Array<{ name?: string; status?: string; failure_info?: { failure?: Record<string, unknown> } }>>;
        interactions?: Record<string, { request?: { method?: string; uri?: string }; response?: { status_code?: number; content?: { $base64?: string } | string } }>;
        cases?: Record<string, { value?: { method?: string; path?: string } }>;
    };
}

/** Parse one line of the NDJSON report. Returns the failed checks it records, or nothing for a passing/skipped scenario. */
export function parseSchemathesisNdjson(text: string): { failures: SchemathesisFailure[]; tested: number; skipped: number; phases: Set<string>; operations: Set<string> } {
    const failures: SchemathesisFailure[] = [];
    const phases = new Set<string>();
    const operations = new Set<string>();
    let tested = 0;
    let skipped = 0;
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let parsed: { ScenarioFinished?: NdjsonScenario };
        try {
            parsed = JSON.parse(trimmed) as { ScenarioFinished?: NdjsonScenario };
        } catch {
            continue;
        }
        const scenario = parsed.ScenarioFinished;
        if (!scenario) continue;
        if (scenario.phase) phases.add(scenario.phase);
        if (scenario.status === "skip") {
            skipped++;
            continue;
        }
        // The label is read for EVERY exercised scenario, not only for the failing ones. Reading it only inside the failure branch made a
        // clean run report "0 operations" - and a clean run is the common one, a document that matches the API it describes. A coverage
        // line that understates what was actually tested is worse than no coverage line at all.
        const recorder = scenario.recorder ?? {};
        if (recorder.label) operations.add(String(recorder.label));
        if (scenario.status !== "failure") {
            if (scenario.status) tested++;
            continue;
        }
        const interactions = recorder.interactions ?? {};
        for (const checks of Object.values(recorder.checks ?? {})) {
            for (const check of checks) {
                if (check?.status !== "failure") continue;
                const failure = (check.failure_info?.failure ?? {}) as Record<string, unknown>;
                const caseId = String(failure.case_id ?? "");
                // Schemathesis records the failing check without always filling in `case_id`, so the matching interaction is found by
                // key when there is one and by being the only one when there is not. Without this fallback a real report parses
                // without the status code and the request that produced it.
                const interaction = (caseId ? interactions[caseId] : undefined) ?? Object.values(interactions)[0];
                const label = String(recorder.label ?? "");
                const [methodFromLabel, pathFromLabel] = label.split(" ", 2);
                const uri = String(interaction?.request?.uri ?? "");
                failures.push({
                    check: String(check.name ?? "check"),
                    code: String(failure.code ?? ""),
                    title: String(failure.title ?? "Schemathesis check failed"),
                    severity: String(failure.severity ?? "unknown"),
                    message: String(failure.message ?? ""),
                    method: String(interaction?.request?.method ?? (recorder.cases?.[caseId]?.value?.method ?? methodFromLabel ?? "GET")),
                    // Only the path, never the whole URI: the finding's address is rebuilt from the origin the scope guard checked, so a
                    // report can never carry a host the scan was not authorized for.
                    path: uri ? pathOf(uri) : String(recorder.cases?.[caseId]?.value?.path ?? pathFromLabel ?? ""),
                    ...(typeof interaction?.response?.status_code === "number" ? { statusCode: interaction.response.status_code } : {}),
                });
                tested++;
            }
        }
    }
    return { failures, tested, skipped, phases, operations };
}

/** The base64 response body Schemathesis keeps in its NDJSON, as readable text (never stored whole). */
function responseExcerpt(content: { $base64?: string } | string | undefined): string | undefined {
    if (!content) return undefined;
    try {
        if (typeof content === "string") return content.slice(0, 1_000);
        if (typeof content.$base64 === "string") return Buffer.from(content.$base64, "base64").toString("utf8").slice(0, 1_000);
    } catch {
        /* an unreadable body is not a reason to lose the failure */
    }
    return undefined;
}

/** One Schemathesis failure as a platform finding. The tool's own code, title, message and evidence are kept for review. */
export function schemathesisFailureToFinding(f: SchemathesisFailure, baseUrl: string): ScannerFinding {
    // A path from the tool is joined onto the origin the scope guard checked; an address that already is absolute is used as it is,
    // because doubling an origin onto a full address is how a report ends up pointing somewhere nobody scanned.
    const url = /^https?:\/\//i.test(f.path) ? f.path : f.path ? `${baseUrl.replace(/\/+$/, "")}${f.path.startsWith("/") ? "" : "/"}${f.path}` : baseUrl;
    const excerpt = responseExcerpt(undefined);
    const evidence = [
        { kind: "note" as const, label: "What Schemathesis found", value: `${f.title}${f.code ? ` (${f.code})` : ""}${f.message ? `\n${f.message.slice(0, 1_200)}` : ""}` },
        ...(f.statusCode !== undefined ? [{ kind: "status" as const, label: "Status returned", value: String(f.statusCode) }] : []),
        { kind: "note" as const, label: "Check", value: `${f.check} on ${f.method} ${f.path || "(the document's base path)"}` },
        ...(excerpt ? [{ kind: "body-excerpt" as const, label: "Answer", value: excerpt }] : []),
    ].slice(0, MAX_SCANNER_EVIDENCE);
    return {
        scannerRuleId: `schemathesis:${f.code || f.check}`,
        title: f.title,
        // Schemathesis already rates severity; an unreadable rating is treated as info, never as more serious.
        severity: severityOf(f.severity),
        category: categoryFor({ scannerRuleId: f.code || f.check, title: `${f.title} ${f.check}` }),
        url,
        description: `Schemathesis's "${f.check}" check reported: ${f.message.split("\n")[0] || f.title}.`,
        evidence,
        confidence: "medium",
    };
}

/** Coverage in plain words. A contract mismatch is evidence to investigate, not a confirmed vulnerability. */
export function schemathesisCoverage(input: { operations: number; tested: number; skipped: number; methods: string[]; findings: number; checksLeftOut?: string[]; operationsRemoved?: number; version?: string }): ScanResultSet["coverage"] {
    const advanced = input.methods.some((m) => (STATE_CHANGING_METHODS as readonly string[]).includes(m));
    return {
        inspected: [
            `Schemathesis read the API document and generated test data from it for ${input.operations} operation${input.operations === 1 ? "" : "s"}${advanced ? ", including the ones that change data" : ", limited to the methods that cannot change data"}.`,
            `Its checks ran over ${input.tested} test case${input.tested === 1 ? "" : "s"} and ${input.findings} answer${input.findings === 1 ? "" : "s"} did not match the document.`,
        ],
        notInspected: [
            "Schemathesis only tests operations the document describes. An endpoint that is missing from the document is never reached, so this is not a complete inventory of the API.",
            ...(advanced ? [] : [`Operations that change data (${STATE_CHANGING_METHODS.join(", ")}) were skipped, as at every profile: no request it sent was meant to create, update or delete anything.`]),
            ...(input.skipped ? [`${input.skipped} operation${input.skipped === 1 ? " was" : "s were"} skipped because the document gave no usable example for ${input.skipped === 1 ? "it" : "them"}.`] : []),
            "A mismatch between the document and the answer is a contradiction to investigate. It is not by itself a security vulnerability, and the platform does not mark it confirmed.",
            "Schemathesis does not look for broken access control between two different users unless an approved advanced profile with two test identities is used.",
            ...(input.checksLeftOut?.length ? [`These checks were left out because the installed Schemathesis${input.version ? ` (${input.version})` : ""} does not have them yet: ${input.checksLeftOut.join(", ")}.`] : []),
            ...(input.operationsRemoved ? [`${input.operationsRemoved} operation${input.operationsRemoved === 1 ? " was" : "s were"} taken out of the document before the run because ${input.operationsRemoved === 1 ? "it is" : "they are"} under an excluded path or a sensitive workflow.`] : []),
        ],
    };
}

/** The document's own base path (OpenAPI `servers[0].url`, Swagger `basePath`), without a trailing slash; "" when it has none. */
export function documentBasePath(doc: { servers?: unknown; basePath?: unknown } | null | undefined): string {
    try {
        const first = Array.isArray(doc?.servers) ? (doc.servers[0] as { url?: unknown } | undefined)?.url : undefined;
        if (typeof first === "string") return new URL(first, "http://placeholder.invalid").pathname.replace(/\/+$/, "");
        if (typeof doc?.basePath === "string") return doc.basePath.replace(/\/+$/, "");
    } catch {
        /* no usable base path */
    }
    return "";
}

/** The address Schemathesis is given (`--url`): the checked origin plus the document's own base path, so /v1 is not lost. */
export function apiBaseUrl(text: string, origin: string): string {
    let doc: { servers?: unknown; basePath?: unknown } | null = null;
    try {
        doc = JSON.parse(stripBom(text));
    } catch {
        try {
            doc = parseYaml(stripBom(text)) as typeof doc;
        } catch {
            doc = null;
        }
    }
    return `${origin.replace(/\/+$/, "")}${documentBasePath(doc && typeof doc === "object" ? doc : null)}`;
}

/** The specification, with its own `servers` entry pointed at the origin the scope guard already checked, keeping its base path. */
export function rewriteServers(text: string, origin: string): string {
    try {
        const doc = JSON.parse(stripBom(text)) as { servers?: unknown[]; host?: string; basePath?: string; schemes?: string[] };
        if (Array.isArray(doc.servers)) {
            doc.servers = [{ url: apiBaseUrl(text, origin) }];
            return JSON.stringify(doc);
        }
        return text;
    } catch {
        // A YAML or Swagger 2.0 document is handed over as it is; the --url flag is what Schemathesis uses in that case.
        return stripBom(text);
    }
}

export class SchemathesisAdapter implements ScannerAdapter {
    readonly id = "schemathesis" as const;
    readonly name = "Schemathesis";
    readonly documentationUrl = "https://github.com/schemathesis/schemathesis";
    readonly description =
        "Schema-driven API validation: it generates test data from the client's own API document and reports where an answer contradicts it. Installed separately; only used when an administrator names it in SECURITY_SCANNERS.";
    readonly capabilities = { progress: true, cancel: true, sharedDaemon: false, specDriven: true, aiDriven: false, egressProxy: true, egressIsolation: true };

    private readonly settings: ScannerSettings;
    private readonly resolve: typeof resolveExecutable;
    private readonly run: typeof runProcess;
    private readonly readFile: (file: string) => Promise<string>;
    private readonly now: () => Date;

    constructor(options: SchemathesisAdapterOptions) {
        this.settings = options.settings;
        this.resolve = options.resolve ?? resolveExecutable;
        this.run = options.run ?? runProcess;
        this.readFile = options.readFile ?? ((file: string) => fs.readFile(file, "utf8"));
        this.now = options.now ?? (() => new Date());
    }

    private binary(): string | undefined {
        return this.resolve("schemathesis", this.settings.schemathesis.path, this.settings.binDirs);
    }

    async available(signal?: AbortSignal): Promise<ScannerAvailability> {
        const at = this.now().toISOString();
        if (!isSwitchedOn(this.settings, this.id)) return { scanner: this.id, state: "not_configured", checkedAt: at, ...notEnabledReason(this.id) };
        const file = this.binary();
        if (!file)
            return {
                scanner: this.id,
                state: "unavailable",
                checkedAt: at,
                ...notInstalledReason("Schemathesis", "SECURITY_SCHEMATHESIS_PATH", "Install it with `pip install schemathesis` (a Python tool), then point SECURITY_SCHEMATHESIS_PATH at the schemathesis command."),
            };
        const startedAt = Date.now();
        try {
            const out = await this.run({ file, args: ["--version"], timeoutMs: 60_000, signal, maxOutputBytes: 64 * 1024, env: schemathesisEnv() });
            const version = versionOf(out.stdout + out.stderr);
            if (!version)
                return {
                    scanner: this.id,
                    state: "unknown",
                    checkedAt: at,
                    reason: `The Schemathesis command at ${path.basename(file)} answered, but its version could not be read.`,
                    remedy: "Check that the configured path is the schemathesis command and not another program.",
                    tookMs: Date.now() - startedAt,
                };
            return { scanner: this.id, state: "available", version, checkedAt: at, tookMs: Date.now() - startedAt };
        } catch (e) {
            return {
                scanner: this.id,
                state: "unknown",
                checkedAt: at,
                reason: `Schemathesis could not be started: ${(e as Error).message.split("\n")[0]}.`,
                remedy: "Check that Python is installed, that the platform may run the command, and that its runtime is not locked.",
                tookMs: Date.now() - startedAt,
            };
        }
    }

    async validateConfig(): Promise<ConfigCheck> {
        const problems: string[] = [];
        const checked: string[] = [];
        if (!isSwitchedOn(this.settings, this.id)) problems.push(notEnabledReason(this.id).reason);
        const file = this.binary();
        if (file) checked.push(`Schemathesis command found (${path.basename(file)}).`);
        else problems.push(notInstalledReason("Schemathesis", "SECURITY_SCHEMATHESIS_PATH", "Install it with `pip install schemathesis`.").reason);
        if (file) {
            try {
                const out = await this.run({ file, args: ["--version"], timeoutMs: 60_000, maxOutputBytes: 64 * 1024, env: schemathesisEnv() });
                checked.push(`The command answered: Schemathesis ${versionOf(out.stdout + out.stderr) ?? "an unreadable version"}.`);
            } catch (e) {
                problems.push(`The Schemathesis command could not be started: ${(e as Error).message.split("\n")[0]}`);
            }
        }
        return { ok: problems.length === 0, problems, checked };
    }

    supports(profile: ScanIntensity): boolean {
        // Every profile uses Schemathesis; which methods and checks run is decided by methodsFor/checksFor and the approval rules.
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
                refused.push({ url, code: "unsupported-scheme", reason: "It is not an address this scanner can request." });
                continue;
            }
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                refused.push({ url, code: "unsupported-scheme", reason: `Schemathesis requests http and https only, and this is ${parsed.protocol}` });
                continue;
            }
            if (parsed.origin !== target.origin) {
                refused.push({ url, code: "out-of-scope", reason: "Schemathesis runs against one base address; this one is on a different origin." });
                continue;
            }
            if (target.excludedPaths.some((prefix) => prefix && parsed.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) {
                refused.push({ url, code: "excluded-path", reason: "It is under an excluded path or a sensitive workflow." });
                continue;
            }
            allowed.push(url);
        }
        if (!allowed.length) return { ok: false, allowed, refused: [...refused, { url: target.origin, code: "no-targets", reason: "No in-scope address is left for Schemathesis to test." }] };
        return { ok: true, allowed, refused };
    }

    async start(target: ScanTarget, profile: ScanIntensity, options: StartOptions): Promise<ScanHandle> {
        if (!this.supports(profile)) throw new ScannerError("profile_unsupported", this.id, `Schemathesis is not used at the ${profile} profile.`);
        const file = this.binary();
        if (!file) throw new ScannerError("unavailable", this.id, "Schemathesis is not installed on this machine.", notInstalledReason("Schemathesis", "SECURITY_SCHEMATHESIS_PATH", "").remedy);
        if (!target.spec?.text) throw new ScannerError("not_configured", this.id, "No API document is available for this application.", "Upload an OpenAPI or Swagger document to the application, or point apiSpecUrl at the document the API publishes. Schemathesis cannot test an API it has no document for.");

        const scope = await this.validateScope(target);
        if (!scope.ok) throw new ScannerError("out_of_scope", this.id, "None of the addresses for this scan may be tested by Schemathesis.", scope.refused.map((r) => `${r.url}: ${r.reason}`).join("; "));

        // The advanced profile's extra checks need the Crowd4Test admin's approval recorded for this environment. It still never sends a
        // state-changing method (methodsFor).
        if (profile === "advanced" && !options.approval)
            throw new ScannerError("profile_unsupported", this.id, "The advanced profile needs a recorded approval.", "Run the assessment at a conservative profile, or have a Crowd4Test admin approve the advanced profile for a development or staging application first.");
        if (options.approval && options.approval.profile !== profile)
            throw new ScannerError("invalid_config", this.id, "The recorded approval is for a different profile than this run.", `The approval covers ${options.approval.profile}; this run is ${profile}.`);

        const methods = methodsFor(profile);
        // The installed version decides which check names the CLI knows: one unknown name would refuse the whole run.
        let version: string | undefined;
        try {
            const v = await this.run({ file, args: ["--version"], timeoutMs: 60_000, signal: options.signal, maxOutputBytes: 64 * 1024, env: schemathesisEnv() });
            version = versionOf(v.stdout + v.stderr);
        } catch {
            version = undefined;
        }
        if (version && !versionAtLeast(version, SCHEMATHESIS_MIN_VERSION))
            throw new ScannerError("unavailable", this.id, `Schemathesis ${version} is older than ${SCHEMATHESIS_MIN_VERSION}, which this platform needs.`, "Install a current Schemathesis 4 (`pip install --upgrade schemathesis`).");
        const { checks, leftOut } = checksForVersion(profile, version);
        // No operation under an excluded path or a sensitive workflow may be in the document Schemathesis generates requests from.
        const filtered = withoutExcludedOperations(stripBom(target.spec.text), target.excludedPaths);
        if ("refused" in filtered) throw new ScannerError("invalid_config", this.id, filtered.refused, "Upload the API document as OpenAPI or Swagger JSON or YAML.");
        const auth = target.authHeader?.name && target.authHeader.value ? target.authHeader : null;
        let temp: SecureTempDir | undefined;
        try {
            temp = await withSecureTempDir("schemathesis");
            const specFile = await temp.write("schema.json", rewriteServers(filtered.text, target.origin));
            const configFile = auth ? await temp.write("schemathesis.toml", authConfigToml(auth.name)) : undefined;
            const ndjsonFile = path.join(temp.dir, "report.ndjson");
            const jsonFile = path.join(temp.dir, "report.json");

            const rate = Math.max(1, Math.min(this.settings.maxRequestsPerSecond, target.maxRequestsPerSecond));
            // Schemathesis is told to stop BEFORE the timer that kills the process would fire. Given the same number it is killed at the
            // instant its own budget expires, never gets to write its report, and the run is recorded as "did not finish" instead of
            // carrying the findings it already had (verified against schemathesis 4.32.4, which needs the last seconds to write out).
            const seconds = Math.max(10, Math.round((target.timeoutMs / 1000) * 0.8));
            const args = [
                "run",
                specFile,
                "--url",
                apiBaseUrl(filtered.text, target.origin),
                "--checks",
                checks.join(","),
                "--mode",
                "positive",
                "--max-examples",
                String(SCHEMATHESIS_MAX_EXAMPLES),
                "--workers",
                "1",
                "--rate-limit",
                `${rate * 60}/m`,
                "--no-shrink",
                // NO --generation-deterministic, on purpose. In deterministic mode schemathesis ignores --max-time and runs every case it
                // can generate (verified on 4.32.4: asked for 144 seconds it ran 180 and was still going). A tool that will not stop at its
                // deadline cannot be cancelled either, and this platform promises both. Runs are therefore not bit-for-bit repeatable;
                // the time limit and the stop button are worth more than a fixed seed.
                "--output-sanitize",
                "true",
                "--max-time",
                String(seconds),
                "--report",
                "ndjson,json",
                "--report-ndjson-path",
                ndjsonFile,
                "--report-json-path",
                jsonFile,
                // The safe-method gate: without it state-changing operations would be generated too.
                ...methods.map((m) => ["--include-method", m]).flat(),
                ...excludePathArgs(target.excludedPaths),
                // The platform's request guard, when the run has one (schemathesis 4 `--proxy`, plus the proxy environment below).
                ...(target.egress ? ["--proxy", target.egress.proxyUrl] : []),
            ];
            // `--config-file` belongs to the top-level command, before `run`.
            if (configFile) args.unshift("--config-file", configFile);

            const findings: ScannerFinding[] = [];
            let finished = false;
            let percent = 0;
            const message = "Schemathesis is reading the API document.";

            // Above passive the run has an isolated network whose only way out is the request guard: Schemathesis is started inside it.
            const cmd = isolationFor(target)?.wrap(file, args) ?? { file, args };
            const runPromise = this.run({
                file: cmd.file,
                args: cmd.args,
                // Schemathesis writes a `.schemathesis` cache directory into its working directory and offers no environment variable to
                // move it (DEFAULT_ROOT = Path(".schemathesis") in schemathesis/core/storage.py). Run it inside the run's own temporary
                // directory so a scan never drops a cache folder into whatever directory the platform happened to be started in.
                cwd: temp.dir,
                env: schemathesisEnv({ ...(auth ? { [AUTH_ENV]: auth.value } : {}), ...(target.egress ? egressEnv(target.egress.proxyUrl) : {}) }),
                signal: options.signal,
                timeoutMs: target.timeoutMs,
                maxOutputBytes: 8 * 1024 * 1024,
                onStdoutLine: (line) => {
                    const m = /(\d+)%\s*\|/.exec(line) ?? /(\d+)%/.exec(line);
                    if (m) percent = Math.max(0, Math.min(99, Number(m[1])));
                    options.onProgress?.({ percent, message: `Schemathesis is validating the API against its document (${percent}%).`, done: false });
                },
            });
            options.onProgress?.({ percent: 0, message, done: false });
            options.log?.("started", { scanner: this.id, profile, version: version ?? "unknown", checks: checks.length, checksLeftOut: leftOut, methods: methods.length, rate, operationsRemoved: filtered.removed.length, signedIn: Boolean(auth) });

            let outcome: Awaited<typeof runPromise>;
            try {
                outcome = await runPromise;
            } catch (e) {
                finished = true;
                throw new ScannerError("tool_failed", this.id, "Schemathesis could not be started.", (e as Error).message.split("\n")[0]);
            }
            finished = true;

            const ndjson = await this.readFile(ndjsonFile).catch(() => "");
            const parsed = parseSchemathesisNdjson(ndjson);
            // Schemathesis reports the SAME contract mismatch once per generated test case: one wrong response shape can be reported
            // thousands of times in a single run. They are folded here, on rule + address, so a run reports what it found rather than how
            // many times it happened to ask. The count of folded repeats is reported in the coverage text below.
            const seen = new Map<string, SchemathesisFailure>();
            for (const failure of parsed.failures) {
                const key = `${failure.code || failure.check}|${failure.method} ${failure.path}`;
                const first = seen.get(key);
                if (!first) seen.set(key, failure);
            }
            let repeats = 0;
            for (const failure of seen.values()) {
                findings.push(schemathesisFailureToFinding(failure, target.origin));
                repeats += parsed.failures.filter((f) => `${f.code || f.check}|${f.method} ${f.path}` === `${failure.code || failure.check}|${failure.method} ${failure.path}`).length - 1;
            }

            // Schemathesis exits 1 when it found a contract mismatch, which is a result, not a failure of the tool.
            //
            // Reaching the time limit, or being cancelled, is not a failure of the tool either. It writes its NDJSON report as it goes,
            // so a run stopped at the limit still carries everything it had checked by then, and a document that really does match its
            // API legitimately reports nothing at all. Calling either an error threw away a complete report and recorded the run as
            // "did not finish" every time - which, on a well-formed API, is every single run. Only a real crash (an exit code that is
            // neither 0 nor 1) or a stop with nothing whatsoever in the report is a failure.
            const crashed = !outcome.stopped && outcome.code !== 0 && outcome.code !== 1;
            const reported = findings.length > 0 || parsed.tested > 0 || parsed.operations.size > 0;
            if (crashed || (outcome.stopped && !reported)) {
                const reason = outcome.stopped ? (outcome.stopReason === "timeout" ? "The time limit was reached." : "The run was stopped.") : `The command exited with code ${outcome.code}.`;
                throw new ScannerError(outcome.stopReason === "timeout" ? "timeout" : "tool_failed", this.id, `Schemathesis did not finish. ${reason}`, (outcome.stderr || outcome.stdout).slice(-500));
            }

            // The operation list comes from the NDJSON rather than the JSON summary: the NDJSON is the file this adapter has always
            // proved it can read, and counting the distinct operations it actually exercised cannot report zero for a run that tested.
            const operations = parsed.operations.size;

            const coverage = schemathesisCoverage({ operations, tested: parsed.tested, skipped: parsed.skipped, methods, findings: findings.length, checksLeftOut: leftOut, operationsRemoved: filtered.removed.length, ...(version ? { version } : {}) });
            if (outcome.stopped)
                coverage.notInspected.push(
                    outcome.stopReason === "timeout"
                        ? "The run reached the time limit and was stopped there. Everything it had checked by then is reported above; nothing after that point was tested."
                        : "The run was stopped before Schemathesis finished, so it covers only what it had checked at that moment.",
                );
            if (repeats > 0) coverage.notInspected.push(`${repeats} repeat${repeats === 1 ? "" : "s"} of the same mismatch on the same operation were folded into the finding above; Schemathesis reports a mismatch once per test case it generated.`);
            options.onProgress?.({ percent: 100, message: `Schemathesis finished: ${findings.length} answer${findings.length === 1 ? "" : "s"} did not match the document.`, done: true });

            return {
                scanner: this.id,
                reference: `schemathesis-${target.applicationId}`,
                progress: async () => ({ percent: finished ? 100 : percent, message: finished ? "Finished." : "Schemathesis is validating the API against its document.", done: finished }),
                cancel: async () => undefined,
                results: async () => ({ findings, coverage, reference: `schemathesis-${target.applicationId}` }),
                cleanup: async () => {
                    await temp?.remove().catch(() => undefined);
                },
            };
        } catch (e) {
            await temp?.remove().catch(() => undefined);
            throw e;
        }
    }
}
