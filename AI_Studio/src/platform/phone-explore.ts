/**
 * The checks made before an AI phone exploration is queued, so a person gets a plain sentence at once instead of a failed job later.
 * (The model is checked when the job starts: the platform's own client does not know a per-job model.)
 */
import type { MobileTarget } from "../engine/mobile/target.js";
import { NO_PACKAGE } from "../engine/mobile/explore/pipeline.js";
import { agentServiceOf } from "./agent-services.js";
import { chooseDeviceHost, localDeviceProblem } from "./agent-device.js";
import { callerIdOf, sessionHosts } from "./agent-record.js";
import { currentActor } from "./auth/actor.js";
import { HttpError } from "./http-error.js";

/** Throws a plain HttpError when this project cannot have its Android app explored right now. */
export function assertPhoneExploration(projectId: string, mobile: MobileTarget | undefined): void {
    if (!mobile) throw new HttpError(422, "This project has no mobile app set up. Add an app package or an APK first.");
    if (!mobile.appPackage) throw new HttpError(422, NO_PACKAGE);
    const svc = agentServiceOf(projectId);
    const local = localDeviceProblem();
    if (!svc) {
        if (local) throw new HttpError(409, local);
        return;
    }
    // Where the phone is comes from the project's runner choice, exactly as it will when the job starts.
    // The person starting it: their own computer may host it, another person's never.
    const caller = callerIdOf(currentActor());
    chooseDeviceHost({ runner: svc.store.getRunner(projectId), agents: sessionHosts(svc.store, projectId, caller), caller, ...(local ? { localProblem: local } : {}) });
}
