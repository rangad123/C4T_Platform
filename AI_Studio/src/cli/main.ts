import { API_DIFF_HELP, apiDiffCommand } from "./api-diff.js";
import { HELP, parseCli } from "./args.js";
import { EXIT, InfraError, UsageError } from "./errors.js";
import { exportCommand } from "./export.js";
import { runCommand, type Io } from "./run.js";

/** Entry point shared by `npm run ai-test` and the `ai-test` bin. Returns the exit code; never throws. */
export async function main(argv: string[], io: Io): Promise<number> {
    try {
        if (argv[0] === "api-diff") return await apiDiffCommand(argv.slice(1), io);
        if (argv[0] === "help" && argv[1] === "api-diff") {
            io.out(API_DIFF_HELP);
            return EXIT.OK;
        }
        const parsed = parseCli(argv);
        if (parsed.command === "help") {
            io.out(parsed.topic ? HELP[parsed.topic] : HELP.main);
            return EXIT.OK;
        }
        return parsed.command === "run" ? await runCommand(parsed.args, io) : await exportCommand(parsed.args, io);
    } catch (e) {
        if (e instanceof UsageError) io.err(`ai-test: ${e.message}`);
        else if (e instanceof InfraError) io.err(`ai-test: ${e.message}`);
        else io.err(`ai-test: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        return EXIT.ERROR;
    }
}
