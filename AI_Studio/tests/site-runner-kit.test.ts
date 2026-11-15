/**
 * The runner kit and the public suffix list (tldts, behind src/shared/site.ts). Engine code runs on runners, and the kit's npm install
 * fetches only what EXTERNAL and the kit's package.json name, so whatever the bundle uses must be inside it, with its licence. No
 * engine code imports src/shared/site.ts (ownApiHost in src/engine/identity/access.ts uses a strict host rule; only the
 * server's src/platform/selection/coverage.ts uses tldts), so tldts is not in the bundle and its licence is not listed. If engine code
 * imports it again, these checks require it bundled and licensed. Builds the bundle with esbuild into a temp folder (a few seconds). No ports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner, BUNDLED_LICENCES, EXTERNAL } from "../scripts/build-runner.mjs";

let tmp: string;
let out: string;
beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-site-kit-"));
    out = path.join(tmp, "runner");
    await buildRunner({ outDir: out });
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OUTPUTS = ["runner.mjs", "task-child.mjs", "record-child.mjs"];
const bundle = () => OUTPUTS.map((f) => fs.readFileSync(path.join(out, f), "utf8")).join("\n");
/** The packages esbuild copied into the bundle (its "// .../node_modules/<name>/..." module comments). */
const bundledPackages = (code: string) => new Set([...code.matchAll(/^\/\/ (?:\.\.\/)*\S*?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)].map((m) => m[1]!));

describe("the runner kit and the public suffix list", () => {
    it("never leaves tldts to npm: no program imports it at run time, and it is neither external nor a kit dependency", () => {
        expect(bundle()).not.toMatch(/from\s*["']tldts(?:-core)?["']|require\(["']tldts(?:-core)?["']\)|import\(["']tldts(?:-core)?["']\)/);
        expect(EXTERNAL).not.toContain("tldts");
        expect(EXTERNAL).not.toContain("tldts-core");
        const kit = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        expect(Object.keys(kit.dependencies)).not.toContain("tldts");
        expect(Object.keys(kit.dependencies)).not.toContain("tldts-core");
    });
    it("bundles tldts exactly when engine code uses src/shared/site.ts", () => {
        const code = bundle();
        const usesSite = code.includes("// src/shared/site.ts");
        // tldts's own build carries tldts-core's code inside it (allowPrivateDomains is its option), so there is no separate tldts-core module.
        expect(bundledPackages(code).has("tldts")).toBe(usesSite);
        expect(code.includes("allowPrivateDomains")).toBe(usesSite);
    });
    it("lists the licence of every package in the bundle and of no package that is not", () => {
        const bundled = bundledPackages(bundle());
        // @ai-sdk/provider-utils ships without a LICENSE file: it is part of the AI SDK, under the licence of "ai" (scripts/build-runner.mjs).
        bundled.delete("@ai-sdk/provider-utils");
        if (bundled.has("tldts")) bundled.add("tldts-core");
        expect([...BUNDLED_LICENCES].sort()).toEqual([...bundled].sort());
        const licences = fs.readFileSync(path.join(out, "LICENSES.txt"), "utf8");
        for (const name of BUNDLED_LICENCES as string[]) expect(licences).toContain(`=== ${name} ===`);
        expect(licences.includes("=== tldts ===")).toBe(bundled.has("tldts"));
    });
});
