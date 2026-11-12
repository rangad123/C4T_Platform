/**
 * Round 45 (one runner per person): a runner that was set up for a team or a project, or whose credential was retired, is refused by the
 * platform with a plain sentence. The runner shows that sentence and stops with exit code 3 ("access removed"), and never asks again:
 *   - a team enrollment code at /api/agent/enroll: HTTP 410 with the sentence;
 *   - a team or project credential at hello: HTTP 401 with the sentence;
 *   - a retired personal credential at hello: 404, with or without a sentence;
 *   - a credential removed by the runner reset (migration 57): 404 at hello with the platform's sentence (download the new runner).
 * No network: the platform is a stand-in fetch that counts the requests it gets.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Agent, EXIT } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { ACCESS_REMOVED } from "../src/agent/client.js";
import type { AgentConfig } from "../src/agent/config.js";
import { memoryLogger } from "../src/agent/log.js";
import { RUNNER_TOKEN_GONE } from "../src/platform/runner-only.js";

const TEAM = "This runner was set up for a team or a project, and those runners are no longer used. Set up your own runner from Settings in AI Studio.";
const CODE = `aite_${"T".repeat(43)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-refused-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** A stand-in platform: every request gets the same answer; the paths asked for are kept. */
function platform(status: number, body: unknown) {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        asked.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { asked, fetchImpl };
}

async function runAgent(config: Partial<AgentConfig>, fake: ReturnType<typeof platform>) {
    const work = fs.mkdtempSync(path.join(root, "w-"));
    const { log, lines } = memoryLogger();
    const probe = new CapabilityProbe({ platform: "linux", browsers: () => ["chromium"], exec: async () => undefined });
    const agent = new Agent({
        config: { baseUrl: "https://tests.example.com", token: "", name: "refused-test", concurrency: 1, workDir: work, credentialDir: work, allowInsecure: false, cacheBytes: 1024 * 1024, tokenSource: "store", ...config },
        log,
        env: {},
        probe,
        fetchImpl: fake.fetchImpl,
        backoff: { baseMs: 1, maxMs: 2 },
    });
    const timer = setTimeout(() => agent.stop(), 10_000);
    const code = await agent.run();
    clearTimeout(timer);
    return { code, out: lines.join("\n") };
}

describe("a refused runner stops with the platform's sentence", () => {
    it("a team enrollment code (410 at enroll): the sentence, exit 3, asked once", async () => {
        const fake = platform(410, { error: TEAM });
        const r = await runAgent({ enroll: { code: CODE, explicit: true } }, fake);
        expect(r.code).toBe(EXIT.token);
        expect(r.out).toContain(TEAM);
        expect(fake.asked).toEqual(["POST /api/agent/enroll"]);
        expect(r.out).not.toContain(CODE);
    });

    it("a team or project credential (401 at hello): the sentence, exit 3, never asked again", async () => {
        const fake = platform(401, { error: TEAM });
        const r = await runAgent({ token: `aitg_${"t".repeat(40)}`, tokenSource: "env" }, fake);
        expect(r.code).toBe(EXIT.token);
        expect(r.out).toContain(`The platform no longer accepts this runner. ${TEAM}`);
        expect(fake.asked.filter((a) => a.endsWith("/api/agent/hello")).length).toBe(1);
        expect(fake.asked.some((a) => a.endsWith("/api/agent/poll"))).toBe(false);
    });

    it("a retired credential (404 at hello, no sentence): what to do in plain words, exit 3", async () => {
        const fake = platform(404, undefined);
        const r = await runAgent({ token: `aitg_${"r".repeat(40)}`, tokenSource: "env" }, fake);
        expect(r.code).toBe(EXIT.token);
        expect(r.out).toContain(ACCESS_REMOVED);
        expect(fake.asked.filter((a) => a.endsWith("/api/agent/hello")).length).toBe(1);
    });

    it("a credential removed by the update (404 at hello, the platform's sentence): download the new runner, exit 3, never asked again", async () => {
        const fake = platform(404, { error: RUNNER_TOKEN_GONE });
        const r = await runAgent({ token: `aitg_${"o".repeat(40)}`, tokenSource: "env" }, fake);
        expect(r.code).toBe(EXIT.token);
        expect(r.out).toContain(`The platform no longer accepts this runner. ${RUNNER_TOKEN_GONE}`);
        expect(r.out).toContain("Download the new runner in Settings, Your runner");
        expect(fake.asked.filter((a) => a.endsWith("/api/agent/hello")).length).toBe(1);
        expect(fake.asked.some((a) => a.endsWith("/api/agent/poll"))).toBe(false);
    });
});
