/**
 * The Nuclei adapter (https://github.com/projectdiscovery/nuclei), driving an independently installed `nuclei` binary.
 *
 * How it is driven: `nuclei -jsonl -silent -t <the selected template files> -l <the scope-checked targets> -rl <rate> -c <concurrency>
 * -timeout <s> -retries <n> -duc -nc -ni`, with the target list and the template list written to a secure temporary directory that is
 * removed whatever happens.
 *
 * What it deliberately does NOT do:
 *   - It never runs a template from anywhere but the directory the administrator configured, and never runs one whose tags or
 *     severity the reviewed policy refuses (./policy.ts). A template id can only ever narrow that set, never widen it.
 *   - It never lets anybody supply a command, a flag or a path at run time. The argument list here is the whole argument list.
 *   - It never lets the scan reach an address outside the scope the platform already checked: the targets come from `ScanTarget.urls`,
 *     which src/security/scope.ts resolved and refused where needed, and excluded paths are filtered again here.
 *   - It disables interactsh (`-ni`). An out-of-band callback would send the target's data to a third party's server, which is outside
 *     the authorized scope; a scan must not do that.
 *   - It never marks anything confirmed. Findings arrive as scanner results and start `probable` or `needs-review`.
 *
 * Availability and version come from the binary itself (`nuclei -version`), never from a guess. When the binary is missing the adapter
 * says `unavailable` and names the install; when it is installed but no directory or no target is configured it says
 * `not_configured`. Neither ever produces findings.
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ScannerError, type ConfigCheck, type ScanHandle, type ScanIntensity, type ScanResultSet, type ScannerAdapter, type ScannerAvailability, type ScannerFinding, type ScannerScopeCheck, type ScanTarget, type StartOptions } from "../contract.js";
import { hasFilesIn, notConfiguredReason, notInstalledReason, resolveExecutable } from "../binaries.js";
import { isDirectory, runProcess, withSecureTempDir, type SecureTempDir } from "../process.js";
import { isSwitchedOn, notEnabledReason, type ScannerSettings } from "../settings.js";
import { categoryFor, severityOf } from "../normalize.js";
import { MAX_SCANNER_EVIDENCE } from "../normalize.js";
import { MAX_TEMPLATES_PER_RUN, concurrencyFor, rateFor, templateAllowed, type TemplateFacts } from "./policy.js";

/** How much of a template's own request and response is kept as evidence, before redaction. */
export const MAX_RAW_EVIDENCE = 1_500;

export interface NucleiAdapterOptions {
    settings: ScannerSettings;
    /** Overridable for tests: how the binary is found. Never takes a path from a request. */
    resolve?: typeof resolveExecutable;
    /** Overridable for tests: how the process is run. */
    run?: typeof runProcess;
    now?: () => Date;
}

const versionOf = (stdout: string): string | undefined => {
    const m = /v?(\d+\.\d+\.\d+)/.exec(String(stdout ?? ""));
    return m ? `v${m[1]}` : undefined;
};

/** One template's own `id`, `severity` and `tags`, read from the file the administrator installed. Never executed, only read. */
export async function readTemplateFacts(file: string): Promise<TemplateFacts | undefined> {
    try {
        const text = await fs.readFile(file, "utf8");
        const doc = (parseYaml(text) ?? {}) as { id?: unknown; info?: { severity?: unknown; tags?: unknown } };
        const id = typeof doc.id === "string" ? doc.id.trim() : "";
        if (!id) return undefined;
        const raw = doc.info?.tags;
        const tags = Array.isArray(raw) ? raw.map((t) => String(t)) : typeof raw === "string" ? raw.split(",").map((t) => t.trim()) : [];
        return { id, severity: String(doc.info?.severity ?? "info").toLowerCase(), tags, path: file };
    } catch {
        return undefined;
    }
}

/** Every template file in a directory, one level deep and in `.yaml` subdirectories, sorted so a run is reproducible. */
export async function listTemplateFiles(dir: string, limit = MAX_TEMPLATES_PER_RUN * 4): Promise<string[]> {
    const out: string[] = [];
    const walk = async (current: string, depth: number) => {
        if (out.length >= limit || depth > 3) return;
        let entries: Dirent[];
        try {
            entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= limit) return;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) await walk(full, depth + 1);
            else if (/\.(ya?ml)$/i.test(entry.name) && !entry.name.startsWith(".")) out.push(full);
        }
    };
    await walk(dir, 0);
    return out;
}

export class NucleiAdapter implements ScannerAdapter {
    readonly id = "nuclei" as const;
    readonly name = "ProjectDiscovery Nuclei";
    readonly documentationUrl = "https://github.com/projectdiscovery/nuclei";
    readonly description = "Template-driven checks from a reviewed template directory. Installed separately; it is only used when an administrator names it in SECURITY_SCANNERS.";
    readonly capabilities = { progress: true, cancel: true, sharedDaemon: false, specDriven: false, aiDriven: false };

    private readonly settings: ScannerSettings;
    private readonly resolve: typeof resolveExecutable;
    private readonly run: typeof runProcess;
    private readonly now: () => Date;

    constructor(options: NucleiAdapterOptions) {
        this.settings = options.settings;
        this.resolve = options.resolve ?? resolveExecutable;
        this.run = options.run ?? runProcess;
        this.now = options.now ?? (() => new Date());
    }

    private binary(): string | undefined {
        return this.resolve("nuclei", this.settings.nuclei.path, this.settings.binDirs);
    }

    async available(signal?: AbortSignal): Promise<ScannerAvailability> {
        const at = this.now().toISOString();
        if (!isSwitchedOn(this.settings, this.id)) return { scanner: this.id, state: "not_configured", checkedAt: at, ...notEnabledReason(this.id) };
        const file = this.binary();
        if (!file) return { scanner: this.id, state: "unavailable", checkedAt: at, ...notInstalledReason("Nuclei", "SECURITY_NUCLEI_PATH", "Install it from https://github.com/projectdiscovery/nuclei/releases (the single binary is enough).") };
        const startedAt = Date.now();
        try {
            const out = await this.run({ file, args: ["-version"], timeoutMs: 20_000, signal, maxOutputBytes: 64 * 1024 });
            const version = versionOf(out.stdout + out.stderr);
            if (!version) return { scanner: this.id, state: "unknown", version: undefined, checkedAt: at, reason: `The nuclei binary at ${path.basename(file)} answered, but its version could not be read.`, remedy: "Check that the file really is the nuclei binary and not another program with the same name.", tookMs: Date.now() - startedAt };
            return { scanner: this.id, state: "available", version, checkedAt: at, tookMs: Date.now() - startedAt };
        } catch (e) {
            return { scanner: this.id, state: "unknown", checkedAt: at, reason: `The nuclei binary could not be started: ${(e as Error).message.split("\n")[0]}`, remedy: "Check that the platform may run that file, and that its directory is not locked.", tookMs: Date.now() - startedAt };
        }
    }

    async validateConfig(): Promise<ConfigCheck> {
        const problems: string[] = [];
        const checked: string[] = [];
        if (!isSwitchedOn(this.settings, this.id)) problems.push(notEnabledReason(this.id).reason);
        const file = this.binary();
        if (file) checked.push(`Nuclei binary found (${path.basename(file)}).`);
        else problems.push(notInstalledReason("Nuclei", "SECURITY_NUCLEI_PATH", "Install it from https://github.com/projectdiscovery/nuclei/releases.").reason);
        const dir = this.settings.nuclei.templatesDir;
        if (!dir) problems.push(notConfiguredReason("No Nuclei template directory is set", "SECURITY_NUCLEI_TEMPLATES").reason);
        else if (!isDirectory(dir)) problems.push(`SECURITY_NUCLEI_TEMPLATES points at ${dir}, which is not a directory.`);
        else if (!hasFilesIn(dir)) problems.push(`The template directory ${dir} has no template files in it.`);
        else checked.push(`Template directory set (${path.basename(dir)}).`);
        if (file) {
            try {
                const out = await this.run({ file, args: ["-version"], timeoutMs: 20_000, maxOutputBytes: 64 * 1024 });
                checked.push(`The binary answered: ${versionOf(out.stdout + out.stderr) ?? "an unreadable version"}.`);
            } catch (e) {
                problems.push(`The Nuclei binary could not be started: ${(e as Error).message.split("\n")[0]}`);
            }
        }
        return { ok: problems.length === 0, problems, checked };
    }

    supports(profile: ScanIntensity): boolean {
        // Nuclei has read-only and active checks alike, so every profile is allowed; which templates run is the policy's job.
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
                refused.push({ url, code: "unsupported-scheme", reason: `Nuclei requests http and https only, and this is ${parsed.protocol}` });
                continue;
            }
            if (target.excludedPaths.some((prefix) => prefix && (parsed.pathname === prefix || parsed.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)))) {
                refused.push({ url, code: "excluded-path", reason: "It is under an excluded path or a sensitive workflow." });
                continue;
            }
            allowed.push(url);
        }
        return { ok: allowed.length > 0, allowed, refused };
    }

    async start(target: ScanTarget, profile: ScanIntensity, options: StartOptions): Promise<ScanHandle> {
        if (!this.supports(profile)) throw new ScannerError("profile_unsupported", this.id, `Nuclei is not used at the ${profile} profile.`);
        const file = this.binary();
        if (!file) throw new ScannerError("unavailable", this.id, "Nuclei is not installed on this machine.", notInstalledReason("Nuclei", "SECURITY_NUCLEI_PATH", "").remedy);
        const dir = this.settings.nuclei.templatesDir;
        if (!dir || !isDirectory(dir)) throw new ScannerError("not_configured", this.id, "No Nuclei template directory is set, so no check can be selected.");

        const scope = await this.validateScope(target);
        if (!scope.ok) throw new ScannerError("out_of_scope", this.id, "None of the addresses for this scan may be requested by Nuclei.", scope.refused.map((r) => `${r.url}: ${r.reason}`).join("; "));

        const picked = await this.selectTemplates(dir, profile);
        if (!picked.selected.length)
            throw new ScannerError("not_configured", this.id, `No template in ${path.basename(dir)} may be used at the ${profile} profile.`, picked.refused.map((r) => `${r.id}: ${r.reason}`).join("; "));

        let temp: SecureTempDir | undefined;
        try {
            temp = await withSecureTempDir("nuclei");
            const listFile = await temp.write("targets.txt", `${scope.allowed.join("\n")}\n`);
            // One `-t` naming a file that lists the selected templates, rather than one `-t` per template: nuclei accepts a list file, and
            // a directory full of reviewed templates can reach MAX_TEMPLATES_PER_RUN, which would overflow the command line on Windows.
            const templateFile = await temp.write("templates.txt", `${picked.selected.map((t) => t.path).join("\n")}\n`);

            const rate = rateFor(profile, target.maxRequestsPerSecond, this.settings.maxRequestsPerSecond);
            const concurrency = concurrencyFor(profile, this.settings.nuclei.concurrency);
            const args = [
                "-jsonl",
                "-silent",
                "-nc",
                "-duc",
                "-ni",
                "-l",
                listFile,
                "-t",
                templateFile,
                "-rl",
                String(rate),
                "-c",
                String(concurrency),
                "-bs",
                String(Math.max(1, Math.min(concurrency, 5))),
                "-timeout",
                "10",
                "-retries",
                "0",
                "-sj",
                "-si",
                "2",
                ...(profile === "passive" ? ["-passive"] : []),
            ];

            const findings: ScannerFinding[] = [];
            let percent = 0;
            let message = "Nuclei is starting.";
            let finished = false;

            const runPromise = this.run({
                file,
                args,
                cwd: temp.dir,
                signal: options.signal,
                timeoutMs: target.timeoutMs,
                maxOutputBytes: 16 * 1024 * 1024,
                onStdoutLine: (line) => {
                    const parsed = parseNucleiLine(line);
                    if (!parsed) return;
                    if (parsed.kind === "stats") {
                        percent = Math.max(0, Math.min(100, Number(parsed.percent) || 0));
                        message = `Nuclei has checked ${parsed.requests} of ${parsed.total} requests across ${parsed.templates} templates.`;
                        options.onProgress?.({ percent, message, done: false });
                        return;
                    }
                    findings.push(nucleiFindingToFinding(parsed.record));
                    message = `Nuclei found ${findings.length} problem${findings.length === 1 ? "" : "s"} so far.`;
                    options.onProgress?.({ percent, message, done: false });
                },
            });
            options.onProgress?.({ percent: 0, message, done: false });
            options.log?.("started", { scanner: this.id, profile, templates: picked.selected.length, targets: scope.allowed.length, rate, concurrency });

            let outcome: Awaited<typeof runPromise>;
            try {
                outcome = await runPromise;
            } catch (e) {
                finished = true;
                throw new ScannerError("tool_failed", this.id, "Nuclei could not be started.", (e as Error).message.split("\n")[0]);
            }
            finished = true;

            if (outcome.stopReason === "cancelled" || options.signal.aborted) throw new ScannerError("cancelled", this.id, "The Nuclei scan was cancelled.");
            if (outcome.stopReason === "timeout") throw new ScannerError("timeout", this.id, `Nuclei did not finish within the ${Math.round(target.timeoutMs / 60_000)} minute limit and was stopped.`);
            if (outcome.code !== 0)
                throw new ScannerError(
                    "tool_failed",
                    this.id,
                    `Nuclei stopped with an error (exit code ${outcome.code ?? "none"}). Nothing from this run was kept as a result.`,
                    `${outcome.stderr}`.split("\n").slice(-3).join(" ").slice(0, 400),
                );
            if (outcome.truncated)
                options.log?.("output-truncated", { scanner: this.id });

            const reference = `nuclei-${this.now().toISOString()}-${picked.selected.length}t`;
            const coverage = {
                inspected: [
                    `Nuclei ran ${picked.selected.length} reviewed template${picked.selected.length === 1 ? "" : "s"} from ${path.basename(dir)} against ${scope.allowed.length} address${scope.allowed.length === 1 ? "" : "es"} in scope, at the ${profile} profile.`,
                    `It sent at most ${rate} requests a second and was limited to ${Math.round(target.timeoutMs / 60_000)} minute${target.timeoutMs < 120_000 ? "" : "s"}.`,
                ],
                notInspected: [
                    ...(picked.refused.length ? [`${picked.refused.length} template${picked.refused.length === 1 ? "" : "s"} in the template directory were not used because the platform's reviewed policy does not allow ${picked.refused.length === 1 ? "it" : "them"}: ${picked.refused.slice(0, 5).map((r) => `${r.id} (${r.reason})`).join("; ")}${picked.refused.length > 5 ? `; and ${picked.refused.length - 5} more` : ""}.`] : []),
                    ...(scope.refused.length ? [`${scope.refused.length} address${scope.refused.length === 1 ? "" : "es"} in scope were not given to Nuclei: ${scope.refused.slice(0, 3).map((r) => `${r.url} (${r.reason})`).join("; ")}${scope.refused.length > 3 ? `; and ${scope.refused.length - 3} more` : ""}.`] : []),
                    "Nuclei only reports what its selected templates match. A template that does not exist, is not installed, or does not match does not mean the application is free of that problem.",
                    "Out-of-band checks were switched off, so a problem that only shows itself by calling the scanner operator back out was not looked for.",
                ],
            };

            return {
                scanner: this.id,
                reference,
                progress: async () => ({ percent: finished ? 100 : percent, message: finished ? "Nuclei finished." : message, done: finished }),
                cancel: async () => undefined,
                results: async (): Promise<ScanResultSet> => ({ findings, coverage, reference }),
                cleanup: async () => {
                    await temp?.remove();
                },
            };
        } catch (e) {
            await temp?.remove();
            throw e;
        }
    }

    /** Read the configured directory and keep only the templates the reviewed policy allows at this profile. */
    private async selectTemplates(dir: string, profile: ScanIntensity): Promise<{ selected: TemplateFacts[]; refused: Array<TemplateFacts & { reason: string }> }> {
        const files = await listTemplateFiles(dir);
        const selected: TemplateFacts[] = [];
        const refused: Array<TemplateFacts & { reason: string }> = [];
        for (const file of files) {
            const facts = await readTemplateFacts(file);
            if (!facts) continue;
            const decision = templateAllowed(facts, profile);
            if (decision.ok) {
                if (selected.length < MAX_TEMPLATES_PER_RUN) selected.push(facts);
                else refused.push({ ...facts, reason: `more than ${MAX_TEMPLATES_PER_RUN} templates may run in one scan.` });
            } else refused.push({ ...facts, reason: decision.reason ?? "not allowed" });
        }
        return { selected, refused };
    }
}

/** One line of nuclei JSONL: either a finding or a statistics update. Anything else is ignored. */
export type NucleiLine = { kind: "finding"; record: NucleiRecord } | { kind: "stats"; percent: number; requests: number; total: number; templates: number; matched: number };

export interface NucleiRecord {
    "template-id"?: string;
    info?: { name?: string; severity?: string; tags?: string[]; reference?: unknown; classification?: { "cwe-id"?: string[] } };
    "matched-at"?: string;
    url?: string;
    host?: string;
    request?: string;
    response?: string;
    timestamp?: string;
    type?: string;
    "curl-command"?: string;
    "template-path"?: string;
}

/** Parse one JSONL line. Returns undefined for a line that is not a finding and not statistics (a banner, a warning, a blank). */
export function parseNucleiLine(line: string): NucleiLine | undefined {
    const text = line.trim();
    if (!text.startsWith("{")) return undefined;
    let json: Record<string, unknown>;
    try {
        json = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const stats = json.stats as { percent?: unknown; requests?: unknown; total?: unknown; templates?: unknown; matched?: unknown } | undefined;
    if (stats && typeof stats === "object") {
        return { kind: "stats", percent: Number(stats.percent) || 0, requests: Number(stats.requests) || 0, total: Number(stats.total) || 0, templates: Number(stats.templates) || 0, matched: Number(stats.matched) || 0 };
    }
    if (typeof json["template-id"] === "string") return { kind: "finding", record: json as NucleiRecord };
    return undefined;
}

/** The CWE ids nuclei records for a template, when it recorded any. */
export function cwesOf(record: NucleiRecord): string[] {
    const ids = record.info?.classification?.["cwe-id"];
    return Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
}

/** Nuclei's own record as a platform finding. The template's raw request and response are kept (capped) as evidence, and are
 * redacted by the findings pipeline before anything is stored. */
export function nucleiFindingToFinding(record: NucleiRecord): ScannerFinding {
    const ruleId = String(record["template-id"] ?? "nuclei-unknown");
    const name = String(record.info?.name ?? ruleId);
    const url = String(record["matched-at"] ?? record.url ?? "");
    const cwe = cwesOf(record)[0];
    const evidence = [
        { kind: "body-excerpt" as const, label: "Request nuclei sent", value: String(record.request ?? "").slice(0, MAX_RAW_EVIDENCE) },
        { kind: "body-excerpt" as const, label: "Answer the application gave", value: String(record.response ?? "").slice(0, MAX_RAW_EVIDENCE) },
        { kind: "note" as const, label: "Template", value: `${ruleId}${cwe ? ` (${cwe})` : ""}${tagsOf(record).length ? ` (tags: ${tagsOf(record).join(", ")})` : ""}` },
    ].slice(0, MAX_SCANNER_EVIDENCE);
    return {
        scannerRuleId: ruleId,
        title: name,
        severity: severityOf(record.info?.severity),
        category: categoryFor({ scannerRuleId: ruleId, title: name, cwe }),
        url,
        description: `Nuclei's template "${name}" matched at this address. Its tags: ${tagsOf(record).join(", ") || "none"}.`,
        evidence,
        references: referenceLinks(record),
        confidence: "medium",
        ...(cwe ? { cwe } : {}),
        ...(record.timestamp ? { observedAt: String(record.timestamp) } : {}),
    };
}

/** The links nuclei recorded for a template, as text. The platform never fetches them. */
function referenceLinks(record: NucleiRecord): string[] {
    const raw = record.info?.reference;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const out = list.map((r) => String(r)).filter((r) => /^https?:\/\//i.test(r));
    const cwes = cwesOf(record);
    if (cwes.length) out.push(`CWE-${cwes[0]}`);
    return out.slice(0, 5);
}

/** The tags nuclei recorded for a template, whatever shape it used for them. */
export function tagsOf(record: NucleiRecord): string[] {
    const raw = record.info?.tags;
    return Array.isArray(raw) ? raw.map(String).filter(Boolean) : typeof raw === "string" ? [raw] : [];
}
