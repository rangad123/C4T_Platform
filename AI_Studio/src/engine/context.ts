import type { Config } from "../config.js";
import type { ScriptExecutor } from "./frameworks/types.js";
import type { LlmClient } from "./llm/provider.js";
import type { FrameSink } from "./frames/sink.js";

export type Stage = "discovery" | "analysis" | "planning" | "generation" | "validation" | "orchestration";

/**
 * Concise, structured observability event. Deliberately NOT a place for model reasoning —
 * only what happened ("Page visited", "Validation failed: step 3 ...").
 */
export interface EngineEvent {
    stage: Stage;
    kind: string;
    message: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
}

export interface EngineContext {
    config: Config;
    llm: LlmClient;
    emit(event: EngineEvent): void;
    signal?: AbortSignal;
    /** Where this job's scripts run (see ./frameworks). Unset: on this machine. */
    executor?: ScriptExecutor;
    /** The project switched this framework off: a plain sentence, or undefined when it may run (project framework settings; unset = all on). */
    frameworkOff?: (adapterId: string) => string | undefined;
    /** The Explorer view's picture source: set only while a person can watch this job (exploration and the plain-English builder). Unset: no picture is ever taken. */
    frames?: FrameSink;
    /** Opens a phone or emulator for the AI to explore an Android app (this computer's adb or a runner). Unset: phone exploration is not available. */
    openDevice?: import("./mobile/explore/types.js").DeviceOpener;
    /** This job's Android tests run on a device farm (platform/device-farm-run.ts), so no phone of this computer is needed. Unset: as always. */
    deviceFarm?: { label: string };
    /** The project's shared elements, by name: a repair without AI may try an element's other locators (healing/deterministic.ts). Unset: none. */
    sharedElements?: import("./locators/refs.js").ObjectIndex;
    /** Pauses the job to ask a person on the job page (a one-time code or captcha during a phone sign-in, mobile/explore/signin.ts). Unset: nobody can be asked. */
    askPerson?: import("./mobile/explore/signin.js").PersonGate;
    /** C10: the project's read-only database access (its database probe, platform/db-probe-store.ts). Unset: none set up, or a benchmark's own. */
    dbProbe?: import("./database/probe.js").DatabaseProbe;
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Job cancelled");
}

/** Run `fn` over items with bounded concurrency; results keep input order. Errors are captured per item. */
export async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }>> {
    const results: Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }> = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            try {
                results[i] = { ok: true, value: await fn(items[i]!, i) };
            } catch (error) {
                results[i] = { ok: false, error, item: items[i]! };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/**
 * mapLimit with lanes: items with the same lane key (the account they sign in as) never run at the same time and run in input order;
 * items without one, and other lanes, run beside them, never more than `limit` at once. The lane with the most items left starts
 * first, so a long lane does not end up running alone at the end. Results keep input order; errors are captured per item.
 */
export async function mapLanes<T, R>(
    items: T[],
    limit: number,
    laneOf: (item: T, index: number) => string | undefined,
    fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }>> {
    const results: Array<{ ok: true; value: R } | { ok: false; error: unknown; item: T }> = new Array(items.length);
    const lanes = items.map((item, i) => laneOf(item, i));
    const waiting = items.map((_, i) => i);
    const busy = new Set<string>();
    const left = (lane: string | undefined) => (lane === undefined ? 0 : waiting.filter((i) => lanes[i] === lane).length);
    let running = 0;
    return await new Promise((resolve) => {
        const pump = () => {
            while (running < Math.max(1, limit)) {
                let pick = -1;
                for (let w = 0; w < waiting.length; w++) {
                    const lane = lanes[waiting[w]!];
                    if (lane !== undefined && busy.has(lane)) continue;
                    if (pick < 0 || left(lane) > left(lanes[waiting[pick]!])) pick = w;
                }
                if (pick < 0) break;
                const i = waiting.splice(pick, 1)[0]!;
                const lane = lanes[i];
                if (lane !== undefined) busy.add(lane);
                running++;
                void (async () => {
                    try {
                        results[i] = { ok: true, value: await fn(items[i]!, i) };
                    } catch (error) {
                        results[i] = { ok: false, error, item: items[i]! };
                    }
                    running--;
                    if (lane !== undefined) busy.delete(lane);
                    pump();
                })();
            }
            if (running === 0 && waiting.length === 0) resolve(results);
        };
        pump();
    });
}
