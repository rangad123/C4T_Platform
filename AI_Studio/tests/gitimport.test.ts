/**
 * Git import against real repositories built in temp folders (no network). Part 1 drives the service with in-memory stores and
 * the real system git; part 2 (further down) goes through the platform's HTTP API with the real custom-test stores.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkScript } from "../src/engine/custom/guard.js";
import { GitImportService, type CustomTestPort, type GitImportPorts, type GitRepoPort, type RepoRecord } from "../src/platform/git-import-service.js";
import { HttpError } from "../src/platform/http-error.js";
import { TestRepo, isAlive, makeTempRoot, specFile, writeFakeGit } from "./fixtures/git-fixture.js";

const PORT_AUTH = 6091;
const TOKEN = "GITIMPORT-Sentinel-Tok3n-9f2c1";

// ── in-memory stores ──────────────────────────────────────────────────────────
class MemPorts {
    rows: RepoRecord[] = [];
    tests = new Map<string, { testId: string; repoId: string; path: string; content: string; versions: string[] }>();
    queued: string[][] = [];
    helpers = new Set<string>();
    n = 0;
    repos: GitRepoPort = {
        create: (r) => {
            const row = { ...r, id: `repo${++this.n}` };
            this.rows.push(row);
            return row;
        },
        list: (pid) => this.rows.filter((r) => r.projectId === pid),
        get: (pid, id) => this.rows.find((r) => r.projectId === pid && r.id === id),
        update: (id, patch) => void Object.assign(this.rows.find((r) => r.id === id)!, patch),
        delete: (pid, id) => void (this.rows = this.rows.filter((r) => !(r.projectId === pid && r.id === id))),
    };
    testPort: CustomTestPort = {
        upsert: async (_pid, repoId, f) => {
            const have = [...this.tests.values()].find((t) => t.repoId === repoId && t.path === f.path);
            if (have) {
                const changed = have.content !== f.content;
                if (changed) (have.content = f.content), have.versions.push(f.content);
                return { testId: have.testId, created: false, changed };
            }
            const testId = `t${++this.n}`;
            this.tests.set(testId, { testId, repoId, path: f.path, content: f.content, versions: [f.content] });
            return { testId, created: true, changed: true };
        },
        forRepo: (repoId) => [...this.tests.values()].filter((t) => t.repoId === repoId).map((t) => ({ testId: t.testId, path: t.path, content: t.content })),
        queueValidation: async (_pid, ids) => {
            this.queued.push(ids);
            return { jobId: `job${this.queued.length}` };
        },
    };
    checkScript = (content: string) => checkScript(content).diagnostics;
    helperNames = () => [...this.helpers];
}
const portsOf = (m: MemPorts): GitImportPorts => ({ checkScript: m.checkScript, helperNames: m.helperNames, repos: m.repos, tests: m.testPort });

// ── the repository under test ─────────────────────────────────────────────────
let root: string;
let repo: TestRepo;
let c1: string;
let c2: string;
const dirs: string[] = [];
const scratch = () => path.join(root, "scratch");

function buildRepo(): void {
    repo = new TestRepo(path.join(root, "repo"));
    repo.write("tests/login.spec.ts", specFile("Login"));
    repo.write("tests/cart/cart.spec.ts", specFile("Cart"));
    repo.write("tests/cart/api.test.js", `const { test } = require("@playwright/test");\n`); // require is refused by the guard
    repo.write("tests/danger.spec.ts", specFile("Danger", "", `import { execSync } from "child_process";`));
    repo.write("tests/uses-lib.spec.ts", specFile("Uses lib", "", `import { util } from "../lib/util";`));
    repo.write("tests/uses-helper.spec.ts", specFile("Uses missing helper", "", `import { go } from "./helpers/nav";`));
    repo.write("tests/binary.spec.ts", Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x80, 0x81]));
    repo.write("tests/huge.spec.ts", `// ${"x".repeat(250 * 1024)}\n`);
    repo.write("node_modules/pkg/inner.spec.ts", specFile("Inner"));
    repo.write(".hidden/h.spec.ts", specFile("Hidden"));
    repo.write("lib/util.ts", "export const util = 1;\n");
    repo.write("README.md", "# readme\n");
    repo.addSymlink("tests/link.spec.ts", "login.spec.ts");
    c1 = repo.commit("first");
    // second commit: change one file, add one, remove one
    repo.write("tests/login.spec.ts", specFile("Login", "await page.goto('/login');"));
    repo.write("tests/new.spec.ts", specFile("Brand new"));
    repo.remove("tests/cart/cart.spec.ts");
    c2 = repo.commit("second");
}

function service(ports: MemPorts, extra: Partial<ConstructorParameters<typeof GitImportService>[0]> = {}): GitImportService {
    return new GitImportService({ scratchRoot: scratch(), allowLocal: true, ...extra }, portsOf(ports));
}

beforeAll(() => {
    root = makeTempRoot();
    buildRepo();
});
afterAll(() => {
    repo?.destroy();
    fs.rmSync(root, { recursive: true, force: true });
});

const leftovers = () => (fs.existsSync(scratch()) ? fs.readdirSync(scratch()).filter((n) => n.startsWith("run-")) : []);
afterEach(() => {
    expect(leftovers(), "the clone directory is removed in every outcome").toEqual([]);
});

describe("clone, preview and import", () => {
    it("previews files, counts, problems and skips without storing anything", async () => {
        const ports = new MemPorts();
        ports.helpers.add("other");
        const svc = service(ports);
        const pre = await svc.dryRun("p1", { url: repo.url, ref: "main", dryRun: true });
        expect(pre.commit).toBe(c2);
        const byPath = Object.fromEntries(pre.files.map((f) => [f.path, f]));
        expect(Object.keys(byPath).sort()).toEqual(["tests/cart/api.test.js", "tests/danger.spec.ts", "tests/login.spec.ts", "tests/new.spec.ts", "tests/uses-helper.spec.ts", "tests/uses-lib.spec.ts"]);
        expect(byPath["tests/login.spec.ts"]).toMatchObject({ title: "Login", tests: 1, problems: [] });
        expect(byPath["tests/login.spec.ts"]!.bytes).toBeGreaterThan(50);
        expect(byPath["tests/danger.spec.ts"]!.problems.join(" ")).toMatch(/child_process/);
        expect(byPath["tests/uses-lib.spec.ts"]!.problems.join(" ")).toMatch(/\.\.\/lib\/util/);
        expect(byPath["tests/uses-helper.spec.ts"]!.problems.join(" ")).toMatch(/helper named nav that doesn't exist yet/);
        expect(byPath["tests/cart/api.test.js"]!.problems.length).toBeGreaterThan(0);
        const skipped = Object.fromEntries(pre.skipped.map((s) => [s.path, s.reason]));
        expect(skipped["tests/binary.spec.ts"]).toMatch(/Not a text file/);
        expect(skipped["tests/huge.spec.ts"]).toMatch(/Larger than 200 KB/);
        expect(skipped["tests/link.spec.ts"]).toMatch(/symbolic link/);
        expect(skipped[""]).toMatch(/2 test files inside node_modules or hidden folders were left out/);
        // nothing stored, nothing queued
        expect(ports.rows).toEqual([]);
        expect(ports.tests.size).toBe(0);
        expect(ports.queued).toEqual([]);
    });

    it("imports clean files with provenance, skips blocked ones with their reason, and queues one validation", async () => {
        const ports = new MemPorts();
        const svc = service(ports);
        const first = await svc.import("p1", { url: repo.url, ref: c1 });
        expect(first.commit).toBe(c1);
        const paths = first.imported.map((i) => i.path).sort();
        expect(paths).toEqual(["tests/cart/cart.spec.ts", "tests/login.spec.ts"]);
        expect(first.imported.every((i) => i.created && i.changed)).toBe(true);
        const reasons = Object.fromEntries(first.skipped.map((s) => [s.path, s.reason]));
        expect(reasons["tests/danger.spec.ts"]).toMatch(/child_process/);
        expect(reasons["tests/uses-lib.spec.ts"]).toMatch(/\.\.\/lib\/util/);
        expect(reasons["tests/uses-helper.spec.ts"]).toMatch(/nav/);
        expect([...ports.tests.values()].some((t) => /child_process|\.\.\/lib/.test(t.content))).toBe(false);
        expect(first.jobId).toBe("job1");
        expect(ports.queued[0]!.length).toBe(2);
        expect(ports.rows).toHaveLength(1);
        expect(ports.rows[0]).toMatchObject({ host: "local", commit: c1, ref: c1, subpath: "" });
    });

    it("refresh updates the changed file as a new version, creates the new file, and reports the removed one", async () => {
        // a branch pointing at the first commit, then moved forward
        repo.git("branch", "-f", "movable", c1);
        const p3 = new MemPorts();
        const s3 = service(p3);
        const first = await s3.import("p1", { url: repo.url, ref: "movable" });
        expect(first.commit).toBe(c1);
        const gid3 = p3.rows[0]!.id;
        const before = await s3.check("p1", gid3);
        expect(before).toMatchObject({ upToDate: true, changed: [], added: [] });

        repo.git("branch", "-f", "movable", c2);
        const chk = await s3.check("p1", gid3);
        expect(chk.upToDate).toBe(false);
        expect(chk.newCommit).toBe(c2);
        expect(chk.changed.map((c) => `${c.path}${c.removed ? "!" : ""}`).sort()).toEqual(["tests/cart/cart.spec.ts!", "tests/login.spec.ts"]);
        expect(chk.added).toEqual(["tests/new.spec.ts"]);
        const loginId = first.imported.find((i) => i.path === "tests/login.spec.ts")!.testId;
        expect(chk.changed.find((c) => c.path === "tests/login.spec.ts")!.testId).toBe(loginId);

        const refreshed = await s3.refresh("p1", gid3);
        expect(refreshed.commit).toBe(c2);
        const by = Object.fromEntries(refreshed.imported.map((i) => [i.path, i]));
        expect(by["tests/login.spec.ts"]).toMatchObject({ created: false, changed: true, testId: loginId });
        expect(by["tests/new.spec.ts"]).toMatchObject({ created: true });
        expect(by["tests/cart/cart.spec.ts"]).toBeUndefined();
        // the removed file's test is kept, not deleted
        expect([...p3.tests.values()].some((t) => t.path === "tests/cart/cart.spec.ts")).toBe(true);
        expect(p3.tests.get(loginId)!.versions).toHaveLength(2);
        expect(p3.rows[0]!.commit).toBe(c2);
        expect(p3.queued[1]!.sort()).toEqual([loginId, by["tests/new.spec.ts"]!.testId].sort());
    });

    it("is idempotent: the same import again changes nothing and queues nothing", async () => {
        const ports = new MemPorts();
        const svc = service(ports);
        await svc.import("p1", { url: repo.url, ref: "main" });
        const again = await svc.import("p1", { url: repo.url, ref: "main" });
        expect(ports.rows).toHaveLength(1);
        expect(again.imported.every((i) => !i.created && !i.changed)).toBe(true);
        expect(again.jobId).toBeNull();
        expect(ports.queued).toHaveLength(1);
        expect([...ports.tests.values()].every((t) => t.versions.length === 1)).toBe(true);
        // refresh with nothing new is quiet as well
        const r = await svc.refresh("p1", ports.rows[0]!.id);
        expect(r.imported.every((i) => !i.changed)).toBe(true);
    });

    it("imports a folder only, lists links and drops the link without touching the tests", async () => {
        const ports = new MemPorts();
        const svc = service(ports);
        const r = await svc.import("p1", { url: repo.url, ref: "main", path: "tests\\cart" });
        expect(r.imported.map((i) => i.path)).toEqual([]);
        expect(r.skipped.some((s) => s.path === "tests/cart/api.test.js")).toBe(true);
        const r2 = await svc.import("p1", { url: repo.url, path: "tests" });
        expect(r2.imported.length).toBeGreaterThan(0);
        expect(svc.list("p1").map((x) => ({ ref: x.ref, tests: x.tests }))).toEqual([
            { ref: "main", tests: 0 },
            { ref: "main", tests: r2.imported.length },
        ]);
        const gid = ports.rows[1]!.id;
        svc.remove("p1", gid);
        expect(ports.rows).toHaveLength(1);
        expect(() => svc.remove("p1", gid)).toThrow(/not linked/);
        expect(() => svc.remove("other-project", ports.rows[0]!.id)).toThrow(/not linked/);
    });

    it("accepts a helper the project already has", async () => {
        const ports = new MemPorts();
        ports.helpers.add("nav");
        const r = await service(ports).import("p1", { url: repo.url, ref: "main" });
        expect(r.imported.map((i) => i.path)).toContain("tests/uses-helper.spec.ts");
    });

    it("says plainly when there is nothing to import, a branch is missing, or a limit is passed", async () => {
        const svc = service(new MemPorts());
        await expect(svc.import("p1", { url: repo.url, ref: "main", path: "lib" })).rejects.toThrow(/No test files were found in lib/);
        await expect(svc.import("p1", { url: repo.url, ref: "no-such-branch" })).rejects.toThrow(/does not exist/);
        await expect(svc.import("p1", { url: repo.url, ref: "f".repeat(40) })).rejects.toThrow(HttpError);
        await expect(service(new MemPorts(), { maxFiles: 5 }).import("p1", { url: repo.url })).rejects.toThrow(/more than 5 files/);
        await expect(service(new MemPorts(), { maxCheckoutBytes: 1000 }).import("p1", { url: repo.url })).rejects.toThrow(/too large/);
        await expect(svc.import("p1", { url: "ssh://git@example.com/a/b.git" })).rejects.toThrow(/SSH/);
        await expect(svc.import("p1", { url: repo.url, path: "../x" })).rejects.toThrow(/inside the repository/);
    });

    it("refuses a repository with more than 200 test files and asks for a narrower folder", async () => {
        const big = new TestRepo(path.join(root, "big"));
        for (let i = 0; i < 201; i++) big.write(`many/t${i}.spec.ts`, `test("t${i}", async () => {});\n`);
        big.write("few/a.spec.ts", specFile("A"));
        big.commit("many");
        const svc = service(new MemPorts());
        await expect(svc.dryRun("p1", { url: big.url })).rejects.toThrow(/more than the 200/);
        const ok = await svc.dryRun("p1", { url: big.url, path: "few" });
        expect(ok.files).toHaveLength(1);
    });

    it("allows only one import at a time per project", async () => {
        const svc = service(new MemPorts());
        const a = svc.dryRun("p1", { url: repo.url });
        await expect(svc.dryRun("p1", { url: repo.url })).rejects.toMatchObject({ status: 409 });
        await expect(svc.import("p1", { url: repo.url })).rejects.toMatchObject({ status: 409 });
        // another project is not blocked
        const b = svc.dryRun("p2", { url: repo.url });
        await Promise.all([a, b]);
        await expect(svc.dryRun("p1", { url: repo.url })).resolves.toBeDefined();
    });

    it("rejects a repository whose address is in the guarded range before starting git", async () => {
        const fake = writeFakeGit(root, "hang");
        const rec = fake.record;
        fs.rmSync(rec, { force: true });
        const prev = process.env.BLOCK_PRIVATE_TARGETS;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            // not the seam: a real https address on a private host
            const svc = new GitImportService({ scratchRoot: scratch(), git: fake }, portsOf(new MemPorts()));
            await expect(svc.dryRun("p1", { url: "https://127.0.0.1/acme/tests" })).rejects.toThrow(/private|loopback/);
            await expect(svc.dryRun("p1", { url: "https://localhost/acme/tests" })).rejects.toThrow(/private|loopback/);
        } finally {
            if (prev === undefined) delete process.env.BLOCK_PRIVATE_TARGETS;
            else process.env.BLOCK_PRIVATE_TARGETS = prev;
        }
        expect(fs.existsSync(rec)).toBe(false);
    });
});

describe("limits, failures and the token", () => {
    it("ends a hung download by its process id and says it took too long", async () => {
        const fake = writeFakeGit(root, "hang");
        fs.rmSync(fake.record, { force: true });
        const svc = service(new MemPorts(), { git: fake, timeoutMs: 1500 });
        const started = Date.now();
        await expect(svc.dryRun("p1", { url: repo.url })).rejects.toThrow(/took too long/);
        expect(Date.now() - started).toBeLessThan(20_000);
        const seen = JSON.parse(fs.readFileSync(fake.record, "utf8")) as Array<{ pid: number; args: string[] }>;
        expect(seen.length).toBe(1);
        await new Promise((r) => setTimeout(r, 600));
        expect(isAlive(seen[0]!.pid)).toBe(false);
    });

    it("keeps the token out of arguments, errors and the working folder; passes it only in the environment", async () => {
        const fake = writeFakeGit(root, "leaky");
        fs.rmSync(fake.record, { force: true });
        const svc = new GitImportService({ scratchRoot: scratch(), git: fake, allowLocal: true }, portsOf(new MemPorts()));
        let message = "";
        try {
            await svc.dryRun("p1", { url: "http://127.0.0.1:6099/acme/tests.git", token: TOKEN });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/refused the access token/);
        expect(message).not.toContain(TOKEN);
        const seen = JSON.parse(fs.readFileSync(fake.record, "utf8")) as Array<{ args: string[]; env: Record<string, string> }>;
        expect(seen.length).toBeGreaterThan(0);
        for (const s of seen) {
            expect(s.args.join(" ")).not.toContain(TOKEN);
            expect(s.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${TOKEN}`);
            expect(s.env.GIT_CONFIG_KEY_0).toBe("http.http://127.0.0.1:6099/.extraHeader");
            expect(s.env.GIT_TERMINAL_PROMPT).toBe("0");
            expect(s.env.GIT_CONFIG_NOSYSTEM).toBe("1");
            expect(s.args).toEqual(expect.arrayContaining(["-c", "core.symlinks=false", "--depth", "1"]));
            expect(s.args.some((a) => a.startsWith("core.hooksPath="))).toBe(true);
            expect(s.args.indexOf("--")).toBeGreaterThan(s.args.indexOf("clone"));
        }
    });

    it("sends the token as a header to the repository's own server and explains a refusal", async () => {
        const seen: Array<string | undefined> = [];
        const server = http.createServer((req, res) => {
            seen.push(req.headers.authorization);
            res.writeHead(401, { "www-authenticate": 'Basic realm="x"' });
            res.end("no");
        });
        await new Promise<void>((r) => server.listen(PORT_AUTH, "127.0.0.1", r));
        try {
            const svc = service(new MemPorts());
            const url = `http://127.0.0.1:${PORT_AUTH}/acme/tests.git`;
            const e1 = await svc.dryRun("p1", { url, token: TOKEN }).catch((e: Error) => e);
            expect((e1 as Error).message).toMatch(/refused the access token/);
            expect((e1 as Error).message).not.toContain(TOKEN);
            expect(seen).toContain(`Bearer ${TOKEN}`);
            seen.length = 0;
            const e2 = await svc.dryRun("p1", { url }).catch((e: Error) => e);
            expect((e2 as Error).message).toMatch(/needs a sign-in/);
            expect(seen.every((h) => h === undefined)).toBe(true);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    it("says plainly when git is not installed, and creates nothing", async () => {
        const svc = service(new MemPorts(), { git: { file: path.join(root, "no-such-git-program") } });
        await expect(svc.dryRun("p1", { url: repo.url })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Git isn't installed on the computer that runs the platform/) });
    });

    it("never writes a symlink, hook or submodule from the repository onto the platform computer", async () => {
        const evil = new TestRepo(path.join(root, "evil"));
        const marker = path.join(root, "hook-ran.txt");
        evil.write("a.spec.ts", specFile("A"));
        evil.write(".githooks/post-checkout", `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`);
        evil.write(".gitmodules", `[submodule "x"]\n\tpath = x\n\turl = https://127.0.0.1:1/never.git\n`);
        evil.commit("evil");
        const r = await service(new MemPorts()).import("p1", { url: evil.url });
        expect(r.imported.map((i) => i.path)).toEqual(["a.spec.ts"]);
        expect(fs.existsSync(marker)).toBe(false);
    });
});
