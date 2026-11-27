/**
 * Application model: the structured, persisted representation of what discovery learned.
 * Later stages (understanding, planning, authoring) read this instead of re-crawling or
 * relying on raw LLM context.
 *
 * Pages, their forms and components, navigation between them, API endpoints (observed, documented
 * or from an OpenAPI document), user journeys and external dependencies.
 */
import { z } from "zod";

export const PAGE_TYPES = [
    "home",
    "listing",
    "detail",
    "form",
    "cart",
    "checkout",
    "account",
    "login",
    "register",
    "dashboard",
    "search",
    "content",
    "error",
    "other",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export interface FormFieldModel {
    type: string;
    name?: string;
    label?: string;
    placeholder?: string;
    required: boolean;
    /** Constraints the page declares on the field (attributes as written; options are a select's choice labels). Absent on older models. */
    min?: string;
    max?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    options?: string[];
    /** The message shown after an invalid value was typed and the field left (nothing submitted), and which rule that value broke. */
    validation?: { check: "type" | "min" | "max" | "minLength" | "pattern" | "required"; message: string };
}

export interface FormModel {
    id?: string;
    action?: string;
    method?: string;
    fields: FormFieldModel[];
    submitLabel?: string;
    /** Heuristic classification: login, signup, search, contact, other. */
    purpose: "login" | "signup" | "search" | "contact" | "checkout" | "other";
    /** Fields that appear only after a choice in this form (found by the crawl; see discovery/crawler.ts probeConditionalFields). */
    conditional?: Array<{ when: string; shows: string[] }>;
}

export interface ComponentModel {
    role: string;
    name: string;
    /** Playwright-style locator hint, e.g. getByRole('button', { name: 'Login' }). */
    locatorHint: string;
}

export interface PageModel {
    url: string;
    path: string;
    title: string;
    type: PageType;
    /** One-sentence description of what the page is for (filled by the analyzer). */
    purpose?: string;
    depth: number;
    status: number;
    headings: string[];
    forms: FormModel[];
    components: ComponentModel[];
    links: Array<{ text: string; href: string }>;
    /** Truncated accessibility snapshot, kept for planning/authoring prompts. */
    aria: string;
    /** Visible text excerpt. */
    text: string;
    apiCalls: string[];
    /** Elements revealed by safe interactions (menus, tabs, accordions, dialogs). */
    revealed: string[];
    screenshot?: string;
    loadMs?: number;
    consoleErrors: string[];
    /** 2 when the crawl that produced the page read constraints and structures; absent on pages from older crawls. */
    discovery?: 2;
    /** Names of the dialogs the page has, open or closed, including those a safe interaction opened. */
    dialogs?: string[];
    /** Menus (role menu or menubar) with their item names. */
    menus?: Array<{ name: string; items: string[] }>;
    /** Tables and grids: name and column headers only, never cell text. */
    tables?: Array<{ name: string; headers: string[] }>;
    /** Requests a safe interaction (opening a menu, tab or dialog, "Load more") caused: the control, method and path template. */
    interactions?: Array<{ control: string; method: string; path: string }>;
    /** Links that showed only once a menu, tab or "Load more" was opened. Absent on older models. */
    revealedLinks?: Array<{ text: string; href: string }>;
    /** When this page's probes (menus, conditional fields, validation messages) last really ran (ISO). Absent on older models. */
    probedAt?: string;
    /** How many explorations in a row took the probe results without probing (memory/probe-reuse.ts). */
    reuses?: number;
    /** This exploration took the page's probe results from the exploration of `at` (the page had not changed); they were not tried again. */
    reusedFrom?: { at: string };
    /** The id of this exploration's covered thumbnail of the page (discovery/thumbnails.ts), when the project keeps them. */
    thumbnail?: string;
}

export interface ApiEndpointModel {
    method: string;
    /** Normalised path template, e.g. /api/users/{id}. */
    path: string;
    origin: string;
    statuses: number[];
    requestSchema?: Record<string, unknown>;
    responseSchema?: Record<string, unknown>;
    sampleRequestBody?: unknown;
    /** First concrete path+query observed on the wire (ids intact) � lets happy-path tests replay a real request. */
    examplePath?: string;
    queryParams: string[];
    requiresAuth?: boolean;
    source: "network" | "openapi" | "documentation";
    summary?: string;
    /** OpenAPI parameter / body detail when source = openapi. */
    spec?: OpenApiOperation;
    usedIn: string[];
}

export interface OpenApiParameter {
    name: string;
    location: "query" | "path" | "header" | "cookie";
    required: boolean;
    type: string;
    enum?: unknown[];
    example?: unknown;
}

export interface OpenApiOperation {
    operationId?: string;
    tags: string[];
    parameters: OpenApiParameter[];
    requestBody?: { required: boolean; contentType: string; schema: Record<string, unknown> };
    /** contentType: the answer's first documented media type ("application/json", "text/event-stream"), when the document gives one. */
    responses: Array<{ status: string; description: string; schema?: Record<string, unknown>; contentType?: string }>;
    security: string[];
}

export interface JourneyModel {
    name: string;
    description: string;
    steps: string[];
    priority: "critical" | "high" | "medium" | "low";
    pages: string[];
    requiresAuth: boolean;
    /**
     * Per step (same order as `steps`), the page it happens on and the API request it sends, as the analysis named them from the crawl's
     * pages and the listed requests. Absent when the analysis was not asked for them (an older runner) or on models stored before it.
     */
    stepLinks?: Array<{ page?: string; endpoint?: string }>;
}

export interface NavigationEdge {
    from: string;
    to: string;
    label: string;
}

export interface AppModel {
    url: string;
    origin: string;
    siteType: string;
    purpose: string;
    features: string[];
    pages: PageModel[];
    navigation: NavigationEdge[];
    apis: ApiEndpointModel[];
    openApi?: { url: string; version: string; title: string; operationCount: number; baseUrl: string };
    authentication: {
        required: boolean;
        loginPath?: string;
        signupPath?: string;
        mechanisms: string[];
        loggedIn: boolean;
        loginError?: string;
    };
    journeys: JourneyModel[];
    /** Hosts the app talks to that are not its own (analytics, CDNs, payment providers...). */
    externalDependencies: string[];
    /** WebSocket endpoints the app's pages opened while exploring (no query string), and on which pages. Absent on older models. */
    webSockets?: Array<{ url: string; usedIn: string[] }>;
    /** Test cases / API docs found on the site itself (e.g. /test_cases, /api_list), see discovery/docs.ts. */
    documentedTestCases: Array<{ id?: string; name: string; description?: string; steps?: string[]; category?: string }>;
    stats: { pagesVisited: number; pagesSkipped: number; apisFound: number; durationMs: number };
    /** Only for an Android app explored by the AI on a phone: its screens, how they connect, forms and sign-in (see mobile/explore/types.ts). */
    mobile?: import("../mobile/explore/types.js").MobileAppModel;
    /** Screens and the actions that lead between them (see ../screenmap/map.ts). Absent on models stored before it existed. */
    screenMap?: import("../screenmap/map.js").ScreenMap;
    /**
     * Pages only the project's test accounts reached (an admin's page when the project signs in as a user), with who reached them
     * (../screenmap/map.ts rolePagesOf). Not part of `pages`: checks made from `pages` run as the project's own account. Absent on older models.
     */
    rolePages?: Array<PageModel & { reachedBy: string[] }>;
}

/** Schema the analyzer asks the LLM to fill in. */
export const AnalysisSchema = z.object({
    siteType: z.string().describe("e.g. ecommerce, saas, blog, dashboard, landing, webapp, documentation"),
    purpose: z.string(),
    features: z.array(z.string()).describe("Distinct user-facing capabilities"),
    pagePurposes: z
        .array(z.object({ path: z.string(), type: z.enum(PAGE_TYPES), purpose: z.string() }))
        .describe("One entry per discovered page path"),
    journeys: z
        .array(
            z.object({
                name: z.string(),
                description: z.string(),
                steps: z.array(z.string()).min(1),
                priority: z.enum(["critical", "high", "medium", "low"]),
                pages: z.array(z.string()).describe("Paths involved, in order"),
                requiresAuth: z.boolean(),
            }),
        )
        .describe("Important end-to-end user journeys"),
    authenticationMechanisms: z.array(z.string()).default([]),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** A journey step as the linked analysis gives it; a plain sentence is still taken (no page or request named). */
const LinkedStepSchema = z.union([
    z.object({
        action: z.string(),
        page: z.string().describe("Exact crawl path of the page the step happens on; empty when unsure"),
        endpoint: z.string().describe('The request the step sends, exactly as listed ("METHOD /path"); empty when it sends none of them'),
    }),
    z.string(),
]);

/** AnalysisSchema with each journey step naming its page and request (the page understanding additions; an older runner asks AnalysisSchema). */
export const LinkedAnalysisSchema = AnalysisSchema.extend({
    journeys: z
        .array(AnalysisSchema.shape.journeys.element.extend({ steps: z.array(LinkedStepSchema).min(1) }))
        .describe("Important user journeys, one feature each"),
});
export type LinkedAnalysis = z.infer<typeof LinkedAnalysisSchema>;
