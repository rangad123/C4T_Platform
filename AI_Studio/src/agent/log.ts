/**
 * The agent's log: one plain line per event, with a timestamp, no payloads.
 *
 * Secrets are kept out twice. By construction nothing logs a token or a credential. And as a second line of defence every
 * line passes through `redact`, which masks any registered secret (the token, the credentials of the tasks being run) if
 * one ever slipped into a message, for example inside the text of an error from another library.
 */

export interface LogSink {
    out(line: string): void;
    err(line: string): void;
}

export type Level = "info" | "warn" | "error";

/** Secrets shorter than this are not masked: masking "a" would shred every line and protects nothing. */
const MIN_SECRET_LENGTH = 4;

export class Logger {
    private readonly secrets = new Map<string, number>();

    constructor(
        private readonly sink: LogSink,
        private readonly now: () => Date = () => new Date(),
    ) {}

    /** Register a value that must never appear in a line. Returns a function that forgets it (counted: the same value can be added twice). */
    addSecrets(values: Iterable<string | undefined>): () => void {
        const added: string[] = [];
        for (const v of values) {
            if (!v || v.length < MIN_SECRET_LENGTH) continue;
            this.secrets.set(v, (this.secrets.get(v) ?? 0) + 1);
            added.push(v);
        }
        return () => {
            for (const v of added) {
                const n = (this.secrets.get(v) ?? 1) - 1;
                if (n <= 0) this.secrets.delete(v);
                else this.secrets.set(v, n);
            }
        };
    }

    /** Mask every registered secret (longest first, so a secret that contains another is masked whole). */
    redact(text: string): string {
        let out = text;
        for (const s of [...this.secrets.keys()].sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
        return out;
    }

    line(level: Level, message: string): void {
        const clean = this.redact(message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\r?\n/g, " "));
        const text = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} ${clean.slice(0, 600)}`;
        if (level === "info") this.sink.out(text);
        else this.sink.err(text);
    }

    info(message: string): void {
        this.line("info", message);
    }
    warn(message: string): void {
        this.line("warn", message);
    }
    error(message: string): void {
        this.line("error", message);
    }
}

/** A logger that keeps lines in memory (tests). */
export function memoryLogger(): { log: Logger; lines: string[] } {
    const lines: string[] = [];
    return { log: new Logger({ out: (l) => lines.push(l), err: (l) => lines.push(l) }), lines };
}
