import { describe, expect, it } from "vitest";
import { classifyPath, decodeUtf8, importProblems, isSafeRepoPath, isUnder, scanTestFile } from "../src/engine/gitimport/files.js";
import { catFileBatchArgs, cloneArgs, fetchCommitArgs, friendlyGitError, gitEnv, lsRemoteArgs, safetyConfig, scrub, validateToken } from "../src/engine/gitimport/git-args.js";
import { buildProvenance, summarizeDiff } from "../src/engine/gitimport/provenance.js";
import { GitInputError, normalizeSubpath, parseRef, parseRepoUrl } from "../src/engine/gitimport/url.js";
import { parseTree } from "../src/platform/git-checkout.js";

const TOKEN = "GHP-sentinel-Tok3n/with+chars==";

describe("repository address policy", () => {
    const ok: Array<[string, string, string]> = [
        ["https://github.com/acme/tests", "github.com", "acme/tests"],
        ["https://github.com/acme/tests.git", "github.com", "acme/tests"],
        ["  https://gitlab.example.org:8443/group/sub/repo/  ", "gitlab.example.org:8443", "group/sub/repo"],
        ["HTTPS://GitHub.com/Acme/Tests", "github.com", "Acme/Tests"],
    ];
    it.each(ok)("accepts %s", (raw, host, repoPath) => {
        const a = parseRepoUrl(raw);
        expect(a.host).toBe(host);
        expect(a.path).toBe(repoPath);
        expect(a.cloneUrl.startsWith("https://")).toBe(true);
        expect(a.cloneUrl).not.toContain("@");
    });

    const refused: Array<[string, RegExp]> = [
        ["ssh://git@github.com/acme/tests.git", /SSH/],
        ["git@github.com:acme/tests.git", /SSH/],
        ["git://github.com/acme/tests.git", /git:\/\//],
        ["file:///etc/passwd", /Local files/],
        ["/etc/passwd", /does not look like/],
        ["C:\\repos\\tests", /does not look like|Only https/],
        ["http://github.com/acme/tests", /https/],
        ["https://user:pw@github.com/acme/tests", /user name and password/],
        ["https://tok@github.com/acme/tests", /user name and password/],
        ["https://github.com/acme/tests?x=1", /query/],
        ["https://github.com/", /name a repository/],
        ["--upload-pack=calc https://github.com/a/b", /spaces|does not look like/],
        ["-oProxyCommand=x", /does not look like/],
        ["ftp://example.com/a/b", /https/],
        ["", /Enter the address/],
        ["https://github.com/a b/c", /spaces/],
        [`https://example.com/${"a".repeat(600)}`, /too long/],
    ];
    it.each(refused)("refuses %s", (raw, why) => {
        expect(() => parseRepoUrl(raw)).toThrow(GitInputError);
        expect(() => parseRepoUrl(raw)).toThrow(why);
    });

    it("only the test seam allows local sources", () => {
        expect(() => parseRepoUrl("C:\\repos\\tests")).toThrow();
        const a = parseRepoUrl("C:\\repos\\tests.git", { allowLocal: true });
        expect(a.transport).toBe("local");
        expect(a.host).toBe("local");
        expect(parseRepoUrl("http://127.0.0.1:6091/x/y.git", { allowLocal: true }).host).toBe("127.0.0.1:6091");
        expect(parseRepoUrl("file:///c:/tmp/r.git", { allowLocal: true }).transport).toBe("local");
    });
});

describe("ref and folder input", () => {
    it("accepts branches, tags and full commit ids", () => {
        expect(parseRef(undefined)).toEqual({ ref: "", isCommit: false });
        expect(parseRef("main")).toEqual({ ref: "main", isCommit: false });
        expect(parseRef("release/1.2.3")).toEqual({ ref: "release/1.2.3", isCommit: false });
        expect(parseRef("a".repeat(40))).toEqual({ ref: "a".repeat(40), isCommit: true });
        expect(parseRef("A".repeat(40)).ref).toBe("a".repeat(40));
    });
    it.each(["--upload-pack=x", "-x", "a..b", "a b", "a;rm", "a$(x)", "x/", "a//b", "x.lock", "a@{1}", "a".repeat(201), "ref\nname"])("refuses ref %j", (r) => {
        expect(() => parseRef(r)).toThrow(GitInputError);
    });
    it("normalises the folder and refuses escapes", () => {
        expect(normalizeSubpath(undefined)).toBe("");
        expect(normalizeSubpath(".")).toBe("");
        expect(normalizeSubpath("/")).toBe("");
        expect(normalizeSubpath("tests\\e2e/")).toBe("tests/e2e");
        expect(normalizeSubpath("./a/./b")).toBe("a/b");
        for (const bad of ["../x", "a/../../x", "/etc", "C:/x", "a/.git/b", "a\u0000b"]) expect(() => normalizeSubpath(bad)).toThrow(GitInputError);
    });
});

describe("file filtering and reading", () => {
    it("picks test files and ignores dependency and hidden folders", () => {
        expect(classifyPath("tests/login.spec.ts")).toBe("candidate");
        expect(classifyPath("a/b/c.test.js")).toBe("candidate");
        expect(classifyPath("a.spec.ts")).toBe("candidate");
        expect(classifyPath("README.md")).toBe("ignore");
        expect(classifyPath("src/util.ts")).toBe("ignore");
        expect(classifyPath("login.spec.tsx")).toBe("ignore");
        expect(classifyPath("node_modules/pkg/x.spec.ts")).toBe("dependency-folder");
        expect(classifyPath(".github/x.spec.ts")).toBe("hidden-folder");
        expect(classifyPath("a/.cache/x.test.ts")).toBe("hidden-folder");
    });
    it("recognises unsafe repository paths", () => {
        for (const bad of ["", "/abs", "a/../b", "a\\b", "C:/x", "a//b", "./a", "a/\u0000"]) expect(isSafeRepoPath(bad)).toBe(false);
        expect(isSafeRepoPath("tests/e2e/a.spec.ts")).toBe(true);
    });
    it("isUnder follows folder boundaries", () => {
        expect(isUnder("tests/a.spec.ts", "tests")).toBe(true);
        expect(isUnder("tests2/a.spec.ts", "tests")).toBe(false);
        expect(isUnder("x.spec.ts", "")).toBe(true);
    });
    it("decodes only UTF-8 text", () => {
        expect(decodeUtf8(Buffer.from("héllo"))).toBe("héllo");
        expect(decodeUtf8(Buffer.from([0x66, 0x6f, 0x80, 0x81]))).toBeNull();
        expect(decodeUtf8(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
        expect(decodeUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x")]))).toBe("x");
    });

    it("counts tests and takes the title from describe, then the first test, then the file name", () => {
        const withDescribe = `import { test, expect } from "@playwright/test";
test.describe("Checkout flow", () => {
  test("adds an item", async ({ page }) => {});
  test.only("pays", async ({ page }) => { test.skip(true, "later"); });
  test.skip("old", async () => {});
});
test.describe.serial("Other", () => { test("x", async () => {}); });
test.use({ locale: "en" });
test.beforeEach(async () => {});`;
        const a = scanTestFile(withDescribe, "tests/checkout.spec.ts");
        expect(a.title).toBe("Checkout flow");
        expect(a.tests).toBe(4);
        expect(scanTestFile(`test("Logs in", async () => {}); test("Logs out", async () => {});`, "x.spec.ts")).toMatchObject({ title: "Logs in", tests: 2 });
        expect(scanTestFile(`// nothing`, "tests/my-cool_page.spec.ts")).toMatchObject({ title: "my cool page", tests: 0 });
        expect(scanTestFile(`this is not (valid {{ typescript`, "broken.spec.ts").tests).toBe(0);
        // tests named by a variable are still tests, but cannot be titled
        expect(scanTestFile("const n = 'a'; test(n, async () => {});", "v.spec.ts").tests).toBe(0);
    });
    it("caps and cleans titles from untrusted text", () => {
        const long = "x".repeat(400);
        const s = scanTestFile(`test("${long}", async () => {});`, "t.spec.ts");
        expect(s.title.length).toBeLessThanOrEqual(160);
        const ctl = scanTestFile("test(\"a\\u0007b\\nc\", async () => {});", "t.spec.ts");
        expect(ctl.title).toBe("a b c");
    });
    it("lists every kind of import, including require and dynamic import", () => {
        const s = scanTestFile(
            `import { test } from "@playwright/test"; import x = require("../old");
import u from "../lib/util"; export * from "./helpers/shared"; const m = require("child_process"); const d = await import("./helpers/late");`,
            "i.spec.ts",
        );
        expect(s.imports.sort()).toEqual(["../lib/util", "../old", "./helpers/late", "./helpers/shared", "@playwright/test", "child_process"].sort());
        expect(s.helpers.sort()).toEqual(["late", "shared"]);
    });
    it("explains imports in plain words", () => {
        const scan = scanTestFile(`import "@playwright/test"; import "./helpers/nav"; import "./helpers/ghost"; import "../lib/util"; import "@app/models"; import fs from "node:fs"; import cp from "child_process"; import "lodash";`, "a.spec.ts");
        const p = importProblems(scan, new Set(["nav"]));
        expect(p.some((m) => m.includes("helper named ghost that doesn't exist yet"))).toBe(true);
        expect(p.some((m) => m.includes("../lib/util"))).toBe(true);
        expect(p.some((m) => m.includes("@app/models"))).toBe(true);
        expect(p.some((m) => m.includes("lodash"))).toBe(true);
        expect(p.some((m) => m.includes("nav"))).toBe(false);
        // Node built-ins are left to the static guard
        expect(p.some((m) => m.includes("child_process") || m.includes("node:fs"))).toBe(false);
        expect(importProblems(scanTestFile(`import "@playwright/test"; import "@axe-core/playwright"; import "./helpers/nav.ts"`, "a.spec.ts"), new Set(["nav"]))).toEqual([]);
    });
});

describe("git command lines", () => {
    const cfg = safetyConfig({ hooksDir: "C:/scratch/no-hooks", allowLocal: false });
    const joined = (a: string[]) => a.join(" ");

    it("switches hooks, symlinks, credential helpers, submodules and other transports off", () => {
        const j = joined(cfg);
        for (const must of ["core.symlinks=false", "core.hooksPath=C:/scratch/no-hooks", "credential.helper=", "http.followRedirects=initial", "protocol.file.allow=never", "submodule.recurse=false", "protocol.ssh.allow=never"]) expect(j).toContain(must);
        expect(joined(safetyConfig({ hooksDir: "h", allowLocal: true }))).toContain("protocol.file.allow=always");
    });
    it("builds a shallow single-branch clone with the address after --", () => {
        const a = cloneArgs(cfg, { url: "https://github.com/acme/tests", dir: "D:/w/repo", ref: "main", allowLocal: false });
        expect(a.slice(a.indexOf("clone"))).toEqual(["clone", "--depth", "1", "--single-branch", "--no-tags", "--no-checkout", "--no-recurse-submodules", "--branch", "main", "--", "https://github.com/acme/tests", "D:/w/repo"]);
        expect(cloneArgs(cfg, { url: "u", dir: "d", ref: "", allowLocal: false })).not.toContain("--branch");
        expect(fetchCommitArgs(cfg, "https://h/x", "a".repeat(40)).slice(-3)).toEqual(["--", "https://h/x", "a".repeat(40)]);
        expect(lsRemoteArgs(cfg, "https://h/x", "").slice(-2)).toEqual(["--", "https://h/x"].concat(["HEAD"]).slice(-2));
        expect(catFileBatchArgs(cfg).at(-1)).toBe("--batch");
    });
    it("never puts the token in an argument; it goes in the environment, limited to the repository's origin", () => {
        const args = [...cloneArgs(cfg, { url: "https://github.com/acme/tests", dir: "d", ref: "main", allowLocal: false }), ...lsRemoteArgs(cfg, "https://github.com/acme/tests", "main"), ...cfg];
        expect(args.some((x) => x.includes(TOKEN))).toBe(false);
        const env = gitEnv({ base: { PATH: "/bin", SECRET_KEY: "platform-secret-key-1234", ANTHROPIC_API_KEY: "k" }, scratch: "s", emptyConfig: "s/gitconfig", origin: "https://github.com", token: TOKEN, allowLocal: false });
        expect(env.GIT_CONFIG_COUNT).toBe("1");
        expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
        expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${TOKEN}`);
        expect(env.SECRET_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
        expect(env.GIT_ALLOW_PROTOCOL).toBe("https");
        expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
        expect(gitEnv({ base: {}, scratch: "s", emptyConfig: "e", allowLocal: false }).GIT_CONFIG_COUNT).toBeUndefined();
    });
    it("checks tokens before they reach a header", () => {
        expect(validateToken(undefined)).toBeUndefined();
        expect(validateToken("")).toBeUndefined();
        expect(validateToken(TOKEN)).toBe(TOKEN);
        for (const bad of ["a b", "a\nX-Evil: 1", "a\r", "a\u0000", "x".repeat(501)]) expect(() => validateToken(bad)).toThrow(GitInputError);
    });
});

describe("scrubbing and plain errors", () => {
    it("removes the token and its encodings from any text", () => {
        const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
        const text = `fatal: unable to access 'https://user:${TOKEN}@github.com/a/b/': Authorization: Bearer ${TOKEN}; enc=${encodeURIComponent(TOKEN)} basic=${b64} https://oauth2:other@host/x`;
        const out = scrub(text, [TOKEN]);
        expect(out).not.toContain(TOKEN);
        expect(out).not.toContain(encodeURIComponent(TOKEN));
        expect(out).not.toContain(b64);
        expect(out).not.toContain("other@");
        expect(scrub("nothing here", [undefined, ""])).toBe("nothing here");
    });
    it("maps git's messages to sentences without raw output", () => {
        const f = friendlyGitError;
        expect(f("fatal: Authentication failed for 'https://x/'", { hasToken: true })).toMatch(/refused the access token/);
        expect(f("fatal: could not read Username for 'https://x': terminal prompts disabled", { hasToken: false })).toMatch(/needs a sign-in/);
        expect(f("remote: Repository not found.\nfatal: repository 'https://x/' not found", {})).toMatch(/No repository was found/);
        expect(f("fatal: Remote branch nope not found in upstream origin", {})).toMatch(/branch, tag or commit does not exist/);
        expect(f("fatal: unable to access 'https://x/': Could not resolve host: x", {})).toMatch(/could not be reached/);
        expect(f("", { timedOut: true })).toMatch(/too long/);
        expect(f("", { tooLarge: true })).toMatch(/too large/);
        expect(f("garbage", {})).toMatch(/could not be downloaded/);
        expect(f("garbage C:\\Users\\secret\\path", {})).not.toContain("secret");
    });
});

describe("tree listing, provenance and diffs", () => {
    it("parses ls-tree output and drops unsafe paths", () => {
        const sha = "a".repeat(40);
        const text = [`100644 blob ${sha}     123\ttests/a.spec.ts`, `120000 blob ${sha}       9\tlink.spec.ts`, `160000 commit ${sha}       -\tsub`, `100644 blob ${sha}       1\t../evil.spec.ts`, `100644 blob ${sha}       1\t/abs.spec.ts`, ""].join("\0");
        const e = parseTree(text);
        expect(e.map((x) => x.path)).toEqual(["tests/a.spec.ts", "link.spec.ts", "sub"]);
        expect(e[0]).toMatchObject({ mode: "100644", type: "blob", size: 123 });
        expect(e[1]!.mode).toBe("120000");
        expect(e[2]).toMatchObject({ type: "commit", size: 0 });
    });
    it("builds provenance and summarises line changes", () => {
        const p = buildProvenance({ host: "github.com", path: "acme/tests", ref: "main", commit: "abc", repoId: "r1", file: "a.spec.ts", now: new Date("2026-01-01T00:00:00Z") });
        expect(p).toEqual({ host: "github.com", path: "acme/tests", ref: "main", commit: "abc", importedAt: "2026-01-01T00:00:00.000Z", repoId: "r1", file: "a.spec.ts" });
        expect(summarizeDiff("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
        expect(summarizeDiff("same", "same")).toEqual({ added: 0, removed: 0 });
    });
});
