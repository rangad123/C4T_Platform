/**
 * Round 40: what a test (possibly a hand-written code script) running on a runner can reach. It runs as the runner's OS user, so it can read
 * what that user can (SECURITY_DESIGN.md says so); these checks pin down the two things the runner does limit: the test process's
 * environment (an allow-list: no runner credential, enrollment code or platform key), and other OS accounts on the computer (the run
 * folders, the file cache and kept results are owner-only).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { restrictToOwner } from "../src/agent/agent.js";
import { childEnvFrom } from "../src/agent/task-process.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-untrusted-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("a test on a runner", () => {
    it("gets an allow-listed environment: no runner credential, enrollment code, credential folder or platform key", () => {
        const env = childEnvFrom({
            PATH: "/usr/bin",
            HOME: "/home/tester",
            HTTPS_PROXY: "http://proxy.example:3128",
            AITP_AGENT_TOKEN: "aitg_secret_value_0123456789abcdef",
            AITP_AGENT_TOKEN_FILE: "/x/runner.token",
            AITP_ENROLL_CODE: "aite_secret_value_0123456789abcdef",
            AITP_AGENT_ENROLL_FILE: "/x/runner.enroll",
            AITP_CREDENTIAL_DIR: "/x",
            AITP_AGENT_WORK_DIR: "/x/work",
            AITP_URL: "https://platform.example",
            SECRET_KEY: "platform-secret",
            API_KEY: "platform-key",
            ANTHROPIC_API_KEY: "sk-ant-x",
            AWS_SECRET_ACCESS_KEY: "aws-secret",
            GITHUB_TOKEN: "ghp_x",
            NODE_OPTIONS: "--require /tmp/evil.js",
        });
        expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/tester", HTTPS_PROXY: "http://proxy.example:3128" });
    });

    it("cannot be read by another OS account: the run folders, the file cache and kept results are owner-only (the work folder itself is left as it is)", async () => {
        if (process.platform === "win32") return; // folder ACLs: the profile's AppData is private already
        const work = path.join(tmp, "work");
        fs.mkdirSync(path.join(work, "cache"), { recursive: true, mode: 0o755 });
        fs.chmodSync(work, 0o755);
        await restrictToOwner(work, ["tasks", "cache", "outbox"]);
        for (const n of ["tasks", "cache", "outbox"]) expect(fs.statSync(path.join(work, n)).mode & 0o777, n).toBe(0o700);
        expect(fs.statSync(work).mode & 0o777).toBe(0o755);
        // Windows: nothing is changed.
        const win = path.join(tmp, "win");
        await restrictToOwner(win, ["tasks"], "win32");
        expect(fs.existsSync(win)).toBe(false);
    });
});
