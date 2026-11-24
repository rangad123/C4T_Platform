/**
 * What a change touched, from a pull request's files and their patches (pure; no I/O).
 *
 *  - Changed lines: added lines on the new side, removed lines on the old side, and for each removal the new-side line it sits before
 *    (so a removal can be placed in the new file's functions too).
 *  - Changed functions: when the new file's source is at hand, the innermost function, method or class around each changed line
 *    (a JS/TS scan that skips strings, comments and regular expressions, or Python's indentation). Without the source, only the
 *    function name git wrote in the hunk header, marked as the weaker evidence it is (git names the last function that starts
 *    before the hunk, which may have ended before the change).
 */

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    /** The text after the second `@@` (git's function context), trimmed; "" when there is none. */
    header: string;
}

export interface PatchLines {
    hunks: Hunk[];
    /** New-side line numbers of added lines. */
    added: number[];
    /** Old-side line numbers of removed lines. */
    removed: number[];
    /** For each removed line, the new-side line it was removed before (deduplicated). */
    removedAt: number[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** The hunks and changed lines of one file's unified patch (as GitHub's files API gives it, with or without the ---/+++ lines). */
export function parsePatch(patch: string): PatchLines {
    const out: PatchLines = { hunks: [], added: [], removed: [], removedAt: [] };
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const line of patch.split(/\r?\n/)) {
        const h = HUNK.exec(line);
        if (h) {
            const hunk = { oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]), header: h[5]!.trim() };
            out.hunks.push(hunk);
            oldLine = hunk.oldStart;
            newLine = hunk.newStart;
            inHunk = true;
            continue;
        }
        if (!inHunk || line.startsWith("\\")) continue; // "\ No newline at end of file"
        if (line.startsWith("+")) out.added.push(newLine++);
        else if (line.startsWith("-")) {
            out.removed.push(oldLine++);
            // A removal at the very start of a file (new side 0) sits before line 1.
            const at = Math.max(1, newLine);
            if (out.removedAt.at(-1) !== at) out.removedAt.push(at);
        } else {
            oldLine++;
            newLine++;
        }
    }
    return out;
}

// ── a JS/TS scanner: which characters are code ─────────────────────────────────

export interface JsScan {
    /** The source with the inside of strings, template text, comments and regular expressions blanked (newlines kept). Same length. */
    code: string;
    /** For each bracket ( [ { in `code`, the index of its partner, and back; -1 elsewhere. */
    pair: Int32Array;
    /** Line (1-based) of a character index. */
    lineAt(i: number): number;
}

const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "instanceof", "yield", "await"]);

/**
 * Blanks everything that is not code. Regular expressions are told from division by what came before them.
 * shortcut: JSX text (`<p>don't</p>`) is read as code and can unbalance the scan of a .jsx/.tsx file; route files are rarely JSX.
 */
export function scanJs(src: string): JsScan {
    const out = src.split("");
    const blank = (i: number) => {
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
    };
    // What a `}` closes: a block, or the `${` of a template (then the template text goes on).
    const braces: Array<"block" | "tpl"> = [];
    let lastSig = ""; // the last code token's last character, or a whole word for keywords
    let i = 0;
    const n = src.length;
    const template = (start: number): number => {
        // From just after a backtick (or the `}` of an expression), to the closing backtick or the next `${`.
        let j = start;
        while (j < n) {
            const c = src[j]!;
            if (c === "\\") {
                blank(j);
                blank(j + 1);
                j += 2;
                continue;
            }
            if (c === "`") return j + 1;
            if (c === "$" && src[j + 1] === "{") {
                blank(j);
                braces.push("tpl");
                return j + 2; // the `{` stays as code so brackets pair up
            }
            blank(j);
            j++;
        }
        return j;
    };
    while (i < n) {
        const c = src[i]!;
        const next = src[i + 1];
        if (c === "/" && next === "/") {
            while (i < n && src[i] !== "\n") blank(i++);
            continue;
        }
        if (c === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2);
            const stop = end < 0 ? n : end + 2;
            while (i < stop) blank(i++);
            continue;
        }
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < n && src[j] !== c && src[j] !== "\n") {
                if (src[j] === "\\") blank(j++);
                blank(j++);
            }
            i = j + 1;
            lastSig = "a";
            continue;
        }
        if (c === "`") {
            i = template(i + 1);
            if (src[i - 1] === "`") lastSig = "a";
            else lastSig = "{";
            continue;
        }
        if (c === "/") {
            const regexHere = lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || REGEX_AFTER_WORD.has(lastSig);
            if (regexHere) {
                let j = i + 1;
                let inClass = false;
                while (j < n && src[j] !== "\n") {
                    const d = src[j]!;
                    if (d === "\\") {
                        blank(j++);
                        blank(j++);
                        continue;
                    }
                    if (d === "[") inClass = true;
                    else if (d === "]") inClass = false;
                    else if (d === "/" && !inClass) break;
                    blank(j++);
                }
                i = j + 1;
                while (i < n && /[a-z]/i.test(src[i]!)) i++; // flags
                lastSig = "a";
                continue;
            }
        }
        if (c === "{") braces.push("block");
        if (c === "}") {
            if (braces.pop() === "tpl") {
                i = template(i + 1);
                lastSig = src[i - 1] === "`" ? "a" : "{";
                continue;
            }
        }
        if (/[A-Za-z0-9_$]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
            const word = src.slice(i, j);
            lastSig = REGEX_AFTER_WORD.has(word) ? word : "a";
            i = j;
            continue;
        }
        if (!/\s/.test(c)) lastSig = c === ")" || c === "]" ? "a" : c;
        i++;
    }
    const code = out.join("");
    const pair = new Int32Array(n).fill(-1);
    const stack: number[] = [];
    const open: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    for (let k = 0; k < n; k++) {
        const ch = code[k]!;
        if (ch === "(" || ch === "[" || ch === "{") stack.push(k);
        else if (ch === ")" || ch === "]" || ch === "}") {
            // An unbalanced file pairs what it can; a stray closer is left alone.
            if (stack.length && code[stack.at(-1)!] === open[ch]) {
                const o = stack.pop()!;
                pair[o] = k;
                pair[k] = o;
            }
        }
    }
    const starts = [0];
    for (let k = 0; k < n; k++) if (src[k] === "\n") starts.push(k + 1);
    const lineAt = (idx: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid]! <= idx) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1;
    };
    return { code, pair, lineAt };
}

/** The end (exclusive index) of an expression starting at `from`: the first `;` or `,` at its own depth, or the bracket that closes around it. */
export function expressionEnd(scan: JsScan, from: number): number {
    const { code, pair } = scan;
    for (let k = from; k < code.length; k++) {
        const ch = code[k]!;
        if ((ch === "(" || ch === "[" || ch === "{") && pair[k]! > k) k = pair[k]!;
        else if (ch === ";" || ch === "," || ch === ")" || ch === "]" || ch === "}") return k;
    }
    return code.length;
}

// ── symbols: functions, methods and classes with their line ranges ─────────────

export interface SourceSymbol {
    name: string;
    /** "constant": a top-level `const NAME = …` that is not a function (impact/routes.ts follows a changed one by its uses). */
    kind: "function" | "method" | "class" | "constant";
    /** First and last line (1-based, inclusive). */
    start: number;
    end: number;
    /** Index of the name in the source (JS/TS), so a reference scan can skip the declaration itself. */
    at?: number;
    exported?: boolean;
}

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const PY_EXT = /\.py$/i;
export const isJsLike = (path: string) => JS_EXT.test(path);

const NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "typeof", "new", "await", "super", "constructor"]);

/** The index of the `{` that opens a body after a parameter list's `)`, skipping a return type; -1 when the next thing is not a body. */
function bodyAfter(scan: JsScan, close: number): number {
    const { code, pair } = scan;
    let typed = false;
    for (let k = close + 1; k < code.length; k++) {
        const ch = code[k]!;
        if (/\s/.test(ch)) continue;
        if (ch === ":") {
            typed = true;
            continue;
        }
        if (ch === "{") {
            if (typed && pair[k]! > k) {
                // `: { a: string } {`, `: Promise<{ ok: boolean }> {` — braces with another `{` after them on the line are a return type.
                if (/^[^;{}\n]*\{/.test(code.slice(pair[k]! + 1))) {
                    k = pair[k]!;
                    continue;
                }
            }
            return k;
        }
        if (typed) {
            if ((ch === "(" || ch === "[" || ch === "<") && pair[k]! > k) k = pair[k]!;
            continue;
        }
        return -1;
    }
    return -1;
}

function jsSymbols(scan: JsScan): SourceSymbol[] {
    const { code, pair, lineAt } = scan;
    const out: SourceSymbol[] = [];
    const add = (name: string, kind: SourceSymbol["kind"], at: number, endIdx: number, declStart: number) => {
        if (endIdx < at) return;
        const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?$/.test(code.slice(Math.max(0, declStart - 30), declStart));
        out.push({ name, kind, start: lineAt(declStart), end: lineAt(endIdx), at, ...(exported ? { exported } : {}) });
    };
    // function name(...) { ... }
    for (const m of code.matchAll(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g)) {
        if (/=\s*$/.test(code.slice(Math.max(0, m.index! - 20), m.index!))) continue; // const x = function y(): known by x (below)
        const open = m.index! + m[0].length - 1;
        const body = pair[open]! > open ? bodyAfter(scan, pair[open]!) : -1;
        if (body >= 0 && pair[body]! > body) add(m[1]!, "function", m.index! + m[0].indexOf(m[1]!), pair[body]!, m.index!);
    }
    // const name = (...) => ..., const name = async x => ..., const name = function (...) { ... }
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s+)?(function\b\s*\*?\s*[\w$]*\s*\(|\(|[A-Za-z_$][\w$]*\s*=>)/g)) {
        const name = m[1]!;
        const at = m.index! + m[0].indexOf(name);
        let k = m.index! + m[0].length - 1;
        if (code[k] === ">") {
            // x => ...
            k++;
        } else {
            if (pair[k]! <= k) continue;
            if (m[2]!.startsWith("function")) {
                const body = bodyAfter(scan, pair[k]!);
                if (body >= 0 && pair[body]! > body) add(name, "function", at, pair[body]!, m.index!);
                continue;
            }
            // (...) must be followed by an optional return type and =>, or it is not a function
            const rest = code.slice(pair[k]! + 1);
            const arrow = /^\s*(?::[^=;{]*(?:\{[^}]*\})?[^=;{]*)?=>/.exec(rest);
            if (!arrow) continue;
            k = pair[k]! + 1 + arrow[0].length;
        }
        while (k < code.length && /\s/.test(code[k]!)) k++;
        if (code[k] === "{" && pair[k]! > k) add(name, "function", at, pair[k]!, m.index!);
        else add(name, "function", at, Math.max(k, expressionEnd(scan, k) - 1), m.index!);
    }
    // class Name { ... }
    for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g)) {
        const open = m.index! + m[0].length - 1;
        if (pair[open]! > open) add(m[1]!, "class", m.index! + m[0].indexOf(m[1]!), pair[open]!, m.index!);
    }
    // methods: name(...) { at the start of a line, inside a class or an object
    for (const m of code.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|get|set|readonly|override)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/gm)) {
        const name = m[1]!;
        if (NOT_METHOD.has(name)) continue;
        const open = m.index! + m[0].length - 1;
        if (pair[open]! <= open) continue;
        const body = bodyAfter(scan, pair[open]!);
        if (body < 0 || pair[body]! <= body) continue;
        const at = m.index! + m[0].lastIndexOf(name, m[0].length - 1);
        if (out.some((s) => s.at === at)) continue;
        add(name, "method", at, pair[body]!, m.index! + (m[0].length - m[0].trimStart().length));
    }
    return out;
}

function pySymbols(src: string): SourceSymbol[] {
    const lines = src.split(/\r?\n/);
    const out: SourceSymbol[] = [];
    const indent = (s: string) => s.length - s.trimStart().length;
    lines.forEach((line, i) => {
        const m = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(line);
        if (!m) return;
        const own = m[1]!.length;
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j]!;
            if (!l.trim() || l.trimStart().startsWith("#")) continue;
            if (indent(l) <= own) break;
            end = j;
        }
        out.push({ name: m[3]!, kind: m[2] === "class" ? "class" : own > 0 ? "method" : "function", start: i + 1, end: end + 1 });
    });
    return out;
}

/** Functions, methods and classes of a JS/TS or Python file, with their line ranges; [] for other languages. */
export function symbolsOf(path: string, source: string, scan?: JsScan): SourceSymbol[] {
    if (PY_EXT.test(path)) return pySymbols(source);
    if (JS_EXT.test(path)) return jsSymbols(scan ?? scanJs(source));
    return [];
}

/** The smallest symbol around a line (ties: the one that starts last). */
export function innermost<T extends { start: number; end: number }>(items: T[], line: number): T | undefined {
    let best: T | undefined;
    for (const s of items) if (s.start <= line && line <= s.end && (!best || s.end - s.start < best.end - best.start || (s.end - s.start === best.end - best.start && s.start > best.start))) best = s;
    return best;
}

// ── one changed file ──────────────────────────────────────────────────────────

export interface FileChangeInput {
    path: string;
    previousPath?: string;
    status?: string;
    /** The unified patch; absent for binary or very large files. */
    patch?: string;
}

export interface ChangedFunction {
    name: string;
    /** "enclosing": the new source shows the changed line inside it. "hunk-header": only git's hunk header names it. */
    evidence: "enclosing" | "hunk-header";
    /** New-side lines of the change inside it (for "enclosing"); the hunk's first new line (for "hunk-header"). */
    lines: number[];
    start?: number;
    end?: number;
}

export interface FileChange extends PatchLines {
    path: string;
    previousPath?: string;
    status?: string;
    /** New-side lines touched: added lines and the places of removals, sorted. */
    touched: number[];
    functions: ChangedFunction[];
    /** Why nothing could be read from this file, when that is so. */
    note?: string;
}

const HEADER_NAME = [/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, /\bclass\s+([A-Za-z_$][\w$]*)/, /\bdef\s+([A-Za-z_]\w*)/, /^\s*(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\(/];

/** The function name in a hunk header, if it names one. */
export function headerFunction(header: string): string | undefined {
    for (const re of HEADER_NAME) {
        const m = re.exec(header);
        if (m && !NOT_METHOD.has(m[1]!)) return m[1];
    }
    return undefined;
}

/** A changed file's lines and functions. `source` is the file's new content when the checkout is at hand. */
export function analyzeFile(input: FileChangeInput, source?: string): FileChange {
    const lines = input.patch ? parsePatch(input.patch) : { hunks: [], added: [], removed: [], removedAt: [] };
    const touched = [...new Set([...lines.added, ...lines.removedAt])].sort((a, b) => a - b);
    const base: FileChange = { path: input.path, ...(input.previousPath ? { previousPath: input.previousPath } : {}), ...(input.status ? { status: input.status } : {}), ...lines, touched, functions: [] };
    if (!input.patch) return { ...base, note: "No patch (a binary file, or too large for GitHub to show): the lines changed are not known." };
    if (source !== undefined && input.status !== "removed") {
        const symbols = symbolsOf(input.path, source);
        if (symbols.length || isJsLike(input.path) || PY_EXT.test(input.path)) {
            const byKey = new Map<string, ChangedFunction>();
            for (const line of touched) {
                const s = innermost(symbols, line);
                if (!s) continue;
                const key = `${s.name}:${s.start}`;
                const f = byKey.get(key) ?? { name: s.name, evidence: "enclosing" as const, lines: [], start: s.start, end: s.end };
                f.lines.push(line);
                byKey.set(key, f);
            }
            return { ...base, functions: [...byKey.values()] };
        }
    }
    const seen = new Set<string>();
    const functions: ChangedFunction[] = [];
    for (const h of lines.hunks) {
        const name = headerFunction(h.header);
        if (name && !seen.has(name)) {
            seen.add(name);
            functions.push({ name, evidence: "hunk-header", lines: [h.newStart] });
        }
    }
    return { ...base, functions };
}
