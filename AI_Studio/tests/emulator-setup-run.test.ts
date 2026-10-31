/**
 * The emulator setup scripts (src/platform/emulator-setup.ts) really run: each path through them is executed with stand-in `node` and `npx`
 * commands on PATH, so nothing is downloaded. The Windows script runs under cmd.exe on Windows; the Mac/Linux script runs under sh elsewhere.
 * This is what caught a ")" inside an `if ( … )` block ending it early (". was unexpected at this time.") on the failure path.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMULATOR_SETUP } from "../src/platform/emulator-setup.js";

const WIN = process.platform === "win32";

function workspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-emusetup-run-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    return { dir, bin };
}

describe.skipIf(!WIN)("setup-emulator.cmd under cmd.exe", () => {
    const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    // The stand-in node answers `node -p "parseInt(process.versions.node)"` with a major version.
    const run = (npxExit: number | null, nodeMajor = 24) => {
        const { dir, bin } = workspace();
        const script = path.join(dir, EMULATOR_SETUP.windows.file);
        fs.writeFileSync(script, EMULATOR_SETUP.windows.body);
        if (npxExit !== null) {
            fs.writeFileSync(path.join(bin, "node.cmd"), `@echo ${nodeMajor}\r\n@exit /b 0\r\n`);
            fs.writeFileSync(path.join(bin, "npx.cmd"), `@echo stand-in npx %*\r\n@exit /b ${npxExit}\r\n`);
        }
        const r = spawnSync("cmd.exe", ["/d", "/c", script], { env: { SystemRoot: process.env.SystemRoot, PATH: npxExit === null ? system32 : `${bin};${system32}` }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
        fs.rmSync(dir, { recursive: true, force: true });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };

    it("succeeds: runs the install command and says Ready", () => {
        const r = run(0);
        expect(r.out).toContain("stand-in npx --yes @taqwright/taqwright install --with-avd");
        expect(r.out).toContain("[done] The emulator is set up.");
        expect(r.code).toBe(0);
    });

    it("fails plainly when the install fails: the whole help text, exit 1, and no cmd.exe parse error", () => {
        const r = run(1);
        expect(r.out).not.toContain("was unexpected at this time");
        expect(r.out).toContain("[failed] Setup did not finish");
        expect(r.out).toContain("run this file again");
        expect(r.out).toContain('or "Hyper-V" under Windows Features).');
        expect(r.out).not.toContain("[done]");
        expect(r.code).toBe(1);
    });

    it("stops before downloading anything when Node.js is missing", () => {
        const r = run(null);
        expect(r.out).toContain("[missing] Node.js is not installed.");
        expect(r.out).not.toContain("Downloading the Android SDK");
        expect(r.code).toBe(1);
    });

    it("stops before downloading anything when Node.js is older than 24 (the Android tools need 24)", () => {
        const r = run(0, 20);
        expect(r.out).toContain("[too old] This computer has Node.js 20; the Android tools need Node.js 24 or newer.");
        expect(r.out).not.toContain("stand-in npx");
        expect(r.code).toBe(1);
    });
});

describe.skipIf(WIN)("setup-emulator.sh under sh", () => {
    const run = (npxExit: number | null, nodeMajor = 24) => {
        const { dir, bin } = workspace();
        const script = path.join(dir, EMULATOR_SETUP.unix.file);
        fs.writeFileSync(script, EMULATOR_SETUP.unix.body);
        if (npxExit !== null) {
            fs.writeFileSync(path.join(bin, "node"), `#!/bin/sh\necho ${nodeMajor}\n`, { mode: 0o755 });
            fs.writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "stand-in npx $*"\nexit ${npxExit}\n`, { mode: 0o755 });
        }
        const r = spawnSync("/bin/sh", [script], { env: { PATH: npxExit === null ? "/usr/bin:/bin" : `${bin}:/usr/bin:/bin` }, encoding: "utf8", timeout: 30_000 });
        fs.rmSync(dir, { recursive: true, force: true });
        return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };

    it("succeeds: runs the install command and says Ready", () => {
        const r = run(0);
        expect(r.out).toContain("stand-in npx --yes @taqwright/taqwright install --with-avd");
        expect(r.out).toContain("[done] The emulator is set up.");
        expect(r.code).toBe(0);
    });

    it("fails plainly when the install fails", () => {
        const r = run(1);
        expect(r.out).toContain("[failed] Setup did not finish");
        expect(r.out).not.toContain("[done]");
        expect(r.code).toBe(1);
    });

    it("stops before downloading anything when Node.js is missing", () => {
        const r = run(null);
        expect(r.out).toContain("[missing] Node.js is not installed.");
        expect(r.code).toBe(1);
    });

    it("stops before downloading anything when Node.js is older than 24", () => {
        const r = run(0, 20);
        expect(r.out).toContain("[too old] This computer has Node.js 20");
        expect(r.out).not.toContain("stand-in npx");
        expect(r.code).toBe(1);
    });
});
