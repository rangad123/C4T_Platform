/**
 * Phone quality checks during a test run (this computer or a runner: the mobile runner calls this wherever it runs).
 *
 *  - Crashes and freezes: the phone's crash log is marked before the tests and read after them. A crash or freeze of the app under test fails the
 *    test with "The app crashed: <exception>" (or "The app stopped responding: …"), a finding with the stack trace: never a silent pass.
 *  - Start-up time: for a start-up check test (marker `// phone-check: start-up`), the app's cold start is measured once before the tests and
 *    compared with the budget (the project's, else the one written into the test, else 5 s).
 *  - Accessibility: a phone accessibility check test (marker `// phone-check: accessibility`) runs on its own; then the screen it ended on is read
 *    and checked (labels, touch targets, duplicate labels).
 *
 * Which test a crash belongs to: the only test of its run when it ran alone (check tests always do); otherwise the tests of that run that did not
 * pass (a crash usually makes the running test fail); when all of them passed, the last one, saying that the test could not be told. A phone that
 * cannot be read (no adb, several phones and none named) never fails a test that does not need it: the run log says what was not checked.
 */
import { Adb } from "../device/adb.js";
import { parseHierarchy } from "../device/uiautomator.js";
import type { MobileTarget } from "../target.js";
import type { ScriptInput, ScriptRun } from "../../validation/runner.js";
import { checkScreenA11y } from "./a11y.js";
import { a11yReason, crashReason, phoneChecksOf, slowStartReason } from "./findings.js";
import { AppMonitor, LOG_UNREADABLE } from "./monitor.js";
import { clampBudget, formatMs } from "./startup.js";
import type { AppCrash, StartupMeasure } from "./types.js";

export const NO_PHONE_LINK = "The phone could not be reached through adb on this computer";

export interface PhoneRunChecks {
    scripts: ScriptInput[];
    target: MobileTarget;
    sourceEnv: NodeJS.ProcessEnv;
    /** The emulator or phone the run uses, when the runner knows it. */
    serial?: string | undefined;
    signal?: AbortSignal | undefined;
    log?: ((message: string) => void) | undefined;
    /** The test account's password: scrubbed from anything read from the phone. */
    secrets?: readonly string[];
}

/** Opens the monitor on the run's phone: the named serial, else the only ready device. Undefined (with the reason) when that is not possible. */
export async function openRunMonitor(o: Pick<PhoneRunChecks, "sourceEnv" | "serial" | "signal" | "secrets">, appPackage: string): Promise<{ monitor?: AppMonitor; adb?: Adb; why?: string }> {
    const base = Adb.locate({ env: o.sourceEnv, ...(o.signal ? { signal: o.signal } : {}), secrets: [...(o.secrets ?? [])].filter((s) => s.length > 0) });
    if (!base) return { why: `${NO_PHONE_LINK} (the Android tools were not found)` };
    try {
        let serial = o.serial;
        if (!serial) {
            const ready = (await base.devices()).filter((d) => d.state === "device");
            if (ready.length !== 1) return { why: ready.length ? `${NO_PHONE_LINK}: several phones are connected and the run did not name one` : `${NO_PHONE_LINK}: no phone is connected` };
            serial = ready[0]!.serial;
        }
        const adb = base.forSerial(serial);
        return { monitor: new AppMonitor(adb, appPackage, o.secrets ?? []), adb };
    } catch (e) {
        return { why: `${NO_PHONE_LINK}: ${e instanceof Error ? e.message : String(e)}` };
    }
}

const failWith = (run: ScriptRun, error: string): ScriptRun => ({ ...run, status: "failed", error });

/** Runs the scripts through `runBatch` with the phone quality checks around them; the results come back in the scripts' order. */
export async function withPhoneChecks(o: PhoneRunChecks, runBatch: (scripts: ScriptInput[]) => Promise<ScriptRun[]>): Promise<ScriptRun[]> {
    const pkg = o.target.appPackage;
    if (!pkg || o.scripts.length === 0) return runBatch(o.scripts);
    const log = (m: string) => o.log?.(m);
    const checks = new Map(o.scripts.map((s) => [s.testId, phoneChecksOf(s.content)]));
    const opened = await openRunMonitor(o, pkg);
    const monitor = opened.monitor;
    let watching = false;
    if (monitor) {
        watching = await monitor.start();
        if (!watching) log(LOG_UNREADABLE);
    } else log(`Crashes and freezes are not checked in this run. ${opened.why ?? NO_PHONE_LINK}.`);

    // Start-up time: measured once, before the tests, when a start-up check is among them.
    let startup: { measure?: StartupMeasure; problem?: string } | undefined;
    if ([...checks.values()].some((c) => c.startup)) {
        startup = monitor ? await monitor.coldStart() : { problem: `The start-up time could not be measured: ${opened.why ?? NO_PHONE_LINK}` };
        if (startup.measure) log(`The app took ${formatMs(startup.measure.totalMs)} to open from a cold start`);
    }

    const plain = o.scripts.filter((s) => !checks.get(s.testId)!.accessibility);
    const alone = o.scripts.filter((s) => checks.get(s.testId)!.accessibility);
    const results = new Map<string, ScriptRun>();

    const attribute = (batch: ScriptInput[], runs: ScriptRun[], crashes: AppCrash[]) => {
        if (!crashes.length) return runs;
        const out = [...runs];
        const notPassed = out.map((r, i) => (r.status !== "passed" ? i : -1)).filter((i) => i >= 0);
        const targets = batch.length === 1 ? [0] : notPassed.length ? notPassed : [out.length - 1];
        const unsure = batch.length > 1 && notPassed.length === 0;
        const first = crashes[0]!;
        const more = crashes.length > 1 ? `\n(${crashes.length - 1} more crash${crashes.length > 2 ? "es" : ""} or freeze${crashes.length > 2 ? "s" : ""} logged in the same run.)` : "";
        for (const i of targets) {
            const r = out[i]!;
            const where = r.status !== "passed" && r.failedStepIndex >= 0 ? `while step ${r.failedStepIndex + 1} ran` : undefined;
            const text = crashReason(first, {
                seenWhile: unsure ? `Logged by the phone while ${batch.length} tests ran one after another; it could not be told which one, so it is reported on the last.` : "Logged by the phone while this test ran.",
                ...(where ? { where } : {}),
            });
            out[i] = { ...failWith(r, `${text}${more}`), ...(r.status === "passed" ? { failedStepIndex: -1 } : {}) };
        }
        log(`The app ${first.kind === "anr" ? "stopped responding" : "crashed"} during the run: ${first.exception}`);
        return out;
    };

    const runAndWatch = async (batch: ScriptInput[], after?: (runs: ScriptRun[]) => Promise<ScriptRun[]>) => {
        let runs = await runBatch(batch);
        if (after) runs = await after(runs);
        const crashes = watching && monitor ? await monitor.crashes() : [];
        runs = attribute(batch, runs, crashes);
        runs.forEach((r) => results.set(r.testId, r));
    };

    if (plain.length) await runAndWatch(plain);
    for (const s of alone) {
        if (o.signal?.aborted) break;
        await runAndWatch([s], async (runs) => {
            const r = runs[0];
            if (!r || r.status !== "passed") return runs;
            return [await screenCheck(r, opened.adb, pkg, opened.why, monitor)];
        });
    }

    // Start-up checks: the measurement decides, on a test that otherwise passed.
    for (const s of o.scripts) {
        const c = checks.get(s.testId)!;
        const r = results.get(s.testId);
        if (!c.startup || !r || r.status !== "passed") continue;
        const budget = clampBudget(o.target.startupBudgetMs ?? c.startup.budgetMs);
        if (!startup?.measure) results.set(s.testId, failWith(r, startup?.problem ?? "The start-up time could not be measured."));
        else if (startup.measure.totalMs > budget) results.set(s.testId, failWith(r, slowStartReason(startup.measure, budget)));
        else results.set(s.testId, { ...r, notes: [...(r.notes ?? []), `Start-up: ${formatMs(startup.measure.totalMs)} from a cold start (budget ${formatMs(budget)}).`] });
    }
    return o.scripts.map((s) => results.get(s.testId) ?? { testId: s.testId, status: "error", durationMs: 0, error: "The run was stopped before this test ran.", failedStepIndex: -1, steps: [], artifacts: [], responses: [] });
}

/** Reads the screen a passed accessibility check test ended on and checks it. A screen that cannot be read fails the test with the plain reason. */
async function screenCheck(r: ScriptRun, adb: Adb | undefined, pkg: string, why: string | undefined, monitor: AppMonitor | undefined): Promise<ScriptRun> {
    if (!adb) return failWith(r, `The accessibility check could not read the app's screen after the test: ${why ?? NO_PHONE_LINK}.`);
    let xml: string;
    try {
        xml = await adb.uiDump();
    } catch (e) {
        return failWith(r, `The accessibility check could not read the app's screen after the test: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = parseHierarchy(xml, { appPackage: pkg });
    if (!parsed.ok) return failWith(r, `The accessibility check could not read the app's screen after the test: ${parsed.error}`);
    if (parsed.snapshot.outsideApp) return failWith(r, "The accessibility check could not look at the app: after the test the phone did not show it.");
    const title = parsed.snapshot.elements.find((e) => !e.clickable && !e.editable && e.text.trim().length >= 2)?.text.trim().slice(0, 40) ?? "the screen";
    const density = await monitor?.densityDpi();
    const result = checkScreenA11y(parsed.snapshot, { screen: "", title, ...(density ? { densityDpi: density } : {}) });
    if (!result.issues.length) return { ...r, notes: [...(r.notes ?? []), `Accessibility: no problems found on “${title}” (${result.checked} elements checked).`] };
    return { ...failWith(r, a11yReason(result)), failedStepIndex: -1 };
}
