/**
 * Round 39: the runner's credential store and its command line. The Linux file store is exercised for real; Windows (DPAPI through PowerShell)
 * and macOS (the login Keychain through `security`) are checked through the commands they build, with a stand-in runner: there is no real
 * DPAPI or Keychain on the machine these tests run on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseAgentArgs } from "../src/agent/config.js";
import { CREDENTIAL_FILE, deleteCredential, loadCredential, machineIdFor, saveCredential } from "../src/agent/credential-store.js";
import { dpapiCommands, keychainCommands, securityQuote, type CommandRunner } from "../src/agent/credential-store-os.js";
import { applyKitDefaults } from "../src/agent/kit.js";
import { main } from "../src/agent/main.js";

const TOKEN = `aitg_${"Ab3_".repeat(11)}`;
const CODE = `aite_${"Zx9-".repeat(11)}`;
const dirs: string[] = [];
const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-cred-"));
    dirs.push(d);
    return d;
};
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("the credential store", () => {
    it("Linux: a file only its owner can read, read back, removed", async () => {
        const dir = tmp();
        expect(await loadCredential(dir, { platform: "linux" })).toBeNull();
        await saveCredential(dir, TOKEN, { platform: "linux" });
        const file = path.join(dir, CREDENTIAL_FILE);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(await loadCredential(dir, { platform: "linux" })).toBe(TOKEN);
        await deleteCredential(dir, { platform: "linux" });
        expect(fs.existsSync(file)).toBe(false);
        await expect(saveCredential(dir, "not-a-token", { platform: "linux" })).rejects.toThrow("not a runner credential");
    });

    it("Windows: DPAPI through PowerShell, the token only on stdin, the file holds the protected blob", async () => {
        const dir = tmp();
        const calls: Array<{ cmd: string; args: string[]; stdin: string }> = [];
        const run: CommandRunner = async (cmd, args, stdin) => {
            calls.push({ cmd, args, stdin });
            const script = args[args.length - 1]!;
            if (script.includes("::Protect(")) return { code: 0, stdout: Buffer.from(`sealed:${stdin}`).toString("base64"), stderr: "" };
            return { code: 0, stdout: Buffer.from(stdin, "base64").toString("utf8").replace(/^sealed:/, ""), stderr: "" };
        };
        await saveCredential(dir, TOKEN, { platform: "win32", run });
        const text = fs.readFileSync(path.join(dir, CREDENTIAL_FILE), "utf8");
        expect(text.startsWith("dpapi:")).toBe(true);
        expect(text).not.toContain(TOKEN);
        expect(await loadCredential(dir, { platform: "win32", run })).toBe(TOKEN);
        for (const c of calls) {
            expect(c.cmd).toBe("powershell.exe");
            expect(c.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
            expect(c.args.join(" ")).not.toContain(TOKEN);
            expect(c.args.join(" ")).toContain("DataProtectionScope]::CurrentUser");
        }
        expect(calls[0]!.stdin).toBe(TOKEN);
        // A refusal (another Windows account) is a plain sentence, never the blob or the token.
        await expect(loadCredential(dir, { platform: "win32", run: async () => ({ code: 1, stdout: "", stderr: "denied" }) })).rejects.toThrow("Windows account that added this computer");
        expect(dpapiCommands().unprotect("QUJD").stdin).toBe("QUJD");
    });

    it("macOS: the login Keychain through security; adding sends the token on stdin (security -i), never as an argument", async () => {
        const dir = tmp();
        const calls: Array<{ cmd: string; args: string[]; stdin: string }> = [];
        const kept = new Map<string, string>();
        const run: CommandRunner = async (cmd, args, stdin) => {
            calls.push({ cmd, args, stdin });
            if (args[0] === "-i") {
                kept.set(dir, /-w "([^"]+)"/.exec(stdin)![1]!);
                return { code: 0, stdout: "", stderr: "" };
            }
            if (args[0] === "find-generic-password") return kept.has(dir) ? { code: 0, stdout: `${kept.get(dir)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." };
            kept.delete(dir);
            return { code: 0, stdout: "", stderr: "" };
        };
        expect(await loadCredential(dir, { platform: "darwin", run })).toBeNull();
        await saveCredential(dir, TOKEN, { platform: "darwin", run });
        expect(fs.existsSync(path.join(dir, CREDENTIAL_FILE))).toBe(false);
        expect(await loadCredential(dir, { platform: "darwin", run })).toBe(TOKEN);
        await deleteCredential(dir, { platform: "darwin", run });
        expect(await loadCredential(dir, { platform: "darwin", run })).toBeNull();
        for (const c of calls) {
            expect(c.cmd).toBe("/usr/bin/security");
            expect(c.args.join(" ")).not.toContain(TOKEN);
        }
        const add = keychainCommands("/Users/t/Runner \"x\"").add(TOKEN);
        expect(add.stdin).toContain('-a "/Users/t/Runner \\"x\\""');
        expect(add.stdin).toContain("-U");
        expect(keychainCommands("/r").find.args).toEqual(["find-generic-password", "-s", "Crowd4Test AI Studio runner", "-a", "/r", "-w"]);
        expect(securityQuote('a\\b"c\nd')).toBe('"a\\\\b\\"c d"');
    });

    it("the install id is made once and kept", () => {
        const dir = tmp();
        const id = machineIdFor(dir);
        expect(id).toMatch(/^[A-Za-z0-9-]{16,64}$/);
        expect(machineIdFor(dir)).toBe(id);
    });
});

describe("the command line", () => {
    const base = { AITP_URL: "https://tests.example.com" };
    it("--enroll, --enroll-file and no token at all mean the credential store; a bad code is refused", () => {
        const dir = tmp();
        const flag = parseAgentArgs(["--enroll", CODE, "--work-dir", dir], base);
        expect(flag).toMatchObject({ kind: "run", config: { token: "", tokenSource: "store", enroll: { code: CODE, explicit: true }, credentialDir: dir } });
        fs.writeFileSync(path.join(dir, "runner.enroll"), `${CODE}\n`);
        expect(parseAgentArgs(["--enroll-file", path.join(dir, "runner.enroll")], base)).toMatchObject({ kind: "run", config: { enroll: { code: CODE, explicit: false } } });
        expect(parseAgentArgs([], base)).toMatchObject({ kind: "run", config: { token: "", tokenSource: "store" } });
        expect(parseAgentArgs(["--enroll", "aitg_nope_nope_nope_nope_nope"], base)).toMatchObject({ kind: "error" });
        expect(parseAgentArgs(["--token", TOKEN], base)).toMatchObject({ kind: "run", config: { token: TOKEN, tokenSource: "flag" } });
        expect(parseAgentArgs(["--forget-credential"], { AITP_CREDENTIAL_DIR: dir })).toEqual({ kind: "forget", credentialDir: dir });
    });

    it("a download's runner.enroll is found next to the runner, and the credential is kept for that folder", () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, "runner.json"), JSON.stringify({ url: "https://tests.example.com", name: "Laptop" }));
        fs.writeFileSync(path.join(dir, "runner.enroll"), `${CODE}\n`);
        const kit = applyKitDefaults({}, dir);
        expect(kit).toMatchObject({ kit: true, env: { AITP_AGENT_ENROLL_FILE: path.join(dir, "runner.enroll"), AITP_CREDENTIAL_DIR: dir } });
    });

    it("no credential and no code: a plain usage error; --forget-credential removes what is kept", async () => {
        const dir = tmp();
        const err: string[] = [];
        const code = await main([], { env: { ...base, AITP_CREDENTIAL_DIR: dir, AITP_AGENT_WORK_DIR: dir }, out: () => undefined, err: (l) => err.push(l) });
        expect(code).toBe(2);
        expect(err.join(" ")).toContain("--enroll <code>");
        await saveCredential(dir, TOKEN, { platform: "linux" });
        const out: string[] = [];
        expect(await main(["--forget-credential"], { env: { AITP_CREDENTIAL_DIR: dir }, out: (l) => out.push(l), err: () => undefined, credentialStore: { platform: "linux" } })).toBe(0);
        expect(fs.existsSync(path.join(dir, CREDENTIAL_FILE))).toBe(false);
        expect(out.join(" ")).not.toContain(TOKEN);
    });
});
