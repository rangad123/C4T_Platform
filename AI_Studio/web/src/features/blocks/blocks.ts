/** Types and wording for reusable steps (the API lives in src/platform/routes/blocks.ts). */
import { ApiError } from "../../api";
import { plural } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import type { Catalog, Step } from "../builder/builder";
import type { Placeholders } from "../builder/Fields";

export type BlockKind = "web" | "api" | "any";

export interface BlockParam {
    name: string;
    description?: string;
    default?: string;
}

export interface UserBrief {
    id: string;
    testId: string;
    title: string;
}

export interface Block {
    id: string;
    name: string;
    description: string | null;
    kind: BlockKind;
    params: BlockParam[];
    stepCount: number;
    /** Only in the answer for one block. */
    steps?: Step[];
    version: number;
    createdAt: string;
    updatedAt: string;
    usedBy: { count: number; blocks: string[]; tests: UserBrief[] };
}

export interface BlockList {
    total: number;
    limit: number;
    blocks: Block[];
    catalog: Catalog;
    placeholders: Placeholders;
}

export interface Revalidation {
    status: "started" | "waiting" | "none";
    jobId?: string;
    message?: string;
}

/** The answer to a change: the block, and what happened to the tests that use it. */
export interface BlockChange extends Block {
    appliesTo: number;
    tests: UserBrief[];
    revalidation: Revalidation;
    problems: Array<{ testId: string; error: string }>;
}

export const KIND_TEXT: Record<BlockKind, string> = { web: "Web tests", api: "API tests", any: "Any test" };
export const KIND_CHOICES: Array<{ id: BlockKind; label: string; help: string }> = [
    { id: "web", label: "Web tests", help: "Steps in a browser: open a page, click, type, check the page." },
    { id: "api", label: "API tests", help: "Requests to your API and checks of the answers." },
    { id: "any", label: "Any test", help: "Steps that suit both, such as waiting, or other reusable steps." },
];

export const usedByText = (count: number): string => (count === 0 ? "Not used by any test yet" : `Used by ${plural(count, "test")}`);

export const paramsText = (params: BlockParam[]): string => (params.length <= 3 ? params.map((p) => p.name).join(", ") : plural(params.length, "value"));

/** What happened to the tests after a change, in one sentence a person can act on. */
export function appliesToText(c: Pick<BlockChange, "appliesTo" | "revalidation">): string {
    if (c.appliesTo === 0) return "No test uses these steps yet.";
    const who = c.appliesTo === 1 ? "1 test uses" : `${c.appliesTo} tests use`;
    if (c.revalidation.status === "started") return `${who} these steps. Their scripts were updated and they are running again.`;
    if (c.revalidation.status === "waiting") return `${who} these steps. ${c.revalidation.message ?? "Run them again when you can."}`;
    return `${who} these steps. Nothing about them needed to change.`;
}

/** The plain message of a failed request, plus the list the platform sent with it (the tests a change would break, or the problems found). */
export function blockError(e: unknown): { message: string; items: string[] } {
    const message = describeApiError(e);
    if (!(e instanceof ApiError)) return { message, items: [] };
    const d = e.details as { problems?: unknown; tests?: Array<{ testId?: string; title?: string; problem?: string }>; blocks?: unknown } | undefined;
    const items: string[] = [];
    if (Array.isArray(d?.problems)) for (const p of d.problems) if (typeof p === "string" && p !== message) items.push(p);
    if (Array.isArray(d?.tests)) for (const t of d.tests) items.push(t.problem ? `${t.testId ?? ""} ${t.title ?? ""}: ${t.problem}`.trim() : `${t.testId ?? ""} ${t.title ?? ""}`.trim());
    return { message, items: items.slice(0, 8) };
}

/** A name for the parameter placeholders offered inside a block: its own parameters, then the saved sign-in names. */
export function placeholdersFor(base: Placeholders | undefined, params: BlockParam[]): Placeholders {
    return { values: params.map((p) => p.name).filter(Boolean), credentials: base?.credentials ?? ["credentials.username", "credentials.password", "credentials.totp"], env: base?.env ?? [] };
}

/** Blocks a step of this kind of test may use. */
export const fitsKind = (b: Pick<Block, "kind">, kind: "web" | "api"): boolean => b.kind === "any" || b.kind === kind;
