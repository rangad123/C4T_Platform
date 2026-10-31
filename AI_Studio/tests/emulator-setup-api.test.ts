/**
 * GET /api/mobile/emulator-setup: the download route for the Android emulator setup script (platform/emulator-setup.ts). Browser-free; the
 * platform is injected, not listened on. The script logic itself is covered in emulator-setup-unit.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

describe("GET /api/mobile/emulator-setup", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    const get = (url: string) => server.inject({ method: "GET", url });

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-emusetup-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
    }, 30_000);
    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("serves the Windows script as a download", async () => {
        const res = await get("/api/mobile/emulator-setup?os=windows");
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-disposition"]).toContain('filename="setup-emulator.cmd"');
        expect(res.body).toContain("npx --yes @taqwright/taqwright install --with-avd");
    });

    it("serves the Unix script, and maps mac/linux to it", async () => {
        for (const o of ["unix", "mac", "linux"]) {
            const res = await get(`/api/mobile/emulator-setup?os=${o}`);
            expect(res.statusCode, o).toBe(200);
            expect(res.headers["content-disposition"], o).toContain('filename="setup-emulator.sh"');
        }
    });

    it("refuses a missing or unknown operating system with a plain 400", async () => {
        expect((await get("/api/mobile/emulator-setup")).statusCode).toBe(400);
        expect((await get("/api/mobile/emulator-setup?os=android")).statusCode).toBe(400);
    });
});
