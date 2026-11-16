/**
 * Answer keys for the understanding benchmark: per benchmark app, what a correct application model contains (screens, workflows,
 * entities, endpoints, roles) and the rule each seeded defect violates, with the requirements-document line that states it. Written from
 * the apps' intended behaviour, read only by the scorer, never served by an app or given to the engine.
 *
 * Also the schema of recorded judgements: a person's decision, per scored run, on which model rule matches which answer-key rule when no
 * deterministic link decides it, and whether a rule contradicts its source. There is no AI judge.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../../../config.js";
import { RULE_KINDS } from "../../../engine/intel/model.js";
import type { Catalogue } from "../catalogue.js";

export const ANSWERS_DIR = path.join(REPO_ROOT, "src/eval/bench/answers");
export const INPUTS_DIR = path.join(REPO_ROOT, "src/eval/bench/inputs");

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, "Use letters, digits, dot, dash or underscore (at most 80)");
const Name = z.string().min(1).max(200);
const Ids = z.array(Id).max(100).default([]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** An endpoint is named "METHOD /path/template", e.g. "POST /api/cart/items/:id". */
const EndpointRef = z.string().regex(new RegExp(`^(${METHODS.join("|")}) /\\S{0,300}$`), 'Name an endpoint as "METHOD /path"');

export const AnswerKeySchema = z
    .object({
        app: Id,
        /** The key's own version; any change after the owner's review needs the owner again. */
        version: z.string().min(1).max(40),
        /** Keys are reviewed by the owner before any measured run; a measured run refuses a key that is not approved. */
        review: z.enum(["awaiting-owner", "approved"]),
        /** The catalogue version the key was written against. */
        catalogueVersion: z.string().min(1).max(40),
        /** File name in src/eval/bench/inputs/ that the rules cite by line. */
        requirementsDocument: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/, "A file name in the inputs folder ending in .md"),
        screens: z.array(z.object({ id: Id, path: z.string().regex(/^\/\S{0,300}$/, "A path starting with /"), name: Name, signIn: z.boolean(), roles: Ids }).strict()).min(1).max(200),
        workflows: z.array(z.object({ id: Id, name: Name, screens: Ids, endpoints: z.array(EndpointRef).max(100).default([]), roles: Ids }).strict()).min(1).max(200),
        entities: z.array(z.object({ id: Id, name: Name, fields: z.array(z.string().min(1).max(100)).max(100).default([]) }).strict()).max(200).default([]),
        endpoints: z.array(z.object({ method: z.enum(METHODS), path: z.string().regex(/^\/\S{0,300}$/, "A path starting with /"), documented: z.boolean() }).strict()).max(500).default([]),
        roles: z.array(z.object({ id: Id, name: Name }).strict()).max(50).default([]),
        /** Exactly one per catalogue defect of the app. */
        rules: z
            .array(
                z
                    .object({
                        defectId: Id,
                        kind: z.enum(RULE_KINDS),
                        statement: z.string().min(1).max(1000),
                        /** The requirement that states the rule: its stable id (e.g. "4.9") and its 1-based line in the document, which must carry that id. */
                        requirement: z.object({ id: z.string().regex(/^\d{1,3}(\.\d{1,3}){0,3}$/, 'A dotted requirement number, e.g. "4.9"'), line: z.number().int().min(1).max(100_000) }).strict(),
                        workflows: z.array(Id).min(1).max(20),
                        endpoints: z.array(EndpointRef).max(20).default([]),
                        entities: Ids,
                    })
                    .strict(),
            )
            .max(200),
    })
    .strict();
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

export const endpointRef = (e: { method: string; path: string }): string => `${e.method} ${e.path}`;

const issues = (e: z.ZodError) =>
    e.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`)
        .join("; ");

export function parseAnswerKey(text: string, file: string): { key: AnswerKey; sha256: string } {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`The answer key ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = AnswerKeySchema.safeParse(raw);
    if (!parsed.success) throw new Error(`The answer key ${file} has problems: ${issues(parsed.error)}`);
    return { key: parsed.data, sha256: crypto.createHash("sha256").update(text).digest("hex") };
}

/** Problems inside one key: duplicate ids and links to things the key does not list. */
function consistencyProblems(file: string, k: AnswerKey): string[] {
    const out: string[] = [];
    const set = (kind: string, ids: string[]) => {
        const s = new Set<string>();
        for (const id of ids) {
            if (s.has(id)) out.push(`${file}: the ${kind} “${id}” is listed twice`);
            s.add(id);
        }
        return s;
    };
    const screens = set("screen", k.screens.map((s) => s.id));
    const workflows = set("workflow", k.workflows.map((w) => w.id));
    const entities = set("entity", k.entities.map((e) => e.id));
    const endpoints = set("endpoint", k.endpoints.map(endpointRef));
    const roles = set("role", k.roles.map((r) => r.id));
    const linked = (where: string, kind: string, known: Set<string>, ids: string[]) => {
        for (const id of ids) if (!known.has(id)) out.push(`${file}: ${where} links the ${kind} “${id}”, which the key does not list`);
    };
    for (const s of k.screens) linked(`screen “${s.id}”`, "role", roles, s.roles);
    for (const w of k.workflows) {
        linked(`workflow “${w.id}”`, "screen", screens, w.screens);
        linked(`workflow “${w.id}”`, "endpoint", endpoints, w.endpoints);
        linked(`workflow “${w.id}”`, "role", roles, w.roles);
    }
    for (const r of k.rules) {
        linked(`the rule for ${r.defectId}`, "workflow", workflows, r.workflows);
        linked(`the rule for ${r.defectId}`, "endpoint", endpoints, r.endpoints);
        linked(`the rule for ${r.defectId}`, "entity", entities, r.entities);
    }
    return out;
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface BenchFile {
    file: string;
    text: string;
}

/**
 * Every problem with the answer keys and the requirements documents, as sentences; empty when all is well. Checks each key's schema and
 * consistency, that it covers every catalogue defect of its app with exactly one rule linked to the defect's workflow, lists every
 * catalogue workflow of the app, cites existing non-blank lines of its requirements document, and that no requirements document contains
 * a defect id, a catalogue "actual" text or an answer-key file name.
 */
export function checkAnswerKeys(input: { catalogue: Catalogue; keys: BenchFile[]; inputs: BenchFile[] }): string[] {
    const { catalogue } = input;
    const out: string[] = [];
    const docs = new Map(input.inputs.map((d) => [d.file, d.text]));
    for (const f of input.keys) {
        let key: AnswerKey;
        try {
            key = parseAnswerKey(f.text, f.file).key;
        } catch (e) {
            out.push(e instanceof Error ? e.message : String(e));
            continue;
        }
        if (f.file !== `${key.app}.json`) out.push(`${f.file}: an answer key is named after its app (${key.app}.json)`);
        if (key.catalogueVersion !== catalogue.version) out.push(`${f.file}: written against catalogue version ${key.catalogueVersion}, but the catalogue is ${catalogue.version}`);
        out.push(...consistencyProblems(f.file, key));
        const defects = catalogue.defects.filter((d) => d.app === key.app);
        if (defects.length === 0) out.push(`${f.file}: the catalogue has no defects for the app “${key.app}”`);
        const keyWorkflows = new Set(key.workflows.map((w) => w.id));
        for (const wf of [...new Set(defects.map((d) => d.workflow))].sort()) {
            if (!keyWorkflows.has(wf)) out.push(`${f.file}: the catalogue workflow “${wf}” is missing from the key's workflows`);
        }
        for (const d of defects) {
            const rules = key.rules.filter((r) => r.defectId === d.id);
            if (rules.length === 0) out.push(`${f.file}: the defect ${d.id} has no rule`);
            else if (rules.length > 1) out.push(`${f.file}: the defect ${d.id} has ${rules.length} rules; one is expected`);
            else if (!rules[0].workflows.includes(d.workflow)) out.push(`${f.file}: the rule for ${d.id} must link its catalogue workflow “${d.workflow}”`);
        }
        const known = new Set(defects.map((d) => d.id));
        for (const r of key.rules) if (!known.has(r.defectId)) out.push(`${f.file}: ${r.defectId} is not a catalogue defect of ${key.app}`);
        const doc = docs.get(key.requirementsDocument);
        if (doc === undefined) out.push(`${f.file}: its requirements document ${key.requirementsDocument} is not in the inputs folder`);
        else {
            const lines = doc.split(/\r?\n/);
            if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
            for (const r of key.rules) {
                const { id, line } = r.requirement;
                if (line > lines.length) out.push(`${f.file}: the rule for ${r.defectId} cites line ${line}, but ${key.requirementsDocument} has only ${lines.length} lines`);
                else if (lines[line - 1].trim() === "") out.push(`${f.file}: the rule for ${r.defectId} cites line ${line} of ${key.requirementsDocument}, which is blank`);
                else if (!new RegExp(`^\\s*(?:[-*]\\s+)?${escapeRe(id)}(?![.\\d])`).test(lines[line - 1])) out.push(`${f.file}: the rule for ${r.defectId} cites line ${line} of ${key.requirementsDocument}, which is not requirement ${id}`);
            }
        }
    }
    const keyNames = new Set([...input.keys.map((k) => k.file), ...catalogue.defects.map((d) => `${d.app}.json`)]);
    for (const d of input.inputs) {
        const flat = normalise(d.text);
        for (const defect of catalogue.defects) {
            if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(defect.id)}([^A-Za-z0-9]|$)`, "i").test(d.text)) out.push(`${d.file}: names the defect id ${defect.id}`);
            const actual = typeof defect.actual === "string" ? normalise(defect.actual) : "";
            if (actual && flat.includes(actual)) out.push(`${d.file}: contains the catalogue's actual behaviour of ${defect.id}`);
        }
        for (const name of keyNames) if (flat.includes(name.toLowerCase())) out.push(`${d.file}: names the answer-key file ${name}`);
    }
    return out;
}

/** A measured run scores only against a key the owner approved. */
export function requireApprovedKey(key: AnswerKey, file: string): void {
    if (key.review !== "approved") throw new Error(`The answer key ${file} is not approved by the owner yet (review: ${key.review}); a measured run needs an approved key.`);
}

/** The files with the given extension in a folder, sorted by name; none when the folder does not exist. */
export function readBenchFiles(dir: string, ext: string): BenchFile[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .sort()
        .map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), "utf8") }));
}

const RuleRef = z.string().min(1).max(100);

/** One person's recorded judgements for one scored run (spec Q6): rule matches the deterministic link did not decide, and reviews. */
export const JudgementsSchema = z
    .object({
        app: Id,
        inputs: z.enum(["url", "full"]),
        engine: z.enum(["baseline", "candidate"]),
        /** 1-based trial of the series. */
        trial: z.number().int().min(1).max(1000),
        modelVersion: z.number().int().min(1),
        /** sha256 of the answer key the run was scored against. */
        answerKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
        recordedBy: z.enum(["lead", "owner"]),
        ownerReviewed: z.boolean(),
        recordedAt: z.string().datetime(),
        /** A model rule and the defect whose answer-key rule it states, or null when it states none of them. */
        links: z.array(z.object({ ruleRef: RuleRef, defectId: Id.nullable(), reason: z.string().min(1).max(1000) }).strict()).max(2000).default([]),
        /** A model workflow and the answer-key workflow it identifies, for workflows no deterministic link found (or null: none). */
        workflowLinks: z.array(z.object({ workflowId: RuleRef, keyWorkflowId: Id.nullable(), reason: z.string().min(1).max(1000) }).strict()).max(500).default([]),
        /** Whether a model rule contradicts its source (explicit rules) or the answer key (inferred rules). */
        reviews: z.array(z.object({ ruleRef: RuleRef, verdict: z.enum(["consistent", "contradicts"]), note: z.string().max(1000).default("") }).strict()).max(2000).default([]),
    })
    .strict()
    .superRefine((j, ctx) => {
        for (const list of ["links", "reviews"] as const) {
            const seen = new Set<string>();
            j[list].forEach((x, i) => {
                if (seen.has(x.ruleRef)) ctx.addIssue({ code: "custom", path: [list, i, "ruleRef"], message: `The rule ${x.ruleRef} is judged twice` });
                seen.add(x.ruleRef);
            });
        }
        const seen = new Set<string>();
        j.workflowLinks.forEach((x, i) => {
            if (seen.has(x.workflowId)) ctx.addIssue({ code: "custom", path: ["workflowLinks", i, "workflowId"], message: `The workflow ${x.workflowId} is judged twice` });
            seen.add(x.workflowId);
        });
    });
export type Judgements = z.infer<typeof JudgementsSchema>;

export function parseJudgements(text: string): Judgements {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`The judgements file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = JudgementsSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`The judgements file has problems: ${issues(parsed.error)}`);
    return parsed.data;
}
