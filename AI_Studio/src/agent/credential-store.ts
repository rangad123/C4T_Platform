/**
 * Where a runner keeps its credential (round 39): the `aitg_` token it got by trading its enrollment code, in the computer's own store.
 *
 *   Windows  a file `runner.credential` in the runner's folder holding the token protected with DPAPI for the current user (PowerShell's
 *            System.Security.Cryptography.ProtectedData, CurrentUser scope). Only this Windows account on this computer can read it back.
 *   macOS    the login Keychain: a generic password, service "Crowd4Test AI Studio runner", account = the runner's folder.
 *   Linux    a file `runner.credential` in the runner's folder, readable only by its owner (0600). Not encrypted.
 *
 * What this protects against, honestly: other people's accounts on the same computer, and a copied disk or backup (Windows, macOS). It does
 * not protect against programs that run as the same user, which includes the tests the runner runs: such a program can ask DPAPI or the
 * Keychain the same way. The token is never put on a command line (it travels on stdin), never printed and never logged.
 *
 * `--token`, `--token-file` and AITP_AGENT_TOKEN keep working for development and older installs; they do not touch this store.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { keychainCommands, dpapiCommands, runCommand, type CommandRunner } from "./credential-store-os.js";

export const CREDENTIAL_FILE = "runner.credential";
export const MACHINE_ID_FILE = "runner.machine";
export const ENROLL_FILE = "runner.enroll";
export const KEYCHAIN_SERVICE = "Crowd4Test AI Studio runner";

const TOKEN_SHAPE = /^aitg_[A-Za-z0-9_-]{20,200}$/;

export interface StoreDeps {
    platform?: NodeJS.Platform;
    /** Runs a program with stdin; replaced in tests (no real Keychain or DPAPI on the test machine). */
    run?: CommandRunner;
}

/** Thrown with a plain sentence when the computer's store could not be used. Never carries the token. */
export class CredentialStoreError extends Error {}

const platformOf = (d?: StoreDeps) => d?.platform ?? process.platform;

/** The runner's credential, or null when none is stored (or what is stored is not a credential). */
export async function loadCredential(dir: string, deps?: StoreDeps): Promise<string | null> {
    const platform = platformOf(deps);
    const run = deps?.run ?? runCommand;
    if (platform === "darwin") {
        const c = keychainCommands(dir).find;
        const out = await run(c.cmd, c.args, c.stdin);
        // 44: no such item. Anything else that fails says so, plainly.
        if (out.code === 44 || /could not be found/i.test(out.stderr)) return null;
        if (out.code !== 0) throw new CredentialStoreError("The runner could not read its credential from the login Keychain. Unlock the Keychain (sign in to this Mac), then start the runner again.");
        const token = out.stdout.trim();
        return TOKEN_SHAPE.test(token) ? token : null;
    }
    const file = path.join(dir, CREDENTIAL_FILE);
    let text: string;
    try {
        text = (await fsp.readFile(file, "utf8")).trim();
    } catch {
        return null;
    }
    if (platform === "win32") {
        if (!text.startsWith("dpapi:")) return null;
        const c = dpapiCommands().unprotect(text.slice("dpapi:".length));
        const out = await run(c.cmd, c.args, c.stdin);
        if (out.code !== 0) throw new CredentialStoreError("The runner could not read its credential (Windows data protection refused). It works only for the Windows account that added this computer. Add this computer again in Settings, Your runner.");
        const token = out.stdout.trim();
        return TOKEN_SHAPE.test(token) ? token : null;
    }
    return TOKEN_SHAPE.test(text) ? text : null;
}

/** Keep the credential in the computer's store, replacing what was there. */
export async function saveCredential(dir: string, token: string, deps?: StoreDeps): Promise<void> {
    if (!TOKEN_SHAPE.test(token)) throw new CredentialStoreError("That is not a runner credential.");
    const platform = platformOf(deps);
    const run = deps?.run ?? runCommand;
    await fsp.mkdir(dir, { recursive: true });
    if (platform === "darwin") {
        const c = keychainCommands(dir).add(token);
        const out = await run(c.cmd, c.args, c.stdin);
        if (out.code !== 0) throw new CredentialStoreError("The runner could not keep its credential in the login Keychain. Unlock the Keychain (sign in to this Mac), then start the runner again.");
        return;
    }
    let content = token;
    if (platform === "win32") {
        const c = dpapiCommands().protect(token);
        const out = await run(c.cmd, c.args, c.stdin);
        const blob = out.stdout.trim();
        if (out.code !== 0 || !/^[A-Za-z0-9+/=]{16,}$/.test(blob)) throw new CredentialStoreError("The runner could not protect its credential with Windows data protection. Start it again; if that does not help, add this computer again in Settings, Your runner.");
        content = `dpapi:${blob}`;
    }
    await writePrivate(path.join(dir, CREDENTIAL_FILE), `${content}\n`);
}

/** Remove the stored credential (uninstall, `--forget-credential`). Nothing stored is fine. */
export async function deleteCredential(dir: string, deps?: StoreDeps): Promise<void> {
    const platform = platformOf(deps);
    const run = deps?.run ?? runCommand;
    if (platform === "darwin") {
        const c = keychainCommands(dir).remove;
        await run(c.cmd, c.args, c.stdin).catch(() => undefined);
    }
    await fsp.rm(path.join(dir, CREDENTIAL_FILE), { force: true });
}

/** Write a file only its owner can read, in one step (a temporary file renamed into place). */
async function writePrivate(file: string, text: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => undefined);
    await fsp.rename(tmp, file);
}

/**
 * This installation's random id, made once and kept next to the runner's settings: the platform binds a credential to it, so a copied
 * credential does not work from another computer. It is not secret and says nothing about the computer.
 */
export function machineIdFor(dir: string): string {
    const file = path.join(dir, MACHINE_ID_FILE);
    try {
        const v = fs.readFileSync(file, "utf8").trim();
        if (/^[A-Za-z0-9-]{16,64}$/.test(v)) return v;
    } catch {
        /* made below */
    }
    const id = crypto.randomUUID();
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${id}\n`, { mode: 0o644 });
    } catch {
        /* an id that cannot be kept is still this run's id; the next start makes a new one and the platform refuses it, which says why */
    }
    return id;
}
