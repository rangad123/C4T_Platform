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
    /** First concrete path+query observed on the wire (ids intact) — lets happy-path tests replay a real request. */
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
    responses: Array<{ status: string; description: string; schema?: Record<string, unknown> }>;
    security: string[];
}

export interface JourneyModel {
    name: string;
    description: string;
    steps: string[];
    priority: "critical" | "high" | "medium" | "low";
    pages: string[];
    requiresAuth: boolean;
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
    /** Test cases / API docs found on the site itself (e.g. /test_cases, /api_list), see discovery/docs.ts. */
    documentedTestCases: Array<{ id?: string; name: string; description?: string; steps?: string[]; category?: string }>;
    stats: { pagesVisited: number; pagesSkipped: number; apisFound: number; durationMs: number };
    /** Only for an Android app explored by the AI on a phone: its screens, how they connect, forms and sign-in (see mobile/explore/types.ts). */
    mobile?: import("../mobile/explore/types.js").MobileAppModel;
    /** Screens and the actions that lead between them (see ../screenmap/map.ts). Absent on models stored before it existed. */
    screenMap?: import("../screenmap/map.js").ScreenMap;
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
