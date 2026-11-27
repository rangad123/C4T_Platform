/**
 * What a pull request's change reaches, on evidence only (testing-engine Phase 6). Each step is a link with the evidence that makes it:
 *
 *   changed files and functions (diff.ts) → route handlers that hold or call them (routes.ts) → endpoints and pages → tests whose
 *   declared or observed footprint hits one (selection/coverage.ts) → app-model workflows whose steps send or open one → rules that name
 *   such an endpoint or workflow → the entities those rules name → requirements linked to a reached test → past findings on a reached
 *   endpoint or page. A changed line of a document that is a requirement of the project (its id leads the line, or the line holds its
 *   stored text) is a changed requirement, and the tests linked to it are reached through it.
 *
 * A script under a folder the server hands to the browser as it is (public/, static/, www/, wwwroot/) is page code: it is listed with
 * why, and never followed as server code (its top-level calls run in the page, not before every request).
 *
 * Nothing is linked by a similar name: a file called `cart-routes.mjs` that registers no route reaches nothing. A changed file with no
 * evidence-backed route is listed as unmapped, with why. A change in code that runs outside every route handler (a session check before
 * routing) is "shared": it reaches every request, which no footprint can narrow.
 *
 * Optional, off by default: one AI call per PR to link changed hunks to requirement ids. Every id it cites must be one it was given and
 * every file one of the PR's; anything else is dropped and counted. Its links are marked as AI suggestions, never as evidence.
 */
import { z } from "zod";
import type { AppModel, Rule } from "../intel/model.js";
import type { LlmClient } from "../llm/provider.js";
import type { CoverageItem, TestCoverage } from "../../platform/selection/coverage.js";
import { matchesChange, readChanges, type ChangeItem } from "../../platform/selection/preview.js";
import { analyzeFile, isJsLike, type FileChangeInput } from "./diff.js";
import { describeRoute, routesForChange, routeTemplate, type RouteEntry } from "./routes.js";

/** A finding seen before, by where it happened (the platform reads them from the findings list: platform/findings/past.ts). */
export interface PastFinding {
    id: string;
    title: string;
    /** "POST /api/orders" */
    endpoints?: string[];
    /** "/checkout" */
    pages?: string[];
}

export interface ImpactInput {
    /** The PR's files, with patches (code-host/github.ts files()). */
    files: FileChangeInput[];
    /** The new side of the checkout: path → content. Routes are looked for in these files only. */
    sources: Record<string, string>;
    tests?: TestCoverage[];
    /** The path of the API's base address ("/api"), as the preview takes it. */
    apiPrefix?: string;
    model?: Pick<AppModel, "pages" | "workflows">;
    rules?: Array<Pick<Rule, "ref" | "description" | "endpoints" | "workflows" | "entities">>;
    /** requirement_links rows: a requirement and a test that covers it. */
    requirementLinks?: Array<{ requirement: string; testId: string }>;
    /** The project's requirements: a changed document line that carries one is a changed requirement. */
    requirements?: Array<{ ref: string; text: string }>;
    findings?: PastFinding[];
    /** Off unless given: one AI call to link hunks to these requirements. */
    ai?: { client: Pick<LlmClient, "object">; requirements: Array<{ ref: string; text: string }> };
}

export interface Link {
    id: string;
    name: string;
    evidence: string[];
}

export interface ImpactEndpoint {
    route: string;
    method: string;
    path: string;
    evidence: string[];
}

export interface ImpactAnalysis {
    files: Array<{ path: string; functions: string[]; mapped: boolean }>;
    endpoints: ImpactEndpoint[];
    tests: Link[];
    workflows: Link[];
    rules: Link[];
    entities: Link[];
    requirements: Link[];
    /** Requirements whose text the change edits, each with the changed lines. */
    changedRequirements: Link[];
    /** Tests linked to a changed requirement. */
    requirementTests: Link[];
    findings: Link[];
    /** Changed files with no evidence-backed route, and why. */
    unmapped: Array<{ path: string; why: string[] }>;
    /** Changed files that are not application code (the repository's own tests, build scripts), with why: not in `files` or `unmapped`. */
    notApp: Array<{ path: string; why: string }>;
    /** Changed code that runs outside every route handler, so it reaches every request. */
    shared: string[];
    /** The reached routes as a change set for the preview (selection/preview.ts readChanges). */
    changes: { pages: string[]; endpoints: string[] };
    /** The optional AI requirement links: what it suggested, and how many citations were dropped. Absent when the call was off. */
    ai?: { links: Link[]; dropped: number };
}

/** The change set a route stands for: its endpoint, and for GET or any-method routes the page at that path (a page load requests it). */
function routeChanges(r: RouteEntry): { endpoints: string[]; pages: string[] } {
    return { endpoints: [r.method === "*" ? r.path : `${r.method} ${r.path}`], pages: r.method === "*" || r.method === "GET" ? [r.path] : [] };
}

const asItem = (c: ChangeItem): CoverageItem => ({ kind: c.kind, path: c.path, ...(c.method ? { method: c.method } : {}), ...(c.host ? { host: c.host } : {}), query: [], source: "declared", seenIn: [] });

/** Each workflow step that sends a request or happens on a page, as a page or an endpoint. */
export function workflowSteps(model: Pick<AppModel, "pages" | "workflows">): Array<{ workflow: { id: string; name: string }; order: number; item: CoverageItem; text: string }> {
    const pagePath = new Map(model.pages.map((p) => [p.id, p.path]));
    const out: ReturnType<typeof workflowSteps> = [];
    for (const w of model.workflows) {
        for (const s of w.steps) {
            const page = s.page ? pagePath.get(s.page) : undefined;
            const { changes } = readChanges({ ...(s.endpoint ? { endpoints: [s.endpoint] } : {}), ...(page ? { pages: [page] } : {}) });
            for (const c of changes) out.push({ workflow: { id: w.id, name: w.name }, order: s.order, item: asItem(c), text: c.kind === "endpoint" ? `sends ${c.given}` : `happens on ${c.given}` });
        }
    }
    return out;
}

export const AiLinks = z.object({ links: z.array(z.object({ requirement: z.string(), file: z.string(), line: z.number().int().optional(), why: z.string().max(500) })).max(50) });
/** Long key-like string literals are not sent (tokens, keys); shortcut: a pattern, not a secret scanner, upgrade if real repositories need one. */
const maskLine = (l: string) => l.replace(/(["'`])[A-Za-z0-9_+/=-]{20,}\1/g, "$1[hidden]$1");

async function aiRequirementLinks(ai: NonNullable<ImpactInput["ai"]>, files: FileChangeInput[]): Promise<{ links: Link[]; dropped: number }> {
    const hunks = files
        .filter((f) => f.patch)
        .map((f) => `File ${f.path}\n${f.patch!.split("\n").slice(0, 200).map(maskLine).join("\n")}`)
        .join("\n\n")
        .slice(0, 20_000);
    const out = await ai.client.object({
        system: "You link changed code to the requirements it affects. Cite only requirement ids from the list and files from the diff. Say why in one sentence. No link when unsure.",
        prompt: `Requirements:\n${ai.requirements.map((r) => `${r.ref}: ${r.text.slice(0, 300)}`).join("\n")}\n\nDiff:\n${hunks}`,
        schema: AiLinks,
        purpose: "analysis",
    });
    const refs = new Map(ai.requirements.map((r) => [r.ref.trim().toUpperCase(), r.ref]));
    const paths = new Set(files.map((f) => f.path));
    const links = new Map<string, Link>();
    let dropped = 0;
    for (const l of out.links) {
        const ref = refs.get(l.requirement.trim().toUpperCase());
        if (!ref || !paths.has(l.file)) {
            dropped++;
            continue;
        }
        const link = links.get(ref) ?? { id: ref, name: ref, evidence: [] };
        link.evidence.push(`AI suggestion, not verified: ${l.file}${l.line ? `:${l.line}` : ""}: ${l.why}`);
        links.set(ref, link);
    }
    return { links: [...links.values()], dropped };
}

/** shortcut: by folder name, not by reading how the server serves files; upgrade if a repository serves its browser code from elsewhere. */
export const BROWSER_DIR = /(^|\/)(public|static|www|wwwroot)\//;
const HTML = /\.html?$/i;
/** The repository's own tests: they change no application behaviour. */
const TEST_FILE = /(^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
/** A script folder outside the server: a script there that writes into the browser folder is a build script (its output is analysed itself). */
const TOOL_DIR = /(^|\/)(?:scripts|tools|bin)\//;
const writesBrowserFiles = (src: string | undefined) => !!src && /\bwrite(?:File|FileSync)\b/.test(src) && /(["'`])(?:\.\.?\/)*(?:public|static|www|wwwroot)\1|\/(?:public|static|www|wwwroot)(["'`])/.test(src);

/** The address a browser-folder file is served at ("/assets/order.js"). */
function servedAt(file: string): string | undefined {
    const m = BROWSER_DIR.exec(file);
    return m ? `/${file.slice(m.index + m[0].length)}` : undefined;
}

/** Scripts a page or module loads: <script src>, import … from, import(). */
const LOADS = /(?:\bsrc\s*=\s*|\bfrom\s+|\bimport\s*\(?\s*)["']([^"'?#]+\.m?js)["']/g;

/**
 * The pages a changed browser-folder file is part of, each with its evidence. A page file: a server file that names it on the same line
 * as an address (a page table: `['/checkout/review', 'checkout-review.html']`), else its own address or that address without `.html`
 * when the app's tests or model open a page there. A script: the pages of every page or script in the browser folder that loads it.
 */
function pagesOf(file: string, sources: Record<string, string>, known: Set<string>, seen = new Set<string>()): Array<{ route: RouteEntry; evidence: string[] }> {
    const at = servedAt(file);
    if (!at || seen.has(file)) return [];
    seen.add(file);
    if (HTML.test(file)) {
        // An address and the file's name side by side (`'/checkout/review', 'checkout-review.html'`), in either order.
        const name = at.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pair = new RegExp(`(["'\`])(\\/[^"'\`\\s]*)\\1\\s*,\\s*(["'\`])${name}\\3|(["'\`])${name}\\4\\s*,\\s*(["'\`])(\\/[^"'\`\\s]*)\\5`, "g");
        const out: Array<{ route: RouteEntry; evidence: string[] }> = [];
        for (const [src, text] of Object.entries(sources)) {
            if (BROWSER_DIR.test(src) || TEST_FILE.test(src) || !isJsLike(src)) continue;
            text.split("\n").forEach((l, i) => {
                for (const m of l.matchAll(pair)) {
                    const addr = (m[2] ?? m[6])!;
                    const route: RouteEntry = { file: src, method: "GET", path: routeTemplate(addr), line: i + 1, start: i + 1, end: i + 1, style: "table" };
                    out.push({ route, evidence: [`${src}:${i + 1} serves ${file} at ${addr}`] });
                }
            });
        }
        if (out.length) return out;
        const bare = at.replace(/(?:\/index)?\.html?$/i, "") || "/";
        return [...new Set([at, bare])]
            .filter((p) => known.has(p))
            .map((p) => ({ route: { file, method: "GET", path: routeTemplate(p), line: 1, start: 1, end: 1, style: "table" }, evidence: [`${file} is served from the browser folder at ${p}, a page the app's tests or model open`] }));
    }
    const out: Array<{ route: RouteEntry; evidence: string[] }> = [];
    for (const [src, text] of Object.entries(sources)) {
        const from = servedAt(src);
        if (!from || src === file) continue;
        const loads = [...text.matchAll(LOADS)].some((m) => new URL(m[1]!, `http://x${from}`).pathname === at);
        if (!loads) continue;
        for (const p of pagesOf(src, sources, known, seen)) out.push({ route: p.route, evidence: [`${src} loads ${at}`, ...p.evidence] });
    }
    return out;
}

/** Documents a requirement can be written in. */
const DOC = /\.(?:md|markdown|txt|rst|adoc)$/i;

/** Each added or removed line of a patch, with the new-side line it is at. */
function changedLines(patch: string): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    let n = 0;
    let inHunk = false;
    for (const l of patch.split(/\r?\n/)) {
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (h) {
            n = Number(h[1]);
            inHunk = true;
        } else if (!inHunk || l.startsWith("\\")) continue;
        else if (l.startsWith("+")) out.push({ line: n++, text: l.slice(1) });
        else if (l.startsWith("-")) out.push({ line: Math.max(1, n), text: l.slice(1) });
        else n++;
    }
    return out;
}

const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** The requirements a changed line carries: its id leads the line (after list or heading marks), or the line holds its stored text. */
function requirementsOn(text: string, reqs: NonNullable<ImpactInput["requirements"]>): string[] {
    const bare = text.replace(/^[\s>*+#-]*/, "");
    return reqs.filter((r) => (r.ref && bare.startsWith(r.ref) && /^(\s|:|\)|$)/.test(bare.slice(r.ref.length))) || (r.text.trim().length >= 20 && flat(bare).includes(flat(r.text)))).map((r) => r.ref);
}

/** The impact of one PR. Pure apart from the optional AI call. */
export async function analyzeImpact(input: ImpactInput): Promise<ImpactAnalysis> {
    const files: ImpactAnalysis["files"] = [];
    const unmapped: ImpactAnalysis["unmapped"] = [];
    const notApp: ImpactAnalysis["notApp"] = [];
    const shared: string[] = [];
    const known = new Set([...(input.model?.pages ?? []).map((p) => p.path), ...(input.tests ?? []).flatMap((t) => t.items.filter((i) => i.kind === "page").map((i) => i.path))].map((p) => p.replace(/(.)\/$/, "$1")));
    const endpoints = new Map<string, ImpactEndpoint & { entry: RouteEntry }>();
    const changedReqs = new Map<string, { link: Link; at: string }>();
    for (const f of input.files) {
        if (DOC.test(f.path) && f.patch && input.requirements?.length) {
            for (const c of changedLines(f.patch))
                for (const ref of requirementsOn(c.text, input.requirements)) {
                    const at = `${f.path}:${c.line}`;
                    const r = changedReqs.get(ref.toUpperCase()) ?? { link: { id: ref, name: ref, evidence: [] }, at };
                    if (!r.link.evidence.includes(`${at} changes requirement ${ref}`)) r.link.evidence.push(`${at} changes requirement ${ref}`);
                    changedReqs.set(ref.toUpperCase(), r);
                }
            if ([...changedReqs.values()].some((r) => r.at.startsWith(`${f.path}:`))) {
                files.push({ path: f.path, functions: [], mapped: true });
                continue;
            }
        }
        if (BROWSER_DIR.test(f.path) && (isJsLike(f.path) || HTML.test(f.path))) {
            const pages = pagesOf(f.path, input.sources, known);
            for (const p of pages) {
                const key = `${p.route.method} ${p.route.path}`;
                if (!endpoints.has(key)) endpoints.set(key, { route: describeRoute(p.route), method: p.route.method, path: p.route.path, evidence: p.evidence, entry: p.route });
            }
            files.push({ path: f.path, functions: [], mapped: pages.length > 0 });
            if (!pages.length) unmapped.push({ path: f.path, why: [`${f.path} is served to the browser (page code): it runs in the pages that load it, not in a route handler on the server.`] });
            continue;
        }
        const change = analyzeFile(f, input.sources[f.path]);
        const r = change.touched.length ? routesForChange(input.sources, f.path, change.touched) : { hits: [], unresolved: [] };
        for (const h of r.hits) {
            const key = `${h.route.method} ${h.route.path}`;
            if (!endpoints.has(key)) endpoints.set(key, { route: describeRoute(h.route), method: h.route.method, path: h.route.path, evidence: h.evidence, entry: h.route });
        }
        // routes.ts words a use in code outside every handler (a check before routing) this way: that code runs for every request.
        shared.push(...r.unresolved.filter((u) => / is used at .*, outside every route handler\.$/.test(u)));
        if (!r.hits.length && (TEST_FILE.test(f.path) || (TOOL_DIR.test(f.path) && writesBrowserFiles(input.sources[f.path])))) {
            notApp.push({ path: f.path, why: TEST_FILE.test(f.path) ? `${f.path} is one of the repository's own tests.` : `${f.path} is a build script: it writes files into the browser folder, and those files are analysed themselves.` });
            continue;
        }
        files.push({ path: f.path, functions: change.functions.map((x) => x.name), mapped: r.hits.length > 0 });
        if (!r.hits.length) {
            const why = [...(change.note ? [change.note] : []), ...r.unresolved];
            unmapped.push({ path: f.path, why: why.length ? why : [change.touched.length ? "The changed lines reach no route." : "No changed lines (a rename or a mode change only)."] });
        }
    }

    const reached = [...endpoints.values()].map((e) => {
        const c = routeChanges(e.entry);
        return { e, items: readChanges(c).changes };
    });
    const changes = { pages: [...new Set(reached.flatMap((r) => routeChanges(r.e.entry).pages))], endpoints: [...new Set(reached.flatMap((r) => routeChanges(r.e.entry).endpoints))] };
    /** The reached route an item (a test's footprint entry, a workflow step) hits, if any. */
    const routeOf = (item: CoverageItem) => reached.find((r) => r.items.some((c) => matchesChange(c, item, input.apiPrefix)))?.e;

    const tests: Link[] = [];
    for (const t of input.tests ?? []) {
        const evidence: string[] = [];
        for (const item of t.items) {
            const e = routeOf(item);
            if (!e) continue;
            const how = item.source === "declared" ? `its steps ${item.kind === "page" ? "open" : "call"}` : `a recorded run ${item.kind === "page" ? "opened" : "called"}`;
            evidence.push(`${how} ${item.method ? `${item.method} ` : ""}${item.path} (${item.seenIn.join(", ") || item.source}), handled by ${e.route}`);
        }
        if (evidence.length) tests.push({ id: t.testId, name: `${t.testKey} ${t.title}`, evidence });
    }

    const workflows = new Map<string, Link>();
    for (const s of input.model ? workflowSteps(input.model) : []) {
        const e = routeOf(s.item);
        if (!e) continue;
        const w = workflows.get(s.workflow.id) ?? { id: s.workflow.id, name: s.workflow.name, evidence: [] };
        w.evidence.push(`step ${s.order} ${s.text}, handled by ${e.route}`);
        workflows.set(s.workflow.id, w);
    }

    const rules: Link[] = [];
    const entities = new Map<string, Link>();
    for (const rule of input.rules ?? []) {
        const evidence: string[] = [];
        for (const ep of rule.endpoints) {
            const { changes: cs } = readChanges({ endpoints: [ep] });
            const e = cs[0] && routeOf(asItem(cs[0]));
            if (e) evidence.push(`names ${ep}, handled by ${e.route}`);
        }
        for (const wid of rule.workflows) if (workflows.has(wid)) evidence.push(`belongs to the reached workflow ${workflows.get(wid)!.name}`);
        if (!evidence.length) continue;
        rules.push({ id: rule.ref, name: rule.description.slice(0, 200), evidence });
        for (const ent of rule.entities) {
            const l = entities.get(ent) ?? { id: ent, name: ent, evidence: [] };
            l.evidence.push(`named by the reached rule ${rule.ref}`);
            entities.set(ent, l);
        }
    }

    const reachedTests = new Map(tests.map((t) => [t.id, t]));
    const requirements = new Map<string, Link>();
    for (const l of input.requirementLinks ?? []) {
        const t = reachedTests.get(l.testId);
        if (!t) continue;
        const r = requirements.get(l.requirement) ?? { id: l.requirement, name: l.requirement, evidence: [] };
        r.evidence.push(`linked to the reached test ${t.name}`);
        requirements.set(l.requirement, r);
    }

    const testName = (id: string) => {
        const t = input.tests?.find((x) => x.testId === id);
        return t ? `${t.testKey} ${t.title}` : id;
    };
    const requirementTests = new Map<string, Link>();
    for (const l of input.requirementLinks ?? []) {
        const r = changedReqs.get(l.requirement.trim().toUpperCase());
        if (!r) continue;
        const t = requirementTests.get(l.testId) ?? { id: l.testId, name: testName(l.testId), evidence: [] };
        t.evidence.push(`linked to requirement ${r.link.id}, which this change edits (${r.at})`);
        requirementTests.set(l.testId, t);
    }

    const findings: Link[] = [];
    for (const f of input.findings ?? []) {
        const { changes: cs } = readChanges({ endpoints: f.endpoints ?? [], pages: f.pages ?? [] });
        const evidence = cs.flatMap((c) => {
            const e = routeOf(asItem(c));
            return e ? [`found on ${c.given}, handled by ${e.route}`] : [];
        });
        if (evidence.length) findings.push({ id: f.id, name: f.title, evidence });
    }

    return {
        files,
        endpoints: [...endpoints.values()].map(({ entry: _entry, ...e }) => e),
        tests,
        workflows: [...workflows.values()],
        rules,
        entities: [...entities.values()],
        requirements: [...requirements.values()],
        changedRequirements: [...changedReqs.values()].map((r) => r.link),
        requirementTests: [...requirementTests.values()],
        findings,
        unmapped,
        notApp,
        shared,
        changes,
        ...(input.ai ? { ai: await aiRequirementLinks(input.ai, input.files) } : {}),
    };
}
