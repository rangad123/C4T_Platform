/** Helpers for the Git import tests: a real local repository built in a temp folder, and stand-ins for the git program. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1" };

export class TestRepo {
    readonly dir: string;
    constructor(readonly root: string) {
        this.dir = path.join(root, "origin");
        fs.mkdirSync(this.dir, { recursive: true });
        this.git("init", "-q", "-b", "main");
        this.git("config", "core.autocrlf", "false");
        this.git("config", "uploadpack.allowAnySHA1InWant", "true");
    }
    /** Always runs with an explicit working folder inside the temp area. */
    git(...args: string[]): string {
        return execFileSync("git", args, { cwd: this.dir, env: ENV, encoding: "utf8", windowsHide: true });
    }
    write(rel: string, content: string | Buffer): void {
        const p = path.join(this.dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    remove(rel: string): void {
        fs.rmSync(path.join(this.dir, rel), { force: true });
    }
    private readonly links: Array<[string, string]> = [];
    /** A symbolic link entry made through git's index, so it needs no operating-system privilege. */
    addSymlink(rel: string, target: string): void {
        this.links.push([rel, target]);
        this.indexLink(rel, target);
    }
    private indexLink(rel: string, target: string): void {
        const sha = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: this.dir, env: ENV, input: target, encoding: "utf8", windowsHide: true }).trim();
        this.git("update-index", "--add", "--cacheinfo", `120000,${sha},${rel}`);
    }
    commit(message: string): string {
        this.git("add", "-A");
        for (const [rel, target] of this.links) this.indexLink(rel, target); // the index entry has no file behind it, so add -A would drop it
        this.git("commit", "-q", "--no-verify", "-m", message);
        return this.git("rev-parse", "HEAD").trim();
    }
    branch(name: string): void {
        this.git("branch", name);
    }
    /** The address the platform's test seam accepts. */
    get url(): string {
        return `file:///${this.dir.replace(/\\/g, "/")}`;
    }
    destroy(): void {
        fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

export function makeTempRoot(prefix = "gitimport-"): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const specFile = (title: string, body = "await page.goto('/');", imports = ""): string =>
    `import { test, expect } from "@playwright/test";\n${imports}\ntest.describe("${title}", () => {\n  test("${title} works", async ({ page }) => {\n    ${body}\n  });\n});\n`;

/**
 * A stand-in for git: a node script that answers `--version`, writes what it was started with to `record`, and then either hangs,
 * or fails with the token in its error text (to prove that every output is scrubbed).
 */
export function writeFakeGit(dir: string, mode: "hang" | "leaky"): { file: string; prefixArgs: string[]; record: string } {
    const script = path.join(dir, `fake-git-${mode}.mjs`);
    const record = path.join(dir, `fake-git-${mode}.json`);
    fs.writeFileSync(
        script,
        `import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("git version 2.45.0"); process.exit(0); }
const prev = fs.existsSync(${JSON.stringify(record)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(record)}, "utf8")) : [];
const env = {}; for (const k of Object.keys(process.env)) if (/^(GIT_|HOME|USERPROFILE)/.test(k)) env[k] = process.env[k];
prev.push({ pid: process.pid, args, env });
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(prev));
${
    mode === "hang"
        ? "setInterval(() => {}, 1000);"
        : `const header = process.env.GIT_CONFIG_VALUE_0 || "";
const tok = header.replace("Authorization: Bearer ", "");
console.error("fatal: Authentication failed for 'https://user:" + tok + "@host/x.git' header=" + header + " b64=" + Buffer.from(tok).toString("base64"));
process.exit(128);`
}
`,
    );
    return { file: process.execPath, prefixArgs: [script], record };
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
