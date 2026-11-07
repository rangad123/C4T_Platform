/**
 * The graceful stop on Windows (round 39): the installer's tray program writes stop.request in the runner's folder, waits up to 25 seconds
 * for the runner to report its running test and exit, and only then ends it hard. Part 1 RUNS the agent-side helpers (src/agent/stop-file.ts)
 * on real files. Part 2 READS the C# sources (no C# compiler on Linux or macOS): the file name and the wait match the agent's, the request
 * is written before the hard stop, a leftover request is cleared at start, and the other round 39 installer rules are in the code
 * (enrollment arguments, sign-in start on by default, npm ci with the lock file, the credential forgotten on uninstall). The Windows
 * program itself runs in tests/installer-win.test.ts (Windows only) and in .github/workflows/runner-matrix.yml.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { clearStopRequest, requestStop, STOP_FILE, STOP_GRACE_MS, stopFilePath, watchStopFile } from "../src/agent/stop-file.js";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-stopfile-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cs = (f: string) => fs.readFileSync(path.join(REPO, "installer", "win", f), "utf8");

describe("the agent side of the stop file", () => {
    it("calls back once when the file appears, deletes it, and a cleared leftover never stops a start", async () => {
        const dir = fs.mkdtempSync(path.join(tmp, "r-"));
        requestStop(dir);
        expect(fs.existsSync(stopFilePath(dir))).toBe(true);
        clearStopRequest(dir);
        expect(fs.existsSync(stopFilePath(dir))).toBe(false);
        let stops = 0;
        const end = watchStopFile(dir, () => stops++, 20);
        await new Promise((r) => setTimeout(r, 80));
        expect(stops).toBe(0);
        requestStop(dir);
        await new Promise((r) => setTimeout(r, 120));
        expect(stops).toBe(1);
        expect(fs.existsSync(stopFilePath(dir))).toBe(false);
        // Only once, even if it is written again.
        requestStop(dir);
        await new Promise((r) => setTimeout(r, 80));
        expect(stops).toBe(1);
        end();
        // The file holds a time stamp, nothing else.
        expect(fs.readFileSync(stopFilePath(dir), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/);
    });
});

describe("the Windows host (read, not run)", () => {
    const host = cs("RunnerHost.cs");
    const common = cs("Common.cs");
    const engine = cs("Engine.cs");

    it("uses the agent's file name and wait, writes the request before it ends the runner hard, and clears a leftover at start", () => {
        expect(common).toContain(`public const string StopFile = "${STOP_FILE}";`);
        expect(common).toContain(`public const int StopGraceMs = ${STOP_GRACE_MS};`);
        const stop = host.slice(host.indexOf("public void Stop()"), host.indexOf("void Loop()"));
        expect(stop).toContain("StopChildGracefully();");
        expect(stop).not.toContain("KillChild();");
        const graceful = host.slice(host.indexOf("void StopChildGracefully()"), host.indexOf("void KillChild()"));
        const write = graceful.indexOf("File.WriteAllText(request");
        const wait = graceful.indexOf("p.WaitForExit(Product.StopGraceMs)");
        const kill = graceful.indexOf("KillChild()");
        expect(write).toBeGreaterThan(0);
        expect(wait).toBeGreaterThan(write);
        expect(kill).toBeGreaterThan(wait);
        expect(graceful).toContain("if (!exited) KillChild();");
        const start = host.slice(host.indexOf("public void Start()"), host.indexOf("public void Stop()"));
        expect(start).toContain("File.Delete(Path.Combine(lay.App, Product.StopFile))");
    });

    it("starts the runner with the one-time code, else an older download's token, else its saved credential; never with the secret on the command line", () => {
        const args = host.slice(host.indexOf("public static string CredentialArgs"), host.indexOf("static readonly Regex Warn"));
        expect(args.indexOf('"runner.enroll"')).toBeLessThan(args.indexOf('"runner.token"'));
        expect(args).toContain('" --enroll-file runner.enroll"');
        expect(args).toContain('" --token-file runner.token"');
        expect(host).toContain('new ProcessStartInfo(nodePath, "runner.mjs" + CredentialArgs(lay.App))');
        expect(host).not.toMatch(/--token [^-]|--enroll [^-]/);
    });

    it("copies a one-time code once (by its sha256, never the code), restricts it to this user, and lets it replace an older token", () => {
        expect(engine).toContain('if (name == "runner.enroll" && Util.Sha256File(src) == State.EnrollSha) return false;');
        expect(engine).toContain("State.EnrollSha = sha;");
        expect(engine).toContain('if (name == "runner.enroll" || name == "runner.token") RestrictToCurrentUser(dst);');
        expect(engine).toContain('File.Delete(Path.Combine(L.App, "runner.token"))');
    });

    it("starts at sign-in by default (window and silent), installs with npm ci --ignore-scripts from the lock file, and forgets the credential on uninstall", () => {
        expect(cs("Ui.cs")).toContain("CbStartup.Checked = true;");
        expect(cs("Program.cs")).toContain("bool atSignIn = !o.NoStartAtSignIn;");
        expect(common).toContain('case "--no-start-at-sign-in": o.NoStartAtSignIn = true; break;');
        expect(engine).toContain('string npmArgs = locked ? " ci --ignore-scripts --no-audit --no-fund" : " install --no-audit --no-fund";');
        const uninstall = engine.slice(engine.indexOf("public List<string> Uninstall("));
        expect(uninstall.indexOf("removed.Add(ForgetCredential());")).toBeLessThan(uninstall.indexOf("Util.DeleteTree(d)"));
        expect(engine).toContain('Util.Run(node, "runner.mjs --forget-credential", 30000, L.App, null)');
        // C# 5 only (the compiler that ships with Windows): no string interpolation, no null-conditional, no nameof.
        for (const f of ["RunnerHost.cs", "Engine.cs", "Common.cs", "Program.cs", "Ui.cs"]) expect(cs(f), f).not.toMatch(/[\s(=,]\$@?"|\w\?\.\w|nameof\(/);
    });
});
