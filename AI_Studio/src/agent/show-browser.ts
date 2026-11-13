/**
 * "Show the browser while exploring" (the runner owner's switch, Settings, Your runner): whether an exploration on this runner opens its
 * browser in a visible window. Decided once per task, before the engine starts. Only the browser the AI explores and builds with is shown;
 * the test runs inside the exploration stay hidden (explore-child.ts). Never fails the task: on Linux without a screen the browser runs hidden
 * at once, and a visible launch that fails for want of a window is opened hidden instead (engine/discovery/browser.ts fallBackToHidden).
 * Either way the job says so once.
 */
export const BROWSER_HIDDEN_NOTE = "The browser window could not be shown on this computer, so it runs hidden.";

export interface BrowserWindow {
    headless: boolean;
    /** Said in the job's log when the window was asked for but this computer has no screen. */
    note?: string;
}

export function browserWindowFor(want: boolean, o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): BrowserWindow {
    if (!want) return { headless: true };
    const env = o.env ?? process.env;
    if ((o.platform ?? process.platform) === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { headless: true, note: BROWSER_HIDDEN_NOTE };
    return { headless: false };
}

/** `say` once, however often it is called. */
export function once(say: () => void): () => void {
    let said = false;
    return () => {
        if (said) return;
        said = true;
        say();
    };
}
