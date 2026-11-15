/**
 * The assessment loop for a standalone worker process (src/worker-main.ts, WORKER_EMBEDDED=false on the API process).
 * With WORKER_EMBEDDED on, the API process runs the loop itself (routes/assessments.ts) and this is not used.
 * Returns a stop function, or undefined when the module is switched off (SECURITY_ASSESSMENT=off).
 */
import type { Platform } from "../platform/bootstrap.js";
import { AssessmentLoop } from "./assessment/runner.js";
import { isolationReady, warmIsolation } from "./egress/isolation.js";
import { loopDeps } from "./routes/assessments.js";
import { securitySettings } from "./settings.js";

export function startStandaloneAssessmentLoop(p: Platform): (() => Promise<void>) | undefined {
    const settings = securitySettings(p.config);
    if (!settings.enabled) return undefined;
    const loop = new AssessmentLoop(loopDeps({ p, settings }), 1_500);
    // Above passive, this machine's isolation is checked first without blocking (see routes/assessments.ts).
    let stopped = false;
    if (settings.activeProfiles)
        void warmIsolation().finally(() => {
            if (!stopped) loop.start();
        });
    else loop.start();
    return async () => {
        stopped = true;
        await loop.stop();
        // A check still running finishes, so it removes its temporary folders.
        await isolationReady();
    };
}
