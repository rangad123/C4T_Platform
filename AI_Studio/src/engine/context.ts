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
