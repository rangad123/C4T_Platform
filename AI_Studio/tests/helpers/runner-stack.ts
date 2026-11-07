/**
 * A whole runner stack for journey tests, made of real programs:
 *  - the platform (`node --import tsx src/main.ts`) on a temporary data folder, in `runners` mode (EXECUTION_MODE=runners, no
 *    embedded worker: the platform hands every run to runners) or in `local` mode (today's embedded worker; a project set to
 *    "On a runner" still sends its runs to the runner);
 *  - a stand-in application to test, whose pages can be held open so a run is caught half way;
 *  - the real runner program from source (`bin/ai-test-agent.mjs` → `src/agent`), started with an enrollment code or a token file,
 *    stopped and started again like a person closing and reopening it.
 *
 * People are made before the platform starts (local accounts with a password for the browser and a personal API token for API calls).
 * Every process is started here in its own process group and stopped by its captured PID (never by name). Both programs get a short
 * allow-listed environment: a temporary HOME, no keys of this machine, no proxy, no database address, TAQWRIGHT_HOME pointing nowhere.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, REPO_ROOT } from "../../src/config.js";
import type { Role } from "../../src/platform/auth/actor.js";
import { hashPassword } from "../../src/platform/auth/password.js";
import { bootstrap } from "../../src/platform/bootstrap.js";
import { SecretBox } from "../../src/platform/secrets.js";
import { UserStore } from "../../src/platform/user-store.js";

export type ExecutionMode = "runners" | "local";

export interface PersonSpec {
    email: string;
    name: string;
    role: Role;
    password: string;
}

export interface Person extends PersonSpec {
    id: string;
    /** A personal API token (`aitpu_…`), sent as `Authorization: Bearer`: API calls made as this person, no CSRF dance. */
    token: string;
}

export interface Answer {
    status: number;
    text: string;
    body: any;
}

export interface StackOptions {
    port: number;
    appPort: number;
    mode: ExecutionMode;
    people: Record<string, PersonSpec>;
    /** More platform settings (strings, as in the environment). */
    env?: Record<string, string>;
    /** Prefix of the temporary folders. */
    label?: string;
}

/** The real runner program, started by this helper. */
export interface AgentProcess {
    readonly pid: number;
    readonly workDir: string;
    /** Everything it printed so far (stdout and stderr). */
    output(): string;
    /** Resolves with the exit code once it has exited. */
    readonly exited: Promise<number | null>;
    running(): boolean;
    /** SIGTERM (the runner's own graceful stop), then SIGKILL to its process group after `graceMs`. */
    stop(graceMs?: number): Promise<number | null>;
}

export interface AgentStart {
    name: string;
    /** An enrollment code (`aite_…`): `--enroll <code>`. */
    enrollCode?: string;
    /** An enrollment code in a file: `--enroll-file <file>` (the runner deletes it after use). */
    enrollFile?: string;
    /** A runner token (`aitg_…`) written to a 0600 file: `--token-file <file>`. */
    token?: string;
    /** Neither: the runner uses the credential it saved at enrollment. */
    savedCredential?: boolean;
    /** The runner's work folder (default: a new one). Pass the same folder to start the same runner again. */
    workDir?: string;
    extraArgs?: string[];
    extraEnv?: Record<string, string>;
}

export interface StandInApp {
    readonly url: string;
    /** Serve this HTML at this path. */
    page(pathname: string, html: string): void;
    /** Requests for this path wait until `release` (or `maxMs`, a safety net so a stuck test never hangs a run). */
    hold(pathname: string, maxMs?: number): void;
    release(pathname: string): void;
    /** How many requests reached this path. */
    hits(pathname: string): number;
    /** Resolves once `n` requests reached this path. */
    waitForHit(pathname: string, n?: number, ms?: number): Promise<void>;
    close(): Promise<void>;
}

export interface RunnerStack {
    readonly base: string;
    readonly mode: ExecutionMode;
    readonly apiKey: string;
    readonly dataDir: string;
    readonly app: StandInApp;
    readonly people: Record<string, Person>;
    /** An API call with the platform's access key (an owner). */
    admin(method: string, url: string, body?: unknown): Promise<Answer>;
    /** An API call as one person (their personal API token). */
    as(person: string, method: string, url: string, body?: unknown): Promise<Answer>;
    startAgent(opts: AgentStart): Promise<AgentProcess>;
    /** Everything the platform printed so far. */
    platformOutput(): string;
    stop(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` gives something other than undefined (errors count as "not yet"). */
export async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, ms: number, what: string, every = 250): Promise<T> {
    const end = Date.now() + ms;
    let last: unknown;
    while (Date.now() < end) {
        try {
            const v = await fn();
            if (v !== undefined) return v;
        } catch (e) {
            last = e;
        }
        await sleep(every);
    }
    throw new Error(`Timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
}

/** Process groups started here and still alive: killed when the test process exits, whatever happens. */
const groups = new Set<number>();
let exitHook = false;
function track(pid: number) {
    groups.add(pid);
    if (!exitHook) {
        exitHook = true;
        process.on("exit", () => {
            for (const g of groups) killGroup(g, "SIGKILL");
        });
    }
}
function killGroup(pid: number, signal: NodeJS.Signals) {
    try {
        // A negative pid is the process group this helper made (detached: true), so only processes it started are reached.
        process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch {
        /* already gone */
    }
}

/** The environment both programs get: a short allow-list, never this machine's keys, proxies or database settings. */
function baseEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "LANG", "LC_ALL", "TZ", "SystemRoot", "TMPDIR", "TEMP", "TMP"]) if (process.env[k] !== undefined) env[k] = process.env[k];
    // Playwright's browsers stay where this machine keeps them, even with a temporary HOME.
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : process.platform === "win32" ? "AppData/Local/ms-playwright" : ".cache/ms-playwright");
    env.PLAYWRIGHT_BROWSERS_PATH = browsers;
    env.HOME = home;
    env.USERPROFILE = home;
    // A real phone may be attached to this machine: no test reaches it.
    env.TAQWRIGHT_HOME = process.platform === "win32" ? "C:\\nonexistent-taqwright" : "/nonexistent-taqwright";
    return env;
}

function startProcess(args: string[], env: NodeJS.ProcessEnv, label: string): { child: ChildProcess; lines: string[]; exited: Promise<number | null> } {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    if (!child.pid) throw new Error(`${label} did not start`);
    track(child.pid);
    const lines: string[] = [];
    child.stdout!.on("data", (b: Buffer) => lines.push(b.toString("utf8")));
    child.stderr!.on("data", (b: Buffer) => lines.push(b.toString("utf8")));
    const pid = child.pid;
    const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (code) => {
            // What it left behind in its own group (a test's browser, a task child) goes with it. While a member is alive the group's
            // id cannot be given to another process, so this reaches only what this helper started.
            killGroup(pid, "SIGKILL");
            groups.delete(pid);
            resolve(code);
        }),
    );
    return { child, lines, exited };
}

async function stopProcess(child: ChildProcess, exited: Promise<number | null>, graceMs: number): Promise<number | null> {
    if (child.exitCode !== null || child.signalCode !== null) return exited;
    try {
        child.kill("SIGTERM");
    } catch {
        /* gone */
    }
    const code = await Promise.race([exited, sleep(graceMs).then(() => "late" as const)]);
    if (code !== "late") return code;
    killGroup(child.pid!, "SIGKILL");
    return exited;
}

export async function startStandInApp(port: number): Promise<StandInApp> {
    const pages = new Map<string, string>();
    const held = new Map<string, { maxMs: number; waiting: Array<() => void> }>();
    const counts = new Map<string, number>();
    const server = http.createServer((req, res) => {
        const p = new URL(req.url ?? "/", "http://x").pathname;
        counts.set(p, (counts.get(p) ?? 0) + 1);
        const send = () => {
            const html = pages.get(p);
            if (p === "/api/health") return void res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
            if (html === undefined) return void res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title><p>Not found</p>");
            res.writeHead(200, { "content-type": "text/html" }).end(html);
        };
        const h = held.get(p);
        if (!h) return send();
        const timer = setTimeout(send, h.maxMs);
        h.waiting.push(() => {
            clearTimeout(timer);
            send();
        });
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${port}`;
    return {
        url,
        page: (p, html) => void pages.set(p, html),
        hold: (p, maxMs = 25_000) => void held.set(p, { maxMs, waiting: [] }),
        release: (p) => {
            const h = held.get(p);
            held.delete(p);
            for (const go of h?.waiting ?? []) go();
        },
        hits: (p) => counts.get(p) ?? 0,
        waitForHit: async (p, n = 1, ms = 60_000) => void (await waitFor(() => ((counts.get(p) ?? 0) >= n ? true : undefined), ms, `a request for ${p}`, 100)),
        close: () =>
            new Promise<void>((r) => {
                for (const p of [...held.keys()]) {
                    const h = held.get(p);
                    held.delete(p);
                    for (const go of h?.waiting ?? []) go();
                }
                server.closeAllConnections();
                server.close(() => r());
            }),
    };
}

/** Make the people in a fresh data folder (the platform is not running yet), each with a password and a personal API token. */
async function seedPeople(dataDir: string, apiKey: string, people: Record<string, PersonSpec>): Promise<Record<string, Person>> {
    const seed = bootstrap(loadConfig({ DATA_DIR: dataDir, API_KEY: apiKey, HOST: "127.0.0.1", LLM_PROVIDER: "anthropic", SCHEDULER_ENABLED: "false", WORKER_EMBEDDED: "false" }));
    try {
        const users = new UserStore(seed.db, new SecretBox(dataDir, undefined));
        const out: Record<string, Person> = {};
        for (const [key, p] of Object.entries(people)) {
            const made = users.create({ email: p.email, name: p.name, role: p.role, passwordHash: await hashPassword(p.password) });
            const { token } = users.createToken(made.id, { name: "journey test", role: p.role });
            out[key] = { ...p, id: made.id, token };
        }
        return out;
    } finally {
        seed.db.close();
    }
}

async function call(base: string, headers: Record<string, string>, method: string, url: string, body?: unknown): Promise<Answer> {
    const res = await fetch(`${base}${url}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: unknown;
    try {
        parsed = text ? JSON.parse(text) : undefined;
    } catch {
        parsed = undefined;
    }
    return { status: res.status, text, body: parsed };
}

export async function startRunnerStack(opts: StackOptions): Promise<RunnerStack> {
    const label = opts.label ?? "aitp-runner-stack";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
    const dataDir = path.join(root, "data");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const apiKey = `stack-key-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
    const base = `http://127.0.0.1:${opts.port}`;
    const people = await seedPeople(dataDir, apiKey, opts.people);
    const app = await startStandInApp(opts.appPort);

    const env: NodeJS.ProcessEnv = {
        ...baseEnv(home),
        DATA_DIR: dataDir,
        API_KEY: apiKey,
        HOST: "127.0.0.1",
        PORT: String(opts.port),
        // No AI is ever called: no model keys, and nothing below asks for one.
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        LLM_API_KEY: "",
        MAX_REPAIR_ATTEMPTS: "0",
        CONCURRENCY: "2",
        WORKER_POLL_MS: "200",
        SHUTDOWN_GRACE_SECONDS: "3",
        // Short runner timings, so a journey takes a minute or two (the platform's long-poll, the lease, the watch loop).
        AGENT_POLL_SECONDS: "2",
        AGENT_LEASE_SECONDS: "30",
        AGENT_WATCH_MS: "200",
        AGENT_NO_AGENT_GRACE_SECONDS: "60",
        ...(opts.mode === "runners" ? { EXECUTION_MODE: "runners", WORKER_EMBEDDED: "false", SCHEDULER_ENABLED: "true" } : { EXECUTION_MODE: "local", WORKER_EMBEDDED: "true", SCHEDULER_ENABLED: "false" }),
        ...(opts.env ?? {}),
    };
    const platform = startProcess(["--import", "tsx", "src/main.ts"], env, "The platform");
    const platformOutput = () => platform.lines.join("");
    try {
        await waitFor(
            async () => {
                if (platform.child.exitCode !== null) throw new Error(`the platform exited with ${platform.child.exitCode}: ${platformOutput().slice(-2000)}`);
                return (await fetch(`${base}/api/health`)).ok ? true : undefined;
            },
            90_000,
            "the platform to answer",
        );
    } catch (e) {
        await stopProcess(platform.child, platform.exited, 2000);
        await app.close();
        throw new Error(`${String(e)}\n${platformOutput().slice(-3000)}`);
    }

    const agents: AgentProcess[] = [];
    let agentCount = 0;
    const startAgent = async (a: AgentStart): Promise<AgentProcess> => {
        agentCount += 1;
        const agentRoot = path.join(root, `agent-${agentCount}`);
        fs.mkdirSync(agentRoot, { recursive: true });
        const workDir = a.workDir ?? path.join(root, `runner-${agentCount}`);
        fs.mkdirSync(workDir, { recursive: true });
        const args = [path.join(REPO_ROOT, "bin/ai-test-agent.mjs"), "--url", base, "--name", a.name, "--work-dir", workDir, ...(a.extraArgs ?? [])];
        if (a.enrollCode) args.push("--enroll", a.enrollCode);
        else if (a.enrollFile) args.push("--enroll-file", a.enrollFile);
        else if (a.token) {
            const file = path.join(agentRoot, "runner.token");
            fs.writeFileSync(file, `${a.token}\n`, { mode: 0o600 });
            args.push("--token-file", file);
        } else if (!a.savedCredential) throw new Error("startAgent needs an enrollment code, a token or savedCredential: true");
        const p = startProcess(
            args,
            {
                ...baseEnv(home),
                // A runner from a checkout: no updates, no download of phone tools, nothing from this machine's runner settings.
                AITP_UPDATES: "0",
                AITP_PHONE_TOOLS: "off",
                AITP_URL: "",
                AITP_AGENT_TOKEN: "",
                AITP_AGENT_TOKEN_FILE: "",
                // RUNNER_STACK_AGENT_BROWSERS_PATH=/nowhere hides Playwright's own browsers from the runner only, so it takes the computer's
                // installed Chrome or Edge, as on a tester's computer (the test's own browser keeps Playwright's).
                ...(process.env.RUNNER_STACK_AGENT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.RUNNER_STACK_AGENT_BROWSERS_PATH } : {}),
                ...(a.extraEnv ?? {}),
            },
            "The runner",
        );
        const agent: AgentProcess = {
            pid: p.child.pid!,
            workDir,
            output: () => p.lines.join(""),
            exited: p.exited,
            running: () => p.child.exitCode === null && p.child.signalCode === null,
            stop: (graceMs = 20_000) => stopProcess(p.child, p.exited, graceMs),
        };
        agents.push(agent);
        return agent;
    };

    const stop = async () => {
        for (const a of agents) if (a.running()) await a.stop(10_000);
        await stopProcess(platform.child, platform.exited, 10_000);
        await app.close();
        fs.rmSync(root, { recursive: true, force: true });
    };

    return {
        base,
        mode: opts.mode,
        apiKey,
        dataDir,
        app,
        people,
        admin: (method, url, body) => call(base, { "x-api-key": apiKey }, method, url, body),
        as: (person, method, url, body) => {
            const p = people[person];
            if (!p) throw new Error(`No person "${person}" in this stack`);
            return call(base, { authorization: `Bearer ${p.token}` }, method, url, body);
        },
        startAgent,
        platformOutput,
        stop,
    };
}
