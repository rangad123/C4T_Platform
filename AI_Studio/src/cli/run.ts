import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import type { RunArgs } from "./args.js";
import { ApiCallError, remoteClient, type ApiClient } from "./client.js";
import { collectEnvironmentTests } from "./environment.js";
import { InfraError, UsageError, EXIT } from "./errors.js";
import { postStickyComment, prFromEvent } from "./github-comment.js";
import type { LocalPlatform } from "./local.js";
import { collectTests, evaluateGate, REPORT_SCHEMA_VERSION, summarize, type CiReport, type CiTest } from "./model.js";
import { renderConsole, renderHtml, renderJson, renderJunit, renderMarkdown, renderSarif } from "./render.js";

export interface Io {
    env: NodeJS.ProcessEnv;
    out(line: string): void;
    err(line: string): void;
}

const TERMINAL = new Set(["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function version(): string {
    try {
        return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

/** Values that must never be printed or written: the app's credentials, the platform key, the GitHub token. */
class Secrets {
    private readonly values = new Set<string>();
    add(v: string | undefined): string | undefined {
        if (v && v.length >= 4) this.values.add(v);
        return v;
    }
    redact(text: string): string {
        let out = text;
        for (const v of this.values) out = out.split(v).join("***");
        return out;
    }
}

function readEnvVar(io: Io, flag: string, name: string | undefined, secrets: Secrets): string | undefined {
    if (!name) return undefined;
    const v = io.env[name];
    if (v === undefined || v === "") throw new UsageError(`--${flag} names the environment variable ${name}, but it is not set (or is empty).`);
    return secrets.add(v);
}

/** Explain a rejected spec file in terms of the file: which test, which field. */
function specProblems(e: ApiCallError): string {
    const details = e.details;
    if (Array.isArray(details)) {
        const lines = details.slice(0, 5).map((d: { index?: number; issues?: Array<{ path?: Array<string | number>; message?: string }>; path?: Array<string | number>; message?: string }) => {
            const issues = d.issues ?? [d];
            const where = d.index !== undefined ? `test ${d.index + 1} in the file` : "specs file";
            return `  ${where}: ${issues.slice(0, 2).map((i) => `${(i.path ?? []).join(".") || "(whole test)"} — ${i.message}`).join("; ")}`;
        });
        return `${e.message}:\n${lines.join("\n")}`;
    }
    return e.message;
}

export function readSpecsFile(file: string): { specs: unknown[]; text: string } {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        throw new UsageError(`Cannot read the specs file “${file}”. Create one with “ai-test export”, or from the platform’s Tests → More actions → Export tests.`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new UsageError(`“${file}” is not valid JSON.`);
    }
    const specs = Array.isArray(json) ? json : (json as { specs?: unknown })?.specs;
    if (!Array.isArray(specs) || specs.length === 0) throw new UsageError(`“${file}” should contain a list of tests (or an object with a “specs” list), and it should not be empty.`);
    return { specs, text };
}

async function waitForJob(client: ApiClient, jobId: string, timeoutS: number, pollMs: number, io: Io) {
    const started = Date.now();
    let lastStatus = "";
    for (;;) {
        const job = await client.json<{ status: string; error: string | null; counters?: Record<string, number> }>("GET", `/test-generation/${jobId}`);
        if (job.status !== lastStatus) {
            lastStatus = job.status;
            io.err(`[ai-test] ${job.status.toLowerCase().replace(/_/g, " ")}…`);
        }
        if (TERMINAL.has(job.status)) return job;
        if (Date.now() - started > timeoutS * 1000) {
            await client.json("DELETE", `/test-generation/${jobId}`).catch(() => undefined);
            throw new InfraError(`The run did not finish within ${timeoutS} seconds and was cancelled. Raise --timeout if the suite is large.`);
        }
        await sleep(pollMs);
    }
}

async function resolveProject(client: ApiClient, name: string | undefined): Promise<{ id: string; name: string; existed: boolean }> {
    const wanted = name ?? `ci-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
    if (name) {
        const all = await client.json<Array<{ id: string; name: string }>>("GET", "/projects");
        const hit = all.find((p) => p.id === name) ?? all.find((p) => p.name === name);
        if (hit) return { ...hit, existed: true };
    }
    const created = await client.json<{ id: string; name: string }>("POST", "/projects", { name: wanted });
    return { ...created, existed: false };
}

/** `ai-test run`. Returns the process exit code. Throws UsageError / InfraError for exit code 2. */
export async function runCommand(args: RunArgs, io: Io): Promise<number> {
    const started = Date.now();
    const secrets = new Secrets();

    // Credentials come from environment variables the caller names; the values are only ever sent to the app.
    const username = readEnvVar(io, "username-env", args["username-env"], secrets);
    const password = readEnvVar(io, "password-env", args["password-env"], secrets);
    const totpSecret = readEnvVar(io, "totp-secret-env", args["totp-secret-env"], secrets);
    const apiToken = readEnvVar(io, "token-env", args["token-env"], secrets);
    const apiAuthHeader = readEnvVar(io, "auth-header-env", args["auth-header-env"], secrets);
    const credentials = username || apiToken || apiAuthHeader ? { ...(username ? { username, password, ...(totpSecret ? { totpSecret } : {}) } : {}), ...(apiToken ? { apiToken } : {}), ...(apiAuthHeader ? { apiAuthHeader } : {}) } : undefined;
    const apiKey = args["api-key"] ? secrets.add(args["api-key"]) : readEnvVar(io, "api-key-env", args["api-key-env"] ?? (io.env.AI_TEST_API_KEY ? "AI_TEST_API_KEY" : undefined), secrets);

    const specsFile = args.specs ? readSpecsFile(args.specs) : undefined;
    const remote = Boolean(args.server);
    const mode: CiReport["mode"] = remote ? (args.specs ? "remote-replay" : args.analyze ? "remote-analyze" : "remote-rerun") : args.analyze ? "analyze" : "replay";

    let local: LocalPlatform | undefined;
    let report: CiReport;
    const savedEvidence: string[] = [];
    try {
        let client: ApiClient;
        if (remote) client = remoteClient(args.server!, apiKey);
        else {
            // Loaded on demand: help, usage errors and remote runs never need the whole platform.
            local = await (await import("./local.js")).startLocalPlatform({ replay: !args.analyze });
            client = local.client;
        }

        const project = await resolveProject(client, args.project);
        // --env: the platform runs the tests against that named environment (address, sign-in and variables saved there).
        const envChoice = args.env ? { environment: args.env, ...(args["confirm-production"] ? { confirmProduction: true } : {}) } : {};
        let jobId: string;
        try {
            if (specsFile) {
                const have = project.existed ? new Set((await client.json<Array<{ testId: string }>>("GET", `/projects/${project.id}/tests`)).map((t) => t.testId)) : new Set<string>();
                // A project reused across runs keeps the tests it has; only tests it does not have yet are added.
                const fresh = specsFile.specs.filter((s) => !(typeof (s as { testId?: unknown })?.testId === "string" && have.has((s as { testId: string }).testId)));
                if (fresh.length) await client.json("POST", `/projects/${project.id}/specs`, { specs: fresh, baseUrl: args.url, credentials, validate: false });
                const v = await client.json<{ jobId: string }>("POST", `/projects/${project.id}/validation`, { baseUrl: args.url, credentials, apiBaseUrl: args["api-base-url"], ...envChoice });
                jobId = v.jobId;
            } else if (args.analyze) {
                const g = await client.json<{ jobId: string }>("POST", `/projects/${project.id}/test-generation`, {
                    url: args.url,
                    credentials,
                    apiBaseUrl: args["api-base-url"],
                    maxPages: args["max-pages"],
                    maxScenarios: args["max-scenarios"],
                });
                jobId = g.jobId;
            } else {
                const v = await client.json<{ jobId: string }>("POST", `/projects/${project.id}/validation`, { baseUrl: args.url, credentials, apiBaseUrl: args["api-base-url"], ...envChoice });
                jobId = v.jobId;
            }
        } catch (e) {
            if (e instanceof ApiCallError) {
                if (e.status === 400 && specsFile) throw new InfraError(`The platform rejected the tests in ${args.specs}: ${specProblems(e)}`);
                throw new InfraError(`The platform refused the request (${e.status}): ${e.message}`);
            }
            throw e;
        }

        const job = await waitForJob(client, jobId, args.timeout, remote ? 2000 : 400, io);
        if (job.status === "FAILED") throw new InfraError(`The run failed before it could produce results: ${job.error ?? "unknown error"}`);

        const collect = { files: Boolean(args["evidence-dir"]), platformUrl: remote ? args.server : undefined };
        const tests = args.env ? await collectEnvironmentTests(client, project.id, args.env, collect) : await collectTests(client, project.id, collect);
        if (tests.every((t) => t.outcome === "not_run")) throw new InfraError("No tests were executed. (Mobile tests need an emulator and are skipped by this command.)");

        if (args["evidence-dir"]) saveEvidence(tests, args["evidence-dir"], savedEvidence);

        const gate = evaluateGate(tests, args["fail-on"], args["fail-on-failed-validation"]);
        report = {
            schemaVersion: REPORT_SCHEMA_VERSION,
            tool: { name: "ai-test", version: version() },
            generatedAt: new Date().toISOString(),
            mode,
            target: args.env ? `environment “${args.env}”` : (args.url ?? "(project's saved address)"),
            ...(args.env ? { environment: args.env } : {}),
            project: { name: project.name, ...(remote ? { id: project.id } : {}) },
            durationMs: Date.now() - started,
            summary: summarize(tests),
            gate,
            tests,
        };
    } finally {
        await local?.close();
    }

    // ── outputs ────────────────────────────────────────────────────────────
    const write = (file: string, content: string) => {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, secrets.redact(content));
    };
    if (args.junit) write(args.junit, renderJunit(report));
    if (args.json) write(args.json, renderJson(report));
    if (args.html) write(args.html, renderHtml(report));
    if (args.sarif) {
        write(
            args.sarif,
            renderSarif(report, {
                specsFile: args.specs ? path.relative(process.cwd(), path.resolve(args.specs)).split(path.sep).join("/") : undefined,
                specsText: specsFile?.text,
                fingerprint: (s) => createHash("sha256").update(s).digest("hex").slice(0, 32),
            }),
        );
    }
    const markdown = renderMarkdown(report);
    if (args.markdown) write(args.markdown, markdown);
    const summaryFile = io.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) {
        try {
            fs.appendFileSync(summaryFile, secrets.redact(markdown) + "\n");
        } catch (e) {
            io.err(`[ai-test] warning: could not write the job summary: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    io.out(secrets.redact(renderConsole(report, savedEvidence)));

    if (args["github-comment"]) {
        const token = readEnvVar(io, "github-token-env", args["github-token-env"], secrets);
        const repoSlug = args["github-repo"] ?? io.env.GITHUB_REPOSITORY;
        const pr = args.pr ?? prFromEvent(io.env.GITHUB_EVENT_PATH);
        const [owner, repo] = (repoSlug ?? "").split("/");
        if (!pr) io.err("[ai-test] No pull request to comment on (this does not look like a pull request run; pass --pr to force one). Skipping the comment.");
        else if (!owner || !repo) io.err("[ai-test] warning: no repository for the pull request comment (set GITHUB_REPOSITORY or pass --github-repo). Skipping the comment.");
        else {
            const outcome = await postStickyComment({ apiUrl: args["github-api-url"] ?? io.env.GITHUB_API_URL ?? "https://api.github.com", owner, repo, pr, token: token! }, secrets.redact(renderMarkdown(report, { comment: true })));
            if (outcome.posted) io.err(`[ai-test] Pull request comment ${outcome.posted}${outcome.url ? `: ${outcome.url}` : ""}`);
            else io.err(`[ai-test] warning: ${outcome.warning}`);
        }
    }

    return report.gate.exitCode === 0 ? EXIT.OK : EXIT.GATE_FAILED;
}

const EXT: Record<string, string> = { screenshot: "png", "visual-diff": "png", "visual-actual": "png", "vision-shot": "jpg", video: "webm", trace: "zip" };

/** Write evidence files next to the reports and refer to them by relative name. Large files are not kept in memory afterwards. */
function saveEvidence(tests: CiTest[], dir: string, saved: string[]): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const t of tests) {
        const seen = new Map<string, number>();
        for (const e of t.evidence) {
            if (!e.data) continue;
            const n = (seen.get(e.kind) ?? 0) + 1;
            seen.set(e.kind, n);
            const name = `${t.testId}-${e.kind}${n > 1 ? `-${n}` : ""}.${EXT[e.kind] ?? "bin"}`;
            fs.writeFileSync(path.join(dir, name), e.data);
            e.file = name;
            saved.push(name);
            if (e.kind === "video" || e.kind === "trace") delete e.data;
        }
    }
}
