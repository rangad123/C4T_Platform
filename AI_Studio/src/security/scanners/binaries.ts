/**
 * Finding the scanner binaries an administrator installed. Nothing else in the module looks for an executable.
 *
 * The order is always the same, and it never includes a path that came from a request:
 *   1. the explicit path the administrator configured (SECURITY_NUCLEI_PATH and its friends),
 *   2. the directories in SECURITY_SCANNER_BIN_DIRS,
 *   3. the directories on PATH.
 *
 * On Windows a bare name also matches the `.exe`, `.cmd`, `.bat` and `.com` forms, and a candidate is only accepted when it is a real file
 * that Node can execute. The result is an absolute path, so the value that reaches `spawn` is never relative to whatever directory
 * the platform happens to be running in.
 *
 * The extensionless name is NOT tried on Windows, and the order matters. Node cannot `spawn` a file that has no extension there, and
 * npm's `node_modules/.bin` directories contain a POSIX shell script next to every Windows shim: `promptfoo` (a `sh` script) sits beside
 * `promptfoo.cmd`. Accepting the bare name first picks the shell script, and every run then fails with a bare `spawn ... ENOENT` that says
 * nothing about the real problem. Only the forms Windows can actually execute are considered.
 */
import fs from "node:fs";
import path from "node:path";
import { isExecutableFile } from "./process.js";

const WINDOWS_EXTENSIONS = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];

const directoriesOf = (dirs: readonly string[]): string[] => dirs.map((d) => d.trim()).filter(Boolean);

/** Every place a bare name may live, PATH last. */
function candidateDirs(binDirs: readonly string[]): string[] {
    const pathValue = process.env.PATH ?? process.env.Path ?? "";
    const separator = process.platform === "win32" ? ";" : ":";
    return [...directoriesOf(binDirs), ...pathValue.split(separator).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean)];
}

/**
 * The absolute path of `name`, or undefined when it is not installed here. An explicit `configured` path that exists wins even when
 * its file name is something else, which is how a renamed or packaged scanner is used.
 */
export function resolveExecutable(name: string, configured: string | undefined, binDirs: readonly string[] = []): string | undefined {
    const explicit = (configured ?? "").trim();
    if (explicit) {
        const absolute = path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
        return isExecutableFile(absolute) ? absolute : undefined;
    }
    for (const dir of candidateDirs(binDirs)) {
        for (const extension of WINDOWS_EXTENSIONS) {
            const candidate = path.join(dir, `${name}${extension}`);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return undefined;
}

/** The plain sentence for "it is not installed here", naming the variable that would fix it. */
export function notInstalledReason(name: string, envVar: string, install: string): { reason: string; remedy: string } {
    return {
        reason: `${name} is not installed on this machine (no executable called "${name}" was found).`,
        remedy: `${install} Then set ${envVar} to the full path of the executable, or put its directory in SECURITY_SCANNER_BIN_DIRS, and restart the platform.`,
    };
}

/** The plain sentence for "installed, but nothing says where it should run". */
export function notConfiguredReason(what: string, envVar: string): { reason: string; remedy: string } {
    return { reason: `${what} is not configured on this platform.`, remedy: `Set ${envVar} in the environment file and restart the platform.` };
}

/** True when a path names a directory with at least one file in it (used for template directories). */
export function hasFilesIn(dir: string): boolean {
    try {
        return fs.readdirSync(dir).some((entry) => fs.statSync(path.join(dir, entry)).isFile());
    } catch {
        return false;
    }
}
