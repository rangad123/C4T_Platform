/**
 * Several phone tests at once on this computer: when the project allows N at a time and more than one phone or emulator is connected and ready, the
 * tests are shared out among up to N of them and each group runs in its own Taqwright process pinned to its phone (its own Appium port and UiAutomator2
 * system port). With one phone, or N = 1, nothing changes: the caller runs the tests one after another exactly as before.
 *
 * Only phones that are already connected are used: no emulator is started for this, and none is stopped.
 */
import { Adb } from "../device/adb.js";
import type { ScriptInput, ScriptRun } from "../../validation/runner.js";

export const MAX_PARALLEL_PHONES = 10;

/** Shares items out round-robin into `n` groups, keeping each item's position so results can be put back in order. */
export function shareOut<T>(items: readonly T[], n: number): Array<Array<{ item: T; at: number }>> {
    const groups: Array<Array<{ item: T; at: number }>> = Array.from({ length: Math.max(1, n) }, () => []);
    items.forEach((item, at) => groups[at % groups.length]!.push({ item, at }));
    return groups.filter((g) => g.length > 0);
}

/**
 * Runs the scripts on several connected phones, or returns undefined when that does not apply (setting off, one script, one phone, no adb).
 * `run` runs one group on one phone (the runner's own `execute`, with that phone's serial and a system port of its own).
 */
export async function runOnConnectedPhones(
    scripts: ScriptInput[],
    o: { parallel?: number | undefined; sourceEnv?: NodeJS.ProcessEnv | undefined; log?: ((m: string) => void) | undefined },
    run: (group: ScriptInput[], serial: string, systemPort: number) => Promise<ScriptRun[]>,
): Promise<ScriptRun[] | undefined> {
    const n = Math.min(MAX_PARALLEL_PHONES, Math.floor(o.parallel ?? 1));
    if (!(n > 1) || scripts.length < 2) return undefined;
    const adb = Adb.locate({ env: o.sourceEnv ?? process.env });
    if (!adb) return undefined;
    const ready = (await adb.devices().catch(() => [])).filter((d) => d.state === "device").slice(0, n);
    if (ready.length < 2) {
        o.log?.("Only one phone is ready, so the tests run one after another.");
        return undefined;
    }
    const groups = shareOut(scripts, ready.length);
    o.log?.(`Running on ${groups.length} phones at once: ${ready.slice(0, groups.length).map((d) => d.model ?? d.serial).join(", ")}`);
    const out: ScriptRun[] = new Array(scripts.length);
    // UiAutomator2 forwards one port per phone; parallel sessions must not share it (8200 is its default, so start above it).
    const runs = await Promise.all(groups.map((g, i) => run(g.map((x) => x.item), ready[i]!.serial, 8210 + i)));
    groups.forEach((g, i) => g.forEach((x, k) => (out[x.at] = runs[i]![k] ?? { testId: x.item.testId, status: "error", durationMs: 0, error: "No result came back for this test.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] })));
    return out;
}
