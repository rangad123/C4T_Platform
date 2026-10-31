/**
 * Site memory: what the platform remembers about one application between analyses.
 *
 * The idea (a per-site knowledge base that later runs start from) comes from QAAgency's `src/memory/*`
 * (MIT, https://github.com/ninacoelhodr/QAAgency); this is a much smaller, structural-only version.
 * Only structure is kept: paths, page types, short titles, content fingerprints, journey names, endpoint
 * templates. Never page text, form values, credentials, tokens or user data.
 */
import { z } from "zod";
import { PAGE_TYPES } from "../understanding/app-model.js";

/** Bump when the stored shape changes; a record with another version is ignored, never half-read. */
export const MEMORY_VERSION = 1;
/** A stored record bigger than this is dropped (and a new one is distilled to fit under it). */
export const MAX_MEMORY_BYTES = 64 * 1024;
/** Memories kept per project (one per application origin). */
export const MAX_ORIGINS_PER_PROJECT = 5;

const Path = z.string().min(1).max(240);
const Short = (n: number) => z.string().max(n);

export const SiteKnowledgeSchema = z.object({
    version: z.literal(MEMORY_VERSION),
    origin: z.string().min(1).max(200),
    analysedAt: z.string().max(40),
    siteType: Short(60),
    purpose: Short(300),
    pages: z
        .array(
            z.object({
                path: Path,
                type: z.enum(PAGE_TYPES),
                title: Short(80),
                /** Hash of the page's headings and form field names: changes when the page's structure changes. */
                fp: z.string().regex(/^[0-9a-f]{16}$/),
                /**
                 * Exploration reuse (reuse.ts): a hash of what the AI was shown about the page (the fingerprint above plus its title, its
                 * controls' roles and names and the API calls it makes), and what the AI understood it is for (one scrubbed sentence).
                 * Absent in records saved before reuse existed: such pages are simply sent to the AI again.
                 */
                ufp: z.string().regex(/^[0-9a-f]{16}$/).optional(),
                purpose: Short(200).optional(),
            }),
        )
        .max(400),
    journeys: z
        .array(
            z.object({
                name: Short(120),
                priority: z.enum(["critical", "high", "medium", "low"]),
                requiresAuth: z.boolean(),
                pages: z.array(Path).max(20),
                /** Titles of the planned scenarios of this journey that passed validation. */
                validated: z.array(Short(120)).max(12),
            }),
        )
        .max(60),
    loginPath: Path.optional(),
    apis: z.array(z.object({ method: Short(10), path: Path, requiresAuth: z.boolean().optional() })).max(300),
    /** Whether this analysis planned and validated scenarios (false: `validated` was carried over, not re-measured). */
    validationKnown: z.boolean(),
    /** Deterministic one-paragraph summary of what was learned. */
    learned: Short(600),
});
export type SiteKnowledge = z.infer<typeof SiteKnowledgeSchema>;

/** What changed between the previous memory and a new analysis (computed, never asked of the model). */
export const MemoryChangesSchema = z.object({
    /** When the analysis compared against ran. */
    since: z.string().max(40),
    pagesAdded: z.array(Path).max(50),
    pagesRemoved: z.array(Path).max(50),
    pagesChanged: z.array(Path).max(50),
    endpointsAdded: z.array(Short(260)).max(50),
    endpointsRemoved: z.array(Short(260)).max(50),
    journeysNoLongerValidating: z.array(Short(120)).max(50),
    /** True counts (the lists above are capped). */
    counts: z.object({
        pagesAdded: z.number().int().min(0),
        pagesRemoved: z.number().int().min(0),
        pagesChanged: z.number().int().min(0),
        endpointsAdded: z.number().int().min(0),
        endpointsRemoved: z.number().int().min(0),
        journeysNoLongerValidating: z.number().int().min(0),
    }),
    /** "Since the last analysis: 2 new pages, 1 page changed, 1 endpoint gone." */
    text: Short(400),
});
export type MemoryChanges = z.infer<typeof MemoryChangesSchema>;

/** What a store hands the orchestrator: the record (if usable) and a plain warning when one had to be dropped or skipped. */
export interface MemoryLoad {
    knowledge: SiteKnowledge | null;
    warning?: string;
}
