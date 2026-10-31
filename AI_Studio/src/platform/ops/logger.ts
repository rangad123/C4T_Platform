/**
 * Structured logs. With LOG_FORMAT=json every line the platform writes (console.log/info/warn/error/debug, the request log, the shutdown
 * and backup notes) becomes one JSON object: `time`, `level`, `msg`, and when known `component` (the `[worker]` style prefix), `job` (the short
 * job id the job lines carry), `requestId`. Without it the platform's usual text lines are written exactly as before.
 *
 * Secrets never reach a line: the values the server holds (API key, encryption key, AI key, mail password, metrics token, ...) are replaced by
 * the existing run-secret scrubber, credential shapes (Bearer/Basic, JWTs) and secret query parameters (`?token=`, `?key=`, `?ticket=`, ...) are
 * hidden, and a deploy-trigger token in a path is hidden by the trigger store's own redaction.
 */
import { format } from "node:util";
import { scrubSecrets } from "../agent-routing.js";
import { redactStreamUrl } from "../stream-core.js";
import { redactTriggerUrl } from "../trigger-store.js";

export type Level = "debug" | "info" | "warn" | "error";

/** The environment variables whose values are secrets of the server itself. */
export const SERVER_SECRET_VARS = ["API_KEY", "SECRET_KEY", "LLM_API_KEY", "SMTP_PASSWORD", "METRICS_TOKEN", "OIDC_CLIENT_SECRET"] as const;

export function serverSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
    return SERVER_SECRET_VARS.map((k) => env[k]?.trim() ?? "").filter((v) => v.length >= 4);
}

const AUTH_SCHEME = /\b(bearer|basic)\s+[\w.~+/=-]{6,}/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
// Same names the discovery code treats as secret in an address (engine/discovery/network.ts), as query parameters inside any text.
const SECRET_PARAM = /([?&](?:[\w-]*pass(?:word)?|[\w-]*secret|[\w-]*token|authori[sz]ation|auth|api[-_]?key|key|session|signature|sig|ticket|code|otp|cookie)=)[^&#\s"']*/gi;
const MAX_LINE = 8_000;

/** Remove every secret from one log text (known values first, then shapes). */
export function scrubLogText(text: string, secrets: readonly string[]): string {
    let out = scrubSecrets(text, [...secrets]);
    out = redactTriggerUrl(redactStreamUrl(out));
    out = out.replace(JWT, "[token]").replace(AUTH_SCHEME, "$1 [hidden]").replace(SECRET_PARAM, "$1[hidden]");
    return out.length > MAX_LINE ? `${out.slice(0, MAX_LINE)}…(cut)` : out;
}

export interface LogFields {
    component?: string;
    job?: string;
    requestId?: string;
    [k: string]: unknown;
}

/** One JSON log line (no newline). `extra` values that are strings are scrubbed too. */
export function jsonLine(level: Level, msg: string, fields: LogFields, secrets: readonly string[], at: Date = new Date()): string {
    const clean: Record<string, unknown> = { time: at.toISOString(), level, msg: scrubLogText(msg, secrets) };
    // Pick the context out of the platform's usual prefixes: "[worker] ...", "[job 1a2b3c4d] ...".
    const prefix = /^\[([\w-]+)(?: ([0-9a-f]{8}))?\]\s/.exec(msg);
    if (prefix && !fields.component) clean.component = prefix[1];
    if (prefix?.[2] && !fields.job) clean.job = prefix[2];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || k === "time" || k === "level" || k === "msg") continue;
        clean[k] = typeof v === "string" ? scrubLogText(v, secrets) : v;
    }
    return JSON.stringify(clean);
}

type Sink = (line: string) => void;

export interface OpsLogger {
    format: "text" | "json";
    log(level: Level, msg: string, fields?: LogFields): void;
}

/** A logger that writes either the usual text line or a JSON line. Used by the ops pieces (requests, shutdown, backups). */
export function createOpsLogger(fmt: "text" | "json", secrets: readonly string[], sink: { out: Sink; err: Sink } = defaultSinks()): OpsLogger {
    return {
        format: fmt,
        log(level, msg, fields = {}) {
            const write = level === "error" || level === "warn" ? sink.err : sink.out;
            if (fmt === "json") write(jsonLine(level, msg, fields, secrets));
            else write(scrubLogText(msg, secrets));
        },
    };
}

function defaultSinks(): { out: Sink; err: Sink } {
    return { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
}

let errorLines = 0;
/** Error-level lines this process wrote since it started (for /metrics). */
export const errorLineCount = (): number => errorLines;

const CONSOLE_LEVELS: Array<[keyof Console & ("log" | "info" | "warn" | "error" | "debug"), Level]> = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
    ["debug", "debug"],
];

let installed: (() => void) | undefined;

/**
 * Process start (main.ts, worker-main.ts): counts error lines for /metrics and, with LOG_FORMAT=json, turns every console line into a
 * scrubbed JSON line. Returns a function that puts the console back (tests).
 */
export function installConsole(fmt: "text" | "json", secrets: readonly string[], sink: { out: Sink; err: Sink } = defaultSinks()): () => void {
    installed?.();
    const original = Object.fromEntries(CONSOLE_LEVELS.map(([m]) => [m, console[m]])) as Record<string, (...a: unknown[]) => void>;
    for (const [method, level] of CONSOLE_LEVELS) {
        console[method] = (...args: unknown[]) => {
            if (level === "error") errorLines++;
            if (fmt !== "json") return original[method]!.apply(console, args);
            const write = level === "error" || level === "warn" ? sink.err : sink.out;
            write(jsonLine(level, format(...args), {}, secrets));
        };
    }
    installed = () => {
        for (const [method] of CONSOLE_LEVELS) console[method] = original[method] as never;
        installed = undefined;
    };
    return installed;
}
