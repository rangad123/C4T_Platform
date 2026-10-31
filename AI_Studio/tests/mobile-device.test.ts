/**
 * Mobile tests on a REAL Android emulator (Taqwright + Appium), through the whole platform:
 * import → job → emulator boot → Appium session → steps → stored result with evidence.
 *
 * Opt-in because it needs the Android toolchain (`npx @taqwright/taqwright install --with-avd`) and roughly 3 GB of
 * free RAM, and a cold emulator boot takes minutes:   MOBILE_E2E=1 npm run test:mobile:device
 * The app under test is Android's built-in Settings, so no APK is needed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { mobileAvailability } from "../src/engine/mobile/toolchain.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const enabled = process.env.MOBILE_E2E === "1";
const avail = mobileAvailability();

describe.skipIf(!enabled)("mobile tests on a real emulator", () => {
    let platform: Platform;
    let worker: Worker;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dataDir: string;

    beforeAll(async () => {
        if (!avail.available) throw new Error(`MOBILE_E2E=1 but this machine cannot run mobile tests: ${avail.reason}`);
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-mobile-device-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 500);
        worker.start();
    }, 30_000);
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };

    it("passes a test that is true of the app and fails one that is not, with evidence", async () => {
        const project = (await call("POST", "/api/projects", { name: "Android Settings" })).body.id as string;
        const specs = [
            {
                title: "Settings lists Network & internet and opens it",
                kind: "mobile",
                category: "Mobile · Settings",
                steps: [
                    { action: "assert", check: "visible", locator: { by: "text", value: "Network & internet" } },
                    { action: "click", locator: { by: "text", value: "Network & internet" } },
                    { action: "assert", check: "visible", locator: { by: "text", value: "Internet" } },
                ],
            },
            {
                title: "Settings shows an entry that does not exist",
                kind: "mobile",
                category: "Mobile · Settings",
                steps: [{ action: "assert", check: "visible", locator: { by: "text", value: "Definitely not a setting" } }],
            },
        ];
        const imported = await call("POST", `/api/projects/${project}/specs`, { specs, mobile: { appPackage: "com.android.settings" } });
        expect(imported.status).toBe(202);

        // Emulator cold boot + Appium session on a modest machine can take many minutes.
        let job: { status: string; error?: string } | undefined;
        for (let i = 0; i < 360; i++) {
            job = (await call("GET", `/api/test-generation/${imported.body.jobId}`)).body;
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job!.status)) break;
            await new Promise((r) => setTimeout(r, 5_000));
        }
        expect(job?.status, job?.error ?? "").toBe("PARTIALLY_COMPLETED");

        const tests = Object.fromEntries(((await call("GET", `/api/projects/${project}/tests`)).body as Array<{ testId: string; validationStatus: string; id: string }>).map((t) => [t.testId, t]));
        expect(tests["MOB-001"]!.validationStatus).toBe("VALIDATED");
        expect(tests["MOB-002"]!.validationStatus).toBe("FAILED_VALIDATION");

        const failed = (await call("GET", `/api/tests/${tests["MOB-002"]!.id}`)).body;
        const kinds = failed.executions[0].artifacts.map((a: { kind: string }) => a.kind);
        expect(kinds).toContain("screenshot");
        expect(failed.executions[0].steps[0].status).toBe("failed");
    }, 40 * 60_000);
});
