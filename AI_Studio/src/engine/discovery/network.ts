/**
 * API discovery from browser traffic: while the crawler walks the app, every fetch/XHR the page makes is folded into one
 * ApiEndpointModel per method + origin + path template. Nothing secret is kept: credential-like body fields and query
 * parameters are replaced before they are stored, because example paths and request bodies are replayed by generated tests.
 */
import type { Page, Request, Response } from "playwright";
import type { ApiEndpointModel } from "../understanding/app-model.js";

/** Path segments that are record ids: plain numbers, UUIDs and 24-hex object ids. */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i;

/** One endpoint for /api/users/12 and /api/users/13: id segments become `{id}`. */
export function normalizeApiPath(pathname: string): string {
    return pathname.replace(/[^/]+/g, (segment) => (ID_SEGMENT.test(segment) ? "{id}" : segment));
}

/**
 * Field and query-parameter names whose values are credentials or personal secrets. Short words only match the whole
 * name, so ordinary fields (postcode, author, spinner) keep their values.
 */
const SECRET_NAME = /pass(word)?|secret|token|authoriz|api[-_]?key|session|signature|card|cvv|cvc|cookie|^(auth|sig|otp|pin|code)$/i;

const REDACTED = "[redacted]";
/** How far into a JSON body the redaction and the shape description go, and how many array items a sample keeps. */
const MAX_SAMPLE_DEPTH = 4;
const MAX_SAMPLE_ITEMS = 3;
const MAX_SHAPE_DEPTH = 3;

/** The query string of an address with every secret-looking parameter's value replaced ("" when there is none). */
export function redactQuery(u: URL): string {
    const params = new URLSearchParams(u.search);
    for (const name of new Set(params.keys())) if (SECRET_NAME.test(name)) params.set(name, "redacted");
    const text = params.toString();
    return text ? `?${text}` : "";
}

/** A copy of a JSON value that is safe to keep as a sample: secret fields replaced, arrays shortened. */
function sampleOf(value: unknown, depth = 0): unknown {
    if (depth > MAX_SAMPLE_DEPTH || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.slice(0, MAX_SAMPLE_ITEMS).map((item) => sampleOf(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_NAME.test(k) ? REDACTED : sampleOf(v, depth + 1)]));
}

/** A JSON-Schema-like description of a value's shape, as far as one example shows it. */
function shapeOf(value: unknown, depth = 0): Record<string, unknown> {
    if (depth > MAX_SHAPE_DEPTH) return {};
    if (Array.isArray(value)) return { type: "array", items: value.length ? shapeOf(value[0], depth + 1) : {} };
    if (value && typeof value === "object") {
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) properties[k] = shapeOf(v, depth + 1);
        return { type: "object", properties };
    }
    return { type: typeof value };
}

/** The request body as JSON, or undefined when there is none or it is not JSON. */
function jsonBody(raw: string | null): unknown {
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

const union = <T>(a: readonly T[] | undefined, b: readonly T[]): T[] => [...new Set([...(a ?? []), ...b])];

/**
 * Requests a framework makes to fetch the pages of the app itself, not calls to an API: Next.js (`?_rsc=` page payloads, `/_next/data/…`),
 * and Remix (`?_data=`). They are fetch requests, and a page route often answers them with a redirect or a page, so a test built from them
 * expects a JSON API that does not exist.
 */
export function isFrameworkPageRequest(url: string): boolean {
    try {
        const u = new URL(url);
        return u.searchParams.has("_rsc") || u.searchParams.has("_data") || /^\/_next\/(data|image|static)\//.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * Is this a call to an API? Every fetch() is (apart from a framework loading its own pages); an XHR only when its address
 * looks like one (/api/, /graphql, .json, ?format=). Images, scripts, documents and the like never are.
 */
export function isApiRequest(url: string, resourceType: string): boolean {
    if ((resourceType !== "fetch" && resourceType !== "xhr") || isFrameworkPageRequest(url)) return false;
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (resourceType === "fetch") return true;
    const p = u.pathname.toLowerCase();
    return p.includes("/api/") || p.includes("/graphql") || p.endsWith(".json") || u.searchParams.has("format");
}

/** Watches one page's traffic. `setCurrentPage` tells it which page the next calls belong to. */
export class NetworkInterceptor {
    private readonly endpoints = new Map<string, ApiEndpointModel>();
    private readonly otherHosts = new Set<string>();
    private readonly authSchemes = new Set<string>();
    /** WebSocket addresses (no query string: it can carry a token) and the pages that opened them. */
    private readonly sockets = new Map<string, Set<string>>();
    private origin = "";
    private pagePath = "/";

    setCurrentPage(url: string): void {
        try {
            const u = new URL(url);
            this.origin = u.origin;
            this.pagePath = u.pathname;
        } catch {
            /* not an address: keep the last page */
        }
    }

    attach(page: Page): void {
        page.on("request", (req) => this.noteHost(req));
        page.on("response", (res) => void this.record(res));
        page.on("websocket", (ws) => this.noteSocket(ws.url()));
    }

    private noteSocket(url: string): void {
        try {
            const u = new URL(url);
            if (u.protocol !== "ws:" && u.protocol !== "wss:") return;
            const key = `${u.origin.replace(/^http/, "ws")}${u.pathname}`;
            if (!this.sockets.has(key) && this.sockets.size >= 20) return;
            const pages = this.sockets.get(key) ?? new Set<string>();
            if (pages.size < 10) pages.add(this.pagePath);
            this.sockets.set(key, pages);
        } catch {
            /* not an address */
        }
    }

    /** The WebSocket endpoints the app's pages opened (live updates, chat, notifications). */
    getWebSockets(): Array<{ url: string; usedIn: string[] }> {
        return [...this.sockets].map(([url, pages]) => ({ url, usedIn: [...pages] }));
    }

    /** Hosts other than the application's that its pages talked to (fonts, analytics, payment providers...). */
    private noteHost(req: Request): void {
        if (!this.origin) return;
        try {
            const u = new URL(req.url());
            if (u.protocol.startsWith("http") && u.origin !== this.origin) this.otherHosts.add(u.host);
        } catch {
            /* data: and the like */
        }
    }

    private async record(res: Response): Promise<void> {
        const req = res.request();
        if (!isApiRequest(res.url(), req.resourceType())) return;
        let body: unknown;
        if ((res.headers()["content-type"] ?? "").includes("application/json")) body = await res.json().catch(() => undefined);
        let u: URL;
        try {
            u = new URL(res.url());
        } catch {
            return;
        }
        const method = req.method();
        const path = normalizeApiPath(u.pathname);
        const key = `${method} ${u.origin}${path}`;
        const headers = req.headers();
        const authorization = headers["authorization"];
        if (authorization) this.authSchemes.add(authorization.split(" ")[0]!.toLowerCase());
        const sent = jsonBody(req.postData());
        const before = this.endpoints.get(key);
        this.endpoints.set(key, {
            method,
            path,
            origin: u.origin,
            statuses: union(before?.statuses, [res.status()]),
            responseSchema: body ? shapeOf(body) : before?.responseSchema,
            requestSchema: sent === undefined ? before?.requestSchema : shapeOf(sent),
            sampleRequestBody: sent === undefined ? before?.sampleRequestBody : sampleOf(sent),
            examplePath: before?.examplePath ?? u.pathname + redactQuery(u),
            queryParams: union(before?.queryParams, [...u.searchParams.keys()]),
            requiresAuth: before?.requiresAuth || Boolean(authorization || headers["x-api-key"]) || undefined,
            source: "network",
            usedIn: union(before?.usedIn, [this.pagePath]),
        });
    }

    getDiscoveredEndpoints(): ApiEndpointModel[] {
        return [...this.endpoints.values()];
    }

    getExternalHosts(): string[] {
        return [...this.otherHosts];
    }

    /** Authorization schemes the app sent (bearer, basic...), lower case. */
    getAuthSchemes(): string[] {
        return [...this.authSchemes];
    }
}
