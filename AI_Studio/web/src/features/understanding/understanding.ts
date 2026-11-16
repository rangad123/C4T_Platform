import { ApiError, getKey, csrfHeader, projectKind, projectShape, type ProjectDetail } from "../../api";
import { useFetch, type Fetched } from "../../lib/hooks";

/**
 * What the platform knows about the application a project tests (GET /api/projects/:id/intel/...): the latest analysis, its sources,
 * and the business rules found in them, which only a person confirms or rejects.
 */

export type SourceKind = "exploration" | "openapi" | "requirements" | "db_schema" | "repository" | "existing_tests";
export type SourceStatus = "connected" | "processed" | "failed";
export type RuleStatus = "unverified" | "confirmed" | "rejected";
export type SourceType = "requirement" | "prd" | "openapi" | "source_code" | "db_schema" | "existing_test" | "user_confirmed" | "inferred" | "observed";

export interface Source {
    id: string;
    kind: SourceKind;
    ref: string;
    status: SourceStatus;
    processedAt: string | null;
    error: string | null;
}

export interface LastAnalysis {
    at: string;
    changed: boolean;
    version: number | null;
    failed: number;
    error?: string;
}

export interface SourcesAnswer {
    sources: Source[];
    running: { since: string } | null;
    last: LastAnalysis | null;
}

export interface Workflow {
    id: string;
    name: string;
    sourceType: SourceType;
    steps?: Array<{ order: number; action: string }>;
    evidence?: Evidence[];
    /** Which version of the workflow a person decides about; sent back with a decision. */
    fingerprint?: string;
    /** A person's decision about an inferred workflow, kept across readings. */
    decision?: { status: "confirmed" | "rejected"; decidedBy: string | null; decidedAt: string } | null;
    /** A later reading's name for a decided workflow; it keeps the name the person decided about. */
    rewordedName?: string;
}

export interface AppVersion {
    source: "person" | "deploy" | "repository" | "unversioned";
    label: string;
    analysedAt: string;
}

export interface ModelVersion {
    version: number;
    createdAt: string;
    appVersion: AppVersion;
    model: {
        pages: unknown[];
        workflows: Workflow[];
        endpoints: unknown[];
        missingContext: Array<{ text: string }>;
    };
}

export interface Evidence {
    kind: "quote" | "openapi" | "file" | "page" | "test" | "note" | "request";
    ref: string;
    excerpt?: string;
}

export interface Rule {
    id: string;
    description: string;
    expected: string;
    sourceType: SourceType;
    sourceRef: string;
    evidence: Evidence[];
    explicitness: "explicit" | "inferred";
    confidence: number;
    workflows: string[];
    status: RuleStatus;
    /** Which version of the rule a person decides about; sent back with a decision. */
    fingerprint: string;
    /** A later analysis's wording of a decided rule; the rule keeps the wording the person decided about. */
    rewordedDescription?: string;
    rewordedExpected?: string;
    evidenceGone?: { version: number; at: string };
}

/**
 * Whether a project has application understanding: a website the AI agent explores. A code-only project and a phone app are not read
 * this way, so nothing is shown or asked for them.
 */
export const understandsApp = (p: Pick<ProjectDetail, "platforms" | "testingModes" | "mobile">): boolean => projectKind(p) !== "code" && projectShape(p).platforms.includes("web") && !p.mobile;

/** Where knowledge came from, in plain words. */
export const SOURCE_WORDS: Record<SourceKind, string> = {
    exploration: "Exploring the application",
    openapi: "API description",
    requirements: "Requirements",
    db_schema: "Database schema file",
    repository: "Source repository",
    existing_tests: "Existing tests",
};

export const STATUS_WORDS: Record<SourceStatus, string> = { connected: "Waiting", processed: "Processed", failed: "Failed" };
export const STATUS_TONE: Record<SourceStatus, "neutral" | "success" | "danger"> = { connected: "neutral", processed: "success", failed: "danger" };

/** Where a rule came from, in plain words. */
export const RULE_SOURCE_WORDS: Record<SourceType, string> = {
    requirement: "Requirements",
    prd: "Product document",
    openapi: "API description",
    source_code: "Source code",
    db_schema: "Database schema",
    existing_test: "An existing test",
    user_confirmed: "A person",
    inferred: "Worked out by the AI",
    observed: "Seen in the application",
};

/** Sources that state behaviour; a workflow from any other is only inferred. */
const STATING: ReadonlySet<SourceType> = new Set(["requirement", "prd", "openapi", "source_code", "db_schema", "existing_test", "user_confirmed"]);
export const isStated = (t: SourceType): boolean => STATING.has(t);

export const EVIDENCE_GONE = "A later reading no longer found what this rule was based on. Check that it still holds.";
export const UNCONFIRMED_WORKFLOW = "Tests use this rule once this workflow is confirmed.";

/** Tests use a workflow when a source states it or a person confirmed it. */
export const workflowUsable = (w: Workflow): boolean => isStated(w.sourceType) || w.decision?.status === "confirmed";

/** The new wording of a decided rule, as one line; empty when it was not reworded. */
export function rewordedLine(r: Pick<Rule, "rewordedDescription" | "rewordedExpected">): string {
    const parts = [r.rewordedDescription, r.rewordedExpected && `expected: ${r.rewordedExpected}`].filter(Boolean);
    return parts.length ? `Reworded since you decided: ${parts.join("; ")}` : "";
}

/** The rules line: how many are stated by a source, inferred, and still waiting for a person. */
export function rulesLine(rules: readonly Rule[]): string {
    const explicit = rules.filter((r) => r.explicitness === "explicit").length;
    const waiting = rules.filter((r) => r.status === "unverified").length;
    return `${explicit} stated by a source, ${rules.length - explicit} inferred; ${waiting} waiting for a person to confirm.`;
}

/** Send a database schema file's bytes (SQL or Prisma) as the raw request body. */
export async function uploadSchema(projectId: string, file: File): Promise<Source> {
    let res: Response;
    try {
        res = await fetch(`/api/projects/${projectId}/intel/sources/schema?name=${encodeURIComponent(file.name)}`, {
            method: "POST",
            headers: { "content-type": "application/octet-stream", ...(getKey() ? { "x-api-key": getKey() } : {}), ...csrfHeader("POST") },
            body: file,
        });
    } catch {
        throw new ApiError(0, "Could not reach the platform server");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || res.statusText);
    return data as Source;
}

/**
 * The latest analysis, or `none` when there is none yet. The list of versions is asked first, so a project never analysed makes no
 * request that answers 404 (the browser would log it as an error).
 */
export function useLatestModel(projectId: string): Fetched<ModelVersion> & { none: boolean } {
    const versions = useFetch<{ versions: unknown[] }>(`/projects/${projectId}/intel/models`);
    const any = (versions.data?.versions.length ?? 0) > 0;
    const latest = useFetch<ModelVersion>(any ? `/projects/${projectId}/intel/models/latest` : null);
    return {
        ...latest,
        loading: versions.loading || latest.loading,
        error: versions.error ?? latest.error,
        none: Boolean(versions.data) && !any,
        reload: async () => {
            await versions.reload();
            await latest.reload();
        },
    };
}
