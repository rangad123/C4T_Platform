/**
 * Command line and environment of the runner agent.
 *
 * Pure: `parseAgentArgs(argv, env)` returns what to do (help, version, run with this configuration) or a plain usage
 * error. It reads the token file (when asked to) but prints nothing, so the token can never reach an output from here:
 * an error message about the token says what is wrong with it, never what it is.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AGENT_TOKEN_PREFIX, ENROLLMENT_CODE_PREFIX } from "../agent-protocol/schema.js";
import { REPO_ROOT } from "../config.js";
import { isDeniedProgram } from "../engine/desktop/target.js";
import { BROWSER_POLICIES, isBrowserPolicy, type BrowserPolicy } from "../engine/browsers/choice.js";
import { resolveNetwork, type NetworkSettings } from "./net.js";

export const AGENT_VERSION = "1.0.0";

export interface AgentConfig {
    /** Platform address without a trailing slash, e.g. https://tests.example.com */
    baseUrl: string;
    token: string;
    name: string;
    concurrency: number;
    workDir: string;
    allowInsecure: boolean;
    /** Largest the downloaded-file cache may grow, in bytes. */
    cacheBytes: number;
    /** Set when the address is plain http and was accepted anyway: the text of the warning to print once. */
    insecureWarning?: string;
    /**
     * Where the token came from, for the one-time advice about the command line. "store": the computer's credential store (credential-store.ts),
     * read by main() before the agent starts, or filled by trading `enroll` at first contact; `token` is empty until then.
     */
    tokenSource: "flag" | "env" | "file" | "store";
    /** The folder whose credential the store keeps (the runner's folder; AITP_CREDENTIAL_DIR, else the work folder). Its install id lives there too. */
    credentialDir?: string;
    /** A single-use enrollment code to trade for the credential: given on the command line (`explicit`, replaces a stored one) or in a file (runner.enroll, used only while none is stored). */
    enroll?: { code: string; file?: string; explicit: boolean };
    /**
     * Applications Windows desktop tests may start on this computer (--allow-app, AITP_ALLOW_APPS, --allow-apps-file). Empty = none: a desktop
     * test is refused with a plain message. Command shells and script hosts are dropped here and never allowed (see engine/desktop/target.ts).
     */
    allowApps?: string[];
    /** Plain sentences about allow-list entries that were left out, printed once at start-up. */
    allowAppNotes?: string[];
    /**
     * This computer's owner agrees to run hand-written scripts (--allow-custom-scripts, AITP_ALLOW_CUSTOM_SCRIPTS). Only then does the agent report
     * the capability, accept a script marked custom, or write helper modules. Absent = refuse them.
     */
    allowCustomScripts?: boolean;
    /** The runner kit this agent was started from (AITP_KIT_VERSION, set from the kit's runner.json by kit.ts). Only reported to the platform. */
    kitVersion?: string;
    /** Which browser web tests use (--browser, AITP_BROWSER, runner.json `browser`): auto (default), bundled, chrome or msedge. See browser-setup.ts. */
    browser?: BrowserPolicy;
    /** Proxy and certificates (--proxy, --proxy-bypass, --proxy-tests, --ca-file, the HTTPS_PROXY family, runner.json). See net.ts. */
    network?: NetworkSettings;
}

export type ParsedArgs =
    | { kind: "help" }
    | { kind: "version" }
    | { kind: "run"; config: AgentConfig }
    | { kind: "forget"; credentialDir: string }
    | { kind: "error"; message: string };

export const USAGE = `ai-test-agent: runs tests for the AI Testing Platform on this computer.

Usage:
  ai-test-agent --url <platform address> --enroll <aite_...> [options]
  (a download from Settings, Your runner needs neither: its start script or installer passes them)

The runner is the program on your computer that runs your tests. Each person has one, set up once in Settings. It
connects out to the platform (it never opens a port), receives the runs you start, runs them next to your application
and devices, and sends the results back.

Options:
  --url <address>        Platform address, e.g. https://tests.example.com        (env AITP_URL)
  --enroll <code>        Add this computer with a single-use code from Settings, Your runner (aite_...).
                         The runner trades it for its own credential, keeps that in this computer's
                         store (Windows data protection, the macOS Keychain, or a file only you can
                         read on Linux) and needs no code afterwards         (env AITP_ENROLL_CODE)
  --enroll-file <file>   The same code read from a file, deleted once used (a download's runner.enroll)
                                                                                 (env AITP_AGENT_ENROLL_FILE)
  --forget-credential    Delete the credential this runner keeps, then exit (for uninstalling)
  --name <label>         Name shown in Settings, default: this computer's name   (env AITP_AGENT_NAME)
  --concurrency <1-8>    Runs at the same time, default 1                        (env AITP_AGENT_CONCURRENCY)
  --work-dir <folder>    Where runs and the file cache live, default .agent-work (env AITP_AGENT_WORK_DIR)
  --cache-mb <number>    Size limit of the file cache, default 2048              (env AITP_AGENT_CACHE_MB)
  --allow-insecure       Accept a plain http:// address that is not on a private network
                                                                                 (env AITP_AGENT_ALLOW_INSECURE=1)
  --allow-app <program>  A Windows application desktop tests may start: a full path or a
                         program name, repeat for more. Nothing is allowed by default
                                                                                 (env AITP_ALLOW_APPS, separated by ;)
  --allow-apps-file <f>  The same list in a file, one entry per line               (env AITP_ALLOW_APPS_FILE)
  --allow-custom-scripts Run hand-written scripts (code people on the project wrote). They can
                         do anything this user can do on this computer, so only switch it on
                         when you trust everyone who edits tests. Off by default
                                                                                 (env AITP_ALLOW_CUSTOM_SCRIPTS=1)
  --browser <choice>     Browser for web tests: auto (default: Playwright's Chromium if it is
                         here, else Google Chrome, else Microsoft Edge, else download Chromium),
                         bundled (always Playwright's Chromium), chrome or msedge (only that
                         installed browser)                                      (env AITP_BROWSER)
  --proxy <address>      Company proxy for the runner's own connections, e.g. http://proxy:8080
                         or http://user:password@proxy:8080 (the password is never shown).
                         "none" connects directly. Default: HTTPS_PROXY / HTTP_PROXY, then
                         runner.json "proxy", then (Windows) the system proxy setting
  --proxy-bypass <list>  Addresses reached without the proxy, separated by commas
                         (like NO_PROXY: host, .example.com, *.example.com, host:port)
  --proxy-tests          Send the browser and the tests' API calls through the proxy too
                         (default: tests reach the application directly) (env AITP_PROXY_TESTS=1)
  --ca-file <file>       A company certificate file (.pem or .crt) to trust, besides this
                         computer's certificate store                            (env AITP_CA_FILE)
  AITP_PHONE_TOOLS       (environment or runner.json "phoneTools") auto: get Google's Android
                         phone tools (adb) into the work folder when a phone session needs them
                         (default for a downloaded runner); now: also at start; off: never
  --check                Check this computer and exit: Node.js, the runner's files, the test tools,
                         the browser, the proxy and certificates, the platform and the token (never
                         shown), disk space, the clock and phone tools, each with how to fix it
  --rollback             A runner from a download: go back to the version kept by its last
                         update, then exit (start it again afterwards). AITP_UPDATES=0 turns
                         its automatic updates off on this computer
  --version              Print the agent version
  -h, --help             Print this help

Prefer the environment variable or --token-file for the token: a token on the command line is visible to other users of
this computer in the process list. The token is never printed or logged by the agent.
Exit codes: 0 stopped normally, 1 failed, 2 wrong command line, 3 token not valid or revoked, 4 protocol mismatch,
5 the platform refused this agent, 75 updated itself (start it again; the start scripts do).`;

const OPTIONS = {
    url: { type: "string" },
    token: { type: "string" },
    "token-file": { type: "string" },
    enroll: { type: "string" },
    "enroll-file": { type: "string" },
    "forget-credential": { type: "boolean" },
    name: { type: "string" },
    concurrency: { type: "string" },
    "work-dir": { type: "string" },
    "cache-mb": { type: "string" },
    "allow-insecure": { type: "boolean" },
    "allow-app": { type: "string", multiple: true },
    "allow-apps-file": { type: "string" },
    "allow-custom-scripts": { type: "boolean" },
    browser: { type: "string" },
    proxy: { type: "string" },
    "proxy-bypass": { type: "string" },
    "proxy-tests": { type: "boolean" },
    "ca-file": { type: "string" },
    version: { type: "boolean" },
    help: { type: "boolean", short: "h" },
} as const;

/** True for addresses that are not on the public internet: loopback, private ranges, link-local, "localhost". */
export function isPrivateHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    if (h.includes(":")) {
        if (h === "::1") return true;
        if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local fc00::/7
        if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // link-local fe80::/10
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
        return mapped ? isPrivateHost(mapped[1]!) : false;
    }
    return false;
}

export type AddressCheck = { ok: true; baseUrl: string; warning?: string } | { ok: false; message: string };

/** HTTPS is required unless the platform is on this computer or a private network, or the person said --allow-insecure. */
export function checkPlatformAddress(raw: string, allowInsecure: boolean): AddressCheck {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { ok: false, message: "--url must be a full address like https://tests.example.com" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, message: "--url must start with https:// (or http:// for a platform on a private network)" };
    if (u.username || u.password) return { ok: false, message: "--url must not contain a user name or password; use --token instead" };
    const baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    if (u.protocol === "https:") return { ok: true, baseUrl };
    if (isPrivateHost(u.hostname)) return { ok: true, baseUrl, warning: `The platform address is plain http (${u.host}). That is fine on this computer or a private network, but the token and the test credentials travel unencrypted.` };
    if (allowInsecure) return { ok: true, baseUrl, warning: `WARNING: the platform address is plain http (${u.host}) and --allow-insecure is set. The token and the test credentials travel unencrypted over this connection.` };
    return { ok: false, message: `--url must use https:// because ${u.hostname} is not on a private network. Use an https address, or add --allow-insecure if you accept sending the token unencrypted.` };
}

const TOKEN_SHAPE = new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{20,200}$`);
const ENROLL_SHAPE = new RegExp(`^${ENROLLMENT_CODE_PREFIX}[A-Za-z0-9_-]{20,200}$`);

/** The default folder for runs: inside the checkout, so the generated scripts find @playwright/test in node_modules. */
export const defaultWorkDir = (): string => path.join(REPO_ROOT, ".agent-work");

function int(name: string, raw: string, min: number, max: number): number | string {
    if (!/^\d+$/.test(raw.trim())) return `--${name} must be a whole number between ${min} and ${max}`;
    const n = Number(raw);
    return n < min || n > max ? `--${name} must be between ${min} and ${max}` : n;
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

const readArgs = (argv: string[]) => parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });

export function parseAgentArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
    let parsed: ReturnType<typeof readArgs>;
    try {
        parsed = readArgs(argv);
    } catch (e) {
        const raw = e instanceof Error ? e.message : "";
        // Node's messages name the option, never a value; keep them but make the first sentence plain.
        const unknown = /Unknown option '([^']+)'/.exec(raw);
        if (unknown) return { kind: "error", message: `Unknown option ${unknown[1]}. Run ai-test-agent --help to see the options.` };
        const missing = /Option '([^']+)' argument missing/.exec(raw);
        if (missing) return { kind: "error", message: `${missing[1]!.replace(/ <value>.*$/, "")} needs a value.` };
        return { kind: "error", message: "The command line could not be read. Run ai-test-agent --help." };
    }
    const { values, positionals } = parsed;
    if (values.help) return { kind: "help" };
    if (values.version) return { kind: "version" };
    if (values["forget-credential"]) {
        const dirRaw = env.AITP_CREDENTIAL_DIR?.trim() || values["work-dir"]?.trim() || env.AITP_AGENT_WORK_DIR?.trim();
        return { kind: "forget", credentialDir: dirRaw ? path.resolve(dirRaw) : defaultWorkDir() };
    }
    if (positionals.length > 0) return { kind: "error", message: `Unexpected argument "${positionals[0]!.slice(0, 40)}". Run ai-test-agent --help.` };

    const url = values.url ?? env.AITP_URL;
    if (!url?.trim()) return { kind: "error", message: "Give the platform address with --url (or AITP_URL), e.g. --url https://tests.example.com" };

    // Where the token comes from: flag, then file, then environment. Whatever the source, the text is never echoed.
    let token: string | undefined;
    let tokenSource: AgentConfig["tokenSource"] = "env";
    const tokenFile = values["token-file"] ?? env.AITP_AGENT_TOKEN_FILE;
    if (values.token !== undefined) {
        token = values.token;
        tokenSource = "flag";
    } else if (tokenFile) {
        try {
            token = fs.readFileSync(tokenFile, "utf8").split(/\r?\n/)[0] ?? "";
            tokenSource = "file";
        } catch {
            return { kind: "error", message: "The token file could not be read. Check the path given with --token-file." };
        }
    } else {
        token = env.AITP_AGENT_TOKEN;
    }
    token = token?.trim();
    // Round 39: no token given means the credential this runner keeps (credential-store.ts), or an enrollment code to get one.
    let enroll: AgentConfig["enroll"];
    const enrollCode = values.enroll ?? env.AITP_ENROLL_CODE;
    const enrollFile = values["enroll-file"] ?? env.AITP_AGENT_ENROLL_FILE;
    if (!token && enrollCode !== undefined && enrollCode.trim()) {
        if (!ENROLL_SHAPE.test(enrollCode.trim())) return { kind: "error", message: `That is not an enrollment code (they start with ${ENROLLMENT_CODE_PREFIX}). Copy it again from Settings, Your runner.` };
        enroll = { code: enrollCode.trim(), explicit: true };
    } else if (!token && enrollFile) {
        let code = "";
        try {
            code = (fs.readFileSync(enrollFile, "utf8").split(/\r?\n/)[0] ?? "").trim();
        } catch {
            /* the file was used and deleted already: the stored credential counts (main.ts) */
        }
        if (code && !ENROLL_SHAPE.test(code)) return { kind: "error", message: `The enrollment file does not hold an enrollment code. Download the runner again from Settings, Your runner.` };
        if (code) enroll = { code, file: path.resolve(enrollFile), explicit: false };
    }
    if (token && !TOKEN_SHAPE.test(token)) return { kind: "error", message: `That is not an agent token (they start with ${AGENT_TOKEN_PREFIX}). Set up the runner from Settings, Your runner instead.` };
    if (!token) {
        token = "";
        tokenSource = "store";
    }

    const allowInsecure = values["allow-insecure"] === true || truthy(env.AITP_AGENT_ALLOW_INSECURE);
    const address = checkPlatformAddress(url.trim(), allowInsecure);
    if (!address.ok) return { kind: "error", message: address.message };

    const concurrencyRaw = values.concurrency ?? env.AITP_AGENT_CONCURRENCY ?? "1";
    const concurrency = int("concurrency", concurrencyRaw, 1, 8);
    if (typeof concurrency === "string") return { kind: "error", message: concurrency };
    const cacheRaw = values["cache-mb"] ?? env.AITP_AGENT_CACHE_MB ?? "2048";
    const cacheMb = int("cache-mb", cacheRaw, 16, 1_000_000);
    if (typeof cacheMb === "string") return { kind: "error", message: cacheMb };

    const name = (values.name ?? env.AITP_AGENT_NAME ?? os.hostname()).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 64) || "agent";
    const workDirRaw = values["work-dir"] ?? env.AITP_AGENT_WORK_DIR;
    const workDir = workDirRaw?.trim() ? path.resolve(workDirRaw.trim()) : defaultWorkDir();
    const credentialDir = env.AITP_CREDENTIAL_DIR?.trim() ? path.resolve(env.AITP_CREDENTIAL_DIR.trim()) : workDir;

    // Applications desktop tests may start. Three places to say it, all kept on this computer: the command line, the environment, a file.
    const listed: string[] = [...(values["allow-app"] ?? [])];
    for (const part of (env.AITP_ALLOW_APPS ?? "").split(";")) listed.push(part);
    const allowFile = values["allow-apps-file"] ?? env.AITP_ALLOW_APPS_FILE;
    if (allowFile) {
        try {
            listed.push(...fs.readFileSync(allowFile, "utf8").split(/\r?\n/));
        } catch {
            return { kind: "error", message: "The allow-list file could not be read. Check the path given with --allow-apps-file." };
        }
    }
    const allowApps: string[] = [];
    const allowAppNotes: string[] = [];
    for (const raw of listed) {
        const entry = raw.trim();
        // A line of a file may be a comment.
        if (!entry || entry.startsWith("#")) continue;
        if (entry.length > 300 || /[\u0000-\u001f"<>|*?]/.test(entry)) {
            allowAppNotes.push(`Ignored an allow-list entry that is not a program name or path ("${entry.replace(/[\u0000-\u001f]/g, " ").slice(0, 40)}").`);
        } else if (isDeniedProgram(entry)) {
            allowAppNotes.push(`${entry} is never allowed: command shells, script hosts and similar programs cannot be started by a test, even when listed.`);
        } else if (!allowApps.includes(entry)) allowApps.push(entry);
    }

    // Informational only (shown in the platform's runner list): printable characters, short.
    const kitVersion = (env.AITP_KIT_VERSION ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 80);

    // The browser setting: the flag beats the environment, which beats the kit's runner.json (kit.ts puts that into AITP_BROWSER only when it is unset).
    const browserRaw = (values.browser ?? env.AITP_BROWSER ?? "").trim().toLowerCase();
    if (browserRaw && !isBrowserPolicy(browserRaw)) return { kind: "error", message: `${values.browser !== undefined ? "--browser" : "AITP_BROWSER"} must be one of ${BROWSER_POLICIES.join(", ")}.` };
    const browser = browserRaw && isBrowserPolicy(browserRaw) ? browserRaw : undefined;

    // Proxy and certificates (net.ts): a flag beats the environment, which beats runner.json. A refusal never repeats the proxy address (it may hold a password).
    const net = resolveNetwork({ ...(values.proxy !== undefined ? { proxy: values.proxy } : {}), ...(values["proxy-bypass"] !== undefined ? { "proxy-bypass": values["proxy-bypass"] } : {}), ...(values["proxy-tests"] ? { "proxy-tests": true } : {}), ...(values["ca-file"] !== undefined ? { "ca-file": values["ca-file"] } : {}) }, env);
    if (!net.ok) return { kind: "error", message: net.message };

    return {
        kind: "run",
        config: { baseUrl: address.baseUrl, token, name, concurrency, workDir, credentialDir, ...(enroll ? { enroll } : {}), allowInsecure, cacheBytes: cacheMb * 1024 * 1024, ...(address.warning ? { insecureWarning: address.warning } : {}), tokenSource, allowApps, allowAppNotes, ...(values["allow-custom-scripts"] === true || truthy(env.AITP_ALLOW_CUSTOM_SCRIPTS) ? { allowCustomScripts: true } : {}), ...(kitVersion ? { kitVersion } : {}), ...(browser ? { browser } : {}), network: net.settings },
    };
}
