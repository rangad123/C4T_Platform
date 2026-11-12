/**
 * Refusing a Windows desktop run early, before a job exists, with a plain sentence.
 *
 * Two places can run desktop tests: the platform host itself (when it is a Windows computer in a signed-in session) and a
 * runner agent. In both cases the computer that runs them keeps an allow-list of applications it may start; a spec never
 * widens it. These checks only decide whether to START a job; the computer that runs the tests checks again before it
 * starts anything (see engine/frameworks/windows.ts and the agent's task runner).
 *
 * A refusal is HTTP 409 (the request is fine, the setup is not). It never becomes a failing test.
 */
import type { Capabilities } from "../agent-protocol/schema.js";
import { checkApp, hostAllowList } from "../engine/desktop/policy.js";
import { desktopUnavailableReason, lastProbe, probeDesktop } from "../engine/desktop/probe.js";
import { isDeniedProgram } from "../engine/desktop/target.js";
import type { TestSpec } from "../engine/spec/schema.js";
import { HttpError } from "./http-error.js";

/** The distinct applications the desktop specs among `specs` start. */
export function desktopApps(specs: readonly TestSpec[]): string[] {
    return [...new Set(specs.filter((s) => s.kind === "desktop" && s.desktop).map((s) => s.desktop!.app))];
}

/**
 * The platform host runs the tests: it must be Windows, in a normal interactive session, and each application must be on
 * `DESKTOP_ALLOWED_APPS`. `platform` and `allow` are parameters so the rules can be tested on any computer.
 */
export function hostDesktopProblem(apps: readonly string[], opts: { platform?: NodeJS.Platform; allow?: readonly string[] } = {}): string | undefined {
    if (apps.length === 0) return undefined;
    const platform = opts.platform ?? process.platform;
    if (platform !== "win32") return "Windows desktop tests need a Windows computer, and this platform runs on another system. Set up your runner on a Windows computer in Settings.";
    // The probe runs in the background the first time; once it has an answer, a non-interactive or elevated session is refused here.
    if (opts.platform === undefined) {
        const known = lastProbe();
        if (!known) void probeDesktop();
        const why = desktopUnavailableReason(platform, known);
        if (why) return why;
    }
    const allow = opts.allow ?? hostAllowList();
    for (const app of apps) {
        const d = checkApp(app, allow, "host", platform);
        if (!d.ok) return d.message;
    }
    return undefined;
}

/** True when an agent that reports `allowedApps` may start `app` (a full path, or a bare name matched on the file name). */
export function agentAllows(caps: Capabilities, app: string): boolean {
    const list = caps.windows?.allowedApps ?? [];
    const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    const wanted = norm(/\.exe$/i.test(app) ? app : `${app}.exe`);
    if (/^[a-z]:\\/.test(wanted)) return list.some((a) => norm(a) === wanted);
    return list.some((a) => norm(a).split("\\").pop() === wanted);
}

/** The agents can run desktop tests, but none of them is set up to start one of the applications. Undefined = fine. */
export function agentDesktopProblem(apps: readonly string[], agents: ReadonlyArray<{ capabilities: Capabilities }>): string | undefined {
    for (const app of apps) {
        const shown = app.length > 80 ? `${app.slice(0, 79)}…` : app;
        if (isDeniedProgram(app)) return `${shown} can't be started by a test: command shells, script hosts and similar programs are never allowed.`;
        if (!agents.some((a) => agentAllows(a.capabilities, app))) return `This computer isn't set up to start ${shown}. Add it with --allow-app, then run again.`;
    }
    return undefined;
}

/** Throw the 409 for a host problem. */
export function assertHostDesktop(apps: readonly string[]): void {
    const why = hostDesktopProblem(apps);
    if (why) throw new HttpError(409, why);
}
