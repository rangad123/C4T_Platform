/**
 * The application intelligence model (testing-engine Phase 1): what the platform knows about an application, each piece with where it
 * came from. Types, schemas and the pure helpers over them (diff, rule fingerprint); fragment.ts is what each source returns.
 *
 * The rule that matters most: an expectation is only as good as its source. A business rule records whether it was stated by a
 * document (explicit) or guessed (inferred), how sure that is, and whether a person confirmed it. Current application behaviour is never a
 * source of expected behaviour: "observed" exists only to mark what a regression baseline saw.
 */
import { createHash } from "node:crypto";
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
        kind: z.enum(["quote", "openapi", "file", "page", "test", "note", "request"]),
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

/** A form field with the constraints the page itself declares (required, type, limits, pattern, options) and the message it shows. */
export const FieldSchema = z
    .object({
        name: Text(200),
        label: Text(200).optional(),
        type: Text(50).default("text"),
        required: z.boolean().optional(),
        min: Text(100).optional(),
        max: Text(100).optional(),
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(0).optional(),
        pattern: Text(500).optional(),
        options: z.array(Text(200)).max(200).optional(),
        /** The message the page showed for an invalid value (never the value typed). */
        message: Text(500).optional(),
    })
    .strict();

export const FormSchema = z.object({ name: Text(200).default(""), fields: z.array(FieldSchema).max(100).default([]) }).strict();

/** Dialogs, menus and tables on a page; a table keeps its headers only, never cell text. */
export const StructureSchema = z.object({ kind: z.enum(["dialog", "menu", "table"]), name: Text(200).default(""), headers: z.array(Text(200)).max(50).optional() }).strict();

/** A request a safe interaction on the page caused: the control and the endpoint's method and path template. */
export const InteractionSchema = z.object({ control: Text(200), method: Text(10), path: Text(500) }).strict();

export const PageSchema = z
    .object({
        id: Id,
        path: Text(500),
        purpose: Text(500).default(""),
        elements: z.array(ElementSchema).max(300).default([]),
        requiresSignIn: z.boolean().optional(),
        /** The screen this page is in the screen map. */
        screenId: Id.optional(),
        /** Roles whose accounts reached the page. */
        reachableBy: z.array(Text(100)).max(20).optional(),
        forms: z.array(FormSchema).max(30).default([]),
        structures: z.array(StructureSchema).max(100).default([]),
        interactions: z.array(InteractionSchema).max(200).default([]),
    })
    .strict();

/** From one page to another, by which control; seen in the crawl. */
export const NavigationSchema = z.object({ from: Id, to: Id, control: Text(200).default(""), evidence: z.array(EvidenceSchema).min(1).max(5) }).strict();

/**
 * An API endpoint. "documented" means an OpenAPI document describes it, so it needs that document's path as evidence; "observed" means
 * the application was seen calling it. An endpoint that is neither documented nor observed has no evidence and is never recorded.
 */
export const EndpointSchema = z
    .object({
        method: Text(10).min(1),
        /** Path template, e.g. /api/orders/{id}. */
        path: Text(500).min(1),
        origin: z.enum(["documented", "observed"]),
        parameters: z.array(z.object({ name: Text(100), in: z.enum(["path", "query", "header", "cookie", "body"]), required: z.boolean().default(false), type: Text(50).default("") }).strict()).max(100).default([]),
        /** Schema references, e.g. #/components/schemas/Order. */
        requestSchema: Text(300).optional(),
        responseSchema: Text(300).optional(),
        requiresAuth: z.boolean().optional(),
        errors: z.array(z.object({ status: Text(10), description: Text(300).default("") }).strict()).max(30).default([]),
        evidence: z.array(EvidenceSchema).min(1).max(20),
    })
    .strict()
    .superRefine((e, ctx) => {
        if (e.origin === "documented" && !e.evidence.some((x) => x.kind === "openapi")) ctx.addIssue({ code: "custom", path: ["evidence"], message: "A documented endpoint needs its OpenAPI path as evidence." });
    });
export type Endpoint = z.infer<typeof EndpointSchema>;

/** The key an endpoint is known by: method and path template. */
export const endpointKey = (e: { method: string; path: string }): string => `${e.method.toUpperCase()} ${e.path}`;

/** A role, what its account reached and how it differs from the others (from the per-account crawl). */
export const RoleSchema = z.object({ name: Text(100).min(1), reaches: Ids.default([]), differs: z.array(Text(500)).max(50).default([]), evidence: z.array(EvidenceSchema).min(1).max(20) }).strict();

/**
 * A state change of an entity. `expectation` marks it as intended behaviour; a transition the application was only seen making
 * ("observed") is never one.
 */
export const TransitionSchema = z
    .object({
        entity: Id,
        from: Text(100),
        to: Text(100),
        trigger: Text(300).default(""),
        sourceType: SourceTypeSchema,
        expectation: z.boolean().default(false),
        evidence: z.array(EvidenceSchema).min(1).max(20),
    })
    .strict()
    .superRefine((t, ctx) => {
        if (t.sourceType === "observed" && t.expectation) ctx.addIssue({ code: "custom", path: ["expectation"], message: "What the application did is not a source of expected behaviour." });
    });

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
        /** The pages, requests or document lines it was built from. */
        evidence: z.array(EvidenceSchema).max(20).default([]),
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

/** Where knowledge comes from, one record per connected source (an uploaded file, a document, the crawl, an artefact in a repository). */
export const SOURCE_KINDS = ["exploration", "openapi", "requirements", "db_schema", "repository", "existing_tests"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_STATUSES = ["connected", "processed", "failed"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const SourceRecordSchema = z
    .object({
        kind: z.enum(SOURCE_KINDS),
        /** What it is: a URL, a document id, a file name, a repository path at a commit. */
        ref: Text(500).min(1),
        /** sha256 of the normalised content; empty until processed. */
        fingerprint: Text(100).default(""),
        status: z.enum(SOURCE_STATUSES),
        processedAt: Text(40).optional(),
        /** Why it failed, as one sentence; only for a failed source. */
        error: Text(500).optional(),
    })
    .strict()
    .superRefine((s, ctx) => {
        if (s.status === "failed" && !s.error) ctx.addIssue({ code: "custom", path: ["error"], message: "A failed source says why." });
        if (s.status !== "failed" && s.error) ctx.addIssue({ code: "custom", path: ["error"], message: "Only a failed source has an error." });
    });
export type SourceRecord = z.infer<typeof SourceRecordSchema>;

/** Something the analysis could not work out, and which source would answer it. */
export const MissingContextSchema = z.object({ text: Text(500).min(1), source: z.enum(SOURCE_KINDS).optional() }).strict();
export type MissingContext = z.infer<typeof MissingContextSchema>;

/**
 * Which build of the application a model describes. Never inferred from a page: a label a person gave, the version or commit a deploy
 * sent, the repository commit analysed, or "unversioned" (then only the analysis time says when).
 */
export const AppVersionSchema = z
    .object({ source: z.enum(["person", "deploy", "repository", "unversioned"]), label: Text(200).default(""), analysedAt: Text(40) })
    .strict()
    .superRefine((v, ctx) => {
        if (v.source !== "unversioned" && !v.label.trim()) ctx.addIssue({ code: "custom", path: ["label"], message: "A version needs its label." });
    });
export type AppVersion = z.infer<typeof AppVersionSchema>;

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
        endpoints: z.array(EndpointSchema).max(2000).default([]),
        navigation: z.array(NavigationSchema).max(5000).default([]),
        roles: z.array(RoleSchema).max(50).default([]),
        transitions: z.array(TransitionSchema).max(500).default([]),
        sources: z.array(SourceRecordSchema).max(200).default([]),
        missingContext: z.array(MissingContextSchema).max(100).default([]),
        appVersion: AppVersionSchema.optional(),
    })
    .strict();
export type AppModel = z.infer<typeof AppModelSchema>;

/** Added, removed and changed (same key, different content) items. `changed` is absent in diffs stored by the first version. */
export interface DiffPart {
    added: string[];
    removed: string[];
    changed?: string[];
}

export interface ModelDiff {
    pages: DiffPart;
    workflows: DiffPart;
    entities: DiffPart;
    scenarios: DiffPart;
    /** Absent in diffs stored by the first version. */
    endpoints?: DiffPart;
    roles?: DiffPart;
}

const byKey = <T>(xs: T[], key: (x: T) => string) => new Map(xs.map((x) => [key(x), JSON.stringify(x)]));
function delta<T>(before: T[], after: T[], key: (x: T) => string): Required<DiffPart> {
    const a = byKey(before, key);
    const b = byKey(after, key);
    return {
        added: [...b.keys()].filter((k) => !a.has(k)).sort(),
        removed: [...a.keys()].filter((k) => !b.has(k)).sort(),
        changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).sort(),
    };
}
const id = (x: { id: string }) => x.id;

/** What changed between two analyses, by id (endpoints by method and path, roles by name). */
export function diffModels(before: AppModel | undefined, after: AppModel): Required<ModelDiff> {
    const b = before ?? AppModelSchema.parse({});
    return {
        pages: delta(b.pages, after.pages, id),
        workflows: delta(b.workflows, after.workflows, id),
        entities: delta(b.entities, after.entities, id),
        scenarios: delta(b.scenarios, after.scenarios, id),
        endpoints: delta(b.endpoints, after.endpoints, endpointKey),
        roles: delta(b.roles, after.roles, (r) => r.name),
    };
}

/** Spacing only: case and look-alike characters are content (a code, a path, a superscript), so they are kept. */
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * The key a rule is matched by across analyses: sha256 of its kind, what it expects and what it is linked to, ignoring only spacing and
 * the order of links, so a person's decision follows exactly the text they read. Its wording, ref, source and confidence are not part of it.
 */
/**
 * The key a workflow is matched by across analyses: sha256 of its steps in order (each step's action, page and endpoint), ignoring only
 * spacing. Its name is not part of it, so a renamed workflow keeps a person's decision (the new name is shown beside the decided one).
 */
export function workflowFingerprint(w: { steps: ReadonlyArray<{ order?: number; action: string; page?: string; endpoint?: string }> }): string {
    const key = [...w.steps].map((s) => [norm(s.action), norm(s.page ?? ""), norm(s.endpoint ?? "")]);
    return createHash("sha256").update(JSON.stringify(["workflow", key])).digest("hex");
}

export function ruleFingerprint(rule: Pick<Rule, "kind" | "expected" | "entities" | "workflows" | "endpoints">): string {
    const links = (xs: string[]) => [...new Set(xs.map(norm))].sort();
    const key = [rule.kind, norm(rule.expected), links(rule.entities), links(rule.workflows), links(rule.endpoints)];
    return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}
