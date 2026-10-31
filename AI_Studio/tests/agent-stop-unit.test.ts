/**
 * Stopping the agent program does not wait for a capability probe that is still running. The Windows UI Automation probe starts
 * PowerShell (about 2 s on a quiet machine, up to its 20 s limit on a loaded one); before the fix stop() waited for it, which made the
 * teardown of tests/live-session-agent.test.ts pass its 30 s hook limit in loaded full runs (the "setup time-out" flaky test).
 * No network: the probe never answers before stop(), so the agent never reaches the platform.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { CapabilityProbe } from "../src/agent/capabilities.js";
import { memoryLogger } from "../src/agent/log.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-agent-stop-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

describe("stopping the agent", () => {
    it("returns at once while the capability probe is still running", async () => {
        let release = (): void => undefined;
        const slowDesktop = new Promise<{ uiautomation: boolean; interactive: boolean; elevated: boolean }>((resolve) => {
            release = () => resolve({ uiautomation: true, interactive: true, elevated: false });
        });
        const probe = new CapabilityProbe({ platform: "win32", browsers: () => ["chromium"], desktop: () => slowDesktop, exec: async () => undefined });
        const { log, lines } = memoryLogger();
        const agent = new Agent({
            // Port 6891 (QA range): nothing listens there, and the probe never lets the agent get that far.
            config: { baseUrl: "http://127.0.0.1:6891", token: "t".repeat(40), name: "stop-test", concurrency: 1, workDir: work, allowInsecure: false, cacheBytes: 1024 * 1024, tokenSource: "env" },
            log,
            env: {},
            probe,
        });
        const done = agent.run();
        await new Promise((r) => setTimeout(r, 300)); // the agent is inside its first probe now
        const t0 = Date.now();
        agent.stop();
        const code = await done;
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(agent.status().state).toBe("stopped");
        expect(typeof code).toBe("number");
        expect(lines.join("\n")).not.toMatch(/Connected to the platform/);
        release();
    });
});
