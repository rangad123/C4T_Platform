/**
 * The project's time limits for Windows desktop tests, laid over a generated script for ONE run (the stored script is not changed,
 * exactly like the computer's policy in policy.ts). Only used when a project changes them; without that the script runs as rendered.
 *
 *  - startTimeoutMs: how long the application may take to show its window. A spec that names its own `startTimeoutMs` keeps it.
 *  - testTimeoutMs: the test's time limit. The generated script sets its own (`test.setTimeout`), which wins over any config, so it
 *    is the line that is replaced.
 */
import { jsLit } from "./helper.js";
import { DESKTOP_TARGET_RE } from "./policy.js";

const SET_TIMEOUT_RE = /^(    )test\.setTimeout\(\d+\);$/m;
const DEFAULT_START_MS = 15_000;

export interface DesktopTimings {
    testTimeoutMs?: number;
    startTimeoutMs?: number;
}

export function withDesktopTimings(content: string, timings: DesktopTimings): string {
    let out = content;
    let start = DEFAULT_START_MS;
    if (timings.startTimeoutMs !== undefined) {
        const m = DESKTOP_TARGET_RE.exec(out);
        if (m) {
            try {
                const target = JSON.parse(m[1]!) as Record<string, unknown>;
                if (typeof target.startTimeoutMs !== "number") {
                    target.startTimeoutMs = Math.round(timings.startTimeoutMs);
                    out = out.replace(DESKTOP_TARGET_RE, () => `const DESKTOP_TARGET = ${jsLit(target)}; // aitp:target`);
                }
                start = typeof target.startTimeoutMs === "number" ? target.startTimeoutMs : start;
            } catch {
                /* a target that is not valid JSON is refused by the pre-flight check; leave it alone */
            }
        }
    }
    // Same formula as the generator: the start time plus 90 s, at least 120 s; or the project's own test limit.
    const testMs = timings.testTimeoutMs !== undefined ? Math.round(timings.testTimeoutMs) : timings.startTimeoutMs !== undefined ? Math.max(120, Math.ceil(start / 1000) + 90) * 1000 : undefined;
    if (testMs !== undefined) out = out.replace(SET_TIMEOUT_RE, (_all, indent: string) => `${indent}test.setTimeout(${testMs});`);
    return out;
}
