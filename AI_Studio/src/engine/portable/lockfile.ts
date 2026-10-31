/**
 * A truthful package-lock.json for a downloaded test project, made without the internet.
 *
 * The platform runs tests with the packages installed from its own package-lock.json. A download pins exactly those versions, so the
 * lockfile it carries is cut out of the platform's own lockfile: the entries of the pinned packages and of everything they need, at the
 * same places in node_modules, with the same versions, download addresses and integrity hashes npm wrote when it installed them here.
 * Every entry is copied, nothing is invented, and an entry that is missing makes the cut fail instead of producing a lockfile that
 * `npm ci` would reject (see docs/features/portable-code-tests.md).
 */

/** One entry of a version 2/3 lockfile's `packages` map (only the fields this code reads are named). */
export interface LockEntry {
    version?: string;
    resolved?: string;
    integrity?: string;
    license?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    engines?: Record<string, string>;
    os?: string[];
    cpu?: string[];
    dev?: boolean;
    optional?: boolean;
    devOptional?: boolean;
    peer?: boolean;
    link?: boolean;
    inBundle?: boolean;
    [field: string]: unknown;
}

export interface Lockfile {
    name?: string;
    version?: string;
    lockfileVersion: number;
    requires?: boolean;
    packages: Record<string, LockEntry>;
}

/** Thrown when the source lockfile cannot give a complete, truthful cut. */
export class LockCutError extends Error {}

/**
 * Where Node finds `name` from the package at `from` (a lockfile key such as "node_modules/a/node_modules/b"): its own node_modules,
 * then each enclosing node_modules, up to the top. The root package is "".
 */
export function resolveIn(packages: Record<string, LockEntry>, from: string, name: string): string | undefined {
    let base = from;
    for (;;) {
        const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
        if (packages[key]) return key;
        if (!base) return undefined;
        const i = base.lastIndexOf("/node_modules/");
        base = i < 0 ? "" : base.slice(0, i);
    }
}

/** The fields npm computes from the tree (copied entries get fresh ones for the smaller tree). */
const FLAG_FIELDS = new Set(["dev", "optional", "devOptional", "peer"]);

/**
 * The lockfile for a project whose package.json has exactly `pins` as devDependencies (name -> exact version). Every pin must be at the
 * top of the source tree with that exact version. Required edges (dependencies and non-optional peers) must resolve; optional ones are
 * kept when the source has them. All entries are dev (the project has only devDependencies); one reached only through optional edges is
 * also optional, as npm marks it.
 */
export function cutLockfile(source: Lockfile, pins: Record<string, string>, root: { name: string; version: string }): Lockfile {
    if (source.lockfileVersion < 2 || !source.packages) throw new LockCutError("The platform's package-lock.json is too old (lockfile version 2 or newer is needed).");
    const packages = source.packages;
    const included = new Set<string>();
    const required = new Set<string>();
    const queue: Array<{ key: string; viaRequired: boolean }> = [];
    for (const [name, version] of Object.entries(pins)) {
        const key = `node_modules/${name}`;
        const entry = packages[key];
        if (!entry) throw new LockCutError(`${name} is not in the platform's package-lock.json.`);
        if (entry.version !== version) throw new LockCutError(`${name} is ${entry.version} in the platform's package-lock.json, not ${version}.`);
        queue.push({ key, viaRequired: true });
    }
    while (queue.length) {
        const { key, viaRequired } = queue.shift()!;
        const seen = included.has(key);
        const upgrade = viaRequired && !required.has(key);
        if (seen && !upgrade) continue;
        included.add(key);
        if (viaRequired) required.add(key);
        const entry = packages[key]!;
        if (entry.link) throw new LockCutError(`${key} is a linked package; it cannot be part of a download.`);
        if (entry.inBundle) continue; // shipped inside its parent's tarball
        // An optional peer is only installed when something else needs it, so it never pulls a package in by itself.
        const optionalPeer = (n: string) => entry.peerDependenciesMeta?.[n]?.optional === true;
        const edges: Array<[string, boolean]> = [
            ...Object.keys(entry.dependencies ?? {}).map((n): [string, boolean] => [n, true]),
            ...Object.keys(entry.optionalDependencies ?? {}).map((n): [string, boolean] => [n, false]),
            ...Object.keys(entry.peerDependencies ?? {}).filter((n) => !optionalPeer(n)).map((n): [string, boolean] => [n, true]),
        ];
        for (const [name, needed] of edges) {
            const target = resolveIn(packages, key, name);
            if (!target) {
                if (needed) throw new LockCutError(`${key.replace(/^.*node_modules\//, "")} needs ${name}, which is not in the platform's package-lock.json.`);
                continue;
            }
            queue.push({ key: target, viaRequired: viaRequired && needed });
        }
    }
    const out: Record<string, LockEntry> = { "": { name: root.name, version: root.version, devDependencies: { ...pins } } };
    for (const key of [...included].sort((a, b) => a.localeCompare(b, "en"))) {
        const copy: LockEntry = {};
        for (const [field, value] of Object.entries(packages[key]!)) if (!FLAG_FIELDS.has(field)) copy[field] = value;
        copy.dev = true;
        if (!required.has(key)) copy.optional = true;
        out[key] = copy;
    }
    return { name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages: out };
}

/** The lowest Node.js version (major, minor, patch) every entry's `engines.node` allows, as far as simple ranges can tell. */
export function nodeFloor(entries: Iterable<LockEntry>): [number, number, number] {
    let floor: [number, number, number] = [0, 0, 0];
    for (const e of entries) {
        const range = e.engines?.node;
        if (!range) continue;
        // "a || b": the lowest alternative is what is allowed at least.
        const lows = range.split("||").map((alt) => lowerBound(alt.trim())).filter((v): v is [number, number, number] => v !== undefined);
        if (!lows.length) continue;
        const low = lows.reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
        if (compareVersions(low, floor) > 0) floor = low;
    }
    return floor;
}

function lowerBound(alt: string): [number, number, number] | undefined {
    const m = /^(>=|\^|~)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(alt);
    if (!m || alt.startsWith("<")) return undefined;
    const n = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : 0);
    return [Number(m[2]), n(m[3]), n(m[4])];
}

export function parseVersion(v: string): [number, number, number] {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) throw new Error(`Not a version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
}
