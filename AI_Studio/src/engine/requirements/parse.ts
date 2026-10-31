/**
 * Requirements text → atomic, identified requirements.
 *
 * Two passes:
 *  1. Deterministic (always): line-oriented structure recovery — headings/sections, numbered and
 *     bulleted items, ids already in the document (REQ-1, FR-2.3, US-12, "1.2", table rows),
 *     "As a … I want …" user stories and "shall/must/should" sentences in prose.
 *  2. LLM (only when a model is configured): normalise/split the candidates into atomic,
 *     testable requirements and drop non-requirements. If no model is configured
 *     (LlmNotConfiguredError) — or the call fails — the deterministic result is returned.
 *
 * Reuse: ai-testing-agent (MIT, Copyright (c) 2026 dannicolau7) `parse_requirements` sends the whole
 * document to the model with "extract features, user stories, acceptance criteria, edge cases,
 * priorities" and keeps the free-form JSON. Ported from it: the extraction categories (user
 * stories / acceptance criteria / edge cases are requirements to test) and its
 * `example_requirements.txt` layout ("2.1 Section" headings with "-" bullets and "*" sub-bullets)
 * as a format the deterministic pass must handle. New here: the deterministic pre-pass, id
 * preservation, a zod-validated output, bounded LLM input and the no-LLM fallback.
 */
import { z } from "zod";
import type { EngineContext } from "../context.js";
import { LlmNotConfiguredError } from "../llm/provider.js";

export const REQUIREMENT_KINDS = ["functional", "validation", "security", "non-functional", "other"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const RequirementSchema = z.object({
    id: z.string(),
    text: z.string(),
    section: z.string().optional(),
    kind: z.enum(REQUIREMENT_KINDS),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/** Raw document text sent to the model alongside the candidates; above this only candidates are sent. */
export const LLM_TEXT_BUDGET = 40_000;
/** Candidates per normalisation call (keeps output well inside the token limit). */
export const LLM_CANDIDATES_PER_CALL = 150;
/** At most this many normalisation calls per document; the remainder stays deterministic. */
export const LLM_MAX_CALLS = 8;

// ── Deterministic pass ──────────────────────────────────────────────────────

/** Ids authors put on requirements: REQ-1, FR-2.3, NFR_04, US-12, REQ-AUTH-3, FR1, UC2.1. */
const ID_CORE = String.raw`(?:[A-Za-z]{1,10}(?:[-_][A-Za-z]{1,10})*[-_]\d+(?:\.\d+)*[a-z]?|[A-Z]{1,8}\d+(?:\.\d+)*[a-z]?)`;
const ID_PREFIX = new RegExp(String.raw`^[\[(]?(?:\*\*|__)?(${ID_CORE})(?:\*\*|__)?[\])]?\s*(?:[:.)\-–—|]\s*|\s+)(.*)$`);
const ID_FULL = new RegExp(String.raw`^(?:\*\*|__)?(${ID_CORE})(?:\*\*|__)?$`);
const MULTI_NUM = /^(\d+(?:\.\d+)+)\.?\s+(.+)$/;
const SINGLE_NUM = /^(\d+)[.)]\s+(.+)$/;
const BULLET = /^(\s*)([-*•+▪◦‣·○■□►–]|\d+[.)]|[a-zA-Z][.)]|\(\w{1,4}\))\s+(.*)$/;
const MODAL = /\b(shall|must|should|is required to|are required to|needs? to|has to|have to|will be able to|is able to|are able to|can)\b/i;
const STRONG_MODAL = /\b(shall|must|should|is required to|are required to|needs? to|has to|have to|will be able to)\b/i;
const USER_STORY = /\bAs an?\s+[^,.;]{2,80},?\s+I\s+(?:want|need|can|would like|should be able)\b/i;
const METADATA = /^(version|date|author|owner|status|project|document|revision|last updated|prepared by|approved by|reviewed by)\s*:/i;
/** Sections whose items are not requirements. */
const SKIP_SECTION = /\b(glossary|definitions?|abbreviations|acronyms|references|revision history|change ?log|table of contents|contents|document control|out of scope|non-goals)\b/i;

interface Candidate {
    id?: string;
    /** document: id written by the author; weak: single-level list number (kept only if unique). */
    idOrigin: "document" | "weak" | "none";
    text: string;
    section?: string;
    sectionPath: string[];
    indent: number;
    isListItem: boolean;
    parent?: Candidate;
    /** Requirement that only introduces sub-items ("Password must contain:") — replaced by them. */
    leadIn?: boolean;
    /** Heading that carries an id ("## FR-1 Login"): following prose is its description. */
    container?: boolean;
    children: Candidate[];
    dropped?: boolean;
}

function cleanInline(s: string): string {
    return s
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/^\[[ xX]\]\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
}

function indentOf(line: string): number {
    const m = /^[ \t]*/.exec(line)![0];
    return m.replace(/\t/g, "    ").length;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const isAllCaps = (s: string) => /[A-Z]{2,}/.test(s) && !/[a-z]/.test(s);

/** Classify by keywords; section names (e.g. "3.2 Performance") take precedence over the text. */
export function classifyRequirement(text: string, sectionPath: string[] = []): RequirementKind {
    const section = sectionPath.join(" ");
    if (/\bsecurity\b/i.test(section)) return "security";
    if (/non[- ]?functional|performance|reliability|availability|scalability|usability|accessibility|compatibility/i.test(section)) {
        return "non-functional";
    }
    if (/\b(valid(ate|ation|ated)?|invalid|required fields?|mandatory|format|minimum|maximum|at least|at most|no more than|characters?|unique|empty|blank|must match|digits?|length)\b/i.test(text)) {
        return "validation";
    }
    if (/\b(secur\w*|csrf|xss|injection|encrypt\w*|hash\w*|https|tls|ssl|rate[- ]limit\w*|brute[- ]force|permissions?|unauthori[sz]ed|access control|privileges?|lock(ed)? out|account is locked|2fa|mfa|two-factor|sanitis\w*|sanitiz\w*)\b/i.test(text)) {
        return "security";
    }
    if (/\b(performance|within \d+(\.\d+)?\s*(ms|milliseconds?|s|seconds?|minutes?)|uptime|concurrent|scal\w+|latency|response time|throughput|availability|\d+(\.\d+)?\s*%|wcag|accessib\w+|screen reader|browsers?|responsive|mobile devices?)\b/i.test(text)) {
        return "non-functional";
    }
    if (MODAL.test(text) || USER_STORY.test(text) || /\b(users?|system|application|admin\w*|customers?|page|button|form)\b/i.test(text)) {
        return "functional";
    }
    return "other";
}

function splitSentences(paragraph: string): string[] {
    return paragraph
        .split(/(?<=[.!?])\s+(?=["'(]?[A-Z0-9])/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function isRequirementSentence(s: string): boolean {
    return STRONG_MODAL.test(s) || USER_STORY.test(s);
}

interface Heading {
    level: number;
    title: string;
    id?: string;
}

/** Heading detection: markdown, setext (underlined), numbered ("2.1 User Registration"), ALL CAPS, bold-only lines. */
function headingAt(lines: string[], i: number): Heading | "underline" | null {
    const raw = lines[i]!;
    const line = raw.trim();
    if (/^(=+|-+|~+)$/.test(line) && line.length >= 3) return "underline";
    const md = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (md) return { level: md[1]!.length, title: cleanInline(md[2]!) };
    if (indentOf(raw) > 0 || BULLET.test(raw) && !SINGLE_NUM.test(line)) {
        // Indented lines and non-numeric bullets are never headings.
        return null;
    }
    const next = lines[i + 1]?.trim() ?? "";
    if (/^(=+|-+|~+)$/.test(next) && next.length >= 3 && line && !BULLET.test(raw)) {
        return { level: next.startsWith("=") ? 1 : 2, title: cleanInline(line) };
    }
    const bold = /^(?:\*\*|__)([^*_]{2,80})(?:\*\*|__):?$/.exec(line);
    if (bold && wordCount(bold[1]!) <= 8 && !STRONG_MODAL.test(bold[1]!)) return { level: 4, title: bold[1]!.trim() };

    const titleLike = (t: string) => wordCount(t) <= 8 && !MODAL.test(t) && !USER_STORY.test(t) && !/[.!?:;,]$/.test(t);
    const multi = MULTI_NUM.exec(line);
    if (multi && titleLike(multi[2]!)) return { level: multi[1]!.split(".").length, title: cleanInline(line) };
    const single = SINGLE_NUM.exec(line);
    if (single && titleLike(single[2]!)) {
        // "1. Login" followed directly by "2. …" is a list, not a heading.
        const nextIsSibling = SINGLE_NUM.test(next);
        if (isAllCaps(single[2]!) || (!nextIsSibling && wordCount(single[2]!) <= 6)) return { level: 1, title: cleanInline(line) };
    }
    if (!single && !multi && isAllCaps(line) && wordCount(line) <= 8 && !/^[A-Z]+\s+\/\S*/.test(line)) {
        return { level: 1, title: cleanInline(line) };
    }
    return null;
}

/** Table rows ("| REQ-1 | text | High |" or mammoth's "REQ-1 | text"). */
function tableCandidate(line: string): { id?: string; idOrigin: Candidate["idOrigin"]; text: string } | "skip" | null {
    if (!line.includes("|")) return null;
    const cells = line.split("|").map((c) => cleanInline(c)).filter(Boolean);
    if (cells.length < 2) return null;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return "skip";
    const idx = cells.findIndex((c) => ID_FULL.test(c) || /^\d+(\.\d+)*$/.test(c));
    const others = cells.filter((_, k) => k !== idx);
    const text = others.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (idx >= 0 && wordCount(text) >= 2) {
        const id = cells[idx]!;
        const origin = /^\d+$/.test(id) ? "weak" : "document";
        return { id, idOrigin: origin, text };
    }
    if (isRequirementSentence(text)) return { idOrigin: "none", text };
    return "skip";
}

function keepable(text: string): boolean {
    return text.length >= 8 && wordCount(text) >= 2 && !METADATA.test(text);
}

/**
 * Deterministic pre-pass. Exported for tests and for callers that must not use a model.
 */
export function parseRequirementsDeterministic(text: string): Requirement[] {
    return deterministicPass(text).requirements;
}

function deterministicPass(text: string): { requirements: Requirement[]; documentIds: Set<string> } {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const candidates: Candidate[] = [];
    const headings: Heading[] = [];
    let listStack: Candidate[] = [];
    let lastItem: Candidate | null = null;
    let container: Candidate | null = null;
    let containerHasBody = false;
    let para: string[] = [];
    let inFence = false;

    const sectionPath = () => headings.map((h) => h.title);
    const skipping = () => headings.some((h) => SKIP_SECTION.test(h.title));
    const add = (c: Omit<Candidate, "sectionPath" | "section" | "children">): Candidate => {
        const path = sectionPath();
        const cand: Candidate = { ...c, sectionPath: path, section: path[path.length - 1], children: [] };
        if (!skipping()) candidates.push(cand);
        return cand;
    };
    const flushPara = () => {
        if (!para.length) return;
        const p = cleanInline(para.join(" "));
        para = [];
        if (container && !containerHasBody) {
            // Prose directly under "## FR-1 Login" describes FR-1.
            container.text = `${container.text}: ${p}`.replace(/:\s*:/, ":");
            containerHasBody = true;
            return;
        }
        for (const s of splitSentences(p)) {
            if (isRequirementSentence(s) && keepable(s)) add({ idOrigin: "none", text: s, indent: 0, isListItem: false });
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]!;
        const line = raw.trim();
        if (/^(```|~~~)/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (!line) {
            flushPara();
            lastItem = null;
            continue;
        }

        const heading = headingAt(lines, i);
        if (heading === "underline") continue;
        if (heading) {
            flushPara();
            lastItem = null;
            listStack = [];
            while (headings.length && headings[headings.length - 1]!.level >= heading.level) headings.pop();
            // A heading that carries an author id is itself a requirement ("## FR-1: User login").
            const idm = ID_PREFIX.exec(heading.title);
            if (idm && wordCount(idm[2]!) >= 1 && idm[2]!.trim()) {
                headings.push({ ...heading, id: idm[1] });
                container = add({ id: idm[1], idOrigin: "document", text: cleanInline(idm[2]!), indent: 0, isListItem: false, container: true });
                containerHasBody = false;
            } else {
                headings.push(heading);
                container = null;
            }
            continue;
        }

        const table = tableCandidate(line);
        if (table) {
            flushPara();
            lastItem = null;
            if (table !== "skip" && keepable(table.text)) add({ id: table.id, idOrigin: table.idOrigin, text: table.text, indent: 0, isListItem: false });
            continue;
        }

        const bullet = BULLET.exec(raw);
        if (bullet) {
            flushPara();
            const indent = indentOf(raw);
            let content = cleanInline(bullet[3]!);
            let id: string | undefined;
            let idOrigin: Candidate["idOrigin"] = "none";
            const idm = ID_PREFIX.exec(content);
            const multi = MULTI_NUM.exec(content);
            if (idm && idm[2]!.trim()) {
                id = idm[1];
                idOrigin = "document";
                content = cleanInline(idm[2]!);
            } else if (multi) {
                id = multi[1];
                idOrigin = "document";
                content = multi[2]!;
            } else if (/^\d+[.)]$/.test(bullet[2]!)) {
                id = bullet[2]!.replace(/[.)]$/, "");
                idOrigin = "weak";
            }
            while (listStack.length && listStack[listStack.length - 1]!.indent >= indent) listStack.pop();
            const parent: Candidate | undefined = listStack[listStack.length - 1] ?? container ?? undefined;
            if (parent?.isListItem && /:$/.test(parent.text)) {
                // "Password must meet: / * Minimum 8 characters" → "Password must meet: Minimum 8 characters".
                parent.leadIn = true;
                content = `${parent.text} ${content}`;
            }
            const cand = add({ id, idOrigin, text: content, indent, isListItem: true, parent });
            parent?.children.push(cand);
            listStack.push(cand);
            lastItem = cand;
            continue;
        }

        // Continuation of a wrapped list item / id line (indented deeper, or starting lower-case).
        if (lastItem && (indentOf(raw) > lastItem.indent || /^[a-z(]/.test(line) || !lastItem.text)) {
            lastItem.text = cleanInline(`${lastItem.text} ${line}`);
            continue;
        }

        const idm = ID_PREFIX.exec(line);
        const multi = MULTI_NUM.exec(line);
        if ((idm && (idm[2]!.trim() || /^\S+$/.test(line))) || multi) {
            flushPara();
            const cand = idm
                ? add({ id: idm[1], idOrigin: "document", text: cleanInline(idm[2] ?? ""), indent: indentOf(raw), isListItem: false })
                : add({ id: multi![1], idOrigin: "document", text: cleanInline(multi![2]!), indent: indentOf(raw), isListItem: false });
            lastItem = cand;
            listStack = [];
            continue;
        }

        lastItem = null;
        para.push(line);
    }
    flushPara();

    return finalise(candidates);
}

function normKey(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function finalise(all: Candidate[]): { requirements: Requirement[]; documentIds: Set<string> } {
    for (const c of all) {
        if (c.leadIn && c.idOrigin !== "document") c.dropped = true;
        if (!keepable(c.text) && !(c.idOrigin === "document" && c.text)) c.dropped = true;
    }
    let live = all.filter((c) => !c.dropped);

    // Single-level list numbers are ids only when they number the whole document (no restarts).
    const docIds = new Set(live.filter((c) => c.idOrigin === "document").map((c) => c.id!));
    const weak = live.filter((c) => c.idOrigin === "weak");
    const weakUnique = new Set(weak.map((c) => c.id)).size === weak.length && weak.every((c) => !docIds.has(c.id!));
    for (const c of weak) {
        if (weakUnique) c.idOrigin = "document";
        else {
            c.id = undefined;
            c.idOrigin = "none";
        }
    }

    // Duplicate texts (same bullet repeated in two sections) collapse; author-identified items always stay.
    const seenText = new Set<string>();
    live = live.filter((c) => {
        const key = normKey(c.text);
        if (seenText.has(key) && c.idOrigin !== "document") return false;
        seenText.add(key);
        return true;
    });

    const used = new Set<string>();
    const documentIds = new Set<string>();
    for (const c of live) {
        if (c.idOrigin !== "document" || !c.id) continue;
        let id = c.id;
        for (let n = 2; used.has(id); n++) id = `${c.id}#${n}`;
        c.id = id;
        used.add(id);
        documentIds.add(id);
    }
    // Children of an identified parent get derived ids (FR-1 → FR-1.1, FR-1.2) for traceability.
    for (const c of live) {
        if (c.id) continue;
        const p = c.parent;
        if (p?.id && p.idOrigin === "document") {
            const id = `${p.id}.${p.children.indexOf(c) + 1}`;
            if (!used.has(id)) {
                c.id = id;
                used.add(id);
            }
        }
    }
    let seq = 0;
    const nextId = () => {
        let id: string;
        do id = `R-${String(++seq).padStart(3, "0")}`;
        while (used.has(id));
        used.add(id);
        return id;
    };
    const requirements = live.map((c): Requirement => {
        const text = c.text.replace(/\s+/g, " ").trim();
        const r: Requirement = { id: c.id ?? nextId(), text, kind: classifyRequirement(text, c.sectionPath) };
        if (c.section) r.section = c.section;
        return r;
    });
    return { requirements, documentIds };
}

// ── LLM normalisation ───────────────────────────────────────────────────────

const NormalisedSchema = z.object({
    requirements: z.array(
        z.object({
            id: z.string().describe('Existing id, a split suffix ("FR-2.a"), or "" for a requirement the pre-pass missed'),
            text: z.string(),
            section: z.string().optional(),
            kind: z.enum(REQUIREMENT_KINDS),
        }),
    ),
});

const SYSTEM = `You normalise software requirements extracted from a requirements document into atomic, testable requirements.
You receive candidate requirements found by a deterministic parser (format: [id] (section) text) and, when it fits, the document text.
Rules:
- Each output requirement states exactly ONE testable behaviour or constraint. Split compound candidates
  ("users can add and remove items", "email and password are required") into separate requirements.
- Keep the given ids. When you split a candidate, suffix its id: FR-2 → FR-2.a, FR-2.b. Never renumber.
- If the document text contains a requirement the candidates missed, add it: use the id the document gives it, otherwise id "".
- Drop candidates that are not requirements: headings, metadata, glossary entries, notes, out-of-scope items, pure descriptions.
- Never invent requirements, numbers or limits that the document does not state. Keep the author's wording; make each
  requirement self-contained (resolve "it"/"this field" from context, e.g. prefix the field or feature name).
- kind: functional (behaviour/feature), validation (input rules, required fields, formats, limits),
  security (authn/authz, protection, secrets, rate limiting), non-functional (performance, availability, accessibility,
  compatibility), other.
- section: the heading the requirement belongs to, if any.`;

function formatCandidates(reqs: Requirement[]): string {
    return reqs.map((r) => `[${r.id}]${r.section ? ` (${r.section})` : ""} ${r.text}`).join("\n");
}

/**
 * Extract requirements from document text. Always runs the deterministic pass; refines it with
 * the model when one is configured. Never throws for a missing/failed model.
 */
export async function parseRequirements(ctx: EngineContext, text: string): Promise<Requirement[]> {
    const det = deterministicPass(text);
    if (!text.trim()) return [];

    const batches: Requirement[][] = [];
    for (let i = 0; i < det.requirements.length; i += LLM_CANDIDATES_PER_CALL) {
        batches.push(det.requirements.slice(i, i + LLM_CANDIDATES_PER_CALL));
    }
    // Prose-only documents yield no candidates; the model then reads the text itself (if it fits).
    if (!batches.length) {
        if (text.length > LLM_TEXT_BUDGET) return [];
        batches.push([]);
    }
    const includeText = batches.length === 1 && text.length <= LLM_TEXT_BUDGET;

    const normalised: Array<{ id: string; text: string; section?: string; kind: RequirementKind }> = [];
    const leftover: Requirement[] = [];
    try {
        for (let b = 0; b < batches.length; b++) {
            if (ctx.signal?.aborted) throw new Error("Job cancelled");
            if (b >= LLM_MAX_CALLS) {
                leftover.push(...batches[b]!);
                continue;
            }
            const out = await ctx.llm.object({
                system: SYSTEM,
                schema: NormalisedSchema,
                maxOutputTokens: 16_000,
                purpose: "planning",
                prompt: `Candidate requirements${batches.length > 1 ? ` (part ${b + 1} of ${batches.length})` : ""}:
${batches[b]!.length ? formatCandidates(batches[b]!) : "(none found by the parser)"}
${includeText ? `\nDocument text:\n"""\n${text}\n"""` : ""}`,
            });
            normalised.push(...out.requirements);
        }
    } catch (e) {
        if (ctx.signal?.aborted) throw e;
        const unavailable = e instanceof LlmNotConfiguredError;
        ctx.emit({
            stage: "planning",
            kind: "requirements_parsed",
            level: unavailable ? "info" : "warn",
            message: unavailable
                ? `Requirements: ${det.requirements.length} extracted (rule-based; no LLM configured)`
                : `Requirements: LLM normalisation failed (${e instanceof Error ? e.message : String(e)}); using ${det.requirements.length} rule-based requirements`,
        });
        return det.requirements;
    }

    const result = mergeNormalised(text, det, normalised, leftover);
    ctx.emit({
        stage: "planning",
        kind: "requirements_parsed",
        message: `Requirements: ${result.length} extracted (${det.requirements.length} rule-based candidates normalised by LLM)`,
    });
    return result;
}

/** Validate model output: unique ids, no invented ids, author-identified requirements never silently dropped. */
function mergeNormalised(
    source: string,
    det: { requirements: Requirement[]; documentIds: Set<string> },
    normalised: Array<{ id: string; text: string; section?: string; kind: RequirementKind }>,
    leftover: Requirement[],
): Requirement[] {
    // The model saw nothing useful — trust the parser rather than returning an empty list.
    if (!normalised.length && det.requirements.length) return det.requirements;

    const known = new Set(det.requirements.map((r) => r.id));
    const legitimate = (id: string) =>
        known.has(id) || [...known].some((k) => id.startsWith(`${k}.`)) || (!/^R-\d+$/.test(id) && source.includes(id));

    const used = new Set<string>();
    const out: Requirement[] = [];
    const pending: Requirement[] = [];
    for (const n of normalised) {
        const text = n.text.replace(/\s+/g, " ").trim();
        if (!text) continue;
        let id = n.id.trim().slice(0, 40);
        const r: Requirement = { id: "", text, kind: n.kind };
        if (n.section?.trim()) r.section = n.section.trim();
        if (id && legitimate(id)) {
            for (let k = 2; used.has(id); k++) id = `${n.id.trim()}#${k}`;
            r.id = id;
            used.add(id);
        } else {
            pending.push(r);
        }
        out.push(r);
    }
    for (const d of det.requirements) {
        if (!det.documentIds.has(d.id)) continue;
        if ([...used].some((u) => u === d.id || u.startsWith(`${d.id}.`))) continue;
        out.push(d);
        used.add(d.id);
    }
    for (const l of leftover) {
        if (used.has(l.id)) continue;
        out.push(l);
        used.add(l.id);
    }
    let seq = 0;
    for (const r of pending) {
        let id: string;
        do id = `R-${String(++seq).padStart(3, "0")}`;
        while (used.has(id) || known.has(id));
        r.id = id;
        used.add(id);
    }
    return out;
}
