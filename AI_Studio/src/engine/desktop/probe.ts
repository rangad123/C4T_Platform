/**
 * Can this computer run Windows desktop tests right now?
 *
 * One short, windowless PowerShell run that loads the UI Automation assemblies and reads two facts about the session: whether
 * it is interactive (not a Windows service) and whether it is elevated (administrator). It opens no window and touches no
 * application. The answer is cached for 30 seconds. On other operating systems the answer is "no" without running anything.
 *
 * A locked screen cannot be detected from here: UI Automation simply finds nothing then, and the test says so when it times out.
 */
import { execFile } from "node:child_process";
import path from "node:path";

export interface DesktopProbeResult {
    /** powershell.exe exists and the UIA assemblies load. */
    uiautomation: boolean;
    /** The session is interactive (a signed-in user, not a Windows service). */
    interactive: boolean;
    /** The process runs as administrator. Desktop tests refuse to run elevated. */
    elevated: boolean;
}

export const DESKTOP_PROBE_CACHE_MS = 30_000;

/** The probe script: fixed text, no input. Single quotes only (it travels as one command-line argument, no shell). */
export const PROBE_COMMAND = [
    "$ErrorActionPreference = 'Stop'",
    "$u = $true",
    "try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes } catch { $u = $false }",
    "$e = $false",
    "try { $e = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator) } catch { }",
    "'uiautomation=' + $u + ';interactive=' + [Environment]::UserInteractive + ';elevated=' + $e",
].join("; ");

export type RunPowerShell = (args: string[], timeoutMs: number) => Promise<string | undefined>;

const powerShellExe = (env: NodeJS.ProcessEnv): string => path.win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const runReal =
    (env: NodeJS.ProcessEnv): RunPowerShell =>
    (args, timeoutMs) =>
        new Promise((resolve) => {
            try {
                execFile(powerShellExe(env), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error ? undefined : String(stdout)));
            } catch {
                resolve(undefined);
            }
        });

/** Parse the probe's one line (`uiautomation=True;interactive=True;elevated=False`). Anything else counts as "not available". */
export function parseProbe(text: string | undefined): DesktopProbeResult {
    const facts = new Map<string, boolean>();
    const lines = (text ?? "").trim().split(/\r?\n/);
    const last = lines[lines.length - 1] ?? "";
    for (const part of last.split(";")) {
        const m = /^(uiautomation|interactive|elevated)=(True|False)$/i.exec(part.trim());
        if (m) facts.set(m[1]!.toLowerCase(), m[2]!.toLowerCase() === "true");
    }
    return { uiautomation: facts.get("uiautomation") === true, interactive: facts.get("interactive") === true, elevated: facts.get("elevated") === true };
}

export interface DesktopProbeOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    run?: RunPowerShell;
    now?: () => number;
    cacheMs?: number;
}

let shared: { at: number; value: DesktopProbeResult } | undefined;

/** The probe's answer (cached). On a computer that is not Windows: never available, nothing is run. */
export async function probeDesktop(opts: DesktopProbeOptions = {}): Promise<DesktopProbeResult> {
    const platform = opts.platform ?? process.platform;
    if (platform !== "win32") return { uiautomation: false, interactive: false, elevated: false };
    const now = (opts.now ?? Date.now)();
    // A caller that injects its own runner (tests) never shares the cache with the real one.
    const useShared = !opts.run;
    if (useShared && shared && now - shared.at < (opts.cacheMs ?? DESKTOP_PROBE_CACHE_MS)) return shared.value;
    const run = opts.run ?? runReal(opts.env ?? process.env);
    const value = parseProbe(await run(["-NoProfile", "-NonInteractive", "-Command", PROBE_COMMAND], 20_000));
    if (useShared) shared = { at: (opts.now ?? Date.now)(), value };
    return value;
}

/** The last answer without waiting (undefined before the first probe). Used where a synchronous check is needed. */
export const lastProbe = (): DesktopProbeResult | undefined => shared?.value;

/** Why desktop tests cannot run here, in plain words, or undefined when they can. */
export function desktopUnavailableReason(platform: NodeJS.Platform, p: DesktopProbeResult | undefined): string | undefined {
    if (platform !== "win32") return "Windows desktop tests can only run on a Windows computer.";
    if (!p) return undefined;
    if (!p.uiautomation) return "Windows UI Automation is not available on this computer.";
    if (p.elevated) return "This process runs as administrator. Desktop tests do not run elevated: start it as a normal user.";
    if (!p.interactive) return "This session has no interactive desktop. Desktop tests need a signed-in user session (not a Windows service), and the screen must not be locked.";
    return undefined;
}
