/**
 * Runner capability parity: the preview judges the tests the viewer's runner can run, but a deploy trigger runs the tests its maker's
 * runner can run (trigger-services.ts: runnableTestIds with runnerOwnerOf(token.createdBy)). For each active (not revoked) deploy token of
 * the project this works out that set the same way and compares it with the viewer's. When a set differs, or whose runner a token uses
 * cannot be resolved, the preview says so and requires a full run (preview.ts). Reads only.
 *
 * A maker with a local account is also put through the check the trigger itself makes before it starts a run (`ownerCheck`: the route
 * passes c4t-service.ts assertC4tOwnerMayRun, which asks Crowd4Test whether a Crowd4Test maker is still active and may run tests). When
 * that check refuses, or Crowd4Test cannot answer, the trigger's runs would not start as this preview describes: unresolved.
 */
import { OWNER_MAY_NOT_RUN, OWNER_NOT_ACTIVE } from "../c4t-service.js";
import { OPEN_OWNER_ID, runnerOwnerOf } from "../agent-store.js";
import type { Repo } from "../repo.js";
import { runnableTestIds } from "../scheduler.js";

/** One active deploy token compared with the viewer. */
export interface TriggerParity {
    /** How the token is named to a person: its label and the last characters of the token (only those when it has no label). */
    trigger: string;
    /** Whose runner it uses cannot be resolved: why, in words. Then the sets were not compared. */
    unresolvedWhy?: string;
    /** Test ids the viewer's runner can run and the token's maker's cannot. */
    onlyViewer: string[];
    /** Test ids the token's maker's runner can run and the viewer's cannot. */
    onlyTrigger: string[];
}

/** Pure: compare two runnable sets. */
export function compareSets(viewer: ReadonlySet<string>, trigger: ReadonlySet<string>): Pick<TriggerParity, "onlyViewer" | "onlyTrigger"> {
    return { onlyViewer: [...viewer].filter((id) => !trigger.has(id)).sort(), onlyTrigger: [...trigger].filter((id) => !viewer.has(id)).sort() };
}

export const triggerName = (label: string | null, hint: string): string => (label ? `“${label.slice(0, 80)}” (…${hint})` : `…${hint}`);

/**
 * Each active deploy token of the project against the viewer's runnable set. `viewer` undefined: the viewer's set could not be worked out,
 * so every token is reported unresolved (nothing to compare with).
 */
/** Words for a refusal of the trigger's own check on the token's maker. */
function ownerRefusedWhy(e: unknown): string {
    const msg = e instanceof Error ? e.message : "";
    if (msg === OWNER_NOT_ACTIVE) return "Crowd4Test says the person who made it no longer has an active account, so its runs do not start";
    if (msg === OWNER_MAY_NOT_RUN) return "Crowd4Test says the person who made it may no longer run tests, so its runs do not start";
    return "Crowd4Test could not confirm that the person who made it may still run tests, so whether its runs start is not known";
}

export async function triggerParity(
    repo: Repo,
    projectId: string,
    viewer: ReadonlySet<string> | undefined,
    /** The trigger's own check on a token's maker (assertC4tOwnerMayRun); throws when a run in their name must not start. */
    ownerCheck?: (createdBy: string) => Promise<void>,
): Promise<TriggerParity[]> {
    const tokens = repo.db.all<{ label: string | null; hint: string; created_by: string | null }>(
        "SELECT label, hint, created_by FROM trigger_tokens WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at, id",
        projectId,
    );
    const out: TriggerParity[] = [];
    const cache = new Map<string, Set<string> | undefined>();
    const checked = new Map<string, string | undefined>();
    for (const t of tokens) {
        const trigger = triggerName(t.label, t.hint);
        const none = { onlyViewer: [], onlyTrigger: [] };
        if (!viewer) {
            out.push({ trigger, unresolvedWhy: "which tests your runner can run could not be worked out, so there is nothing to compare with", ...none });
            continue;
        }
        if (!t.created_by) {
            out.push({ trigger, unresolvedWhy: "it was made before deploy triggers recorded who made them, so whose runner it uses is not known", ...none });
            continue;
        }
        // The shared access key and the open server have no account to check; a person must still have an active one.
        const owner = runnerOwnerOf(t.created_by);
        if (owner && owner !== OPEN_OWNER_ID && !repo.db.get("SELECT 1 AS x FROM users WHERE id = ? AND role IS NOT NULL AND status = 'active'", owner)) {
            out.push({ trigger, unresolvedWhy: "the person who made it no longer has an active account, so whose runner it uses is not known", ...none });
            continue;
        }
        if (ownerCheck) {
            if (!checked.has(t.created_by)) {
                try {
                    await ownerCheck(t.created_by);
                    checked.set(t.created_by, undefined);
                } catch (e) {
                    checked.set(t.created_by, ownerRefusedWhy(e));
                }
            }
            const refused = checked.get(t.created_by);
            if (refused) {
                out.push({ trigger, unresolvedWhy: refused, ...none });
                continue;
            }
        }
        const key = owner ?? "";
        if (!cache.has(key)) {
            try {
                cache.set(key, new Set(await runnableTestIds(repo, projectId, "validate", owner)));
            } catch {
                cache.set(key, undefined);
            }
        }
        const set = cache.get(key);
        if (!set) {
            out.push({ trigger, unresolvedWhy: "which tests its maker's runner can run could not be worked out", ...none });
            continue;
        }
        out.push({ trigger, ...compareSets(viewer, set) });
    }
    return out;
}
