/**
 * What phone runs and explorations learn about the device, kept with the project's mobile app (the application's config JSON, through
 * phone-settings-store.ts; no table): the device an exploration used (so the tests it writes run there) and the screen that opens the app, as a run
 * resolved it on the phone (shown read-only under Settings, Mobile app). Each write is a courtesy: it never throws and never stops a run.
 */
import type { PhoneMemory } from "../engine/orchestrator.js";
import { recordExploredOn, updateMobileTarget } from "./phone-settings-store.js";
import type { Repo } from "./repo.js";

export function rememberPhone(repo: Repo, projectId: string, d: PhoneMemory): void {
    if (d.exploredOn) recordExploredOn(repo, projectId, d.exploredOn);
    const a = d.appActivity;
    if (a) {
        try {
            // Only for the same app: a project whose app changed meanwhile keeps nothing from a run of the old one.
            updateMobileTarget(repo, projectId, (cur) => (cur.appPackage === a.appPackage && cur.appActivity !== a.activity ? { ...cur, appActivity: a.activity } : cur));
        } catch {
            /* nothing to keep it with */
        }
    }
}
