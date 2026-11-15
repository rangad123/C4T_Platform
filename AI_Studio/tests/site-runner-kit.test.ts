/**
 * The runner kit's bundled licences. Engine code runs on runners, and the kit's npm install fetches only what EXTERNAL and the kit's
 * package.json name, so whatever the bundle uses must be inside it, with its licence. Builds the bundle with esbuild into a temp folder
 * (a few seconds). No ports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript build script (no type declarations)
import { buildRunner, BUNDLED_LICENCES } from "../scripts/build-runner.mjs";

let tmp: string;
let out: string;
beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runner-kit-"));
    out = path.join(tmp, "runner");
    await buildRunner({ outDir: out });
}, 120_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OUTPUTS = ["runner.mjs", "task-child.mjs", "record-child.mjs"];
const bundle = () => OUTPUTS.map((f) => fs.readFileSync(path.join(out, f), "utf8")).join("\n");
/** The packages esbuild copied into the bundle (its "// .../node_modules/<name>/..." module comments). */
const bundledPackages = (code: string) => new Set([...code.matchAll(/^\/\/ (?:\.\.\/)*\S*?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)].map((m) => m[1]!));

describe("the runner kit's licences", () => {
    it("lists the licence of every package in the bundle and of no package that is not", () => {
        const bundled = bundledPackages(bundle());
        // @ai-sdk/provider-utils ships without a LICENSE file: it is part of the AI SDK, under the licence of "ai" (scripts/build-runner.mjs).
        bundled.delete("@ai-sdk/provider-utils");
        expect([...BUNDLED_LICENCES].sort()).toEqual([...bundled].sort());
        const licences = fs.readFileSync(path.join(out, "LICENSES.txt"), "utf8");
        for (const name of BUNDLED_LICENCES as string[]) expect(licences).toContain(`=== ${name} ===`);
    });
});
