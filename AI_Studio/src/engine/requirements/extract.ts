/**
 * Requirements document → plain text.
 *
 * Supported: .txt / .md (UTF-8, UTF-16 with BOM), .docx (mammoth), .pdf (unpdf / PDF.js).
 * ai-testing-agent (MIT, Copyright (c) 2026 dannicolau7) advertises the same four formats for its
 * `cli.py` requirements argument, but its `read_requirements_file` only reads UTF-8 text; the
 * binary-format extraction here is new.
 *
 * The output keeps line structure (headings, list items one per line) because the deterministic
 * requirement parser (./parse.ts) works line by line.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/** Upper bound on the uploaded file. Word/PDF files carry images, so this is larger than the text bound. */
export const REQUIREMENTS_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Upper bound on extracted text (~50 pages of dense prose). Larger documents should be split. */
export const REQUIREMENTS_MAX_CHARS = 200_000;

export const REQUIREMENTS_EXTENSIONS = [".txt", ".md", ".markdown", ".pdf", ".docx"] as const;

/**
 * What a .docx may unpack to. A Word file is a zip, and a zip of a few kilobytes can unpack to gigabytes: every part is unpacked here,
 * up to these limits, before anything else reads the file, so the reader that follows never meets more than this.
 */
export const DOCX_LIMITS = { maxEntries: 1000, maxDocumentBytes: 20 * 1024 * 1024, maxPartBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 };
/** The separate process that reads a .docx or .pdf: its memory, and how long it may take. */
export const PARSE_LIMITS = { memoryMb: 512, timeoutMs: 30_000 };

export class RequirementsDocumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RequirementsDocumentError";
    }
}

function extensionOf(name: string): string {
    const m = /\.[A-Za-z0-9]+$/.exec(name.trim());
    return m ? m[0].toLowerCase() : "";
}

export async function extractDocumentText(file: { name: string; data: Buffer }): Promise<string> {
    const ext = extensionOf(file.name);
    if (!(REQUIREMENTS_EXTENSIONS as readonly string[]).includes(ext)) {
        const hint = ext === ".doc" ? " Legacy .doc is not supported — save it as .docx." : "";
        throw new RequirementsDocumentError(
            `Unsupported requirements file "${file.name}". Supported types: ${REQUIREMENTS_EXTENSIONS.join(", ")}.${hint}`,
        );
    }
    if (file.data.length === 0) throw new RequirementsDocumentError(`Requirements file "${file.name}" is empty.`);
    if (file.data.length > REQUIREMENTS_MAX_FILE_BYTES) {
        throw new RequirementsDocumentError(
            `Requirements file "${file.name}" is ${(file.data.length / 1024 / 1024).toFixed(1)} MB; the limit is ${REQUIREMENTS_MAX_FILE_BYTES / 1024 / 1024} MB.`,
        );
    }

    let text: string;
    if (ext === ".pdf") text = await pdfText(file);
    else if (ext === ".docx") text = await docxText(file);
    else text = decodeText(file);

    text = normalise(text);
    if (!text.trim()) {
        throw new RequirementsDocumentError(
            ext === ".pdf"
                ? `No extractable text in "${file.name}" (scanned/image-only PDFs are not supported — OCR it first).`
                : `No text found in "${file.name}".`,
        );
    }
    if (text.length > REQUIREMENTS_MAX_CHARS) {
        throw new RequirementsDocumentError(
            `"${file.name}" contains ${text.length.toLocaleString("en-US")} characters of text; the limit is ${REQUIREMENTS_MAX_CHARS.toLocaleString("en-US")}. Upload only the relevant sections.`,
        );
    }
    return text;
}

function decodeText(file: { name: string; data: Buffer }): string {
    const d = file.data;
    // Windows editors (Notepad "Unicode") save UTF-16 with a BOM.
    if (d.length >= 2 && d[0] === 0xff && d[1] === 0xfe) return new TextDecoder("utf-16le").decode(d.subarray(2));
    if (d.length >= 2 && d[0] === 0xfe && d[1] === 0xff) return new TextDecoder("utf-16be").decode(d.subarray(2));
    // NUL bytes mean a binary file renamed to .txt/.md (or BOM-less UTF-16) — refuse instead of feeding garbage on.
    if (d.subarray(0, 8192).includes(0)) {
        throw new RequirementsDocumentError(`"${file.name}" does not look like a text file (binary content). Save it as UTF-8 text.`);
    }
    // Non-fatal decoding: a stray Latin-1 byte becomes U+FFFD rather than failing the job.
    return new TextDecoder("utf-8").decode(d).replace(/^﻿/, "");
}

const CHILD = fileURLToPath(new URL("./extract-child.mjs", import.meta.url));

/** Run the reader in its own process with a memory limit and a timeout: whatever the file does, the server goes on. */
function inChild(kind: "docx" | "pdf", data: Buffer, name: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const tooMuch = () => new RequirementsDocumentError(`"${name}" could not be read: it needs more memory or time than a requirements document should. Save it again, or paste the text.`);
        let settled = false;
        const child = fork(CHILD, [], { execArgv: [`--max-old-space-size=${PARSE_LIMITS.memoryMb}`], serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
        const done = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null) child.kill("SIGKILL");
            fn();
        };
        const timer = setTimeout(() => done(() => reject(tooMuch())), PARSE_LIMITS.timeoutMs);
        child.once("message", (m: { ok: boolean; value?: string; message?: string }) => done(() => (m.ok ? resolve(String(m.value ?? "")) : reject(new Error(String(m.message ?? "unreadable"))))));
        child.once("error", (e) => done(() => reject(e)));
        child.once("exit", () => done(() => reject(tooMuch())));
        child.send({ kind, data: new Uint8Array(data) });
    });
}

/**
 * Unpack every part of a .docx up to DOCX_LIMITS, from the zip's own directory, before any reader sees it. The sizes the zip claims are
 * not trusted: each part is really unpacked, with a cap on the output, so a part that claims 1 KB and unpacks to 1 GB is caught at the cap.
 */
export function checkDocxSize(data: Buffer, name: string, limits = DOCX_LIMITS): void {
    const bad = (why: string) => new RequirementsDocumentError(`"${name}" cannot be read: ${why} Save it again from Word, or paste the text.`);
    const tooBig = bad(`it unpacks to more than a requirements document should (at most ${limits.maxDocumentBytes / 1024 / 1024} MB of text).`);
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65_535); i--) {
        if (data.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw bad("it is not a complete Word file.");
    const count = data.readUInt16LE(eocd + 10);
    const cdOffset = data.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw bad("it is a kind of zip Word does not write (zip64).");
    if (count > limits.maxEntries) throw bad(`it has more than ${limits.maxEntries} parts.`);
    let at = cdOffset;
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) throw bad("its table of contents is damaged.");
        const method = data.readUInt16LE(at + 10);
        const compressed = data.readUInt32LE(at + 20);
        const nameLen = data.readUInt16LE(at + 28);
        const extraLen = data.readUInt16LE(at + 30);
        const commentLen = data.readUInt16LE(at + 32);
        const local = data.readUInt32LE(at + 42);
        const part = data.subarray(at + 46, at + 46 + nameLen).toString("utf8");
        at += 46 + nameLen + extraLen + commentLen;
        if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw bad("its table of contents is damaged.");
        const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
        const raw = data.subarray(start, start + compressed);
        const cap = Math.min(part === "word/document.xml" ? limits.maxDocumentBytes : limits.maxPartBytes, limits.maxTotalBytes - total);
        let size: number;
        if (method === 0) size = raw.length;
        else if (method === 8) {
            try {
                size = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, cap + 1) }).length;
            } catch (e) {
                if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw tooBig;
                throw bad("one of its parts is damaged.");
            }
        } else throw bad("it uses a kind of compression Word does not write.");
        if (size > cap) throw tooBig;
        total += size;
    }
}

async function pdfText(file: { name: string; data: Buffer }): Promise<string> {
    if (file.data.subarray(0, 1024).indexOf("%PDF-") === -1) {
        throw new RequirementsDocumentError(`"${file.name}" is not a valid PDF file.`);
    }
    try {
        return await inChild("pdf", file.data, file.name);
    } catch (e) {
        if (e instanceof RequirementsDocumentError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        throw new RequirementsDocumentError(
            /password/i.test(msg) ? `"${file.name}" is password-protected.` : `Could not read PDF "${file.name}": ${msg}`,
        );
    }
}

async function docxText(file: { name: string; data: Buffer }): Promise<string> {
    // .docx is a zip container ("PK\x03\x04").
    if (!(file.data[0] === 0x50 && file.data[1] === 0x4b)) {
        throw new RequirementsDocumentError(`"${file.name}" is not a valid .docx file.`);
    }
    checkDocxSize(file.data, file.name);
    try {
        // HTML rather than extractRawText: raw text drops list structure, which the parser relies on.
        return htmlToText(await inChild("docx", file.data, file.name));
    } catch (e) {
        if (e instanceof RequirementsDocumentError) throw e;
        throw new RequirementsDocumentError(`Could not read Word document "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
    }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/**
 * Mammoth's HTML → line-oriented text: headings become "# …", list items "- …" (indented by
 * nesting), table cells are joined with " | ". Word auto-numbering is not exposed by mammoth, so
 * numbers typed into the text survive but list numbers generated by Word do not.
 */
export function htmlToText(html: string): string {
    const lines: string[] = [];
    let line = "";
    let markerOnly = false;
    let listDepth = 0;
    let cellIndex = 0;
    const breakLine = () => {
        if (line.trim() && !markerOnly) lines.push(line.trimEnd());
        if (!markerOnly) line = "";
    };
    for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/gi)) {
        if (m[3] !== undefined) {
            const t = decodeEntities(m[3]).replace(/\s+/g, " ");
            if (!t.trim() && !line.trim()) continue;
            line += t;
            if (t.trim()) markerOnly = false;
            continue;
        }
        const closing = m[1] === "/";
        const tag = m[2]!.toLowerCase();
        if (tag === "ul" || tag === "ol") {
            breakLine();
            listDepth = Math.max(0, listDepth + (closing ? -1 : 1));
        } else if (tag === "li") {
            // An item that never received text leaves only its marker behind: discard it.
            if (markerOnly) line = "";
            markerOnly = false;
            breakLine();
            if (!closing) {
                line = `${"  ".repeat(Math.max(0, listDepth - 1))}- `;
                markerOnly = true;
            }
        } else if (/^h[1-6]$/.test(tag)) {
            breakLine();
            if (!closing) line = `${"#".repeat(Number(tag[1]))} `;
        } else if (tag === "p" || tag === "br" || tag === "div") {
            breakLine();
        } else if (tag === "tr") {
            breakLine();
            cellIndex = 0;
        } else if ((tag === "td" || tag === "th") && !closing) {
            if (cellIndex++ > 0) line += " | ";
        }
    }
    markerOnly = false;
    breakLine();
    return lines.join("\n");
}

function normalise(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[\u2028\u2029]/g, "\n")
        // Control characters other than tab/newline (PDF extraction leaves some behind).
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
