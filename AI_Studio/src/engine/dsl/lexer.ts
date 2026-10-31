/**
 * Text tests, step 1: cut one line into words and quoted texts. Pure text work: nothing here evaluates, fetches or reads a file.
 *
 * A line is a list of tokens. A token is either a bare word (anything up to a space or a quote) or a text in straight double quotes.
 * Inside a quoted text a backslash starts an escape: \" \\ \n \r \t \b \f \/ and \uXXXX. Everything else after a backslash is a
 * mistake that is reported (a typed backslash is written \\).
 */

export interface Token {
    /** "bad" is a quoted text that could not be read (`error` says why); the parser reports it where it matters. */
    kind: "word" | "str" | "bad";
    /** The raw text of the token as typed (with the quotes for a quoted text). */
    raw: string;
    /** Words: the word. Quoted texts: the text with escapes resolved. */
    value: string;
    /** Zero-based offsets into the line: start inclusive, end exclusive. */
    start: number;
    end: number;
    /** A quote that touches the word before it (`item="x"`). Steps need a space there. */
    glued: boolean;
    error?: string;
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "/": "/" };

/** A quoted text as the printer writes it: only what must be escaped is. */
export function quote(s: string): string {
    let out = '"';
    for (const ch of s) {
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch < " " || ch === "\u2028" || ch === "\u2029") out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
        else out += ch;
    }
    return out + '"';
}

const isSpace = (ch: string) => ch === " " || ch === "\t" || ch === " " || ch === "　";

export function tokenize(line: string): Token[] {
    const out: Token[] = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
        const ch = line[i]!;
        if (isSpace(ch)) {
            i++;
            continue;
        }
        const glued = i > 0 && !isSpace(line[i - 1]!);
        if (ch === '"') {
            const start = i;
            i++;
            let value = "";
            let error: string | undefined;
            let closed = false;
            while (i < n) {
                const c = line[i]!;
                if (c === "\\") {
                    const next = line[i + 1];
                    if (next === undefined) {
                        error = "A backslash cannot end the line. Write two (\\\\) for one backslash.";
                        i++;
                        break;
                    }
                    if (next === "u") {
                        const hex = line.slice(i + 2, i + 6);
                        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                            value += String.fromCharCode(parseInt(hex, 16));
                            i += 6;
                            continue;
                        }
                        error ??= "After \\u there must be four hexadecimal digits, like \\u00e9.";
                        i += 2;
                        continue;
                    }
                    if (next in ESCAPES) {
                        value += ESCAPES[next]!;
                        i += 2;
                        continue;
                    }
                    error ??= `\\${next} is not a known escape. Write two backslashes (\\\\) for one, or \\" for a quote.`;
                    value += next;
                    i += 2;
                    continue;
                }
                if (c === '"') {
                    closed = true;
                    i++;
                    break;
                }
                value += c;
                i++;
            }
            if (!closed && !error) error = "This text is missing its closing quote.";
            out.push({ kind: error ? "bad" : "str", raw: line.slice(start, i), value, start, end: i, glued, ...(error ? { error } : {}) });
            continue;
        }
        const start = i;
        while (i < n && !isSpace(line[i]!) && line[i] !== '"') i++;
        const raw = line.slice(start, i);
        out.push({ kind: "word", raw, value: raw, start, end: i, glued: false });
    }
    return out;
}

/**
 * The end (exclusive) of the JSON object or array that starts at `from`, or -1 when it never closes. String-aware; the nesting depth is
 * capped so a long run of brackets cannot cost much.
 */
export function scanJsonEnd(line: string, from: number, maxDepth = 64): number {
    let depth = 0;
    let inString = false;
    for (let i = from; i < line.length; i++) {
        const c = line[i]!;
        if (inString) {
            if (c === "\\") i++;
            else if (c === '"') inString = false;
            continue;
        }
        if (c === '"') inString = true;
        else if (c === "{" || c === "[") {
            depth++;
            if (depth > maxDepth) return -1;
        } else if (c === "}" || c === "]") {
            depth--;
            if (depth === 0) return i + 1;
            if (depth < 0) return -1;
        }
    }
    return -1;
}

/** Levenshtein distance, for "did you mean" (inputs are short; the work is capped by the caller). */
export function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 6) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length]!;
}
