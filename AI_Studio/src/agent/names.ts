/**
 * File and folder names the agent builds from text it did not write (task ids, file names from the platform, file names
 * Playwright produced). Nothing here is ever joined to a path without passing through one of these first.
 */
import path from "node:path";
import { SafeName } from "../agent-protocol/schema.js";

/** A name that is safe in a path on every operating system, derived from any text. Never empty, at most `max` characters. */
export function sanitizeName(text: string, max = 100, fallback = "file"): string {
    const cleaned = text
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .replace(/^[^A-Za-z0-9]+/, "")
        .replace(/\.{2,}/g, ".")
        .slice(0, max);
    return cleaned || fallback;
}

/** Is this already a valid protocol file name? */
export const isSafeName = (name: string): boolean => SafeName.safeParse(name).success;

/**
 * `child` inside `base`, or undefined if it would land outside (a ".." or an absolute name). Compared after resolving, so
 * "a/../../b" and "C:\\x" are caught as well as plain "../b".
 */
export function resolveInside(base: string, ...parts: string[]): string | undefined {
    const root = path.resolve(base);
    const full = path.resolve(root, ...parts);
    const rel = path.relative(root, full);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return full;
}

/** Hands out upload names that are unique within one task and valid protocol names. */
export class NameAllocator {
    private readonly used = new Set<string>();

    /** `<stem><ext>` made safe; a number is added when the name is already taken. */
    allocate(stem: string, ext: string): string {
        const cleanExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : "";
        const base = sanitizeName(stem, 100, "file");
        let name = `${base}${cleanExt}`;
        for (let i = 2; this.used.has(name.toLowerCase()); i++) name = `${base}-${i}${cleanExt}`;
        this.used.add(name.toLowerCase());
        return name;
    }
}
