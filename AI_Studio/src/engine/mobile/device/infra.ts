/**
 * Infrastructure failures of a phone run: the test helper on the phone (UiAutomator2 server) crashed, the connection dropped, the phone went offline,
 * or the test session could not be started. None of these says anything about the app, so a test that hit one is run once more and, if it happens
 * again, reported as "the phone could not run the test" (status error, never a failing test of the app, never sent to repair).
 */
import type { ScriptRun } from "../../validation/runner.js";

/** Every infrastructure result starts with this (the validator and the web labels read it). */
export const PHONE_INFRA_PREFIX = "The phone could not run the test: ";

const KINDS: Array<{ re: RegExp; words: string }> = [
    { re: /instrumentation process (is not running|cannot be initiali[sz]ed)|instrumentation (died|crashed)|UiAutomator2 server (is not running|crashed|has (quit|exited))|uiautomator2 server is not listening|INSTRUMENTATION_(FAILED|ABORTED)|UiAutomationService .* already registered/i, words: "the test helper on the phone (UiAutomator2) stopped while the test ran." },
    { re: /socket hang up|ECONNRESET|ECONNREFUSED 127\.0\.0\.1|Could not proxy command to the remote server|connect ECONNREFUSED/i, words: "the connection to the phone dropped while the test ran." },
    { re: /device offline|device '[^']*' not found|was not in the list of connected devices|device unauthori[sz]ed|no devices\/emulators found|Could not find a connected Android device/i, words: "the phone went offline or was disconnected while the test ran." },
    { re: /A new session could not be created|Could not start a new session|Failed to create session|Unable to resolve the launchable activity/i, words: "the test session could not be started on the phone." },
];

const textOf = (r: ScriptRun): string => [r.error ?? "", ...r.steps.map((s) => s.error ?? "")].join("\n");

/** The plain words for an infrastructure failure of this run, or undefined when it is an ordinary result. */
export function infraKind(r: ScriptRun): string | undefined {
    if (r.status === "passed" || r.status === "skipped") return undefined;
    if ((r.error ?? "").startsWith(PHONE_INFRA_PREFIX)) return undefined; // already labelled
    const t = textOf(r);
    return KINDS.find((k) => k.re.test(t))?.words;
}

/** The run, labelled as an infrastructure result (after the second attempt hit one too). */
export function asInfrastructure(r: ScriptRun, words: string, attempts: number): ScriptRun {
    const detail = textOf(r)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0)
        ?.slice(0, 200);
    const tried = attempts > 1 ? ` It was tried ${attempts === 2 ? "twice" : `${attempts} times`}.` : "";
    return {
        ...r,
        status: "error",
        error: `${PHONE_INFRA_PREFIX}${words}${tried} This is a problem of the phone or its connection, not a failing test of the app.${detail ? `\nDetails: ${detail}` : ""}`,
    };
}

/** Is this result an infrastructure result (labelled by asInfrastructure)? */
export const isPhoneInfrastructure = (r: Pick<ScriptRun, "error">): boolean => (r.error ?? "").startsWith(PHONE_INFRA_PREFIX);
