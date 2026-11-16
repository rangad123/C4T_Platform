/**
 * What every source of application knowledge returns: a fragment. Each source (the crawl, an OpenAPI document, a requirements document,
 * a database schema file, a repository artefact, existing tests) produces one fragment: the part of the model it could fill, the rules it
 * found, and its own source record. Fragments meet only in merge.ts.
 *
 * Rules in a fragment have no status: every rule is stored unverified, and only a person confirms one.
 */
import { z } from "zod";
import { AppModelSchema, RuleSchema, SourceRecordSchema } from "./model.js";

export { SOURCE_KINDS, SOURCE_STATUSES, SourceRecordSchema, type SourceKind, type SourceRecord, type SourceStatus } from "./model.js";

export const ModelFragmentSchema = z
    .object({
        source: SourceRecordSchema,
        /** The part of the model this source filled; everything it did not fill is empty. */
        model: AppModelSchema,
        rules: z.array(RuleSchema).max(2000).default([]),
        /** Plain sentences about what the source left out (e.g. "3 rules dropped: their quote is not in the document."). */
        notes: z.array(z.string().max(500)).max(50).default([]),
        /**
         * The documents this source read in full, as fingerprints (the same as Rule.anchor.text): a stored rule read from one of them still
         * has its evidence, even when this reading did not state the rule again (carry-forward.ts). Absent for sources not read as text.
         */
        read: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(5000).optional(),
    })
    .strict();
export type ModelFragment = z.infer<typeof ModelFragmentSchema>;
