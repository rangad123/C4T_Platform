/**
 * Reusable steps ("blocks"): the model of a named, project-level group of steps with optional parameters.
 *
 * Everything here is pure text work, so the same rules check a block typed into the UI, one imported from a backup and one extracted
 * from an existing test. A test uses a block with a `useBlock` step; the block's steps are put in its place before any script is
 * rendered (see expand.ts), so no generated script ever contains the step.
 */
import { z } from "zod";
import { StoredStepSchema, type Step } from "../spec/schema.js";
import { nameKey, nameProblem, normalizeName } from "../locators/model.js";

export { nameKey, normalizeName };

export const BLOCK_KINDS = ["web", "api", "any"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const MAX_BLOCKS = 100;
export const MAX_BLOCK_STEPS = 40;
export const MAX_BLOCK_PARAMS = 10;
/** Size of the block's steps as JSON text. */
export const MAX_BLOCK_BYTES = 20_000;
/** How deep reusable steps may use each other: a test uses A, A uses B, B uses C is the deepest allowed. */
export const MAX_BLOCK_DEPTH = 3;
/** A test never grows past this many steps once blocks are expanded (the same number as the step editor's cap). */
export const MAX_EXPANDED_STEPS = 100;
export const MAX_ARG_LENGTH = 500;
/**
 * The most text the steps put in place for ONE test may hold (the sum of their sizes as JSON, counted while they are built). Every other
 * limit is per block or per value and each is fine on its own; nested blocks multiply them, so this one is checked as the steps are made.
 */
export const MAX_EXPANDED_CHARS = 400_000;
export const DESCRIPTION_MAX = 300;
export const PARAM_DESCRIPTION_MAX = 200;

/** Parameter names are words (they sit between braces in a step), and two names are kept for the platform. */
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
export const RESERVED_PARAMS = new Set(["unique", "dataSet"]);

export interface BlockParam {
    name: string;
    description?: string;
    /** Used when a test gives no value. A parameter without a default must be given one. */
    default?: string;
}

export interface BlockDef {
    name: string;
    kind: BlockKind;
    params: BlockParam[];
    steps: Step[];
}
/** The project's blocks by exact name. */
export type BlockIndex = ReadonlyMap<string, BlockDef>;

export const indexBlocks = (blocks: Iterable<BlockDef>): BlockIndex => {
    const m = new Map<string, BlockDef>();
    for (const b of blocks) m.set(b.name, b);
    return m;
};

const ParamSchema = z.object({
    name: z.string().max(60),
    description: z.string().max(PARAM_DESCRIPTION_MAX).optional(),
    default: z.string().max(MAX_ARG_LENGTH).optional(),
});

/** A block as a person, an API caller or a backup gives it. */
export const BlockInputSchema = z.object({
    name: z.string().min(1, "Give the reusable steps a name.").max(200).transform(normalizeName),
    description: z.string().max(2000).optional(),
    kind: z.enum(BLOCK_KINDS),
    params: z.array(ParamSchema).max(MAX_BLOCK_PARAMS, `Reusable steps can have at most ${MAX_BLOCK_PARAMS} parameters.`).default([]),
    steps: z.array(StoredStepSchema).min(1, "Add at least one step.").max(MAX_BLOCK_STEPS, `Reusable steps can have at most ${MAX_BLOCK_STEPS} steps.`),
});

export interface CheckedBlock {
    name: string;
    description?: string;
    kind: BlockKind;
    params: BlockParam[];
    steps: Step[];
}

const clean = (s: string | undefined, max: number): string | undefined => {
    const t = (s ?? "").trim();
    return t === "" ? undefined : t.slice(0, max);
};

/** The placeholder `{{name}}` of a parameter, with the same spacing rules the substitution uses. */
export const placeholderPattern = (name: string): RegExp => new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`);

/** Plain-language form of the first zod problem. */
function firstIssue(e: z.ZodError): string {
    const i = e.issues[0]!;
    const p = i.path;
    if (p[0] === "steps" && typeof p[1] === "number") {
        const field = p.slice(2).filter((x) => typeof x === "string").pop();
        if (i.code === "invalid_union_discriminator") return `Step ${p[1] + 1}: choose what this step does.`;
        if (i.code === "invalid_type" && (i as { received?: string }).received === "undefined") return `Step ${p[1] + 1}: ${field ? `“${field}”` : "this step"} is missing.`;
        return `Step ${p[1] + 1}: ${field ? `“${field}” ` : ""}${i.message.charAt(0).toLowerCase()}${i.message.slice(1)}`;
    }
    const where = p.length ? `${p.join(".")}: ` : "";
    return `${where}${i.message}`;
}

/**
 * The block with every rule applied, or the first problem in plain words. The rules that need the rest of the project (cycles, depth, the
 * address guard, the sign-in rule, the tests that use the block) are checked by the platform around this.
 */
export function checkBlockInput(input: unknown): { ok: true; block: CheckedBlock } | { ok: false; error: string } {
    const r = BlockInputSchema.safeParse(input);
    if (!r.success) return { ok: false, error: firstIssue(r.error) };
    const { name, description, kind, params, steps } = r.data;
    const bad = nameProblem(name)?.replace("the element", "the reusable steps");
    if (bad) return { ok: false, error: bad };
    if (description !== undefined && description.trim().length > DESCRIPTION_MAX) return { ok: false, error: `The description can have at most ${DESCRIPTION_MAX} characters.` };
    const seen = new Set<string>();
    const cleanParams: BlockParam[] = [];
    for (const p of params) {
        const pn = p.name.trim();
        if (!PARAM_NAME.test(pn)) return { ok: false, error: `The parameter name “${pn.slice(0, 40)}” can only use letters, numbers and underscores, must start with a letter and can have at most 40 characters.` };
        if (RESERVED_PARAMS.has(pn)) return { ok: false, error: `“${pn}” is kept for the platform. Pick another parameter name.` };
        if (seen.has(pn.toLowerCase())) return { ok: false, error: `The parameter “${pn}” appears twice.` };
        seen.add(pn.toLowerCase());
        const d = clean(p.description, PARAM_DESCRIPTION_MAX);
        cleanParams.push({ name: pn, ...(d ? { description: d } : {}), ...(p.default !== undefined ? { default: p.default } : {}) });
    }
    const size = JSON.stringify(steps).length;
    if (size > MAX_BLOCK_BYTES) return { ok: false, error: `These steps are too large (${Math.ceil(size / 1000)} KB). A block can hold at most ${MAX_BLOCK_BYTES / 1000} KB of steps.` };
    const desc = clean(description, DESCRIPTION_MAX);
    return { ok: true, block: { name, ...(desc ? { description: desc } : {}), kind, params: cleanParams, steps } };
}

/** Names this block's steps use directly (each once, in order). */
export function blockUses(steps: readonly Step[]): string[] {
    const out: string[] = [];
    for (const s of steps) if (s.action === "useBlock" && !out.includes(s.block)) out.push(s.block);
    return out;
}
