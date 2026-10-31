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
import { parseStorageState, secretValuesOf } from "./storage-state.js";

const PLAYWRIGHT_IMPORT = 'import { test, expect } from "@playwright/test";\n';
/** No trace for these scripts: a trace records every request with its cookies, and the session's cookies are as good as a password. */
export const SESSION_LINE =
    "// Starts signed in with the project's saved sign-in (added for this run only; no trace, it would hold the session's cookies).\ntest.use({ storageState: process.env.AITP_STORAGE_STATE, trace: \"off\" });\n";

/** The script text a run writes: with the session line when the script uses the saved sign-in (and is a generated Playwright script). */
export function withSessionLine(content: string): string {
    const i = content.indexOf(PLAYWRIGHT_IMPORT);
    if (i < 0) return content;
    const at = i + PLAYWRIGHT_IMPORT.length;
    return content.slice(0, at) + SESSION_LINE + content.slice(at);
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
    const useSession = Boolean(storageState) && scripts.some((s) => s.session);
    if (useSession) {
        const state = parseStorageState(storageState);
        secrets = secretValuesOf(state);
        sessionFile = path.join(runDir, ".signed-in.json");
        await fs.writeFile(sessionFile, JSON.stringify(state), { mode: 0o600 });
        env.AITP_STORAGE_STATE = sessionFile;
    }
    let rpc: MailRpc | undefined;
    if (mail && scripts.some((s) => scriptWaitsForEmail(s.content))) {
        rpc = await startMailRpc(path.join(runDir, "mail"), mail);
        env.AITP_MAIL_DIR = rpc.dir;
    }
    return {
        env,
        content: (s) => (useSession && s.session ? withSessionLine(s.content) : s.content),
        secrets,
        async end() {
            await rpc?.stop().catch(() => undefined);
            if (sessionFile) await fs.rm(sessionFile, { force: true }).catch(() => undefined);
        },
    };
}
