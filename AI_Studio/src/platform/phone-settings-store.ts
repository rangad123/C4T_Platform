/**
 * Reading and changing a project's phone settings (engine/mobile/phone-settings.ts) where they live: the `mobile` part of the project's latest
 * application's config JSON. A change rewrites that part in place (the application keeps its id, test account and app model), so nothing else of
 * the project moves. No table, no migration.
 *
 * Also the one place other parts record what they learned about the phone:
 *   recordExploredOn(repo, projectId, device)   the exploration says which device it used (phone tests then run there by default).
 */
import type { ExploredOn, PhoneSetup } from "../engine/mobile/phone-settings.js";
import { MobileTargetSchema, type MobileTarget } from "../engine/mobile/target.js";
import { HttpError } from "./http-error.js";
import type { Repo } from "./repo.js";

export const NO_APP = "Add the phone app under Settings, Mobile app first. These settings belong to it.";

export interface MobileRow {
    applicationId: string;
    config: Record<string, unknown>;
    mobile?: MobileTarget;
}

/** The project's latest application and its parsed mobile app (undefined when there is none or it no longer parses). */
export function latestMobileRow(repo: Repo, projectId: string): MobileRow | undefined {
    const a = repo.getLatestApplicationPublic(projectId);
    if (!a) return undefined;
    const config = (a.config ?? {}) as Record<string, unknown>;
    const parsed = MobileTargetSchema.safeParse(config.mobile);
    return { applicationId: a.id as string, config, ...(parsed.success ? { mobile: parsed.data } : {}) };
}

/** Changes the mobile app in place. `change` gets the current one and returns the next; the result is checked like any saved mobile app. */
export function updateMobileTarget(repo: Repo, projectId: string, change: (cur: MobileTarget) => MobileTarget): MobileTarget {
    const row = latestMobileRow(repo, projectId);
    if (!row?.mobile) throw new HttpError(409, NO_APP);
    const parsed = MobileTargetSchema.safeParse(change(row.mobile));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid phone settings");
    repo.db.run("UPDATE applications SET config_json = ? WHERE id = ?", JSON.stringify({ ...row.config, mobile: parsed.data }), row.applicationId);
    return parsed.data;
}

/** The exploration records the device it used. Never throws: a project without a mobile app (or an unreadable one) just keeps nothing. */
export function recordExploredOn(repo: Repo, projectId: string, device: ExploredOn): void {
    try {
        updateMobileTarget(repo, projectId, (cur) => ({ ...cur, exploredOn: { ...device, ...(device.model ? { model: device.model.slice(0, 60) } : {}), at: device.at ?? new Date().toISOString() } }));
    } catch {
        /* a courtesy for the next run's device choice */
    }
}

/** Keeps (or forgets) the values a phone had before this project changed them, per serial. */
export function withSaved(cur: MobileTarget, serial: string, part: "animations", value: NonNullable<PhoneSetup["animations"]>[string] | undefined): MobileTarget;
export function withSaved(cur: MobileTarget, serial: string, part: "stayAwake", value: string | undefined): MobileTarget;
export function withSaved(cur: MobileTarget, serial: string, part: "animations" | "stayAwake", value: unknown): MobileTarget {
    const setup: PhoneSetup = { ...(cur.phoneSetup ?? {}) };
    const map = { ...((setup[part] ?? {}) as Record<string, unknown>) };
    if (value === undefined) delete map[serial];
    else map[serial] = value;
    // At most 20 phones remembered per project (a lab may rotate phones; the oldest are dropped).
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete map[k];
    if (Object.keys(map).length) (setup as Record<string, unknown>)[part] = map;
    else delete setup[part];
    const { phoneSetup: _old, ...rest } = cur;
    return { ...rest, ...(setup.animations || setup.stayAwake ? { phoneSetup: setup } : {}) };
}
