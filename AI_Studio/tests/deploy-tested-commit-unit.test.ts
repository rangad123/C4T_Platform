/**
 * deploy/c4t-box/deploy.sh: a deploy started by a CI run starts only the AI Studio code that run checked. deploy-pull.sh resets the box to
 * main as it is now, so a newer AI Studio commit that no CI run has passed yet must not be restarted into.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fs.readFileSync(new URL("../deploy/c4t-box/deploy.sh", import.meta.url), "utf8");
const hasBash = spawnSync("bash", ["--version"]).status === 0 && spawnSync("git", ["--version"]).status === 0;

let root: string;
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
const commit = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
    git("add", "-A");
    git("commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
};
/** Sources the script (which defines its functions without running them) and calls check_tested_commit. */
const check = (tested: string | undefined) =>
    spawnSync("bash", ["-c", 'source "$1"; check_tested_commit; echo "rc=$?"', "deploy-test", path.join(root, "AI_Studio/deploy/c4t-box/deploy.sh")], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: root, AI_STUDIO_HOME: path.join(root, "home"), ...(tested === undefined ? {} : { TESTED_SHA: tested }) },
    });

describe.skipIf(!hasBash)("deploy.sh starts only the AI Studio code CI checked", () => {
    let tested: string;
    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-deploy-sha-"));
        git("init", "-q");
        commit("AI_Studio/deploy/c4t-box/deploy.sh", SCRIPT);
        tested = commit("AI_Studio/src/app.ts", "one\n");
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("goes on when main is the commit CI checked, and when a run by hand passes none", () => {
        expect(check(tested).stdout).toContain("rc=0");
        expect(check(undefined).stdout).toContain("rc=0");
    });

    it("goes on when main moved on only outside AI Studio", () => {
        commit("web/page.tsx", "other app\n");
        expect(check(tested).stdout).toContain("rc=0");
    });

    it("starts nothing when main holds newer AI Studio changes than the commit CI checked", () => {
        commit("AI_Studio/src/app.ts", "two, not checked yet\n");
        const r = check(tested);
        // check_tested_commit says why and returns 1; main() then stops before anything is installed or restarted.
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/newer than [0-9a-f]{12}, the commit CI checked; nothing was restarted/);
    });

    it("refuses a value that is not a commit id", () => {
        const r = check("main; rm -rf /");
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not a full commit id/);
    });
});
