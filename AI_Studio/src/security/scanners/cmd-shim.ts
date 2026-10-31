/**
 * Running a Windows `.cmd` / `.bat` shim without turning the platform into a command line.
 *
 * Node refuses to `spawn` a batch file when `shell: false` (it answers `EINVAL`), and every npm-installed CLI on Windows ships as one
 * (`promptfoo.cmd`, `npx.cmd`, ...). So this platform has exactly two honest choices: refuse to run them, or run them through
 * `cmd.exe` deliberately. This module does the second, narrowly:
 *
 *   - Only for a file that ends in `.cmd` or `.bat`, only on Windows, and only for a path the administrator configured
 *     (`resolveExecutable` never returns a path that came from a request).
 *   - `cmd.exe /d /s /c "<program>" "<arg1>" "<arg2>" ...`, with every element quoted by this module and passed with
 *     `windowsVerbatimArguments`, which is the shape Windows itself expects and the one cross-spawn uses. Nothing is ever joined
 *     into a free-form command line that something else then re-parses.
 *   - Every argument, including the program path, is CHECKED first. If any of them contains a character the Windows command
 *     interpreter would reinterpret (`%`, `!`, `^`, `&`, `|`, `<`, `>`, a newline or a NUL), the run is REFUSED with a plain reason
 *     instead of being quoted hopefully. Refusing is the correct answer here: every argument the platform passes is one it generated
 *     (a flag, a number, a temporary path it created), so a rejection means something is genuinely wrong, and running it anyway is
 *     exactly the "arbitrary command execution" the design forbids.
 *
 * The refusal is a plain `Error`, so an adapter reports it as "the tool could not be started" and a test can assert the exact reason.
 */

/** Characters the Windows command interpreter would reinterpret rather than pass through literally. */
const CMD_UNSAFE = /[%!^&|<>\r\n\0"]/;

/** Quote one element for a cmd.exe command line: wrap in double quotes and escape any embedded quote as `\"`. */
export function quoteForCmd(value: string): string {
    return `"${value.replace(/(\\*)"/g, '$1$1\\"')}"`;
}

/** How one run is actually started. */
export interface SpawnPlan {
    file: string;
    args: string[];
    /** True when the program is a batch shim that had to go through the Windows command interpreter. */
    viaCommandInterpreter: boolean;
    /**
     * True when Node must not re-escape the argument list. Required with the command interpreter: it re-quotes its own arguments, and
     * letting it do that turns the quotes this module added into literal characters the command interpreter then rejects.
     */
    verbatimArguments: boolean;
}

/**
 * Decide how to start `file` with `args`. A `.cmd`/`.bat` shim on Windows is run through `cmd.exe`; anything else is spawned directly
 * with no interpreter at all. Throws when an argument would not survive that indirection safely.
 */
export function planSpawn(file: string, args: readonly string[]): SpawnPlan {
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
    if (!isBatch) return { file, args: [...args], viaCommandInterpreter: false, verbatimArguments: false };
    for (const [index, value] of [file, ...args].entries()) {
        if (CMD_UNSAFE.test(value)) {
            const which = index === 0 ? "the configured path of the scanner program" : `argument ${index}`;
            throw new Error(
                `${which} contains a character Windows would reinterpret (${JSON.stringify(value)}), so the scanner program was not started. ` +
                    `Point the scanner's path setting at a real executable rather than a batch shim, or use a path and settings without those characters.`,
            );
        }
    }
    // `/c` takes ONE argument: the whole command line, wrapped in an outer pair of quotes. Quoting each element separately and passing
    // them as separate arguments does not work here - `/s` strips the outermost quote of what follows `/c`, which leaves the first
    // element's quote stranded. Verified against cmd.exe on Windows; see tests/security-scanner-process.test.ts.
    // The outer pair is a literal wrapper, NOT another quoteForCmd(): re-escaping here would turn the inner quotes into backslashes.
    const commandLine = `"${[file, ...args].map(quoteForCmd).join(" ")}"`;
    return {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", commandLine],
        viaCommandInterpreter: true,
        verbatimArguments: true,
    };
}
