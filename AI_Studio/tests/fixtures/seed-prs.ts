/**
 * Seed PRs of the PR bench, until lane B builds it (examples/bench-repo/): each is one real code change against examples/bench-shop or
 * examples/bench-rbac that turns one seeded defect on in code (`on("BS-03")` becomes `true` on every line that names it), as GitHub's
 * files API gives it: the file, status "modified", and a unified patch. `sources` is the new side of the checkout.
 */
import fs from "node:fs";
import path from "node:path";
import type { FileChangeInput } from "../../src/engine/impact/diff.js";

export type BenchApp = "bench-shop" | "bench-rbac";
export interface SeedPr {
    app: BenchApp;
    seed: string;
    files: FileChangeInput[];
    sources: Record<string, string>;
    /** New-side lines changed. */
    lines: number[];
}

const fileOf = (app: BenchApp) => `examples/${app}/server.mjs`;
const read = (app: BenchApp) => fs.readFileSync(path.join(import.meta.dirname, "..", "..", fileOf(app)), "utf8");

/** Every seed id the app's source names, in file order. */
export function seedIds(app: BenchApp): string[] {
    return [...new Set([...read(app).matchAll(/\bon\("(B[SR]-\d+)"\)/g)].map((m) => m[1]!))];
}

export function seedPr(app: BenchApp, seed: string): SeedPr {
    const old = read(app).split("\n");
    const lines: number[] = [];
    const hunks: string[] = [];
    const next = old.map((l, i) => {
        if (!l.includes(`on("${seed}")`)) return l;
        const changed = l.split(`on("${seed}")`).join("true");
        lines.push(i + 1);
        hunks.push(`@@ -${i + 1},1 +${i + 1},1 @@`, `-${l}`, `+${changed}`);
        return changed;
    });
    if (!lines.length) throw new Error(`${seed} is not in ${app}`);
    const file = fileOf(app);
    return { app, seed, lines, files: [{ path: file, status: "modified", patch: hunks.join("\n") }], sources: { [file]: next.join("\n") } };
}
