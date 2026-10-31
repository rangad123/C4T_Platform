/**
 * The downloadable "set up the Android emulator" script (src/platform/emulator-setup.ts): the right script per operating system, the exact
 * install command, and that it carries nothing that would run in a shell on its own.
 */
import { describe, expect, it } from "vitest";
import { EMULATOR_SETUP, emulatorSetupScript } from "../src/platform/emulator-setup.js";

describe("emulator setup script", () => {
    it("serves a Windows .cmd and a Unix .sh, and maps mac/linux to unix", () => {
        expect(emulatorSetupScript("windows")?.file).toBe("setup-emulator.cmd");
        expect(emulatorSetupScript("unix")?.file).toBe("setup-emulator.sh");
        for (const alias of ["mac", "macos", "darwin", "linux"]) expect(emulatorSetupScript(alias)?.file, alias).toBe("setup-emulator.sh");
        expect(emulatorSetupScript("")).toBeUndefined();
        expect(emulatorSetupScript("android")).toBeUndefined();
    });

    it("runs exactly the documented install command, and nothing else that touches the network", () => {
        for (const os of ["windows", "unix"] as const) {
            const body = EMULATOR_SETUP[os].body;
            expect(body).toContain("npx --yes @taqwright/taqwright install --with-avd");
            // No other download/fetch/curl is smuggled in.
            expect(body).not.toMatch(/curl|wget|Invoke-WebRequest|iwr\b/i);
            // It points the person back to the Settings page, not to a surprise action.
            expect(body.toLowerCase()).toContain("mobile testing");
        }
    });

    it("has the line endings its platform needs, whatever the server's checkout: CRLF for Windows, LF for Mac and Linux", () => {
        const win = EMULATOR_SETUP.windows.body;
        expect(win.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // every line break is CRLF
        expect(win.endsWith("\r\n")).toBe(true);
        expect(EMULATOR_SETUP.unix.body).not.toContain("\r"); // sh rejects "then\r"
    });

    it("is a real script for its platform: the Windows file is batch, the Unix file has a shebang", () => {
        expect(EMULATOR_SETUP.windows.body.startsWith("@echo off")).toBe(true);
        expect(EMULATOR_SETUP.unix.body.startsWith("#!/bin/sh")).toBe(true);
        // Node.js is checked before anything is downloaded.
        expect(EMULATOR_SETUP.windows.body).toMatch(/where node/);
        expect(EMULATOR_SETUP.unix.body).toMatch(/command -v node/);
    });
});
