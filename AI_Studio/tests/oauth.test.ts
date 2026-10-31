/**
 * OAuth2 client-credentials: token fetch against the sample app's /oauth/token, error handling, and a
 * full API-only job where authenticated tests pass only because the platform obtained a token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { fetchClientCredentialsToken, OAuth2Error } from "../src/engine/api/oauth.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";
import { Worker } from "../src/platform/worker.js";

const PORT = 5141;
const BASE = `http://127.0.0.1:${PORT}`;
const oauth2 = { tokenUrl: `${BASE}/oauth/token`, clientId: "demo-client", clientSecret: "demo-secret" };
let sample: ChildProcess;

beforeAll(async () => {
    sample = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(PORT)], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(BASE + "/")).ok) return;
        } catch {
            await new Promise((r) => setTimeout(r, 150));
        }
    }
}, 20_000);
afterAll(() => sample?.kill());

describe("fetchClientCredentialsToken", () => {
    it("obtains a token with HTTP Basic and with body credentials", async () => {
        expect(await fetchClientCredentialsToken(oauth2)).toBe("oauth-token-456");
        expect(await fetchClientCredentialsToken({ ...oauth2, authMethod: "body" })).toBe("oauth-token-456");
    });

    it("reports rejected credentials with the server's error code", async () => {
        await expect(fetchClientCredentialsToken({ ...oauth2, clientSecret: "wrong" })).rejects.toThrow(/invalid_client/);
        await expect(fetchClientCredentialsToken({ ...oauth2, tokenUrl: `${BASE}/nope` })).rejects.toBeInstanceOf(OAuth2Error);
    });
});

describe("API job with OAuth2 credentials", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let worker: Worker;
    let dataDir: string;

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-oauth-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        worker = new Worker(platform, 200);
        worker.start();
    });
    afterAll(async () => {
        await worker?.stop();
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("authenticated API tests validate with a token the platform obtained itself", async () => {
        const inject = async (method: "GET" | "POST", url: string, payload?: unknown) => JSON.parse((await server.inject({ method, url, payload: payload as never })).body);
        const project = await inject("POST", "/api/projects", { name: "OAuth" });
        // passive security checks (on by default) would find the fixture's missing headers; this test is about the OAuth token path
        const { jobId } = await inject("POST", `/api/projects/${project.id}/test-generation`, { url: BASE, targets: ["api"], securityChecks: false, credentials: { oauth2 } });
        let job: { status: string; testsValidated: number; testsGenerated: number };
        for (;;) {
            job = await inject("GET", `/api/test-generation/${jobId}`);
            if (["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"].includes(job.status)) break;
            await new Promise((r) => setTimeout(r, 400));
        }
        const tests = (await inject("GET", `/api/projects/${project.id}/tests`)) as Array<{ title: string; validationStatus: string }>;
        const me = tests.find((t) => t.title.startsWith("GET /api/me: succeeds"))!;
        expect(me.validationStatus).toBe("VALIDATED");
        expect(job.status).toBe("COMPLETED");
        // the token never reaches stored artifacts
        const events = (await inject("GET", `/api/test-generation/${jobId}/events`)) as Array<{ kind: string; message: string }>;
        expect(events.some((e) => e.kind === "oauth2_token_obtained")).toBe(true);
        expect(JSON.stringify(events)).not.toContain("oauth-token-456");
        expect(JSON.stringify(tests)).not.toContain("demo-secret");
    }, 120_000);
});
