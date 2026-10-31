/**
 * Documentation a site publishes about itself: some practice and demo sites list their own test cases (/test_cases) or
 * their API (/api_list, /docs). After the crawl, a few likely pages are opened; the ones that read like test or API
 * documentation are given to the model, which lists the test cases and endpoints on them. The test cases become
 * `documentedTestCases` (the planner covers them) and the endpoints join the discovered APIs.
 *
 * Bounded: at most MAX_PAGES_OPENED pages and MAX_MODEL_CALLS model calls. Never fails discovery: a page that cannot be
 * read is skipped, and without a model (or once the AI limit is reached) the result is empty.
 */
import { z } from "zod";
import { throwIfAborted, type EngineContext } from "../context.js";
import { LlmNotConfiguredError } from "../llm/provider.js";
import type { ApiEndpointModel, AppModel } from "../understanding/app-model.js";
import { settle, type BrowserSession } from "./browser.js";
import { normalizeApiPath } from "./network.js";

const MAX_PAGES_OPENED = 6;
const MAX_MODEL_CALLS = 2;
const MAX_PAGE_TEXT = 6_000;

/**
 * Does a same-origin path look like a documentation page? Its first segment names one (docs, readme, swagger,
 * test_cases, api_list...), or it is the API's root, version root or docs.
 */
const DOC_FIRST_SEGMENT = /^(docs?|documentation|readme|swagger(-ui)?(\.html)?|redoc|test[-_]?cases?|api[-_](list|docs|reference))$/;
const DOC_API_PATH = /^\/api(\/(v\d+|docs)(\/.*)?)?$/;
export function isDocumentationPath(pathname: string): boolean {
    const p = pathname.toLowerCase().replace(/\/+$/, "");
    return DOC_FIRST_SEGMENT.test(p.split("/")[1] ?? "") || DOC_API_PATH.test(p);
}

/** Tried on every site even when no link points at them, after the linked pages: the two common practice-site pages first. */
const WELL_KNOWN_DOC_PATHS = ["/test_cases", "/api_list", "/test-cases", "/api-list", "/docs", "/documentation"];

/** The model's answer for one page. Missing lists and fields get defaults, so a partial answer still counts. */
const PageDocumentation = z.object({
    testCases: z
        .array(
            z.object({
                id: z.string().optional(),
                name: z.string(),
                description: z.string().optional().default(""),
                steps: z.array(z.string()).optional().default([]),
                category: z.string().optional().default(""),
            }),
        )
        .default([]),
    apis: z
        .array(
            z.object({
                name: z.string(),
                method: z.string().default("GET"),
                endpoint: z.string(),
                description: z.string().optional().default(""),
                expectedStatus: z.number().optional().default(200),
            }),
        )
        .default([]),
});

export interface DocumentedApi {
    name: string;
    method: string;
    endpoint: string;
    description?: string;
    expectedStatus?: number;
    /** Path of the documentation page it was read from. */
    foundOn?: string;
}

export interface DocumentationResult {
    testCases: AppModel["documentedTestCases"];
    apis: DocumentedApi[];
}

/** Worth a model call? Only text that talks about test cases or scenarios, or about an API's endpoints or methods. */
export function looksLikeDocumentation(text: string): boolean {
    if (/\btest[\s_-]?(cases?|scenarios?)\b/i.test(text)) return true;
    return /\bapis?\b/i.test(text) && /\b(endpoints?|methods?)\b/i.test(text);
}

/** A "page not found" served with status 200. Only the title and the opening words count: API docs often mention 404. */
function isSoftNotFound(title: string, text: string): boolean {
    return /\b404\b|not found/i.test(title) || /^\W*(404\b|(page )?not found)/i.test(text.trim().slice(0, 300));
}

/** "Request Method: POST", "get" → POST, GET. Anything without a method word is a GET. */
function httpMethod(text: string): string {
    return /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i.exec(text)?.[1]?.toUpperCase() ?? "GET";
}

/** The model is out of reach for the rest of this run: none is set up, or the AI limit was reached. */
function modelUnavailable(err: unknown): { unavailable: boolean; reason: string } {
    const name = (err as Error | undefined)?.name;
    if (err instanceof LlmNotConfiguredError || name === "LlmNotConfiguredError") return { unavailable: true, reason: "no LLM configured" };
    const reason = (err as Error | undefined)?.message ?? String(err);
    return { unavailable: name === "BudgetExceeded", reason };
}

function extractionPrompt(url: string, title: string, text: string): string {
    return `A page of the application under test, which may document its own test cases or API.

Address: ${url}
Title: ${title}

Text of the page:
${text.slice(0, MAX_PAGE_TEXT)}

List what the page documents:
- testCases: each test case on the page, with its id or number if it has one, its name, its steps in order, a one-line description and its category if given.
- apis: each API endpoint on the page, with a name, the HTTP method, the path or full address, a one-line description and the response code it documents.
Copy names, paths and steps as the page writes them. If the page documents neither, answer with two empty lists.`;
}

/** Same-origin documentation pages: the linked ones first, in link order, then the well-known paths. No repeats. */
function pagesToOpen(origin: string, links: Array<{ href: string; text?: string }>): string[] {
    const urls: string[] = [];
    const add = (url: string) => {
        if (!urls.includes(url)) urls.push(url);
    };
    for (const link of links) {
        let u: URL;
        try {
            u = new URL(link.href, origin);
        } catch {
            continue;
        }
        if (u.origin === origin && isDocumentationPath(u.pathname)) add(u.origin + u.pathname + u.search);
    }
    for (const p of WELL_KNOWN_DOC_PATHS) add(origin + p);
    return urls.slice(0, MAX_PAGES_OPENED);
}

/** Open a candidate page and read it; undefined when it is missing, elsewhere, empty or not readable. */
async function readPage(session: BrowserSession, origin: string, url: string): Promise<{ url: string; title: string; text: string } | undefined> {
    const { page } = session;
    try {
        session.network.setCurrentPage(url);
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (!res || res.status() >= 400) return undefined;
        await settle(page, 2_000);
        const landed = page.url();
        if (new URL(landed).origin !== origin) return undefined;
        const title = await page.title();
        const text = await page.locator("body").innerText({ timeout: 5_000 });
        return text.trim() ? { url: landed, title, text } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Read the documentation pages of a site. `links` are the links the crawl found; same-origin ones that look like
 * documentation are opened first. Stops early once both test cases and endpoints were found.
 */
export async function scrapeDocumentationPages(
    session: BrowserSession,
    ctx: EngineContext,
    origin: string,
    links: Array<{ href: string; text?: string }>,
): Promise<DocumentationResult> {
    const found: DocumentationResult = { testCases: [], apis: [] };
    const knownTests = new Set<string>();
    let modelCalls = 0;

    for (const candidate of pagesToOpen(origin, links)) {
        if (modelCalls === MAX_MODEL_CALLS || (found.testCases.length && found.apis.length)) break;
        throwIfAborted(ctx.signal);
        const read = await readPage(session, origin, candidate);
        if (!read || isSoftNotFound(read.title, read.text) || !looksLikeDocumentation(read.text)) continue;

        const path = new URL(read.url).pathname;
        modelCalls++;
        let answer: z.infer<typeof PageDocumentation>;
        try {
            answer = await ctx.llm.object({
                system: "You read documentation pages for a QA team and list, completely and without inventing anything, the test cases and API endpoints they describe.",
                prompt: extractionPrompt(read.url, read.title, read.text),
                schema: PageDocumentation,
                maxOutputTokens: 3_000,
                purpose: "analysis",
            });
        } catch (err) {
            const { unavailable, reason } = modelUnavailable(err);
            ctx.emit({ stage: "discovery", kind: "documentation_found", level: "warn", message: `Documentation page ${path} found but not extracted: ${reason}`, data: { url: read.url } });
            // Every further page would be refused the same way.
            if (unavailable) return { testCases: [], apis: [] };
            continue;
        }

        let tests = 0;
        for (const t of answer.testCases) {
            const key = (t.id || t.name).toLowerCase();
            if (!t.name.trim() || knownTests.has(key)) continue;
            knownTests.add(key);
            tests++;
            found.testCases.push({ id: t.id || undefined, name: t.name, description: t.description || undefined, steps: t.steps.length ? t.steps : undefined, category: t.category || undefined });
        }
        let endpoints = 0;
        for (const a of answer.apis) {
            const endpoint = a.endpoint.trim();
            if (!endpoint) continue;
            endpoints++;
            found.apis.push({ name: a.name, method: httpMethod(a.method), endpoint, description: a.description || undefined, expectedStatus: a.expectedStatus, foundOn: path });
        }
        ctx.emit({
            stage: "discovery",
            kind: "documentation_found",
            message: `Documentation page ${path}: ${tests} test cases, ${endpoints} API endpoints`,
            data: { url: read.url, testCases: tests, apis: endpoints },
        });
    }
    return found;
}

/**
 * Documented endpoints as ApiEndpointModels (source "documentation"), comparable with the ones from an OpenAPI document
 * or from traffic: "GET /x" prefixes are dropped, relative paths resolved against the origin, and `:id`, `<id>`, `{id}`
 * and id-like segments become `{...}` templates. A concrete address is kept as the example to call; a templated one has
 * no real id, so it has none.
 */
export function documentedApiModels(apis: DocumentedApi[], origin: string): ApiEndpointModel[] {
    return apis.flatMap((a): ApiEndpointModel[] => {
        let u: URL, pathname: string;
        try {
            const address = a.endpoint.replace(/^[a-z]+\s+(?=\/|https?:)/i, "");
            u = new URL(/^(https?:\/\/|\/)/i.test(address) ? address : `/${address}`, origin);
            pathname = decodeURI(u.pathname); // the URL parser percent-encodes { } < >
        } catch {
            return [];
        }
        const templated = /[{:<]/.test(pathname);
        return [
            {
                method: a.method.toUpperCase(),
                path: normalizeApiPath(pathname.replace(/[:<](\w+)>?/g, "{$1}")),
                origin: u.origin,
                statuses: a.expectedStatus ? [a.expectedStatus] : [],
                examplePath: templated ? undefined : u.pathname + u.search,
                queryParams: [...u.searchParams.keys()],
                source: "documentation",
                summary: a.description || a.name,
                usedIn: a.foundOn ? [a.foundOn] : [],
            },
        ];
    });
}
