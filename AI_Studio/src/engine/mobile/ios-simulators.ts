/**
 * Picking an iOS simulator: pure functions over the output of `xcrun simctl list devices -j`. Nothing here starts anything.
 *
 * The choice, in order: a simulator that is already running (booted by the person or by another tool, used as it is and never
 * shut down), then the newest iOS version, then iPhones before iPads, then the name. When the project names a simulator
 * ("iPhone 15"), only simulators with exactly that name are considered.
 */

export interface Simulator {
    udid: string;
    name: string;
    /** simctl's state: "Booted", "Shutdown", "Booting", "Shutting Down". */
    state: string;
    /** "17.5" */
    version: string;
}

const UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** "com.apple.CoreSimulator.SimRuntime.iOS-17-5" -> "17.5"; other platforms (tvOS, watchOS, visionOS) -> undefined. */
export function iosVersionOfRuntime(runtimeKey: string): string | undefined {
    const m = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtimeKey);
    return m ? m[1]!.replace(/-/g, ".") : undefined;
}

/** The iOS simulators in `simctl list devices -j` output. Unavailable ones, other platforms and anything malformed are left out. */
export function parseSimctlDevices(json: unknown): Simulator[] {
    const devices = (json as { devices?: Record<string, unknown> } | null)?.devices;
    if (!devices || typeof devices !== "object") return [];
    const out: Simulator[] = [];
    for (const [runtime, list] of Object.entries(devices)) {
        const version = iosVersionOfRuntime(runtime);
        if (!version || !Array.isArray(list)) continue;
        for (const d of list as Array<{ name?: unknown; udid?: unknown; state?: unknown; isAvailable?: unknown }>) {
            if (typeof d?.name !== "string" || typeof d.udid !== "string" || !UDID.test(d.udid) || d.isAvailable === false) continue;
            out.push({ udid: d.udid.toUpperCase(), name: d.name.slice(0, 80), state: typeof d.state === "string" ? d.state : "Shutdown", version });
        }
    }
    return out;
}

/** Compare "17.5" with "16.4" as numbers, part by part (descending: the newest first). */
export function compareVersionsDesc(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

export type SimulatorChoice = { ok: true; simulator: Simulator; running: boolean } | { ok: false; message: string };

const isBooted = (s: Simulator) => s.state === "Booted";

/** Order candidates: running first, newest iOS, iPhone before iPad, then name and id (so the answer never depends on list order). */
function ranked(sims: readonly Simulator[]): Simulator[] {
    const phone = (s: Simulator) => (/^iPhone/i.test(s.name) ? 0 : 1);
    return [...sims].sort((a, b) => Number(isBooted(b)) - Number(isBooted(a)) || compareVersionsDesc(a.version, b.version) || phone(a) - phone(b) || a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
}

/**
 * The simulator a run uses, or a plain sentence saying why there is none. `wanted` is a name from the project's settings or app
 * (compared ignoring case and surrounding spaces).
 */
export function chooseSimulator(sims: readonly Simulator[], wanted?: string): SimulatorChoice {
    if (sims.length === 0) return { ok: false, message: "No iOS simulator is set up on this Mac. Install an iOS runtime in Xcode (Settings, Platforms) and create a simulator." };
    const name = wanted?.trim();
    const candidates = name ? sims.filter((s) => s.name.toLowerCase() === name.toLowerCase()) : [...sims];
    if (candidates.length === 0) {
        const known = [...new Set(ranked(sims).map((s) => s.name))].slice(0, 8);
        return { ok: false, message: `The iOS simulator "${name}" does not exist on this Mac (available: ${known.join(", ")}).` };
    }
    const simulator = ranked(candidates)[0]!;
    return { ok: true, simulator, running: isBooted(simulator) };
}
