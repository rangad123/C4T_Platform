/**
 * Downloads that run anywhere (docs/features/portable-code-tests.md): the lockfile cut from the platform's own package-lock.json, the
 * pinned versions, the Node.js version, the configs and the README of a download, and the two download routes (the project and one test).
 * No browser runs here; tests/portable-export-run.test.ts runs a download with the Playwright installed in this checkout.
 *
 * Starts an in-process platform (no port): node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/portable-export.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cutLockfile, LockCutError, nodeFloor, resolveIn, type Lockfile } from "../src/engine/portable/lockfile.js";
import { OLDEST_PLAYWRIGHT } from "../src/engine/portable/playwright-apis.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { exportPath, packageName, platformLock, portableFiles, type ExportScript } from "../src/platform/portable-export.js";
import { buildServer } from "../src/platform/server.js";
// @ts-expect-error plain JavaScript script (no type declarations)
import { checkDownload, CODE_HELPER, codeTest, parseArgs, portableSpecs, readResults, testEnv } from "../scripts/portable-check.mjs";

const REPO = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoLock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8")) as Lockfile;
const installed = (name: string) => repoLock.packages[`node_modules/${name}`]!.version!;

describe("the lockfile cut from the platform's own", () => {
    const tiny: Lockfile = {
        lockfileVersion: 3,
        packages: {
            "": { name: "platform" },
            "node_modules/a": { version: "1.0.0", resolved: "https://registry.example/a.tgz", integrity: "sha512-a", dependencies: { b: "^2.0.0", c: "^1.0.0" }, optionalDependencies: { gone: "1.0.0", opt: "1.0.0" } },
            "node_modules/b": { version: "1.5.0", dependencies: {} },
            "node_modules/a/node_modules/b": { version: "2.1.0", dev: true },
            "node_modules/c": { version: "1.0.0", peerDependencies: { a: "*", ghost: "*" }, peerDependenciesMeta: { ghost: { optional: true } } },
            "node_modules/opt": { version: "1.0.0", os: ["darwin"], dependencies: { b: "^1.0.0" } },
            "node_modules/unrelated": { version: "9.9.9" },
            "node_modules/linked": { version: "1.0.0", link: true },
            "node_modules/broken": { version: "1.0.0", dependencies: { missing: "1.0.0" } },
        },
    };

    it("finds packages the way Node.js does: its own node_modules first, then the enclosing ones", () => {
        expect(resolveIn(tiny.packages, "node_modules/a", "b")).toBe("node_modules/a/node_modules/b");
        expect(resolveIn(tiny.packages, "node_modules/c", "b")).toBe("node_modules/b");
        expect(resolveIn(tiny.packages, "node_modules/a/node_modules/b", "c")).toBe("node_modules/c");
        expect(resolveIn(tiny.packages, "node_modules/a", "nope")).toBeUndefined();
    });

    it("keeps exactly what the pinned packages need, copied as they are, all dev, optional where only optional edges reach", () => {
        const cut = cutLockfile(tiny, { a: "1.0.0" }, { name: "x-tests", version: "1.0.0" });
        expect(cut.lockfileVersion).toBe(3);
        expect(cut.packages[""]).toEqual({ name: "x-tests", version: "1.0.0", devDependencies: { a: "1.0.0" } });
        expect(Object.keys(cut.packages).sort()).toEqual(["", "node_modules/a", "node_modules/a/node_modules/b", "node_modules/b", "node_modules/c", "node_modules/opt"]);
        expect(cut.packages["node_modules/a"]).toEqual({ ...tiny.packages["node_modules/a"], dev: true });
        expect(cut.packages["node_modules/a/node_modules/b"]).toEqual({ version: "2.1.0", dev: true });
        // opt is reached only through an optional dependency, and b (top level) only through opt
        expect(cut.packages["node_modules/opt"]).toMatchObject({ dev: true, optional: true, os: ["darwin"] });
        expect(cut.packages["node_modules/b"]).toMatchObject({ dev: true, optional: true });
        expect(cut.packages["node_modules/c"]!.optional).toBeUndefined();
    });

    it("refuses a pin the platform does not have at that version, a missing dependency and a linked package", () => {
        expect(() => cutLockfile(tiny, { a: "1.0.1" }, { name: "x", version: "1.0.0" })).toThrow(LockCutError);
        expect(() => cutLockfile(tiny, { nothere: "1.0.0" }, { name: "x", version: "1.0.0" })).toThrow(/not in the platform's package-lock.json/);
        expect(() => cutLockfile(tiny, { broken: "1.0.0" }, { name: "x", version: "1.0.0" })).toThrow(/needs missing/);
        expect(() => cutLockfile(tiny, { linked: "1.0.0" }, { name: "x", version: "1.0.0" })).toThrow(/linked package/);
        expect(() => cutLockfile({ lockfileVersion: 1, packages: {} } as Lockfile, {}, { name: "x", version: "1.0.0" })).toThrow(/too old/);
    });

    it("reads the lowest Node.js version each package allows", () => {
        expect(nodeFloor([{ engines: { node: ">=20" } }, { engines: { node: "^14.17.0 || >=16" } }, { engines: { node: ">=18.20.0" } }, {}])).toEqual([20, 0, 0]);
        expect(nodeFloor([{ engines: { node: ">=24.0.0" } }, { engines: { node: "<30" } }])).toEqual([24, 0, 0]);
    });

    it("cut from this repository's real lockfile: truthful for Playwright, axe and Taqwright, complete, and what is installed here", () => {
        const pins = { "@playwright/test": installed("@playwright/test"), "@axe-core/playwright": installed("@axe-core/playwright"), "@taqwright/taqwright": installed("@taqwright/taqwright") };
        const cut = cutLockfile(repoLock, pins, { name: "sample-tests", version: "1.0.0" });
        const keys = Object.keys(cut.packages).filter((k) => k !== "");
        expect(keys.length).toBeGreaterThan(20);
        for (const k of keys) {
            const { dev, optional, devOptional, peer, ...copied } = cut.packages[k]!;
            const { dev: d2, optional: o2, devOptional: v2, peer: p2, ...source } = repoLock.packages[k]!;
            void [devOptional, peer, d2, o2, v2, p2];
            expect(copied, k).toEqual(source);
            expect(dev, k).toBe(true);
            expect(copied.integrity, k).toMatch(/^sha(512|1)-/);
            expect(copied.resolved, k).toMatch(/^https:\/\/registry\.npmjs\.org\//);
            // the version written is the version installed in this checkout at that place
            const onDisk = path.join(REPO, k, "package.json");
            if (fs.existsSync(onDisk)) expect(JSON.parse(fs.readFileSync(onDisk, "utf8")).version, k).toBe(copied.version);
            else expect(optional, `${k} is not installed here, so it must be optional (another system's package)`).toBe(true);
            // every dependency resolves inside the cut
            for (const dep of Object.keys(copied.dependencies ?? {})) expect(resolveIn(cut.packages, k, dep), `${k} -> ${dep}`).toBeDefined();
        }
        // a cut for Playwright alone holds nothing of Taqwright's
        const small = cutLockfile(repoLock, { "@playwright/test": pins["@playwright/test"] }, { name: "x", version: "1.0.0" });
        expect(Object.keys(small.packages).sort()).toEqual(["", "node_modules/@playwright/test", "node_modules/playwright", "node_modules/playwright-core", ...Object.keys(small.packages).filter((k) => k.includes("fsevents"))].sort());
    });
});

const web: ExportScript = { path: "tests/shop/WEB-001.spec.ts", framework: "playwright", content: `import { test, expect } from "@playwright/test";\nconst BASE_URL = process.env.BASE_URL ?? "https://shop.example.test";\nconst p = process.env.TEST_PASSWORD;\nconst q = process.env.AITP_EVIDENCE;\n` };
const axe: ExportScript = { path: "tests/shop/WEB-002.spec.ts", framework: "playwright", content: `import { AxeBuilder } from "@axe-core/playwright";\n` };

describe("what a download carries", () => {
    it("pins the exact versions the platform runs, with their lockfile, the Node.js they need and the three steps", () => {
        const r = portableFiles({ projectName: "Démo Shop / EU", scripts: [web, axe] });
        expect(r.pins).toEqual({ "@playwright/test": installed("@playwright/test"), "@axe-core/playwright": installed("@axe-core/playwright") });
        const pkg = JSON.parse(r.files["package.json"]!);
        expect(pkg).toMatchObject({ name: "demo-shop-eu-tests", private: true, scripts: { test: "playwright test" }, devDependencies: r.pins, engines: { node: ">=20.0.0" } });
        expect(pkg.scripts["test:phone"]).toBeUndefined();
        const lock = JSON.parse(r.files["package-lock.json"]!);
        expect(lock.name).toBe(pkg.name);
        expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
        expect(lock.packages["node_modules/@axe-core/playwright"].version).toBe(installed("@axe-core/playwright"));
        expect(r.files[".nvmrc"]).toBe("20\n");
        expect(r.files[".gitignore"]).toContain("node_modules/");
        expect(r.files["taqwright.config.ts"]).toBeUndefined();
        const readme = r.files["README.md"]!;
        expect(readme).toContain("```\nnpm ci\nnpx playwright install\nnpx playwright test\n```");
        expect(readme).toContain(`Playwright ${OLDEST_PLAYWRIGHT} or newer`);
        expect(readme).toContain("`BASE_URL`");
        expect(readme).toContain("`TEST_PASSWORD`: The test account's password.");
        expect(readme).not.toContain("AITP_");
        expect(r.notes).toEqual([]);
        // the config: Chrome at the platform's window size, the platform's time limits, no desktop project
        const cfg = r.files["playwright.config.ts"]!;
        expect(cfg).toContain('...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }');
        expect(cfg).toContain("timeout: 60_000");
        expect(cfg).not.toContain("windows-desktop");
        // without axe, no axe pin
        expect(portableFiles({ projectName: "x", scripts: [web] }).pins).toEqual({ "@playwright/test": installed("@playwright/test") });
    });

    it("phone tests go to phone-tests/ with Taqwright pinned, their config, npm run test:phone and the Node.js Taqwright needs", () => {
        expect(exportPath("taqwright", "shop", "MOB-001.spec.ts")).toBe("phone-tests/android/shop/MOB-001.spec.ts");
        expect(exportPath("taqwright-ios", "shop", "MOB-002.spec.ts")).toBe("phone-tests/ios/shop/MOB-002.spec.ts");
        expect(exportPath("playwright-api", "api", "API-001.spec.ts")).toBe("tests/api/API-001.spec.ts");
        const phone: ExportScript = { path: "phone-tests/android/shop/MOB-001.spec.ts", framework: "taqwright", content: `import { test, expect } from "@taqwright/taqwright";\nconst pkg = process.env.MOBILE_APP_PACKAGE;\n` };
        const r = portableFiles({ projectName: "Phones", scripts: [web, phone] });
        expect(r.pins["@taqwright/taqwright"]).toBe(installed("@taqwright/taqwright"));
        const pkg = JSON.parse(r.files["package.json"]!);
        expect(pkg.scripts["test:phone"]).toBe("taqwright test --config taqwright.config.ts");
        const floor = (repoLock.packages["node_modules/@taqwright/taqwright"]!.engines!.node as string).replace(/^>=/, "");
        expect(pkg.engines.node).toBe(`>=${floor}`);
        expect(r.files[".nvmrc"]).toBe(`${floor.split(".")[0]}\n`);
        expect(r.files["taqwright.config.ts"]).toContain('testDir: "./phone-tests/android"');
        expect(r.files["taqwright.config.ts"]).not.toContain("Platform.IOS");
        expect(r.files["README.md"]).toContain("## Phone tests");
        expect(r.files["README.md"]).toContain("`MOBILE_APP_PACKAGE`");
    });

    it("desktop tests get a Windows-only project; the load check's helper raises the Node.js version to 20.16", () => {
        const dsk: ExportScript = { path: "tests/desktop/DSK-001.spec.ts", framework: "windows-uia", content: `import { test } from "@playwright/test";\n` };
        const loadScript: ExportScript = { path: "tests/api/API-002.spec.ts", framework: "playwright-api", content: `const fs = process.getBuiltinModule("node:fs");\n` };
        const r = portableFiles({ projectName: "Desk", scripts: [web, dsk, loadScript] });
        expect(r.files["playwright.config.ts"]).toContain('testIgnore: ["desktop/DSK-001.spec.ts"]');
        expect(r.files["playwright.config.ts"]).toContain('...(process.platform === "win32" ? [{ name: "windows-desktop", testMatch: ["desktop/DSK-001.spec.ts"] }] : [])');
        expect(JSON.parse(r.files["package.json"]!).engines.node).toBe(">=20.16.0");
        expect(r.files["README.md"]).toContain("## Windows desktop tests");
    });

    it("an installation without a lockfile still gives a working download and says plainly what is missing", () => {
        const r = portableFiles({ projectName: "x", scripts: [web], lock: undefined });
        expect(r.files["package-lock.json"]).toBeUndefined();
        expect(JSON.parse(r.files["package.json"]!).devDependencies).toEqual({});
        expect(r.files["README.md"]).toContain("```\nnpm install\nnpx playwright install");
        expect(r.notes.join(" ")).toMatch(/not pinned/);
        expect(r.notes.join(" ")).toMatch(/no package-lock.json/);
        expect(platformLock(path.join(os.tmpdir(), "no-such-folder", "package-lock.json"))).toBeUndefined();
        expect(packageName("!!!")).toBe("exported-tests");
    });
});

describe("the download routes", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dataDir: string;
    const KEY = "portable-test-key-0123";
    const APP = "http://127.0.0.1:6961";
    const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
        const res = await server.inject({ method, url, payload: payload as never, headers: { "x-api-key": KEY, ...(payload !== undefined ? { "content-type": "application/json" } : {}) } });
        return { status: res.statusCode, body: res.headers["content-type"]?.toString().includes("json") ? res.json() : undefined, raw: res.rawPayload, headers: res.headers };
    };
    let pid = "";
    let tests: Array<{ id: string; testId: string }> = [];
    let codeId = "";

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "portable-secret-key-0123456789", API_KEY: KEY, MAX_REPAIR_ATTEMPTS: "0" }));
        server = await buildServer(platform);
        pid = (await call("POST", "/api/projects", { name: "Portable sample" })).body.id;
        const imp = await call("POST", `/api/projects/${pid}/specs`, { baseUrl: APP, validate: false, specs: portableSpecs(APP) });
        expect(imp.status).toBe(202);
        tests = imp.body.tests;
        expect((await call("PUT", `/api/projects/${pid}/helpers/shop`, { content: CODE_HELPER })).status).toBe(200);
        const c = await call("POST", `/api/projects/${pid}/custom-tests`, { title: "The product list shows four products", kind: "web", category: "Shop", content: codeTest(APP) });
        expect(c.status).toBe(201);
        codeId = c.body.testId;
    }, 120_000);

    afterAll(async () => {
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    const unzip = (raw: Buffer) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(raw))).map(([k, v]) => [k, strFromU8(v)]));

    it("the project download holds the tests, the helper, and package.json, lockfile, .nvmrc, configs, README and .gitignore", async () => {
        const r = await call("GET", `/api/projects/${pid}/download?includeUnvalidated=true`);
        expect(r.status).toBe(200);
        const files = unzip(r.raw);
        const names = Object.keys(files);
        for (const f of ["package.json", "package-lock.json", ".nvmrc", ".gitignore", "playwright.config.ts", "README.md", "manifest.json", "results/validation-junit.xml", "tests/shop/helpers/shop.ts"]) expect(names, f).toContain(f);
        expect(names.filter((n) => n.endsWith(".spec.ts"))).toHaveLength(6);
        expect(names.some((n) => n.startsWith("phone-tests/"))).toBe(false);
        // what the person's computer gets is checked by the same function the real-machine check uses
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-dl-"));
        try {
            for (const [n, t] of Object.entries(files)) {
                fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
                fs.writeFileSync(path.join(dir, n), t);
            }
            expect(checkDownload(dir).problems).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        const pkg = JSON.parse(files["package.json"]!);
        expect(pkg.name).toBe("portable-sample-tests");
        // an accessibility check is among the tests: axe is pinned too
        expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@axe-core/playwright", "@playwright/test"]);
        const manifest = JSON.parse(files["manifest.json"]!) as Array<{ file: string }>;
        for (const m of manifest) expect(names).toContain(m.file);
        expect(files["README.md"]).toContain("# Tests of Portable sample");
        expect(files["README.md"]).toContain("manifest.json, specs/");
    });

    it("one test downloads on its own, the same way; a code test brings the helper it imports", async () => {
        const one = await call("GET", `/api/tests/${tests[3]!.id}/download`);
        expect(one.status).toBe(200);
        expect(String(one.headers["content-disposition"])).toBe(`attachment; filename="${tests[3]!.testId}.zip"`);
        const files = unzip(one.raw);
        expect(Object.keys(files).filter((n) => n.endsWith(".spec.ts"))).toEqual([`tests/api/${tests[3]!.testId}.spec.ts`]);
        expect(Object.keys(files)).toContain(`specs/${tests[3]!.testId}.json`);
        expect(JSON.parse(files["package.json"]!).devDependencies).toEqual({ "@playwright/test": installed("@playwright/test") });
        expect(files["README.md"]).toContain(`# ${tests[3]!.testId}: The product list answers`);
        expect(files["README.md"]).not.toContain("manifest.json");

        const code = await call("GET", `/api/tests/${codeId}/download`);
        const cf = unzip(code.raw);
        expect(Object.keys(cf).filter((n) => n.startsWith("tests/")).sort()).toEqual(["tests/shop/WEB-004.spec.ts", "tests/shop/helpers/shop.ts"]);
        expect(Object.keys(cf).some((n) => n.startsWith("specs/"))).toBe(false);

        expect((await call("GET", "/api/tests/no-such-test/download")).status).toBe(404);
        // the access key is required, like every other route
        expect((await server.inject({ method: "GET", url: `/api/tests/${codeId}/download` })).statusCode).toBe(401);
    });
});

describe("the real-machine check's own pieces", () => {
    it("reads its arguments and refuses the plain mistakes", () => {
        expect(parseArgs([])).toMatchObject({ port: 6956, linkNodeModules: false, installDeps: false });
        expect(parseArgs(["--playwright", OLDEST_PLAYWRIGHT, "--install-deps", "--port", "6958"])).toMatchObject({ playwright: OLDEST_PLAYWRIGHT, installDeps: true, port: 6958 });
        expect(() => parseArgs(["--playwright", "latest"])).toThrow(/exact version/);
        expect(() => parseArgs(["--link-node-modules", "--playwright", "1.50.0"])).toThrow(/cannot be combined/);
        expect(() => parseArgs(["--port", "3999"])).toThrow(/4000/);
        expect(() => parseArgs(["--export-only"])).toThrow(/--dir/);
        expect(() => parseArgs(["--from", path.join(os.tmpdir(), "nothing-here-portable")])).toThrow(/no package.json/);
    });

    it("gives the tests the computer's environment without the platform's settings or any test secret", () => {
        const env = testEnv({ PATH: "/bin", API_KEY: "k", TEST_PASSWORD: "p", AITP_PROXY_TESTS: "1", NODE_OPTIONS: "--x", TEMP: "/tmp" }, "http://127.0.0.1:6959");
        expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", BASE_URL: "http://127.0.0.1:6959", API_BASE_URL: "http://127.0.0.1:6959", FORCE_COLOR: "0", CI: "1" });
    });

    it("reads Playwright's JSON report", () => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aitp-portable-r-")), "r.json");
        fs.writeFileSync(f, JSON.stringify({ stats: { expected: 5, unexpected: 1, flaky: 0, skipped: 0 }, suites: [{ suites: [{ specs: [{ title: "A", ok: false, tests: [{ results: [{ error: { message: "Expected 4\nReceived 3" } }] }] }, { title: "B", ok: true }] }] }] }));
        expect(readResults(f)).toEqual({ passed: 5, failed: 1, skipped: 0, failures: ["A: Expected 4"] });
    });
});
