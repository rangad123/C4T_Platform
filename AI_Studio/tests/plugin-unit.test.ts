/**
 * Adapter plug-ins, the parts that need no browser and no platform: the manifest and the adapter contract (a table of good and bad
 * ones), the rule for when plug-ins load, the paths that are refused, how an answer from a plug-in is cleaned, and containment of a
 * plug-in that throws, hangs or lies. Plug-ins here are small real ES modules written to a temp folder and really imported.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatReport, runChecks, type Probes } from "../src/cli/doctor.js";
import { ADAPTER_PLUGINS_NEED_API_KEY, loadConfig } from "../src/config.js";
import { AdapterRegistry } from "../src/engine/frameworks/index.js";
import { checkAdapterShape, checkPluginPath, displayName, ManifestSchema, parseManifest, PLUGIN_LIMITS, sanitizeRuns, sanitizeScript, splitPluginList } from "../src/engine/frameworks/plugin.js";
import { explainMissingFramework, getPluginStatus, loadPlugins, PluginAdapter, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";
import { TestSpecSchema, type TestSpec } from "../src/engine/spec/schema.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-plugin-unit-"));
afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => unloadPlugins());

// ── helpers ─────────────────────────────────────────────────────────────────

const BUILT_IN = new Set(["playwright", "playwright-api", "taqwright", "windows-uia", "taqwright-ios"]);
const spec = (kind: "api" | "web" = "api"): TestSpec =>
    TestSpecSchema.parse({ testId: "API-001", title: "A plug-in test", kind, steps: [kind === "api" ? { action: "request", method: "GET", path: "/x" } : { action: "navigate", url: "/" }] });

const goodAdapter = (over: Record<string, unknown> = {}) => ({
    id: "demo-one",
    label: "Demo one",
    kinds: ["api"],
    executable: true,
    runtime: "demo-runtime",
    needs: { node: true },
    traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    render: (s: TestSpec) => ({ filename: `${s.testId}.demo.txt`, content: "demo script" }),
    execute: async (batch: { scripts: Array<{ testId: string }> }) => batch.scripts.map((s) => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] })),
    ...over,
});
const manifestOf = (over: Record<string, unknown> = {}) => ({ name: "demo", version: "1.0.0", apiVersion: 1, description: "A demo", adapters: [{ id: "demo-one", label: "Demo one" }], ...over });

/** A plug-in folder on disk: plugin.json plus adapter.mjs (the module's source text). */
function writePlugin(name: string, manifest: unknown, source: string | null): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (manifest !== null) fs.writeFileSync(path.join(dir, "plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    if (source !== null) fs.writeFileSync(path.join(dir, "adapter.mjs"), source);
    return dir;
}
const GOOD_SOURCE = `export default ${"{"}
    id: "demo-one", label: "Demo one", kinds: ["api"], executable: true, runtime: "demo-runtime",
    needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    render(spec) { return { filename: spec.testId + ".demo.txt", content: "demo script" }; },
    async execute(batch) { return batch.scripts.map((s) => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] })); },
};
`;

async function load(list: string[], over: Record<string, unknown> = {}) {
    const registry = new AdapterRegistry();
    const status = await loadPlugins({ enabled: true, requested: true, list: list.join(";"), registry, ...over });
    return { registry, status };
}

// ── manifest ────────────────────────────────────────────────────────────────

describe("the manifest (plugin.json)", () => {
    it("accepts a good one and fills the description", () => {
        const r = parseManifest(JSON.stringify(manifestOf({ description: undefined })), BUILT_IN);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.manifest).toMatchObject({ name: "demo", version: "1.0.0", apiVersion: 1, description: "", adapters: [{ id: "demo-one", label: "Demo one" }] });
    });

    const bad: Array<[string, unknown, RegExp]> = [
        ["not JSON", "{ nope", /not valid JSON/],
        ["no name", manifestOf({ name: undefined }), /plugin.json is not valid: name/],
        ["a name with slashes", manifestOf({ name: "../evil" }), /name must be/],
        ["a wrong apiVersion", manifestOf({ apiVersion: 2 }), /apiVersion must be 1/],
        ["no version", manifestOf({ version: "" }), /version/],
        ["no adapters", manifestOf({ adapters: [] }), /at least one adapter/],
        ["too many adapters", manifestOf({ adapters: ["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => ({ id, label: id })) }), /at most 5 adapters/],
        ["a bad adapter id (upper case)", manifestOf({ adapters: [{ id: "Demo", label: "x" }] }), /adapter id is 2-31/],
        ["a bad adapter id (starts with a digit)", manifestOf({ adapters: [{ id: "1demo", label: "x" }] }), /adapter id is 2-31/],
        ["a bad adapter id (too short)", manifestOf({ adapters: [{ id: "d", label: "x" }] }), /adapter id is 2-31/],
        ["an id that clashes with a built-in", manifestOf({ adapters: [{ id: "playwright", label: "x" }] }), /ships with the platform/],
        ["the same id twice", manifestOf({ adapters: [{ id: "demo-one", label: "a" }, { id: "demo-one", label: "b" }] }), /twice/],
        ["an unknown field", manifestOf({ extra: true }), /not valid/],
        ["an empty label", manifestOf({ adapters: [{ id: "demo-one", label: "" }] }), /label/],
    ];
    it.each(bad)("refuses %s with a plain message", (_name, manifest, message) => {
        const r = parseManifest(typeof manifest === "string" ? manifest : JSON.stringify(manifest), BUILT_IN);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(message);
    });

    it("refuses a manifest larger than 16 KB", () => {
        const r = parseManifest(JSON.stringify(manifestOf({ description: "x".repeat(PLUGIN_LIMITS.manifestBytes) })), BUILT_IN);
        expect(r.ok).toBe(false);
    });

    it("limits a plug-in to 5 adapters and an id to the documented pattern", () => {
        expect(ManifestSchema.safeParse(manifestOf()).success).toBe(true);
        expect(PLUGIN_LIMITS.adaptersPerPlugin).toBe(5);
        expect(PLUGIN_LIMITS.plugins).toBe(10);
    });
});

// ── adapter shape ───────────────────────────────────────────────────────────

describe("the adapter object a plug-in hands over", () => {
    it("accepts a good one and keeps plain copies", () => {
        const r = checkAdapterShape(goodAdapter({ alsoRenders: ["web"], needs: { node: true, browsers: ["chromium"] } }), "demo-one");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.adapter).toMatchObject({ id: "demo-one", kinds: ["api"], alsoRenders: ["web"], executable: true, runtime: "demo-runtime", needs: { node: true, browsers: ["chromium"] } });
    });

    const bad: Array<[string, unknown, RegExp]> = [
        ["not an object", 7, /not an object/],
        ["an array", [], /not an object/],
        ["a different id than the manifest", goodAdapter({ id: "other-id" }), /declares "demo-one"/],
        ["no label", goodAdapter({ label: undefined }), /label/],
        ["a long label", goodAdapter({ label: "x".repeat(81) }), /label/],
        ["no kinds", goodAdapter({ kinds: undefined }), /"kinds"/],
        ["an empty kinds list", goodAdapter({ kinds: [] }), /"kinds"/],
        ["an unknown kind", goodAdapter({ kinds: ["toaster"] }), /"kinds"/],
        ["a bad alsoRenders", goodAdapter({ alsoRenders: ["nope"] }), /alsoRenders/],
        ["executable not a boolean", goodAdapter({ executable: "yes" }), /"executable"/],
        ["no runtime", goodAdapter({ runtime: undefined }), /"runtime"/],
        ["a runtime with capitals", goodAdapter({ runtime: "Demo" }), /"runtime"/],
        ["a built-in runtime", goodAdapter({ runtime: "playwright" }), /ships with the platform/],
        ["needs without node", goodAdapter({ needs: {} }), /"needs"/],
        ["needs with an unknown member", goodAdapter({ needs: { node: true, quantum: true } }), /"needs"/],
        ["needs with an unknown browser", goodAdapter({ needs: { node: true, browsers: ["lynx"] } }), /"needs"/],
        ["traits missing a flag", goodAdapter({ traits: { visionJudgement: false } }), /"traits"/],
        ["traits with a non-boolean", goodAdapter({ traits: { visionJudgement: 1, cleanupLedger: false, browserRepair: false } }), /"traits"/],
        ["render missing", goodAdapter({ render: undefined }), /render\(spec, ctx\)/],
        ["render not a function", goodAdapter({ render: "x" }), /render\(spec, ctx\)/],
        ["execute missing", goodAdapter({ execute: undefined }), /execute\(batch, env, opts\)/],
        ["describe of the wrong type", goodAdapter({ describe: 5 }), /describe/],
    ];
    it.each(bad)("refuses %s", (_name, obj, message) => {
        const r = checkAdapterShape(obj, "demo-one");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(message);
    });

    it("refuses an object whose members throw when read", () => {
        const hostile = {
            get id(): string {
                throw new Error("boom");
            },
        };
        const r = checkAdapterShape(hostile, "demo-one");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/could not be read/);
    });

    it("calls render and execute as methods of the plug-in's own object", () => {
        class Mine {
            id = "demo-one";
            label = "Mine";
            kinds = ["api"];
            executable = true;
            runtime = "mine-rt";
            needs = { node: true };
            traits = { visionJudgement: false, cleanupLedger: false, browserRepair: false };
            secret = "kept";
            render() {
                return { filename: "A.txt", content: this.secret };
            }
            async execute() {
                return [];
            }
        }
        const r = checkAdapterShape(new Mine(), "demo-one");
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.adapter.render(spec(), {} as never, {})).toEqual({ filename: "A.txt", content: "kept" });
    });
});

// ── the switch ──────────────────────────────────────────────────────────────

describe("when plug-ins may load", () => {
    it("is off by default", () => {
        const c = loadConfig({ DATA_DIR: root, API_KEY: "k" });
        expect(c.ALLOW_ADAPTER_PLUGINS).toBe(false);
        expect(c.adapterPluginsRequested).toBe(false);
        expect(c.adapterPluginsReason).toBeUndefined();
    });
    it("is on only with the switch AND an API key", () => {
        const on = loadConfig({ DATA_DIR: root, API_KEY: "k", ALLOW_ADAPTER_PLUGINS: "true" });
        expect(on.ALLOW_ADAPTER_PLUGINS).toBe(true);
        expect(on.adapterPluginsRequested).toBe(true);
        expect(on.adapterPluginsReason).toBeUndefined();
    });
    it("is ignored without an API key, and says why", () => {
        const c = loadConfig({ DATA_DIR: root, ALLOW_ADAPTER_PLUGINS: "true" });
        expect(c.ALLOW_ADAPTER_PLUGINS).toBe(false);
        expect(c.adapterPluginsRequested).toBe(true);
        expect(c.adapterPluginsReason).toBe(ADAPTER_PLUGINS_NEED_API_KEY);
        expect(c.adapterPluginsReason).toMatch(/API_KEY/);
        expect(loadConfig({ DATA_DIR: root, ALLOW_ADAPTER_PLUGINS: "true", API_KEY: "" }).ALLOW_ADAPTER_PLUGINS).toBe(false);
    });
    it("counts only the exact word true, in any letter case", () => {
        for (const v of ["1", "yes", "on", "truee", ""]) expect(loadConfig({ DATA_DIR: root, API_KEY: "k", ALLOW_ADAPTER_PLUGINS: v }).ALLOW_ADAPTER_PLUGINS).toBe(false);
        expect(loadConfig({ DATA_DIR: root, API_KEY: "k", ALLOW_ADAPTER_PLUGINS: " TRUE " }).ALLOW_ADAPTER_PLUGINS).toBe(true);
    });

    it("loads nothing and imports nothing when the switch is off, whatever is listed", async () => {
        const marker = path.join(root, "off-marker.txt");
        const dir = writePlugin("off-plugin", manifestOf(), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "imported");\n${GOOD_SOURCE}`);
        const registry = new AdapterRegistry();
        const status = await loadPlugins({ enabled: false, requested: false, list: dir, registry });
        expect(status).toMatchObject({ enabled: false, requested: false, configured: 1, loaded: [], problems: [] });
        expect(status.reason).toMatch(/ALLOW_ADAPTER_PLUGINS is not true/);
        expect(registry.list()).toEqual([]);
        expect(fs.existsSync(marker)).toBe(false);
    });
    it("loads nothing and imports nothing when it was asked for without an API key", async () => {
        const marker = path.join(root, "nokey-marker.txt");
        const dir = writePlugin("nokey-plugin", manifestOf(), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "imported");\n${GOOD_SOURCE}`);
        const registry = new AdapterRegistry();
        const status = await loadPlugins({ enabled: false, requested: true, reason: ADAPTER_PLUGINS_NEED_API_KEY, list: dir, registry });
        expect(status).toMatchObject({ enabled: false, requested: true, reason: ADAPTER_PLUGINS_NEED_API_KEY, loaded: [] });
        expect(fs.existsSync(marker)).toBe(false);
    });
});

// ── paths ───────────────────────────────────────────────────────────────────

describe("the paths in ADAPTER_PLUGINS", () => {
    it("splits on semicolons and ignores empty parts", () => {
        expect(splitPluginList(" a ; ;b;; ")).toEqual(["a", "b"]);
        expect(splitPluginList(undefined)).toEqual([]);
        expect(splitPluginList("")).toEqual([]);
    });
    it("names a plug-in by its last segment, never by the full path", () => {
        expect(displayName("C:\\secret\\place\\my-plugin")).toBe("my-plugin");
        expect(displayName("/home/x/plug.mjs")).toBe("plug.mjs");
    });

    const refused: Array<[string, string, RegExp]> = [
        ["a relative path", "plugins/x.mjs", /full \(absolute\) path/],
        ["a dot-relative path", "./x.mjs", /full \(absolute\) path/],
        ["a parent token", `${root}${path.sep}a${path.sep}..${path.sep}b${path.sep}x.mjs`, /"\.\."/],
        ["a parent token with the other slash", `${root.replace(/\\/g, "/")}/../x.mjs`, /"\.\."/],
        ["a UNC path", "\\\\server\\share\\x.mjs", /network paths/],
        ["a UNC path with forward slashes", "//server/share/x.mjs", /network paths/],
        ["a NUL byte", `${root}\0x.mjs`, /not valid/],
        ["a very long path", path.join(root, "x".repeat(600)), /longer than 500/],
    ];
    it.each(refused)("refuses %s", (_name, raw, message) => {
        const r = checkPluginPath(raw);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.message).toMatch(message);
            // A message may name the file, never the folder it was in.
            expect(r.message).not.toContain(root);
        }
    });
    it("accepts a full local path", () => {
        const r = checkPluginPath(path.join(root, "x.mjs"));
        expect(r).toEqual({ ok: true, path: path.join(root, "x.mjs") });
    });

    it("reports each unusable entry in plain words and keeps loading the rest", async () => {
        const good = writePlugin("paths-good", manifestOf(), GOOD_SOURCE);
        const noManifest = writePlugin("paths-nomanifest", null, GOOD_SOURCE);
        const noModule = writePlugin("paths-nomodule", manifestOf(), null);
        const wrongExt = path.join(root, "notes.txt");
        fs.writeFileSync(wrongExt, "hello");
        const lone = path.join(root, "lone.mjs");
        fs.writeFileSync(lone, GOOD_SOURCE);
        const { registry, status } = await load([good, path.join(root, "does-not-exist"), noManifest, noModule, wrongExt, lone, "relative/x.mjs", "\\\\server\\share\\p"]);
        expect(registry.list().map((a) => a.id)).toEqual(["demo-one"]);
        const problems = Object.fromEntries(status.problems.map((p) => [p.plugin, p.message]));
        expect(problems["does-not-exist"]).toMatch(/Nothing was found/);
        expect(problems["paths-nomanifest"]).toMatch(/no plugin.json/);
        expect(problems["paths-nomodule"]).toMatch(/no adapter.mjs/);
        expect(problems["notes.txt"]).toMatch(/not a \.mjs or \.js file or a folder/);
        expect(problems["lone.mjs"]).toMatch(/needs a manifest next to it called "lone.plugin.json"/);
        expect(problems["x.mjs"]).toMatch(/absolute/);
        expect(problems["p"]).toMatch(/network paths/);
        // Nothing in the answer names a server folder.
        expect(JSON.stringify(status)).not.toContain(root);
        expect(JSON.stringify(status)).not.toContain(root.replace(/\\/g, "\\\\"));
    });

    it("loads a single file that has a manifest beside it", async () => {
        const file = path.join(root, "single.mjs");
        fs.writeFileSync(file, GOOD_SOURCE.replace("demo-one", "single-one"));
        fs.writeFileSync(path.join(root, "single.plugin.json"), JSON.stringify(manifestOf({ name: "single", adapters: [{ id: "single-one", label: "Single" }] })));
        const { registry, status } = await load([file]);
        expect(status.problems).toEqual([]);
        expect(registry.list().map((a) => a.id)).toEqual(["single-one"]);
    });

    it("loads at most 10 plug-ins", async () => {
        const dirs = Array.from({ length: 11 }, (_, i) => writePlugin(`many-${i}`, manifestOf({ name: `many-${i}`, adapters: [{ id: `many-${i}`, label: "m" }] }), GOOD_SOURCE.replace("demo-one", `many-${i}`)));
        const { registry, status } = await load(dirs);
        expect(registry.list()).toHaveLength(10);
        expect(status.problems).toEqual([{ plugin: "many-10", message: "Only 10 plug-ins are loaded; this one was left out." }]);
    });
});

// ── loading ─────────────────────────────────────────────────────────────────

describe("loading a plug-in", () => {
    it("registers a good plug-in, labelled with its name and version, and builds the description itself", async () => {
        const dir = writePlugin("load-good", manifestOf(), GOOD_SOURCE);
        const { registry, status } = await load([dir]);
        expect(status.problems).toEqual([]);
        expect(status.loaded).toEqual([{ name: "demo", version: "1.0.0", description: "A demo", adapters: [{ id: "demo-one", label: "Demo one" }] }]);
        const a = registry.get("demo-one");
        expect(a.describe()).toEqual({ id: "demo-one", label: "Demo one", kinds: ["api"], executable: true, runtime: "demo-runtime", needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false }, plugin: { name: "demo", version: "1.0.0" } });
        expect(getPluginStatus().loaded).toHaveLength(1);
    });

    it("never overrides a built-in: the manifest is refused before the module is imported", async () => {
        const marker = path.join(root, "clash-marker.txt");
        const dir = writePlugin("load-clash", manifestOf({ adapters: [{ id: "playwright", label: "Mine" }] }), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "imported");\n${GOOD_SOURCE.replace("demo-one", "playwright")}`);
        const { registry, status } = await load([dir]);
        expect(registry.list()).toEqual([]);
        expect(status.problems[0]!.message).toMatch(/ships with the platform/);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it("refuses an id that is already taken by another plug-in", async () => {
        const a = writePlugin("dup-a", manifestOf({ name: "dup-a" }), GOOD_SOURCE);
        const b = writePlugin("dup-b", manifestOf({ name: "dup-b" }), GOOD_SOURCE);
        const { registry, status } = await load([a, b]);
        expect(registry.list().map((x) => x.id)).toEqual(["demo-one"]);
        expect(status.problems).toHaveLength(1);
        expect(status.problems[0]).toMatchObject({ plugin: "dup-b" });
        expect(status.problems[0]!.message).toMatch(/already/);
    });

    it("reports a module that throws when it is loaded, a module that does not provide a declared adapter, and an undeclared adapter", async () => {
        const throws = writePlugin("load-throws", manifestOf({ name: "throws" }), `throw new Error("cannot start");\n`);
        const missing = writePlugin("load-missing", manifestOf({ name: "missing", adapters: [{ id: "not-there", label: "x" }] }), GOOD_SOURCE);
        const extra = writePlugin("load-extra", manifestOf({ name: "extra", adapters: [{ id: "extra-one", label: "x" }] }), `export default [${GOOD_SOURCE.replace("export default ", "").replace(/;\s*$/, "").replace("demo-one", "extra-one")}, ${GOOD_SOURCE.replace("export default ", "").replace(/;\s*$/, "").replace("demo-one", "extra-two")}];\n`);
        const malformed = writePlugin("load-malformed", manifestOf({ name: "malformed" }), `export default { id: "demo-one", label: "x" };\n`);
        const notJson = writePlugin("load-notjson", "{ oops", GOOD_SOURCE);
        const good = writePlugin("load-fine", manifestOf({ name: "fine", adapters: [{ id: "fine-one", label: "Fine" }] }), GOOD_SOURCE.replace("demo-one", "fine-one"));
        const { registry, status } = await load([throws, missing, extra, malformed, notJson, good]);
        expect(registry.list().map((a) => a.id)).toEqual(["fine-one"]);
        const by = Object.fromEntries(status.problems.map((p) => [p.plugin, p.message]));
        expect(by["throws"]).toMatch(/could not be loaded: cannot start/);
        expect(by["missing"]).toMatch(/declares the adapter "not-there"/);
        expect(by["extra"]).toMatch(/does not declare/);
        expect(by["malformed"]).toMatch(/"kinds"/);
        expect(by["load-notjson"]).toMatch(/not valid JSON/);
        // No stack traces.
        for (const p of status.problems) expect(p.message).not.toMatch(/\n\s+at /);
    });

    it("registers all of a plug-in's adapters or none", async () => {
        const dir = writePlugin("load-pair", manifestOf({ name: "pair", adapters: [{ id: "pair-a", label: "A" }, { id: "pair-b", label: "B" }] }), `export default [${GOOD_SOURCE.replace("export default ", "").replace(/;\s*$/, "").replace("demo-one", "pair-a")}, { id: "pair-b", label: "B" }];\n`);
        const { registry, status } = await load([dir]);
        expect(registry.list()).toEqual([]);
        expect(status.problems).toHaveLength(1);
        expect(status.loaded).toEqual([]);
    });

    it("gives up on a module that takes too long to load", async () => {
        const dir = writePlugin("load-slow", manifestOf({ name: "slow" }), `await new Promise((r) => setTimeout(r, 5000));\n${GOOD_SOURCE}`);
        const { registry, status } = await load([dir], { importTimeoutMs: 150 });
        expect(registry.list()).toEqual([]);
        expect(status.problems[0]!.message).toMatch(/took longer than/);
    });

    it("explains a missing framework in words that say nothing is lost", async () => {
        const dir = writePlugin("load-explain", manifestOf({ name: "explain", adapters: [{ id: "gone-one", label: "x" }] }), `throw new Error("broken");\n`);
        await loadPlugins({ enabled: true, requested: true, list: dir, registry: new AdapterRegistry() });
        const text = explainMissingFramework("gone-one");
        expect(text).toMatch(/"gone-one"/);
        expect(text).toMatch(/plug-in "explain" did not load: .*broken/);
        expect(text).toMatch(/Nothing was deleted/);
        unloadPlugins();
        expect(explainMissingFramework("gone-one")).toMatch(/turned off/);
        await loadPlugins({ enabled: true, requested: true, list: undefined, registry: new AdapterRegistry() });
        expect(explainMissingFramework("gone-one")).toMatch(/No plug-in listed in ADAPTER_PLUGINS provides it/);
    });
});

// ── what comes back from a plug-in ──────────────────────────────────────────

describe("cleaning the script a plug-in renders", () => {
    it("keeps the file name and text, and forces the framework to the adapter's own id", () => {
        expect(sanitizeScript({ framework: "playwright", filename: "A-1.demo.mjs", content: "x" }, "demo-one")).toEqual({ framework: "demo-one", filename: "A-1.demo.mjs", content: "x", language: "typescript" });
    });
    it.each([
        ["a path in the file name", { filename: "../x.txt", content: "x" }, /file name/],
        ["a folder in the file name", { filename: "a/b.txt", content: "x" }, /file name/],
        ["a Windows path", { filename: "C:\\x.txt", content: "x" }, /file name/],
        ["an empty file name", { filename: "", content: "x" }, /file name/],
        ["a long file name", { filename: "a".repeat(200), content: "x" }, /file name/],
        ["no content", { filename: "a.txt" }, /script text/],
        ["a promise", Promise.resolve({ filename: "a.txt", content: "x" }), /not a promise/],
        ["nothing", undefined, /must return/],
        ["a huge script", { filename: "a.txt", content: "x".repeat(PLUGIN_LIMITS.scriptBytes + 1) }, /larger than/],
    ])("refuses %s", (_name, raw, message) => {
        expect(() => sanitizeScript(raw, "demo-one")).toThrow(message);
    });
});

describe("cleaning the results a plug-in returns", () => {
    const scripts = [{ testId: "API-001" }, { testId: "API-002" }];
    let scratch: string;
    beforeAll(() => {
        scratch = fs.mkdtempSync(path.join(root, "scratch-"));
    });
    const ok = (over: Record<string, unknown> = {}) => ({ status: "passed", durationMs: 12, failedStepIndex: -1, steps: [{ index: 0, title: "GET /x", status: "passed" }], artifacts: [], responses: [{ method: "GET", path: "/x", status: 200 }], ...over });

    it("passes a good answer through, filling the test ids from the scripts", () => {
        const runs = sanitizeRuns([ok(), ok({ status: "failed", error: "Expected 200", failedStepIndex: 0 })], scripts, scratch, []);
        expect(runs.map((r) => [r.testId, r.status])).toEqual([["API-001", "passed"], ["API-002", "failed"]]);
        expect(runs[1]!.error).toBe("Expected 200");
        expect(runs[0]!.responses).toEqual([{ method: "GET", path: "/x", status: 200 }]);
    });
    it("uses the script's test id even if the plug-in names another", () => {
        const runs = sanitizeRuns([ok({ testId: "OTHER-9" }), ok()], scripts, scratch, []);
        expect(runs.map((r) => r.testId)).toEqual(["API-001", "API-002"]);
    });
    it.each([
        ["not a list", { status: "passed" }],
        ["too few results", [ok()]],
        ["too many results", [ok(), ok(), ok()]],
    ])("turns %s into an error for every script", (_name, raw) => {
        const runs = sanitizeRuns(raw, scripts, scratch, [], "The plug-in \"demo\"");
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toMatch(/plug-in "demo"/);
    });
    it("turns an unknown status, a missing result and a non-object into an error for that script only", () => {
        const runs = sanitizeRuns([ok({ status: "great" }), null], scripts, scratch, []);
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toMatch(/status the platform does not know/);
        const mixed = sanitizeRuns([ok(), ok({ status: "banana" })], scripts, scratch, []);
        expect(mixed.map((r) => r.status)).toEqual(["passed", "error"]);
    });
    it("knows the five statuses", () => {
        const runs = sanitizeRuns([ok({ status: "timedOut", error: "slow" }), ok({ status: "skipped" })], scripts, scratch, []);
        expect(runs.map((r) => r.status)).toEqual(["timedOut", "skipped"]);
    });
    it("cuts long strings and long lists", () => {
        const [run] = sanitizeRuns(
            [
                ok({
                    status: "failed",
                    error: "e".repeat(10_000),
                    steps: Array.from({ length: 800 }, (_, i) => ({ index: i, title: "t".repeat(1000), status: "passed", error: "s".repeat(5000) })),
                    responses: Array.from({ length: 900 }, () => ({ method: "GET", path: "/p".repeat(400), status: 200 })),
                    notes: Array.from({ length: 50 }, () => "n".repeat(2000)),
                }),
                ok(),
            ],
            scripts,
            scratch,
            [],
        );
        expect(run!.error!.length).toBe(PLUGIN_LIMITS.errorChars);
        expect(run!.steps).toHaveLength(PLUGIN_LIMITS.steps);
        expect(run!.steps[0]!.title.length).toBe(PLUGIN_LIMITS.titleChars);
        expect(run!.steps[0]!.error!.length).toBe(PLUGIN_LIMITS.stepErrorChars);
        expect(run!.responses).toHaveLength(PLUGIN_LIMITS.responses);
        expect(run!.responses[0]!.path.length).toBeLessThanOrEqual(500);
        expect(run!.notes).toHaveLength(PLUGIN_LIMITS.notes);
        expect(run!.notes![0]!.length).toBe(PLUGIN_LIMITS.noteChars);
    });
    it("clamps numbers and drops what is not a valid step or response", () => {
        const [run] = sanitizeRuns([ok({ durationMs: -5, failedStepIndex: 10 ** 9, steps: [{ index: 0, title: "a", status: "weird" }, "x", { index: 1, title: "b", status: "failed", error: "no" }], responses: [{ method: "GET", path: "/x", status: "200" }, { method: "GET", path: "/y", status: 404 }] }), ok()], scripts, scratch, []);
        expect(run!.durationMs).toBe(0);
        expect(run!.failedStepIndex).toBe(100_000);
        expect(run!.steps).toEqual([{ index: 1, title: "b", status: "failed", error: "no" }]);
        expect(run!.responses).toEqual([{ method: "GET", path: "/y", status: 404 }]);
    });
    it("says why when a failure came without a reason", () => {
        const [run] = sanitizeRuns([ok({ status: "failed" }), ok()], scripts, scratch, [], "The plug-in \"demo\"");
        expect(run!.error).toMatch(/failure without saying why/);
    });
    it("hides the run's secrets in error text, steps, responses and notes", () => {
        const [run] = sanitizeRuns([ok({ status: "failed", error: "token hunter2-secret leaked", steps: [{ index: 0, title: "uses hunter2-secret", status: "failed", error: "hunter2-secret" }], notes: ["x hunter2-secret y"], responses: [{ method: "GET", path: "/a?k=hunter2-secret", status: 200 }] }), ok()], scripts, scratch, ["hunter2-secret"]);
        expect(JSON.stringify(run)).not.toContain("hunter2-secret");
        expect(run!.error).toContain("[hidden]");
    });
    it("builds results from fresh objects, so a prototype-polluting key goes nowhere", () => {
        const evil = JSON.parse('{"status":"passed","durationMs":1,"failedStepIndex":-1,"steps":[],"artifacts":[],"responses":[],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
        const runs = sanitizeRuns([evil, ok()], scripts, scratch, []);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((runs[0] as unknown as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys(runs[0]!).sort()).toEqual(["artifacts", "durationMs", "failedStepIndex", "responses", "status", "steps", "testId"]);
    });
    it("keeps an artifact inside the run folder and drops every other", () => {
        const inside = path.join(scratch, "shot.png");
        fs.writeFileSync(inside, "png");
        const outside = path.join(root, "outside.png");
        fs.writeFileSync(outside, "png");
        const sneaky = path.join(scratch, "..", path.basename(root), "outside.png");
        const [run] = sanitizeRuns(
            [
                ok({
                    artifacts: [
                        { kind: "screenshot", path: inside },
                        { kind: "screenshot", path: outside },
                        { kind: "screenshot", path: sneaky },
                        { kind: "screenshot", path: path.join(scratch, "missing.png") },
                        { kind: "evidence", path: inside },
                        { kind: "trace", path: 42 },
                    ],
                }),
                ok(),
            ],
            scripts,
            scratch,
            [],
        );
        expect(run!.artifacts).toEqual([{ kind: "screenshot", path: fs.realpathSync(inside) }]);
        expect(run!.notes!.some((n) => /outside the run folder/.test(n))).toBe(true);
        expect(run!.notes!.some((n) => /does not exist/.test(n))).toBe(true);
    });
});

// ── containment ─────────────────────────────────────────────────────────────

describe("a plug-in that misbehaves is contained", () => {
    const wrap = (over: Record<string, unknown> = {}) => {
        const shaped = checkAdapterShape(goodAdapter(over), "demo-one");
        if (!shaped.ok) throw new Error(shaped.message);
        return new PluginAdapter(shaped.adapter, "Demo one", { name: "demo", version: "1.0.0" });
    };
    let scratch: string;
    beforeAll(() => {
        scratch = fs.mkdtempSync(path.join(root, "contain-"));
    });
    const batch = () => ({ scratchDir: scratch, scripts: [{ testId: "API-001", filename: "API-001.demo.txt", content: "x" }, { testId: "API-002", filename: "API-002.demo.txt", content: "y" }] });
    const env = { run: { baseUrl: "http://127.0.0.1:1", headless: true, apiToken: "tok-very-secret" } };

    it("renders through the plug-in and returns a clean script", () => {
        const s = wrap().render(spec(), { baseUrl: "http://127.0.0.1:1" });
        expect(s).toEqual({ framework: "demo-one", filename: "API-001.demo.txt", content: "demo script", language: "typescript" });
    });
    it("hands render copies, so it cannot change the test", () => {
        const a = spec();
        wrap({
            render: (s: TestSpec) => {
                s.title = "CHANGED";
                s.steps.length = 0;
                return { filename: "A.txt", content: "x" };
            },
        }).render(a, { baseUrl: "http://127.0.0.1:1" });
        expect(a.title).toBe("A plug-in test");
        expect(a.steps).toHaveLength(1);
    });
    it("hands render a host that quotes text safely", () => {
        let quoted = "";
        wrap({
            render: (_s: TestSpec, _c: unknown, host: { js(v: string): string }) => {
                quoted = host.js(`a"b\\c\n<script>`);
                return { filename: "A.txt", content: "x" };
            },
        }).render(spec(), { baseUrl: "http://127.0.0.1:1" });
        expect(JSON.parse(quoted)).toBe(`a"b\\c\n<script>`);
        expect(quoted).not.toContain("\n");
    });
    it("turns a render that throws into a plain sentence naming the plug-in", () => {
        const a = wrap({
            render: () => {
                throw new Error("I cannot do this step\n    at secret/stack.js:1");
            },
        });
        expect(() => a.render(spec(), { baseUrl: "http://127.0.0.1:1" })).toThrow(/^The plug-in "demo" could not render this test: I cannot do this step at secret\/stack.js:1$/);
    });
    it("turns a render that returns rubbish into the same kind of sentence", () => {
        expect(() => wrap({ render: () => "text" }).render(spec(), { baseUrl: "http://127.0.0.1:1" })).toThrow(/could not render this test/);
        expect(() => wrap({ render: () => ({ filename: "../x", content: "x" }) }).render(spec(), { baseUrl: "http://127.0.0.1:1" })).toThrow(/file name/);
    });
    it("refuses a test kind it does not run, before calling the plug-in", () => {
        let called = false;
        const a = wrap({
            render: () => {
                called = true;
                return { filename: "A.txt", content: "x" };
            },
        });
        expect(() => a.render(spec("web"), { baseUrl: "http://127.0.0.1:1" })).toThrow(/does not run web tests/);
        expect(called).toBe(false);
    });
    it("refuses to send stored sign-in details to another site, before the plug-in sees the steps", () => {
        let called = false;
        const a = wrap({
            render: () => {
                called = true;
                return { filename: "A.txt", content: "x" };
            },
        });
        const leaky = TestSpecSchema.parse({ testId: "API-001", title: "Leaks the token", kind: "api", steps: [{ action: "request", method: "GET", path: "https://evil.example/steal", auth: "default" }] });
        expect(() => a.render(leaky, { baseUrl: "http://127.0.0.1:1" })).toThrow(/Stored sign-in details can only be used on the application's own site/);
        expect(called).toBe(false);
    });

    it("runs the scripts and returns the cleaned results", async () => {
        const runs = await wrap().execute(batch(), env, { workers: 1 });
        expect(runs.map((r) => [r.testId, r.status])).toEqual([["API-001", "passed"], ["API-002", "passed"]]);
    });
    it("returns nothing for an empty batch without calling the plug-in", async () => {
        let called = false;
        const a = wrap({
            execute: async () => {
                called = true;
                return [];
            },
        });
        expect(await a.execute({ scratchDir: scratch, scripts: [] }, env, { workers: 1 })).toEqual([]);
        expect(called).toBe(false);
    });
    it("turns an execute that throws into an error result for every script, never a pass", async () => {
        const runs = await wrap({
            execute: async () => {
                throw new Error("the framework fell over, token tok-very-secret");
            },
        }).execute(batch(), env, { workers: 1 });
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toMatch(/^The plug-in "demo" stopped with an error: the framework fell over/);
        expect(runs[0]!.error).not.toContain("tok-very-secret");
    });
    it("turns an execute that throws synchronously, or returns rubbish, into error results too", async () => {
        const sync = await wrap({
            execute: () => {
                throw new Error("sync boom");
            },
        }).execute(batch(), env, { workers: 1 });
        expect(sync.map((r) => r.status)).toEqual(["error", "error"]);
        const rubbish = await wrap({ execute: async () => "passed" }).execute(batch(), env, { workers: 1 });
        expect(rubbish.map((r) => r.status)).toEqual(["error", "error"]);
        const short = await wrap({ execute: async () => [] }).execute(batch(), env, { workers: 1 });
        expect(short[0]!.error).toMatch(/returned 0 results for 2 scripts/);
    });
    it("cuts an execute that hangs at the run's time limit and tells the plug-in to stop", async () => {
        let seen: AbortSignal | undefined;
        const started = Date.now();
        const runs = await wrap({
            execute: (_b: unknown, _e: unknown, opts: { signal: AbortSignal }) => {
                seen = opts.signal;
                return new Promise(() => undefined);
            },
        }).execute(batch(), env, { workers: 1, timeoutMs: 250 });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toMatch(/did not finish within \d+ seconds and was stopped/);
        expect(seen?.aborted).toBe(true);
    });
    it("cuts an execute that hangs when the job is cancelled", async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const pending = wrap({
            execute: (_b: unknown, _e: unknown, opts: { signal: AbortSignal }) => {
                seen = opts.signal;
                return new Promise(() => undefined);
            },
        }).execute(batch(), env, { workers: 1, signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        await expect(pending).rejects.toThrow("Job cancelled");
        expect(seen?.aborted).toBe(true);
    });
    it("does not even start when the job was cancelled already", async () => {
        const controller = new AbortController();
        controller.abort();
        let called = false;
        await expect(
            wrap({
                execute: async () => {
                    called = true;
                    return [];
                },
            }).execute(batch(), env, { workers: 1, signal: controller.signal }),
        ).rejects.toThrow("Job cancelled");
        expect(called).toBe(false);
    });
    it("hands execute copies of the scripts and a host with safe helpers", async () => {
        const original = batch();
        let hostKeys: string[] = [];
        const runs = await wrap({
            execute: async (b: { scripts: Array<{ testId: string; content: string }> }, _e: unknown, _o: unknown, host: Record<string, unknown>) => {
                hostKeys = Object.keys(host).sort();
                b.scripts[0]!.content = "CHANGED";
                return b.scripts.map((s) => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
            },
        }).execute(original, env, { workers: 1 });
        expect(runs.map((r) => r.status)).toEqual(["passed", "passed"]);
        expect(original.scripts[0]!.content).toBe("x");
        expect(hostKeys).toEqual(["apiVersion", "js", "makeRunDir", "runNode"]);
    });
    it("reports a framework that is stored here but not executable", async () => {
        const runs = await wrap({ executable: false }).execute(batch(), env, { workers: 1 });
        expect(runs.map((r) => r.status)).toEqual(["error", "error"]);
        expect(runs[0]!.error).toMatch(/does not run it/);
    });

    it("runs Node for a plug-in with a filtered environment, a time limit and the abort signal (the host helper)", async () => {
        process.env.AITP_TEST_SECRET_FOR_PLUGIN = "must-not-leak";
        try {
            let result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean } | undefined;
            let slow: typeof result;
            let aborted: typeof result;
            let refused = "";
            const controller = new AbortController();
            await wrap({
                execute: async (b: { scripts: Array<{ testId: string }> }, _e: unknown, _o: unknown, host: { makeRunDir(): Promise<string>; runNode(o: unknown): Promise<NonNullable<typeof result>> }) => {
                    const dir = await host.makeRunDir();
                    fs.writeFileSync(path.join(dir, "env.mjs"), "console.log(JSON.stringify({ secret: process.env.AITP_TEST_SECRET_FOR_PLUGIN ?? null, key: process.env.API_KEY ?? null, added: process.env.ADDED ?? null }));");
                    fs.writeFileSync(path.join(dir, "slow.mjs"), "setTimeout(() => {}, 60000);");
                    result = await host.runNode({ cwd: dir, args: ["env.mjs"], env: { ADDED: "yes" }, timeoutMs: 20_000 });
                    slow = await host.runNode({ cwd: dir, args: ["slow.mjs"], timeoutMs: 400 });
                    setTimeout(() => controller.abort(), 150);
                    aborted = await host.runNode({ cwd: dir, args: ["slow.mjs"], timeoutMs: 20_000, signal: controller.signal });
                    try {
                        await host.runNode({ cwd: os.tmpdir(), args: ["env.mjs"], timeoutMs: 1000 });
                    } catch (e) {
                        refused = (e as Error).message;
                    }
                    return b.scripts.map((s) => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] }));
                },
            }).execute(batch(), env, { workers: 1 });
            expect(JSON.parse(result!.stdout)).toEqual({ secret: null, key: null, added: "yes" });
            expect(slow!.timedOut).toBe(true);
            expect(aborted!.aborted).toBe(true);
            expect(refused).toMatch(/inside the run folder/);
        } finally {
            delete process.env.AITP_TEST_SECRET_FOR_PLUGIN;
        }
    });
});

// ── the doctor command ──────────────────────────────────────────────────────

describe("the doctor check for adapter plug-ins", () => {
    const SENTINEL = "SENTINEL-plugin-path-never-print";
    const machine = (env: Record<string, string>, fileExists: (p: string) => boolean = () => true): Probes => ({
        platform: "linux",
        nodeVersion: "24.1.0",
        enginesNode: ">=24",
        env,
        packageVersion: (n) => (n === "playwright" ? "1.50.0" : "5.8.0"),
        browserInstalled: () => true,
        onPath: (p) => `/usr/bin/${p}`,
        fileExists,
        envFileExists: () => true,
        dataDir: () => "/data",
        dataDirWritable: () => ({ ok: true, exists: true }),
        portFree: async () => ({ free: true }),
        invalidSettings: () => [],
        android: () => ({ available: false, avds: [], reason: "none" }),
        webDist: () => "/app/web/dist",
    });
    const check = async (env: Record<string, string>, fileExists?: (p: string) => boolean) => (await runChecks(machine(env, fileExists))).find((c) => c.id === "adapter-plugins")!;

    it("says plug-ins are off by default", async () => {
        const c = await check({});
        expect(c.title).toBe("Adapter plug-ins do not load on this computer (the default)");
        expect(c.status).toBe("ok");
        expect(c.fix).toBeUndefined();
    });
    it("says what is wrong when the switch is on without an API key", async () => {
        const c = await check({ ALLOW_ADAPTER_PLUGINS: "true" });
        expect(c.title).toBe("Adapter plug-ins do not load on this computer, because ALLOW_ADAPTER_PLUGINS is true but API_KEY is not set");
        expect(c.status).toBe("optional");
        expect(c.fix).toMatch(/Set API_KEY/);
    });
    it("says plug-ins are listed but the switch is off", async () => {
        const c = await check({ API_KEY: "k", ADAPTER_PLUGINS: `/p/a;/p/b` });
        expect(c.title).toBe("Adapter plug-ins do not load on this computer: ADAPTER_PLUGINS lists 2 plug-ins, but ALLOW_ADAPTER_PLUGINS is not true");
    });
    it("says plug-ins may load, how many are listed and warns about their power", async () => {
        const abs = path.join(root, "listed");
        const c = await check({ ALLOW_ADAPTER_PLUGINS: "true", API_KEY: "k", ADAPTER_PLUGINS: abs });
        expect(c.title).toBe("Adapter plug-ins may load on this computer (ALLOW_ADAPTER_PLUGINS is true; 1 plug-in listed)");
        expect(c.purpose).toMatch(/runs inside the platform with all its power/);
        expect(c.status).toBe("ok");
    });
    it("counts listed plug-ins that cannot be found, and never prints a path", async () => {
        const a = path.join(root, SENTINEL, "a");
        const b = path.join(root, SENTINEL, "b");
        const checks = await runChecks(machine({ ALLOW_ADAPTER_PLUGINS: "true", API_KEY: "k", ADAPTER_PLUGINS: `${a};${b};relative/x`, ANTHROPIC_API_KEY: SENTINEL }, (p) => p === a));
        const c = checks.find((x) => x.id === "adapter-plugins")!;
        expect(c.title).toBe("Adapter plug-ins may load on this computer (ALLOW_ADAPTER_PLUGINS is true; 3 plug-ins listed, 2 not found)");
        expect(c.status).toBe("optional");
        expect(c.fix).toMatch(/full path/);
        expect(formatReport(checks)).not.toContain(SENTINEL);
    });
});
