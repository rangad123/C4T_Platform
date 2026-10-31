/**
 * An error raised inside the browser library but outside any promise a job awaits (for example inside a route handler) would end the whole
 * process, and with it every other person's session. The job it belongs to fails or times out by itself, so such an error is logged and the
 * process carries on. Every other uncaught error still ends the process, exactly as Node does by default.
 */
export function isBrowserLibraryError(err: unknown): boolean {
    return err instanceof Error && typeof err.stack === "string" && /[\\/]playwright(-core)?[\\/]/.test(err.stack);
}

export function installCrashGuard(log: (line: string) => void = (l) => console.error(l)): void {
    process.on("uncaughtException", (err) => {
        if (isBrowserLibraryError(err)) {
            log(`[browser] An error inside the browser library did not end the platform: ${err.message.split("\n")[0]}`);
            return;
        }
        console.error(err);
        process.exit(1);
    });
}
