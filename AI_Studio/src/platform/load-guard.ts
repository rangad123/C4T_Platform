/**
 * Where a load check may NOT be sent (see engine/performance/load.ts). Two rules, both checked by the platform before any
 * load request exists: the outbound-address guard every target goes through, and "never production".
 *
 * A project has no flag of its own for "this address is production"; the only place that says so is a named environment
 * marked production. So an address that is the base or API address of such an environment (same origin) is refused.
 */
import type { Db } from "./db.js";
import { isAppUri } from "../engine/desktop/target.js";
import { assertAllowedTarget } from "./net-guard.js";
import { HttpError } from "./http-error.js";

const originOf = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
        return new URL(raw).origin;
    } catch {
        return undefined;
    }
};

/** Origins of the project's environments that are marked production (base and API address of each). */
export function productionOrigins(db: Db, projectId: string): Set<string> {
    const rows = db.all<{ base_url: string; api_base_url: string | null }>("SELECT base_url, api_base_url FROM project_environments WHERE project_id = ? AND production = 1", projectId);
    const out = new Set<string>();
    for (const r of rows) for (const o of [originOf(r.base_url), originOf(r.api_base_url)]) if (o) out.add(o);
    return out;
}

/**
 * Why load must not be sent to these addresses, or undefined when it may. Addresses are the ones the load check would really
 * call (the API address when there is one, else the application's).
 */
export async function loadTargetProblem(db: Db, projectId: string, urls: Array<string | null | undefined>): Promise<string | undefined> {
    const targets = urls.filter((u): u is string => typeof u === "string" && u.length > 0 && !isAppUri(u));
    const prod = productionOrigins(db, projectId);
    for (const u of targets) {
        if (prod.has(originOf(u) ?? "")) return `Load checks don't run on production: ${new URL(u).origin} is a production environment of this project.`;
        try {
            await assertAllowedTarget(u);
        } catch (e) {
            return e instanceof HttpError ? e.message : "This address is not allowed as a test target.";
        }
    }
    return undefined;
}
