/**
 * Crashes and freezes of the app under test, read from the phone's own log.
 *
 * The log is read with ONE fixed command (`adb logcat -d -b crash -b system -v epoch -t <mark>`, see device/adb.ts): the crash buffer holds the
 * "FATAL EXCEPTION" of a Java/Kotlin app and the "Fatal signal" of a native one, the system buffer holds "ANR in <package>" (the app stopped
 * responding). Only entries of the app under test (its package or one of its processes, `pkg:name`) are kept; everything else on the phone is ignored.
 *
 * What comes out is untrusted text from an app: control characters are removed, lines are cut, the stack is capped, and anything that looks like a
 * secret (the project's password, `password=…`, tokens, long keys, e-mail addresses) is replaced before it is stored or shown.
 */
import type { AppCrash } from "./types.js";

export const MAX_STACK_LINES = 25;
const MAX_LINE = 200;
/** The most log text read at once: the end of it is kept (the newest entries). */
export const MAX_LOG_CHARS = 512 * 1024;
/** Most crashes kept from one read (an app in a crash loop logs the same crash again and again). */
const MAX_CRASHES = 10;

export interface LogLine {
    at: number;
    pid: number;
    level: string;
    tag: string;
    msg: string;
    /** The exact text, to tell apart two entries logged in the same millisecond. */
    raw: string;
}

const LINE = /^\s*(\d{1,12}\.\d{1,9})\s+(\d{1,7})\s+(\d{1,7})\s+([VDIWEFAS])\s+([^:]{0,64}?)\s*: ?(.*)$/;

/** Parses `logcat -v epoch` output. Lines that are not log entries ("--------- beginning of crash") are skipped. */
export function parseLogLines(text: string): LogLine[] {
    const tail = text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text;
    const out: LogLine[] = [];
    for (const raw of tail.split(/\r?\n/)) {
        const m = LINE.exec(raw);
        if (!m) continue;
        out.push({ at: Number(m[1]), pid: Number(m[2]), level: m[4]!, tag: m[5]!.trim(), msg: m[6]!, raw });
    }
    return out;
}

/** The newest entry's time, formatted for `-t` (always with a decimal point, so logcat reads it as a time and not as a count). */
export function markOf(text: string): string | undefined {
    const lines = parseLogLines(text);
    const last = lines[lines.length - 1];
    return last ? formatMark(last.at) : undefined;
}

export const formatMark = (at: number): string => at.toFixed(3);

const SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|auth|session|cookie)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2[hidden]"],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [hidden]"],
    [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}/g, "[e-mail hidden]"],
    [/\b(?=[A-Za-z0-9+/_-]{32,}\b)(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g, "[hidden]"],
];

/** Cleans one line of app text for storing: no control or direction characters, secrets replaced, cut to 200 characters. */
export function scrubLine(line: string, secrets: readonly string[] = []): string {
    let s = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").replace(/\t/g, "    ");
    for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join("[hidden]");
    for (const [re, to] of SECRET_PATTERNS) s = s.replace(re, to);
    s = s.trimEnd();
    return s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
}

/** Is this process name the app under test (the package itself, or one of its own processes such as `com.example.app:sync`)? */
export function isAppProcess(name: string, appPackage: string): boolean {
    return name === appPackage || name.startsWith(`${appPackage}:`);
}

/**
 * The crashes and freezes of `appPackage` in log text, newest last. `after` drops entries at or before that time (the mark of the run), except
 * entries whose exact text is in `seenAtMark` (logged in the same millisecond as the mark but not seen yet).
 */
export function crashesIn(text: string, appPackage: string, o: { after?: number; seenAtMark?: ReadonlySet<string>; secrets?: readonly string[] } = {}): AppCrash[] {
    const secrets = o.secrets ?? [];
    const lines = parseLogLines(text).filter((l) => o.after === undefined || l.at > o.after || (l.at === o.after && o.seenAtMark !== undefined && !o.seenAtMark.has(l.raw)));
    const out: AppCrash[] = [];
    for (let i = 0; i < lines.length && out.length < MAX_CRASHES; i++) {
        const l = lines[i]!;
        // A Java/Kotlin crash: "FATAL EXCEPTION: main", "Process: <pkg>, PID: <pid>", the exception, then "\tat ..." lines.
        if (l.tag === "AndroidRuntime" && /^FATAL EXCEPTION\b/.test(l.msg)) {
            const same = [] as LogLine[];
            for (let j = i + 1; j < lines.length && same.length < 200; j++) {
                const n = lines[j]!;
                if (n.pid !== l.pid || n.tag !== "AndroidRuntime") break;
                if (/^FATAL EXCEPTION\b/.test(n.msg)) break;
                same.push(n);
            }
            const proc = /^Process:\s*([A-Za-z][\w.]*(?::[\w.]+)?)/.exec(same[0]?.msg ?? "")?.[1];
            i += same.length;
            if (!proc || !isAppProcess(proc, appPackage)) continue;
            const body = same.slice(1).map((x) => x.msg);
            const first = body.findIndex((m) => m.trim() && !/^\s*at\s/.test(m));
            const exception = scrubLine((first >= 0 ? body[first]! : "An unknown exception").trim(), secrets);
            const stack = body.slice(first >= 0 ? first + 1 : 0).filter((m) => m.trim()).slice(0, MAX_STACK_LINES).map((m) => scrubLine(m.trim(), secrets));
            out.push({ kind: "crash", package: proc, exception, stack, at: l.at });
            continue;
        }
        // A native crash: "Fatal signal 11 (SIGSEGV), code 1 ..., pid 4321 (com.example.app)", then the backtrace from the crash dumper.
        if (/^Fatal signal \d+/.test(l.msg)) {
            const name = /\bpid\s+\d+\s+\(([^)]{1,200})\)/.exec(l.msg)?.[1] ?? /\(([A-Za-z][\w.]*(?::[\w.]+)?)\)/.exec(l.msg)?.[1] ?? "";
            if (!isAppProcess(name, appPackage)) continue;
            const signal = /^(Fatal signal \d+(?: \([A-Z]+\))?)/.exec(l.msg)?.[1] ?? "Fatal signal";
            const stack: string[] = [];
            for (let j = i + 1; j < lines.length && stack.length < MAX_STACK_LINES; j++) {
                const n = lines[j]!;
                if (n.at - l.at > 10) break;
                if (/^\s*#\d{2}\s+pc\s/.test(n.msg) || /^(signal|Abort message|Cmdline|backtrace:)/.test(n.msg.trim())) stack.push(scrubLine(n.msg.trim(), secrets));
                if (/^Fatal signal \d+/.test(n.msg) || (n.tag === "AndroidRuntime" && /^FATAL EXCEPTION\b/.test(n.msg))) break;
            }
            out.push({ kind: "native", package: name, exception: `${signal}: the app's native code stopped`, stack, at: l.at });
            continue;
        }
        // A freeze: "ANR in <pkg> (<pkg>/.Activity)", then "PID:", "Reason: ...", load and CPU lines.
        const anr = l.tag === "ActivityManager" ? /^ANR in ([A-Za-z][\w.]*(?::[\w.]+)?)/.exec(l.msg) : null;
        if (anr) {
            const proc = anr[1]!;
            const details: string[] = [];
            for (let j = i + 1; j < lines.length && details.length < MAX_STACK_LINES; j++) {
                const n = lines[j]!;
                if (n.tag !== "ActivityManager" || n.pid !== l.pid || /^ANR in /.test(n.msg)) break;
                details.push(n.msg);
            }
            i += details.length;
            if (!isAppProcess(proc, appPackage)) continue;
            const reason = details.find((d) => /^Reason:/.test(d.trim()))?.trim().replace(/^Reason:\s*/, "") ?? "the app did not answer in time";
            out.push({ kind: "anr", package: proc, exception: scrubLine(reason, secrets), stack: details.filter((d) => d.trim() && !/^Reason:/.test(d.trim())).slice(0, MAX_STACK_LINES).map((d) => scrubLine(d.trim(), secrets)), at: l.at });
        }
    }
    return out;
}
