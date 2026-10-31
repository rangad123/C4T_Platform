// Builds the runner kit's program: the agent and the engine code it reuses, bundled into a few files that run with nothing but Node and
// the packages listed in the kit's package.json (Playwright and friends). The platform's kit download reads the result.
//
//   npm run build:runner                      writes dist/runner/
//   node scripts/build-runner.mjs --out <dir>  writes somewhere else (the tests do)
//   npm run build:runner -- --complete [--targets win-x64,mac-arm64,...]
//                                             also the complete downloads with their own Node.js and packages, into
//                                             dist/runner-complete/ (see scripts/build-runner-complete.mjs)
//
// What goes in: src/agent, src/engine, src/agent-protocol and the little shared code they import (src/config.ts and so on), plus the
// packages those import (zod, yaml). What does not: the platform (server, database, jobs), the web UI, .env files, anything
// from data/. esbuild only follows imports, and the output is scanned below for the one thing that could still leak in: this machine's
// folder names.
//
// One file per entry and no code splitting on purpose: the agent starts its helper processes by file name next to runner.mjs
// (task-child.mjs, record-child.mjs), and a shared chunk in a sub-folder would change what `import.meta.url` means for them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Left to npm in the kit: they ship browsers, native code or dynamic requires, or the generated tests import them themselves. */
export const EXTERNAL = ["playwright", "playwright-core", "@playwright/test", "typescript", "@axe-core/playwright", "@taqwright/taqwright"];
/** Installed with the kit, at exactly the versions this platform uses (read from node_modules, not from the loose ranges in package.json). */
export const KIT_DEPENDENCIES = ["@playwright/test", "playwright", "playwright-core", "typescript", "@axe-core/playwright"];
/**
 * Packages that must exist exactly once in the kit. `@axe-core/playwright` accepts any playwright-core, so without this npm can install a
 * newer top-level playwright-core than the one `playwright` uses: the runner then looks for browsers of the wrong revision and reports that no
 * browser is installed, even though the right one was just downloaded.
 */
export const KIT_SINGLE_COPY = ["playwright-core"];
/** Needed only by Android tests; if npm cannot install it the runner still works for web and API tests. */
export const KIT_OPTIONAL = ["@taqwright/taqwright"];
export const ENTRIES = { runner: "src/agent/index.ts", "task-child": "src/agent/task-child.ts", "record-child": "src/agent/record-child.ts" };
export const NODE_MIN = 24;
/** Packages whose code is copied into the bundle (everything esbuild followed into node_modules). */
export const BUNDLED_LICENCES = ["zod", "yaml"];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function installedVersion(name, root = ROOT) {
    const file = path.join(root, "node_modules", ...name.split("/"), "package.json");
    try {
        return String(readJson(file).version);
    } catch {
        throw new Error(`${name} is not installed in node_modules, so the kit cannot pin its version. Run npm install first.`);
    }
}

/** `platformVersion` replaces package.json's version and is stamped into the programs (tests build two versions; docs/features/runner-updates.md). */
export async function buildRunner({ root = ROOT, outDir = path.join(root, "dist", "runner"), log = () => {}, platformVersion: versionOverride } = {}) {
    let esbuild;
    try {
        esbuild = await import("esbuild");
    } catch {
        throw new Error("esbuild was not found in node_modules. Run npm install, then npm run build:runner again.");
    }
    const platformVersion = String(versionOverride ?? readJson(path.join(root, "package.json")).version ?? "0.0.0");
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    log(`Bundling the runner into ${outDir} ...`);
    await esbuild.build({
        absWorkingDir: root,
        entryPoints: ENTRIES,
        outdir: outDir,
        outExtension: { ".js": ".mjs" },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        splitting: false,
        external: EXTERNAL,
        // A few CommonJS packages call require() for Node's own modules; give the ES module bundle a require that works.
        banner: { js: 'import { createRequire as __aitpCreateRequire } from "node:module"; if (typeof globalThis.require === "undefined") globalThis.require = __aitpCreateRequire(import.meta.url);' + (versionOverride ? `\n// runner version ${String(versionOverride).replace(/[^A-Za-z0-9.+-]/g, "")}` : "") },
        logLevel: "warning",
        sourcemap: false,
    });

    const dependencies = Object.fromEntries(KIT_DEPENDENCIES.map((n) => [n, installedVersion(n, root)]));
    const optionalDependencies = Object.fromEntries(KIT_OPTIONAL.map((n) => [n, installedVersion(n, root)]));
    const kitPackage = {
        name: "ai-test-runner-kit",
        private: true,
        version: "1.0.0",
        description: "Runs tests for the AI Testing Platform on this computer. Generated by the platform; do not publish.",
        type: "module",
        engines: { node: `>=${NODE_MIN}` },
        dependencies,
        optionalDependencies,
        overrides: Object.fromEntries(KIT_SINGLE_COPY.map((n) => [n, installedVersion(n, root)])),
    };
    fs.writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(kitPackage, null, 2)}\n`);

    // The bundle holds copies of these packages, whose licences ask for their notice to travel with them. (axe-core, Playwright and the rest are
    // installed from npm by the kit's own package.json and bring their own.)
    const NL = String.fromCharCode(10);
    const notices = BUNDLED_LICENCES.map((n) => ["=== " + n + " ===", fs.readFileSync(path.join(root, "node_modules", ...n.split("/"), "LICENSE"), "utf8").trim(), ""].join(NL));
    fs.writeFileSync(path.join(outDir, "LICENSES.txt"), ["This runner contains code from these open source packages.", "", ...notices].join(NL) + NL);

    const names = [...Object.keys(ENTRIES).map((e) => `${e}.mjs`), "package.json", "LICENSES.txt"].sort();
    const files = names.map((name) => {
        const bytes = fs.readFileSync(path.join(outDir, name));
        return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });

    // The bundle must not carry this machine's folder names (a source map or an absolute path would). Relative "// src/..." comments are fine.
    const home = [root, root.replaceAll("\\", "/"), process.env.USERPROFILE, process.env.HOME].filter((s) => s && s.length > 6);
    for (const f of files) {
        if (f.name === "package.json") continue;
        const text = fs.readFileSync(path.join(outDir, f.name), "utf8");
        const hit = home.find((h) => text.includes(h));
        if (hit) throw new Error(`${f.name} contains a path of this machine (${hit.slice(0, 3)}...). The kit must not carry local paths.`);
    }

    const hash = sha256(files.map((f) => `${f.name}\0${f.sha256}\n`).join(""));
    const manifest = { format: 1, platformVersion, hash, kitVersion: `${platformVersion}+${hash.slice(0, 10)}`, nodeMin: NODE_MIN, builtAt: new Date().toISOString(), files };
    fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`Done: ${files.length} files, kit version ${manifest.kitVersion}.`);
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = (name) => {
        const i = process.argv.indexOf(name);
        return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
    };
    const outDir = arg("--out") ? path.resolve(arg("--out")) : undefined;
    const log = (l) => console.log(l);
    (async () => {
        await buildRunner({ ...(outDir ? { outDir } : {}), log });
        // --complete: also the downloads that carry their own Node.js and packages (docs/features/runner-complete-kit.md).
        if (!process.argv.includes("--complete")) return;
        const { buildComplete, parseTargets } = await import("./build-runner-complete.mjs");
        const targets = parseTargets(arg("--targets"));
        if (targets.length === 0) return log("Complete downloads: none asked for (--targets none).");
        await buildComplete({
            root: ROOT,
            bundleDir: outDir ?? path.join(ROOT, "dist", "runner"),
            outDir: arg("--complete-out") ? path.resolve(arg("--complete-out")) : path.join(ROOT, "dist", "runner-complete"),
            cacheDir: arg("--cache") ? path.resolve(arg("--cache")) : path.join(ROOT, "dist", "runner-cache"),
            targets,
            log,
        });
    })().catch((e) => {
        console.error(`build:runner failed: ${e instanceof Error ? e.message : e}`);
        process.exit(1);
    });
}
