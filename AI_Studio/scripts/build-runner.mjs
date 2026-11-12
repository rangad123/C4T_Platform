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
// Round 51: an exploration runs the engine on the runner (src/agent/explore-child.ts), which brings the AI SDK and what it imports.
// @ai-sdk/provider-utils ships without a LICENSE file: it is part of the AI SDK, under the same Apache-2.0 licence as "ai" listed here.
export const BUNDLED_LICENCES = ["zod", "yaml", "fflate", "ai", "@ai-sdk/gateway", "@ai-sdk/provider", "eventsource-parser", "@opentelemetry/api", "@vercel/oidc"];

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

/**
 * The kit's package-lock.json, cut from this checkout's own lock file: the entries the kit's dependencies reach (Node's lookup rules,
 * nested folders first), so `npm ci` in the kit installs exactly the versions and checksums the platform was built and tested with.
 * Undefined when this checkout has no lock file (then the kit falls back to npm install). Throws when the lock file misses one of them.
 */
export function kitLockfile(kitPackage, root = ROOT) {
    const file = path.join(root, "package-lock.json");
    if (!fs.existsSync(file)) return undefined;
    const lock = readJson(file);
    const all = lock.packages;
    if (lock.lockfileVersion < 2 || !all || typeof all !== "object") return undefined;
    const resolve = (from, name) => {
        for (let base = from; ; ) {
            const at = `${base ? `${base}/` : ""}node_modules/${name}`;
            if (all[at]) return at;
            if (!base) return undefined;
            const i = base.lastIndexOf("/node_modules/");
            base = i < 0 ? "" : base.slice(0, i);
        }
    };
    // Every entry the kit reaches, and which of them it reaches without an optional dependency on the way (the rest are optional for the
    // kit, as npm marks them: Taqwright is an optional dependency of the kit, but a regular one of the platform).
    const reached = new Set();
    const required = new Set();
    const walk = (at, viaRequired) => {
        if (viaRequired ? required.has(at) : reached.has(at)) return;
        reached.add(at);
        if (viaRequired) required.add(at);
        const e = all[at];
        const optional = e.optionalDependencies ?? {};
        for (const dep of Object.keys({ ...e.dependencies, ...optional })) {
            const to = resolve(at, dep);
            if (to) walk(to, viaRequired && !(dep in optional));
            else if (!(dep in optional)) throw new Error(`package-lock.json has no entry for ${dep} (needed by ${at}). Run npm install, then build again.`);
        }
    };
    const roots = [...Object.entries(kitPackage.dependencies ?? {}).map(([n, v]) => [n, v, true]), ...Object.entries(kitPackage.optionalDependencies ?? {}).map(([n, v]) => [n, v, false])];
    for (const [name, want, isRequired] of roots) {
        const at = resolve("", name);
        if (!at) throw new Error(`package-lock.json has no entry for ${name}. Run npm install, then build again.`);
        if (all[at].version !== want) throw new Error(`package-lock.json has ${name} ${all[at].version}, but node_modules has ${want}. Run npm ci, then build again.`);
        walk(at, isRequired);
    }
    const kept = new Map();
    for (const at of [...reached].sort()) {
        // The flags of the platform's own tree (dev, devOptional, peer, optional) do not describe the kit's.
        const entry = { ...all[at] };
        for (const flag of ["dev", "devOptional", "peer", "optional"]) delete entry[flag];
        if (!required.has(at)) entry.optional = true;
        kept.set(at, entry);
    }
    const rootEntry = { name: kitPackage.name, version: kitPackage.version, dependencies: kitPackage.dependencies, optionalDependencies: kitPackage.optionalDependencies, engines: kitPackage.engines };
    const packages = { "": rootEntry, ...Object.fromEntries(kept) };
    return { name: kitPackage.name, version: kitPackage.version, lockfileVersion: 3, requires: true, packages };
}

/**
 * `platformVersion` replaces package.json's version and is stamped into the programs (tests build two versions; docs/features/runner-updates.md).
 * `updateKeys` replaces the update keys built into the runner (src/agent/update-keys.ts): tests only, to trust a test key. Never set it for a
 * download people use.
 */
export async function buildRunner({ root = ROOT, outDir = path.join(root, "dist", "runner"), log = () => {}, platformVersion: versionOverride, updateKeys } = {}) {
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
        ...(updateKeys ? { define: { __AITP_UPDATE_KEYS__: JSON.stringify(updateKeys.map(String)) } } : {}),
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
    // The lock file the start scripts, the Windows installer, the Mac setup and the updater install from (npm ci --ignore-scripts).
    const lock = kitLockfile(kitPackage, root);
    if (lock) fs.writeFileSync(path.join(outDir, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
    else log("No package-lock.json in this checkout: the kit installs its test tools with npm install (no lock file).");

    // The bundle holds copies of these packages, whose licences ask for their notice to travel with them. (axe-core, Playwright and the rest are
    // installed from npm by the kit's own package.json and bring their own.)
    const NL = String.fromCharCode(10);
    const notices = BUNDLED_LICENCES.map((n) => ["=== " + n + " ===", fs.readFileSync(path.join(root, "node_modules", ...n.split("/"), "LICENSE"), "utf8").trim(), ""].join(NL));
    fs.writeFileSync(path.join(outDir, "LICENSES.txt"), ["This runner contains code from these open source packages.", "", ...notices].join(NL) + NL);

    const names = [...Object.keys(ENTRIES).map((e) => `${e}.mjs`), "package.json", "LICENSES.txt", ...(lock ? ["package-lock.json"] : [])].sort();
    const files = names.map((name) => {
        const bytes = fs.readFileSync(path.join(outDir, name));
        return { name, bytes: bytes.length, sha256: sha256(bytes) };
    });

    // The bundle must not carry this machine's folder names (a source map or an absolute path would). Relative "// src/..." comments are fine.
    const home = [root, root.replaceAll("\\", "/"), process.env.USERPROFILE, process.env.HOME].filter((s) => s && s.length > 6);
    for (const f of files) {
        if (f.name === "package.json" || f.name === "package-lock.json") continue;
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
