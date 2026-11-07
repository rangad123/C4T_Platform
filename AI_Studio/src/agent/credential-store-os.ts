/**
 * The commands behind the credential store (credential-store.ts) on Windows and macOS, built here so they can be unit-tested without a real
 * Keychain or DPAPI. The token always travels on stdin, never on a command line (other users can read command lines).
 */
import { spawn } from "node:child_process";

export interface Command {
    cmd: string;
    args: string[];
    stdin: string;
}
export type CommandRunner = (cmd: string, args: string[], stdin: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const KEYCHAIN_SERVICE = "Crowd4Test AI Studio runner";

/** A value inside double quotes for `security -i` (its own command line): backslashes and quotes escaped, no line breaks. */
export const securityQuote = (v: string): string => `"${v.replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * macOS: the login Keychain through `security`. Adding goes through `security -i` with the command on stdin, so the token is not in any
 * process's arguments; finding prints only the password (`-w`) on stdout.
 */
export function keychainCommands(account: string): { add(token: string): Command; find: Command; remove: Command } {
    const base = ["-s", KEYCHAIN_SERVICE, "-a", account];
    return {
        add: (token) => ({ cmd: "/usr/bin/security", args: ["-i"], stdin: `add-generic-password -U -s ${securityQuote(KEYCHAIN_SERVICE)} -a ${securityQuote(account)} -l ${securityQuote(KEYCHAIN_SERVICE)} -w ${securityQuote(token)}\n` }),
        find: { cmd: "/usr/bin/security", args: ["find-generic-password", ...base, "-w"], stdin: "" },
        remove: { cmd: "/usr/bin/security", args: ["delete-generic-password", ...base], stdin: "" },
    };
}

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const PROTECT =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); " +
    "$p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($t),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    "[Console]::Out.Write([Convert]::ToBase64String($p))";
const UNPROTECT =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); " +
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))";

/** Windows: DPAPI for the current user through PowerShell. The token (or the protected blob) goes in on stdin; the script is fixed text. */
export function dpapiCommands(): { protect(token: string): Command; unprotect(blob: string): Command } {
    return {
        protect: (token) => ({ cmd: "powershell.exe", args: [...PS, PROTECT], stdin: token }),
        unprotect: (blob) => ({ cmd: "powershell.exe", args: [...PS, UNPROTECT], stdin: blob }),
    };
}

/** Run a program, give it `stdin`, collect what it prints (at most 64 KB each), and give up after 20 seconds. */
export const runCommand: CommandRunner = (cmd, args, stdin) =>
    new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let done = false;
        const finish = (code: number) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        };
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
        } catch {
            return resolve({ code: -1, stdout: "", stderr: "could not start" });
        }
        const timer = setTimeout(() => {
            child.kill();
            finish(-1);
        }, 20_000);
        child.stdout?.on("data", (d: Buffer) => void (stdout.length < 65_536 && (stdout += d.toString("utf8"))));
        child.stderr?.on("data", (d: Buffer) => void (stderr.length < 65_536 && (stderr += d.toString("utf8"))));
        child.on("error", () => finish(-1));
        child.on("close", (code) => finish(code ?? -1));
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(stdin);
    });
