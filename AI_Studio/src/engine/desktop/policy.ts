/**
 * Which applications this computer may start, decided by the computer and never by a spec.
 *
 * The allow-list lives with the machine that runs the tests:
 *  - a runner agent: `--allow-app <exe path or name>` (repeatable), `AITP_ALLOW_APPS` (semicolon-separated) and an
 *    `--allow-apps-file` (one entry per line);
 *  - the platform host itself: `DESKTOP_ALLOWED_APPS` (semicolon-separated).
 * Matching is on the RESOLVED full path, case-insensitive, no wildcards. A name such as `calc.exe` is looked up on the
 * PATH and in the Windows folders, so it stands for one real file. The hard deny-list (command shells, script hosts and so on,
 * ./target.ts) wins over the allow-list: a shell on the list is still refused.
 *
 * The decision itself is made by the helper text (./helper.ts), the same text the generated script carries, so the platform's
 * pre-flight check and the script's own check cannot disagree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { jsLit, loadDesktopRuntime, type DesktopRuntime } from "./helper.js";
import { DesktopTargetSchema, type DesktopTarget } from "./target.js";

/** The line in a generated script that holds the spec's target (data, read by the pre-flight check). */
export const DESKTOP_TARGET_RE = /^const DESKTOP_TARGET = (.+); \/\/ aitp:target$/m;
/** The line the run replaces with this computer's policy. Absent from the stored script: a downloaded script reads DESKTOP_ALLOWED_APPS instead. */
export const DESKTOP_POLICY_LINE = "const DESKTOP_POLICY = null; // aitp:policy";
const DESKTOP_POLICY_RE = /^const DESKTOP_POLICY = null; \/\/ aitp:policy$/m;

let runtime: DesktopRuntime | undefined;
/** The helper compiled against this machine's real modules. */
export function desktopRuntime(): DesktopRuntime {
    runtime ??= loadDesktopRuntime({ fs, path, os, spawn, process });
    return runtime;
}

/** The entries of a semicolon-separated list (DESKTOP_ALLOWED_APPS, AITP_ALLOW_APPS). */
export const parseAllowList = (raw: string | undefined): string[] => desktopRuntime().desktopParseList(raw ?? "");

/** The platform host's own allow-list. */
export const hostAllowList = (env: NodeJS.ProcessEnv = process.env): string[] => parseAllowList(env.DESKTOP_ALLOWED_APPS);

export type AppDecision = { ok: true; full: string } | { ok: false; code: "denied" | "notallowed" | "notfound" | "invalid" | "platform"; message: string };

/** May this computer start `app`? `via` names where its allow-list is kept, for the wording of the refusal. */
export function checkApp(app: string, allow: readonly string[], via: "agent" | "host", platform: NodeJS.Platform = process.platform): AppDecision {
    if (platform !== "win32") return { ok: false, code: "platform", message: "Windows desktop tests can only run on a Windows computer." };
    const rt = desktopRuntime();
    const r = rt.desktopCheckApp(app, [...allow]);
    if (r.ok) return { ok: true, full: r.full };
    return { ok: false, code: r.code, message: rt.desktopRefusalText(r, via) };
}

/** The target a generated script carries, or undefined when the text has none (or it is not valid). */
export function targetOfScript(content: string): DesktopTarget | undefined {
    const m = DESKTOP_TARGET_RE.exec(content);
    if (!m) return undefined;
    try {
        const parsed = DesktopTargetSchema.safeParse(JSON.parse(m[1]!));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export interface ScriptPolicy {
    /** Resolved full paths and names this computer allows. */
    allow: string[];
    /** Where the allow-list is kept ("agent" = --allow-app, "host" = DESKTOP_ALLOWED_APPS). */
    via: "agent" | "host";
    /** A private folder for the host script and the ledger of started processes; the caller sweeps it after the run. */
    dir: string;
}

/** The script with this computer's policy filled in (the stored script is not changed). */
export function withPolicy(content: string, policy: ScriptPolicy): string {
    const line = `const DESKTOP_POLICY = ${jsLit(policy)}; // aitp:policy`;
    return DESKTOP_POLICY_RE.test(content) ? content.replace(DESKTOP_POLICY_RE, () => line) : content;
}

/** The allow-list as full paths of programs that exist (shown in the agent's capabilities; names that resolve to nothing are left out). */
export function resolvedAllowList(allow: readonly string[]): string[] {
    const rt = desktopRuntime();
    const out = new Set<string>();
    for (const entry of allow) {
        if (rt.desktopIsDenied(entry)) continue;
        const r = rt.desktopResolve(entry);
        if (r.full && !rt.desktopIsDenied(r.full)) out.add(r.full);
    }
    return [...out];
}

/** The `app` a script's target line names, even when the rest of the target is not valid (so a refusal can still say which program it was). */
function appOfScript(content: string): string | undefined {
    const m = DESKTOP_TARGET_RE.exec(content);
    if (!m) return undefined;
    try {
        const j = JSON.parse(m[1]!) as { app?: unknown };
        return typeof j?.app === "string" ? j.app : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Why this computer will not run this desktop script, in plain words, or undefined when it may: not a desktop script, an application
 * that is on the hard deny-list or not on the allow-list, or settings that are not valid. The one decision both the adapter and the
 * agent's task runner use before anything is started.
 */
export function scriptRefusal(content: string, allow: readonly string[], via: "agent" | "host", platform: NodeJS.Platform = process.platform): string | undefined {
    const app = appOfScript(content);
    if (app === undefined) return "This script is not a Windows desktop test (it has no valid application target).";
    const decision = checkApp(app, allow, via, platform);
    if (!decision.ok) return decision.message;
    if (!targetOfScript(content)) return "This script's application settings are not valid, so it was not run.";
    return undefined;
}
