/**
 * Shared helper modules for hand-written scripts: which helpers a script needs (through other helpers too), and the rules that keep a
 * helper inside its own folder. Pure; the store and the runners call it.
 *
 * A script imports `./helpers/<name>`; a helper imports another as `./<name>` (they sit side by side when written for a run). Names are
 * restricted so a helper can never be written outside `<run folder>/helpers/`: no separators, no dots, no upper case (case-insensitive
 * file systems), no Windows device names.
 */
import path from "node:path";
import { checkScript, isHelperName } from "./guard.js";

export { HELPER_NAME, isHelperName, MAX_HELPER_BYTES } from "./guard.js";
export const MAX_HELPERS = 20;
/** How many helpers deep a script's imports are followed (script, helper, helper of helper, ...). */
export const MAX_HELPER_DEPTH = 3;

export interface HelperFile {
    name: string;
    content: string;
}

/** Helper names the code imports, read from its syntax tree. */
export function helperImportsOf(content: string, kind: "test" | "helper"): string[] {
    return checkScript(content, { kind }).helperImports;
}

export interface Closure {
    /** The helpers to write, in the order they were found. */
    helpers: HelperFile[];
    /** Imported names no helper exists for. */
    missing: string[];
    /** Imports beyond MAX_HELPER_DEPTH levels (not followed). */
    tooDeep: string[];
}

/**
 * The helpers a set of scripts need, following imports at most MAX_HELPER_DEPTH levels. A cycle is fine (each helper is taken once).
 * `get` returns a helper's code or undefined.
 */
export function helperClosure(scripts: readonly string[], get: (name: string) => string | undefined): Closure {
    const found = new Map<string, string>();
    const missing = new Set<string>();
    const tooDeep = new Set<string>();
    const visit = (names: readonly string[], depth: number) => {
        for (const name of names) {
            if (found.has(name) || missing.has(name)) continue;
            if (depth > MAX_HELPER_DEPTH) {
                tooDeep.add(name);
                continue;
            }
            const code = isHelperName(name) ? get(name) : undefined;
            if (code === undefined) {
                missing.add(name);
                continue;
            }
            found.set(name, code);
            visit(helperImportsOf(code, "helper"), depth + 1);
        }
    };
    for (const s of scripts) visit(helperImportsOf(s, "test"), 1);
    return { helpers: [...found].map(([name, content]) => ({ name, content })), missing: [...missing], tooDeep: [...tooDeep] };
}

/**
 * Where a helper is written inside a run folder. Throws for any name that is not a plain helper name, and for a result that is not
 * directly inside `<dir>/helpers`.
 */
export function helperPath(runDir: string, name: string): string {
    if (!isHelperName(name)) throw new Error("unsafe helper name");
    const folder = path.resolve(runDir, "helpers");
    const full = path.resolve(folder, `${name}.ts`);
    if (path.dirname(full) !== folder) throw new Error("unsafe helper name");
    return full;
}
