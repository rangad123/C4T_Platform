/**
 * The application intelligence model (testing-engine Phase 1): what the platform knows about an application, each piece with where it
 * came from. Types and schemas only; the generation pipeline does not read it yet (docs/ai-testing-engine/PHASE_1_IMPLEMENTATION.md).
 *
 * The rule that matters most: an expectation is only as good as its source. A business rule records whether it was stated by a
 * document (explicit) or guessed (inferred), how sure that is, and whether a person confirmed it. Current application behaviour is never a
 * source of expected behaviour: "observed" exists only to mark what a regression baseline saw.
 */
import { z } from "zod";

const Id = z.string().min(1).max(100);
const Text = (n: number) => z.string().max(n);
const Ids = z.array(Id).max(200);

/** Where a piece of knowledge, or an expected behaviour, comes from. */
export const SOURCE_TYPES = ["requirement", "prd", "openapi", "source_code", "db_schema", "existing_test", "user_confirmed", "inferred", "observed"] as const;
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** Sources that state intended behaviour. "inferred" is a guess; "observed" is only what the application did. */
export const STATING_SOURCES: ReadonlySet<SourceType> = new Set(["requirement", "prd", "openapi", "source_code", "db_schema", "existing_test", "user_confirmed"]);

export const RULE_KINDS = ["invariant", "constraint", "transition", "permission", "calculation", "workflow", "other"] as const;
export const RULE_STATUSES = ["unverified", "confirmed", "rejected"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const EvidenceSchema = z
    .object({
        /** What the evidence is: a quoted line, an OpenAPI path, a file and line, a page address. */
        kind: z.enum(["quote", "openapi", "file", "page", "test", "note"]),
        ref: Text(500),
        excerpt: Text(1000).optional(),
    })
    .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;

export const RuleSchema = z
    .object({
        /** Stable id within the project, e.g. R-12. */
        ref: Id,
        kind: z.enum(RULE_KINDS),
        description: Text(1000).min(1),
        expected: Text(1000).min(1),
        sourceType: SourceTypeSchema,
        sourceRef: Text(500).default(""),
        evidence: z.array(EvidenceSchema).max(20).default([]),
        /** explicit: a source states it; inferred: derived without a stating source. Worked out from sourceType, never chosen freely. */
        explicitness: z.enum(["explicit", "inferred"]),
        confidence: z.number().min(0).max(1),
        entities: Ids.default([]),
        workflows: Ids.default([]),
        endpoints: z.array(Text(300)).max(100).default([]),
    })
    .strict()
    .superRefine((r, ctx) => {
        const explicit = STATING_SOURCES.has(r.sourceType);
        if (r.explicitness !== (explicit ? "explicit" : "inferred")) ctx.addIssue({ code: "custom", path: ["explicitness"], message: `A rule from "${r.sourceType}" is ${explicit ? "explicit" : "inferred"}.` });
        if (r.sourceType === "observed") ctx.addIssue({ code: "custom", path: ["sourceType"], message: "What the application did is not a source of expected behaviour." });
        if (explicit && r.sourceType !== "user_confirmed" && r.evidence.length === 0 && !r.sourceRef) ctx.addIssue({ code: "custom", path: ["evidence"], message: "An explicit rule needs its source reference or evidence." });
    });
export type Rule = z.infer<typeof RuleSchema>;

/** explicit when a stating source says it; else inferred. */
export const explicitnessOf = (sourceType: SourceType): "explicit" | "inferred" => (STATING_SOURCES.has(sourceType) ? "explicit" : "inferred");

export const ElementSchema = z.object({ role: Text(60), name: Text(200), kind: z.enum(["link", "button", "input", "select", "form", "table", "dialog", "menu", "other"]) }).strict();

export const PageSchema = z
    .object({
        id: Id,
        path: Text(500),
        purpose: Text(500).default(""),
        elements: z.array(ElementSchema).max(300).default([]),
        requiresSignIn: z.boolean().optional(),
    })
    .strict();

export const WorkflowStepSchema = z.object({ order: z.number().int().min(0).max(1000), action: Text(500), page: Id.optional(), endpoint: Text(300).optional() }).strict();

export const WorkflowSchema = z
    .object({
        id: Id,
        name: Text(200),
        steps: z.array(WorkflowStepSchema).max(100).default([]),
        preconditions: z.array(Text(500)).max(30).default([]),
        postconditions: z.array(Text(500)).max(30).default([]),
        roles: z.array(Text(100)).max(20).default([]),
        sourceType: SourceTypeSchema,
    })
    .strict();

export const EntitySchema = z
    .object({
        id: Id,
        name: Text(100),
        fields: z.array(z.object({ name: Text(100), type: Text(50).optional(), constraints: z.array(Text(200)).max(20).default([]) }).strict()).max(100).default([]),
        evidence: z.array(EvidenceSchema).max(20).default([]),
    })
    .strict();

export const RelationshipSchema = z
    .object({
        from: Id,
        to: Id,
        kind: z.enum(["has_one", "has_many", "belongs_to", "many_to_many", "references"]),
        /** Only with evidence: a relationship nobody can point at is not recorded. */
        evidence: z.array(EvidenceSchema).min(1).max(20),
    })
    .strict();

export const ExpectedOutcomeSchema = z
    .object({
        text: Text(1000).min(1),
        sourceType: SourceTypeSchema,
        ruleRef: Id.optional(),
        requirementRef: Id.optional(),
    })
    .strict();
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

export const ScenarioSchema = z
    .object({
        id: Id,
        description: Text(1000),
        objective: Text(500),
        preconditions: z.array(Text(500)).max(30).default([]),
        actions: z.array(Text(500)).max(100).default([]),
        expectedOutcomes: z.array(ExpectedOutcomeSchema).max(20).default([]),
        rules: Ids.default([]),
        entities: Ids.default([]),
        workflows: Ids.default([]),
        /** What it covers, for coverage counting: pages, endpoints, rules. */
        covers: z.object({ pages: Ids.default([]), endpoints: z.array(Text(300)).max(100).default([]), rules: Ids.default([]) }).strict().default({ pages: [], endpoints: [], rules: [] }),
        testCaseId: Id.optional(),
    })
    .strict();
export type IntelScenario = z.infer<typeof ScenarioSchema>;

export const CONTEXT_SOURCES = ["url", "crawl", "openapi", "requirements", "prd", "source_code", "db_schema", "existing_tests", "design"] as const;

/** One analysis of an application: what was known at that time. Rules are kept apart (they outlive versions and are confirmed by people). */
export const AppModelSchema = z
    .object({
        appType: Text(100).default(""),
        contextSources: z.array(z.enum(CONTEXT_SOURCES)).max(CONTEXT_SOURCES.length).default([]),
        pages: z.array(PageSchema).max(2000).default([]),
        workflows: z.array(WorkflowSchema).max(500).default([]),
        entities: z.array(EntitySchema).max(500).default([]),
        relationships: z.array(RelationshipSchema).max(2000).default([]),
        scenarios: z.array(ScenarioSchema).max(2000).default([]),
    })
    .strict();
export type AppModel = z.infer<typeof AppModelSchema>;

export interface ModelDiff {
    pages: { added: string[]; removed: string[] };
    workflows: { added: string[]; removed: string[] };
    entities: { added: string[]; removed: string[] };
    scenarios: { added: string[]; removed: string[] };
}

const idsOf = (xs: Array<{ id: string }>) => new Set(xs.map((x) => x.id));
const delta = (a: Set<string>, b: Set<string>) => ({ added: [...b].filter((x) => !a.has(x)).sort(), removed: [...a].filter((x) => !b.has(x)).sort() });

/** What changed between two analyses, by id. */
export function diffModels(before: AppModel | undefined, after: AppModel): ModelDiff {
    const b = before ?? AppModelSchema.parse({});
    return {
        pages: delta(idsOf(b.pages), idsOf(after.pages)),
        workflows: delta(idsOf(b.workflows), idsOf(after.workflows)),
        entities: delta(idsOf(b.entities), idsOf(after.entities)),
        scenarios: delta(idsOf(b.scenarios), idsOf(after.scenarios)),
    };
}
