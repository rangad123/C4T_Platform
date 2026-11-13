/**
 * Starting a run signed in, and serving its email steps: what the script runner does around one Playwright run (see
 * ../validation/runner.ts, which calls these and nothing else of this feature).
 *
 *  - Saved session: when the run carries the project's saved sign-in (RunEnv.storageState) and a script is marked to use it
 *    (ScriptInput.session), the session is written to the run's own folder (owner-only permissions), the script's file gets one line,
 *    `test.use({ storageState: process.env.AITP_STORAGE_STATE, trace: "off" })`, right after its Playwright import, and the file is removed when the run
 *    ends. The stored script is never changed: the line exists only in the run's copy.
 *  - Email steps: when the run has a mail source and a script waits for an email, the request folder is created and answered
 *    (./mail-rpc.ts).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { startMailRpc, type MailRpc } from "./mail-rpc.js";
import type { MailSource } from "./mail.js";
import { parseStorageState, playwrightState, RESTORE_SESSION_STORAGE_SOURCE, secretValuesOf, sessionStorageText, SIGN_IN_PATH } from "./storage-state.js";

const PLAYWRIGHT_IMPORT = 'import { test, expect } from "@playwright/test";\n';
/** No trace for these scripts: a trace records every request with its cookies, and the session's cookies are as good as a password. */
export const SESSION_LINE =
    "// Starts signed in with the project's saved sign-in (added for this run only; no trace, it would hold the session's cookies).\ntest.use({ storageState: process.env.AITP_STORAGE_STATE, trace: \"off\" });\n";

/** Restores the session's sessionStorage before the site's own code runs (only when the session has some). */
export const SESSION_STORAGE_LINE = `// The saved sign-in's sessionStorage, put back in every page before the site's own code runs (added for this run only).\ntest.beforeEach(async ({ context }) => {\n    if (process.env.AITP_SESSION_STORAGE) await context.addInitScript({ content: "(" + ${JSON.stringify(RESTORE_SESSION_STORAGE_SOURCE)} + ")(" + process.env.AITP_SESSION_STORAGE + ");" });\n});\n`;

/** The script text a run writes: with the session line when the script uses the saved sign-in (and is a generated Playwright script). */
export function withSessionLine(content: string, sessionStorage = false): string {
    const i = content.indexOf(PLAYWRIGHT_IMPORT);
    if (i < 0) return content;
    const at = i + PLAYWRIGHT_IMPORT.length;
    // A signed-in run keeps the real date: a session can depend on it, so a pinned date (TestSpec.pinnedTime) is left out of this run's copy.
    const rest = content.slice(at).replace(PINNED_LINE, "");
    return content.slice(0, at) + SESSION_LINE + (sessionStorage ? SESSION_STORAGE_LINE : "") + rest;
}

const PINNED_LINE = /^    await page\.clock\.setFixedTime\(new Date\("[^"\n]*"\)\);\n/gm;

/** The file Playwright runs once before the tests of a run that starts signed in (see sessionSetupSource). */
export const SESSION_SETUP_FILE = "signed-in.setup.ts";
/** What the setup prints when it signed in again; the run's output carries it. */
export const RENEWED_LINE = "AITP: the saved sign-in had run out, so the run signed in again once with the stored username and password.";

/**
 * A run's sign-in renewal (Playwright's global setup): before any test, open the check page with the saved sign-in. Still signed in: nothing
 * happens. Signed out, and the run has the stored username and password: sign in once on the application's own site (the password is typed
 * only when the page is on the check page's site), check again, and write the new sign-in over the run's copy, so every test starts signed
 * in instead of every test failing. The stored sign-in itself is not changed. Anything that goes wrong leaves the run as it was.
 */
export function sessionSetupSource(checkUrl: string): string {
    return `import { chromium, type FullConfig } from "@playwright/test";

const CHECK_URL = ${JSON.stringify(checkUrl)};
const SIGN_IN_PATH = ${SIGN_IN_PATH.toString()};
const USER_CSS = 'input[type=email]:visible, input[autocomplete=username]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible, input[name*="login" i]:visible, input[type=text]:visible';

export default async function renewSignIn(config: FullConfig): Promise<void> {
    const file = process.env.AITP_STORAGE_STATE;
    const user = process.env.TEST_USERNAME;
    const pass = process.env.TEST_PASSWORD;
    if (!file || !user || !pass) return;
    const use = (config.projects[0]?.use ?? {}) as { channel?: string; launchOptions?: Record<string, unknown> };
    const browser = await chromium.launch({ headless: process.env.PW_HEADLESS !== "false", ...(use.channel ? { channel: use.channel } : {}), ...(use.launchOptions ?? {}) }).catch(() => undefined);
    if (!browser) return;
    try {
        const context = await browser.newContext({ storageState: file, serviceWorkers: "block", acceptDownloads: false });
        const page = await context.newPage();
        const open = async () => {
            await page.goto(CHECK_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        };
        const signedIn = async () => {
            if ((await page.locator("input[type=password]:visible").count()) > 0) return false;
            const at = new URL(page.url());
            return at.origin === new URL(CHECK_URL).origin && !(SIGN_IN_PATH.test(at.pathname) && !SIGN_IN_PATH.test(new URL(CHECK_URL).pathname));
        };
        await open();
        if (await signedIn()) return;
        // Typed only on the application's own site, never on another one a redirect led to.
        if (new URL(page.url()).origin !== new URL(CHECK_URL).origin) return console.log("AITP: the saved sign-in has run out and the sign-in page is on another site, so the run did not sign in again.");
        const password = page.locator("input[type=password]:visible").first();
        if ((await password.count()) === 0) return;
        const username = page.locator(USER_CSS).first();
        if ((await username.count()) > 0) await username.fill(user);
        await password.fill(pass);
        await password.press("Enter");
        await password.waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
        await open();
        if (!(await signedIn())) return console.log("AITP: the saved sign-in has run out, and signing in again with the stored username and password did not work.");
        await context.storageState({ path: file, indexedDB: true });
        console.log(${JSON.stringify(RENEWED_LINE)});
    } catch (e) {
        console.log("AITP: the saved sign-in could not be checked before the run: " + String((e as Error)?.message ?? e).split("\\n")[0]);
    } finally {
        await browser.close().catch(() => undefined);
    }
}
`;
}

/** Does a script read an email (so the run must answer it)? */
export const scriptWaitsForEmail = (content: string): boolean => content.includes("AITP_MAIL_DIR");

export interface RunExtras {
    /** Extra environment variables for the Playwright child. */
    env: Record<string, string>;
    /** The text to write for script `i`. */
    content(script: { content: string; session?: boolean }): string;
    /** Values that must be masked in anything the run keeps (cookie and storage values of the session). */
    secrets: string[];
    /** Removes the session file and stops answering email steps. Never throws. */
    end(): Promise<void>;
}

export async function prepareRunExtras(runDir: string, scripts: ReadonlyArray<{ content: string; session?: boolean }>, storageState: string | undefined, mail: MailSource | undefined): Promise<RunExtras> {
    const env: Record<string, string> = {};
    let sessionFile: string | undefined;
    let secrets: string[] = [];
    let withStorage = false;
    const useSession = Boolean(storageState) && scripts.some((s) => s.session);
    if (useSession) {
        const state = parseStorageState(storageState);
        secrets = secretValuesOf(state);
        sessionFile = path.join(runDir, ".signed-in.json");
        await fs.writeFile(sessionFile, JSON.stringify(playwrightState(state)), { mode: 0o600 });
        env.AITP_STORAGE_STATE = sessionFile;
        const session = sessionStorageText(state);
        if (session) {
            env.AITP_SESSION_STORAGE = session;
            withStorage = true;
        }
        // A sign-in that runs out during a run is renewed once, before the tests (the config gets a global setup).
        if (state.checkUrl && /^https?:\/\//.test(state.checkUrl)) {
            const config = path.join(runDir, "playwright.config.ts");
            const text = await fs.readFile(config, "utf8").catch(() => "");
            if (text.includes('    testDir: ".",\n')) {
                await fs.writeFile(path.join(runDir, SESSION_SETUP_FILE), sessionSetupSource(state.checkUrl));
                await fs.writeFile(config, text.replace('    testDir: ".",\n', () => `    testDir: ".",\n    globalSetup: "./${SESSION_SETUP_FILE}",\n`));
            }
        }
    }
    let rpc: MailRpc | undefined;
    if (mail && scripts.some((s) => scriptWaitsForEmail(s.content))) {
        rpc = await startMailRpc(path.join(runDir, "mail"), mail);
        env.AITP_MAIL_DIR = rpc.dir;
    }
    return {
        env,
        content: (s) => (useSession && s.session ? withSessionLine(s.content, withStorage) : s.content),
        secrets,
        async end() {
            await rpc?.stop().catch(() => undefined);
            if (sessionFile) await fs.rm(sessionFile, { force: true }).catch(() => undefined);
        },
    };
}
