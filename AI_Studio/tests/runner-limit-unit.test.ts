/**
 * One runner per project (src/platform/runner-kit.ts DEFAULT_MAX_TOKENS = 1): a second runner token is refused on both creation paths until
 * the first is removed, and the kit-info answer reports the limit for the UI. Browser-free; the platform is injected, not listened on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

describe("one runner per project", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dir: string;
    let projectId = "";
    const saved = process.env.AGENT_MAX_TOKENS;
    const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never });
        return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
    };

    beforeAll(async () => {
        delete process.env.AGENT_MAX_TOKENS; // the default is one
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runnerlimit-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, LLM_PROVIDER: "anthropic" }));
        server = await buildServer(platform);
        projectId = (await call("POST", "/api/projects", { name: "Runner limit" })).body.id as string;
    }, 30_000);
    afterAll(async () => {
        if (saved === undefined) delete process.env.AGENT_MAX_TOKENS;
        else process.env.AGENT_MAX_TOKENS = saved;
        await server?.close();
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses a second runner token until the first is removed, and says why", async () => {
        const base = `/api/projects/${projectId}`;
        const first = await call("POST", `${base}/agent-tokens`, { label: "one" });
        expect(first.status).toBe(201);

        const second = await call("POST", `${base}/agent-tokens`, { label: "two" });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already has a runner/i);

        // Remove the first (revoke), then a new one is allowed.
        const tokens = (await call("GET", `${base}/agent-tokens`)).body as Array<{ id: string }>;
        expect((await call("DELETE", `${base}/agent-tokens/${tokens[0]!.id}`)).status).toBe(200);
        expect((await call("POST", `${base}/agent-tokens`, { label: "replacement" })).status).toBe(201);
    });

    it("reports the limit and the active count for the UI to gate on", async () => {
        const info = (await call("GET", `/api/projects/${projectId}/runner-kits/info`)).body;
        expect(info.maxRunners).toBe(1);
        expect(info.activeRunners).toBe(1); // the replacement token from the previous test
    });
});
