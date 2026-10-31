/**
 * `npm run doctor` as a real program: spawned the way the npm script runs it (tsx, with .env loaded from the folder it starts in),
 * against a temp data folder and a temp working folder. Checks the exit code, the plain output, that a secret placed in the
 * environment and in a .env file never appears, and that nothing is left behind. Port 6197 is the platform port under test.
 * No browser, emulator or server is started by the program; this test only holds a port itself for the "in use" case.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";

const PORT = 6197;
const SENTINEL_ENV = "SENTINEL-env-5c1d9e-do-not-print";
const SENTINEL_FILE = "SENTINEL-file-77ab20-do-not-print";
const TSX = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const DOCTOR = path.join(REPO_ROOT, "src", "cli", "doctor.ts");

let work: string;
let dataDir: string;

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
        // A clean environment: only what the program needs to find Node and its folders, plus what this test sets.
        const base: Record<string, string> = {};
        for (const k of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]) if (process.env[k]) base[k] = process.env[k]!;
        const child = spawn(process.execPath, [TSX, "--env-file-if-exists=.env", DOCTOR, ...args], { cwd: work, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
    });
}

beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-doctor-cwd-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-doctor-data-"));
    fs.writeFileSync(path.join(dataDir, "keep.txt"), "mine");
    // A settings file whose value must never be printed (the program may only ask whether the file exists).
    fs.writeFileSync(path.join(work, ".env"), `LLM_API_KEY=${SENTINEL_FILE}\n`);
});
afterAll(() => {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const baseEnv = () => ({ DATA_DIR: dataDir, PORT: String(PORT), HOST: "127.0.0.1", ANTHROPIC_API_KEY: SENTINEL_ENV, SECRET_KEY: SENTINEL_ENV, SMTP_PASSWORD: SENTINEL_ENV, API_KEY: SENTINEL_ENV });

describe("npm run doctor", () => {
    it("prints a plain report, exits by what is missing, and keeps every secret out of it", async () => {
        const r = await run([], baseEnv());
        expect(r.err).toBe("");
        expect(r.out.startsWith("AI Testing Platform: preflight check\n")).toBe(true);
        expect(r.out).not.toContain(SENTINEL_ENV);
        expect(r.out).not.toContain(SENTINEL_FILE);
        expect(r.out).not.toMatch(/\p{Extended_Pictographic}/u);
        const lines = r.out.split("\n");
        const statusLines = lines.filter((l) => /^(ok|missing|optional) /.test(l));
        expect(statusLines.length).toBeGreaterThanOrEqual(15);
        // every check says what it is for, and every one that is not ok says how to fix it
        expect(lines.filter((l) => l.trim().startsWith("For: ")).length).toBe(statusLines.length);
        expect(lines.filter((l) => l.trim().startsWith("To fix: ")).length).toBe(statusLines.filter((l) => !l.startsWith("ok")).length);
        // the exit code follows what the report says
        const anyMissing = statusLines.some((l) => l.startsWith("missing"));
        expect(r.code).toBe(anyMissing ? 1 : 0);
        // what we know about this setup
        expect(r.out).toContain(`Port ${PORT} is free`);
        expect(r.out).toContain("The data folder is writable");
        expect(r.out).toContain("The settings file (.env) exists");
        expect(r.out).toContain("An AI provider key is set");
        expect(r.out).toContain("Hand-written scripts do not run on this computer");
        expect(r.out).toContain("Desktop tests may not start any application");
        expect(r.out).toMatch(/\n(Ready to run\..*|\d+ required things? (is|are) missing\..*)\n$/);
        // nothing left behind in the data folder, and the files that were there are untouched
        expect(fs.readdirSync(dataDir)).toEqual(["keep.txt"]);
        expect(fs.readFileSync(path.join(dataDir, "keep.txt"), "utf8")).toBe("mine");
        // the program did not keep the port or create anything in its working folder
        expect(fs.readdirSync(work)).toEqual([".env"]);
    }, 90_000);

    it("exits 1 and says how to fix it when the platform's port is taken, and lets the port go again", async () => {
        const held = net.createServer();
        await new Promise<void>((res) => held.listen(PORT, "127.0.0.1", () => res()));
        let r: Awaited<ReturnType<typeof run>>;
        try {
            r = await run([], baseEnv());
        } finally {
            await new Promise((res) => held.close(() => res(null)));
        }
        expect(r.code).toBe(1);
        expect(r.out).toMatch(new RegExp(`^missing +Port ${PORT} is not available \\(in use\\)$`, "m"));
        expect(r.out).toContain("To fix: Something is already listening there.");
        expect(r.out).toMatch(/\n\d+ required things? (is|are) missing\. Fix (it|them) and run this check again\.\n$/);
        expect(r.out).not.toContain(SENTINEL_ENV);
        // the held socket was ours; the program itself holds nothing
        await new Promise<void>((res, rej) => {
            const again = net.createServer();
            again.once("error", rej);
            again.listen(PORT, "127.0.0.1", () => again.close(() => res()));
        });
    }, 90_000);

    it("names a setting it cannot use without printing its value", async () => {
        const r = await run([], { ...baseEnv(), CONCURRENCY: SENTINEL_ENV });
        expect(r.code).toBe(1);
        expect(r.out).toContain("These settings have a value the platform cannot use: CONCURRENCY");
        expect(r.out).not.toContain(SENTINEL_ENV);
    }, 90_000);

    it("shows help without checking anything", async () => {
        const r = await run(["--help"], baseEnv());
        expect(r.code).toBe(0);
        expect(r.out).toContain("Usage: npm run doctor");
        expect(r.out).not.toContain("preflight check");
    }, 60_000);
});
