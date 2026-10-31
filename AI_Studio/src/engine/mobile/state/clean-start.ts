/**
 * A clean start state for every phone test (project option, default off).
 *
 * With "Start every test from a fresh install of the app's data" on, the app's data is cleared (`pm clear`, the configured package only, never another)
 * before EACH test, so a test never depends on what the test before it left behind (a signed-in account, a filled cart, a question already answered).
 * With "Grant these permissions before each test", each listed runtime permission is granted to the configured package (`pm grant`) after the clear.
 *
 * Because a Taqwright run has no hook between tests that can reach adb, a project with either option runs its phone tests one Taqwright run per test,
 * the phone prepared in front of each. Preparation that fails makes THAT test an error with the reason; the test never runs on an unprepared phone.
 * The adb calls go through the closed wrapper (`Adb.forPreparation`), which the AI explorer never gets.
 */
import { Adb, AdbError } from "../device/adb.js";
import type { MobileTarget } from "../target.js";
import { cleanGrantList, permissionLabel } from "./permissions.js";

export interface Preparation {
    clearData: boolean;
    grant: string[];
    appPackage?: string;
}

export function preparationOf(target: Pick<MobileTarget, "cleanStart" | "grantPermissions" | "appPackage"> | undefined): Preparation {
    return { clearData: target?.cleanStart === true, grant: cleanGrantList(target?.grantPermissions), ...(target?.appPackage ? { appPackage: target.appPackage } : {}) };
}

export function needsPreparation(target: Pick<MobileTarget, "cleanStart" | "grantPermissions"> | undefined): boolean {
    const p = preparationOf(target);
    return p.clearData || p.grant.length > 0;
}

/** The plain sentence the plan and the run show; undefined when neither option is on (nothing changes for the person). */
export function startStateSentence(target: Pick<MobileTarget, "cleanStart" | "grantPermissions" | "appPackage"> | undefined): string | undefined {
    const p = preparationOf(target);
    if (!p.clearData && !p.grant.length) return undefined;
    const names = p.grant.map(permissionLabel);
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
    if (p.clearData && names.length) return `Each phone test starts from a fresh copy of the app's data, with these permissions granted: ${list}.`;
    if (p.clearData) return "Each phone test starts from a fresh copy of the app's data (the app's data is cleared before each test).";
    return `These permissions are granted to the app before each phone test: ${list}.`;
}

/** The two options after a settings change: a field the request leaves out keeps its value, null switches it off. Only set fields are returned. */
export function keptStartState(
    cur: Pick<MobileTarget, "cleanStart" | "grantPermissions"> | undefined,
    body: { cleanStart?: boolean | null | undefined; grantPermissions?: string[] | null | undefined },
): Pick<MobileTarget, "cleanStart" | "grantPermissions"> {
    const clean = body.cleanStart === undefined ? cur?.cleanStart : (body.cleanStart ?? undefined);
    const grant = body.grantPermissions === undefined ? cur?.grantPermissions : (body.grantPermissions ?? undefined);
    const list = cleanGrantList(grant);
    return { ...(clean ? { cleanStart: true } : {}), ...(list.length ? { grantPermissions: list } : {}) };
}

/** Why the options cannot be used for this target, in words; undefined when they can. */
export function preparationProblem(target: Pick<MobileTarget, "cleanStart" | "grantPermissions" | "appPackage">): string | undefined {
    if (needsPreparation(target) && !target.appPackage) return "Starting from fresh app data and granting permissions need the app's package name. Add it under Settings, Mobile app.";
    return undefined;
}

/** Clears and grants for one test. Throws an Error with a plain message when the phone could not be prepared. */
export async function prepareForTest(adb: Adb, p: Preparation, log?: (m: string) => void): Promise<void> {
    if (!p.appPackage) throw new Error("the app's package name is not set");
    const dev = adb.forPreparation();
    try {
        if (p.clearData) {
            await dev.forceStop(p.appPackage);
            await dev.clearAppData(p.appPackage);
            log?.("Cleared the app's data before the test");
        }
        for (const perm of p.grant) {
            try {
                await dev.grantPermission(p.appPackage, perm);
            } catch (e) {
                // A permission the app does not ask for cannot be granted: say which, plainly.
                if (e instanceof AdbError && e.code === "failed") throw new Error(`the permission ${permissionLabel(perm)} (${perm}) could not be granted; check that the app asks for it`);
                throw e;
            }
        }
        if (p.grant.length) log?.(`Granted ${p.grant.length} permission${p.grant.length === 1 ? "" : "s"} before the test`);
    } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
    }
}

export interface PreparedRunInput<S, R> {
    scripts: S[];
    target: MobileTarget;
    /** adb for the phone the tests run on (serial already chosen), or undefined when this computer has none. */
    adb: Adb | undefined;
    signal?: AbortSignal | undefined;
    log?: ((m: string) => void) | undefined;
    /** Runs ONE script in its own Taqwright run. */
    runOne: (script: S, i: number) => Promise<R[]>;
    /** The result of a script that did not run because the phone could not be prepared. */
    notPrepared: (script: S, reason: string) => R;
}

/** One run per test, the phone prepared in front of each. Results come back in input order. */
export async function runEachPrepared<S, R>(i: PreparedRunInput<S, R>): Promise<R[]> {
    const prep = preparationOf(i.target);
    const out: R[] = [];
    for (let k = 0; k < i.scripts.length; k++) {
        const script = i.scripts[k]!;
        if (i.signal?.aborted) throw new Error("Job cancelled");
        let problem: string | undefined;
        if (!i.adb) problem = "the Android tools (adb) were not found on the computer that runs the phone";
        else {
            try {
                await prepareForTest(i.adb, prep, i.log);
            } catch (e) {
                problem = e instanceof Error ? e.message : String(e);
            }
        }
        if (problem) {
            out.push(i.notPrepared(script, `The phone could not be prepared for this test, so it did not run: ${problem}.`));
            continue;
        }
        const runs = await i.runOne(script, k);
        out.push(...runs);
    }
    return out;
}
