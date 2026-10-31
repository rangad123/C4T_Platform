/**
 * Browser-free tests for the adapter plug-in fixes of the round-13 review (.scratch/review/BE-report.md): L1 (no server paths in messages),
 * L2 (run folders removed), L6 (a byte order mark in plugin.json), L7 (Windows device names). Plug-ins are small real ES modules written to a
 * temp folder and really imported. Each test failed before its fix.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AdapterRegistry } from "../src/engine/frameworks/index.js";
import { checkAdapterShape, hidePaths, isReservedFileName, parseManifest, sanitizeScript } from "../src/engine/frameworks/plugin.js";
import { explainMissingFramework, getPluginStatus, loadPlugins, PluginAdapter, unloadPlugins } from "../src/engine/frameworks/plugin-loader.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-bf-unit-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => unloadPlugins());

const manifestOf = (over: Record<string, unknown> = {}) => ({ name: "demo", version: "1.0.0", apiVersion: 1, description: "A demo", adapters: [{ id: "demo-one", label: "Demo one" }], ...over });
const GOOD_SOURCE = `export default {
    id: "demo-one", label: "Demo one", kinds: ["api"], executable: true, runtime: "demo-runtime",
    needs: { node: true }, traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
    render(spec) { return { filename: spec.testId + ".demo.txt", content: "demo script" }; },
    async execute(batch) { return batch.scripts.map((s) => ({ testId: s.testId, status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [] })); },
};
`;
function writePlugin(name: string, manifest: string, source: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), manifest);
    fs.writeFileSync(path.join(dir, "adapter.mjs"), source);
    return dir;
}
const noPath = (text: string) => {
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(text).not.toMatch(/[\\/](Users|home|tmp)[\\/]/);
};
const RUN_ENV = { run: { baseUrl: "http://127.0.0.1:1", headless: true } } as never;

describe("L1: messages show names and file names, never server paths", () => {
    it("hidePaths cuts Windows, network, file: and POSIX paths down to the file name and leaves web addresses alone", () => {
        expect(hidePaths("Cannot find package 'x' imported from C:\\Users\\Jo Smith\\plugins\\adapter.mjs")).toBe("Cannot find package 'x' imported from adapter.mjs");
        expect(hidePaths("failed at file:///C:/Users/me/p/adapter.mjs:3")).toBe("failed at adapter.mjs:3");
        expect(hidePaths("see \\\\server\\share\\dir\\a.js now")).toBe("see a.js now");
        expect(hidePaths("ENOENT /home/ci/builds/plug/adapter.mjs")).toBe("ENOENT adapter.mjs");
        expect(hidePaths("GET /api/notes/5 answered 500")).toBe("GET /api/notes/5 answered 500");
        expect(hidePaths("no paths here")).toBe("no paths here");
    });

    it("a plug-in that fails to import leaves a problem message and a missing-framework sentence with no path", async () => {
        const dir = writePlugin("l1-import", JSON.stringify(manifestOf()), `import "bf-package-that-does-not-exist";\n${GOOD_SOURCE}`);
        const registry = new AdapterRegistry();
        const status = await loadPlugins({ enabled: true, requested: true, list: dir, registry });
        expect(status.loaded).toEqual([]);
        expect(status.problems).toHaveLength(1);
        expect(status.problems[0]!.message).toMatch(/bf-package-that-does-not-exist/);
        noPath(status.problems[0]!.message);
        expect(JSON.stringify(getPluginStatus())).not.toContain(root);
        const sentence = explainMissingFramework("demo-one");
        expect(sentence).toMatch(/did not load/);
        noPath(sentence);
    });

    it("an error thrown by a plug-in while it runs is reported without the path it came from", async () => {
        const shaped = checkAdapterShape(
            {
                id: "demo-one",
                label: "Demo one",
                kinds: ["api"],
                executable: true,
                runtime: "demo-runtime",
                needs: { node: true },
                traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
                render: () => ({ filename: "a.txt", content: "x" }),
                execute: async () => {
                    throw new Error(`ENOENT: no such file ${path.join(root, "deep", "dir", "secret.json")}`);
                },
            },
            "demo-one",
        );
        if (!shaped.ok) throw new Error(shaped.message);
        const runs = await new PluginAdapter(shaped.adapter, "Demo one", { name: "demo", version: "1" }).execute({ scratchDir: root, scripts: [{ testId: "API-001", filename: "a.txt", content: "x" }] }, RUN_ENV, { workers: 1 });
        expect(runs[0]!.status).toBe("error");
        expect(runs[0]!.error).toMatch(/secret\.json/);
        noPath(runs[0]!.error!);
    });
});

describe("L6: a byte order mark at the start of plugin.json is tolerated", () => {
    it("parses the manifest and loads the plug-in", async () => {
        expect(parseManifest(`\uFEFF${JSON.stringify(manifestOf())}`, new Set()).ok).toBe(true);
        const dir = writePlugin("l6-bom", `\uFEFF${JSON.stringify(manifestOf())}`, GOOD_SOURCE);
        const registry = new AdapterRegistry();
        const status = await loadPlugins({ enabled: true, requested: true, list: dir, registry });
        expect(status.problems).toEqual([]);
        expect(status.loaded.map((p) => p.name)).toEqual(["demo"]);
    });
});

describe("L7: Windows device names are not accepted as script file names", () => {
    it.each(["con", "CON.mjs", "nul.spec.ts", "aux", "com1.txt", "lpt9", "prn.js", "a.", "x.spec."])("refuses %s", (filename) => {
        expect(isReservedFileName(filename)).toBe(true);
        expect(() => sanitizeScript({ filename, content: "x" }, "demo-one")).toThrow(/file name that is not allowed/);
    });
    it.each(["API-001.demo.txt", "console.mjs", "connect.js", "com10.txt", "nullable.ts", "a.b.c"])("still accepts %s", (filename) => {
        expect(isReservedFileName(filename)).toBe(false);
        expect(sanitizeScript({ filename, content: "x" }, "demo-one").filename).toBe(filename);
    });
});

describe("L2: folders made by makeRunDir are removed when the run ends", () => {
    type Execute = (b: { scripts: Array<{ testId: string }> }, e: unknown, o: unknown, host: { makeRunDir(): Promise<string> }) => Promise<unknown>;
    const run = async (execute: Execute) => {
        const scratch = fs.mkdtempSync(path.join(root, "scratch-"));
        const shaped = checkAdapterShape(
            {
                id: "demo-one",
                label: "Demo one",
                kinds: ["api"],
                executable: true,
                runtime: "demo-runtime",
                needs: { node: true },
                traits: { visionJudgement: false, cleanupLedger: false, browserRepair: false },
                render: () => ({ filename: "a.txt", content: "x" }),
                execute,
            },
            "demo-one",
        );
        if (!shaped.ok) throw new Error(shaped.message);
        // A folder the platform did not make, which must be left alone.
        fs.mkdirSync(path.join(scratch, "run-someone-elses"));
        const runs = await new PluginAdapter(shaped.adapter, "Demo one", { name: "demo", version: "1" }).execute({ scratchDir: scratch, scripts: [{ testId: "API-001", filename: "a.txt", content: "x" }] }, RUN_ENV, { workers: 1 });
        return { scratch, runs, left: fs.readdirSync(scratch).sort() };
    };
    const passed = (extra: Record<string, unknown> = {}) => [{ testId: "API-001", status: "passed", durationMs: 1, failedStepIndex: -1, steps: [], artifacts: [], responses: [], ...extra }];

    it("removes the folders and keeps the one that holds a file the result points at, and anything the platform did not make", async () => {
        const r = await run(async (_b, _e, _o, host) => {
            const a = await host.makeRunDir();
            const b = await host.makeRunDir();
            fs.writeFileSync(path.join(a, "raw.json"), "{}");
            fs.writeFileSync(path.join(b, "shot.png"), "png");
            return passed({ artifacts: [{ kind: "screenshot", path: path.join(b, "shot.png") }] });
        });
        expect(r.runs[0]!.status).toBe("passed");
        expect(r.runs[0]!.artifacts).toHaveLength(1);
        // two made, one removed: what is left is the other folder and the one with the screenshot
        expect(r.left).toHaveLength(2);
        expect(r.left).toContain("run-someone-elses");
        expect(r.left.filter((n) => n.startsWith("run-plugin-"))).toHaveLength(1);
        expect(fs.existsSync(r.runs[0]!.artifacts[0]!.path)).toBe(true);
    });

    it("removes all of them when the plug-in fails", async () => {
        const r = await run(async (_b, _e, _o, host) => {
            fs.writeFileSync(path.join(await host.makeRunDir(), "x.txt"), "x");
            throw new Error("boom");
        });
        expect(r.runs[0]!.status).toBe("error");
        expect(r.left).toEqual(["run-someone-elses"]);
    });

    it("names them like the built-in runners' folders, so the hourly sweep covers a leftover", async () => {
        let made = "";
        await run(async (_b, _e, _o, host) => {
            made = await host.makeRunDir();
            return passed();
        });
        expect(path.basename(made)).toMatch(/^run-plugin-\d+-[0-9a-f]{8}$/);
    });
});
