/**
 * The assessment loop for a standalone worker process (src/worker-main.ts, WORKER_EMBEDDED=false on the API process).
 * With WORKER_EMBEDDED on, the API process runs the loop itself (routes/assessments.ts) and this is not used.
 * Returns a stop function, or undefined when the module is switched off (SECURITY_ASSESSMENT=off).
 */
import type { Platform } from "../platform/bootstrap.js";
import { AssessmentLoop } from "./assessment/runner.js";
import { loopDeps } from "./routes/assessments.js";
import { securitySettings } from "./settings.js";

export function startStandaloneAssessmentLoop(p: Platform): (() => Promise<void>) | undefined {
    const settings = securitySettings(p.config);
    if (!settings.enabled) return undefined;
    const loop = new AssessmentLoop(loopDeps({ p, settings }), 1_500);
    loop.start();
    return () => loop.stop();
}
